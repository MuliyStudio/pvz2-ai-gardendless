/**
 * events：把两次 snapshot 的差异变成增量事件。
 * 只做变更检测 + 去抖，不做判断。LLM 自己决定这些事件意味着什么。
 */

const keyOf = (e) => `${e.t}:${e.lane == null ? '' : e.lane}:${e.detail || ''}`;

export function createEventStreamApi({ snapshot }) {
  const debounceMs = 2500;
  const queue = [];
  const lastAt = new Map();
  let prev = null;
  let dropped = 0;
  let timer = null;
  let interval = 100;

  function emit(list, ev, now) {
    const k = keyOf(ev);
    const t = lastAt.get(k) || 0;
    if (now - t < debounceMs) return;
    lastAt.set(k, now);
    list.push({ ...ev, at: new Date(now).toISOString() });
  }

  function push(state, now = Date.now()) {
    const out = [];
    if (!state || state.ok === false) { prev = state; return out; }
    if (!prev || prev.ok === false) { prev = state; return out; }

    const w1 = (prev.level && prev.level.wave) || 0;
    const w2 = (state.level && state.level.wave) || 0;
    if (w2 > w1) {
      const types = [...new Set((state.zombies || []).map((z) => z.type))];
      const ehpTotal = (state.zombies || []).reduce((s, z) => s + (z.ehp != null ? z.ehp : (z.ehpMax || 0)), 0);
      emit(out, { t: 'wave_started', wave: w2, types, ehpTotal, detail: `第${w2}波${types.length ? ' ' + types.join(',') : ''}` }, now);
    }

    for (const lane of state.lanes || []) {
      const before = (prev.lanes || []).find((l) => l.lane === lane.lane);
      if (before && before.mower !== false && lane.mower === false) {
        emit(out, { t: 'mower_lost', lane: lane.lane, detail: '该行失去推车（再漏一只就输）' }, now);
      }
    }
    for (const p of prev.plants || []) {
      if (!(state.plants || []).some((q) => q.lane === p.lane && q.column === p.column)) {
        emit(out, { t: 'plant_lost', lane: p.lane, detail: `${p.type} @c${p.column}` }, now);
      }
    }

    for (const lane of state.lanes || []) {
      const before = (prev.lanes || []).find((l) => l.lane === lane.lane) || {};
      const nearBefore = before.nearestZombie;
      const nearNow = lane.nearestZombie;
      if (nearNow == null) continue;
      const isNew = (before.zombies || 0) === 0;
      const gotCloser = nearBefore != null && nearNow < nearBefore - 1;
      if (isNew || gotCloser) {
        emit(out, {
          t: 'lane_threat', lane: lane.lane, nearestCol: nearNow,
          count: lane.zombies, walls: lane.walls, shooters: lane.shooters,
          detail: `最近僵尸 c${nearNow}${isNew ? '（新来）' : ''} 墙${lane.walls || 0} 输出${lane.shooters || 0}`,
        }, now);
      }
    }

    const prevCards = new Map((prev.cards || []).map((c) => [c.type, c.ready]));
    const nowReady = (state.cards || []).filter((c) => c.ready && prevCards.get(c.type) === false).map((c) => c.type);
    if (nowReady.length) emit(out, { t: 'card_ready', types: nowReady, detail: nowReady.join(',') }, now);

    const prevTypes = new Set((prev.zombies || []).map((z) => z.type));
    const newTypes = [...new Set((state.zombies || []).map((z) => z.type))].filter((t) => !prevTypes.has(t));
    if (newTypes.length) emit(out, { t: 'zombie_new', types: newTypes, detail: newTypes.join(',') }, now);

    const prevTasks = new Map((prev.tasks || []).map((t) => [t.key, t]));
    for (const t of state.tasks || []) {
      const before = prevTasks.get(t.key);
      if (t.completed && before && !before.completed) emit(out, { t: 'task_done', detail: t.tip }, now);
      if (t.failed && before && !before.failed) emit(out, { t: 'task_failed', detail: t.tip }, now);
      if (t.urgent && !(before && before.urgent)) emit(out, { t: 'task_urgent', detail: t.hint || t.tip }, now);
    }

    if (state.phase === 'won' && prev.phase !== 'won') emit(out, { t: 'level_won', detail: '关卡胜利' }, now);
    if (state.phase === 'lost' && prev.phase !== 'lost') emit(out, { t: 'level_lost', detail: '关卡失败' }, now);

    prev = state;
    return out;
  }

  function sample() {
    let s = null;
    try { s = snapshot(); } catch { return; }
    if (!s || s.ok === false) return;
    let evs = [];
    try { evs = push(s); } catch { evs = []; }
    if (!evs.length) return;
    queue.push(...evs);
    if (queue.length > 200) {
      dropped += queue.length - 200;
      queue.splice(0, queue.length - 200);
    }
  }

  function setEventSampler(ms) {
    interval = Math.max(50, Math.min(1000, Number(ms) || 100));
    if (timer) { clearInterval(timer); timer = null; }
    timer = setInterval(sample, interval);
    return { ok: true, interval };
  }

  function events(limit) {
    const max = Math.max(1, Math.min(200, Number(limit) || 200));
    return queue.splice(0, max);
  }

  function pollEvents(limit) {
    sample();
    return events(limit);
  }

  function status() {
    return { ok: true, interval, pending: queue.length, dropped, debounceMs };
  }

  function reset() {
    prev = null;
    lastAt.clear();
    queue.length = 0;
    dropped = 0;
  }

  function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { push, sample, events, pollEvents, status, reset, dispose, setEventSampler };
}
