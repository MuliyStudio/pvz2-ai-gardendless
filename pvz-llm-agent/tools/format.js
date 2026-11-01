/**
 * format：给人和给 LLM 的两种呈现。
 *
 * UI 只调用 formatToolCall / formatToolResult，保证思考窗里没有整段原始 JSON。
 * 工具返回给模型的仍是结构化对象。
 */

const n = (v) => (v == null ? '?' : v);

export function compactState(s) {
  if (!s || s.ok === false) return { ok: false, code: s && s.code, reason: s && s.reason };
  return {
    phase: s.phase,
    paused: s.paused,
    sun: s.sun,
    plantFood: s.plantFood,
    wave: s.level && s.level.wave,
    waves: s.level && s.level.waves,
    nextWaveIn: s.level && s.level.nextWaveIn,
    level: s.level && s.level.name,
    tasks: (s.tasks || []).map((t) => ({ tip: t.tip, hint: t.hint, completed: t.completed, failed: t.failed, urgent: t.urgent })),
    objective: s.objective ? { active: s.objective.active, missions: s.objective.missions } : null,
    counts: {
      cards: (s.cards || []).length,
      plants: (s.plants || []).length,
      zombies: (s.zombies || []).length,
    },
    lanes: (s.lanes || []).map((l) => ({
      lane: l.lane, zombies: l.zombies, nearestZombie: l.nearestZombie,
      plantCount: l.plants, dps: l.dps, wallHp: l.wallHp, mower: l.mower,
    })),
    plantLimit: s.plantLimit,
    plan: s.plan || null,
  };
}

export function stateLine(s) {
  if (!s || s.ok === false) return `状态不可用：${(s && (s.code || s.reason)) || '未知'}`;
  const lv = s.level || {};
  const bits = [
    `阶段 ${s.phase}${s.paused ? '（暂停）' : ''}`,
    `阳光 ${n(s.sun)}`,
    `能量豆 ${n(s.plantFood)}`,
    `第 ${n(lv.wave)}/${n(lv.waves)} 波`,
    `植物 ${(s.plants || []).length}`,
    `僵尸 ${(s.zombies || []).length}`,
  ];
  return bits.join('｜');
}

const ACTION_CN = {
  plant: '种植', replace: '换植', shovel: '铲除', plant_food: '能量豆', activate: '触发',
  move_cart: '移动矿车', resume: '继续', wait: '等待', restart: '重开本关',
  dismiss_objective: '关闭任务说明', collect: '收掉落物', start_level: '开始战斗',
  choose_deck: '选卡', dismiss: '关闭弹窗', decide: '处理本地决策',
};

const PHASE_CN = {
  objective: '关卡目标', preparing: '选卡/准备', running: '战斗中',
  won: '胜利', lost: '失败', menu: '菜单', worldmap: '世界地图',
};

const TOOL_CN = {
  pvz_briefing: '读取开局简报', pvz_state: '读取实时状态', pvz_events: '读取增量事件',
  pvz_knowledge: '查图鉴', pvz_set_plan: '记录计划', pvz_choose_deck: '选卡',
  pvz_start_level: '开始战斗', pvz_act: '执行动作', pvz_wait_until: '等待条件',
  pvz_collect: '收掉落物', pvz_plant_food: '使用能量豆', pvz_move_cart: '移动矿车',
  pvz_resume: '继续游戏', pvz_restart: '重开本关', pvz_dismiss_objective: '关闭任务说明',
  pvz_health: '健康检查', pvz_decide: '处理本地决策', pvz_forecast: '读取波次预测',
  pvz_level_memory: '读写关卡总结', pvz_stop: '停止 AI', pvz_think: '写入思考',
};

const PLANT_CN = {
  sunflower: '向日葵', peashooter: '豌豆射手', cabbagepult: '卷心菜投手',
  bloomerang: '回旋镖射手', wallnut: '坚果墙', potatomine: '土豆地雷',
  iceburg: '冰冻生菜', snowpea: '寒冰射手', repeater: '双发射手',
  cherry_bomb: '樱桃炸弹', jalapeno: '火爆辣椒', squash: '倭瓜',
  spikeweed: '地刺', spikerock: '地刺王', bonkchoy: '菜问',
  chomper: '大嘴花', torchwood: '火炬树桩', threepeater: '三线射手',
  tallnut: '高坚果', pumpkin: '南瓜头', magnet: '磁力菇',
  lilypad: '睡莲', tanglekelp: '缠绕水草', seashooter: '海豌豆',
  coconutcannon: '椰子加农炮', wintermelon: '冰西瓜', melonpult: '西瓜投手',
  kernelpult: '玉米投手', buttercup: '黄油投手', lightningreed: '闪电芦苇',
  blover: '三叶草', graves: '墓碑', gravebuster: '墓碑破坏者',
};

const ZOMBIE_CN = {
  tutorial: '普通僵尸', mummy: '木乃伊僵尸', mummy_armor1: '路障木乃伊',
  mummy_armor2: '铁桶木乃伊', mummy_flag: '旗帜木乃伊', ra: '太阳神僵尸',
  explorer: '探险家僵尸', tomb_raiser: '造墓僵尸', pharaoh: '法老僵尸',
  egypt_gargantuar: '埃及巨人', gargantuar: '巨人僵尸', imp: '小鬼僵尸',
  buckethead: '铁桶僵尸', conehead: '路障僵尸', flag: '旗帜僵尸',
  newspaper: '读报僵尸', prospector: '淘金僵尸', piano: '钢琴僵尸',
  chicken_farmer: '养鸡僵尸', west_bull: '西部公牛', seagull: '海鸥僵尸',
};

const CODE_CN = {
  COOLDOWN: '冷却中', SUN: '阳光不足', OCCUPIED: '格子被占用', CELL_BLOCKED: '格子不可种',
  TERRAIN: '地形不可种', WALL_TOO_LATE: '墙来不及', MINE_TOO_LATE: '地雷来不及',
  PLANT_BEHIND_ZOMBIE: '种在僵尸身后', OUTPUT_IN_FRONT_OF_WALL: '输出在墙右侧',
  SPIKE_BEHIND_WALL: '地刺在墙后', BATCH_COOLDOWN: '同卡批量冷却',
  TASK_OCCUPIED: '目标格已有植物', TASK_ALREADY_PLANTED: '目标格已有同种植物',
  TASK_EXPIRED: '任务过期', TASK_DONE: '任务已完成', STALE_ACTION: '旧局面任务',
  CARD_NOT_IN_DECK: '卡不在卡组', CARD_UNAVAILABLE: '卡不可用', NO_CARD: '找不到卡',
  NO_SCENE: '场景未就绪', NO_FOOD: '没有能量豆', FOOD_NO_TARGET: '能量豆没有目标',
  PAUSED: '游戏暂停', TIMEOUT: '等待超时', NEED_PLAN: '需要先写计划',
  PLAN_DECK_MISMATCH: '计划卡组不一致', PLAN_MISSING_COUNTER: '计划缺克制关系',
  PLAN_POSITIONAL_AT_START: '开局计划写了具体位置', PLAN_FIXED_WALL_COLUMN: '墙写死了列',
  PLAN_FIXED_MINE_COLUMN: '雷写死了列', NEED_BRIEFING: '需要先读简报',
  NEED_KNOWLEDGE: '需要先读图鉴', BRIEFING_NOT_READY: '简报未就绪', STALE_DECISION: '决策过期',
  NO_DECISION: '决策不存在', BAD_CHOICE: '选择无效', NOT_READY: '还没准备好',
  SHOVEL_BLOCKED: '不能铲除', LANE_LIMIT: '本行数量上限', LEVEL_LIMIT: '本关数量上限',
  POSITION: '位置不合法', NO_PLANT: '格子里没有植物', EMPTY: '格子是空的',
};

// 动态名称缓存：不同世界/新植物新僵尸的中文名来自游戏自身数据
// （briefing/state/knowledge 里的 name 字段），不依赖写死的埃及名单。
const NAME_CN = new Map(Object.entries({ ...PLANT_CN, ...ZOMBIE_CN }));

/** 从任意工具返回/状态对象里收集 { type/plant, name } 对，供后续展示本地化。 */
export function rememberNames(value, budget = { n: 0 }) {
  if (!value || budget.n > 800) return;
  budget.n += 1;
  if (Array.isArray(value)) {
    for (const v of value) rememberNames(v, budget);
    return;
  }
  if (typeof value !== 'object') return;
  const type = value.type || value.plant;
  const name = value.name;
  if (typeof type === 'string' && typeof name === 'string'
    && /[\u4e00-\u9fa5]/.test(name)) {
    NAME_CN.set(type, name);
  }
  for (const k of ['plants', 'zombies', 'cards', 'entry', 'matches', 'deck', 'tasks', 'results', 'preview']) {
    if (value[k] != null) rememberNames(value[k], budget);
  }
}

export function cnName(type) {
  const t = String(type || '');
  return NAME_CN.get(t) || t;
}

export function cnCode(code) {
  const c = String(code || '');
  return CODE_CN[c] || c;
}

/** 桌面/气泡展示用：把常见英文 codename、工具名、phase、错误码换成本地中文语义。 */
export function localizeDisplay(text) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  const escape = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const map of [PHASE_CN, TOOL_CN, CODE_CN]) {
    for (const [k, v] of Object.entries(map)) {
      s = s.replace(new RegExp(`\\b${escape(k)}\\b`, 'g'), v);
    }
  }
  // 植物/僵尸名称用动态缓存（包含当前世界/关卡读到的所有 name）。
  for (const [k, v] of NAME_CN) {
    s = s.replace(new RegExp(`\\b${escape(k)}\\b`, 'g'), v);
  }
  // 常见字段名/枚举的轻量语义替换，避免气泡里出现 count= / ok= / running。
  const words = {
    count: '数量', collected: '收取', paused: '暂停', lane: '行', column: '列', type: '类型',
    detail: '详情', started: '已发起', phase: '阶段', running: '战斗中', preparing: '准备中',
    objective: '关卡目标', won: '胜利', lost: '失败', ok: '完成', fail: '失败',
  };
  for (const [k, v] of Object.entries(words)) {
    s = s.replace(new RegExp(`\\b${escape(k)}\\b`, 'g'), v);
  }
  return s;
}

export function formatAction(a) {
  if (!a || typeof a !== 'object') return '?';
  const type = ACTION_CN[a.type] || a.type || '?';
  if (Array.isArray(a.cells) && a.cells.length) {
    const who = a.plant ? ` ${a.plant}` : (a.card != null ? ` #${a.card}` : '');
    const cells = a.cells.map((c) => `第${Number(c.lane) + 1}行第${Number(c.column) + 1}列`).join('、');
    return `${type}${who} ×${a.cells.length}：${cells}`;
  }
  const pos = Number.isFinite(Number(a.lane)) && Number.isFinite(Number(a.column))
    ? ` 第${Number(a.lane) + 1}行 第${Number(a.column) + 1}列` : '';
  const who = a.plant ? ` ${a.plant}` : (a.card != null ? ` #${a.card}` : '');
  if (a.type === 'move_cart') return `${type} #${a.cart} ${a.direction || ''}`;
  if (a.type === 'activate' && Number.isFinite(Number(a.targetLane)) && Number.isFinite(Number(a.targetColumn))) {
    return `${type}${who}${pos} → 目标 第${Number(a.targetLane) + 1}行第${Number(a.targetColumn) + 1}列`;
  }
  if (a.type === 'wait') return `${type} ${a.seconds == null ? '' : a.seconds + 's'}`;
  return `${type}${who}${pos}`.trim();
}

export function formatToolCall(name, args) {
  const a = args || {};
  switch (name) {
    case 'pvz_briefing': return '读取开局简报';
    case 'pvz_state': return '读取实时状态';
    case 'pvz_events': return '读取增量事件';
    case 'pvz_knowledge':
      if (Array.isArray(a.types) && a.types.length) return `批量查图鉴：${a.types.length} 个`;
      return `查图鉴：${cnName(a.type) || a.query || '?'}`;
    case 'pvz_set_plan': return '记录计划';
    case 'pvz_choose_deck': return `选卡：${(a.cards || []).join('、') || '?'}${a.replace === false ? '（追加）' : '（替换）'}`;
    case 'pvz_start_level': return '开始战斗';
    case 'pvz_act': return Array.isArray(a.actions) ? a.actions.map(formatAction).join('；') : '?';    case 'pvz_wait_until': return `等待：${a.until || '?'}`;
    case 'pvz_collect': return '收掉落物';
    case 'pvz_plant_food': return `能量豆 第${Number(a.lane) + 1}行 第${Number(a.column) + 1}列`;
    case 'pvz_move_cart': return `矿车 #${a.cart} ${a.direction || ''}`;
    case 'pvz_resume': return '继续游戏';
    case 'pvz_restart': return '重开本关';
    case 'pvz_dismiss_objective': return '关闭任务说明';
    case 'pvz_health': return '健康检查';
    default: return TOOL_CN[name] || '????';
  }
}

function codeText(r) {
  if (!r) return '';
  const code = r.code ? `${cnCode(r.code)}` : '';
  const extra = [];
  if (r.retryAfter != null) extra.push(`${r.retryAfter}s 后可重试`);
  if (r.need != null && r.have != null) extra.push(`需要 ${r.need} / 现有 ${r.have}`);
  if (r.retryable === true) extra.push('可重试');
  return [code, extra.join('，')].filter(Boolean).join('（') + (extra.length ? '）' : '');
}

export function formatToolResult(name, r) {
  if (name === 'pvz_events') {
    const list = Array.isArray(r) ? r : [];
    if (!list.length) return '没有新事件';
    return list.map((e) => `· ${eventText(e)}`).join('\n');
  }
  if (!r || typeof r !== 'object') return String(r == null ? '无返回' : r);
  // 任何工具结果里的 name 都进入动态缓存：换世界/换关卡后新植物新僵尸也能中文化。
  rememberNames(r);
  const okMark = r.ok === false ? '❌' : '✅';

  if (name === 'pvz_briefing') {
    if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const z = (r.zombies || []).map((x) => `${x.name}×${(r.waves || []).reduce((s, w) => s + ((w.zombies[x.type] || {}).count || 0), 0) || '?'}`).join('、');
    const gaps = ((r.coverageGaps && r.coverageGaps.missing) || []).map((m) => m.capability);
    const label = (r.level && (r.level.label || r.level.name)) || '本关';
    const notReady = !!(r.prep && r.prep.ready === false);
    return [
      `${okMark} 简报：${label}｜卡槽 ${r.deck && r.deck.slots}｜起始阳光 ${n(r.startingSun)}${notReady ? '｜准备未就绪，进入选卡后再读一次' : ''}`,
      `任务：${(r.missionHints || []).join('；') || '无文本'}`,
      `僵尸：${z || '未读到'}`,
      `可用卡 ${(r.cards || []).length} 张｜波次 ${(r.waves || []).length}${gaps.length ? `｜能力缺口 ${gaps.join('/')}` : ''}`,
    ].join('\n');
  }

  if (name === 'pvz_state') {
    if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const tasks = (r.tasks || []).map((t) => `${t.tip}${t.hint ? `（${t.hint}）` : ''}`).join('；');
    const lanes = (r.lanes || []).map((l) => `L${l.lane + 1} 僵尸${l.zombies} 输出${l.shooters} dps${l.dps}${l.mower ? '' : ' 无车'}`).join('｜');
    return [
      `${okMark} ${stateLine(r)}`,
      tasks ? `任务：${tasks}` : null,
      lanes ? `行：${lanes}` : null,
      r.plan ? '计划：已记录' : null,
    ].filter(Boolean).join('\n');
  }

  if (name === 'pvz_choose_deck') {
    if (r.ok) return `${okMark} 选卡完成 ${(r.actualDeck || []).length}/${r.slots}：${(r.actualDeck || []).join('、')}`;
    const bits = [`${okMark} ${r.code || ''} ${r.reason || ''}`.trim()];
    if (r.actualDeck) bits.push(`实际卡组 ${r.actualDeck.length}/${r.slots || '?'}：${r.actualDeck.join('、')}`);
    if (r.missing && r.missing.length) bits.push(`未选中：${r.missing.join('、')}`);
    if (r.skipped && r.skipped.length) bits.push(`跳过：${r.skipped.map((x) => `${x.type}(${x.reason})`).join('、')}`);
    return bits.join('\n');
  }

  if (name === 'pvz_act') {
    if (r.ok === false && !Array.isArray(r.results)) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    return (r.results || []).map((x) => {
      const actType = x.action || x.type;
      const act = ACTION_CN[actType] || actType;
      if (x.pending) return `⏳ ${x.detail || `${act} 已发起，等待落地`}`;
      if (x.ok && x.detail) return `✅ ${x.detail}`;
      if (x.ok) return `✅ ${act}${actType === 'plant' || actType === 'replace' ? ` ${x.plant || x.type}` : ''}`;
      return `❌ ${act} ${x.code || ''} ${x.reason || ''}${x.retryAfter != null ? `（${x.retryAfter}s 后重试）` : ''}`.trim();
    }).join('\n');
  }

  if (name === 'pvz_wait_until') {
    if (r.ok && r.satisfied) return `✅ 条件满足：${r.condition}（${r.elapsed}s）`;
    if (r.code === 'TIMEOUT') return `⌛ 等待超时：${r.condition}（${r.elapsed}s）`;
    return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_set_plan') {
    if (!r.ok) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const warns = Array.isArray(r.warnings) ? r.warnings : [];
    return `✅ 计划已保存${r.savedAt ? `（${r.savedAt}）` : ''}${warns.length ? `｜${warns.length} 条审计提示，需要重写` : ''}`;
  }

  if (name === 'pvz_knowledge') {
    if (r.ok && r.batch) {
      const names = (r.entries || []).map((e) => e.name || cnName(e.type));
      return `✅ 已读图鉴 ${names.length} 个：${names.join('、')}${Array.isArray(r.missing) && r.missing.length ? `；没查到：${r.missing.join('/')}` : ''}`;
    }
    if (r.ok && r.entry) {
      const e = r.entry;
      const bits = [`${e.name || cnName(e.type)}`];
      if (e.cost != null) bits.push(`${e.cost} 阳光`);
      if (e.hp != null) bits.push(`${e.hp} 血`);
      if (e.ehp != null) bits.push(`${e.ehp} EHP`);
      if (e.attack && e.attack.dps) bits.push(`${e.attack.dps} DPS`);
      if (e.brief) bits.push(e.brief);
      return bits.join('｜');
    }
    if (r.matches) return r.matches.length ? `找到 ${r.matches.length} 条：${r.matches.map((x) => `${x.name || cnName(x.type)}`).join('、')}` : '没有匹配';
    return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_health') {
    return r.ok ? `✅ 模组 v${r.version}｜phase ${r.phase}｜工具 ${(r.tools || []).length} 个` : `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}${codeText(r) ? ` ${codeText(r)}` : ''}`.trim();
  const bits = [];
  for (const k of ['count', 'collected', 'paused', 'lane', 'column', 'type', 'detail', 'started', 'phase']) {
    if (r[k] != null) bits.push(`${k}=${typeof r[k] === 'object' ? '[对象]' : r[k]}`);
  }
  return `${okMark} ${bits.join(' ') || '完成'}`;
}

export function eventText(e) {
  if (!e) return '?';
  const names = {
    wave_started: '波次开始', lane_threat: '行威胁', mower_lost: '小推车丢失',
    plant_lost: '植物损失', card_ready: '卡片就绪', zombie_new: '新僵尸',
    task_urgent: '任务紧急', task_done: '任务完成', task_failed: '任务失败',
    level_won: '关卡胜利', level_lost: '关卡失败',
  };
  const head = names[e.t] || e.t;
  const bits = [];
  if (e.lane != null) bits.push(`第${e.lane + 1}行`);
  if (e.wave != null) bits.push(`第${e.wave}波`);
  if (e.detail) bits.push(e.detail);
  return `${head}${bits.length ? '：' + bits.join(' ') : ''}`;
}

/** 计划的人话呈现（UI 用），不解析成执行指令。 */
export function formatPlan(plan) {
  if (!plan || typeof plan !== 'object') return '暂无计划';
  const lines = [];
  const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (plan.text) lines.push(`摘要：${plan.text}`);
  if (plan.goal) lines.push(`目标：${asText(plan.goal)}`);
  if (plan.style) lines.push(`风格：${asText(plan.style)}`);
  if (Array.isArray(plan.deck) && plan.deck.length) lines.push(`卡组：${plan.deck.join('、')}`);
  else if (plan.deck && typeof plan.deck === 'object') {
    const deck = Object.entries(plan.deck).map(([k, v]) => `${k}（${asText(v)}）`);
    if (deck.length) lines.push(`卡组：${deck.join('、')}`);
  }
  if (plan.layout && typeof plan.layout === 'object') {
    lines.push('布置：');
    for (const [k, v] of Object.entries(plan.layout)) lines.push(`· ${k}：${asText(v)}`);
  }
  if (Array.isArray(plan.lanes)) {
    for (const l of plan.lanes) {
      if (typeof l === 'string') lines.push(`· ${l}`);
      else if (l && typeof l === 'object') {
        const bits = [];
        if (l.wall != null) bits.push(`墙 c${l.wall}`);
        if (Array.isArray(l.output) && l.output.length) bits.push(`输出 c${l.output.join('/c')}`);
        if (Array.isArray(l.econ) && l.econ.length) bits.push(`经济 c${l.econ.join('/c')}`);
        if (l.plan || l.notes) bits.push(l.plan || l.notes);
        lines.push(`· L${(l.lane != null ? Number(l.lane) + 1 : '?')} ${l.role || ''}${bits.length ? `：${bits.join('，')}` : ''}`.trim());
      }
    }
  }
  if (Array.isArray(plan.counters) && plan.counters.length) {
    lines.push('克制：' + plan.counters.map((c) => `${c.tag || c.threat || '?'}→${c.card || c.action || '?'}${c.lane != null ? `(L${Number(c.lane) + 1})` : ''}`).join(' / '));
  }
  if (Array.isArray(plan.phases) && plan.phases.length) {
    lines.push('阶段：' + plan.phases.map((p) => `${p.id || '?'}${p.untilWave != null ? `≤${p.untilWave}波` : ''}${Array.isArray(p.actions) ? `：${p.actions.join('；')}` : ''}`).join(' / '));
  }
  if (Array.isArray(plan.triggers) && plan.triggers.length) {
    lines.push('触发：' + plan.triggers.map((t) => `${t.when}→${asText(t.action)}`).join(' / '));
  }
  if (Array.isArray(plan.emergency) && plan.emergency.length) {
    lines.push('应急：' + plan.emergency.map((e) => `${e.when || e.condition || '?'}→${asText(e.action)}`).join(' / '));
  }
  if (plan.thresholds && typeof plan.thresholds === 'object') {
    lines.push('阈值：' + Object.entries(plan.thresholds).map(([k, v]) => `${k}=${asText(v)}`).join(' / '));
  }
  if (plan.contingency) {
    if (typeof plan.contingency === 'string') lines.push(`应急：${plan.contingency}`);
    else if (typeof plan.contingency === 'object') {
      lines.push('应急：');
      for (const [k, v] of Object.entries(plan.contingency)) lines.push(`· ${k}：${asText(v)}`);
    }
  }
  if (!lines.length) return '计划已记录（自定义字段）';
  return lines.join('\n');
}
