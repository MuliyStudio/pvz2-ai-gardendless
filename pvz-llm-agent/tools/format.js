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
  plant: '种植', replace: '换植', shovel: '铲除', plant_food: '能量豆',
  move_cart: '移动矿车', resume: '继续', wait: '等待', restart: '重开本关',
  dismiss_objective: '关闭任务说明', collect: '收掉落物',
};

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
  if (a.type === 'wait') return `${type} ${a.seconds == null ? '' : a.seconds + 's'}`;
  return `${type}${who}${pos}`.trim();
}

export function formatToolCall(name, args) {
  const a = args || {};
  switch (name) {
    case 'pvz_briefing': return '读取开局简报';
    case 'pvz_state': return '读取实时状态';
    case 'pvz_events': return '读取增量事件';
    case 'pvz_knowledge': return `查图鉴：${a.type || a.query || '?'}`;
    case 'pvz_set_plan': return '记录计划';
    case 'pvz_choose_deck': return `选卡：${(a.cards || []).join('、') || '?'}${a.replace === false ? '（追加）' : '（替换）'}`;
    case 'pvz_start_level': return '开始战斗';
    case 'pvz_act': return Array.isArray(a.actions) ? a.actions.map(formatAction).join('；') : '?';
    case 'pvz_wait_until': return `等待：${a.until || '?'}`;
    case 'pvz_collect': return '收掉落物';
    case 'pvz_plant_food': return `能量豆 第${Number(a.lane) + 1}行 第${Number(a.column) + 1}列`;
    case 'pvz_move_cart': return `矿车 #${a.cart} ${a.direction || ''}`;
    case 'pvz_resume': return '继续游戏';
    case 'pvz_restart': return '重开本关';
    case 'pvz_dismiss_objective': return '关闭任务说明';
    case 'pvz_health': return '健康检查';
    default: return name;
  }
}

function codeText(r) {
  if (!r) return '';
  const code = r.code ? `${r.code}` : '';
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
  const okMark = r.ok === false ? '❌' : '✅';

  if (name === 'pvz_briefing') {
    if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const z = (r.zombies || []).map((x) => `${x.name}×${(r.waves || []).reduce((s, w) => s + ((w.zombies[x.type] || {}).count || 0), 0) || '?'}`).join('、');
    return [
      `${okMark} 简报：${r.level && r.level.name ? r.level.name : '本关'}｜卡槽 ${r.deck && r.deck.slots}｜起始阳光 ${n(r.startingSun)}`,
      `任务：${(r.missionHints || []).join('；') || '无文本'}`,
      `僵尸：${z || '未读到'}`,
      `可用卡 ${(r.cards || []).length} 张｜波次 ${(r.waves || []).length}`,
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
    return r.ok ? `✅ 计划已保存${r.savedAt ? `（${r.savedAt}）` : ''}` : `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_knowledge') {
    if (r.ok && r.entry) {
      const e = r.entry;
      const bits = [`${e.name || e.type}`];
      if (e.cost != null) bits.push(`${e.cost} 阳光`);
      if (e.hp != null) bits.push(`${e.hp} 血`);
      if (e.ehp != null) bits.push(`${e.ehp} EHP`);
      if (e.attack && e.attack.dps) bits.push(`${e.attack.dps} DPS`);
      if (e.brief) bits.push(e.brief);
      return bits.join('｜');
    }
    if (r.matches) return r.matches.length ? `找到 ${r.matches.length} 条：${r.matches.map((x) => `${x.name}(${x.type})`).join('、')}` : '没有匹配';
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
      else if (l && typeof l === 'object') lines.push(`· L${(l.lane != null ? Number(l.lane) + 1 : '?')} ${l.role || ''} ${l.plan || l.notes || ''}`.trim());
    }
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
