/**
 * AI 草坪指挥官 · GP-Next 模组
 * 目标版本：PvZ2 Gardendless 0.16.x + GP-Next 1.5.x（桌面版，单机）
 *
 * 工作方式：
 *  - 通过 GP-Next 的 ctx.unsafe.engine 拿到游戏自己的 Cocos 引擎；
 *  - 只读解析当前场景里的 SunCount / Cards / LnC / Zombie / levelController；
 *  - 种植走游戏自己的“选卡 + 点格子”流程（PlaceUIPlant），会正常扣阳光、进冷却；
 *  - 大模型使用 OpenAI 兼容协议，Key 只保存在本机 localStorage（可选择不记）。
 *
 * 注意：这是单机辅助工具，请勿用于联机或排行榜；游戏更新后内部字段可能变化。
 */

const VERSION = '0.3.5';
const CFG_KEY = 'pvzai.agent.mod.cfg.v1';
const HOST_ID = 'pvzai-mod-host';
const LOG_LIMIT = 120;

// LnC.squareType -> 地形字母（SquareType 枚举来自游戏 LnC.ts）；R = 矿车轨道
const SQUARE_TYPE_LETTER = { 0: 'L', 1: 'S', 2: 'W', 3: 'W', 4: 'P' };
const SQUARE_TYPE_NAME = { 0: 'land', 1: 'sky', 2: 'water', 3: 'sea', 4: 'plank' };
const TERRAIN_LEGEND = { L: 'land', W: 'water', P: 'plank', S: 'sky', R: 'rail', '?': 'unknown' };
const TASK_MODE_NAME = {
  0: 'plant_count_limit',
  1: 'plant_lose_limit',
  2: 'sun_cost_limit',
  3: 'sun_produce_request',
  4: 'sun_cost_countdown',
  5: 'kill_count_request',
  6: 'timed_kill',
};
const TASK_MODE_SEMANTICS = {
  0: 'count_limit',
  1: 'loss_limit',
  2: 'sun_budget',
  3: 'sun_produce',
  4: 'countdown',
  5: 'kill_count',
  6: 'sliding_window',
};

// 僵尸机制标签：来自 pvzge.com 图鉴 + 实测。命中第一条规则即用。
const ZOMBIE_TRAIT_RULES = [
  [/piano/, ['crush', 'support', 'lane_switch']],
  [/prospector/, ['jump_over', 'backline']],
  [/chicken_farmer/, ['spawner', 'chickens']],
  [/^chicken$|_chicken/, ['fast', 'small']],
  [/west_bullrider/, ['jump_over']],
  [/west_bull/, ['throw_imp']],
  [/zomboni|catapult/, ['crush', 'rolling']],
  [/seagull|balloon|jetpack|sky_battleplane/, ['flying']],
  [/gargantuar|zomboss/, ['tank']],
  [/armor[1-4]/, ['armored']],
  [/tomb_raiser/, ['spawner', 'tomb']],
  [/weaselhoarder/, ['spawner']],
  [/octopus/, ['disable']],
  [/fisherman/, ['pull']],
  [/eighties_boombox|boombox/, ['support', 'lane_switch']],
  [/dark_wizard/, ['disable', 'sheep']],
  [/kongfu_chi|abbot_chi|monk_drink/, ['push']],
];

function zombieTraits(type) {
  const t = String(type || '');
  for (const [re, tags] of ZOMBIE_TRAIT_RULES) if (re.test(t)) return tags.slice();
  return [];
}

// 僵尸标签 -> 具体应对要点。图鉴文本偏长，模型容易漏读，这里给一句人话对策。
const ZOMBIE_COUNTER_TIPS = {
  crush: '会碾压植物：别用地刺/残血植物硬挡，用投手、高坚果或一次性爆发',
  jump_over: '会跳过植物：后排火力要足，别把安全全押在一堵墙上',
  backline: '会绕到后排：先保住 column 0-2 的输出，必要时坚果/弹簧豆拖延',
  flying: '飞行：地刺/普通坚果无效，优先对空（投手、闪电芦苇、三线）',
  spawner: '会召唤小怪：优先地刺/群伤/闪电芦苇清小怪',
  armored: '带护甲：用高单发、火焰或投手，破甲前别指望普通豌豆',
  tank: '高血量：高坚果拖时间 + 集中输出 + 能量豆',
  rolling: '滚动物体会摧毁地刺：改用投手/远程',
  support: '辅助型：优先点杀，拖久了会被强化',
  lane_switch: '会换行：每行都要有基本火力，不能只堆一行',
  disable: '会控制/变形植物：关键植物分散种，留补位卡',
  pull: '会把植物拉走：关键植物前面垫坚果',
  push: '会推/击退：火力别贴太近',
  small: '体积小速度快：地刺、闪电芦苇、群伤更稳',
  tomb: '会留下墓碑占格：注意可用格子变少，及时换位',
  sheep: '会变羊：关键格分散，备一张补位卡',
};

// 植物定位 -> 文案 / 每行软上限（超出时建议铲掉多余的那株）
const ROLE_LABEL = {
  sun: '阳光生产者', wall: '坚果/肉盾', spring: '弹簧豆', freeze: '冰冻生菜', spike: '地刺',
  mine: '地雷', aoe: '一次性爆发', support: '辅助/底座', shooter: '输出', other: '其他',
};
const ROLE_LIMIT = { sun: 2, wall: 1, spring: 1, freeze: 1, spike: 2, shooter: 4 };
const ROLE_LIMIT_TEXT = '坚果1 / 弹簧豆1 / 冰冻生菜1 / 阳光生产者2 / 射手4 / 地刺2';
// 推荐列窗口：不强制，但越界会提示/拒绝（见 positionIssue）。地刺放前排（c4-c7）。
const ROLE_WINDOW = { sun: [0, 2], shooter: [0, 4], wall: [3, 7], spike: [4, 7], spring: [3, 6], freeze: [2, 6], mine: [3, 6], aoe: [3, 7], support: [0, 4] };

// 世界常识（参考 BWiki：https://wiki.biligame.com/pvzz/）。
// 仅作为“关卡数据没读到僵尸列表”时的兜底，真实图鉴仍以游戏内 almanac 为准。
const WORLD_NOTES = [
  {
    key: 'egypt', re: /埃及|egypt/i, name: '神秘埃及',
    mechanics: '墓碑占格、太阳神/探险家、法老',
    tips: '墓碑会占格；投手能跨墓碑输出；坚果挡探险家；别把阳光生产放前排',
    zombies: ['mummy', 'mummy_armor1', 'mummy_armor2', 'explorer', 'tomb_raiser', 'pharaoh', 'egypt_gargantuar'],
  },
  {
    key: 'pirate', re: /海盗|pirate/i, name: '海盗港湾',
    mechanics: '海面/木板、海鸥飞越、滚桶碾压、船长鹦鹉偷植物',
    tips: '海面不能种普通植物；地刺对滚桶无效；海鸥要优先对空',
    zombies: ['pirate', 'swashbuckler', 'seagull', 'barrelroller', 'pirate_captain', 'pirate_gargantuar'],
  },
  {
    key: 'west', re: /西部|牛仔|cowboy|west/i, name: '狂野西部',
    mechanics: '矿车轨道、钢琴碾压+换行、淘金者跳后、养鸡人放鸡、公牛投小鬼',
    tips: '矿车可上下调行；钢琴别硬挡；鸡群用地刺/群伤；后排要留火力防淘金者',
    zombies: ['cowboy', 'prospector', 'piano', 'poncho', 'chicken_farmer', 'west_bull', 'cowboy_gargantuar'],
  },
  {
    key: 'future', re: /未来|future/i, name: '遥远未来',
    mechanics: '机甲护甲、喷气背包飞越、迪斯科换行、护盾僵尸',
    tips: '护甲用高单发/火焰/投手；飞行单位要留对空；迪斯科会打乱行，别只堆一行',
    zombies: ['future', 'jetpack', 'protector', 'mech_cone', 'football_mech', 'disco_mech', 'future_gargantuar'],
  },
  {
    key: 'dark', re: /黑暗|dark/i, name: '黑暗时代',
    mechanics: '墓碑、巫师变羊、小丑反弹、国王加护甲',
    tips: '墓碑占格；关键植物分散，备补位卡；小丑在场时别把输出全压一条线',
    zombies: ['dark', 'dark_juggler', 'dark_wizard', 'dark_king', 'dark_gargantuar'],
  },
  {
    key: 'beach', re: /沙滩|海滩|beach/i, name: '巨浪沙滩',
    mechanics: '潮汐改变水线、章鱼封植物、渔夫拉植物、冲浪/潜水',
    tips: '潮汐推进后水格会变多；关键植物别贴着水线；章鱼/渔夫要优先处理',
    zombies: ['beach', 'beach_snorkel', 'beach_surfer', 'beach_octopus', 'beach_fisherman', 'beach_gargantuar'],
  },
  {
    key: 'iceage', re: /冰河|冰川|iceage/i, name: '冰河世界',
    mechanics: '冰块滑行、猎人投冰、渡渡鸟跳越、穴居人、黄鼠狼放小怪',
    tips: '滑冰会让僵尸突然前冲；黄鼠狼要群伤/地刺；别把防线拉太长',
    zombies: ['iceage', 'iceage_hunter', 'iceage_dodo', 'iceage_troglobite', 'iceage_weaselhoarder', 'iceage_gargantuar'],
  },
  {
    key: 'lostcity', re: /失落|古城|lostcity/i, name: '遗落古城',
    mechanics: '金瓷砖、濒危植物、飞行员、挖掘者、水晶骷髅',
    tips: '保护濒危植物；飞行员会绕后；金瓷砖上的植物要重点保',
    zombies: ['lostcity', 'lostcity_lostpilot', 'lostcity_excavator', 'lostcity_jane', 'lostcity_bug', 'lostcity_crystalskull', 'lostcity_gargantuar'],
  },
  {
    key: 'kongfu', re: /功夫|kongfu|kungfu/i, name: '功夫世界',
    mechanics: '气功洞推拉、武僧/方丈、刀枪不入',
    tips: '气功洞会移动/击退植物和僵尸；前排别贴洞；优先集火方丈',
    zombies: ['kongfu', 'monk', 'abbot'],
  },
  {
    key: 'jurassic', re: /侏罗纪|jurassic/i, name: '侏罗纪沼泽',
    mechanics: '恐龙（剑龙击退、翼龙抓走、迅猛龙召唤、霸王龙）',
    tips: '恐龙会打乱阵型；别把关键植物放最外侧；留补位',
    zombies: [],
  },
  {
    key: 'modern', re: /现代|modern/i, name: '现代年华',
    mechanics: '多个时代的僵尸混编、特殊机制轮换',
    tips: '按当前波次出现的僵尸临时调整，不要一套卡打到底',
    zombies: [],
  },
];

function worldNoteOf(text) {
  const s = String(text || '');
  for (const w of WORLD_NOTES) if (w.re.test(s)) return w;
  return null;
}


// 没有费用信息时，用卡名估一个强度档位，供“换更强植物”建议使用。
const PLANT_STRENGTH_RULES = [
  [/gatling|winter-?melon|melon|laser|bonk|cabbage|kernel|bloomerang|lightning|threepeater|starfruit|fume|homing|sniper|citron|snapdragon|twinsunflower|primalsunflower/, 3],
  [/repeater|snowpea|splitpea|peapod|firepea|cactus|spik(e)?rock|tallnut|endurian|primalwallnut/, 2],
];
function plantTier(type) {
  const t = String(type || '').toLowerCase();
  const rule = PLANT_STRENGTH_RULES.find(([re]) => re.test(t));
  return rule ? rule[1] : 1;
}
function plantStrength(type, cost) {
  return plantTier(type) * 100 + (Number.isFinite(cost) ? cost : 0);
}

// 开局目标文本 -> 可执行要点（不依赖任务组件，弹窗关掉后也能用）
function parseMissionHints(texts) {
  const out = [];
  const add = (kind, hint) => { if (!out.some((o) => o.kind === kind)) out.push({ kind, hint }); };
  for (const raw of texts || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (/(不|别|勿|不能|不得).{0,6}(损失|失去|丢|被吃)|无伤|一株都别/.test(t)
      && !/(超过|最多|不超过|多于)/.test(t)) add('no_loss', '不能损失植物：少种也比送掉强，危险行先加坚果/控制');
    else if (/(损失|失去|丢).{0,6}(超过|最多|不超过|多于)/.test(t)) add('loss_limit', '损失有上限：先加固再扩张，不要主动铲');
    if (/(\d+)\s*(秒|s).{0,6}(内|之内)|倒计时/.test(t)) add('timed', '有倒计时：优先高输出和能量豆，不要再铺经济');
    if (/(击杀|消灭|杀死|干掉|清理).{0,10}\d+/.test(t)) add('kill', '要清够数量：保证每行有输出，必要时一次性爆发集中清场');
    if (/(最多|不超过|只能种|上限).{0,8}\d+\s*株/.test(t)) add('plant_limit', '植物数量受限：只种关键卡，先铲再种，别铺满');
    if (/(阳光|收集).{0,8}\d+|\d+\s*点?\s*阳光/.test(t)) add('sun', '有阳光目标：先保阳光生产者，再考虑输出');
    if (/(坚持|守住|存活|不许|阻止).{0,8}(进|吃|过|秒)/.test(t)) add('survive', '以守为主：前排坚果/控制优先，输出够用即可');
  }
  return out.slice(0, 6);
}
const TASK_REASON_TEXT = {
  TERRAIN: '该格地形不允许种植',
  OUT_OF_RANGE: '格子超出范围',
  NO_CARD: '卡槽不存在',
  UI_NOT_READY: '卡槽 UI 尚未初始化完成',
  COOLDOWN: '卡牌冷却中',
  SUN: '阳光不足',
  CARD_UNAVAILABLE: '卡牌无法选中',
  PAUSED: '游戏处于暂停状态',
  UI_LOCKED: '游戏界面被锁定',
  LANE_LIMIT: '该行同类型植物已达上限',
  OCCUPIED: '格子已有植物',
  POSITION: '位置不合适（浪费格子/会被吃）',
  LEVEL_LIMIT: '关卡限制（植物上限/特殊规则）',
  CELL_BLOCKED: '该格当前不可种植',
  PLANT_FAILED: '种植未生效',
  EMPTY: '格子没有植物',
  SHOVEL_FAILED: '铲除失败',
  SHOVEL_BLOCKED: '任务限制，不能主动铲除',
  PLANT_MISMATCH: '格子里的植物与预期不符',
  NO_FOOD: '没有植物能量',
  NOT_FOODABLE: '该格没有可喂能量的植物',
  TIMEOUT: '等待超时',
  UNKNOWN_ACTION: '未知动作',
  PREP_NOT_READY: '选卡界面还没准备好',
  ALREADY_STARTED: '战斗已经开始',
  NO_SCENE: '不在关卡内',
  UNSUPPORTED_LEVEL: '当前关卡类型不支持',
  NO_SLOTS: '当前关卡没有可用卡槽',
  NO_CELL: '格子不存在',
  DECK_INCOMPLETE: '卡组还没选满',
  DECK_CLEAR_FAILED: '清空卡组失败',
  START_FAILED: '开局失败',
  NO_OBJECTIVE: '当前没有关卡目标界面',
  CONTINUE_NOT_FOUND: '找不到“继续”按钮',
  BAD_CONDITION: '无法识别的条件',
  NO_ACTIONS: '没有可执行的动作',
  NO_CART: '没有这辆矿车',
  CART_BLOCKED: '矿车无法移动到目标行',
};


const PLANT_CN = {
  sunflower: '向日葵', twinsunflower: '双子向日葵', sunshroom: '阳光菇', primalsunflower: '原始向日葵',
  peashooter: '豌豆射手', repeater: '双发射手', snowpea: '寒冰射手', threepeater: '三线射手',
  splitpea: '分裂豌豆', peapod: '豌豆荚', gatlingpea: '机枪豌豆', firepea: '火焰豌豆',
  wallnut: '坚果墙', tallnut: '高坚果', endurian: '棱镜草', 'explode-o-nut': '爆炸坚果',
  potatomine: '土豆雷', cherrybomb: '樱桃炸弹', jalapeno: '火爆辣椒', 'ice-shroom': '寒冰菇',
  iceburg: '冰冻生菜', springbean: '弹簧豆',
  chomper: '大嘴花', 'bonk-choy': '菜问', 'cabbage-pult': '卷心菜投手', 'kernel-pult': '玉米投手',
  'melon-pult': '西瓜投手', 'winter-melon': '冰西瓜', bloomerang: '回旋镖', 'lightning-reed': '闪电芦苇',
  spikeweed: '地刺', spikrock: '地刺王', lilypad: '睡莲', 'flower-pot': '花盆', imitater: '模仿者',
};

const ZOMBIE_CN = {
  mummy: '木乃伊', mummy_armor1: '路障木乃伊', mummy_armor2: '铁桶木乃伊', mummy_armor4: '铁盔木乃伊',
  mummy_flag: '旗帜木乃伊', ra: '太阳神', explorer: '探险家', tomb_raiser: '造墓者', pharaoh: '法老',
  egypt_imp: '小鬼', egypt_gargantuar: '埃及巨人',
  pirate: '海盗', swashbuckler: '剑客', seagull: '海鸥', barrelroller: '滚桶', pirate_captain: '海盗船长',
  pirate_gargantuar: '海盗巨人', cowboy: '牛仔', prospector: '淘金者', piano: '钢琴僵尸', poncho: '斗篷僵尸',
  chicken_farmer: '养鸡人', chicken: '小鸡', west_bull: '公牛', cowboy_gargantuar: '牛仔巨人',
  future: '未来僵尸', jetpack: '喷气背包', protector: '护盾僵尸', mech_cone: '机械路障',
  football_mech: '机械橄榄球', disco_mech: '机械迪斯科', future_gargantuar: '未来巨人',
  dark: '黑暗僵尸', dark_juggler: '小丑僵尸', dark_wizard: '巫师僵尸', dark_king: '黑暗国王',
  dark_gargantuar: '黑暗巨人', beach: '沙滩僵尸', beach_snorkel: '潜水僵尸', beach_surfer: '冲浪僵尸',
  beach_octopus: '章鱼僵尸', beach_fisherman: '渔夫僵尸', beach_gargantuar: '沙滩巨人',
  iceage: '冰河僵尸', iceage_hunter: '猎人僵尸', iceage_dodo: '渡渡鸟骑士', iceage_troglobite: '穴居人',
  iceage_weaselhoarder: '黄鼠狼', iceage_gargantuar: '冰河巨人', lostcity: '失落僵尸',
  lostcity_lostpilot: '飞行员僵尸', lostcity_excavator: '挖掘者', lostcity_jane: '珍妮',
  lostcity_bug: '甲虫僵尸', lostcity_relichunter: '遗物猎人', lostcity_crystalskull: '水晶骷髅',
  lostcity_gargantuar: '失落巨人', kongfu: '功夫僵尸', monk: '武僧', abbot: '方丈',
  zombossmech_egypt: '埃及僵王', zombossmech_pirate: '海盗僵王', zombossmech_cowboy: '牛仔僵王',
  zombossmech_future: '未来僵王', zombossmech_dark: '黑暗僵王', zombossmech_beach: '沙滩僵王',
  zombossmech_iceage: '冰河僵王', zombossmech_lostcity: '失落僵王',
};

function cleanCodename(v) {
  const s = String(v || '');
  const m = /^RTID\(([^@)]+)/i.exec(s);
  return m ? m[1] : s;
}

function normalizeBaseUrl(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return b;
  if (/^https?:\/\/(api\.deepseek\.com|api\.openai\.com)$/i.test(b)) return b + '/v1';
  try {
    const u = new URL(b);
    if (u.pathname === '/' || u.pathname === '') return b + '/v1';
  } catch { /* ignore */ }
  return b;
}

function plantRole(type) {
  const t = String(type || '').toLowerCase();
  if (/sunflower|sunshroom|twinsunflower|primalsunflower|sunbean|sun-shroom/.test(t)) return 'sun';
  if (/wallnut|tallnut|tall-nut|endurian|garlic|explode-o-nut|infi-nut|primalwallnut|peanut|pumpkin/.test(t)) return 'wall';
  if (/springbean|spring-bean/.test(t)) return 'spring';
  if (/iceburg|iceberg|ice-shroom|icebloom|iceberg-lettuce/.test(t)) return 'freeze';
  if (/spikeweed|spikrock|spikerock/.test(t)) return 'spike';
  if (/potatomine|potato-mine|primalpotatomine/.test(t)) return 'mine';
  if (/cherrybomb|cherry-bomb|jalapeno|squash|bombegranate|grapeshot|lava-guava|grapeshot/.test(t)) return 'aoe';
  if (/lilypad|lily-pad|flower-?pot|floawerpot|imitater|blover/.test(t)) return 'support';
  if (/pea|shot|pult|melon|cabbage|kernel|bloomerang|reed|starfruit|homingthistle|xshot|fume|laser|sniper|bonk|chomper|cactus|citron/.test(t)) return 'shooter';
  return 'other';
}

const DEFAULT_CFG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  persistKey: false,
  autoSun: true,
  autoDeck: true,
  autoShovel: true,
  localBrain: false,
  stream: true,
  showThought: true,
  interval: 1600,
  heartbeat: 9000,
  maxTurns: 500,
  collapsed: false,
  pos: null,
  thinkPos: null,
};

const SYSTEM_PROMPT = `你是《植物大战僵尸2》的实时自动游玩代理。你只能输出一个 json 对象，不能输出 Markdown、解释或思考过程。

坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。僵尸 column 越小越危险。

输出格式（严格 json）：
{"thought":"不超过60字的关键判断","actions":[{"type":"plant","card":0,"lane":2,"column":1}]}

动作：
- {"type":"plant","card":<卡槽下标>,"lane":0-4,"column":0-8}
- {"type":"shovel","lane":0-4,"column":0-8}  铲掉这一格（腾位/清重复/清低效），不返还阳光
- {"type":"replace","card":<卡槽下标>,"lane":0-4,"column":0-8}  先铲后种，把这一格换成更强的植物
- {"type":"plant_food","lane":0-4,"column":0-8}
- {"type":"wait"}
- {"type":"choose_deck","plants":["sunflower","peashooter"]}  仅 phase=preparing
- {"type":"start_level"}  仅 phase=preparing
- {"type":"dismiss_objective"}  仅 phase=objective（本关任务弹窗，点“继续”）
- {"type":"move_cart","cart":0,"direction":"up"}  仅 state.carts 非空
- {"type":"resume"}  仅 paused=true

每回合的阅读顺序（不要跳）：
1) 关卡任务（tasks / 任务要点 / objective）：本关靠什么通过、限制了植物数/损失数/阳光、有没有倒计时。任务失败通常直接判负，优先级最高。
2) 僵尸图鉴与预计僵尸（levelPreview / zombies[].tags / 应对要点）：这波有什么特殊单位，用什么克制。
3) 卡槽图鉴（cards + 每张卡的定位/介绍/特殊能力）：哪些 ready、多少钱、和上面僵尸是否对得上。
4) 战场（lanes / plants / terrain / shovelCandidates）：哪行缺输出、哪格挡路、哪株该换。

游戏规则：
- 掉落的阳光、能量豆、金币会自动收取，不需要你操作。
- 种植会扣阳光并进入冷却；同一张卡冷却中不能再用；一格只能种一株（除非卡牌允许叠加）。
- 僵尸从右往左走，吃掉植物；到最左会触发小推车（每行一次）。
- 射手向右攻击；坚果挡路；冰系减速/冻结；一次性植物触发后消失；地刺不会被啃食但会被滚动物体摧毁；弹簧豆把僵尸弹回/弹进水。
- 能量豆会自动收集；需要时用 plant_food 给高输出植物释放大招。
- **地形**：状态里有 terrain.map，每行一个字符串：L=陆地 P=木板 W=水 S=天空 R=矿车轨道 ?=未知。水格不能种普通植物（需要睡莲/弹簧豆等水生卡）。blockedCells 是明确不可种植的格子，不要往上种。
- **每行软上限**：${ROLE_LIMIT_TEXT}。超出会被代码拒绝（LANE_LIMIT）。
- **落点窗口**：阳光 c0-c2；普通输出 c0-c4；坚果/近战 c3-c7；地刺 c4-c7，且必须在坚果前面（坚果挡住的僵尸踩不到后面的地刺）。放错会被拒绝（POSITION）并给出 alts。
- 当前没有阳光生产者时，不要等向日葵；优先低费射手/地刺，坚果只给最危险的行。
- 种植前先看“阵容统计”和每行植物；不要重复同类型植物。
- 铲除不返还阳光；铲掉后立刻用 replace 或下一步补种，别让格子空着。

决策原则：
1. 前期优先 2-3 个阳光生产者，种在 column 0-2。
2. 攻击植物优先种在 column 1-4；地刺/地刺王放前排 c4-c7，不要种在坚果后面（坚果挡住的僵尸踩不到地刺）；不要把植物种在已有植物的格子。
3. 某行僵尸 column<=3 时优先在该行补防御或输出；column<=1 属于紧急情况。
4. 只选择 ready=true 的卡；cd>0 或 affordable=false 的卡不要用。
5. 每个回合最多 3 个动作，按顺序执行；没有值得做的就输出 wait。
6. 优先使用费用低、冷却好的卡；阳光快到上限时不必囤积。
7. **铲除是正常战术，不是失败**：种错位置、种了弱卡、重复超限、格子被占，都应该主动铲掉重种。每次最多处理 1 格。
8. **优先 replace**：同格要从弱卡换强卡（豌豆→双发/西瓜、坚果→高坚果、向日葵→双子向日葵）时，用 replace 一步完成；只腾位不换卡才用 shovel。
9. 明确该铲/该换的情况：shovelCandidates 的 reason=over_limit（超上限）、upgrade（有更强卡）、misplaced（阳光 c>=4 / 坚果 c<=2 / 地刺 c<4 或在坚果后面）、low_hp（残血）。misplaced 先 shovel 腾出来，再按“空位建议”把同类卡种到正确窗口；有更强卡就直接 replace。这些是建议不是命令，要结合波次和阳光判断。
10. 不该铲的情况：loss_limit 任务 left<=1（再损失一株就失败，代码也会拒绝）、刚种下还没发挥作用、铲了没钱补种、僵尸正贴着它而后面没有防线。
11. 如果 phase=objective，先输出 dismiss_objective，不要做别的。
12. 如果 phase=preparing，先 choose_deck（最多选满卡槽）再 start_level；如果已经自动选好卡，直接 start_level。
13. 关卡任务（tasks）是本关必须完成的目标，例如“在 30 秒内击杀 20 个僵尸”。每回合都先看 tasks：未完成任务优先，围绕它调整种植和能量豆——限时击杀就集中输出/地刺/能量豆，限制植物数量就不要多铺，限制阳光花费就先便宜卡，限制损失就少种、先加固。
14. 任务带 timeLeft 时，第一屏会显示“任务倒计时”。urgent=true 时优先把能量豆/一次性植物/最高输出砸上去；timeLeft 很小而进度差很多时，不要继续铺经济。timed_kill 是“最近 30 秒内击杀 20 个”的滑动窗口，不是整关倒计时。
15. 动作失败会返回 code（TERRAIN/COOLDOWN/SUN/OCCUPIED/POSITION/LANE_LIMIT/LEVEL_LIMIT/SHOVEL_BLOCKED/PLANT_MISMATCH…），按 code 换格或等待，不要重复同一个失败动作；带 alts 时直接改种给出的格子。
16. **矿车**：状态里有 carts。矿车是可在同一轨道列上下移动的植物平台，植物会跟着车走。某行有僵尸但没射手时，优先把载着射手的矿车 move_cart 到该行，而不是重复买植物；移车前确认原行不会因此失守。
17. **暂停**：状态 paused=true 时，种植/铲除/能量豆都会被游戏忽略；先输出 resume，再做别的。
18. **特殊僵尸**：state.zombies[].tags 会标出 crush/jump_over/backline/flying/spawner/armored/rolling/tank/lane_switch 等，状态里的“应对要点”给出对应打法；图鉴的“特殊能力/属性”优先于你的记忆。
19. 同一张卡不要在一批动作里连续种两次（会撞冷却）；不同卡可以。
20. **传送带关卡**：state.conveyor.cards 是当前带上的卡，plant 的 card 用这个列表的 index（不是种子卡槽）；传送带不扣阳光、不吃冷却。没有 cards 时不要调用 choose_deck，直接开打。
21. **开局计划**：状态里有“本关作战计划”时，按计划的方向打（卡组、克制、开局顺序、铲除策略）；局势明显变化（例如提前出巨人）才偏离，并在 thought 里说明。没有计划时按通用原则打。
22. 看到“⚡ 优先处理”且阳光够时，把对应的 replace/shovel 作为本回合第一个动作；早换早收益，别等格子被僵尸吃掉。
23. **落点**：先看“位置图”和“空位建议”再决定 lane/column，别从数组里自己猜；种失败带 alts 时直接用 alts 里的格子，不要重试同一个位置。`;

// 把系统提示拆成“固定规则”和“可编辑策略”，UI 里只让用户改后者。
const STRATEGY_MARKER = '\n决策原则：\n';
const STRATEGY_INDEX = SYSTEM_PROMPT.indexOf(STRATEGY_MARKER);
const SYSTEM_PROMPT_CORE = STRATEGY_INDEX >= 0 ? SYSTEM_PROMPT.slice(0, STRATEGY_INDEX) : SYSTEM_PROMPT;
const DEFAULT_STRATEGY = STRATEGY_INDEX >= 0
  ? SYSTEM_PROMPT.slice(STRATEGY_INDEX + STRATEGY_MARKER.length)
  : '';




// 开局参谋：只产出“本关计划”，不执行动作。开打后计划会一直带在每回合状态里。
const PLANNER_PROMPT = `你是《植物大战僵尸2》的开局参谋。现在还没开始战斗（关卡目标说明 / 选卡阶段），你要先通读关卡任务、地图机制、可选卡组、预计出现的僵尸和植物图鉴，想清楚整关怎么打，再输出一个 json 对象。

只输出 json，不要 Markdown、不要解释：
{"plan":{"goal":"一句话复述通关条件","threats":["本关要重点针对的僵尸/机制"],"counters":["针对威胁的具体手段"],"deck":["sunflower","wallnut","repeater"],"buildOrder":["第1步：...","第2步：..."],"shovelPolicy":"什么情况下铲掉重种","dangerLanes":[2],"notes":"其他注意事项"}}

要求：
- 先看任务、世界机制、预计僵尸、可选卡组；世界特有机制（潮汐/墓碑/矿车/恐龙/气功洞/传送门）要在 notes 里写怎么处理。
- goal：从 tasks / 关卡目标原文提炼通过条件，写清限制（植物上限、损失上限、倒计时、击杀数）。
- threats / counters：优先看“预计僵尸”和它们的标签（crush/jump_over/flying/armored/spawner/rolling/tank/lane_switch…），每条对应一个克制手段；没有信息时按关卡世界（埃及/海盗/西部/未来/黑暗/沙滩/冰河/失落/功夫）的常见威胁写。
- deck：从 seedSelection.available 里选 5-8 个 codename，必须包含阳光生产者（如果有）与至少 1 个前排防御/控制；按预计僵尸选克制卡，不要每次都同一套。不要编造 codename。传送带或固定卡组关卡输出 []。
- buildOrder：前 60 秒的种植顺序，写清第几行、第几列、先什么后什么，并照顾“植物数量上限/阳光预算”类任务。
- shovelPolicy：说明哪种植物种错/太弱/重复时要铲掉，换成什么；以及不能铲的情况。
- dangerLanes：预计最危险的行（0-4，可为空数组）。
- notes：能量豆怎么用、特殊机制（潮汐/矿车/传送门/恐龙/墓碑）怎么处理。`;

const PLAY_TOOL = {
  type: 'function',
  function: {
    name: 'play_actions',
    description: '提交本回合的《植物大战僵尸2》操作。最多 3 个动作。',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: '不超过 60 字的关键判断（会显示在玩家看到的思考浮窗里）' },
        actions: {
          type: 'array',
          description: '按顺序执行的动作',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['plant', 'shovel', 'replace', 'plant_food', 'wait', 'choose_deck', 'start_level', 'dismiss_objective', 'move_cart', 'resume'] },
              card: { type: 'integer', description: '卡槽下标（plant / replace 用）' },
              lane: { type: 'integer', description: '0-4 行' },
              column: { type: 'integer', description: '0-8 列' },
              cart: { type: 'integer', description: '矿车编号（move_cart 用）' },
              direction: { type: 'string', enum: ['up', 'down'], description: '矿车移动方向' },
              plants: { type: 'array', items: { type: 'string' }, description: '选卡阶段的植物 codename 列表' },
            },
            required: ['type'],
          },
        },
      },
      required: ['thought', 'actions'],
    },
  },
};

export default {
  setup(ctx) {
    const engine = ctx.unsafe && ctx.unsafe.engine;
    const getCc = () => {
      try { return (engine && engine.getCc && engine.getCc()) || window.cc || null; } catch { return window.cc || null; }
    };
    const platformVersion = (() => {
      try { return ctx.compat && ctx.compat.getPlatformVersion ? String(ctx.compat.getPlatformVersion()) : 'unknown'; } catch { return 'unknown'; }
    })();

    let cfg = loadCfg();
    let host = null, shadow = null, el = {};
    let logLines = [];
    let run = null;
    let uiTimer = null;
    let thinkTimer = null;
    let autoCollectTimer = null;
    let lastPickupLog = 0;
    let disposed = false;
    let tauriHttpLogged = false;
    let tauriHttpErrorLogged = false;
    const kb = { plants: Object.create(null), zombies: Object.create(null), plantNames: null, zombieNames: null };
    // 地形学习缓存：游戏字段探不到/判定失败时，第二次不再撞同一格。
    const learnedCells = new Map(); // "lane:column" -> { until, code, terrain }
    let learnedLevelKey = '';
    // 限时击杀任务的滑动窗口：按任务 key 记录击杀时间戳。
    const taskTrack = new Map(); // key -> { lastValue, kills: [], updatedAt }
    // 植物损失追踪：快照之间对比，找出“刚刚没了的植物”。
    let lastPlants = new Map(); // "lane:column" -> { type, hp }
    const shoveledAt = new Map(); // "lane:column" -> timestamp（自己铲掉的不算损失）
    const recentShovels = []; // 最近铲掉的格子，用于提示词里告诉模型“刚做过什么”
    let currentPlan = null; // 开局前制定的作战计划
    let levelHint = ''; // 本关临时策略（只在本关生效，不写入 localStorage）
    let levelHintKey = ''; // 该临时策略属于哪个关卡
    let levelHintSetting = false; // 发送临时策略时避免 snapshot 里的 sync 把它清掉
    // 性能缓存：状态浮窗 700ms 刷新一次，重复扫场景/查关卡数据会明显拖慢游戏。
    let compCache = { scene: null, map: null, at: 0 };
    let previewCache = { key: '', at: 0, value: null };
    let terrainCache = { key: '', at: 0, value: null };
    let mechCache = { key: '', at: 0, value: null };
    let tileCache = { key: '', at: 0, value: null };
    let recentLosses = [];
    let cartMoveUntil = 0; // 矿车移动后 3 秒内不做损失对比（植物跟着车换格）
    let lastMechanics = null;


    // GP-Next 可能在同源 iframe 中运行模组：优先把浮窗挂到游戏主页面。
    function getDoc() {
      try {
        if (window.parent && window.parent !== window) {
          const d = window.parent.document;
          if (d && d.body) return d;
        }
      } catch { /* cross-origin, fall through */ }
      return document;
    }
    function getWin() {
      try { if (window.parent && window.parent !== window) return window.parent; } catch { /* ignore */ }
      return window;
    }

    // ───────────────────────── 配置 ─────────────────────────

    function loadCfg() {
      try {
        const raw = localStorage.getItem(CFG_KEY);
        if (!raw) return { ...DEFAULT_CFG };
        const parsed = JSON.parse(raw);
        const out = { ...DEFAULT_CFG, ...parsed };
        if (!parsed.persistKey) out.apiKey = '';
        return out;
      } catch { return { ...DEFAULT_CFG }; }
    }

    function saveCfg() {
      try {
        const copy = { ...cfg };
        if (!cfg.persistKey) copy.apiKey = '';
        localStorage.setItem(CFG_KEY, JSON.stringify(copy));
      } catch { /* ignore */ }
    }

    // ───────────────────────── 日志 ─────────────────────────

    function mlog(message, kind = '') {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      logLines.push({ time, message: String(message), kind });
      if (logLines.length > LOG_LIMIT) logLines = logLines.slice(-LOG_LIMIT);
      renderLog();
      if (kind === 'err') showError(String(message));
      try {
        if (kind === 'err') ctx.log.error('[AI草坪] ' + message);
        else if (kind === 'warn') ctx.log.warn('[AI草坪] ' + message);
        else ctx.log.info('[AI草坪] ' + message);
      } catch { /* ignore */ }
    }

    function showError(message) {
      if (!el.errbar) return;
      el.errbar.textContent = '✖ ' + message;
      el.errbar.classList.add('show');
    }

    function clearError() {
      if (!el.errbar) return;
      el.errbar.textContent = '';
      el.errbar.classList.remove('show');
    }

    function toast(message, type = 'info') {
      try { ctx.ui.toast(message, type); } catch { /* ignore */ }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function renderLog() {
      if (!el.log) return;
      el.log.innerHTML = logLines.map((l) =>
        `<div><span class="t">${l.time}</span> <span class="${l.kind}">${escapeHtml(l.message)}</span></div>`
      ).join('');
      el.log.scrollTop = el.log.scrollHeight;
    }

    // ───────────────────────── 浮窗 ─────────────────────────

    function buildUI() {
      if (uiTimer) { clearInterval(uiTimer); uiTimer = null; }
      if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
      const doc = getDoc();
      const old = doc.getElementById(HOST_ID);
      if (old) old.remove();
      host = null;
      shadow = null;

      host = doc.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; }
          .panel {
            position: absolute; right: 16px; top: 80px; bottom: auto; width: 330px;
            pointer-events: auto;
            max-height: min(88vh, 780px); display: flex; flex-direction: column;
            border: 1px solid rgba(126,217,87,.38); border-radius: 14px;
            background: linear-gradient(180deg, rgba(18,34,24,.97), rgba(10,20,14,.97));
            box-shadow: 0 14px 40px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
            overflow: hidden; backdrop-filter: blur(8px);
            font-family: "Microsoft YaHei","PingFang SC",system-ui,sans-serif;
            color: #eaf5ea; font-size: 12px; line-height: 1.45;
          }
          .head {
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            padding: 9px 10px 9px 12px; cursor: grab; user-select: none;
            background: linear-gradient(180deg, rgba(52,94,47,.95), rgba(28,54,32,.95));
            border-bottom: 1px solid rgba(126,217,87,.22);
          }
          .head:active { cursor: grabbing; }
          .title { font-weight: 700; font-size: 13px; letter-spacing: .3px; }
          .ver { opacity: .55; font-size: 10px; margin-left: 4px; }
          button {
            font-family: inherit; font-size: 12px; color: #eaf5ea; cursor: pointer;
            border: 1px solid rgba(126,217,87,.35); background: rgba(255,255,255,.06);
            border-radius: 8px; padding: 5px 9px; transition: background .15s,border-color .15s,transform .05s;
          }
          button:hover { background: rgba(126,217,87,.18); border-color: rgba(126,217,87,.6); }
          button:active { transform: translateY(1px); }
          button:disabled { opacity: .4; cursor: not-allowed; }
          .icon { padding: 2px 8px; line-height: 1.3; font-size: 14px; }
          .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; overflow-x: hidden; min-height: 0; }
          .scroll-area { display: contents; }
          .status {
            flex: 0 0 auto;
            border: 1px solid rgba(126,217,87,.22); background: rgba(126,217,87,.07);
            border-radius: 9px; padding: 7px 9px; font-size: 11.5px; color: #bfe9b4; word-break: break-all;
          }
          .status b { color: #fff; font-weight: 600; }
          .errbar {
            flex: 0 0 auto;
            display: none; border: 1px solid rgba(255,120,120,.65);
            background: rgba(160,36,36,.28); color: #ffb3b3;
            border-radius: 8px; padding: 7px 9px; font-size: 11px;
            word-break: break-all; white-space: pre-wrap;
          }
          .errbar.show { display: block; }
          details { flex: 0 0 auto; border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 0 9px 9px; background: rgba(255,255,255,.025); }
          summary { cursor: pointer; padding: 8px 0 6px; font-weight: 600; color: #cfecc6; list-style: none; }
          summary::-webkit-details-marker { display: none; }
          summary::before { content: "▸ "; opacity: .7; }
          details[open] summary::before { content: "▾ "; }
          .field { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
          .field label { color: #9fc79a; font-size: 11px; }
          input[type="text"], input[type="password"], input[type="number"] {
            font-family: inherit; font-size: 12px; color: #eaf5ea; width: 100%;
            background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
            border-radius: 7px; padding: 6px 8px; outline: none;
          }
          input:focus { border-color: rgba(126,217,87,.6); }
          textarea.ta {
            font-family: inherit; font-size: 11px; line-height: 1.45; color: #eaf5ea; width: 100%; height: 130px;
            background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
            border-radius: 7px; padding: 6px 8px; outline: none; resize: vertical;
          }
          textarea.ta:focus { border-color: rgba(126,217,87,.6); }
          .checks { flex: 0 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
          .check { display: flex; align-items: center; gap: 6px; color: #c8dfc3; cursor: pointer; }
          .check input { accent-color: #7ed957; }
          .btns { flex: 0 0 auto; display: flex; gap: 6px; flex-wrap: wrap; }
          .btns button { flex: 1; min-width: 86px; }
          .primary { background: linear-gradient(180deg,#6fc94c,#479a30) !important; border-color: #8fe36a !important; font-weight: 700; color: #fff !important; }
          .danger { background: rgba(200,60,60,.22) !important; border-color: rgba(255,120,120,.45) !important; }
          .log {
            flex: 0 0 110px; height: 110px; min-height: 110px;
            overflow-y: auto; overflow-x: hidden;
            white-space: pre-wrap; word-break: break-all;
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 8px; padding: 6px 8px; background: rgba(0,0,0,.3);
            font-family: Consolas,"Cascadia Mono",monospace; font-size: 10.5px;
            line-height: 1.45; color: #b9d3b3;
          }
          .log div { white-space: pre-wrap; word-break: break-all; }
          .log .t { color: #6f8f6b; }
          .log .ok { color: #9fe08a; }
          .log .warn { color: #ffd479; }
          .log .err { color: #ff9b9b; }
          .hint { color: #87a382; font-size: 10.5px; }
          .pill {
            position: absolute; right: 0; bottom: 0; display: none; align-items: center; gap: 6px;
            pointer-events: auto; padding: 9px 14px; border-radius: 999px; cursor: pointer;
            border: 1px solid rgba(126,217,87,.55);
            background: linear-gradient(180deg, rgba(52,94,47,.98), rgba(24,46,28,.98));
            box-shadow: 0 8px 24px rgba(0,0,0,.5); font-weight: 700;
            font-family: "Microsoft YaHei",system-ui,sans-serif; color: #eaf5ea; font-size: 12px;
          }
          .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #7ed957; box-shadow: 0 0 8px #7ed957; }
          .pill.idle .dot { background: #8a9a86; box-shadow: none; }
          .think {
            position: absolute; left: 16px; bottom: 84px; width: 310px; max-height: 44vh;
            pointer-events: auto; display: flex; flex-direction: column;
            border: 1px solid rgba(126,217,87,.32); border-radius: 12px;
            background: linear-gradient(180deg, rgba(14,26,18,.95), rgba(8,16,11,.95));
            box-shadow: 0 10px 30px rgba(0,0,0,.45); overflow: hidden;
            font-family: "Microsoft YaHei",system-ui,sans-serif; color: #eaf5ea; font-size: 11.5px;
            backdrop-filter: blur(6px);
          }
          .think-head {
            display: flex; align-items: center; gap: 6px; padding: 6px 8px 6px 10px;
            cursor: grab; user-select: none;
            background: linear-gradient(180deg, rgba(40,72,40,.92), rgba(22,42,26,.92));
            border-bottom: 1px solid rgba(126,217,87,.18);
          }
          .think-head:active { cursor: grabbing; }
          .think-title { font-weight: 700; font-size: 12px; }
          .think-stage { margin-left: auto; color: #9fe08a; font-size: 10.5px; font-family: Consolas,"Cascadia Mono",monospace; }
          .think-stage.long { color: #ffd479; }
          .think-body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; }
          .think-thought { color: #dff3d5; line-height: 1.5; word-break: break-word; }
          .think-thought.live { color: #9fe08a; }
          .think-acts { display: flex; flex-direction: column; gap: 2px; font-family: Consolas,"Cascadia Mono",monospace; font-size: 10.5px; color: #b9d3b3; }
          .think-acts .ok { color: #9fe08a; }
          .think-acts .bad { color: #ffb3b3; }
          .think-plan { color: #87a382; font-size: 10.5px; border-top: 1px dashed rgba(255,255,255,.1); padding-top: 5px; }
          .think-plan:empty { display: none; }
          .think-board-wrap { border-top: 1px dashed rgba(255,255,255,.1); padding-top: 4px; }
          .think-board-wrap summary { color: #87a382; font-size: 10.5px; cursor: pointer; padding: 2px 0; }
          .think-board { white-space: pre; overflow-x: auto; font-family: Consolas,"Cascadia Mono",monospace; font-size: 10px; line-height: 1.45; color: #9fc79a; padding-top: 3px; }
          .think-note-row { display: flex; flex-direction: column; gap: 4px; border-top: 1px dashed rgba(255,255,255,.1); padding-top: 5px; }
          .think-note {
            width: 100%; height: 44px; resize: vertical; font-family: inherit; font-size: 11px; line-height: 1.4;
            color: #eaf5ea; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
            border-radius: 6px; padding: 4px 6px; outline: none;
          }
          .think-note:focus { border-color: rgba(126,217,87,.6); }
          .think-note-btns { display: flex; gap: 5px; }
          .think-note-btns button { flex: 1; padding: 3px 6px; font-size: 11px; }
          .think-note-label { color: #9fc79a; font-size: 10px; }
          .think-hint { color: #ffd479; font-size: 10.5px; word-break: break-word; }
          .think-hint:empty { display: none; }
          .think-history { border-top: 1px dashed rgba(255,255,255,.1); padding-top: 5px; display: flex; flex-direction: column; gap: 2px; color: #7f9a7b; font-size: 10px; font-family: Consolas,"Cascadia Mono",monospace; }
          .think-history:empty { display: none; }
          .think-history div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          :host(.think-off) .think { display: none; }
          :host(.collapsed) .panel { display: none; }
          :host(.collapsed) .pill { display: flex; }
        </style>
        <div class="panel">
          <div class="head" id="drag">
            <div><span class="title">🌻 AI 草坪指挥官</span><span class="ver">v${VERSION}</span></div>
            <button class="icon" data-act="min" title="收起">—</button>
          </div>
          <div class="body">
            <div class="status" id="status">正在等待游戏加载…</div>
            <div class="errbar" id="errbar"></div>

            <div class="btns">
              <button id="start" class="primary">开始操控</button>
              <button id="stop" class="danger" disabled>停止</button>
            </div>
            <div class="btns">
              <button id="test">测试连接</button>
              <button id="copylog">复制日志</button>
              <button id="snap">导出状态</button>
            </div>

            <div class="log" id="log"></div>

            <div class="scroll-area">
              <details open>
                <summary>模型设置</summary>
                <div class="field"><label>API Base URL（含 /v1）</label>
                  <input type="text" id="base" spellcheck="false" placeholder="https://api.deepseek.com/v1"></div>
                <div class="field"><label>模型名</label>
                  <input type="text" id="model" spellcheck="false" placeholder="deepseek-flash"></div>
                <div class="field"><label>API Key</label>
                  <input type="password" id="key" spellcheck="false" placeholder="sk-…（只保存在本机）"></div>
                <label class="check" style="margin-top:7px"><input type="checkbox" id="persist"><span>在本机记住 Key（localStorage 明文）</span></label>
                <div class="field"><label>决策间隔（毫秒）</label>
                  <input type="number" id="interval" min="600" max="15000" step="100"></div>
                <div class="hint">DeepSeek 常用：deepseek-flash / deepseek-v4-pro。OpenRouter 可直连；OpenAI 官方通常被 CORS 拦截，请用中转。想让 Claude/Cursor 直接操控：用 PvZ-MCP 的 MCP Server，不需要在这里填 Key。F8 开始/停止，F10 显示/隐藏思考窗。游戏版本：${escapeHtml(platformVersion)}</div>
              </details>

              <details>
                <summary>默认策略（strategy.md）</summary>
                <div class="hint" id="strategyStatus">启动时读取 strategy.md…</div>
                <div class="btns" style="margin-top:6px">
                  <button id="strategyReload">重新读取 strategy.md</button>
                </div>
                <div class="hint">默认策略在模组目录的 strategy.md，用文本编辑器改；浮窗/思考窗里的输入只是本关临时策略，不会修改默认策略。</div>
              </details>

              <div class="checks">
                <label class="check"><input type="checkbox" id="autosun"><span>自动收阳光/能量豆</span></label>
                <label class="check"><input type="checkbox" id="autodeck"><span>自动选卡开局</span></label>
                <label class="check"><input type="checkbox" id="autoshovel"><span>自动铲换弱卡</span></label>
                <label class="check"><input type="checkbox" id="showthought"><span>显示思考浮窗</span></label>
                <label class="check"><input type="checkbox" id="stream"><span>流式思考（更快）</span></label>
                <label class="check"><input type="checkbox" id="local"><span>本地策略（不调用模型）</span></label>
                <label class="check"><input type="checkbox" id="debug"><span>控制台日志</span></label>
              </div>
            </div>
          </div>
        </div>
        <button class="pill idle" id="pill"><span class="dot"></span><span id="pillText">AI 待机（F8）</span></button>
        <div class="think" id="think">
          <div class="think-head" id="thinkDrag">
            <span class="think-title">🧠 AI 思考</span>
            <span class="think-stage" id="thinkStage">待机</span>
            <button class="icon" data-act="thinkmin" title="隐藏思考窗（F10 可再打开）">—</button>
          </div>
          <div class="think-body">
            <div class="think-thought" id="thinkThought">开始操控后，这里会实时显示 AI 的判断、动作和结果。</div>
            <div class="think-acts" id="thinkActs"></div>
            <div class="think-plan" id="thinkPlan"></div>
            <details class="think-board-wrap">
              <summary>位置图（模型看到的）</summary>
              <div class="think-board" id="thinkBoard"></div>
            </details>
            <div class="think-note-row">
              <div class="think-note-label">本关临时策略（只在本关生效，换关自动清空）</div>
              <textarea id="thinkNote" class="think-note" rows="2" spellcheck="false" placeholder="例如：地刺放最前面，别种在坚果后面（回车发送并立即思考）"></textarea>
              <div class="think-note-btns">
                <button id="thinkSend">发送并思考</button>
                <button id="thinkClear">清除</button>
              </div>
              <div class="think-hint" id="thinkHint"></div>
            </div>
            <div class="think-history" id="thinkHistory"></div>
          </div>
        </div>
      `;
      doc.body.appendChild(host);
      mountHost();

      // 浮窗上的输入/点击不要传给游戏，避免填 Key 时触发游戏快捷键或种植物。
      for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'wheel']) {
        shadow.addEventListener(type, (e) => e.stopPropagation(), false);
      }

      el = {
        panel: shadow.querySelector('.panel'),
        status: shadow.querySelector('#status'),
        errbar: shadow.querySelector('#errbar'),
        log: shadow.querySelector('#log'),
        pill: shadow.querySelector('#pill'),
        pillText: shadow.querySelector('#pillText'),
        start: shadow.querySelector('#start'),
        stop: shadow.querySelector('#stop'),
        base: shadow.querySelector('#base'),
        model: shadow.querySelector('#model'),
        key: shadow.querySelector('#key'),
        persist: shadow.querySelector('#persist'),
        interval: shadow.querySelector('#interval'),
        autosun: shadow.querySelector('#autosun'),
        autodeck: shadow.querySelector('#autodeck'),
        autoshovel: shadow.querySelector('#autoshovel'),
        showthought: shadow.querySelector('#showthought'),
        stream: shadow.querySelector('#stream'),
        local: shadow.querySelector('#local'),
        debug: shadow.querySelector('#debug'),
        strategyStatus: shadow.querySelector('#strategyStatus'),
        think: shadow.querySelector('#think'),
        thinkStage: shadow.querySelector('#thinkStage'),
        thinkThought: shadow.querySelector('#thinkThought'),
        thinkActs: shadow.querySelector('#thinkActs'),
        thinkPlan: shadow.querySelector('#thinkPlan'),
        thinkBoard: shadow.querySelector('#thinkBoard'),
        thinkNote: shadow.querySelector('#thinkNote'),
        thinkHint: shadow.querySelector('#thinkHint'),
        thinkHistory: shadow.querySelector('#thinkHistory'),
      };

      el.base.value = cfg.baseUrl;
      el.model.value = cfg.model;
      el.key.value = cfg.apiKey;
      el.persist.checked = cfg.persistKey;
      el.interval.value = cfg.interval;
      el.autosun.checked = cfg.autoSun;
      el.autodeck.checked = cfg.autoDeck;
      el.autoshovel.checked = cfg.autoShovel !== false;
      el.showthought.checked = cfg.showThought !== false;
      el.stream.checked = cfg.stream !== false;
      el.local.checked = cfg.localBrain;
      if (el.strategyStatus) {
        el.strategyStatus.textContent = externalStrategy
          ? `已加载 ${strategyFile || 'strategy.md'}（${externalStrategy.length} 字）`
          : '启动时读取 strategy.md…';
      }
      if (el.thinkHint) el.thinkHint.textContent = levelHint ? '👤 ' + levelHint : '';
      if (host) {
        host.classList.toggle('collapsed', !!cfg.collapsed);
        host.classList.toggle('think-off', cfg.showThought === false);
      }
      applyPos();

      const bindText = (node, key, transform = (v) => v) => {
        node.addEventListener('input', () => { cfg[key] = transform(node.value); saveCfg(); });
      };
      bindText(el.base, 'baseUrl');
      bindText(el.model, 'model');
      bindText(el.key, 'apiKey');
      el.interval.addEventListener('change', () => {
        cfg.interval = clamp(+el.interval.value || 1600, 600, 15000);
        el.interval.value = cfg.interval;
        saveCfg();
      });
      el.persist.addEventListener('change', () => {
        cfg.persistKey = el.persist.checked;
        saveCfg();
        if (!cfg.persistKey) mlog('已关闭 Key 记忆，下次需重新填写', 'warn');
      });
      el.autosun.addEventListener('change', () => { cfg.autoSun = el.autosun.checked; saveCfg(); });
      el.autodeck.addEventListener('change', () => { cfg.autoDeck = el.autodeck.checked; saveCfg(); });
      el.autoshovel.addEventListener('change', () => { cfg.autoShovel = el.autoshovel.checked; saveCfg(); });
      el.stream.addEventListener('change', () => { cfg.stream = el.stream.checked; saveCfg(); });
      el.showthought.addEventListener('change', () => {
        cfg.showThought = el.showthought.checked;
        if (host) host.classList.toggle('think-off', !cfg.showThought);
        saveCfg();
      });
      el.local.addEventListener('change', () => { cfg.localBrain = el.local.checked; saveCfg(); });
      el.debug.addEventListener('change', () => { window.__PVZAI_DEBUG__ = el.debug.checked; });

      el.start.addEventListener('click', start);
      el.stop.addEventListener('click', () => stop('手动停止'));
      shadow.querySelector('#test').addEventListener('click', testConnection);
      shadow.querySelector('#copylog').addEventListener('click', copyLog);
      shadow.querySelector('#snap').addEventListener('click', exportSnapshot);
      el.pill.addEventListener('click', () => setCollapsed(false));
      shadow.querySelector('[data-act="min"]').addEventListener('click', () => setCollapsed(true));
      const on = (sel, ev, fn) => {
        const node = typeof sel === 'string' ? shadow.querySelector(sel) : sel;
        if (node) node.addEventListener(ev, fn);
      };
      shadow.querySelector('[data-act="thinkmin"]').addEventListener('click', () => {
        cfg.showThought = false;
        el.showthought.checked = false;
        if (host) host.classList.add('think-off');
        saveCfg();
        toast('思考浮窗已隐藏，按 F10 可再打开', 'info');
      });
      on('#strategyReload', 'click', async () => {
        const ok = await loadStrategyFile(true);
        if (ok) {
          toast('已重新读取 strategy.md', 'success');
        } else {
          toast('没读到 strategy.md，仍用内置默认', 'warning');
        }
      });
      const sendHint = () => {
        if (!el.thinkNote) return;
        setLevelHint(el.thinkNote.value, { immediate: true });
        el.thinkNote.value = '';
      };
      on('#thinkSend', 'click', sendHint);
      on('#thinkClear', 'click', () => {
        setLevelHint('', { immediate: true });
        if (el.thinkNote) el.thinkNote.value = '';
      });
      if (el.thinkNote) {
        el.thinkNote.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendHint();
          }
        });
      }

      makeDraggable(shadow.querySelector('#drag'), el.panel, 'pos');
      makeDraggable(shadow.querySelector('#thinkDrag'), el.think, 'thinkPos');
      renderLog();
      updateStatus();
      uiTimer = setInterval(updateStatus, 700);
      thinkTimer = setInterval(() => { if (run && run.active) thinkRender(); }, 300);
    }

    function setCollapsed(v) {
      cfg.collapsed = !!v;
      saveCfg();
      if (shadow && host) host.classList.toggle('collapsed', !!v);
    }

    function mountHost() {
      if (!host) return;
      const doc = getDoc();
      const target = doc.fullscreenElement || doc.body;
      if (target && host.parentElement !== target) target.appendChild(host);
    }

    function applyPos() {
      if (el.panel && cfg.pos) {
        el.panel.style.left = cfg.pos.left + 'px';
        el.panel.style.top = cfg.pos.top + 'px';
        el.panel.style.right = 'auto';
        el.panel.style.bottom = 'auto';
      }
      if (el.think && cfg.thinkPos) {
        el.think.style.left = cfg.thinkPos.left + 'px';
        el.think.style.top = cfg.thinkPos.top + 'px';
        el.think.style.right = 'auto';
        el.think.style.bottom = 'auto';
      }
    }

    function makeDraggable(handle, target, posKey = 'pos') {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        const r = target.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const r = target.getBoundingClientRect();
        const left = clamp(ox + e.clientX - sx, 0, getWin().innerWidth - r.width);
        const top = clamp(oy + e.clientY - sy, 0, getWin().innerHeight - 48);
        target.style.left = left + 'px';
        target.style.top = top + 'px';
        target.style.right = 'auto';
        target.style.bottom = 'auto';
      });
      handle.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        const r = target.getBoundingClientRect();
        cfg[posKey] = { left: Math.round(r.left), top: Math.round(r.top) };
        saveCfg();
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      });
    }

    // ───────────────────────── 游戏桥 ─────────────────────────

    function findComps() {
      const cc = getCc();
      const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
      if (!scene) return null;
      const now = Date.now();
      if (compCache.scene === scene && compCache.map && now - compCache.at < 600) {
        return { cc, scene, map: compCache.map };
      }
      const map = Object.create(null);
      const walk = (n) => {
        const comps = n._components || [];
        for (let i = 0; i < comps.length; i++) {
          const c = comps[i];
          const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (k && !map[k]) map[k] = c;
        }
        const children = n.children || [];
        for (let i = 0; i < children.length; i++) walk(children[i]);
      };
      walk(scene);
      compCache = { scene, map, at: now };
      return { cc, scene, map };
    }

    function findCompByClass(scene, className) {
      if (!scene) return null;
      let hit = null;
      const walk = (n) => {
        if (hit) return;
        for (const c of n._components || []) {
          const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (k === className) { hit = c; return; }
        }
        for (const ch of n.children || []) { walk(ch); if (hit) return; }
      };
      walk(scene);
      return hit;
    }

    function findNodeByName(root, name) {
      if (!root) return null;
      if (root.name === name) return root;
      for (const ch of root.children || []) {
        const hit = findNodeByName(ch, name);
        if (hit) return hit;
      }
      return null;
    }

    const TASK_LIMIT_KEYS = ['plantCountLimit', 'plantLoseLimit', 'sunCostLimit', 'sunProduceRequest', 'sunCostCountDownLimit', 'zombieKillCount'];

    function num(v) {
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }

    // 统一的结构化失败返回；reason 保留给旧调用方/日志，code 给 Agent。
    function fail(code, extra, reason) {
      const out = { ok: false, code, retryable: false, reason: reason || TASK_REASON_TEXT[code] || code };
      if (extra && typeof extra === 'object') {
        for (const k of Object.keys(extra)) if (extra[k] !== undefined) out[k] = extra[k];
      }
      return out;
    }

    function firstNumber(s) {
      const m = String(s == null ? '' : s).match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : null;
    }

    // 7 种关卡任务的语义。除了 mode 6 的滑动窗口，其余模式也给出 left/hint/urgent。
    function applyTaskSemantics(t) {
      const mode = t.mode;
      const start = t.starting || {};
      const obj = t.detail || {};
      const countNum = firstNumber(t.count);
      const now = Date.now();

      if (mode === 6) {
        const total = t.total || num(start.ZombiesToKill) || 0;
        const limit = t.timeLimit || num(start.Time) || 0;
        let st = taskTrack.get(t.key);
        if (!st) { st = { lastValue: 0, kills: [], updatedAt: now }; taskTrack.set(t.key, st); }
        if (typeof t.value === 'number') {
          const delta = t.value - st.lastValue;
          if (delta > 0) {
            for (let i = 0; i < delta && i < 40; i++) st.kills.push(now);
          } else if (delta < 0) {
            st.kills.splice(0, Math.min(st.kills.length, -delta));
          }
          st.lastValue = t.value;
        }
        if (limit > 0) {
          while (st.kills.length && now - st.kills[0] > limit * 1000) st.kills.shift();
        }
        st.updatedAt = now;
        const active = limit > 0 ? st.kills.length : (t.value || 0);
        const timeLeft = limit > 0 && st.kills.length
          ? Math.max(0, limit - (now - st.kills[0]) / 1000)
          : null;
        const need = total > 0 && typeof t.value === 'number' ? Math.max(0, total - t.value) : null;
        t.timeSemantics = 'sliding_window';
        t.windowActive = !t.completed && !t.failed && (timeLeft !== null ? timeLeft > 0 : !!t.value);
        t.timeLeft = timeLeft === null ? null : Math.round(timeLeft * 10) / 10;
        t.windowKills = active;
        t.timeLimit = limit || null;
        t.need = need;
        t.urgent = !t.completed && !t.failed && need !== null && need > 0
          && ((t.timeLeft !== null && t.timeLeft <= 5) || (total > 0 && (t.value || 0) / total >= 0.75));
        if (t.completed) t.hint = '任务已完成';
        else if (t.failed) t.hint = '任务已失败';
        else if (t.timeLeft !== null && t.windowActive) t.hint = `滑动窗口还剩 ${t.timeLeft.toFixed(1)} 秒，当前 ${t.value}/${total}，需再杀 ${need} 个`;
        else if (need !== null) t.hint = `最近 ${limit} 秒窗口内击杀 ${t.value}/${total}，还需 ${need} 个`;
        return;
      }

      t.semantics = mode === null ? 'unknown' : (TASK_MODE_SEMANTICS[mode] || 'unknown');
      switch (mode) {
        case 0: {
          const total = num(start.MaximumPlants) ?? t.total;
          const left = countNum ?? num(obj.LeftPlants);
          if (total && left !== null) {
            t.total = total;
            t.value = Math.max(0, total - left);
            t.percent = Math.round((t.value / total) * 100);
          }
          t.left = left;
          t.hint = `还能种 ${left ?? '?'} 株（上限 ${total ?? '?'}）`;
          t.urgent = left !== null && left <= 2;
          break;
        }
        case 1: {
          const total = num(start.MaximumPlantsLost) ?? t.total;
          const left = num(obj.LeftPlantsToLose) ?? countNum;
          if (total && left !== null) {
            t.total = total;
            t.value = Math.max(0, total - left);
            t.percent = Math.round((t.value / total) * 100);
          }
          t.left = left;
          t.hint = `还可损失 ${left ?? '?'} 株（上限 ${total ?? '?'}），再丢就失败`;
          t.urgent = left !== null && left <= 1;
          break;
        }
        case 2: {
          const left = num(obj.LeftSun) ?? countNum;
          t.left = left;
          t.hint = `剩余阳光额度 ${left ?? '?'}`;
          t.urgent = left !== null && left <= 100;
          break;
        }
        case 3: {
          const produced = num(obj.SunProduced) ?? t.value;
          const total = num(start.TargetSun) ?? t.total;
          t.value = produced;
          t.total = total;
          if (produced !== null && total) t.percent = Math.round((produced / total) * 100);
          t.hint = `已产生 ${produced ?? '?'}/${total ?? '?'} 阳光`;
          t.urgent = produced !== null && total ? produced / total >= 0.8 : false;
          break;
        }
        case 4: {
          const left = num(obj.LeftTime) ?? t.timeLeft;
          t.timeSemantics = 'countdown';
          t.timeLimit = num(start.HoldoutSeconds) ?? t.timeLimit;
          t.timeLeft = left !== null ? Math.round(left * 10) / 10 : null;
          t.windowActive = left !== null && left > 0;
          t.hint = `倒计时 ${t.timeLeft ?? '?'} 秒`;
          t.urgent = left !== null && left <= 5;
          break;
        }
        case 5: {
          t.hint = `击杀 ${t.value ?? '?'}/${t.total ?? '?'}`;
          t.urgent = false;
          break;
        }
        default:
          t.hint = t.count || '';
          t.urgent = false;
      }
      if (t.completed) { t.hint = '任务已完成'; t.urgent = false; }
      if (t.failed) { t.hint = '任务已失败'; t.urgent = false; }
    }

    // 关卡任务：LevelTaskCount（每关开局后常驻在 UIInGameUpper/LevelTaskSlots 下）
    function readTasks(scene) {
      const tasks = [];
      if (!scene) return tasks;
      const walk = (n) => {
        for (const c of n._components || []) {
          const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (cls !== 'LevelTaskCount') continue;
          const tip = typeof c.tip === 'string' ? c.tip : '';
          const count = c.count && typeof c.count.string === 'string' ? c.count.string : '';
          const mode = num(c.mode);
          let value = null;
          let total = null;
          if (count && count.indexOf('/') >= 0) {
            const parts = count.split('/');
            value = Number(parts[0]);
            total = Number(parts[1]);
            if (!Number.isFinite(value)) value = null;
            if (!Number.isFinite(total)) total = null;
          }
          const limits = {};
          for (const k of TASK_LIMIT_KEYS) {
            const v = c[k];
            if (typeof v === 'number' && v !== 0) limits[k] = v;
          }
          const starting = {};
          try {
            if (c.startingObjdata && typeof c.startingObjdata === 'object') {
              for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds', 'LeftSun']) {
                const v = c.startingObjdata[k];
                if (typeof v === 'number') starting[k] = v;
              }
              // 有时字段名会被 Object.assign 到组件上
              for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds']) {
                if (starting[k] === undefined && typeof c[k] === 'number') starting[k] = c[k];
              }
            }
          } catch { /* ignore */ }
          let detail;
          try {
            if (c.objdata && typeof c.objdata === 'object') {
              detail = {};
              let n2 = 0;
              for (const k of Object.keys(c.objdata)) {
                const v = c.objdata[k];
                if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') detail[k] = v;
                if (++n2 >= 8) break;
              }
            }
          } catch { detail = undefined; }

          const task = {
            key: tip || ('mode_' + mode),
            tip,
            count,
            value,
            total,
            percent: value !== null && total ? Math.round((value / total) * 100) : null,
            mode,
            modeName: mode === null ? null : (TASK_MODE_NAME[mode] || 'mode_' + mode),
            completed: !!c.completed,
            failed: !!c.failed,
            limits: Object.keys(limits).length ? limits : undefined,
            starting: Object.keys(starting).length ? starting : undefined,
            timeLimit: mode === 6 ? num(starting.Time) : (mode === 4 ? num(starting.HoldoutSeconds) : null),
            detail,
          };
          // 进度条只作为“没有任何语义信息”时的最后兜底，避免把 PlantLoseLimit 误报成 100%。
          if (task.value === null && task.percent === null && (mode === null || TASK_MODE_SEMANTICS[mode] === undefined)
            && c.progress && typeof c.progress._progress === 'number') {
            const p = c.progress._progress;
            task.percent = Math.round(p * 100);
            if (task.percent > 100) task.percent = 100;
          }
          if (!task.modeName && task.mode !== null) task.modeName = 'mode_' + task.mode;
          applyTaskSemantics(task);
          tasks.push(task);
        }
        for (const ch of n.children || []) walk(ch);
      };
      walk(scene);
      return tasks;
    }

    // 开局的目标说明弹窗（LevelObjectiveScreen），必须先点“继续”才能进选卡
    function readObjective(scene) {
      const obj = findCompByClass(scene, 'LevelObjectiveScreen');
      if (!obj) return null;
      const node = obj.node || null;
      const screenName = obj.screenName && typeof obj.screenName.string === 'string' ? obj.screenName.string : '';
      const missions = [];
      const push = (t) => {
        const s = String(t || '').trim();
        if (!s || s.length < 3) return;
        if (s === screenName) return;
        if (/^(继续|开始|开始游戏|确定|下一步|返回|取消)$/.test(s)) return;
        if (/^(关卡任务|任务|任务目标|目标|本关任务|任务说明)$/.test(s)) return;
        if (missions.indexOf(s) < 0) missions.push(s);
      };
      if (obj.mission0 && typeof obj.mission0.string === 'string') push(obj.mission0.string);
      const walkLabels = (n) => {
        for (const c of n._components || []) {
          const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (cls === 'cc.Label' && typeof c.string === 'string') push(c.string);
        }
        for (const ch of n.children || []) walkLabels(ch);
      };
      if (node) walkLabels(node);
      const active = !!node && node.activeInHierarchy !== false && node.active !== false && !obj.faded;
      return {
        screenName,
        missions,
        hints: parseMissionHints(missions),
        active,
        canContinue: typeof obj.continue === 'function',
      };
    }

    // LnC 地形：squareType 0=solid 1=sky 2=water 3=sea 4=deck
    function cellTerrain(C, lane, column) {
      const out = { lane, column, letter: '?', terrain: 'unknown', plantable: false, tilePutable: false, exists: false };
      let cell = null;
      try { cell = C.getLnC(lane, column); } catch { cell = null; }
      if (!cell) return out;
      out.exists = true;
      let st = null;
      try { st = num(cell.squareType); } catch { st = null; }
      if (st === null) { try { st = num(cell._squareType); } catch { st = null; } }
      if (st !== null) {
        out.squareType = st;
        out.letter = SQUARE_TYPE_LETTER[st] || '?';
        out.terrain = SQUARE_TYPE_NAME[st] || 'unknown';
      }
      try {
        if (cell.rail) {
          out.letter = 'R';
          out.terrain = 'rail';
          out.rail = true;
        }
      } catch { /* ignore */ }
      try { out.hasCart = !!cell.cart; } catch { out.hasCart = false; }
      try { if (typeof cell.plantable === 'function') out.plantable = !!cell.plantable(); } catch { /* ignore */ }
      try { if (typeof cell.tilePutable === 'function') out.tilePutable = !!cell.tilePutable(undefined, true); } catch { /* ignore */ }
      return out;
    }

    function refreshLearning(levelKey) {
      if (levelKey === learnedLevelKey) return;
      learnedLevelKey = levelKey;
      learnedCells.clear();
      taskTrack.clear();
      lastPlants = new Map();
      shoveledAt.clear();
      recentShovels.length = 0;
      recentLosses = [];
      previewCache = { key: '', at: 0, value: null };
      terrainCache = { key: '', at: 0, value: null };
      mechCache = { key: '', at: 0, value: null };
      tileCache = { key: '', at: 0, value: null };
      if (run) {
        run.objectiveMissions = [];
        run.planDeckDone = false;
        run.planDeckRetried = false;
      }
    }

    // 把地形矩阵 + 不可种植格子放进 snapshot。只增字段，不改旧结构。
    function readTerrain(C, lanes, cols) {
      const map = [];
      const blocked = [];
      for (let r = 0; r < lanes; r++) {
        let row = '';
        for (let c = 0; c < cols; c++) {
          const info = cellTerrain(C, r, c);
          row += info.letter;
          if (info.exists) {
            if (info.letter === 'W' || info.letter === 'S') {
              blocked.push({ lane: r, column: c, terrain: info.terrain, reason: info.terrain === 'sky' ? 'sky' : 'water' });
            } else if (info.letter === 'R' && !info.hasCart) {
              blocked.push({ lane: r, column: c, terrain: 'rail', reason: 'rail' });
            }
          }
        }
        map.push(row);
      }
      return { lanes, columns: cols, map, legend: TERRAIN_LEGEND, blockedCells: blocked };
    }

    // ── 矿车（西部矿车是可在同一轨道列上下移动的植物平台）──
    function collectCartRefs(C, lanes, cols) {
      const seen = new Set();
      const refs = [];
      for (let r = 0; r < lanes; r++) {
        for (let c = 0; c < cols; c++) {
          let cell = null;
          try { cell = C.getLnC(r, c); } catch { cell = null; }
          if (!cell || !cell.rail) continue;
          let cart = null;
          try { cart = cell.cart; } catch { cart = null; }
          if (!cart || seen.has(cart)) continue;
          seen.add(cart);
          const inL = cart._inLnC || null;
          const lane = inL && Number.isFinite(inL.lIndex) ? inL.lIndex : null;
          const column = inL && Number.isFinite(inL.cIndex) ? inL.cIndex : null;
          const railLanes = [];
          if (column !== null) {
            for (let rr = 0; rr < lanes; rr++) {
              let cc = null;
              try { cc = C.getLnC(rr, column); } catch { cc = null; }
              if (cc && cc.rail && Array.isArray(cc.rail.carts) && cc.rail.carts.indexOf(cart) >= 0) railLanes.push(rr);
            }
          }
          let canUp = false, canDown = false;
          try { canUp = !!(inL && inL.upper && cart.canMoveToLnC(inL.upper)); } catch { canUp = false; }
          try { canDown = !!(inL && inL.lower && cart.canMoveToLnC(inL.lower)); } catch { canDown = false; }
          refs.push({ cart, lane, column, railLanes, canUp, canDown });
        }
      }
      return refs;
    }

    function readCarts(C, lanes, cols) {
      return collectCartRefs(C, lanes, cols).map((ref, i) => ({
        id: i,
        lane: ref.lane,
        column: ref.column,
        railLanes: ref.railLanes,
        plants: ref.lane !== null && ref.column !== null
          ? cellPlantList(C.getLnC(ref.lane, ref.column)).map((p) => {
            const type = cleanCodename(p.Plant_Type || '');
            return { type, name: PLANT_CN[type] || type, hp: Math.round(p.health || 0) };
          })
          : [],
        canUp: ref.canUp,
        canDown: ref.canDown,
      }));
    }

    function readSpecialTiles(C, lanes, cols) {
      const out = [];
      const seen = new Set();
      const push = (lane, column, type, cls) => {
        const key = `${lane}:${column}:${type}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ lane, column, type, class: cls || type });
      };
      for (let r = 0; r < lanes; r++) {
        for (let c = 0; c < cols; c++) {
          let cell = null;
          try { cell = C.getLnC(r, c); } catch { cell = null; }
          if (!cell) continue;
          if (cell.rail) push(r, c, 'rail', 'railway');
          if (cell.haveTomb) push(r, c, 'tomb', 'Tomb');
          if (cell.mold) push(r, c, 'mold', 'moldSquare');
          if (cell.vases && cell.vases.length) push(r, c, 'vase', 'Vase');
          if (cell.iceTile) push(r, c, 'ice', 'iceTile');
          for (const t of (cell.tilesInSquare || [])) {
            const name = compNameOf(t);
            for (const [re, type] of TILE_CLASS_TYPES) {
              if (re.test(name)) { push(r, c, type, name); break; }
            }
          }
        }
      }
      return out;
    }

    function buildLanes(C, lanes, cols, plants, zombies, carts) {
      const out = [];
      for (let r = 0; r < lanes; r++) {
        const ps = plants.filter((p) => p.lane === r);
        const zs = zombies.filter((z) => z.lane === r);
        const rc = { sun: 0, wall: 0, spring: 0, freeze: 0, spike: 0, shooter: 0, other: 0 };
        ps.forEach((p) => { const role = plantRole(p.type); rc[role] = (rc[role] || 0) + 1; });
        const nearest = zs.length ? Math.min(...zs.map((z) => z.column)) : null;
        let mower = false;
        try { mower = !!C.getLane(r).mower; } catch { mower = false; }
        const cart = carts.find((c) => Array.isArray(c.railLanes) && c.railLanes.indexOf(r) >= 0) || null;
        out.push({
          lane: r,
          label: `第${r + 1}排`,
          plants: ps.length,
          shooters: rc.shooter,
          sun: rc.sun,
          walls: rc.wall,
          spikes: rc.spike,
          zombies: zs.length,
          nearestZombie: nearest === null ? null : Math.round(nearest * 10) / 10,
          mower,
          cart: cart ? { id: cart.id, lane: cart.lane, plants: cart.plants.map((p) => p.type) } : null,
          needsShooter: zs.length > 0 && rc.shooter === 0,
          danger: nearest !== null && nearest <= 4,
        });
      }
      return out;
    }

    function compNameOf(c) {
      return String((c && (c.__classname__ || (c.constructor && c.constructor.name))) || '');
    }

    function getConveyor(ctxg) {
      if (!ctxg || !ctxg.scene) return null;
      let hit = null;
      (function walk(n) {
        if (hit) return;
        for (const c of n._components || []) {
          if (compNameOf(c) === 'Conveyor') { hit = c; return; }
        }
        for (const ch of n.children || []) { walk(ch); if (hit) return; }
      })(ctxg.scene);
      return hit;
    }

    function conveyorCards(cv) {
      if (!cv) return [];
      try { return (typeof cv.getCards === 'function' ? cv.getCards() : []) || []; } catch { return []; }
    }

    function conveyorSlots(cv) {
      if (!cv) return [];
      return [].concat(cv.lane1slots || [], cv.lane2slots || [], cv.laneVertslots || []).filter(Boolean);
    }

    function isConveyorMode(cv, cards) {
      if (!cv) return false;
      const plantList = Array.isArray(cv.plantList) ? cv.plantList.length : 0;
      const live = conveyorCards(cv).length;
      const cardCount = cards && Array.isArray(cards.CFs) ? cards.CFs.length : 0;
      return cardCount === 0 && (plantList > 0 || live > 0);
    }

    const TILE_CLASS_TYPES = [
      [/railway|^rail$/i, 'rail'],
      [/goldTile/i, 'gold'],
      [/endangeredTile/i, 'endangered'],
      [/sliderTile/i, 'slider'],
      [/moldSquare/i, 'mold'],
      [/iceblock|iceTile/i, 'ice'],
    ];

    // 只挑安全、可序列化的字段，避免把整个 Cocos 对象塞进 state。
    function compFacts(c) {
      const out = { class: compNameOf(c) };
      const keys = [
        'lIndex', 'cIndex', 'row', 'column', 'lane', 'inLane',
        'action', 'state', 'phase', 'type', 'kind', 'ID', 'name',
        'pos', 'moving', 'waterLevel',
        'Direction', 'LanesToAffect', 'Column', 'LifeSpan', 'TimeBeforeAbsorbing', 'SuppressesNextWave',
        'World', 'TimeBeforeFirst', 'TimeBetween', 'Scale',
        'hp', 'health', 'dead', 'active', 'countdown', 'cd', 'time',
      ];
      for (const holder of [c, c && c.objdataOwn, c && c.objdata]) {
        if (!holder || typeof holder !== 'object') continue;
        for (const k of keys) {
          if (out[k] !== undefined) continue;
          let v;
          try { v = holder[k]; } catch { continue; }
          if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) out[k] = v;
          else if (Array.isArray(v) && v.length && v.every((x) => ['number', 'string', 'boolean'].includes(typeof x))) out[k] = v.slice(0, 6);
        }
      }
      if (!Number.isFinite(out.lane)) {
        if (Number.isFinite(c && c.lIndex)) out.lane = c.lIndex;
        else if (c && c.inLnC && Number.isFinite(c.inLnC.lIndex)) out.lane = c.inLnC.lIndex;
      }
      if (!Number.isFinite(out.column)) {
        if (Number.isFinite(c && c.cIndex)) out.column = c.cIndex;
        else if (c && c.inLnC && Number.isFinite(c.inLnC.cIndex)) out.column = c.inLnC.cIndex;
      }
      return out;
    }

    // 通用机制探测：不按地图写死，按场景组件类名识别。
    function readMechanics(scene, C, lanes, cols, lvl) {
      const comps = [];
      (function walk(n) {
        for (const c of n._components || []) comps.push(c);
        for (const ch of n.children || []) walk(ch);
      })(scene);

      const byName = (re) => comps.filter((c) => re.test(compNameOf(c)));
      const features = [];
      const tiles = [];
      const tileSeen = new Set();
      const pushTile = (lane, column, type, cls) => {
        const key = `${lane}:${column}:${type}`;
        if (tileSeen.has(key)) return;
        tileSeen.add(key);
        tiles.push({ lane, column, type, class: cls || type });
      };

      let waterCells = 0, solidCells = 0, skyCells = 0, railCells = 0;
      const unmapped = new Set();
      for (let r = 0; r < lanes; r++) {
        for (let c = 0; c < cols; c++) {
          let cell = null;
          try { cell = C.getLnC(r, c); } catch { cell = null; }
          if (!cell) continue;
          let st = null;
          try { st = cell.squareType; } catch { /* ignore */ }
          if (st === 0 || st === 4) solidCells++;
          if (st === 1) skyCells++;
          if (st === 2 || st === 3) waterCells++;
          if (cell.rail) { railCells++; pushTile(r, c, 'rail', 'railway'); }
          if (cell.haveTomb) pushTile(r, c, 'tomb', 'Tomb');
          if (cell.mold) pushTile(r, c, 'mold', 'moldSquare');
          if (cell.iceTile) pushTile(r, c, 'ice', 'iceTile');
          if (cell.vases && cell.vases.length) pushTile(r, c, 'vase', 'Vase');
          for (const t of (cell.tilesInSquare || [])) {
            const name = compNameOf(t);
            let hit = null;
            for (const [re, type] of TILE_CLASS_TYPES) if (re.test(name)) { hit = type; break; }
            if (hit) pushTile(r, c, hit, name);
            else if (/Tile$/i.test(name) && !/^Tile$/i.test(name)) unmapped.add(name);
          }
        }
      }
      if (waterCells) features.push('water');
      if (railCells) features.push('rail');
      if (skyCells) features.push('sky');
      for (const type of ['tomb', 'gold', 'endangered', 'slider', 'mold', 'ice', 'vase']) {
        if (tiles.some((t) => t.type === type)) features.push(type);
      }

      let tide = null;
      const tideComp = byName(/^Tide$/i)[0];
      if (tideComp) {
        tide = { pos: num(tideComp.pos), moving: !!tideComp.moving, waterColumns: num(tideComp.pos) !== null ? Math.max(0, cols - num(tideComp.pos)) : null };
        features.push('tide');
      }

      const dinosaurs = byName(/(Ankylo|Ptero|Raptor|Stego|Tyranno)Dinosaur/i)
        .map((c) => {
          const f = compFacts(c);
          f.kind = compNameOf(c).replace(/Dinosaur$/i, '').toLowerCase();
          return f;
        });
      if (dinosaurs.length) features.push('dinosaur');

      const portals = byName(/^Portal$/i).map(compFacts);
      if (portals.length) features.push('portal');

      const hazards = [];
      for (const c of byName(/^ChiHole$/i)) {
        const f = compFacts(c);
        f.type = 'chi_hole';
        hazards.push(f);
      }
      for (const c of byName(/DarkWizardSheep/i)) {
        const f = compFacts(c);
        f.type = 'sheep';
        hazards.push(f);
      }
      if (hazards.length) features.push('hazard');

      const conveyorComp = byName(/^Conveyor$/i)[0];
      const conveyor = !!conveyorComp && (
        (Array.isArray(conveyorComp.plantList) && conveyorComp.plantList.length > 0) ||
        (Array.isArray(conveyorComp.dropDelayConditions) && conveyorComp.dropDelayConditions.length > 0) ||
        (Array.isArray(conveyorComp.speedConditions) && conveyorComp.speedConditions.length > 0)
      );
      const vaseLevel = tiles.some((t) => t.type === 'vase');
      const skyLevel = skyCells > 0 && solidCells === 0;
      if (conveyor) features.push('conveyor');
      if (vaseLevel) features.push('vase');

      let supported = true, unsupportedReason = null;
      const levelName = String((lvl && (lvl.levelNameString || lvl.levelName)) || '');
      if (vaseLevel || /砸罐|vase/i.test(levelName)) { supported = false; unsupportedReason = 'vase'; }
      else if (skyLevel || /天空|sky/i.test(levelName)) { supported = false; unsupportedReason = 'sky'; }
      else if (/保龄球|bowling/i.test(levelName)) { supported = false; unsupportedReason = 'bowling'; }

      return {
        supported,
        unsupportedReason,
        features: [...new Set(features)],
        tide,
        dinosaurs,
        portals,
        hazards,
        tiles,
        unmappedTiles: [...unmapped].slice(0, 12),
      };
    }

    function cardCostOf(s, type) {
      const list = (s.cards || []).concat((s.conveyor && s.conveyor.cards) || []);
      const c = list.find((x) => x.type === type);
      return c && Number.isFinite(c.cost) ? c.cost : null;
    }

    // 通用扒关卡数据里的 RTID：不同世界/版本字段名不同，所以按对象遍历找 RTID(...)，
    // 再用图鉴 id 表判断是僵尸还是植物，作为“本关预计出现的敌人”。
    function readLevelPreview(lvl) {
      if (!lvl) return null;
      const rtids = [];
      const seen = new Set();
      let budget = 3000;
      const skip = /^(node|scene|_components|parent|children|sprite|root|worldPosition|manager|__)/i;
      const walk = (v, depth) => {
        if (!v || depth > 5 || budget <= 0 || rtids.length > 160) return;
        budget--;
        if (typeof v === 'string') {
          const m = /RTID\(([^@)]+)/i.exec(v);
          if (m) rtids.push(m[1]);
          return;
        }
        if (typeof v !== 'object') return;
        if (seen.has(v)) return;
        seen.add(v);
        let keys = [];
        try { keys = Object.keys(v); } catch { return; }
        for (const k of keys) {
          if (skip.test(k)) continue;
          let child;
          try { child = v[k]; } catch { continue; }
          if (child === null || child === undefined || typeof child === 'function') continue;
          if (typeof child === 'object' || typeof child === 'string') walk(child, depth + 1);
        }
      };
      try { walk(lvl, 0); } catch { /* ignore */ }
      if (!rtids.length) return null;
      ensureKbNames();
      const zombies = [];
      const plants = [];
      for (const id of new Set(rtids)) {
        if (kb.zombieIdSet && kb.zombieIdSet.has(id)) {
          if (zombies.indexOf(id) < 0) zombies.push(id);
        } else if (kb.plantIdSet && kb.plantIdSet.has(id)) {
          if (plants.indexOf(id) < 0) plants.push(id);
        }
      }
      if (!zombies.length && !plants.length) return null;
      return { zombies: zombies.slice(0, 16), plants: plants.slice(0, 16), source: 'level-data' };
    }

    // 给模型的“可铲除/可替换”清单：只看结构性证据（超限、可升级、位置不对、残血），不做主观猜测。
    function shovelCandidates(s) {
      const out = [];
      const seen = new Set();
      const lanes = (s.grid && s.grid.lanes) || 5;
      const push = (p, reason, extra) => {
        const key = p.lane + ':' + p.column;
        if (!p || seen.has(key) || out.length >= 8) return;
        seen.add(key);
        const hpPercent = p.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((p.hp / p.maxHp) * 100))) : null;
        out.push({
          lane: p.lane, column: p.column, type: p.type,
          name: p.name || PLANT_CN[p.type] || p.type,
          hp: p.hp, hpPercent, reason, ...extra,
        });
      };
      const byRole = Object.create(null);
      for (const p of s.plants) {
        const role = plantRole(p.type);
        (byRole[role] = byRole[role] || []).push(p);
      }
      const cost = (type) => cardCostOf(s, type);
      const strength = (p) => plantStrength(p.type, cost(p.type));
      const cols = (s.grid && s.grid.columns) || 9;
      const occupiedNow = new Set((s.plants || []).map((p) => `${p.lane}:${p.column}`));
      const blockedNow = new Set(((s.blockedCells || [])).map((b) => `${b.lane}:${b.column}`));
      const rowOf = (lane) => (s.terrain && Array.isArray(s.terrain.map) ? String(s.terrain.map[lane] || '') : '');
      const freeIn = (lane, from, to) => {
        const row = rowOf(lane);
        for (let c = from; c <= to && c < cols; c++) {
          if (occupiedNow.has(`${lane}:${c}`)) continue;
          if (blockedNow.has(`${lane}:${c}`)) continue;
          const ch = row[c];
          if (ch === 'W' || ch === 'S') continue;
          return true;
        }
        return false;
      };
      // 僵尸已经贴到它左边 1.5 列内：这株马上就要被吃，铲了换也是白花阳光。
      const threatened = (p) => (s.zombies || []).some((z) =>
        z.lane === p.lane && z.column <= p.column && z.column >= p.column - 1.5);

      // 1) 超出每行软上限：留强的，铲最弱的
      for (const role of Object.keys(ROLE_LIMIT)) {
        const limit = ROLE_LIMIT[role];
        for (let lane = 0; lane < lanes; lane++) {
          const list = (byRole[role] || []).filter((p) => p.lane === lane);
          if (list.length <= limit) continue;
          const sorted = list.slice().sort((a, b) => strength(b) - strength(a));
          for (const p of sorted.slice(limit)) push(p, 'over_limit', { role, limit });
        }
      }

      // 2) 同格升级：位置已经不够用了，而手上正好有更强的同类卡
      const readyCards = (s.conveyor && s.conveyor.enabled && Array.isArray(s.conveyor.cards))
        ? s.conveyor.cards.filter((c) => c.ready)
        : (s.cards || []).filter((c) => c.ready);
      for (const role of ['shooter', 'wall', 'sun']) {
        const better = readyCards
          .filter((c) => plantRole(c.type) === role)
          .sort((a, b) => plantStrength(b.type, b.cost) - plantStrength(a.type, a.cost))[0];
        if (!better) continue;
        const betterStrength = plantStrength(better.type, better.cost);
        for (let lane = 0; lane < lanes; lane++) {
          const list = (byRole[role] || []).filter((p) => p.lane === lane);
          if (!list.length) continue;
          // 输出：位置已满（4 个射手或 c1-c4 没空位）；坚果：有墙就允许升级；阳光：已有 2 个
          const crowded = role === 'shooter'
            ? (list.length >= ROLE_LIMIT.shooter || !freeIn(lane, 1, 4))
            : role === 'wall'
              ? true
              : list.length >= ROLE_LIMIT.sun;
          if (!crowded) continue;
          const weakest = list.slice().sort((a, b) => strength(a) - strength(b))[0];
          if (!weakest || weakest.type === better.type || threatened(weakest)) continue;
          const wt = plantTier(weakest.type), bt = plantTier(better.type);
          const stronger = bt > wt
            || (bt === wt && (Number(better.cost) || 0) >= (Number(cost(weakest.type)) || 0) + 60);
          if (!stronger || strength(weakest) + 60 > betterStrength) continue;
          // 坚果升级比较贵，留一点阳光余量，避免换完墙没钱补输出
          if (role === 'wall' && (Number(s.sun) || 0) < (Number(better.cost) || 0) + 75) continue;
          push(weakest, 'upgrade', {
            role, better: better.type, betterName: better.name,
            betterCard: better.index, needSun: better.cost,
          });
        }
      }

      // 3) 位置明显不合理（坚果是前排，放在后排才是浪费）
      for (const p of s.plants) {
        const role = plantRole(p.type);
        if (role === 'sun' && p.column >= 4) push(p, 'misplaced', { hint: '阳光生产者太靠前，容易被吃' });
        else if (role === 'wall' && p.column <= 2) push(p, 'misplaced', { hint: '坚果放在最后排，挡不住僵尸' });
        else if (role === 'spike') {
          const wallAhead = (byRole.wall || []).some((w) => w.lane === p.lane && w.column > p.column);
          if (p.column < 4 || wallAhead) {
            push(p, 'misplaced', {
              hint: wallAhead ? '地刺在坚果后面，坚果挡住的僵尸踩不到' : '地刺太靠后，僵尸走不到',
            });
          }
        }
      }

      // 4) 残血：马上要死，同角色有卡能补
      for (const p of s.plants) {
        const role = plantRole(p.type);
        if (role !== 'shooter' && role !== 'sun') continue;
        const maxHp = p.maxHp || 0;
        if (!maxHp || p.hp > maxHp * 0.15) continue;
        if (threatened(p)) continue;
        if (readyCards.some((c) => plantRole(c.type) === role)) push(p, 'low_hp', { role });
      }
      return out;
    }

    function levelKeyOf(s) {
      const lv = (s.level && (s.level.name || s.level.id)) || '';
      return [s.scene || '', lv, s.grid ? `${s.grid.lanes}x${s.grid.columns}` : ''].join('#');
    }

    function snapshot() {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '尚未进入游戏场景' };
      const { scene, map } = ctxg;
      const sceneName = scene.name || '';
      const cards = map.Cards || null;
      const ui = map.UIInGame || null;
      const sunComp = map.SunCount || null;
      const droppings = map.Droppings || null;
      const lvl = map.levelController || null;
      const square = map.Square || null;

      let phase = 'other';
      if (sceneName === 'mainScene') phase = 'menu';
      else if (/worldmap/i.test(sceneName)) phase = 'worldmap';
      else if (sceneName === 'inGameScene') {
        const fighting = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted);
        if (lvl && lvl.gameWon) phase = 'won';
        else if (lvl && lvl.gameLost) phase = 'lost';
        else if (!fighting) phase = 'preparing';
        else phase = 'running';
      }

      const levelKey = String((lvl && (lvl.levelNameString || lvl.levelID || lvl.levelName)) || sceneName);
      refreshLearning(levelKey && levelKey !== 'inGameScene' ? levelKey : '');

      const tasks = readTasks(scene);
      const objective = readObjective(scene);
      if (phase === 'preparing' && objective && objective.active) phase = 'objective';

      const out = {
        ok: true,
        scene: sceneName,
        phase,
        sun: sunComp ? sunComp.CurrentValue : null,
        level: {
          name: (lvl && lvl.levelNameString) || '',
          id: String((lvl && (lvl.levelID || lvl.levelName || lvl.levelNameString)) || ''),
          wave: lvl && Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0,
          waves: (lvl && lvl.waveManagerProps && lvl.waveManagerProps.WaveCount) || null,
          progress: lvl ? Math.round((lvl.levelProgressPercentage || 0) * 100) : 0,
          nextWaveIn: lvl && Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null,
          selectedIndex: ui ? ui.index : -1,
          gameStarted: !!(lvl && lvl.gameStarted),
          rocked: !!(lvl && lvl.letsRocked),
        },
        plantFood: map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null,
        tasks,
        objective,
        cards: [],
        conveyor: null,
        plants: [],
        zombies: [],
        suns: [],
        terrain: null,
        blockedCells: [],
        carts: [],
        lanes: [],
        board: null,
        specialTiles: [],
        mechanics: null,
        recentLosses: [],
        paused: !!(ui && ui.paused),
        ui: ui ? { paused: !!ui.paused, index: ui.index, indexLocked: !!ui.indexLocked } : null,
        seedSelection: null,
        objectiveMissions: (objective && objective.missions) || (run && run.objectiveMissions) || [],
        world: null,
        missionHints: parseMissionHints(
          ((objective && objective.missions) || []).concat(
            (run && run.objectiveMissions) || [],
            tasks.map((t) => t.tip),
          ),
        ),
        levelPreview: null,
        shovelCandidates: [],
        recentShovels: [],
        plan: null,
      };

      try {
        const pvNow = Date.now();
        const pvTtl = previewCache.value ? 15000 : 2000;
        if (previewCache.key === levelKey && pvNow - previewCache.at < pvTtl) out.levelPreview = previewCache.value;
        else {
          out.levelPreview = readLevelPreview(lvl);
          previewCache = { key: levelKey, at: pvNow, value: out.levelPreview };
        }
      } catch { out.levelPreview = null; }

      // 世界常识兜底：关卡数据没读到僵尸时，按世界给出常见威胁与机制。
      try {
        const world = worldNoteOf(`${out.level.name} ${out.level.id} ${sceneName}`);
        if (world) {
          out.world = {
            key: world.key, name: world.name,
            mechanics: world.mechanics, tips: world.tips,
            zombies: world.zombies.slice(0, 10),
          };
          if (!out.levelPreview || !out.levelPreview.zombies || !out.levelPreview.zombies.length) {
            out.levelPreview = {
              zombies: out.world.zombies.slice(0, 10),
              plants: (out.levelPreview && out.levelPreview.plants) || [],
              source: 'world-knowledge',
            };
          } else {
            out.levelPreview.source = out.levelPreview.source || 'level-data';
          }
        }
      } catch { /* ignore */ }

      if (cards && Array.isArray(cards.CFs)) {
        const sunNow = out.sun;
        out.cards = cards.CFs.map((cf, i) => {
          const upper = cards.cardsUIUpper && cards.cardsUIUpper[i];
          const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
          const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
          const affordable = (cf.ca && cf.ca.free) || (Number.isFinite(sunNow)
            ? sunNow >= cost
            : !!(cf.ca && cf.ca.affordable));
          const cooling = !!(cf.ca && cf.ca.cooling) || cd > 0;
          return {
            index: i,
            type: cf.Type || '',
            name: PLANT_CN[cf.Type] || cf.Type || '',
            cost,
            cd: Math.round(cd * 10) / 10,
            affordable,
            cooling,
            ready: affordable && !cooling,
            selected: !!(ui && ui.index === i),
          };
        });
      }

      const cvNow = getConveyor(ctxg);
      if (cvNow && isConveyorMode(cvNow, cards)) {
        try {
          const list = conveyorCards(cvNow);
          out.conveyor = {
            enabled: true,
            vertical: !!cvNow.isVertical,
            cards: list.map((cf, i) => ({
              index: i,
              type: cf.Type || '',
              name: PLANT_CN[cf.Type] || cf.Type || '',
              ready: true,
            })),
            plantList: (cvNow.plantList || []).map((p) => p && (p.PlantType || p.Type)).filter(Boolean),
            slots: conveyorSlots(cvNow).map((s) => (s.card ? s.card.Type : null)),
          };
        } catch { out.conveyor = null; }
      }

      if (square) {
        const C = square.constructor;
        const lanes = C.LaneCount || 5;
        const cols = C.ColumnCount || 9;
        out.grid = { lanes, columns: cols };
        {
          const nowT = Date.now();
          if (terrainCache.key === levelKey && terrainCache.value && nowT - terrainCache.at < 400) out.terrain = terrainCache.value;
          else {
            try { out.terrain = readTerrain(C, lanes, cols); } catch { out.terrain = null; }
            terrainCache = { key: levelKey, at: nowT, value: out.terrain };
          }
        }

        const seen = new Set();
        for (let r = 0; r < lanes; r++) {
          for (let c = 0; c < cols; c++) {
            const cell = C.getLnC(r, c);
            if (!cell) continue;
            for (const p of cellPlantList(cell)) {
              if (!p || seen.has(p)) continue;
              seen.add(p);
              const rawType = p.Plant_Type || '';
              const type = cleanCodename(rawType);
              out.plants.push({
                lane: r, column: c,
                type,
                name: PLANT_CN[type] || type,
                hp: Math.round(p.health || 0),
                maxHp: Math.round(p.toughness || 0),
                foodable: !!p.foodable && !p.fooding,
              });
            }
          }
        }

        for (let r = 0; r < lanes; r++) {
          const lane = C.getLane(r);
          if (!lane) continue;
          let pool = [];
          try { pool = (lane.zombiePool ? lane.zombiePool() : []).concat(lane.hypnoZombiePool ? lane.hypnoZombiePool() : []); } catch { pool = []; }
          for (const z of pool) {
            if (!z) continue;
            let alive = true;
            try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
            if (!alive) continue;
            const col = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
            const type = cleanCodename(z.Zombie_Type || '');
            out.zombies.push({
              lane: r,
              column: Math.round(col * 10) / 10,
              gridColumn: Math.round(col),
              type,
              name: ZOMBIE_CN[type] || type,
              tags: zombieTraits(type),
              hp: Math.round(z.health || 0),
              maxHp: Math.round((z.totalHealth ? z.totalHealth() : z.health) || 0),
              hypnotized: !!z.hypnotized,
            });
          }
        }
        out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);

        // 对比上一次快照，记录“刚刚消失的植物”（自己铲掉 / 矿车移动时忽略）。
        try {
          const nowMs = Date.now();
          const current = new Map();
          for (const p of out.plants) current.set(`${p.lane}:${p.column}`, { type: p.type, hp: p.hp });
          if (nowMs >= cartMoveUntil) {
            for (const [key, old] of lastPlants) {
              if (current.has(key)) continue;
              const t = shoveledAt.get(key);
              if (t && nowMs - t < 3000) continue;
              const [lane, col] = key.split(':').map(Number);
              const near = out.zombies.filter((z) => z.lane === lane && Math.abs(z.column - col) <= 1.5).length;
              recentLosses.push({ lane, column: col, type: old.type, nearZombies: near, at: nowMs });
            }
            recentLosses = recentLosses.slice(-12);
          }
          lastPlants = current;
        } catch { /* ignore */ }

        try { out.carts = readCarts(C, lanes, cols); } catch { out.carts = []; }
        try { out.lanes = buildLanes(C, lanes, cols, out.plants, out.zombies, out.carts); } catch { out.lanes = []; }
        // 棋盘：给 MCP / 外部调用方一个和提示词一致的 5×9 结构化视图
        try {
          out.board = [];
          for (let r = 0; r < lanes; r++) {
            const cells = new Array(cols).fill(null);
            for (const p of out.plants) if (p.lane === r && p.column >= 0 && p.column < cols) cells[p.column] = p.type;
            out.board.push({
              lane: r,
              cells,
              zombies: out.zombies.filter((z) => z.lane === r)
                .map((z) => ({ column: z.column, type: z.type, hp: z.hp })),
            });
          }
        } catch { out.board = null; }
        {
          const nowS = Date.now();
          if (tileCache.key === levelKey && nowS - tileCache.at < 1200) out.specialTiles = tileCache.value;
          else {
            try { out.specialTiles = readSpecialTiles(C, lanes, cols); } catch { out.specialTiles = []; }
            tileCache = { key: levelKey, at: nowS, value: out.specialTiles };
          }
        }
        {
          const nowM = Date.now();
          if (mechCache.key === levelKey && nowM - mechCache.at < 1200 && mechCache.value) {
            out.mechanics = mechCache.value;
          } else {
            try {
              out.mechanics = readMechanics(scene, C, lanes, cols, lvl);
              mechCache = { key: levelKey, at: nowM, value: out.mechanics };
            } catch { out.mechanics = null; }
          }
          lastMechanics = { ...out.mechanics, at: Date.now() };
        }
      }

      if (droppings && Array.isArray(droppings.sunPool)) {
        for (const s of droppings.sunPool) {
          if (!s || s.collected) continue;
          let valid = true;
          try { valid = !s.node || s.node.isValid; } catch { valid = true; }
          if (!valid) continue;
          out.suns.push({ value: s.value || 0 });
        }
      }

      if (cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)) {
        out.seedSelection = {
          slots: cards.maxSlotCount || 0,
          available: cards.seedChooser.CFs
            .filter((cf) => cf && cf.Type && !(cf.ca && cf.ca.locked) && !(cf.ca && cf.ca.disallowed))
            .map((cf) => ({
              type: cf.Type,
              name: PLANT_CN[cf.Type] || cf.Type,
              cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0,
              chosen: !!(cf.ca && cf.ca.chosen),
            })),
        };
      }

      // 学习型兜底：putPlantAvailable 判定失败的格子（第二次不再撞）。
      const now = Date.now();
      for (const [k, v] of learnedCells) {
        if (!v || v.until <= now) { learnedCells.delete(k); continue; }
        const [lane, column] = k.split(':').map(Number);
        out.blockedCells.push({
          lane, column,
          terrain: v.terrain || '?',
          reason: v.code || 'blocked',
          learned: true,
        });
      }
      if (out.terrain && Array.isArray(out.terrain.blockedCells)) {
        out.blockedCells = out.blockedCells.concat(out.terrain.blockedCells);
      }

      try { out.shovelCandidates = shovelCandidates(out); } catch { out.shovelCandidates = []; }
      const lossTask = (out.tasks || []).find((t) => t.semantics === 'loss_limit' && !t.completed && Number.isFinite(t.left));
      out.shovelBlocked = !!(lossTask && lossTask.left <= 1);
      if (out.shovelBlocked) {
        out.shovelCandidates = [];
        out.shovelBlockedReason = `任务「${lossTask.tip}」还可损失 ${lossTask.left} 株，再损失一株就失败`;
      }
      const nowShovel = Date.now();
      out.recentShovels = recentShovels.filter((x) => nowShovel - x.at < 25000).slice(-6);
      if (currentPlan && currentPlan.levelKey === levelKeyOf(out)) out.plan = currentPlan;
      try { syncLevelHint(out); } catch { /* ignore */ }

      return out;
    }

    function safeSnapshot() {
      try { return snapshot(); } catch (e) { return { ok: false, reason: '读取状态失败：' + (e && e.message ? e.message : e) }; }
    }

    function isUnderNames(node, names) {
      let p = node;
      let depth = 0;
      while (p && depth++ < 12) {
        if (p.name && names.indexOf(p.name) >= 0) return true;
        const comps = p._components || [];
        for (const c of comps) {
          const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (k && names.indexOf(k) >= 0) return true;
        }
        p = p.parent;
      }
      return false;
    }

    function collectPickups() {
      const ctxg = findComps();
      if (!ctxg || !ctxg.scene) return { ok: false, count: 0, kinds: {} };
      const kinds = Object.create(null);
      let count = 0;
      const walk = (n) => {
        if (!n || n.active === false) return;
        const comps = n._components || [];
        for (const c of comps) {
          if (!c || c.collected !== false || c.mouseListen !== true) continue;
          if (typeof c.collect !== 'function') continue;
          if (isUnderNames(n, ['Prizes', 'CurrencyShower'])) continue;
          try { if (c.collectable && !c.collectable()) continue; } catch { /* ignore */ }
          try {
            const type = c.DroppingType || c.__classname__ || c.constructor && c.constructor.name || 'item';
            c.collect();
            kinds[type] = (kinds[type] || 0) + 1;
            count++;
          } catch { /* ignore one drop */ }
        }
        const children = n.children || [];
        for (const ch of children) walk(ch);
      };
      walk(ctxg.scene);
      return { ok: true, count, kinds };
    }

    function collectSuns() {
      return collectPickups();
    }

    function pickupLabel(kinds) {
      const names = {
        sun: '阳光', plantFood: '能量豆', plantfood: '能量豆', coin: '金币', gem: '钻石', sprout: '幼苗', ticket: '彩券',
      };
      return Object.keys(kinds || {})
        .map((k) => `${names[k] || k}×${kinds[k]}`)
        .join(' ');
    }

    function cellPlantList(cell) {
      if (!cell) return [];
      const list = [];
      const groups = [
        cell.plantInSquare,
        cell.vineInSquare,
        cell.tilePlantInSquare,
        cell.imitaterInSquare,
        cell.floawerpot ? [cell.floawerpot] : null,
        cell.lilypad ? [cell.lilypad] : null,
      ];
      for (const g of groups) {
        if (!Array.isArray(g)) continue;
        for (const p of g) {
          if (!p || list.includes(p)) continue;
          let alive = true;
          try { alive = p.isAlive ? p.isAlive() : true; } catch { alive = true; }
          if (alive) list.push(p);
        }
      }
      return list;
    }

    function lanePlantList(C, lane) {
      const list = [];
      const cols = C.ColumnCount || 9;
      for (let c = 0; c < cols; c++) {
        for (const p of cellPlantList(C.getLnC(lane, c))) {
          if (!list.includes(p)) list.push(p);
        }
      }
      return list;
    }

    // ── 位置辅助：把“能种哪一格”直接算给模型，减少乱种 ──
    function roleWindowOf(role, type) {
      const t = String(type || '').toLowerCase();
      if (role === 'shooter') return /bonk|chomper|wasabi/.test(t) ? [3, 7] : (ROLE_WINDOW.shooter || [0, 4]);
      return ROLE_WINDOW[role] || [0, 8];
    }

    function freeCellsIn(C, lanes, cols, lane, window) {
      const [from, to] = window || [0, cols - 1];
      const out = [];
      for (let c = Math.max(0, from); c <= Math.min(to, cols - 1); c++) {
        const cell = C.getLnC(lane, c);
        if (!cell) continue;
        if (cellPlantList(cell).length) continue;
        const t = cellTerrain(C, lane, c);
        if (t.exists && (t.letter === 'W' || t.letter === 'S')) continue;
        if (t.exists && t.letter === 'R' && !t.hasCart) continue;
        const learned = learnedCells.get(`${lane}:${c}`);
        if (learned && learned.until > Date.now()) continue;
        out.push(c);
      }
      return out;
    }

    // 紧急情况（僵尸已经压到 c<=3）时，不强求坚果去前排——这时候补一道墙也算防守。
    function laneHasCloseZombie(C, lane, threshold = 3) {
      try {
        const l = C.getLane(lane);
        const pool = l && l.zombiePool ? l.zombiePool() : [];
        for (const z of pool) {
          if (!z) continue;
          let alive = true;
          try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
          if (!alive) continue;
          const col = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
          if (col <= threshold) return true;
        }
      } catch { /* ignore */ }
      return false;
    }

    // 地刺放前排；坚果挡住的僵尸踩不到后面的地刺。
    function laneWallColumns(C, lane) {
      return lanePlantList(C, lane)
        .filter((p) => plantRole(cleanCodename(p.Plant_Type || '')) === 'wall')
        .map((p) => {
          const c = p.plantInLnC && p.plantInLnC.cIndex;
          return Number.isFinite(c) ? c : null;
        })
        .filter((c) => c !== null);
    }

    function nearbyFreeFor(C, lanes, cols, lane, role, type, limit = 3, opts = {}) {
      const win = roleWindowOf(role, type);
      const out = [];
      const order = opts.excludeLane ? [] : [lane];
      for (let d = 1; d < lanes; d++) {
        if (lane - d >= 0) order.push(lane - d);
        if (lane + d < lanes) order.push(lane + d);
      }
      for (const r of order) {
        if (r === lane && opts.excludeLane) continue;
        for (const c of freeCellsIn(C, lanes, cols, r, win)) {
          out.push({ lane: r, column: c });
          if (out.length >= limit) return out;
        }
      }
      return out;
    }

    // 只拦“明显浪费”的种法；有空位才拦，避免把最后一道防线也堵死。
    function positionIssue(role, type, lane, column, C, lanes, cols) {
      const t = String(type || '').toLowerCase();
      if (role === 'sun' && column >= 5) {
        return {
          reason: `阳光生产者应种在 c0-c2，c${column} 太靠前会被吃掉`,
          alts: nearbyFreeFor(C, lanes, cols, lane, 'sun', type, 3),
        };
      }
      if (role === 'wall' && column <= 1 && !laneHasCloseZombie(C, lane)) {
        const alts = freeCellsIn(C, lanes, cols, lane, [3, 7]).slice(0, 3).map((c) => ({ lane, column: c }));
        if (alts.length) return { reason: `坚果是前排，c${column} 在最后排挡不住僵尸`, alts };
      }
      if (role === 'spike') {
        const walls = laneWallColumns(C, lane);
        const wallAhead = walls.length ? Math.max(...walls) : -1;
        if (column < 4 || (wallAhead >= 0 && column <= wallAhead)) {
          const from = Math.max(4, wallAhead + 1);
          const alts = freeCellsIn(C, lanes, cols, lane, [from, 7]).slice(0, 3).map((c) => ({ lane, column: c }));
          if (alts.length) {
            return {
              reason: (wallAhead >= 0 && column <= wallAhead)
                ? `地刺在坚果（c${wallAhead}）后面，坚果挡住的僵尸踩不到它`
                : `地刺应放在僵尸必经的前排（c4-c7），c${column} 太靠后`,
              alts,
            };
          }
        }
      }
      if (role === 'shooter' && !/bonk|chomper|wasabi/.test(t) && column >= 7) {
        const alts = freeCellsIn(C, lanes, cols, lane, [0, 4]).slice(0, 3).map((c) => ({ lane, column: c }));
        if (alts.length) return { reason: `普通射手放 c${column} 会被马上吃掉，建议 c0-c4`, alts };
      }
      return null;
    }

    function altText(alts) {
      if (!Array.isArray(alts) || !alts.length) return '';
      return `（可改种 ${alts.map((a) => `第${a.lane + 1}排c${a.column}`).join('、')}）`;
    }

    function plantCountLimitOf(scene) {
      let limit = 0;
      for (const t of readTasks(scene)) {
        if (t.limits && t.limits.plantCountLimit > 0) limit = Math.max(limit, t.limits.plantCountLimit);
      }
      return limit;
    }

    function plantConveyor(cv, cardIndex, lane, column) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map } = ctxg;
      const ui = map.UIInGame, square = map.Square;
      if (!ui || !square) return fail('NO_SCENE');
      const list = conveyorCards(cv);
      const cf = list[cardIndex];
      if (!cf) {
        return fail('NO_CARD', { conveyor: true, card: cardIndex, available: list.length },
          `传送带当前只有 ${list.length} 张卡`);
      }
      const slot = conveyorSlots(cv).find((s) => s.card === cf);
      if (!slot) return fail('CARD_UNAVAILABLE', { conveyor: true, card: cardIndex, type: cf.Type }, '这张卡已经离开传送带');

      const C = square.constructor;
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      if (lane < 0 || lane >= lanes || column < 0 || column >= cols) {
        return fail('OUT_OF_RANGE', { lane, column, range: { lanes, columns: cols } });
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const terrain = cellTerrain(C, lane, column);
      if (terrain.exists && (terrain.letter === 'W' || terrain.letter === 'S')) {
        return fail('TERRAIN', { lane, column, terrain: terrain.letter, terrainName: terrain.terrain });
      }
      const role = plantRole(cf.Type);
      const pos = positionIssue(role, cf.Type, lane, column, C, lanes, cols);
      if (pos) return fail('POSITION', { lane, column, type: cf.Type, role, alts: pos.alts }, pos.reason + altText(pos.alts));
      const lanePlants = lanePlantList(C, lane);
      const sameRole = lanePlants.filter((p) => plantRole(cleanCodename(p.Plant_Type || '')) === role);
      if (role === 'wall') {
        const strong = sameRole.find((p) => (p.health || 0) > Math.max(1, p.toughness || 1) * 0.25);
        if (strong) return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 1 });
      } else if (role === 'spring' && sameRole.length) {
        return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 1 });
      } else if (role === 'freeze' && sameRole.length) {
        return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 1 });
      } else if (role === 'sun' && sameRole.length >= 2) {
        return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 2 });
      } else if (role === 'shooter' && sameRole.length >= 4) {
        return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 4 });
      } else if (role === 'spike' && sameRole.length >= 2) {
        return fail('LANE_LIMIT', { lane, role, count: sameRole.length, limit: 2 });
      }
      const tags = (cf.PF && cf.PF.TAGS) || [];
      const canOverlap = tags.includes('allowOverlap') || tags.includes('vine') || tags.includes('floawerPot') || tags.includes('lilypad');
      const cellPlants = cellPlantList(cell);
      if (cellPlants.length && !canOverlap) {
        return fail('OCCUPIED', {
          lane, column, plants: cellPlants.map((p) => cleanCodename(p.Plant_Type || '')),
          suggest: 'replace', suggestAction: { type: 'replace', card: cardIndex, lane, column },
          alts: nearbyFreeFor(C, lanes, cols, lane, role, cf.Type, 3),
        }, `格子 ${lane},${column} 已有植物；要换更强的卡用 replace`);
      }
      const learnKey = `${lane}:${column}`;
      const learned = learnedCells.get(learnKey);
      if (learned && learned.until > Date.now()) {
        return fail(learned.code || 'CELL_BLOCKED', { lane, column, terrain: learned.terrain || '?', learned: true });
      }

      try { cv.chooseCard(cf, slot); } catch (e) {
        return fail('CARD_UNAVAILABLE', { conveyor: true, card: cardIndex, type: cf.Type }, '传送带选卡失败：' + (e && e.message ? e.message : e));
      }
      if (ui.currentFreeCF !== cf) {
        return fail('CARD_UNAVAILABLE', { conveyor: true, card: cardIndex, type: cf.Type }, '传送带卡没有选中');
      }
      const canPlace = cell.putPlantAvailable
        ? cell.putPlantAvailable(true, cf.ID, true, true, cf.spf)
        : true;
      if (!canPlace) {
        try { cv.chooseCard(cf, slot); } catch { /* ignore */ }
        learnedCells.set(learnKey, { until: Date.now() + 15000, code: 'CELL_BLOCKED', terrain: terrain.letter || '?' });
        return fail('CELL_BLOCKED', { lane, column, terrain: terrain.letter || '?' });
      }
      const beforeSpawn = cell.spawningPromiseCount || 0;
      cell.PlaceUIPlant();
      if ((cell.spawningPromiseCount || 0) <= beforeSpawn) {
        return fail('PLANT_FAILED', { conveyor: true, card: cardIndex, type: cf.Type, lane, column });
      }
      return {
        ok: true,
        conveyor: true,
        detail: `传送带种下 ${PLANT_CN[cf.Type] || cf.Type} @ ${lane},${column}`,
        lane, column, type: cf.Type, card: cardIndex,
      };
    }

    function plant(cardIndex, lane, column) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map, scene } = ctxg;
      const ui = map.UIInGame, cards = map.Cards, square = map.Square;
      if (!ui || !cards || !square) return fail('NO_SCENE', {}, '当前场景没有种植物界面');
      if (lastMechanics && Date.now() - (lastMechanics.at || 0) < 4000 && lastMechanics.supported === false) {
        return fail('UNSUPPORTED_LEVEL', {
          unsupportedReason: lastMechanics.unsupportedReason,
          features: lastMechanics.features,
        });
      }
      if (ui.paused) return fail('PAUSED', { retryable: true });
      if (ui.indexLocked) return fail('UI_LOCKED', { retryable: true });

      const cvHere = getConveyor(ctxg);
      if (isConveyorMode(cvHere, cards)) return plantConveyor(cvHere, cardIndex, lane, column);

      const cf = cards.CFs && cards.CFs[cardIndex];
      if (!cf) return fail('NO_CARD', { card: cardIndex });
      if (Array.isArray(cards.cardsUIUpper) && cards.CFs.length > cards.cardsUIUpper.length) {
        return fail('UI_NOT_READY', { retryable: true });
      }
      const upper = cards.cardsUIUpper && cards.cardsUIUpper[cardIndex];
      const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
      if (upper && cd > 0) {
        return fail('COOLDOWN', { card: cardIndex, type: cf.Type, retryAfter: Math.round(cd * 10) / 10, retryable: true },
          `${cf.Type} 冷却中 ${cd.toFixed(1)}s`);
      }
      const sunCounter = map.SunCount;
      const sunNow = sunCounter ? sunCounter.CurrentValue : null;
      const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
      if (cf.ca && !cf.ca.affordable && Number.isFinite(sunNow) && sunNow >= cost) {
        // 卡片 UI 的状态可能慢一帧；阳光足够时同步一次，避免刚开局被误判为“阳光不足”。
        cf.ca.affordable = true;
      }
      if (cf.ca && !cf.ca.affordable && !cf.ca.free) {
        return fail('SUN', {
          card: cardIndex, type: cf.Type, need: cost, have: sunNow,
          short: Number.isFinite(sunNow) ? Math.max(0, cost - sunNow) : null, retryable: true,
        }, `${cf.Type} 阳光不足`);
      }

      const C = square.constructor;
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      if (lane < 0 || lane >= lanes || column < 0 || column >= cols) {
        return fail('OUT_OF_RANGE', { lane, column, range: { lanes, columns: cols } }, `格子 ${lane},${column} 超出范围`);
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column }, '格子不存在');

      // 地形：W=水/S=天空 不能种普通植物；P=木板可以。
      const terrain = cellTerrain(C, lane, column);
      if (terrain.exists && (terrain.letter === 'W' || terrain.letter === 'S')) {
        return fail('TERRAIN', {
          lane, column, terrain: terrain.letter, terrainName: terrain.terrain, retryable: false,
          alts: nearbyFreeFor(C, lanes, cols, lane, plantRole(cf.Type), cf.Type, 3),
        }, `格子 ${lane},${column} 是${terrain.terrain === 'sea' ? '海面' : terrain.terrain}，不能种普通植物`);
      }

      const role = plantRole(cf.Type);
      const pos = positionIssue(role, cf.Type, lane, column, C, lanes, cols);
      if (pos) {
        return fail('POSITION', { lane, column, type: cf.Type, role, alts: pos.alts },
          pos.reason + altText(pos.alts));
      }
      const lanePlants = lanePlantList(C, lane);
      const sameRole = lanePlants.filter((p) => plantRole(cleanCodename(p.Plant_Type || '')) === role);
      const posText = sameRole.map((p) => (p.plantInLnC && p.plantInLnC.cIndex != null ? 'c' + p.plantInLnC.cIndex : '?')).join(',');
      const laneLimit = (limit, name) => fail('LANE_LIMIT', {
        lane, role, count: sameRole.length, limit, plants: sameRole.map((p) => cleanCodename(p.Plant_Type || '')),
        suggest: 'shovel_or_replace',
        alts: nearbyFreeFor(C, lanes, cols, lane, role, cf.Type, 3, { excludeLane: true }),
      }, `该行已有${name}（${posText}），先补其他行；要腾位/换强卡用 shovel 或 replace`);
      if (role === 'wall') {
        const strong = sameRole.find((p) => (p.health || 0) > Math.max(1, p.toughness || 1) * 0.25);
        if (strong) return laneLimit(1, '坚果墙');
      } else if (role === 'spring' && sameRole.length) {
        return laneLimit(1, '弹簧豆');
      } else if (role === 'freeze' && sameRole.length) {
        return laneLimit(1, '冰冻生菜');
      } else if (role === 'sun' && sameRole.length >= 2) {
        return laneLimit(2, '2 个阳光生产者');
      } else if (role === 'shooter' && sameRole.length >= 4) {
        return laneLimit(4, '4 个射手');
      } else if (role === 'spike' && sameRole.length >= 2) {
        return laneLimit(2, '2 个地刺');
      }

      const tags = (cf.PF && cf.PF.TAGS) || [];
      const canOverlap = tags.includes('allowOverlap') || tags.includes('vine') || tags.includes('floawerPot') || tags.includes('lilypad');
      const cellPlants = cellPlantList(cell);
      if (cellPlants.length && !canOverlap) {
        const alts = nearbyFreeFor(C, lanes, cols, lane, role, cf.Type, 3);
        return fail('OCCUPIED', {
          lane, column, plants: cellPlants.map((p) => cleanCodename(p.Plant_Type || '')),
          suggest: 'replace', suggestAction: { type: 'replace', card: cardIndex, lane, column }, alts,
        }, `格子 ${lane},${column} 已有植物；要换更强的卡用 replace（先铲后种）${altText(alts)}`);
      }

      // 关卡植物总数上限
      const plantLimit = plantCountLimitOf(scene);
      if (plantLimit > 0) {
        let total = 0;
        for (let r = 0; r < lanes; r++) {
          for (let c = 0; c < cols; c++) total += cellPlantList(C.getLnC(r, c)).length ? 1 : 0;
        }
        if (total >= plantLimit) {
          return fail('LEVEL_LIMIT', {
            limit: 'plantCountLimit', value: plantLimit, count: total, suggest: 'shovel_then_plant',
          }, `关卡限制最多 ${plantLimit} 株植物；先铲掉不用的再种`);
        }
      }

      const learnKey = `${lane}:${column}`;
      const learned = learnedCells.get(learnKey);
      if (learned && learned.until > Date.now()) {
        return fail(learned.code || 'CELL_BLOCKED', {
          lane, column, terrain: learned.terrain || '?', learned: true, retryable: false,
          alts: nearbyFreeFor(C, lanes, cols, lane, role, cf.Type, 3),
        }, `格子 ${lane},${column} 之前判定为不可种植（缓存中）`);
      }

      if (ui.index === cardIndex && ui.currentCF !== cf) ui.tryChangingIndex(-1);
      if (ui.index !== cardIndex) ui.tryChangingIndex(cardIndex);
      if (ui.currentCF !== cf) {
        if (ui.index === cardIndex) ui.tryChangingIndex(-1);
        return fail('CARD_UNAVAILABLE', { card: cardIndex, type: cf.Type, retryable: true });
      }

      const canPlace = cell.putPlantAvailable
        ? cell.putPlantAvailable(true, cf.ID, true, true, cf.spf)
        : true;
      if (!canPlace) {
        if (ui.index === cardIndex) ui.tryChangingIndex(-1);
        learnedCells.set(learnKey, { until: Date.now() + 15000, code: 'CELL_BLOCKED', terrain: terrain.letter || '?' });
        const alts = nearbyFreeFor(C, lanes, cols, lane, role, cf.Type, 3);
        return fail('CELL_BLOCKED', {
          lane, column, terrain: terrain.letter || '?', alts,
        }, `格子 ${lane},${column} 当前不可种植（关卡限制/地形/植物上限）${altText(alts)}`);
      }

      const beforeSpawn = cell.spawningPromiseCount || 0;
      cell.PlaceUIPlant();
      if ((cell.spawningPromiseCount || 0) <= beforeSpawn) {
        if (ui.index === cardIndex) ui.tryChangingIndex(-1);
        return fail('PLANT_FAILED', { card: cardIndex, type: cf.Type, lane, column });
      }
      return {
        ok: true,
        detail: `种下 ${PLANT_CN[cf.Type] || cf.Type} @ ${lane},${column}`,
        lane, column, type: cf.Type,
      };
    }

    function shovel(lane, column, expectType) {
      const ctxg = findComps();
      if (!ctxg || !ctxg.map.Square) return fail('NO_SCENE');
      const ui = ctxg.map.UIInGame;
      if (ui && ui.paused) return fail('PAUSED', { retryable: true });
      if (ui && ui.indexLocked) return fail('UI_LOCKED', { retryable: true });
      const C = ctxg.map.Square.constructor;
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      if (lane < 0 || lane >= lanes || column < 0 || column >= cols) {
        return fail('OUT_OF_RANGE', { lane, column, range: { lanes, columns: cols } });
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const plants = cellPlantList(cell);
      if (!plants.length) return fail('EMPTY', { lane, column }, `格子 ${lane},${column} 没有植物`);
      // 损失上限只剩 1 株时主动铲可能直接判负；先拦住。
      try {
        const loss = readTasks(ctxg.scene).find((t) => t.semantics === 'loss_limit' && !t.completed && Number.isFinite(t.left));
        if (loss && loss.left <= 1) {
          return fail('SHOVEL_BLOCKED', { lane, column, task: loss.tip, left: loss.left },
            '任务限制：再损失一株就失败，禁止主动铲除');
        }
      } catch { /* ignore */ }
      const types = plants.map((p) => cleanCodename(p.Plant_Type || ''));
      if (expectType && types.indexOf(String(expectType)) < 0) {
        return fail('PLANT_MISMATCH', { lane, column, expect: String(expectType), plants: types },
          `格子里不是 ${expectType}（实际 ${types.join(',') || '未知'}）`);
      }
      const names = types.filter(Boolean).join(',') || '植物';
      shoveledAt.set(`${lane}:${column}`, Date.now());
      try {
        cell.removePlant();
      } catch (e) {
        // 某些版本 removePlant 可能对 tile 植物异常，下面走逐株兜底。
      }
      let remaining = cellPlantList(cell);
      if (remaining.length) {
        for (const p of remaining) {
          try { if (p.die) p.die(false); } catch { /* ignore */ }
          try { if (p.node && p.node.destroy) p.node.destroy(); } catch { /* ignore */ }
        }
        remaining = cellPlantList(cell);
      }
      if (remaining.length) {
        return fail('SHOVEL_FAILED', { lane, column, remaining: remaining.map((p) => cleanCodename(p.Plant_Type || '')) });
      }
      const cellKey = `${lane}:${column}`;
      learnedCells.delete(cellKey);
      lastPlants.delete(cellKey);
      recentShovels.push({ lane, column, types, at: Date.now() });
      if (recentShovels.length > 20) recentShovels.splice(0, recentShovels.length - 20);
      return {
        ok: true,
        detail: `铲除 ${names} @ ${lane},${column}`,
        lane, column, removed: types,
      };
    }

    // 先铲后种：同格把弱卡换成强卡。先做卡/地形预检，避免铲完种不上。
    function replacePlant(cardIndex, lane, column) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const ui = ctxg.map.UIInGame;
      if (ui && ui.paused) return fail('PAUSED', { retryable: true });
      const C = ctxg.map.Square && ctxg.map.Square.constructor;
      if (!C) return fail('NO_SCENE');
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      if (lane < 0 || lane >= lanes || column < 0 || column >= cols) {
        return fail('OUT_OF_RANGE', { lane, column, range: { lanes, columns: cols } });
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const plants = cellPlantList(cell);
      if (!plants.length) return plant(cardIndex, lane, column);
      const terrain = cellTerrain(C, lane, column);
      if (terrain.exists && (terrain.letter === 'W' || terrain.letter === 'S')) {
        return fail('TERRAIN', { lane, column, terrain: terrain.letter, terrainName: terrain.terrain }, '该格地形不能种普通植物');
      }
      const s = safeSnapshot();
      if (!s.ok) return fail('NO_SCENE', {}, s.reason);
      const list = (s.conveyor && s.conveyor.enabled) ? s.conveyor.cards : s.cards;
      const card = (list || []).find((c) => Number(c.index) === Number(cardIndex));
      if (!card) {
        return fail('NO_CARD', { card: cardIndex, conveyor: !!(s.conveyor && s.conveyor.enabled) },
          `没有下标 ${cardIndex} 的卡`);
      }
      if (!card.ready) {
        return fail(card.cd > 0 ? 'COOLDOWN' : 'SUN', {
          card: cardIndex, type: card.type, retryAfter: card.cd > 0 ? card.cd : undefined, retryable: true,
        }, card.cd > 0 ? `${card.type} 冷却中` : `${card.type} 阳光不足`);
      }
      const removed = shovel(lane, column);
      if (!removed.ok) return removed;
      const planted = plant(cardIndex, lane, column);
      if (!planted.ok) {
        return {
          ...planted,
          step: 'plant',
          shoveled: removed.removed,
          detail: `铲掉了 ${removed.removed.join(',')}，但没种上 ${card.type}`,
        };
      }
      return {
        ok: true,
        detail: `替换 ${removed.removed.join(',') || '植物'} → ${PLANT_CN[card.type] || card.type} @ ${lane},${column}`,
        lane, column, removed: removed.removed, type: card.type, card: cardIndex,
      };
    }

    // 自动换卡兜底：模型有时会忽略候选；这里只做“明显该换”的一格，且留出阳光余量。
    function pickAutoShovel(s) {
      if (!s || !s.shovelCandidates || !s.shovelCandidates.length || s.shovelBlocked) return null;
      if (s.paused) return null;
      if (s.mechanics && s.mechanics.supported === false) return null;
      const sun = Number(s.sun) || 0;
      for (const c of s.shovelCandidates) {
        const role = plantRole(c.type);
        const misplacedOk = c.reason === 'misplaced' && (role === 'wall' || role === 'spike');
        if (c.reason !== 'upgrade' && c.reason !== 'over_limit' && !misplacedOk) continue;
        if ((s.zombies || []).some((z) => z.lane === c.lane && Math.abs(z.column - c.column) < 2)) continue;
        if (c.reason === 'upgrade') {
          if (c.betterCard == null) continue;
          if (c.needSun && sun < Number(c.needSun) + 75) continue;
          return {
            type: 'replace', card: c.betterCard, lane: c.lane, column: c.column,
            why: `${c.name}→${PLANT_CN[c.better] || c.better}`,
          };
        }
        return { type: 'shovel', lane: c.lane, column: c.column, why: `清多余 ${c.name}` };
      }
      return null;
    }

    function plantFood(lane, column) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map } = ctxg;
      const ui = map.UIInGame;
      if (ui && ui.paused) return fail('PAUSED', { retryable: true });
      const C = map.Square && map.Square.constructor;
      if (!C) return fail('NO_SCENE');
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      if (lane < 0 || lane >= lanes || column < 0 || column >= cols) {
        return fail('OUT_OF_RANGE', { lane, column, range: { lanes, columns: cols } });
      }
      const counter = map.PlantFoodCount;
      const have = counter ? counter.plantFoodNum : null;
      if (counter && !(counter.plantFoodNum > 0)) {
        return fail('NO_FOOD', { have: have || 0, retryable: true }, '没有植物能量');
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const p = ((cell.plantInSquare) || []).find((x) => x && x.foodable && !x.fooding);
      if (!p) return fail('NOT_FOODABLE', { lane, column, plants: cellPlantList(cell).map((x) => cleanCodename(x.Plant_Type || '')) });
      p.food();
      if (counter && counter.plantFoodDec) counter.plantFoodDec();
      return { ok: true, detail: `植物能量 → ${lane},${column}`, lane, column, type: cleanCodename(p.Plant_Type || '') };
    }

    function moveCart(cartId, direction) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map } = ctxg;
      const ui = map.UIInGame;
      if (ui && ui.paused) return fail('PAUSED', { retryable: true });
      const C = map.Square && map.Square.constructor;
      if (!C) return fail('NO_SCENE');
      const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
      const id = Number(cartId);
      const ref = collectCartRefs(C, lanes, cols)[id];
      if (!ref) return fail('NO_CART', { cart: id });
      const inL = ref.cart._inLnC;
      const dir = String(direction || '').toLowerCase();
      if (dir !== 'up' && dir !== 'down') {
        return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'direction' }, 'direction 只能是 up 或 down');
      }
      const target = dir === 'up' ? (inL && inL.upper) : (inL && inL.lower);
      if (!target) {
        return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'no_rail' }, '该方向没有轨道');
      }
      let can = false;
      try { can = !!ref.cart.canMoveToLnC(target); } catch { can = false; }
      if (!can) {
        return fail('CART_BLOCKED', {
          cart: id, direction: dir, reason: 'blocked',
          from: { lane: ref.lane, column: ref.column },
          to: { lane: target.lIndex, column: target.cIndex },
        });
      }
      const plants = cellPlantList(inL).map((p) => cleanCodename(p.Plant_Type || ''));
      try {
        if (dir === 'up') ref.cart.moveUp(); else ref.cart.moveDown();
      } catch (e) {
        return fail('CART_BLOCKED', { cart: id, direction: dir }, '矿车移动失败：' + (e && e.message ? e.message : e));
      }
      cartMoveUntil = Date.now() + 3000;
      return {
        ok: true,
        detail: `矿车 #${id} ${dir === 'up' ? '上移' : '下移'} → ${target.lIndex + 1} 排`,
        cart: id,
        direction: dir,
        from: { lane: ref.lane, column: ref.column },
        to: { lane: target.lIndex, column: target.cIndex },
        plants,
      };
    }

    function resume() {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const ui = ctxg.map.UIInGame;
      if (!ui || !ui.paused) return { ok: true, detail: '游戏未暂停', paused: false };
      const ps = findCompByClass(ctxg.scene, 'PauseScreen');
      if (ps && typeof ps.resume === 'function') {
        try { ps.resume(); return { ok: true, detail: '继续游戏', paused: false }; } catch { /* fall through */ }
      }
      try { ui.paused = false; } catch { /* ignore */ }
      return { ok: true, detail: '已取消暂停', paused: false };
    }

    function safeStartable(cards) {
      try { return !!(cards && cards.GameStartable && cards.GameStartable()); } catch { return false; }
    }

    function prepReady(cards, lvl) {
      return !!(cards && lvl && cards.shown && cards.seedChooser && cards.maxSlotCount > 0
        && lvl.viewButton && lvl.viewButton.node
        && cards.gameStartButton && cards.gameStartButton.node
        && !lvl.rocked && !lvl.gameStarted);
    }

    function tryLetsRock(lvl, cards) {
      if (!lvl || typeof lvl.letsRock !== 'function') return fail('NO_SCENE', {}, '当前场景无法开局');
      if (lvl.letsRocked) return fail('ALREADY_STARTED', {}, '已经开局');
      if (!prepReady(cards, lvl)) return fail('PREP_NOT_READY', { retryable: true }, '选卡界面还没准备好，稍等');
      if (!safeStartable(cards)) return fail('DECK_INCOMPLETE', { retryable: false }, '卡组还没选满');
      try {
        lvl.letsRock();
        return { ok: true, detail: '开始战斗', started: true };
      } catch (e) {
        return fail('START_FAILED', {}, '开局失败：' + (e && e.message ? e.message : e));
      }
    }

    function autoDeck() {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      if (!cards || !lvl) return fail('PREP_NOT_READY');
      if (cards.gameStarted) return fail('ALREADY_STARTED');
      const cv = getConveyor(ctxg);
      if (cv && isConveyorMode(cv, cards)) {
        return { ok: true, conveyor: true, deck: [], applied: [], skipped: [], started: false, detail: '传送带关卡无需选卡' };
      }
      if (!prepReady(cards, lvl)) return fail('PREP_NOT_READY', { retryable: true }, '选卡界面还没准备好，稍等');
      if (safeStartable(cards)) return tryLetsRock(lvl, cards);

      const max = cards.maxSlotCount || 0;
      if (!max) return fail('NO_SLOTS', { retryable: true }, '当前关卡没有可用卡槽（植物未解锁/关卡限制）');
      if (!cards.seedChooser) return fail('PREP_NOT_READY', { retryable: true });
      if (cards.CFs.length >= max) return { ok: true, deck: cards.CFs.map((c) => c.Type), applied: [], skipped: [], started: false, detail: '卡组已满' };

      const avail = (cards.seedChooser.CFs || []).filter(
        (cf) => cf && cf.Type && !(cf.ca && cf.ca.locked) && !(cf.ca && cf.ca.disallowed)
      );
      const pick = [];
      const push = (type) => {
        if (pick.length >= max || pick.includes(type)) return;
        if (avail.some((c) => c.Type === type)) pick.push(type);
      };
      [
        'sunflower', 'primalsunflower', 'twinsunflower', 'sunshroom',
        'peashooter', 'repeater', 'snowpea', 'threepeater', 'cabbagepult', 'kernelpult',
        'wallnut', 'tallnut', 'endurian', 'potatomine', 'cherry_bomb', 'jalapeno',
        'chomper', 'bonkchoy', 'bloomerang', 'lightningreed', 'spikeweed',
      ].forEach(push);
      for (const cf of avail) { if (pick.length >= max) break; push(cf.Type); }

      let added = 0;
      for (const type of pick) {
        try {
          const before = cards.CFs.length;
          cards.addCardByPlantTypeFromSeedbank(type);
          if (cards.CFs.length > before) added++;
        } catch { /* ignore one card */ }
      }
      const out = {
        ok: true,
        deck: cards.CFs.map((c) => c.Type),
        applied: pick.slice(0, added),
        skipped: [],
        started: false,
        detail: `选卡 ${added} 张`,
      };
      if (safeStartable(cards)) {
        const r = tryLetsRock(lvl, cards);
        if (r.ok) { out.started = true; out.detail = `选卡 ${added} 张，已开局`; }
        else out.startReason = r.reason;
      }
      return out;
    }

    // plants: 指定卡组；replace: 先清空当前卡组。返回实际生效的 deck / applied / skipped。
    function autoDeckWith(plants, replace) {
      const ctxg = findComps();
      if (!ctxg) return fail('NO_SCENE');
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      if (!cards || !lvl) return fail('PREP_NOT_READY');
      if (cards.gameStarted) return fail('ALREADY_STARTED');
      const cv = getConveyor(ctxg);
      if (cv && isConveyorMode(cv, cards)) {
        return { ok: true, conveyor: true, deck: [], applied: [], skipped: [], started: false, detail: '传送带关卡无需选卡' };
      }
      if (!prepReady(cards, lvl)) return fail('PREP_NOT_READY', { retryable: true }, '选卡界面还没准备好，稍等');
      const max = cards.maxSlotCount || 0;
      if (!max) return fail('NO_SLOTS', { retryable: true });
      if (!cards.seedChooser) return fail('PREP_NOT_READY', { retryable: true });

      const wanted = Array.isArray(plants) ? plants.map(String).filter(Boolean) : [];
      if (!wanted.length && !replace) return autoDeck();

      const cleared = cards.CFs.length;
      if (replace && typeof cards.spliceAllCards === 'function') {
        try { cards.spliceAllCards(); } catch (e) { /* fall through to add */ }
      }
      if (replace && cards.CFs.length) {
        return fail('DECK_CLEAR_FAILED', { remaining: cards.CFs.map((c) => c.Type) }, '清空卡组失败');
      }
      const avail = new Map((cards.seedChooser.CFs || []).map((cf) => [cf.Type, cf]));
      const applied = [];
      const skipped = [];
      for (const type of wanted) {
        const cf = avail.get(type);
        if (!cf) { skipped.push({ type, reason: 'not_available' }); continue; }
        if (cf.ca && (cf.ca.locked || cf.ca.disallowed)) {
          skipped.push({ type, reason: cf.ca.locked ? 'locked' : 'not_available' });
          continue;
        }
        const before = cards.CFs.length;
        if (before >= max) { skipped.push({ type, reason: 'no_slot' }); continue; }
        try { cards.addCardByPlantTypeFromSeedbank(type); } catch (e) {
          skipped.push({ type, reason: 'error', message: String((e && e.message) || e) });
          continue;
        }
        if (cards.CFs.length > before) applied.push(type);
        else skipped.push({ type, reason: 'rejected' });
      }
      // 计划卡组不足卡槽数时补满，否则 GameStartable() 为 false，开不了局。
      if (cards.CFs.length < max) {
        const fill = [
          'sunflower', 'primalsunflower', 'twinsunflower', 'sunshroom',
          'peashooter', 'repeater', 'snowpea', 'threepeater', 'cabbagepult', 'kernelpult',
          'wallnut', 'tallnut', 'endurian', 'potatomine', 'cherry_bomb', 'jalapeno',
          'bonkchoy', 'bloomerang', 'lightningreed', 'spikeweed',
        ];
        const already = () => new Set(cards.CFs.map((c) => c.Type));
        for (const type of fill) {
          if (cards.CFs.length >= max) break;
          if (already().has(type)) continue;
          const cf = avail.get(type);
          if (!cf || (cf.ca && (cf.ca.locked || cf.ca.disallowed))) continue;
          const before = cards.CFs.length;
          try { cards.addCardByPlantTypeFromSeedbank(type); } catch { continue; }
          if (cards.CFs.length > before) applied.push(type);
        }
        for (const [type, cf] of avail) {
          if (cards.CFs.length >= max) break;
          if (already().has(type)) continue;
          if (cf.ca && (cf.ca.locked || cf.ca.disallowed)) continue;
          const before = cards.CFs.length;
          try { cards.addCardByPlantTypeFromSeedbank(type); } catch { continue; }
          if (cards.CFs.length > before) applied.push(type);
        }
      }
      const out = {
        ok: true,
        deck: cards.CFs.map((c) => c.Type),
        applied,
        skipped,
        cleared: replace ? cleared : 0,
        replace: !!replace,
        started: false,
        detail: `${replace ? `清空 ${cleared} 张并` : ''}选卡 ${applied.length} 张`,
      };
      if (safeStartable(cards)) {
        const r = tryLetsRock(lvl, cards);
        if (r.ok) { out.started = true; out.detail += '，已开局'; }
        else out.startReason = r.reason;
      }
      return out;
    }

    function startLevel() {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      const cv = getConveyor(ctxg);
      if (cv && isConveyorMode(cv, cards) && lvl && !lvl.letsRocked && typeof lvl.letsRock === 'function') {
        let warn = null;
        try {
          lvl.letsRock();
        } catch (e) {
          warn = String(e && e.message ? e.message : e);
        }
        // 传送带关的 letsRock 会在隐去种子栏 UI 时抛错，但战斗已经启动；
        // 这里不把异常当失败，交给 wait_until phase:running 确认。
        return {
          ok: true,
          detail: '开始战斗（传送带）',
          started: !!(lvl.letsRocked || lvl.gameStarted || (cards && cards.gameStarted)),
          warning: warn || undefined,
        };
      }
      return tryLetsRock(lvl, cards);
    }

    function dismissObjective() {
      const ctxg = findComps();
      if (!ctxg || !ctxg.scene) return fail('NO_SCENE');
      const info = readObjective(ctxg.scene);
      if (!info) return fail('NO_OBJECTIVE', {}, '当前没有关卡目标界面');
      const obj = findCompByClass(ctxg.scene, 'LevelObjectiveScreen');
      let called = false;
      if (obj && typeof obj.continue === 'function') {
        try { obj.continue(); called = true; } catch { called = false; }
      }
      if (!called && obj && obj.node) {
        const btnNode = findNodeByName(obj.node, 'ContinueButton');
        if (btnNode) {
          try { btnNode.emit('click'); called = true; } catch { /* ignore */ }
        }
      }
      if (!called) return fail('CONTINUE_NOT_FOUND', {}, '找不到“继续”按钮');
      if (run && info.missions && info.missions.length) run.objectiveMissions = info.missions;
      return {
        ok: true,
        detail: `关闭关卡目标说明（${info.screenName || '本关任务'}）`,
        tasks: info.missions,
        hints: info.hints,
      };
    }

    function taskSummary(s) {
      const list = (s && s.tasks) || [];
      if (!list.length) return '';
      return list.map((t) => {
        const name = t.tip || '任务';
        const state = t.completed ? '已完成' : (t.failed ? '失败' : (t.count || ''));
        const timer = t.timeSemantics === 'sliding_window' && t.timeLeft !== null && !t.completed
          ? `，窗口剩 ${t.timeLeft.toFixed(1)}s`
          : '';
        return `${name}${state || timer ? '（' + state + timer + '）' : ''}`;
      }).join('；');
    }

    // ───────────────────────── 决策 ─────────────────────────

    function decisionKey(s) {
      const ready = s.cards.filter((c) => c.ready).map((c) => c.type).join(',');
      const zombies = s.zombies
        .map((z) => `${z.lane}:${Math.floor(z.column)}:${z.type}:${Math.ceil(z.hp / 80)}`)
        .sort().join('|');
      const plants = s.plants
        .map((p) => `${p.lane}:${p.column}:${p.type}:${Math.ceil((p.hp || 0) / 150)}`)
        .sort().join('|');
      const tasks = (s.tasks || []).map((t) => `${t.tip}:${t.count}:${t.completed ? 1 : 0}:${t.urgent ? 'U' : ''}`).join('|');
      return [s.phase, s.level.wave, ready, zombies, plants, tasks].join('#');
    }

    function localBrain(s) {
      const ready = s.cards.filter((c) => c.ready);
      const occupied = new Set(s.plants.map((p) => `${p.lane}:${p.column}`));
      const ctxg = findComps();
      const C = ctxg && ctxg.map.Square && ctxg.map.Square.constructor;
      const now = Date.now();
      const free = (lane, col) => {
        const k = `${lane}:${col}`;
        if (occupied.has(k)) return false;
        const learned = learnedCells.get(k);
        if (learned && learned.until > now) return false;
        if (C) {
          const t = cellTerrain(C, lane, col);
          if (t.exists && (t.letter === 'W' || t.letter === 'S')) return false;
        }
        return true;
      };
      const urgentTask = (s.tasks || []).find((t) => t.urgent && !t.completed && !t.failed);
      if (urgentTask) {
        // 限时击杀：能量豆优先给僵尸最多的行里可喂的植物。
        const counts = [0, 0, 0, 0, 0];
        s.zombies.forEach((z) => { counts[z.lane] = (counts[z.lane] || 0) + 1; });
        const lane = counts.indexOf(Math.max(...counts));
        const foodable = s.plants.find((p) => p.lane === lane && p.foodable);
        if ((s.plantFood || 0) > 0 && foodable) {
          return { thought: `任务倒计时 ${urgentTask.timeLeft ?? '?'}s，能量豆抢救`, actions: [{ type: 'plant_food', lane: foodable.lane, column: foodable.column }] };
        }
      }
      for (const t of s.tasks || []) {
        const limit = t.limits && t.limits.plantCountLimit;
        if (limit > 0 && s.plants.length >= limit) {
          return { thought: '任务限制植物数量，停止种植', actions: [{ type: 'wait' }] };
        }
      }

      // 铲除/替换：先处理“超上限/可升级”的格子，铲完立刻补上更强的卡。
      const cands = (s.shovelCandidates || []).filter((c) => {
        if (s.zombies.some((z) => z.lane === c.lane && Math.abs(z.column - c.column) < 2)) return false;
        if (recentShovels.some((x) => x.lane === c.lane && x.column === c.column && Date.now() - x.at < 8000)) return false;
        return true;
      });
      const upg = cands.find((c) => c.reason === 'upgrade' && c.betterCard != null && (!c.needSun || (s.sun || 0) >= c.needSun));
      if (upg) {
        return {
          thought: `${upg.name} 换成 ${PLANT_CN[upg.better] || upg.better}`,
          actions: [{ type: 'replace', card: upg.betterCard, lane: upg.lane, column: upg.column }],
        };
      }
      const over = cands.find((c) => c.reason === 'over_limit')
        || cands.find((c) => c.reason === 'misplaced' && (plantRole(c.type) === 'wall' || plantRole(c.type) === 'spike'));
      if (over) {
        return {
          thought: `铲掉多余的${over.name}`,
          actions: [{ type: 'shovel', lane: over.lane, column: over.column }],
        };
      }
      const sunMakers = s.plants.filter((p) => /sunflower|sunshroom|twinsunflower/i.test(p.type)).length;
      const sunCard = ready.find((c) => /sunflower|sunshroom|twinsunflower|primalsunflower/i.test(c.type));
      const shooters = ready.filter((c) => /pea|shot|pult|melon|cabbage|kernel|bloomerang|reed|starfruit|fume|laser|spike|sniper/i.test(c.type));
      const walls = ready.filter((c) => /wallnut|tallnut|endurian|garlic|nut/i.test(c.type));

      const danger = s.zombies.filter((z) => z.column <= 3.5).sort((a, b) => a.column - b.column)[0];
      if (danger) {
        const actions = [];
        const wall = walls[0];
        const laneHasWall = s.plants.some((p) => p.lane === danger.lane && plantRole(p.type) === 'wall');
        if (wall && !laneHasWall) {
          for (const col of [3, 2, 1]) {
            if (free(danger.lane, col)) { actions.push({ type: 'plant', card: wall.index, lane: danger.lane, column: col }); break; }
          }
        }
        if (shooters[0]) {
          for (const col of [1, 2, 0, 3, 4]) {
            if (free(danger.lane, col)) { actions.push({ type: 'plant', card: shooters[0].index, lane: danger.lane, column: col }); break; }
          }
        }
        if (actions.length) return { thought: '最危险一路补防', actions };
      }

      if (sunMakers < 3 && sunCard) {
        for (const lane of [2, 1, 3, 0, 4]) for (const col of [0, 1, 2]) {
          if (free(lane, col)) return { thought: '补经济（向日葵）', actions: [{ type: 'plant', card: sunCard.index, lane, column: col }] };
        }
      }

      if (shooters[0]) {
        const counts = [0, 0, 0, 0, 0];
        s.plants.forEach((p) => { counts[p.lane] = (counts[p.lane] || 0) + 1; });
        const lane = counts.indexOf(Math.min(...counts));
        for (const col of [1, 2, 3, 4, 0, 5]) {
          if (free(lane, col)) return { thought: '补输出', actions: [{ type: 'plant', card: shooters[0].index, lane, column: col }] };
        }
      }

      if (walls[0] && s.zombies.length) {
        for (const z of s.zombies) {
          if (s.plants.some((p) => p.lane === z.lane && plantRole(p.type) === 'wall')) continue;
          for (const col of [4, 3, 2]) {
            if (free(z.lane, col)) return { thought: '加一道墙', actions: [{ type: 'plant', card: walls[0].index, lane: z.lane, column: col }] };
          }
        }
      }

      return { thought: '等待阳光/冷却', actions: [{ type: 'wait' }] };
    }

    function fmtKbElement(e) {
      if (!e || !e.TYPE) return '';
      if (e.VALUE != null) return `${e.TYPE}:${e.VALUE}`;
      if (e.SORT && e.SORT.zh) return `${e.TYPE}:${e.SORT.zh}`;
      if (e.PROGRESS != null) return `${e.TYPE}:${Math.round(e.PROGRESS * 100)}%`;
      return '';
    }

    function ensureKbNames() {
      if (kb.plantNames) return;
      kb.plantNames = Object.create(null);
      kb.zombieNames = Object.create(null);
      kb.plantIdSet = new Set();
      kb.zombieIdSet = new Set();
      try {
        for (const e of ctx.plants.listFeatureEntries()) {
          kb.plantNames[e.id] = (e.name && e.name.zh) || e.label || e.id;
          if (e.id) kb.plantIdSet.add(e.id);
        }
      } catch { /* ignore */ }
      try {
        for (const e of ctx.zombies.listFeatureEntries()) {
          kb.zombieNames[e.id] = (e.name && e.name.zh) || e.label || e.id;
          if (e.id) kb.zombieIdSet.add(e.id);
        }
      } catch { /* ignore */ }
    }

    function plantKb(type) {
      const key = String(type || '');
      if (!key) return null;
      if (kb.plants[key]) return kb.plants[key];
      ensureKbNames();
      const info = {
        name: kb.plantNames[key] || PLANT_CN[key] || key,
        brief: '',
        special: [],
        tags: [],
        elements: [],
      };
      try {
        const f = ctx.plants.getFeature(key);
        if (f && Array.isArray(f.TAGS)) info.tags = f.TAGS.slice();
      } catch { /* ignore */ }
      try {
        const a = ctx.plants.getAlmanac(key);
        const d = a && a.objdata;
        if (d) {
          info.brief = (d.BriefIntroduction && d.BriefIntroduction.zh) || (d.Introduction && d.Introduction.zh) || '';
          if (Array.isArray(d.Special)) {
            info.special = d.Special.map((s) => `${(s.NAME && s.NAME.zh) || ''}：${(s.DESCRIPTION && s.DESCRIPTION.zh) || ''}`).filter((s) => s.length > 1);
          }
          if (Array.isArray(d.Elements)) info.elements = d.Elements.map(fmtKbElement).filter(Boolean);
        }
      } catch { /* ignore */ }
      kb.plants[key] = info;
      return info;
    }

    function zombieKb(type) {
      const key = String(type || '');
      if (!key) return null;
      if (kb.zombies[key]) return kb.zombies[key];
      ensureKbNames();
      const info = {
        name: kb.zombieNames[key] || ZOMBIE_CN[key] || key,
        brief: '',
        special: [],
        elements: [],
      };
      try {
        const a = ctx.zombies.getAlmanac(key);
        const d = a && a.objdata;
        if (d) {
          info.brief = (d.BriefIntroduction && d.BriefIntroduction.zh) || (d.Introduction && d.Introduction.zh) || '';
          if (Array.isArray(d.Special)) {
            info.special = d.Special.map((s) => `${(s.NAME && s.NAME.zh) || ''}：${(s.DESCRIPTION && s.DESCRIPTION.zh) || ''}`).filter((s) => s.length > 1);
          }
          if (Array.isArray(d.Elements)) info.elements = d.Elements.map(fmtKbElement).filter(Boolean);
        }
      } catch { /* ignore */ }
      kb.zombies[key] = info;
      return info;
    }

    // ───────────────────────── 开局计划 ─────────────────────────

    function roleLabel(type) {
      const r = plantRole(type);
      return r === 'other' ? '' : (ROLE_LABEL[r] || '');
    }

    function suggestDeck(s) {
      const avail = (s.seedSelection && s.seedSelection.available) || [];
      if (!avail.length) return [];
      const chosen = avail.filter((p) => p.chosen).map((p) => p.type);
      const pick = (re, limit = 1) => avail
        .filter((p) => re.test(p.type))
        .sort((a, b) => (a.cost || 0) - (b.cost || 0))
        .slice(0, limit).map((p) => p.type);
      const list = [];
      const add = (arr) => {
        for (const t of arr) if (list.length < 8 && list.indexOf(t) < 0) list.push(t);
      };
      add(pick(/sunflower|sunshroom|twinsunflower|primalsunflower/));
      add(pick(/wallnut|tallnut|endurian|garlic|infi-nut/));
      add(pick(/repeater|gatling|melon|laser|bloomerang|lightning|threepeater/));
      add(pick(/peashooter|bonk|cabbage|kernel|snowpea/));
      add(pick(/cherrybomb|jalapeno|squash|lava/));
      add(pick(/spikeweed|spikrock/));
      add(chosen);
      return list;
    }

    function planSummary(p) {
      const parts = [];
      if (p.goal) parts.push('目标：' + p.goal);
      if (p.threats.length) parts.push('威胁：' + p.threats.join('、'));
      if (p.counters.length) parts.push('对策：' + p.counters.join('；'));
      if (p.deck.length) parts.push('卡组：' + p.deck.join(','));
      if (p.buildOrder.length) parts.push('开局：' + p.buildOrder.join(' → '));
      if (p.shovelPolicy) parts.push('铲除策略：' + p.shovelPolicy);
      if (p.dangerLanes.length) parts.push('重点行：第' + p.dangerLanes.map((n) => n + 1).join('/') + '排');
      if (p.notes) parts.push('备注：' + p.notes);
      return parts.join('｜');
    }

    // 把模型/本地计划归一化：deck 必须是本关真的能选的 codename，限制长度，避免污染提示词。
    function normalizePlan(raw, s, opts = {}) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const avail = ((s.seedSelection && s.seedSelection.available) || []).map((p) => p.type);
      const conveyor = !!(s.conveyor && s.conveyor.enabled);
      const deckRaw = (Array.isArray(src.deck) ? src.deck : [])
        .map((t) => cleanCodename(String(t || ''))).filter(Boolean);
      const deck = [];
      for (const t of deckRaw) {
        if (deck.length >= 8) break;
        if (deck.indexOf(t) >= 0) continue;
        if (avail.length && avail.indexOf(t) < 0) continue;
        deck.push(t);
      }
      if (!deck.length && avail.length && !conveyor && opts.fillDeck !== false) {
        suggestDeck(s).forEach((t) => { if (deck.length < 8) deck.push(t); });
      }
      // 卡组保底：至少 1 个阳光生产者 + 2 个输出（可选卡里有的话），否则很容易被拖死。
      if (avail.length && !conveyor && opts.fillDeck !== false) {
        const add = (type) => {
          if (!type || deck.indexOf(type) >= 0) return;
          if (deck.length >= 8) deck.pop();
          deck.push(type);
        };
        if (!deck.some((t) => plantRole(t) === 'sun')) add(avail.find((t) => plantRole(t) === 'sun'));
        const shooters = deck.filter((t) => plantRole(t) === 'shooter');
        if (shooters.length < 2) {
          const pool = avail.filter((t) => plantRole(t) === 'shooter' && deck.indexOf(t) < 0)
            .sort((a, b) => (cardCostOf(s, a) || 999) - (cardCostOf(s, b) || 999));
          for (const t of pool) { if (deck.filter((x) => plantRole(x) === 'shooter').length >= 2) break; add(t); }
        }
        const slots = (s.seedSelection && s.seedSelection.slots) || deck.length;
        if (slots > 0 && deck.length > slots) deck.length = slots;
      }
      const arr = (v, max) => (Array.isArray(v) ? v : (v ? [v] : []))
        .map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max);
      const plan = {
        levelKey: levelKeyOf(s),
        at: Date.now(),
        source: 'llm',
        goal: String(src.goal || '').slice(0, 160),
        threats: arr(src.threats, 6),
        counters: arr(src.counters, 8),
        deck,
        buildOrder: arr(src.buildOrder, 6),
        shovelPolicy: String(src.shovelPolicy || '').slice(0, 240),
        dangerLanes: (Array.isArray(src.dangerLanes) ? src.dangerLanes : [])
          .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 6).slice(0, 5),
        notes: String(src.notes || '').slice(0, 240),
      };
      plan.text = planSummary(plan);
      return plan;
    }

    function localPlan(s) {
      const missions = (s.objective && s.objective.missions) || s.objectiveMissions || [];
      const tasks = s.tasks || [];
      const goal = missions.concat(tasks.map((t) => t.tip)).filter(Boolean).join('；') || '清完本关僵尸，守住房子';
      const preview = (s.levelPreview && s.levelPreview.zombies) || [];
      const threats = [];
      const counters = [];
      for (const id of preview.slice(0, 4)) {
        const k = zombieKb(id);
        threats.push((k && k.name) || id);
        const tip = zombieTraits(id).map((t) => ZOMBIE_COUNTER_TIPS[t]).filter(Boolean)[0];
        if (tip) counters.push(tip);
      }
      return {
        goal,
        threats,
        counters,
        deck: suggestDeck(s),
        buildOrder: ['阳光生产者种 c0-c2（2-3 株）', '最危险行先补 1 个射手', '每行至少 1 射手后再加坚果', '后期用一次性爆发/能量豆救场'],
        shovelPolicy: '重复超限、位置太靠前、打不动的弱卡用更强卡替换；loss_limit 只剩 1 株时不铲',
        dangerLanes: [],
        notes: '',
      };
    }

    function briefingText(s) {
      const lines = [];
      const missions = (s.objective && s.objective.missions && s.objective.missions.length)
        ? s.objective.missions
        : (s.objectiveMissions || []);
      const tasks = s.tasks || [];
      lines.push(`关卡：${s.level.name || s.scene || '未知'}｜阶段：${phaseText(s.phase)}｜波次：${s.level.wave}/${s.level.waves || '?'}`);
      if (levelHint && (!levelHintKey || levelHintKey === levelKeyOf(s))) {
        lines.push('玩家本关临时策略（优先）：' + levelHint);
      }
      if (s.world) {
        lines.push(`世界：${s.world.name}｜机制：${s.world.mechanics}`);
        lines.push('世界要点：' + s.world.tips);
      }
      if (missions.length) lines.push('关卡目标原文：' + missions.join('；'));
      if (tasks.length) {
        lines.push('任务进度：' + tasks.map((t) => `${t.tip}${t.count ? ' ' + t.count : ''}${t.hint ? '（' + t.hint + '）' : ''}`).join('；'));
      }
      const hints = (s.missionHints && s.missionHints.length)
        ? s.missionHints
        : parseMissionHints(missions.concat(tasks.map((t) => t.tip)));
      if (hints.length) lines.push('任务要点：' + hints.map((h) => h.hint).join('；'));
      if (s.terrain) lines.push('地形（L陆地 P木板 W水 S天空 R轨道）：' + s.terrain.map.join(' '));
      if (s.mechanics) {
        const f = (s.mechanics.features || []).join(',') || '无';
        lines.push(`地图机制：${f}${s.mechanics.supported === false ? '（该关卡类型暂不支持操作）' : ''}`);
        if (s.mechanics.tide) lines.push(`潮汐：水线 pos=${s.mechanics.tide.pos ?? '?'}`);
        if (s.mechanics.dinosaurs && s.mechanics.dinosaurs.length) {
          lines.push('恐龙：' + s.mechanics.dinosaurs.map((d) => `${d.kind || d.class}@第${Number.isFinite(d.lane) ? d.lane + 1 : '?'}排`).join('；'));
        }
      }
      if (s.carts && s.carts.length) {
        lines.push('矿车：' + s.carts.map((c) => `#${c.id}@第${c.lane + 1}排 载[${c.plants.map((p) => p.name || p.type).join(',') || '空'}]`).join('；'));
      }
      if (s.conveyor && s.conveyor.enabled) lines.push('传送带关卡：卡组固定，plan.deck 请输出 []。');
      const preview = (s.levelPreview && s.levelPreview.zombies) || [];
      if (preview.length) {
        const fromWorld = s.levelPreview && s.levelPreview.source === 'world-knowledge';
        lines.push(`预计僵尸${fromWorld ? '（关卡数据未读到，按世界常识估计）' : '（来自关卡数据）'}：`);
        for (const id of preview.slice(0, 12)) {
          const k = zombieKb(id);
          const tags = zombieTraits(id);
          const elems = k && k.elements.length ? `｜${k.elements.join(' ')}` : '';
          const brief = k && k.brief ? `｜${k.brief.slice(0, 80)}` : '';
          const special = k && k.special.length ? `｜${k.special.join('；').slice(0, 100)}` : '';
          lines.push(`- ${(k && k.name) || id}(${id})${tags.length ? '[' + tags.join(',') + ']' : ''}${elems}${brief}${special}`);
        }
        const tips = [];
        for (const id of preview) for (const t of zombieTraits(id)) if (tips.indexOf(t) < 0) tips.push(t);
        const tipText = tips.map((t) => ZOMBIE_COUNTER_TIPS[t]).filter(Boolean);
        if (tipText.length) lines.push('应对要点：' + tipText.join('；'));
      } else {
        lines.push('预计僵尸：关卡数据里没读到，按关卡世界和常见波次判断。');
      }
      if (s.seedSelection) {
        const avail = s.seedSelection.available || [];
        lines.push(`可选卡组（卡槽上限 ${s.seedSelection.slots || '?'}，codename(费用)[已选]）：`);
        for (const p of avail.slice(0, 50)) {
          const k = plantKb(p.type);
          const role = roleLabel(p.type);
          const brief = k && k.brief ? `｜${k.brief.slice(0, 45)}` : '';
          const special = k && k.special.length ? `；${k.special.join('；').slice(0, 50)}` : '';
          lines.push(`- ${p.type}(${p.cost})${p.chosen ? '[已选]' : ''}${role ? '｜' + role : ''}${brief}${special}`);
        }
      } else if (s.cards && s.cards.length) {
        lines.push('当前卡组：' + s.cards.map((c) => `${c.type}(${c.cost})`).join(', '));
      }
      lines.push('现在先制定整关计划（只需要 plan，不需要动作）。');
      return lines.join('\n');
    }

    async function makePlan(s, opts = {}) {
      const key = levelKeyOf(s);
      if (!opts.force && currentPlan && currentPlan.levelKey === key) return currentPlan;
      let plan = null;
      if (!cfg.localBrain) {
        mlog('开局前制定对策…');
        try {
          const r = await chatCompletion([
            { role: 'system', content: PLANNER_PROMPT },
            { role: 'user', content: briefingText(s) },
          ], { tools: false, maxTokens: 1400 });
          if (r.content) {
            const parsed = parseDecision(r.content);
            plan = normalizePlan(parsed && parsed.plan ? parsed.plan : parsed, s);
          }
        } catch (e) {
          mlog('制定对策失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }
      if (!plan || !(plan.goal || plan.buildOrder.length || plan.deck.length || plan.counters.length)) {
        plan = normalizePlan(localPlan(s), s);
        plan.source = 'local';
      }
      currentPlan = plan;
      if (run) run.planDeckDone = false;
      thinkSetPlan(plan);
      mlog(`📋 作战计划：${plan.text || plan.goal || '已制定'}`, 'ok');
      return plan;
    }

    function setPlan(input) {
      const s = safeSnapshot();
      if (!s.ok) return fail('NO_SCENE', {}, s.reason);
      const raw = typeof input === 'string' ? { goal: input } : input;
      const plan = normalizePlan(raw, s, { fillDeck: false });
      plan.source = 'external';
      currentPlan = plan;
      mlog(`📋 已记录作战计划：${plan.text || plan.goal || '（空）'}`, 'ok');
      return { ok: true, detail: '已记录作战计划', plan };
    }

    function planValue() {
      return currentPlan ? { ...currentPlan } : null;
    }

    // 外部（MCP）用的一页开局简报：任务 + 预计僵尸 + 图鉴 + 可选卡组
    function briefingValue() {
      const s = safeSnapshot();
      if (!s.ok) return { ok: false, reason: s.reason };
      return {
        ok: true,
        phase: s.phase,
        level: s.level,
        missions: (s.objective && s.objective.missions && s.objective.missions.length)
          ? s.objective.missions : (s.objectiveMissions || []),
        tasks: s.tasks || [],
        missionHints: (s.missionHints || []).map((h) => h.hint),
        terrain: s.terrain ? s.terrain.map : null,
        mechanics: s.mechanics ? { features: s.mechanics.features, supported: s.mechanics.supported } : null,
        world: s.world || null,
        carts: s.carts || [],
        conveyor: s.conveyor || null,
        levelPreview: s.levelPreview || null,
        deckOptions: s.seedSelection
          ? s.seedSelection.available.map((p) => ({ type: p.type, name: p.name, cost: p.cost, chosen: p.chosen, ...plantKb(p.type) }))
          : null,
        deckSlots: s.seedSelection ? s.seedSelection.slots : null,
        suggestedDeck: suggestDeck(s),
        zombieKnowledge: ((s.levelPreview && s.levelPreview.zombies) || []).map((id) => ({
          id, ...(zombieKb(id) || {}), tags: zombieTraits(id),
          counters: zombieTraits(id).map((t) => ZOMBIE_COUNTER_TIPS[t]).filter(Boolean),
        })),
        cards: s.cards || [],
        plan: currentPlan,
        text: briefingText(s),
      };
    }

    // 5×9 文字棋盘：提示词和思考浮窗共用同一份渲染。
    function boardLines(s) {
      const out = [];
      const lanes = (s.grid && s.grid.lanes) || 5;
      const cols = (s.grid && s.grid.columns) || 9;
      const tag = (name, type) => {
        const n = String(name || type || '?');
        return n.length > 2 ? n.slice(0, 2) : n;
      };
      out.push('位置图（c0 在房子侧，c8 在僵尸出生侧；· 为空）：');
      out.push('　　　' + Array.from({ length: cols }, (_, c) => 'c' + c).join(' '));
      for (let r = 0; r < lanes; r++) {
        const cells = [];
        for (let c = 0; c < cols; c++) {
          const p = s.plants.find((x) => x.lane === r && x.column === c);
          cells.push(p ? tag(p.name, p.type) : '·');
        }
        const zs = s.zombies.filter((z) => z.lane === r)
          .map((z) => `c${Math.max(0, Math.round(z.column))}${tag(z.name, z.type)}${z.hp ? '(' + z.hp + ')' : ''}`);
        out.push(`第${r + 1}排 ${cells.join(' ')}${zs.length ? ' ｜僵尸 ' + zs.join(' ') : ''}`);
      }
      return out;
    }

    let externalStrategy = '';
    let strategyFile = '';

    function effectiveStrategy() {
      return externalStrategy || DEFAULT_STRATEGY;
    }

    function systemPrompt() {
      return SYSTEM_PROMPT_CORE + '\n\n决策原则：\n' + effectiveStrategy();
    }

    async function loadStrategyFile(manual) {
      try {
        const files = ctx.files;
        if (!files || typeof files.own !== 'function') {
          if (manual) mlog('当前 GP-Next 不支持 ctx.files，无法读取 strategy.md', 'warn');
          if (el.strategyStatus) el.strategyStatus.textContent = '当前环境不支持读取 strategy.md（用内置默认）';
          return false;
        }
        const own = files.own();
        if (!own || typeof own.readText !== 'function') {
          if (manual) mlog('ctx.files 不可用，无法读取 strategy.md', 'warn');
          if (el.strategyStatus) el.strategyStatus.textContent = 'ctx.files 不可用（用内置默认）';
          return false;
        }
        const candidates = ['strategy.md', 'strategy.txt', 'config/strategy.md', 'scripts/strategy.md'];
        let raw = null;
        let used = '';
        try {
          const listed = typeof own.listPaths === 'function' ? own.listPaths() : [];
          for (const path of listed) {
            const norm = String(path).replace(/^\.\//, '');
            if (!/(^|\/)(strategy)\.(md|txt)$/i.test(norm)) continue;
            const text = await own.readText(norm);
            if (typeof text === 'string' && text.trim()) { raw = text; used = norm; break; }
          }
        } catch { /* ignore */ }
        if (raw === null) {
          for (const path of candidates) {
            try {
              const text = await own.readText(path);
              if (typeof text === 'string' && text.trim()) { raw = text; used = path; break; }
            } catch { /* try next */ }
          }
        }
        if (raw === null) {
          if (manual) mlog('没找到 strategy.md（仍使用内置默认策略）', 'warn');
          if (el.strategyStatus) el.strategyStatus.textContent = '未找到 strategy.md（使用内置默认）';
          return false;
        }
        // 以 # 开头的行是注释，不发给模型。
        const text = raw.split(/\r?\n/)
          .filter((line) => !/^\s*#/.test(line))
          .join('\n').trim().slice(0, 20000);
        if (!text) {
          if (manual) mlog('strategy.md 是空的（仍使用内置默认策略）', 'warn');
          if (el.strategyStatus) el.strategyStatus.textContent = 'strategy.md 为空（使用内置默认）';
          return false;
        }
        externalStrategy = text;
        strategyFile = used;
        mlog(`已加载策略文件：${used}（${text.length} 字）`, 'ok');
        if (el.strategyStatus) el.strategyStatus.textContent = `已加载 ${used}（${text.length} 字）`;
        return true;
      } catch (e) {
        mlog('策略文件读取失败，使用内置策略：' + (e && e.message ? e.message : e), 'warn');
        if (el.strategyStatus) el.strategyStatus.textContent = '读取 strategy.md 失败（使用内置默认）';
        return false;
      }
    }

    function stateForPrompt(s) {
      const compact = {
        phase: s.phase,
        level: s.level,
        tasks: s.tasks || [],
        sun: s.sun,
        plantFood: s.plantFood,
        cards: s.cards.map((c) => ({ i: c.index, type: c.type, name: c.name, cost: c.cost, cd: c.cd, ready: c.ready, affordable: c.affordable })),
        plants: s.plants.map((p) => ({ lane: p.lane, column: p.column, type: p.type, name: p.name, hp: p.hp, maxHp: p.maxHp })),
        zombies: s.zombies.map((z) => ({ lane: z.lane, column: z.column, type: z.type, name: z.name, tags: z.tags || [], hp: z.hp, maxHp: z.maxHp, hypnotized: z.hypnotized })),
        sunsOnGround: s.suns.length,
        lastResults: (run && run.lastResults) || [],
        terrain: s.terrain ? { map: s.terrain.map, legend: s.terrain.legend } : null,
        blockedCells: s.blockedCells || [],
        carts: s.carts || [],
        lanes: s.lanes || [],
        conveyor: s.conveyor || null,
        mechanics: s.mechanics || null,
        recentLosses: s.recentLosses || [],
        paused: !!s.paused,
        objectiveMissions: s.objectiveMissions || [],
        missionHints: (s.missionHints || []).map((h) => h.hint),
        plan: s.plan ? { goal: s.plan.goal, deck: s.plan.deck, buildOrder: s.plan.buildOrder } : null,
        levelPreview: s.levelPreview || null,
        world: s.world || null,
        shovelCandidates: (s.shovelCandidates || []).slice(0, 8),
        shovelBlocked: !!s.shovelBlocked,
      };
      if (s.phase === 'preparing' && s.seedSelection) compact.seedSelection = s.seedSelection;

      const lines = [];
      lines.push(`关卡：${s.level.name || '未知'}  阶段：${phaseText(s.phase)}  波次：${s.level.wave}/${s.level.waves || '?'}  下一波：${s.level.nextWaveIn ?? '?'}s`);
      if (levelHint && (!levelHintKey || levelHintKey === levelKeyOf(s))) {
        lines.push('👤 本关临时策略（优先于默认策略，只在本关生效）：' + levelHint);
      }
      if (s.world) {
        lines.push(`世界：${s.world.name}｜机制：${s.world.mechanics}｜要点：${s.world.tips}`);
      }
      if (s.paused) lines.push('⚠️ 游戏已暂停：所有种植/铲除/能量豆都会被忽略，先调用 resume（pvz_resume 或 pvz_act {type:"resume"}）。');
      if (s.tasks && s.tasks.length) {
        lines.push('本关任务（必须完成）：' + s.tasks.map((t) => {
          const tail = t.completed ? ' [已完成]' : (t.failed ? ' [已失败]' : '');
          const extra = t.timeSemantics === 'sliding_window' && t.timeLeft !== null ? `（窗口剩 ${t.timeLeft.toFixed(1)}s）`
            : t.semantics === 'loss_limit' && t.left !== undefined ? `（还可损失 ${t.left}）`
              : t.semantics === 'count_limit' && t.left !== undefined ? `（还能种 ${t.left}）` : '';
          return `${t.tip}${t.count ? ' ' + t.count : ''}${extra}${tail}`;
        }).join('；'));
        for (const t of s.tasks) {
          if (t.hint) lines.push(`任务提示：${t.hint}${t.urgent ? '  ⚠️ 紧急，优先集中输出/能量豆/一次性植物' : ''}`);
        }
      } else if (s.objective && s.objective.missions && s.objective.missions.length) {
        lines.push('本关任务（目标说明界面）：' + s.objective.missions.join('；'));
      }
      if (s.plan && s.plan.text) {
        lines.push('本关作战计划（开局前制定，照此执行；局势突变可临时偏离）：' + s.plan.text);
      }
      if (s.missionHints && s.missionHints.length) {
        lines.push('任务要点：' + s.missionHints.map((h) => h.hint).join('；'));
      }
      if (!s.shovelBlocked && s.shovelCandidates && s.shovelCandidates.length) {
        const c0 = s.shovelCandidates[0];
        const verb = c0.reason === 'upgrade'
          ? `可以 replace 成 ${PLANT_CN[c0.better] || c0.better}（card=${c0.betterCard}）`
          : '建议铲掉腾位';
        lines.push(`⚡ 优先处理：第${c0.lane + 1}排c${c0.column} ${c0.name} ${verb}；细节见下方候选。`);
      }
      if (s.levelPreview && s.levelPreview.zombies && s.levelPreview.zombies.length) {
        lines.push(`预计僵尸${s.levelPreview.source === 'world-knowledge' ? '（世界常识估计）' : ''}：` + s.levelPreview.zombies.map((id) => {
          const k = zombieKb(id);
          const tags = zombieTraits(id);
          return `${(k && k.name) || id}(${id})${tags.length ? '[' + tags.join(',') + ']' : ''}`;
        }).join('；'));
      }
      {
        const tags = new Set();
        for (const z of s.zombies) for (const t of (z.tags || [])) tags.add(t);
        for (const id of ((s.levelPreview && s.levelPreview.zombies) || [])) for (const t of zombieTraits(id)) tags.add(t);
        const tips = [...tags].map((t) => ZOMBIE_COUNTER_TIPS[t]).filter(Boolean);
        if (tips.length) lines.push('应对要点：' + tips.join('；'));
      }

      // 位置图：让模型直接“看到” 5×9 的格子，而不是从一堆数组里自己拼。
      {
        const lanes = (s.grid && s.grid.lanes) || 5;
        const cols = (s.grid && s.grid.columns) || 9;
        lines.push(...boardLines(s));

        // 空位建议：把“能种哪一格”算好，模型不用自己推。
        const freeAt = (lane, role) => {
          const win = roleWindowOf(role);
          const out = [];
          for (let c = win[0]; c <= Math.min(win[1], cols - 1); c++) {
            if (s.plants.some((p) => p.lane === lane && p.column === c)) continue;
            if ((s.blockedCells || []).some((b) => b.lane === lane && b.column === c)) continue;
            const ch = s.terrain && Array.isArray(s.terrain.map) ? String(s.terrain.map[lane] || '')[c] : 'L';
            if (ch === 'W' || ch === 'S') continue;
            out.push(c);
          }
          return out;
        };
        const readyRoles = [...new Set((s.cards || []).filter((c) => c.ready).map((c) => plantRole(c.type)))];
        const rows = [];
        for (let r = 0; r < lanes; r++) {
          const zs = s.zombies.filter((z) => z.lane === r);
          const shooters = s.plants.filter((p) => p.lane === r && plantRole(p.type) === 'shooter').length;
          const urgent = zs.length && (shooters === 0 || zs.some((z) => z.column <= 3));
          if (!urgent) continue;
          const parts = [];
          if (readyRoles.includes('shooter')) {
            const f = freeAt(r, 'shooter');
            if (f.length) parts.push(`输出 c${f.slice(0, 3).join('/c')}`);
          }
          if (readyRoles.includes('wall')) {
            const f = freeAt(r, 'wall');
            if (f.length) parts.push(`坚果 c${f.slice(0, 2).join('/c')}`);
          }
          if (parts.length) rows.push(`第${r + 1}排：${parts.join('，')}`);
          if (rows.length >= 3) break;
        }
        if (rows.length) lines.push('空位建议（可直接用）：' + rows.join(' ｜ '));
        lines.push(`位置窗口：阳光 c0-c2；普通输出 c0-c4；坚果/近战 c3-c7；地刺 c4-c7（必须在坚果前面）。放错位置会被拒绝（POSITION）并给出可改种格子。`);
      }
      if (s.terrain && Array.isArray(s.terrain.map)) {
        lines.push('地形（L陆地 P木板 W水 S天空 R矿车轨道，每行字符串）：' + s.terrain.map.join(' '));
      }
      if (s.blockedCells && s.blockedCells.length) {
        const list = s.blockedCells.slice(0, 16).map((b) => `${b.lane},${b.column}:${b.terrain || '?'}/${b.reason || 'blocked'}`);
        lines.push('不可种植格子：' + list.join(' ') + (s.blockedCells.length > 16 ? ` …共 ${s.blockedCells.length} 个` : ''));
      }
      if (s.carts && s.carts.length) {
        lines.push('矿车：' + s.carts.map((c) => `#${c.id} 第${c.lane + 1}排(${c.lane},${c.column}) 载[${c.plants.map((p) => p.name || p.type).join(',') || '空'}] 可上${c.canUp ? '✓' : '✗'}下${c.canDown ? '✓' : '✗'}`).join('；') + '（用 move_cart 把车移到有僵尸的行，植物会跟着走）');
      }
      if (s.shovelBlocked) {
        lines.push('⚠️ 不能主动铲除：' + (s.shovelBlockedReason || '任务限制，再损失一株就失败'));
      } else if (s.shovelCandidates && s.shovelCandidates.length) {
        const reasonText = (c) => {
          if (c.reason === 'over_limit') return `超上限${c.limit ? c.limit : ''}`;
          if (c.reason === 'upgrade') return `可换${PLANT_CN[c.better] || c.better || '更强卡'}${c.betterCard != null ? '(card ' + c.betterCard + ')' : ''}`;
          if (c.reason === 'misplaced') return c.hint || '位置不合适';
          if (c.reason === 'low_hp') return '残血快死';
          return c.reason;
        };
        lines.push('可铲除/替换候选（建议，不是命令）：' + s.shovelCandidates.map((c) =>
          `第${c.lane + 1}排c${c.column} ${c.name}（${reasonText(c)}${c.hpPercent != null ? `，血${c.hpPercent}%` : ''}）`).join('；')
          + ' → 只腾位用 shovel；要换更强卡用 replace（card=候选里的可换卡）');
      }
      if (s.recentShovels && s.recentShovels.length) {
        const list = s.recentShovels.slice(-3).map((x) => `第${x.lane + 1}排c${x.column} ${x.types.map((t) => PLANT_CN[t] || t).join(',')}`);
        lines.push('最近铲除：' + list.join('；'));
      }
      if (s.conveyor && s.conveyor.enabled) {
        lines.push(`传送带：${s.conveyor.cards.map((c) => `[${c.index}]${c.name || c.type}`).join(' ') || '暂时没有卡'}（plant 的 card 用这里的 index；不扣阳光、不吃种子冷却）`);
      }
      if (s.recentLosses && s.recentLosses.length) {
        const now = Date.now();
        const list = s.recentLosses.filter((l) => now - l.at < 20000).slice(-4)
          .map((l) => `第${l.lane + 1}排c${l.column} ${PLANT_CN[l.type] || l.type}`);
        if (list.length) lines.push('最近损失：' + list.join('；'));
      }
      if (s.mechanics) {
        const m = s.mechanics;
        lines.push(`地图机制：${(m.features || []).join(',') || '无'}｜supported=${m.supported}${m.unsupportedReason ? `（${m.unsupportedReason}）` : ''}`);
        if (m.tide) lines.push(`潮汐：水位 pos=${m.tide.pos ?? '?'}，水覆盖约 ${m.tide.waterColumns ?? '?'} 列${m.tide.moving ? '，正在移动' : ''}`);
        if (m.dinosaurs && m.dinosaurs.length) {
          lines.push('恐龙：' + m.dinosaurs.map((d) => `${d.kind || d.class}@第${Number.isFinite(d.lane) ? d.lane + 1 : '?'}排${d.action ? '/' + d.action : ''}${d.state ? '/' + d.state : ''}`).join('；'));
        }
        if (m.portals && m.portals.length) {
          lines.push('传送门：' + m.portals.map((p) => `第${Number.isFinite(p.lane) ? p.lane + 1 : '?'}排c${p.column ?? '?'}${p.World ? '/' + p.World : ''}`).join('；'));
        }
        if (m.hazards && m.hazards.length) {
          lines.push('机制危险：' + m.hazards.map((h) => `${h.type}${Number.isFinite(h.lane) ? '@第' + (h.lane + 1) + '排' : ''}${h.Column !== undefined ? ' c' + h.Column : ''}${h.Direction !== undefined ? ' 方向' + h.Direction : ''}`).join('；'));
        }
        if (m.unmappedTiles && m.unmappedTiles.length) lines.push('未识别地块：' + m.unmappedTiles.join(','));
        if (m.supported === false) lines.push('⚠️ 该关卡类型不在支持范围：种植会返回 UNSUPPORTED_LEVEL，不要继续尝试。');
      }
      lines.push(`阳光：${s.sun}  能量豆：${s.plantFood ?? 0}  地面掉落：${s.suns.length}`);
      if (run && run.lastResults && run.lastResults.length) {
        lines.push('上一回合结果：' + run.lastResults.join('；'));
      }
      if (s.phase === 'preparing' && s.seedSelection) {
        lines.push(`可选卡：${s.seedSelection.available.map((p) => `${p.type}(${p.cost})`).join(', ')}`);
      } else {
        lines.push('卡槽图鉴：');
        for (const c of s.cards) {
          const k = plantKb(c.type);
          const brief = k && k.brief ? k.brief.slice(0, 60) : '';
          const special = k && k.special.length ? k.special.join('；').slice(0, 60) : '';
          const extra = [brief, special].filter(Boolean).join('；');
          const tags = k && k.tags.length ? `｜${k.tags.join(',')}` : '';
          const role = roleLabel(c.type);
          lines.push(`[${c.index}] ${c.name}(${c.type}) ${c.cost}☀ ${c.ready ? '可用' : (c.cd > 0 ? `CD${c.cd}s` : '阳光不足')}${role ? '｜' + role : ''}${extra ? '｜' + extra : ''}${tags}`);
        }
      }
      const ztypes = [...new Set(s.zombies.map((z) => z.type))].filter(Boolean);
      if (ztypes.length) {
        lines.push('僵尸图鉴：');
        for (const t of ztypes) {
          const k = zombieKb(t);
          if (!k) continue;
          const elems = k.elements.length ? `｜${k.elements.join(' ')}` : '';
          const extra = [k.brief.slice(0, 60), k.special.join('；').slice(0, 70)].filter(Boolean).join('；');
          const tags = zombieTraits(t);
          lines.push(`${k.name}(${t})${tags.length ? '[' + tags.join(',') + ']' : ''}${elems}${extra ? '｜' + extra : ''}`);
        }
      }
      const roleCounts = { sun: 0, wall: 0, spring: 0, freeze: 0, spike: 0, mine: 0, aoe: 0, support: 0, shooter: 0, other: 0 };
      for (const p of s.plants) roleCounts[plantRole(p.type)] = (roleCounts[plantRole(p.type)] || 0) + 1;
      lines.push(`阵容统计：射手×${roleCounts.shooter} 坚果×${roleCounts.wall} 弹簧豆×${roleCounts.spring} 冰冻生菜×${roleCounts.freeze} 地刺×${roleCounts.spike} 阳光生产者×${roleCounts.sun} 一次性爆发×${roleCounts.aoe} 地雷×${roleCounts.mine}`);
      lines.push(`每行软上限：${ROLE_LIMIT_TEXT}（超出会被代码拒绝；多余/更弱的植物用 shovel 或 replace 处理）`);
      if (roleCounts.sun === 0 && !s.cards.some((c) => plantRole(c.type) === 'sun' && c.ready)) {
        lines.push('提示：当前没有阳光生产者可用，不要等向日葵；优先低费射手/地刺，坚果只给最危险的行。');
      }
      if (s.lanes && s.lanes.length) {
        for (const L of s.lanes) {
          const lanePlants = s.plants.filter((p) => p.lane === L.lane);
          const ps = lanePlants.map((p) => `c${p.column}${p.name}`);
          const zs = s.zombies.filter((z) => z.lane === L.lane)
            .map((z) => `c${z.column}${z.name || z.type}(${z.hp})${z.tags && z.tags.length ? '[' + z.tags.join(',') + ']' : ''}`);
          const hints = [];
          if (L.needsShooter) hints.push('⚠️ 有僵尸但无射手：优先补射手或把矿车移过来');
          if (L.danger) hints.push('本行危险');
          if (L.cart) hints.push(`矿车#${L.cart.id} 可调动`);
          if (L.mower) hints.push('有小推车');
          lines.push(`第${L.lane + 1}排(lane ${L.lane}) 植物[${ps.join(' ') || '空'}] 僵尸[${zs.join(' ') || '无'}]｜射手×${L.shooters} 阳光×${L.sun} 坚果×${L.walls} 地刺×${L.spikes}${hints.length ? '｜' + hints.join('；') : ''}`);
        }
      } else {
        for (let r = 0; r < 5; r++) {
          const lanePlants = s.plants.filter((p) => p.lane === r);
          const ps = lanePlants.map((p) => `c${p.column}${p.name}`);
          const zs = s.zombies.filter((z) => z.lane === r).map((z) => `c${z.column}${z.name || z.type}(${z.hp})`);
          const lc = { sun: 0, wall: 0, spring: 0, freeze: 0, spike: 0, shooter: 0, other: 0 };
          lanePlants.forEach((p) => { const role = plantRole(p.type); lc[role] = (lc[role] || 0) + 1; });
          const hints = [];
          if (lc.shooter === 0) hints.push('缺输出');
          if (s.zombies.some((z) => z.lane === r && z.column <= 3)) hints.push('本行危险');
          lines.push(`第${r + 1}排(lane ${r}) 植物[${ps.join(' ') || '空'}] 僵尸[${zs.join(' ') || '无'}]｜射手×${lc.shooter} 坚果×${lc.wall}${hints.length ? '｜' + hints.join('；') : ''}`);
        }
      }
      return lines.join('\n') + '\n\nJSON 快照：\n' + JSON.stringify(compact, null, 0);
    }

    function parseDecision(text) {
      let t = String(text).trim();
      t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try { return JSON.parse(t); } catch { /* continue */ }
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
      throw new Error('no json');
    }

    function tauriInvoke() {
      const win = getWin();
      const fn = (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke)
        || (win.__TAURI_INTERNALS__ && win.__TAURI_INTERNALS__.invoke);
      return typeof fn === 'function' ? fn : null;
    }

    async function tauriInvokeFetch(invoke, url, options) {
      const headers = [];
      for (const k of Object.keys(options.headers || {})) headers.push([k, String(options.headers[k])]);
      const body = options.body ? Array.from(new TextEncoder().encode(String(options.body))) : null;
      const rid = await invoke('plugin:http|fetch', {
        clientConfig: {
          method: options.method || 'GET',
          url,
          headers,
          data: body,
          maxRedirections: 5,
          connectTimeout: 30000,
        },
      });
      const sent = await invoke('plugin:http|fetch_send', { rid });
      const chunks = [];
      let done = false;
      for (let i = 0; i < 10000 && !done; i++) {
        const raw = await invoke('plugin:http|fetch_read_body', { rid: sent.rid });
        const arr = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
        if (!arr.length) break;
        // 最后 1 字节是“结束”标记；官方 JS 实现会在此时丢弃该块并关闭流。
        if (arr[arr.length - 1] === 1) { done = true; break; }
        chunks.push(arr.subarray(0, arr.length - 1));
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      const text = new TextDecoder().decode(bytes);
      const outHeaders = new Headers();
      const rh = sent.headers || [];
      if (Array.isArray(rh)) {
        for (const pair of rh) if (Array.isArray(pair) && pair.length >= 2) outHeaders.append(pair[0], String(pair[1]));
      } else if (rh && typeof rh === 'object') {
        for (const k of Object.keys(rh)) outHeaders.append(k, String(rh[k]));
      }
      return new Response(text, { status: sent.status || 200, statusText: sent.statusText || '', headers: outHeaders });
    }

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时')), ms)),
      ]);
    }

    async function safeFetch(url, options) {
      const win = getWin();
      // 1) Tauri HTTP 插件（如果 withGlobalTauri 暴露了 http）
      try {
        const t = win.__TAURI__;
        const http = t && (t.http || (t.plugin && t.plugin.http));
        if (http && typeof http.fetch === 'function') {
          if (!tauriHttpLogged) {
            tauriHttpLogged = true;
            mlog('网络：使用 Tauri HTTP 插件');
          }
          return await http.fetch(url, options);
        }
      } catch (e) {
        if (!tauriHttpErrorLogged) {
          tauriHttpErrorLogged = true;
          mlog('Tauri HTTP 插件不可用：' + (e && e.message ? e.message : e), 'warn');
        }
      }
      // 2) 直接 invoke Rust 侧的 plugin:http|fetch（不经过 WebView，绕开 CSP）
      const invoke = tauriInvoke();
      if (invoke) {
        try {
          const res = await withTimeout(tauriInvokeFetch(invoke, url, options), 60000, 'Tauri HTTP');
          if (!tauriHttpLogged) {
            tauriHttpLogged = true;
            mlog('网络：使用 Tauri invoke HTTP（Rust 侧）');
          }
          return res;
        } catch (e) {
          if (!tauriHttpErrorLogged) {
            tauriHttpErrorLogged = true;
            mlog('Tauri invoke HTTP 不可用：' + (e && e.message ? e.message : e), 'warn');
          }
        }
      }
      // 3) 浏览器 fetch（受 CSP/CORS 限制）
      return (win !== window && typeof win.fetch === 'function')
        ? await win.fetch(url, options).catch(() => fetch(url, options))
        : await fetch(url, options);
    }

    // 读 SSE 流：返回 content/reasoning/toolArgs/finish/usage/raw，并支持增量回调（思考浮窗用）。
    async function readSse(res, onDelta) {
      const out = { content: '', reasoning: '', toolArgs: '', finish: null, usage: null, raw: '' };
      let buf = '';
      let lastEmit = 0;
      const emit = (force) => {
        if (!onDelta) return;
        const now = Date.now();
        if (!force && now - lastEmit < 120) return;
        lastEmit = now;
        try { onDelta(out); } catch { /* ignore */ }
      };
      const handleLine = (line) => {
        const t = String(line || '').trim();
        if (!t || !t.startsWith('data:')) return;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let j = null;
        try { j = JSON.parse(data); } catch { return; }
        if (j.usage && Number.isFinite(j.usage.total_tokens)) out.usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) return;
        if (ch.finish_reason) out.finish = ch.finish_reason;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) out.content += d.content;
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) out.reasoning += d.reasoning_content;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            if (tc && tc.function && typeof tc.function.arguments === 'string') out.toolArgs += tc.function.arguments;
          }
        }
        emit(false);
      };
      const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          const chunk = dec.decode(r.value, { stream: true });
          out.raw += chunk;
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            handleLine(line);
          }
        }
        if (buf) handleLine(buf);
      } else {
        out.raw = await res.text();
        for (const line of out.raw.split(/\r?\n/)) handleLine(line);
      }
      emit(true);
      return out;
    }

    async function chatCompletion(messages, opts = {}) {
      const url = normalizeBaseUrl(cfg.baseUrl) + '/chat/completions';
      const win = getWin();
      const AC = win.AbortController || AbortController;
      const controller = new AC();
      const timeout = setTimeout(() => controller.abort(), 60000);
      run.controller = controller;
      const isDeepSeek = /deepseek/i.test(cfg.baseUrl) || /deepseek/i.test(cfg.model);
      const body = {
        model: cfg.model,
        messages,
        temperature: 0.2,
        max_tokens: opts.maxTokens || 600,
        stream: !!opts.stream,
      };
      if (isDeepSeek && run.thinkingMode !== false) body.thinking = { type: 'disabled' };
      let useTools = !!(opts.tools && run.toolsMode !== false);
      const applyMode = () => {
        delete body.tools;
        delete body.tool_choice;
        delete body.response_format;
        if (useTools) {
          body.tools = [PLAY_TOOL];
          body.tool_choice = { type: 'function', function: { name: 'play_actions' } };
        } else if (run.jsonMode !== false) {
          body.response_format = { type: 'json_object' };
        }
      };
      applyMode();
      const makeOptions = () => ({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(String(cfg.apiKey || '').trim() ? { 'Authorization': 'Bearer ' + String(cfg.apiKey).trim() } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      try {
        let res = await safeFetch(url, makeOptions());
        let rawText = res.ok ? '' : await res.text();
        for (let attempt = 0; attempt < 3 && !res.ok && res.status === 400; attempt++) {
          let changed = false;
          if (body.thinking && /thinking|reasoning/i.test(rawText) && !/tool_choice/i.test(rawText)) {
            run.thinkingMode = false;
            delete body.thinking;
            changed = true;
            mlog('模型不支持关闭思考，已重试', 'warn');
          } else if (useTools && /tool|tool_choice|thinking/i.test(rawText)) {
            run.toolsMode = false;
            useTools = false;
            changed = true;
            mlog('模型不支持工具调用，已改用 json 模式重试', 'warn');
          } else if (body.response_format && /response_format|json_object/i.test(rawText) && /not supported|unsupported|invalid|不支持/i.test(rawText)) {
            run.jsonMode = false;
            changed = true;
            mlog('模型不支持 json 模式，已改用普通文本重试', 'warn');
          }
          if (!changed) break;
          applyMode();
          res = await safeFetch(url, makeOptions());
          rawText = res.ok ? '' : await res.text();
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${rawText.slice(0, 300)}`);

        let content = '', reasoning = '', toolArgs = null, finish = null;
        let json = null;
        if (body.stream) {
          const st = await readSse(res, opts.onDelta);
          if (st.content || st.reasoning || st.toolArgs) {
            content = st.content;
            reasoning = st.reasoning;
            toolArgs = st.toolArgs || null;
            finish = st.finish;
            if (st.usage && Number.isFinite(st.usage.total_tokens)) run.tokens += st.usage.total_tokens;
            else run.tokens += Math.round((JSON.stringify(messages).length + content.length + String(toolArgs || '').length) / 4);
          } else {
            // 服务端忽略了 stream，按普通 JSON 处理
            try { json = JSON.parse(st.raw); } catch { throw new Error('API 返回不是 JSON：' + st.raw.slice(0, 200)); }
          }
        } else {
          const text = await res.text();
          try { json = JSON.parse(text); } catch { throw new Error('API 返回不是 JSON：' + text.slice(0, 200)); }
        }

        if (json) {
          if (json.usage && Number.isFinite(json.usage.total_tokens)) run.tokens += json.usage.total_tokens;
          const choice = json.choices && json.choices[0];
          const msg = choice && choice.message;
          const toolCall = msg && msg.tool_calls && msg.tool_calls[0];
          toolArgs = toolCall && toolCall.function ? toolCall.function.arguments : null;
          content = (msg && msg.content) || '';
          reasoning = (msg && msg.reasoning_content) || '';
          finish = choice && choice.finish_reason;
        }
        if (!toolArgs && !content && !reasoning) throw new Error('API 返回为空');
        if (finish === 'length') mlog('模型输出被长度截断，本回合可能失败', 'warn');
        return { content, reasoning, toolArgs, finish };
      } finally {
        clearTimeout(timeout);
      }
    }

    function normalizeDecision(parsed, s) {
      const raw = Array.isArray(parsed && parsed.actions) ? parsed.actions : (parsed && parsed.type ? [parsed] : []);
      const actions = [];
      const toInt = (v) => {
        const n = Number(v);
        return Number.isInteger(n) ? n : NaN;
      };
      const cardIndex = (v) => {
        const n = toInt(v);
        if (Number.isInteger(n)) return n;
        if (s && Array.isArray(s.cards)) {
          const found = s.cards.find((c) => c.type === v || c.name === v);
          if (found) return found.index;
        }
        return NaN;
      };
      for (const a of raw.slice(0, 4)) {
        if (!a || typeof a !== 'object') continue;
        let type = a.type;
        if (!type && (a.card != null || a.plant != null)) type = 'plant';
        if (type === 'plant') {
          const card = cardIndex(a.card != null ? a.card : a.plant);
          const lane = toInt(a.lane != null ? a.lane : (a.row != null ? a.row : a.laneIndex));
          const column = toInt(a.column != null ? a.column : (a.col != null ? a.col : a.columnIndex));
          actions.push({ type: 'plant', card, lane, column });
        } else if (type === 'replace' || type === 'swap') {
          const card = cardIndex(a.card != null ? a.card : a.plant);
          const lane = toInt(a.lane != null ? a.lane : (a.row != null ? a.row : a.laneIndex));
          const column = toInt(a.column != null ? a.column : (a.col != null ? a.col : a.columnIndex));
          actions.push({ type: 'replace', card, lane, column });
        } else if (type === 'shovel' || type === 'plant_food') {
          const lane = toInt(a.lane != null ? a.lane : (a.row != null ? a.row : a.laneIndex));
          const column = toInt(a.column != null ? a.column : (a.col != null ? a.col : a.columnIndex));
          actions.push({ type, lane, column });
        } else if (type === 'choose_deck') {
          const list = a.plants || a.deck;
          actions.push({ type: 'choose_deck', plants: Array.isArray(list) ? list.map(String).slice(0, 10) : [], replace: !!a.replace });
        } else if (type === 'move_cart') {
          actions.push({ type: 'move_cart', cart: toInt(a.cart != null ? a.cart : a.id), direction: String(a.direction || a.dir || '').toLowerCase() });
        } else if (type === 'resume') {
          actions.push({ type: 'resume' });
        } else if (type === 'wait' || type === 'start_level' || type === 'collect_sun') {
          actions.push({ type });
        }
      }
      return {
        thought: parsed && typeof parsed.thought === 'string' ? parsed.thought.slice(0, 120) : '',
        actions,
      };
    }

    async function llmDecide(s) {
      if (!cfg.baseUrl || !cfg.model) throw new Error('请先填写 API Base URL 和模型名');
      if (!String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) throw new Error('请先填写 API Key');

      const baseMessages = [{ role: 'system', content: systemPrompt() }];
      if (run.history.length) baseMessages.push(...run.history);
      baseMessages.push({ role: 'user', content: stateForPrompt(s) });

      const streamOn = cfg.stream !== false && run.streamMode !== false;
      const onDelta = (t) => {
        if (!t) return;
        const text = t.reasoning || t.content || t.toolArgs || '';
        let live = '';
        if (t.reasoning) live = t.reasoning;
        else {
          const m = /"thought"\s*:\s*"([^"\\]*)/.exec(text);
          live = m ? m[1] : (t.content ? text : '');
        }
        live = String(live || '').replace(/\\n|\n/g, ' ').slice(-160);
        if (live && live !== think.live) {
          think.live = live;
          thinkRender();
        }
      };

      let parsed = null;
      try {
        const r = await chatCompletion(baseMessages, { tools: true, stream: streamOn, onDelta });
        const raw = r.toolArgs || r.content;
        if (raw) parsed = parseDecision(raw);
      } catch (e) {
        mlog('模型请求失败：' + (e && e.message ? e.message : e), 'warn');
        if (!run.active) return { thought: '', actions: [{ type: 'wait' }] };
        if (streamOn) {
          run.streamMode = false;
          mlog('流式请求失败，本局改用普通请求（重新开始可再试流式）', 'warn');
          try {
            const r2 = await chatCompletion(baseMessages, { tools: true });
            const raw2 = r2.toolArgs || r2.content;
            if (raw2) parsed = parseDecision(raw2);
          } catch (e2) {
            mlog('模型重试失败：' + (e2 && e2.message ? e2.message : e2), 'warn');
          }
        }
      }
      think.live = '';

      if (!parsed) {
        if (!run.active) return { thought: '', actions: [{ type: 'wait' }] };
        const retryMessages = [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: stateForPrompt(s) + '\n\n请只输出一个 json 对象：{"thought":"...","actions":[{"type":"plant","card":0,"lane":2,"column":1}]}。不要解释，不要 markdown。' },
        ];
        try {
          const r2 = await chatCompletion(retryMessages, { tools: false });
          if (r2.content) parsed = parseDecision(r2.content);
        } catch (e) {
          mlog('模型重试失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }

      if (!parsed) {
        mlog('模型连续输出无效，本回合改用本地策略', 'warn');
        return { thought: '模型输出无效，本地策略接管本回合', actions: localBrain(s).actions, fallback: true };
      }

      const decision = normalizeDecision(parsed, s);
      if (!decision.actions.length) decision.actions = [{ type: 'wait' }];
      run.history.push({ role: 'assistant', content: JSON.stringify(decision) });
      if (run.history.length > 2) run.history = run.history.slice(-2);
      return decision;
    }

    function executeActions(actions) {
      const results = [];
      for (const a of actions.slice(0, 6)) {
        if (!a || typeof a !== 'object') continue;
        let r = null;
        try {
          switch (a.type) {
            case 'plant': r = plant(Number(a.card), Number(a.lane), Number(a.column)); break;
            case 'shovel': r = shovel(Number(a.lane), Number(a.column), a.expect || a.expectType); break;
            case 'replace': r = replacePlant(Number(a.card), Number(a.lane), Number(a.column)); break;
            case 'plant_food': r = plantFood(Number(a.lane), Number(a.column)); break;
            case 'collect_sun': r = collectSuns(); break;
            case 'choose_deck': r = autoDeckWith(a.plants, !!a.replace); break;
            case 'move_cart': r = moveCart(a.cart != null ? a.cart : a.id, a.direction || a.dir); break;
            case 'resume': r = resume(); break;
            case 'start_level': r = startLevel(); break;
            case 'dismiss_objective': r = dismissObjective(); break;
            case 'wait': r = { ok: true, detail: '等待' }; break;
            default: r = { ok: false, reason: '未知动作 ' + a.type };
          }
        } catch (e) { r = { ok: false, reason: String(e && e.message ? e.message : e) }; }
        results.push({ action: a, result: r });
      }
      return results;
    }

    // ───────────────────────── 批量 / 条件等待 ─────────────────────────

    function compactState(s) {
      return {
        phase: s.phase,
        sun: s.sun,
        plantFood: s.plantFood,
        wave: s.level && s.level.wave,
        plants: (s.plants || []).length,
        zombies: (s.zombies || []).length,
        tasks: (s.tasks || []).map((t) => ({
          tip: t.tip, count: t.count, completed: t.completed,
          failed: t.failed, timeLeft: t.timeLeft, urgent: t.urgent,
        })),
      };
    }

    function condSatisfied(s, cond) {
      const c = String(cond || '').trim();
      let m;
      if (!c) return { ok: false, reason: '空条件' };
      if ((m = /^sun\s*>=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(s.sun) >= Number(m[1]) };
      if ((m = /^sun\s*<=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(s.sun) <= Number(m[1]) };
      if ((m = /^sun\s*>\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(s.sun) > Number(m[1]) };
      if ((m = /^sun\s*<\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(s.sun) < Number(m[1]) };
      if ((m = /^plantfood\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: Number(s.plantFood || 0) >= Number(m[1]) };
      if ((m = /^card_ready\s*:\s*(.+)$/i.exec(c))) {
        const v = m[1].trim();
        const list = (s.cards || []).concat((s.conveyor && s.conveyor.cards) || []);
        const card = list.find((x) => x.type === v) || list[Number(v)];
        return { ok: true, hit: !!(card && card.ready) };
      }
      if (/^conveyor_ready$/i.test(c)) {
        return { ok: true, hit: !!(s.conveyor && s.conveyor.enabled && s.conveyor.cards && s.conveyor.cards.length) };
      }
      if ((m = /^zombie_in_lane\s*:\s*(\d+)$/i.exec(c))) {
        return { ok: true, hit: (s.zombies || []).some((z) => Number(z.lane) === Number(m[1])) };
      }
      if ((m = /^cart_ready\s*:\s*(\d+)$/i.exec(c))) {
        const cart = (s.carts || [])[Number(m[1])];
        return { ok: true, hit: !!(cart && (cart.canUp || cart.canDown)) };
      }
      if ((m = /^zombie_near\s*:\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) {
        return { ok: true, hit: (s.zombies || []).some((z) => Number(z.column) <= Number(m[1])) };
      }
      if (/^tasks_ready$/i.test(c)) {
        const list = s.tasks || [];
        return { ok: true, hit: list.length > 0 && list.every((t) => t.completed || t.failed) };
      }
      if ((m = /^phase\s*:\s*(\w+)$/i.exec(c))) return { ok: true, hit: s.phase === m[1].toLowerCase() };
      if ((m = /^plants\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: (s.plants || []).length >= Number(m[1]) };
      return { ok: false, reason: '无法识别的条件：' + c };
    }

    async function waitUntil(cond, timeoutMs) {
      const timeout = clamp(Number(timeoutMs) || 10, 1, 60) * 1000;
      const started = Date.now();
      let last = null;
      while (Date.now() - started <= timeout) {
        const s = safeSnapshot();
        last = s;
        if (!s.ok) { await new Promise((r) => setTimeout(r, 200)); continue; }
        const r = condSatisfied(s, cond);
        if (!r.ok) return { ok: false, code: 'BAD_CONDITION', retryable: false, condition: String(cond), message: r.reason };
        if (r.hit) {
          return {
            ok: true, satisfied: true, condition: String(cond),
            elapsed: Math.round((Date.now() - started) / 100) / 10,
            state: compactState(s),
          };
        }
        await new Promise((r2) => setTimeout(r2, 200));
      }
      return {
        ok: false, code: 'TIMEOUT', satisfied: false, retryable: true,
        condition: String(cond), elapsed: Math.round((Date.now() - started) / 100) / 10,
        state: last && last.ok ? compactState(last) : null,
      };
    }



    function start() {
      if (run && run.active) return;
      if (!cfg.localBrain && !String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) {
        mlog('请先填写 API Key，或勾选“本地策略”体验', 'warn');
        toast('请先填写 API Key，或勾选本地策略', 'warning');
        setCollapsed(false);
        el.key && el.key.focus();
        return;
      }
      clearError();
      run = { active: true, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, startedAt: Date.now(), blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true, streamMode: true, ticking: false, forceTick: false, objectiveMissions: [], planDeckDone: false, planDeckRetried: false };
      thinkReset();
      setStage('init');
      if (currentPlan) thinkSetPlan(currentPlan);
      el.start && (el.start.disabled = true);
      el.stop && (el.stop.disabled = false);
      setCollapsed(true);
      mlog(`开始操控${cfg.localBrain ? '（本地策略）' : `（${cfg.model}）`}`);
      toast('AI 开始接管本场战斗', 'success');
      tick();
    }

    function stop(reason) {
      if (!run) return;
      run.active = false;
      if (run.timer) clearTimeout(run.timer);
      if (run.controller) { try { run.controller.abort(); } catch { /* ignore */ } }
      think.stage = '已停止';
      think.stageAt = 0;
      think.live = '';
      thinkRender();
      if (el.start) el.start.disabled = false;
      if (el.stop) el.stop.disabled = true;
      mlog(`已停止：${reason || '完成'}`, 'warn');
      updateStatus();
    }

    function schedule(ms) {
      if (!run || !run.active) return;
      if (run.timer) clearTimeout(run.timer);
      run.timer = setTimeout(tick, ms);
    }

    async function tick() {
      if (disposed || !run || !run.active) return;
      if (run.ticking) return;
      if (run.turns >= cfg.maxTurns) { stop(`达到最大回合数 ${cfg.maxTurns}`); return; }
      run.ticking = true;
      let stage = setStage('init');

      try {
        stage = setStage('snapshot');
        let s = safeSnapshot();
        if (!s.ok) { mlog(s.reason || '等待游戏', 'warn'); schedule(1800); return; }
        syncLevelHint(s);

        if (run.blocked && run.blocked.size) {
          const now = Date.now();
          for (const [k, until] of run.blocked) if (until <= now) run.blocked.delete(k);
        }

        stage = setStage('collect');
        if (cfg.autoSun) {
          const c = collectPickups();
          if (c.count) { mlog(`自动收取：${pickupLabel(c.kinds)}`, 'ok'); s = safeSnapshot(); }
        }

        if (s.phase === 'menu' || s.phase === 'worldmap' || s.phase === 'other' || s.phase === 'loading') {
          schedule(2200);
          return;
        }

        if (s.phase === 'won' || s.phase === 'lost') {
          if (s.phase === 'lost') {
            const losses = (s.recentLosses || []).slice(-5)
              .map((l) => `第${l.lane + 1}排c${l.column} ${PLANT_CN[l.type] || l.type}`).join('；') || '无';
            mlog(`❌ 失败复盘：任务 ${taskSummary(s) || '无'}；场上植物 ${s.plants.length} 株；最近损失 ${losses}；卡组 ${s.cards.map((c) => c.type).join(',') || '无'}`, 'warn');
            if (currentPlan && currentPlan.text) mlog('本局计划：' + currentPlan.text, 'warn');
          }
          stop(s.phase === 'won' ? '关卡胜利 🎉' : '关卡失败');
          toast(s.phase === 'won' ? 'AI 打赢了本关 🎉' : '本关失败', s.phase === 'won' ? 'success' : 'warning');
          return;
        }

        const taskLine = taskSummary(s);
        if (taskLine && taskLine !== run.lastTaskSummary) {
          run.lastTaskSummary = taskLine;
          mlog('本关任务：' + taskLine);
        }

        // 自动换卡兜底：模型没理会候选时，替它执行“明显该换”的一格（6 秒最多一次）。
        if (cfg.autoShovel !== false && s.phase === 'running' && Date.now() - (run.lastAutoShovelAt || 0) > 6000) {
          const act = pickAutoShovel(s);
          if (act) {
            const why = act.why;
            delete act.why;
            run.lastAutoShovelAt = Date.now();
            const rr = executeActions([act]);
            const ok = !!(rr[0] && rr[0].result && rr[0].result.ok);
            mlog(ok ? `🔧 自动换卡：${why}` : `⚠️ 自动换卡失败：${why}`, ok ? 'ok' : 'warn');
            if (ok) {
              think.history.unshift({ text: `🔧 自动换卡 ${why}` });
              if (think.history.length > 8) think.history.length = 8;
              s = safeSnapshot();
            }
          }
        }

        if (s.phase === 'objective') {
          stage = setStage('objective');
          const d = dismissObjective();
          if (d.ok) mlog(d.detail, 'ok');
          else if (d.reason !== run.lastPrepReason) { mlog('关卡目标界面：' + d.reason, 'warn'); run.lastPrepReason = d.reason; }
          schedule(1000);
          return;
        }

        // 开局先想对策：等选卡界面有可选卡（或传送带/中途接管）再制定，
        // 确保计划能同时看到“可用植物 + 预计僵尸 + 任务 + 世界机制”。
        if (s.phase === 'preparing' || s.phase === 'running') {
          stage = setStage('plan');
          const planKey = levelKeyOf(s);
          const hasSeed = !!(s.seedSelection && s.seedSelection.available && s.seedSelection.available.length);
          const conveyorMode = !!(s.conveyor && s.conveyor.enabled);
          let prepOk = true;
          if (s.phase === 'preparing') {
            const cg = findComps();
            prepOk = !!(cg && (prepReady(cg.map.Cards, cg.map.levelController)
              || isConveyorMode(getConveyor(cg), cg.map.Cards)));
          }
          const readyToPlan = s.phase === 'running' || ((hasSeed || conveyorMode) && prepOk);
          if (readyToPlan && (!currentPlan || currentPlan.levelKey !== planKey)) {
            await makePlan(s);
            if (!run.active) return;
            s = safeSnapshot();
            if (!s.ok) { schedule(1500); return; }
          }
        }

        if (s.phase === 'preparing') {
          stage = setStage('prep');
          const ctxg = findComps();
          const pCards = ctxg && ctxg.map.Cards;
          const pLvl = ctxg && ctxg.map.levelController;
          const pCv = ctxg && getConveyor(ctxg);
          if (!prepReady(pCards, pLvl) && !isConveyorMode(pCv, pCards)) {
            if (run.lastPrepReason !== '选卡界面还没准备好') {
              mlog('等待选卡界面就绪…', 'warn');
              run.lastPrepReason = '选卡界面还没准备好';
            }
            schedule(1200);
            return;
          }
          // 目标说明阶段可能还没有可选卡列表；到选卡界面后补一次“按卡组重定计划”。
          if (cfg.autoDeck && currentPlan && !(currentPlan.deck && currentPlan.deck.length)
            && s.seedSelection && Array.isArray(s.seedSelection.available) && s.seedSelection.available.length
            && !run.planDeckRetried && !(s.conveyor && s.conveyor.enabled)) {
            run.planDeckRetried = true;
            stage = setStage('plan');
            await makePlan(s, { force: true });
            if (!run.active) return;
            s = safeSnapshot();
          }
          if (cfg.autoDeck && !run.planDeckDone) {
            const planned = (currentPlan && currentPlan.deck && currentPlan.deck.length) ? currentPlan.deck : null;
            const d = planned ? autoDeckWith(planned, true) : autoDeck();
            if (d.ok) {
              run.planDeckDone = true;
              if (planned) {
                mlog('按作战计划选卡：' + (d.deck || d.applied || []).join(', ')
                  + (d.skipped && d.skipped.length ? `（跳过 ${d.skipped.join(',')}）` : ''), 'ok');
              } else if (d.detail) {
                mlog(d.detail, 'ok');
              }
              s = safeSnapshot();
            } else if (d.code === 'PREP_NOT_READY') {
              // 选卡 UI 还没就绪，下一轮再试
            } else {
              run.planDeckDone = true;
              if (planned) mlog('按计划选卡失败：' + (d.reason || '未知原因') + '，改用游戏推荐卡组', 'warn');
              else if (d.reason && d.reason !== run.lastPrepReason) { mlog(d.reason, 'warn'); run.lastPrepReason = d.reason; }
              const f = autoDeck();
              if (f.ok && f.detail) mlog(f.detail, 'ok');
              s = safeSnapshot();
            }
          }
          if (s.phase === 'preparing') {
            if (cfg.autoDeck) {
              const st = startLevel();
              if (st.ok) mlog(st.detail || '开始战斗', 'ok');
              else if (st.reason && st.reason !== run.lastPrepReason) {
                mlog('开局失败：' + st.reason, 'warn');
                run.lastPrepReason = st.reason;
              }
            } else {
              mlog('等待手动点“一起摇滚吧”，或勾选自动选卡开局', 'warn');
            }
            schedule(1400);
            return;
          }
        }

        const key = decisionKey(s);
        const now = Date.now();
        if (key === run.lastKey && now - run.lastAt < cfg.heartbeat) { schedule(500); return; }
        run.lastKey = key;
        run.lastAt = now;
        run.turns++;

        think.board = boardLines(s).join('\n');
        stage = setStage('decide');
        think.turn = run.turns;
        think.thought = '';
        think.live = '';
        think.acts = [];
        think.results = [];
        const decision = cfg.localBrain ? localBrain(s) : await llmDecide(s);
        if (!run.active) return;
        thinkSetDecision(decision);
        if (decision.thought) mlog(`🧠 ${decision.thought}`);
        stage = setStage('execute');
        const results = executeActions(decision.actions);
        thinkSetResults(results);
        for (const r of results) {
          if (r.action.type === 'wait') continue;
          if (r.result && r.result.ok) mlog(`✅ ${r.result.detail || r.action.type}`, 'ok');
          else {
            mlog(`⚠️ ${r.action.type}${r.result && r.result.code ? '[' + r.result.code + ']' : ''}: ${(r.result && r.result.reason) || '失败'}${altText(r.result && r.result.alts)}`, 'warn');
          }
        }
        const resultLines = results
          .filter((r) => r.action.type !== 'wait')
          .map((r) => (r.result && r.result.ok
            ? `${r.action.type} ${r.result.detail || ''} 成功`
            : `${r.action.type} 失败${r.result && r.result.code ? '[' + r.result.code + ']' : ''}：${(r.result && (r.result.reason || r.result.code)) || ''}${altText(r.result && r.result.alts)}`));
        run.lastResults = resultLines.slice(-3);
        updateStatus();
        const acted = results.some((r) => r.action.type !== 'wait' && r.result && r.result.ok);
        schedule(acted ? Math.min(cfg.interval, 900) : cfg.interval);
      } catch (e) {
        if (disposed || !run || !run.active) return;
        const msg = e && e.message ? e.message : String(e);
        mlog(`运行错误[${stage}]：` + msg, 'err');
        if (run.lastToastError !== msg) {
          run.lastToastError = msg;
          toast('AI 错误：' + msg.slice(0, 80), 'error');
        }
        schedule(2600);
      } finally {
        if (run) {
          run.ticking = false;
          if (run.active && run.forceTick) {
            run.forceTick = false;
            schedule(120);
          }
        }
      }
    }

    // ───────────────────────── 思考浮窗 ─────────────────────────

    const think = {
      stage: '待机', stageAt: 0,
      thought: '', live: '', plan: '', board: '',
      acts: [], results: [], history: [], turn: 0,
    };

    const STAGE_TEXT = {
      init: '启动',
      snapshot: '读取战场',
      collect: '收取掉落',
      plan: '制定对策',
      objective: '关任务说明',
      prep: '选卡/开局',
      decide: '模型思考',
      execute: '执行动作',
    };

    function thinkReset() {
      think.stage = '待机';
      think.stageAt = 0;
      think.thought = '';
      think.live = '';
      think.board = '';
      think.acts = [];
      think.results = [];
      think.history = [];
      think.turn = 0;
      thinkRender();
    }

    function setStage(name) {
      think.stage = STAGE_TEXT[name] || String(name || '');
      think.stageAt = Date.now();
      thinkRender();
      return name;
    }

    function actionText(a) {
      if (!a) return '';
      const pos = `${a.lane},${a.column}`;
      switch (a.type) {
        case 'plant': return `种卡#${a.card} → ${pos}`;
        case 'replace': return `换卡#${a.card} → ${pos}`;
        case 'shovel': return `铲 ${pos}`;
        case 'plant_food': return `能量豆 → ${pos}`;
        case 'move_cart': return `矿车#${a.cart} ${a.direction || ''}`;
        case 'choose_deck': return `选卡 ${(a.plants || []).join(',')}`;
        case 'start_level': return '开始战斗';
        case 'dismiss_objective': return '关闭任务说明';
        case 'resume': return '继续游戏';
        case 'wait': return '等待';
        default: return a.type || '动作';
      }
    }

    function thinkSetPlan(plan) {
      think.plan = (plan && (plan.text || plan.goal)) || '';
      thinkRender();
    }

    // 本关临时策略：只存在内存里，换关自动清空；发送时立即触发一次决策。
    function setLevelHint(text, opts = {}) {
      const v = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      levelHint = v;
      if (v) {
        levelHintSetting = true;
        try {
          const s = safeSnapshot();
          levelHintKey = s && s.ok ? levelKeyOf(s) : '';
        } finally {
          levelHintSetting = false;
        }
      } else {
        levelHintKey = '';
      }
      if (el.thinkHint) el.thinkHint.textContent = v ? '👤 ' + v : '';
      if (v) {
        think.history.unshift({ text: '👤 ' + v });
        if (think.history.length > 8) think.history.length = 8;
        mlog('本关临时策略：' + v, 'ok');
      } else {
        mlog('已清除本关临时策略');
      }
      const immediate = opts.immediate !== false;
      if (immediate && run && run.active) {
        run.lastKey = '';
        run.lastAt = 0;
        if (run.ticking) run.forceTick = true;
        else schedule(0);
        toast(v ? '已加入本关策略，立即重新决策' : '已清除本关策略，立即重新决策', 'success');
      } else if (v) {
        toast('已记录本关临时策略（开始操控后生效）', 'success');
      }
      thinkRender();
    }

    function syncLevelHint(s) {
      if (!levelHint || levelHintSetting) return;
      const key = levelKeyOf(s);
      if (levelHintKey && key !== levelHintKey) {
        levelHint = '';
        levelHintKey = '';
        if (el.thinkHint) el.thinkHint.textContent = '';
        mlog('已进入新关卡，清空上一关的临时策略', 'warn');
      } else if (!levelHintKey) {
        levelHintKey = key;
      }
    }

    function thinkSetDecision(decision) {
      think.live = '';
      think.thought = (decision && decision.thought) || '';
      think.acts = ((decision && decision.actions) || []).map(actionText);
      think.results = [];
      think.stage = '执行动作';
      think.stageAt = Date.now();
      thinkRender();
    }

    function thinkSetResults(results) {
      think.results = (results || []).map((r) => {
        const ok = !!(r.result && r.result.ok);
        return {
          ok,
          detail: r.result && r.result.detail,
          reason: r.result && (r.result.reason || r.result.code),
        };
      });
      if (think.thought) {
        think.history.unshift({ text: `第${think.turn}回合 · ${think.thought}` });
        if (think.history.length > 8) think.history.length = 8;
      }
      thinkRender();
    }

    function thinkRender() {
      if (!el.think || !el.thinkStage) return;
      const running = !!(run && run.active);
      const elapsed = think.stageAt ? (Date.now() - think.stageAt) / 1000 : 0;
      el.thinkStage.textContent = think.stage + (running && think.stageAt ? ` · ${elapsed.toFixed(1)}s` : '');
      el.thinkStage.classList.toggle('long', running && elapsed > 6);

      if (think.live) {
        el.thinkThought.classList.add('live');
        el.thinkThought.textContent = '💭 ' + think.live;
      } else {
        el.thinkThought.classList.remove('live');
        el.thinkThought.textContent = think.thought
          || (running ? '…' : '开始操控后，这里会实时显示 AI 的判断、动作和结果。');
      }

      el.thinkActs.innerHTML = think.acts.map((a, i) => {
        const r = think.results[i];
        const cls = r ? (r.ok ? 'ok' : 'bad') : '';
        const mark = r ? (r.ok ? '✅' : '⚠️') : '·';
        const detail = r ? (r.ok ? (r.detail || '') : (r.reason || '失败')) : '';
        return `<div class="${cls}">${escapeHtml(mark + ' ' + a + (detail ? ' — ' + detail : ''))}</div>`;
      }).join('');

      el.thinkPlan.textContent = think.plan ? '📋 ' + think.plan : '';
      if (el.thinkBoard) el.thinkBoard.textContent = think.board || '';
      el.thinkHistory.innerHTML = think.history
        .map((h) => `<div>${escapeHtml(h.text)}</div>`).join('');
    }

    // ───────────────────────── 状态 / 连接测试 ─────────────────────────

    function phaseText(phase) {
      return ({ menu: '主菜单', worldmap: '世界地图', loading: '加载中', objective: '关卡任务说明', preparing: '选卡/准备', running: '战斗中', won: '已胜利', lost: '已失败', other: '其他场景' })[phase] || phase;
    }

    function statusLine() {
      const s = safeSnapshot();
      if (!s.ok) return '待机 · ' + (s.reason || '等待游戏');
      const base = `${s.level.name || s.scene || '未知'} · ${phaseText(s.phase)} · 阳光${s.sun ?? '—'} · 植物${s.plants.length} · 僵尸${s.zombies.length}`;
      const task = taskSummary(s);
      if (task) return `${base} · 任务：${task}`;
      if (run && run.active) return `运行中 · ${base} · 回合${run.turns} · tokens${run.tokens}`;
      return '待机 · ' + base;
    }

    function updateStatus() {
      if (!el.status) return;
      const s = safeSnapshot();
      if (!s.ok) {
        el.status.innerHTML = `待机 · ${escapeHtml(s.reason || '等待游戏')}`;
        el.pill.classList.add('idle');
        el.pillText.textContent = 'AI 待机（F8）';
        return;
      }
      if (run && run.active) {
        const danger = s.zombies.filter((z) => z.column <= 3).length;
        const task = taskSummary(s);
        el.status.innerHTML =
          `<b>${escapeHtml(s.level.name || s.scene || '未知关卡')}</b> · ${phaseText(s.phase)}<br>` +
          `阳光 <b>${s.sun ?? '—'}</b> · 能量豆 <b>${s.plantFood ?? 0}</b> · 波次 <b>${s.level.wave}/${s.level.waves || '?'}</b> · 植物 <b>${s.plants.length}</b> · 僵尸 <b>${s.zombies.length}</b>` +
          (danger ? ` · <span style="color:#ff9b9b">近场 ${danger}</span>` : '') +
          (task ? `<br><span class="hint">任务：${escapeHtml(task)}</span>` : '') +
          `<br><span class="hint">回合 ${run.turns} · tokens ${run.tokens}${currentPlan ? ' · 计划✓' : ''}</span>`;
        el.pill.classList.remove('idle');
        el.pillText.textContent = `AI ${s.sun ?? '—'}☀ ⚡${s.plantFood ?? 0} · ${s.level.wave}/${s.level.waves || '?'}波`;
      } else {
        const task = taskSummary(s);
        el.status.innerHTML =
          `待机 · <b>${escapeHtml(s.level.name || s.scene || '未知场景')}</b> · ${phaseText(s.phase)}<br>` +
          `阳光 <b>${s.sun ?? '—'}</b> · 能量豆 <b>${s.plantFood ?? 0}</b> · 植物 <b>${s.plants.length}</b> · 僵尸 <b>${s.zombies.length}</b>` +
          (task ? `<br><span class="hint">任务：${escapeHtml(task)}</span>` : '');
        el.pill.classList.add('idle');
        el.pillText.textContent = 'AI 待机（F8）';
      }
    }

    async function testConnection() {
      if (run && run.active) return mlog('AI 正在运行，停止后再测试连接', 'warn');
      if (!cfg.baseUrl || !cfg.model) return mlog('请先填写 Base URL 和模型名', 'warn');
      if (!String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) return mlog('请先填写 API Key', 'warn');
      clearError();
      mlog(`测试连接：${normalizeBaseUrl(cfg.baseUrl)} / ${cfg.model}`);
      if (!run) run = { active: false, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true, streamMode: true, ticking: false, forceTick: false };
      try {
        const r = await chatCompletion([
          { role: 'system', content: '你是一个测试助手。请只输出一个 json 对象：{"ok":"OK"}。不要解释。' },
          { role: 'user', content: 'ping' },
        ]);
        const text = r.toolArgs || r.content || r.reasoning || '';
        clearError();
        mlog('连接成功：' + text.slice(0, 80), 'ok');
        toast('模型连接成功', 'success');
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        mlog('连接失败：' + msg, 'err');
        toast('连接失败：' + msg.slice(0, 70), 'error');
        if (/Failed to fetch|TypeError|CORS|CSP|Refused/i.test(msg)) {
          mlog('这通常是 CORS/CSP 或网络问题：可换 OpenRouter/中转 Base URL，或把这段日志发给我。', 'warn');
        }
        if (/401|403|Unauthorized|invalid.*key/i.test(msg)) {
          mlog('Key 可能无效或没有该模型权限；确认 Key 没有多余空格，并确认模型名。', 'warn');
        }
        if (/400|404|model/i.test(msg)) {
          mlog('模型名/路径可能不对：DeepSeek 试 deepseek-flash 或 deepseek-v4-pro，Base URL 用 https://api.deepseek.com/v1。', 'warn');
        }
      }
    }

    async function copyLog() {
      const text = logLines.length
        ? logLines.map((l) => `[${l.time}] ${l.message}`).join('\n')
        : '(暂无日志)';
      try {
        await getWin().navigator.clipboard.writeText(text);
        mlog('日志已复制到剪贴板', 'ok');
      } catch {
        try {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const a = getDoc().createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'pvz-ai-log.txt';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          mlog('日志已下载为 pvz-ai-log.txt', 'ok');
        } catch (e) {
          mlog('复制日志失败：' + (e && e.message ? e.message : e), 'err');
        }
      }
    }

    async function exportSnapshot() {
      const s = safeSnapshot();
      const text = JSON.stringify(s, null, 2);
      try {
        await getWin().navigator.clipboard.writeText(text);
        mlog('状态已复制到剪贴板', 'ok');
      } catch {
        try {
          const blob = new Blob([text], { type: 'application/json' });
          const a = getDoc().createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'pvz-ai-state.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          mlog('状态已下载为 pvz-ai-state.json', 'ok');
        } catch (e) { mlog('导出失败：' + e, 'err'); }
      }
      try { ctx.log.info('[AI草坪] snapshot ' + text); } catch { /* ignore */ }
    }

    // ───────────────────────── 官方面板（浮窗失败时的兜底） ─────────────────────────

    function defineOfficialPanel() {
      try {
        ctx.controls.definePanel({
          title: 'AI 草坪指挥官',
          description: '浮窗被遮挡时，可在这里填写设置并开始/停止。建议优先使用右下角浮窗。',
          groups: [
            {
              title: '模型',
              items: [
                { type: 'text', key: 'baseUrl', label: 'Base URL（含 /v1）', getValue: () => cfg.baseUrl, setValue: (v) => { cfg.baseUrl = String(v || ''); saveCfg(); } },
                { type: 'text', key: 'model', label: '模型名', getValue: () => cfg.model, setValue: (v) => { cfg.model = String(v || ''); saveCfg(); } },
                { type: 'text', key: 'apiKey', label: 'API Key', getValue: () => cfg.apiKey, setValue: (v) => { cfg.apiKey = String(v || ''); saveCfg(); } },
                { type: 'toggle', key: 'localBrain', label: '本地策略（不调用模型）', getValue: () => cfg.localBrain, setValue: (v) => { cfg.localBrain = !!v; saveCfg(); } },
              ],
            },
            {
              title: '操控',
              items: [
                { type: 'toggle', key: 'autoSun', label: '自动收阳光/能量豆', getValue: () => cfg.autoSun, setValue: (v) => { cfg.autoSun = !!v; saveCfg(); } },
                { type: 'toggle', key: 'autoDeck', label: '自动选卡开局', getValue: () => cfg.autoDeck, setValue: (v) => { cfg.autoDeck = !!v; saveCfg(); } },
                { type: 'action', key: 'start', label: '开始操控', onClick: () => start() },
                { type: 'action', key: 'stop', label: '停止', onClick: () => stop('手动停止') },
                { type: 'action', key: 'test', label: '测试连接', onClick: () => testConnection() },
                { type: 'readonly', key: 'status', label: '状态', getValue: () => statusLine() },
              ],
            },
          ],
        });
      } catch (e) {
        mlog('官方面板注册失败（不影响浮窗）：' + (e && e.message ? e.message : e), 'warn');
      }
    }

    // ───────────────────────── 生命周期 ─────────────────────────

    function onKeyDown(e) {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'F10') {
        e.preventDefault();
        cfg.showThought = !cfg.showThought;
        if (host) host.classList.toggle('think-off', !cfg.showThought);
        if (el.showthought) el.showthought.checked = cfg.showThought;
        saveCfg();
        toast(cfg.showThought ? '思考浮窗已显示' : '思考浮窗已隐藏', 'info');
        return;
      }
      if (e.key !== 'F8') return;
      e.preventDefault();
      if (run && run.active) stop('热键停止');
      else start();
    }

    function onCspViolation(e) {
      const detail = `${e.violatedDirective || e.effectiveDirective || ''} ${e.blockedURI || ''}`.trim();
      mlog('CSP 阻止：' + (detail || '未知资源'), 'err');
    }

    function boot() {
      if (disposed) return;
      const doc = getDoc();
      const win = getWin();
      if (!doc.body) { setTimeout(boot, 300); return; }
      buildUI();
      loadStrategyFile();
      defineOfficialPanel();
      win.addEventListener('keydown', onKeyDown, true);
      doc.addEventListener('fullscreenchange', mountHost);
      doc.addEventListener('securitypolicyviolation', onCspViolation, true);
      if (win !== window) window.addEventListener('keydown', onKeyDown, true);
      if (!autoCollectTimer) {
        autoCollectTimer = setInterval(() => {
          if (disposed || !cfg.autoSun) return;
          const ctxg = findComps();
          if (!ctxg || !ctxg.map.SunCount) return;
          const c = collectPickups();
          if (!c.count) return;
          const hasFood = !!(c.kinds.plantFood || c.kinds.plantfood);
          if (hasFood || Date.now() - lastPickupLog > 8000) {
            mlog(`自动收取：${pickupLabel(c.kinds)}`, 'ok');
            lastPickupLog = Date.now();
          }
        }, 1100);
      }
      mlog(`AI 草坪指挥官 v${VERSION} 已加载（游戏 ${platformVersion}）`);
      try {
        const tauriKeys = win.__TAURI__ ? Object.keys(win.__TAURI__).join(',') : 'none';
        mlog(`环境：origin=${win.location ? win.location.origin : '?'} · tauri=${tauriKeys} · gpNext=${typeof win.gpNext}`);
        const metas = [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.getAttribute('http-equiv') || ''));
        if (metas.length) mlog('CSP meta：' + metas.map((m) => m.content).join(' | ').slice(0, 500), 'warn');
      } catch { /* ignore */ }
      if (!getCc()) mlog('等待 Cocos 引擎初始化…', 'warn');
      toast('AI 草坪指挥官已加载：填好 Key 后点浮窗“开始操控”，或按 F8', 'success');

      const ready = setInterval(() => {
        if (disposed) { clearInterval(ready); return; }
        const cc = getCc();
        if (cc && cc.director && cc.director.getScene()) {
          clearInterval(ready);
          mlog('已连接游戏引擎，等待进入关卡');
          updateStatus();
        }
      }, 1000);

      const api = {
        version: VERSION,
        platform: platformVersion,
        snapshot: safeSnapshot,
        collectSuns, collectPickups, plant, shovel, replacePlant, plantFood, autoDeck, autoDeckWith, startLevel, dismissObjective, start, stop,
        moveCart, resume,
        execute: executeActions,
        waitUntil,
        briefing: briefingValue,
        plan: planValue,
        setPlan,
        makePlan: async () => {
          const s = safeSnapshot();
          if (!s.ok) return { ok: false, reason: s.reason };
          const prev = run;
          if (!run) {
            run = { active: false, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true, streamMode: true, ticking: false, forceTick: false, objectiveMissions: [], planDeckDone: false };
          }
          try { return { ok: true, plan: await makePlan(s, { force: true }) }; } finally { if (!prev) run = prev; }
        },
        terrain: (lane, column) => {
          const ctxg = findComps();
          const C = ctxg && ctxg.map.Square && ctxg.map.Square.constructor;
          return C ? cellTerrain(C, Number(lane), Number(column)) : null;
        },
        knowledge: { plant: plantKb, zombie: zombieKb },
        normalizeDecision,
        testDecision: async (s) => {
          const prev = run;
          run = { active: false, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true, streamMode: true, ticking: false, forceTick: false };
          try { return await llmDecide(s || safeSnapshot()); } finally { run = prev; }
        },
        get rules() { return systemPrompt(); },
        prompt: (s) => stateForPrompt(s || safeSnapshot()),
        get config() { return cfg; },
        setLocalBrain(v) { cfg.localBrain = !!v; if (el.local) el.local.checked = !!v; saveCfg(); },
        log: mlog,
        ctx,
      };
      window.PvzAI = api;
      if (win !== window) { try { win.PvzAI = api; } catch { /* ignore */ } }
      try { console.log('%c[PvZ AI] v' + VERSION + ' 已注入，控制台可用 window.PvzAI', 'color:#7ed957'); } catch { /* ignore */ }
    }

    // 启动
    const bootDoc = getDoc();
    if (bootDoc.readyState === 'loading') bootDoc.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();

    return function cleanup() {
      disposed = true;
      stop('模组已停用');
      if (uiTimer) clearInterval(uiTimer);
      if (thinkTimer) clearInterval(thinkTimer);
      if (autoCollectTimer) clearInterval(autoCollectTimer);
      const win = getWin();
      win.removeEventListener('keydown', onKeyDown, true);
      if (win !== window) window.removeEventListener('keydown', onKeyDown, true);
      try { getDoc().removeEventListener('fullscreenchange', mountHost); } catch { /* ignore */ }
      try { getDoc().removeEventListener('securitypolicyviolation', onCspViolation, true); } catch { /* ignore */ }
      if (host) host.remove();
      host = null;
      try { ctx.controls.clear(); } catch { /* ignore */ }
      try { delete window.PvzAI; } catch { window.PvzAI = undefined; }
      try { if (win !== window) delete win.PvzAI; } catch { /* ignore */ }
    };
  },
};

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
