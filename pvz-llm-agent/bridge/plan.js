/**
 * plan：只记录 LLM 自己写的整关计划。
 * 读写之外不做任何事——不解析成执行队列，不修正，更不参与本地决策。
 */
export function createPlanStore(version) {
  let plan = null;
  let savedAt = null;

  function setPlan(value) {
    if (value == null) {
      plan = null;
      savedAt = null;
      return { ok: true, plan: null, savedAt: null, detail: '已清空计划' };
    }
    if (typeof value !== 'object') {
      return { ok: false, code: 'BAD_PLAN', reason: 'plan 必须是对象' };
    }
    plan = JSON.parse(JSON.stringify(value));
    savedAt = new Date().toISOString();
    return { ok: true, plan, savedAt, detail: '计划已记录（只保存，不执行）' };
  }

  function getPlan() {
    return plan ? { plan, savedAt } : null;
  }

  function reset() {
    plan = null;
    savedAt = null;
  }

  return { setPlan, getPlan, reset, version };
}
