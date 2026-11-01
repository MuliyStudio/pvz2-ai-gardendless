/**
 * plan：只记录 LLM 自己写的整关计划。
 * 读写之外不做任何事——不解析成执行队列，不修正，更不参与本地决策。
 *
 * 约定结构（pvz-plan/v1）：
 *   text       给玩家看的中文摘要
 *   goal       胜利条件
 *   deck       卡组
 *   lanes[]    {lane, role, econ[], wall, output[], reserve[], notes}
 *   counters[] {tag, threat, capability, card, lane, column, timing, notes}
 *   phases[]   {id, untilWave, actions[]}
 *   triggers[] {when, action, priority}
 *   emergency[]/thresholds/contingency 应急
 * 这里只把常见的对象/数组写法归一化，不改变任何策略内容。
 *
 * auditPlan 只检查“计划有没有覆盖本关事实”，不替模型改计划：
 * 缺能力却没写 counter、卡组和实际不一致、只有一段文本，都会给 warning。
 */

/** 把 coverageGaps 的两种形态（新：能力缺口；旧：逐僵尸 missingTags）统一成数组。 */
export function normalizeCoverageGaps(gaps) {
  if (!gaps) return [];
  if (Array.isArray(gaps)) {
    return gaps.map((g) => {
      if (!g || typeof g !== 'object') return null;
      if (g.capability) return { capability: g.capability, tags: g.tags || [], candidates: g.candidates || [] };
      return { capability: (g.missingTags && g.missingTags[0]) || g.type || 'unknown', tags: g.tags || g.missingTags || [], candidates: g.candidates || [] };
    }).filter(Boolean);
  }
  if (typeof gaps === 'object') {
    if (Array.isArray(gaps.missing)) return normalizeCoverageGaps(gaps.missing);
    if (Array.isArray(gaps.gaps)) return normalizeCoverageGaps(gaps.gaps);
  }
  return [];
}

function counterCovers(counter, gap, deckSet) {
  if (!counter || typeof counter !== 'object') return false;
  // counter 里写的卡必须真的在当前卡组里，否则“计划有克制”只是纸面覆盖。
  if (counter.card && deckSet && deckSet.size && !deckSet.has(String(counter.card))) return false;
  const tags = Array.isArray(gap.tags) ? gap.tags : [];
  const counterTags = Array.isArray(counter.tags) ? counter.tags.map(String)
    : (counter.tag ? [String(counter.tag)] : []);
  if (counterTags.some((t) => tags.includes(t))) return true;
  if (counter.threat && tags.includes(String(counter.threat))) return true;
  const alts = Array.isArray(gap.alternatives) && gap.alternatives.length
    ? gap.alternatives.map(String)
    : [String(gap.capability)];
  if (counter.capability && alts.includes(String(counter.capability))) return true;
  if (counter.card && Array.isArray(gap.candidates) && gap.candidates.includes(String(counter.card))) return true;
  return false;
}

/**
 * 开局计划审计（纯函数）。
 * ctx: { coverageGaps, deck }
 * 返回 { ok, warnings[] }；warning 只要求模型重写计划，不会阻止保存。
 */
export function auditPlan(plan, ctx = {}) {
  const warnings = [];
  if (!plan || typeof plan !== 'object') return { ok: true, warnings };
  const p = plan;

  if (p.schema && p.schema !== 'pvz-plan/v1') {
    warnings.push({ code: 'PLAN_SCHEMA', reason: `计划 schema 是 ${p.schema}，应为 pvz-plan/v1` });
  }
  if (!p.text) {
    warnings.push({ code: 'PLAN_NO_TEXT', reason: '计划缺少 text（给玩家看的中文摘要）' });
  }
  const structuredKeys = ['lanes', 'counters', 'phases', 'triggers', 'emergency', 'queue', 'rules'];
  const structured = structuredKeys.filter((k) => {
    const v = p[k];
    if (Array.isArray(v)) return v.length > 0;
    return !!(v && typeof v === 'object' && Object.keys(v).length);
  });
  if (!structured.length) {
    warnings.push({
      code: 'PLAN_TEXT_ONLY',
      reason: '计划只有文字：补 lanes（每行职责）、counters（机制→卡）、phases/triggers（波次条件），快模型才能直接执行',
    });
  }

  // 开局计划不建议写死具体行/列：僵尸生成和波次是动态的。
  // 只提示，不阻止保存；running 时再写 queue 是允许的。
  if (ctx.phase === 'preparing') {
    const lanes = Array.isArray(p.lanes) ? p.lanes : [];
    const positional = lanes.filter((l) => l && typeof l === 'object' && (
      (l.wall != null && Number.isFinite(Number(l.wall)))
      || (Array.isArray(l.output) && l.output.some((c) => Number.isFinite(Number(c))))
      || (Array.isArray(l.econ) && l.econ.some((c) => Number.isFinite(Number(c))))
    ));
    const queue = Array.isArray(p.queue) ? p.queue : [];
    const fixedQueue = queue.filter((t) => t && t.column != null && /^\d+$/.test(String(t.column)));
    if (positional.length || fixedQueue.length) {
      warnings.push({
        code: 'PLAN_POSITIONAL_AT_START',
        lanes: positional.map((l) => l.lane).filter((x) => x != null),
        fixedTasks: fixedQueue.map((t) => t.id).filter(Boolean).slice(0, 6),
        reason: '开局计划里出现了具体行/列/固定格。僵尸生成和波次是动态的，建议开局只写 counters/usage/phases 这类“什么克制什么、怎么用”的建议；位置留到 running 时由 capacityGaps/wallPlan/minePlan/lastResortPlan 现算。',
      });
    }
  }

  if (Array.isArray(p.lanes)) {
    for (const l of p.lanes) {
      if (!l || typeof l !== 'object' || l.lane == null) continue;
      const n = Number(l.lane);
      if (!Number.isInteger(n) || n < 0 || n > 4) {
        warnings.push({ code: 'PLAN_BAD_LANE', lane: l.lane, reason: `lane 只能是 0-4，计划里出现了 ${l.lane}` });
      }
    }
  }

  const actual = Array.isArray(ctx.deck) ? ctx.deck.map(String).filter(Boolean) : null;
  const planDeck = Array.isArray(p.deck) ? p.deck.map(String).filter(Boolean) : null;
  if (actual && actual.length && planDeck && planDeck.length) {
    const missing = actual.filter((t) => !planDeck.includes(t));
    const extra = planDeck.filter((t) => !actual.includes(t));
    if (missing.length || extra.length) {
      warnings.push({
        code: 'PLAN_DECK_MISMATCH',
        missing, extra,
        reason: `计划卡组和实际卡组不一致：实际有但计划没写 ${missing.join('/') || '无'}；计划写了但实际没有 ${extra.join('/') || '无'}。以实际卡组为准。`,
      });
    }
  }

  const gaps = normalizeCoverageGaps(ctx.coverageGaps);
  const counters = Array.isArray(p.counters) ? p.counters : [];
  const deckSet = new Set((Array.isArray(ctx.deck) ? ctx.deck : []).map(String));
  for (const gap of gaps) {
    // 只认 counters 里的显式对应；卡组里带了某张卡不等于写了“用它处理这个机制”。
    const covered = counters.some((c) => counterCovers(c, gap, deckSet));
    if (covered) continue;
    const alts = Array.isArray(gap.alternatives) && gap.alternatives.length ? gap.alternatives : [gap.capability];
    warnings.push({
      code: 'PLAN_MISSING_COUNTER',
      capability: gap.capability,
      alternatives: alts,
      tags: gap.tags,
      candidates: gap.candidates,
      reason: `本关需要能力 ${alts.join('/')}${gap.tags && gap.tags.length ? `（tag: ${gap.tags.join('/')}）` : ''}，计划里没有对应 counter${gap.candidates && gap.candidates.length ? `；卡池里能满足的是 ${gap.candidates.join('/')}` : ''}。补一条 counters 或写清替代方案。`,
    });
  }

  // 时间敏感任务写死列：墙/雷到执行时僵尸可能已经越过，固定 c 列会变成
  // WALL_TOO_LATE / MINE_TOO_LATE。只提示改列写法，不替模型改任务。
  const queue = Array.isArray(p.queue) ? p.queue : [];
  const fixedColumnWarn = (types, code, label, fix) => {
    if (!Array.isArray(types) || !types.length) return;
    const hits = queue.filter((t) => t && t.type !== 'shovel'
      && types.includes(String(t.plant || ''))
      && t.column != null && /^\d+$/.test(String(t.column)));
    if (!hits.length) return;
    warnings.push({
      code,
      ids: hits.map((t) => t.id).filter(Boolean).slice(0, 6),
      columns: [...new Set(hits.map((t) => Number(t.column)))].sort((a, b) => a - b),
      reason: `queue 里 ${label} 写死了列 c${[...new Set(hits.map((t) => Number(t.column)))].sort((a, b) => a - b).join('/c')}；僵尸越过这一列后任务会变成 ${code === 'PLAN_FIXED_WALL_COLUMN' ? 'WALL_TOO_LATE' : 'MINE_TOO_LATE'}。改用 column:'${fix}'（本地按最前僵尸/出土时间算），或至少带 cond.zombieColumnLt。`,
    });
  };
  fixedColumnWarn(ctx.wallTypes, 'PLAN_FIXED_WALL_COLUMN', '坚果墙', 'ahead');
  fixedColumnWarn(ctx.mineTypes, 'PLAN_FIXED_MINE_COLUMN', '土豆雷/地雷', 'safe');

  return { ok: warnings.length === 0, warnings };
}

export function createPlanStore(version) {
  let plan = null;
  let savedAt = null;

  function normalize(value) {
    const p = JSON.parse(JSON.stringify(value));
    if (!p.schema) p.schema = 'pvz-plan/v1';
    if (typeof p.text !== 'string') {
      p.text = typeof p.style === 'string' ? p.style
        : (typeof p.goal === 'string' ? p.goal : (typeof p.summary === 'string' ? p.summary : null));
    }
    if (!Array.isArray(p.deck) && p.deck && typeof p.deck === 'object') {
      p.deck = Object.keys(p.deck);
    }
    if (p.lanes && !Array.isArray(p.lanes) && typeof p.lanes === 'object') {
      p.lanes = Object.entries(p.lanes).map(([k, v]) => (
        v && typeof v === 'object' ? { lane: /^\d+$/.test(k) ? Number(k) : null, role: k, ...v } : { lane: null, role: k, notes: String(v) }
      ));
    }
    if (Array.isArray(p.lanes)) {
      p.lanes = p.lanes.map((l) => {
        if (typeof l === 'string') return { lane: null, role: l };
        if (!l || typeof l !== 'object') return l;
        const lane = l.lane != null && Number.isFinite(Number(l.lane)) ? Number(l.lane) : null;
        return { ...l, lane };
      });
    }
    if (p.counters && !Array.isArray(p.counters) && typeof p.counters === 'object') {
      p.counters = Object.entries(p.counters).map(([tag, v]) => (
        v && typeof v === 'object' ? { tag, ...v } : { tag, card: String(v) }
      ));
    }
    if (p.triggers && !Array.isArray(p.triggers) && typeof p.triggers === 'object') {
      p.triggers = Object.entries(p.triggers).map(([when, action]) => ({ when, action }));
    }
    return p;
  }

  function setPlan(value) {
    if (value == null) {
      plan = null;
      savedAt = null;
      return { ok: true, plan: null, savedAt: null, detail: '已清空计划' };
    }
    if (typeof value !== 'object') {
      return { ok: false, code: 'BAD_PLAN', reason: 'plan 必须是对象' };
    }
    plan = normalize(value);
    savedAt = new Date().toISOString();
    return { ok: true, plan, savedAt, detail: '计划已记录（结构化，只保存不执行）' };
  }

  function getPlan() {
    return plan ? { plan, savedAt } : null;
  }

  function audit(ctx) {
    return plan ? auditPlan(plan, ctx || {}) : { ok: true, warnings: [] };
  }

  function reset() {
    plan = null;
    savedAt = null;
  }

  return { setPlan, getPlan, audit, reset, version };
}
