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

function counterCovers(counter, gap) {
  if (!counter || typeof counter !== 'object') return false;
  const tags = Array.isArray(gap.tags) ? gap.tags : [];
  if (counter.tag && tags.includes(String(counter.tag))) return true;
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
  const structuredKeys = ['lanes', 'counters', 'phases', 'triggers', 'emergency'];
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
  for (const gap of gaps) {
    // 只认 counters 里的显式对应；卡组里带了某张卡不等于写了“用它处理这个机制”。
    const covered = counters.some((c) => counterCovers(c, gap));
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
