/**
 * 世界事实：只列"这个世界有什么机制"，不写"该怎么打"。
 * 运行时以 snapshot.mechanicFacts / levelScript / 实际地形为准。
 */
import { TAG_CAPABILITIES } from './tags.js';

export const WORLD_FACTS = [
  {
    key: 'egypt', re: /埃及|egypt/i, name: '神秘埃及',
    mechanics: ['墓碑占格并阻挡直线弹道', '法老、太阳神、探险家等特殊僵尸'],
    zombies: ['mummy', 'mummy_armor1', 'mummy_armor2', 'explorer', 'tomb_raiser', 'pharaoh', 'egypt_gargantuar'],
  },
  {
    key: 'pirate', re: /海盗|pirate/i, name: '海盗港湾',
    mechanics: ['海面/木板地形：普通植物不能种在水面', '海鸥可飞越地面阻挡', '滚桶会碾压植物', '船长鹦鹉会偷走植物'],
    zombies: ['pirate', 'swashbuckler', 'seagull', 'barrelroller', 'pirate_captain', 'pirate_gargantuar'],
  },
  {
    key: 'west', re: /西部|牛仔|cowboy|west/i, name: '狂野西部',
    mechanics: ['矿车轨道：矿车可载植物上下移动', '钢琴会碾压并换行', '淘金者可跳到后排', '养鸡人释放鸡群'],
    zombies: ['cowboy', 'prospector', 'piano', 'poncho', 'chicken_farmer', 'west_bull', 'cowboy_gargantuar'],
  },
  {
    key: 'future', re: /未来|future/i, name: '遥远未来',
    mechanics: ['机甲护甲', '喷气背包可飞越', '迪斯科会换行', '部分僵尸带护盾'],
    zombies: ['future', 'jetpack', 'protector', 'mech_cone', 'football_mech', 'disco_mech', 'future_gargantuar'],
  },
  {
    key: 'dark', re: /黑暗|dark/i, name: '黑暗时代',
    mechanics: ['夜间关卡（无天空阳光）', '墓碑占格', '巫师可变羊', '小丑会反弹', '国王会给僵尸加护甲'],
    zombies: ['dark', 'dark_juggler', 'dark_wizard', 'dark_king', 'dark_gargantuar'],
  },
  {
    key: 'beach', re: /沙滩|海滩|beach/i, name: '巨浪沙滩',
    mechanics: ['潮汐会改变水线位置', '章鱼会封住植物', '渔夫会拉走植物', '冲浪/潜水僵尸'],
    zombies: ['beach', 'beach_snorkel', 'beach_surfer', 'beach_octopus', 'beach_fisherman', 'beach_gargantuar'],
  },
  {
    key: 'iceage', re: /冰河|冰川|iceage/i, name: '冰河世界',
    mechanics: ['冰块占格', '猎人投冰', '渡渡鸟可跳越', '黄鼠狼会放出小怪'],
    zombies: ['iceage', 'iceage_hunter', 'iceage_dodo', 'iceage_troglobite', 'iceage_weaselhoarder', 'iceage_gargantuar'],
  },
  {
    key: 'lostcity', re: /失落|古城|lostcity/i, name: '遗落古城',
    mechanics: ['金瓷砖', '濒危植物格', '飞行员会绕后', '挖掘者会挖走植物'],
    zombies: ['lostcity', 'lostcity_lostpilot', 'lostcity_excavator', 'lostcity_jane', 'lostcity_bug', 'lostcity_crystalskull', 'lostcity_gargantuar'],
  },
  {
    key: 'kongfu', re: /功夫|kongfu|kungfu/i, name: '功夫世界',
    mechanics: ['气功洞会推拉植物和僵尸', '武僧/方丈等特殊僵尸'],
    zombies: ['kongfu', 'monk', 'abbot'],
  },
  {
    key: 'jurassic', re: /侏罗纪|jurassic|dino/i, name: '侏罗纪沼泽',
    mechanics: ['恐龙会干扰阵型：剑龙击退、翼龙抓走、迅猛龙召唤等'],
    zombies: ['dino', 'dino_armor1', 'dino_armor2', 'dino_bully', 'dino_imp', 'dino_gargantuar'],
  },
  {
    key: 'sky', re: /天空|sky/i, name: '天空之城',
    mechanics: ['天空格：需要能种在空中的植物或花盆', '飞行僵尸'],
    zombies: ['sky', 'sky_flag', 'sky_imp', 'sky_twin', 'sky_gargantuar'],
  },
  {
    key: 'modern', re: /现代|modern/i, name: '现代年华',
    mechanics: ['多个时代的僵尸混编', '机制随关卡轮换'],
    zombies: [],
  },
];

export function worldFactOf(text) {
  const s = String(text || '');
  for (const w of WORLD_FACTS) if (w.re.test(s)) return w;
  return null;
}

/**
 * 能力事实：tag 背后的“需要什么”，不写“种哪张卡”。
 * coverageGaps 缺哪项能力时，直接把这里的 text 给模型。
 */
export const CAPABILITY_FACTS = {
  anti_rolling: {
    name: '反滚动',
    text: '滚桶/滚木会碾过普通防线；需要地刺类（扎破）或能直接消灭它的爆发，墙挡不住',
  },
  anti_air: {
    name: '对空',
    text: '飞行/荡索/小鬼炮会越过地面阻挡；三叶草只在空中有效，落地后要近战/爆发',
  },
  multi_target: {
    name: '多目标',
    text: '成组僵尸（骆驼牌/旗帜波）需要同时打到多只；多目标/穿透卡按 multiDps 评估，不要只看单目标 dps',
  },
  high_dps: {
    name: '高单体 DPS',
    text: '护甲/巨人把 EHP 拉高；需要高 DPS 集中输出，普通豌豆会被护甲吃掉',
  },
  true_damage: {
    name: '真伤/毒伤',
    text: '真伤/毒伤直接打本体，护甲不计入击杀时间（例如黏毒豌豆的毒）；对铁桶/报纸/护甲单位比普通豌豆更快',
  },
  burst: {
    name: '爆发/秒杀',
    text: '报纸狂暴、巨人锤击、成组突袭需要一次性爆发直接清掉，拖时间只会让防线被压穿',
  },
  control: {
    name: '控制',
    text: '碾压/换行/冲刺需要减速、冰冻、眩晕或秒杀；墙只能拖时间',
  },
  pierce: {
    name: '穿透',
    text: '护甲/报纸有多层血量；穿透/多段攻击能更快打穿',
  },
  multi_lane: {
    name: '多行覆盖',
    text: '换行/跳舞会让僵尸改道；需要能覆盖多行或整行的输出，只压一行会被绕过',
  },
  protect_key: {
    name: '保护关键株',
    text: '偷植物/拉植物会留下空格；关键株旁边要留补位，别把唯一输出放在最外侧',
  },
  amphibious: {
    name: '水面作战',
    text: '能进入深水；水面行需要睡莲或水生植物，普通地面防线不成立',
  },
};

// 僵尸标签对应的“机制克制关系”（事实，不是卡组推荐）：
// 只描述哪些卡能处理这个机制，以及哪些防线对它无效。
// needs = 这个 tag 需要的能力（与 knowledge/tags.js 的 TAG_CAPABILITIES 同源）。
export const TAG_COUNTERS = {
  rolling: {
    text: '滚桶/滚木会滚过普通墙；地刺/地刺王可以扎破，墙挡不住',
    plants: ['spikeweed', 'spikerock'],
  },
  flying: {
    text: '三叶草只对空中单位有效；落地后用菜问/樱桃/倭瓜处理，墙和地刺拦不住飞行',
    plants: ['blover', 'bonkchoy', 'cherry_bomb', 'squash'],
  },
  carries_imp: {
    text: '小鬼炮/炮车会越过防线投小鬼；优先三叶草或樱桃，别等炸膛',
    plants: ['blover', 'cherry_bomb'],
  },
  armored: {
    text: '护甲计入 EHP；需要高 DPS、穿透、真伤/毒伤（黏毒豌豆的毒）或爆发，普通豌豆会被护甲吃掉',
    plants: [],
  },
  newspaper: {
    text: '报纸是独立血量，计入 EHP；打掉报纸后会狂暴加速/增伤，需要多段/穿透或高爆发，别按本体血量误判',
    plants: [],
  },
  group: {
    text: '成组出现（例如骆驼牌每组 3 只以上）；多目标/穿透卡的有效 DPS 远高于单目标，按 multiDps 评估',
    plants: ['bloomerang'],
  },
  steal: {
    text: '会偷走植物；关键株旁边留补位，别把唯一输出放在最外侧',
    plants: [],
  },
  crush: {
    text: '巨尸锤击会直接移除植物；墙挡不住，靠控制/秒杀/远程集火',
    plants: [],
  },
  gargantuar: {
    text: '巨人僵尸血量极高；需要集中输出或秒杀，普通墙只能拖时间',
    plants: [],
  },
  amphibious: {
    text: '能进入深水；水面行不能用普通地面防线判断',
    plants: [],
  },
  hypnotizable: {
    text: '可被魅惑；魅惑后反向攻击同类',
    plants: [],
  },
  lane_switch: {
    text: '会换行/跳行（钢琴、迪斯科等）：只压一行的火力会被绕过，需要多行覆盖或控制',
    plants: [],
  },
  rush: {
    text: '吃到植物后会加速/增伤：别让它在防线上吃出速度，优先控制或直接清掉',
    plants: [],
  },
  polymorph: {
    text: '会把植物变成羊（直接失去该株）：需要爆发/控制先处理它，变羊后补位',
    plants: [],
  },
  pull_plant: {
    text: '会把植物拉走/钩走（留下空格）：关键株旁边留补位，别把唯一输出放在最外侧',
    plants: [],
  },
  seal_plant: {
    text: '会封住植物（该株暂时失效）：需要爆发/控制先处理，别把唯一输出放在会被封的位置',
    plants: [],
  },
  jump_over: {
    text: '会跳过植物/越过防线（渡渡鸟等）：墙拦不住，需要能打到落点后的近战/爆发',
    plants: [],
  },
  spawn_minion: {
    text: '会放出小怪/召唤（黄鼠狼等）：小怪会分摊火力，需要多目标/穿透或快速清场',
    plants: [],
  },
  bypass: {
    text: '会绕到防线后面（淘金者等）：后排经济和关键株要留近战/补位，别只守前排',
    plants: [],
  },
  steal_sun: {
    text: '会偷走阳光：经济节奏会被打断，需要控制/爆发优先处理或提前存阳光',
    plants: [],
  },
};

for (const [tag, rule] of Object.entries(TAG_COUNTERS)) {
  rule.needs = (TAG_CAPABILITIES[tag] || []).slice();
}

