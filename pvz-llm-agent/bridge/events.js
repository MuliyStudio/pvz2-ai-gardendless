/**
 * events：把两次 snapshot 的差异变成增量事件。
 * 只做变更检测 + 去抖，不做判断。LLM 自己决定这些事件意味着什么。
 */

const keyOf = (e) => `${e.t}:${e.lane == null ? '' : e.lane}:${e.detail || ''}`;

export function createEventStreamApi({ snapshot, onLevelEnd = null, keyOf = null }) {
  const debounceMs = 2500;
  const queue = [];
  const lastAt = new Map();
  let prev = null;
  let dropped = 0;
  let timer = null;
  let interval = 100;
  // 本次挑战的运行记录（跨快照累积，用于关卡结束后写总结）
  let run = null;

  function emit(list, ev, now) {
    const k = keyOf(ev);
    const t = lastAt.get(k) || 0;
    if (now - t < debounceMs) return;
    lastAt.set(k, now);
    list.push({ ...ev, at: new Date(now).toISOString() });
  }

  const RUN_PHASES = new Set(['preparing', 'objective', 'running']);

  function startRun(state, now) {
    // 新一局开始：上一局的事件不该再出现在模型眼前（实测会让模型把旧波次当成本局）
    queue.length = 0;
    dropped = 0;
    lastAt.clear();
    run = {
      key: keyOf ? keyOf(state) : null,
      name: (state.level && state.level.name) || null,
      startedAt: now,
      deck: (state.deck || []).slice(),
      waveCount: (state.level && state.level.waves) || null,
      maxWave: (state.level && state.level.wave) || 0,
      plantsLost: 0,
      mowersLost: 0,
      sunPeak: state.sun == null ? null : state.sun,
      everRunning: false,
    };
  }

  function trackRun(state, now) {
    const phase = state.phase;
    if (!RUN_PHASES.has(phase)) return;
    const key = keyOf ? keyOf(state) : null;
    if (!run || (key && run.key && key !== run.key)) startRun(state, now);
    if (!run) return;
    const deckNow = (state.deck || []).filter(Boolean);
    if (deckNow.length > (run.deck || []).length) run.deck = deckNow.slice(0, 12);
    if (phase === 'running') run.everRunning = true;
    const w = (state.level && state.level.wave) || 0;
    if (w > (run.maxWave || 0)) run.maxWave = w;
    if (state.sun != null && (run.sunPeak == null || state.sun > run.sunPeak)) run.sunPeak = state.sun;
    if (state.level && state.level.waves) run.waveCount = state.level.waves;
  }

  function finishRun(result, state, now) {
    if (!run) return null;
    // 失败那一波的现场快照：不是只记花，任何关卡都能据此复盘。
    const recentEvents = queue.slice(-20);
    // 这一局已经结束：队列里剩下的都是上一局的信号，清掉，避免带到下一局
    queue.length = 0;
    dropped = 0;
    lastAt.clear();
    // 赛后复盘的事实（不含打法建议）：哪一波、怎么结束、经济/损失/压力行
    const lanes = (state && state.lanes) || [];
    const pressure = lanes
      .filter((l) => typeof l.gap === 'number' && l.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 3)
      .map((l) => ({ lane: l.lane, gap: l.gap, lossIn: l.lossIn, dps: l.dps }));
    const protect = (state && state.protectCells) || [];
    const flowerLineCells = protect.filter((c) => c && c.source !== 'tile');
    const flowersDead = flowerLineCells.filter((c) => c.dead).length;
    const deadCells = protect.filter((c) => c && c.dead).map((c) => ({
      lane: c.lane, column: c.column, source: c.source || null, tip: c.tip || null,
    }));
    const lastZombies = ((state && state.zombies) || []).slice(0, 16).map((z) => ({
      type: z.type, name: z.name || null, lane: z.lane, column: z.column, tags: z.tags || [], ehp: z.ehp,
    }));
    const tasks = ((state && state.tasks) || []).map((t) => ({ tip: t.tip, failed: !!t.failed, completed: !!t.completed }));
    const failureSnapshot = state && state.ok !== false ? {
      phase: state.phase,
      level: state.level || null,
      world: state.world || null,
      sun: state.sun != null ? state.sun : null,
      plantFood: state.plantFood != null ? state.plantFood : null,
      limits: state.limits || null,
      prep: state.prep || null,
      tasks,
      objective: state.objective || null,
      missionHints: state.missionHints || null,
      protectCells: protect,
      plants: (state.plants || []).slice(0, 60),
      zombies: lastZombies,
      lanes: state.lanes || null,
      brief: state.brief || null,
      changesSinceLast: state.changesSinceLast || null,
      recentEvents,
    } : null;
    const review = {
      result,
      wave: (state && state.level && state.level.wave) || run.maxWave || null,
      waveCount: (state && state.level && state.level.waves) || run.waveCount || null,
      durationSec: Math.max(0, Math.round((now - run.startedAt) / 1000)),
      sunPeak: run.sunPeak,
      sunEnd: state && state.sun != null ? state.sun : null,
      plantsLost: run.plantsLost,
      mowersLost: run.mowersLost,
      flowers: protect.length ? { total: protect.length, dead: flowersDead, deadKnown: flowerLineCells.length > 0, cells: deadCells } : null,
      lastZombies,
      pressure,
      tasks,
      deck: run.deck,
      snapshot: failureSnapshot,
    };
    const info = {
      key: run.key,
      name: run.name,
      result,
      wave: review.wave,
      waveCount: review.waveCount,
      durationSec: review.durationSec,
      deck: run.deck,
      review,
      facts: {
        maxWave: run.maxWave || null,
        plantsLost: run.plantsLost,
        mowersLost: run.mowersLost,
        sunPeak: run.sunPeak,
        everRunning: run.everRunning,
      },
    };
    run = null;
    try { if (onLevelEnd) onLevelEnd(info); } catch { /* ignore */ }
    return info;
  }

  function push(state, now = Date.now()) {
    const out = [];
    if (!state || state.ok === false) { prev = state; return out; }
    if (!prev || prev.ok === false) { prev = state; return out; }

    trackRun(state, now);

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
        if (run) run.mowersLost += 1;
        emit(out, { t: 'mower_lost', lane: lane.lane, detail: '该行失去推车（再漏一只就输）' }, now);
      }
    }
    for (const p of prev.plants || []) {
      if (!(state.plants || []).some((q) => q.lane === p.lane && q.column === p.column)) {
        if (run) run.plantsLost += 1;
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

    // 关卡结束 → 写一条本关总结（不管输赢）；中途重开/退出也记，方便下次开局前看到。
    if (state.phase === 'won' || state.phase === 'lost') {
      finishRun(state.phase, state, now);
    } else if (prev.phase === 'running' && state.phase === 'preparing') {
      finishRun('restart', state, now);
    } else if (prev.phase === 'running' && (state.phase === 'menu' || state.phase === 'worldmap')) {
      // 有的关卡失败后直接回地图，来不及采样到 lost；用上一帧的关卡输赢标记补判。
      const prevLevel = prev.level || {};
      const result = prevLevel.lost ? 'lost' : (prevLevel.won ? 'won' : 'left');
      finishRun(result, prev, now);
    }

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
    return {
      ok: true, interval, pending: queue.length, dropped, debounceMs,
      run: run ? { key: run.key, wave: run.maxWave, plantsLost: run.plantsLost, mowersLost: run.mowersLost, running: run.everRunning } : null,
    };
  }

  function reset() {
    prev = null;
    run = null;
    lastAt.clear();
    queue.length = 0;
    dropped = 0;
  }

  function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { push, sample, events, pollEvents, status, reset, dispose, setEventSampler };
}
