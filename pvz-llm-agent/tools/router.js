/**
 * router：工具名 → handler。
 *
 * MCP 和游戏内 LLM 客户端调用同一个 router；bridge 可以是异步的（CDP）也可以是同步的（游戏内）。
 * 这里只做参数校验、动作编排、等待和错误归一化，不做任何策略决定。
 */
import { TOOL_NAMES } from './definitions.js';
import { normalizeError } from './errors.js';
import { checkCondition, CONDITION_HELP } from './wait.js';
import { compactState } from './format.js';
import { auditPlan } from '../bridge/plan.js';
import { batchPreflight } from '../bridge/mechanics.js';

const routerSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTION_TYPE_SET = new Set(['plant', 'replace', 'shovel', 'plant_food', 'activate', 'move_cart', 'resume', 'wait', 'restart', 'dismiss_objective', 'collect']);

/**
 * 对比两次 pvz_state，算出"自上次读取以来"的变化。
 *
 * 存在的理由：模型每轮只看到当前快照，历史快照会被 compactOldToolResults 压掉，
 * 所以它无法自己 diff 出"哪株被吃了"。这里由工具直接算好，字段很小，不会被压缩。
 */
function diffSnapshot(prev, cur) {
  if (!prev || !cur || !prev.ok || !cur.ok) return null;
  // 跨 phase / 跨关卡不报 diff，避免把上一局的数据算进来
  if (prev.phase !== cur.phase) return null;
  const pk = (p) => `${p.lane}:${p.column}`;
  const prevPlants = new Map((prev.plants || []).map((p) => [pk(p), p]));
  const curPlants = new Map((cur.plants || []).map((p) => [pk(p), p]));

  const plantsLost = [];
  const plantsAdded = [];
  for (const [k, p] of prevPlants) {
    if (!curPlants.has(k)) plantsLost.push({ lane: p.lane, column: p.column, type: p.type });
  }
  for (const [k, p] of curPlants) {
    if (!prevPlants.has(k)) plantsAdded.push({ lane: p.lane, column: p.column, type: p.type });
  }

  const mowerLost = [];
  for (const lane of cur.lanes || []) {
    const before = (prev.lanes || []).find((l) => l.lane === lane.lane);
    if (before && before.mower !== false && lane.mower === false) mowerLost.push(lane.lane);
  }

  const prevWave = (prev.level && prev.level.wave) || 0;
  const curWave = (cur.level && cur.level.wave) || 0;
  const sunDelta = prev.sun == null || cur.sun == null ? null : cur.sun - prev.sun;
  const zombieDelta = (cur.zombies || []).length - (prev.zombies || []).length;

  const none = !plantsLost.length && !plantsAdded.length && !mowerLost.length
    && curWave === prevWave && !zombieDelta && !sunDelta;

  return {
    none,
    plantsLost,
    plantsAdded,
    mowerLost,
    waveDelta: curWave - prevWave,
    sunDelta,
    zombieDelta,
    plantsLeft: cur.limits ? cur.limits.plantsLeft : null,
  };
}

export function createToolRouter({ bridge, version = '0.1.29', sleep = routerSleep, latency = null }) {
  if (!bridge) throw new Error('createToolRouter 需要 bridge');

  // 上一次 pvz_state 的原始快照，只用于算 changesSinceLast。
  // 仅由 pvz_state 更新，UI 直接调 bridge.snapshot() 不会污染它。
  let lastSeenState = null;
  // 上一轮 pvz_act 已带回的 state：紧接着再调 pvz_state 时直接提示，不重复发几千 token。
  let lastActState = null;
  let lastActStateAt = 0;
  // 同一关在短时间内第二次 briefing（objective 后、选卡前）不重复塞整份事实：
  // 完整内容还在上一条工具结果里，重复一次就是几千 token。
  let lastBriefing = null;

  function briefingKey(b) {
    if (!b || !b.ok || !b.level) return null;
    return b.level.asset || b.level.name || null;
  }

  async function readBriefing() {
    const b = await bridge.briefing();
    const key = briefingKey(b);
    const now = Date.now();
    if (key && lastBriefing && lastBriefing.key === key && now - lastBriefing.at < 30000) {
      return {
        ok: true, version: b.version, phase: b.phase, unchanged: true,
        level: b.level, prep: b.prep, history: b.history, plan: b.plan, planSavedAt: b.planSavedAt,
        note: '本关简报与上一条 pvz_briefing 完全相同（任务/波次/卡池/地形/机制都没变），完整内容见上一条工具结果。直接据此定卡组、写计划、开局，不要重复读。',
      };
    }
    if (key) lastBriefing = { key, at: now };
    return b;
  }

  async function call(name, args = {}) {
    const startedAt = Date.now();
    try {
      return await dispatch(name, args);
    } finally {
      if (latency && typeof latency.recordTool === 'function') {
        try { latency.recordTool(Date.now() - startedAt); } catch { /* ignore */ }
      }
    }
  }

  // 只由模型侧读取状态：带 changesSinceLast 和增量事件。
  // compact=true 去掉棋盘/地形/可种位/图鉴等“简报里已经给过”的大字段，单轮体积能砍一半左右。
  async function readState({ compact = true } = {}) {
    const s = await bridge.snapshot();
    if (s && s.ok) {
      const changes = diffSnapshot(lastSeenState, s);
      if (changes) s.changesSinceLast = changes;
      lastSeenState = s;
      if (typeof bridge.pollEvents === 'function') {
        try {
          const evs = await bridge.pollEvents(40);
          if (Array.isArray(evs) && evs.length) s.events = evs;
        } catch { /* ignore */ }
      }
    }
    return compact ? modelState(s) : s;
  }

  function modelState(s) {
    if (!s || s.ok === false) return s;
    return {
      ok: true, version: s.version, scene: s.scene, phase: s.phase, paused: s.paused,
      sun: s.sun, plantFood: s.plantFood, plantFoodUsable: s.plantFoodUsable, plantFoodUseful: s.plantFoodUseful,
      plantFoodMax: s.plantFoodMax, plantFoodFull: s.plantFoodFull,
      level: s.level, levelKey: s.levelKey, prep: s.prep,
      tasks: s.tasks, objective: s.objective, missionHints: s.missionHints,
      cards: s.cards, deck: s.deck, seedSelection: s.seedSelection,
      plants: s.plants, zombies: s.zombies, lanes: s.lanes,
      protectCells: s.protectCells, brief: s.brief, limits: s.limits,
      plan: s.plan, planSavedAt: s.planSavedAt,
      changesSinceLast: s.changesSinceLast, events: s.events,
      forecast: s.forecast, mechanics: s.mechanics, carts: s.carts,
      startingSun: s.startingSun, collect: s.collect,
    };
  }

  async function dispatch(name, args = {}) {
    try {
      switch (name) {
        case 'pvz_briefing': return await readBriefing();
        case 'pvz_knowledge': return await bridge.knowledge(args || {});
        case 'pvz_state': {
          const force = !!(args && (args.force || args.full));
          if (!force && lastActState && Date.now() - lastActStateAt < 2500) {
            return {
              ok: true, duplicate: true,
              note: '上一轮 pvz_act 已经返回最新 state（含 changesSinceLast/events），直接用那份；本次不重复返回。确实要重读传 full=true 或 force=true。',
              phase: lastActState.phase,
              sun: lastActState.sun,
              plantFood: lastActState.plantFood,
              level: lastActState.level,
              tasks: lastActState.tasks,
              changesSinceLast: lastActState.changesSinceLast,
            };
          }
          return await readState({ compact: !(args && args.full) });
        }
        case 'pvz_events': {
          const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 200));
          const list = typeof bridge.pollEvents === 'function' ? await bridge.pollEvents(limit) : await bridge.events(limit);
          return Array.isArray(list) ? list : [];
        }
        case 'pvz_set_plan': {
          if (!args || !('plan' in args)) return normalizeError('BAD_PLAN', {}, '需要 plan 字段');
          const r = await bridge.setPlan(args.plan);
          if (!r || r.ok === false || !r.plan) return r;
          // 保存后立刻用本关事实审计：缺能力没写 counter、卡组不一致、只有一段文本都会给 warning。
          // 仍然保存计划（模型能看到 warning 再重写），不做本地修正。
          let ctx = {};
          try {
            const s = await bridge.snapshot();
            ctx = {
              coverageGaps: s && s.brief ? s.brief.coverageGaps : null,
              deck: (s && s.seedSelection && s.seedSelection.current) || (s && s.deck) || [],
            };
          } catch { ctx = {}; }
          const audit = auditPlan(r.plan, ctx);
          return { ...r, audit, warnings: audit.warnings };
        }
        case 'pvz_choose_deck': return await chooseDeck(args);
        case 'pvz_start_level': return await startLevel(args);
        case 'pvz_act': return await act(args);
        case 'pvz_wait_until': return await waitUntil(args);        case 'pvz_collect': {
          const r = await bridge.collect();
          return r && r.ok === false ? r : { ok: true, ...r };
        }
        case 'pvz_plant_food': {
          if (!isPos(args)) return normalizeError('BAD_POSITION');
          const r = await bridge.act({ type: 'plant_food', lane: Number(args.lane), column: Number(args.column), force: !!args.force });
          return r;
        }
        case 'pvz_move_cart': {
          if (!args || !Number.isFinite(Number(args.cart))) return normalizeError('NO_CART', {}, '需要 cart');
          const dir = String(args.direction || '').toLowerCase();
          if (dir !== 'up' && dir !== 'down') return normalizeError('CART_BLOCKED', { direction: dir }, 'direction 只能是 up/down');
          return await bridge.moveCart(Number(args.cart), dir);
        }
        case 'pvz_resume': return await bridge.resume();
        case 'pvz_restart': {
          if (typeof bridge.restartLevel !== 'function') return normalizeError('RESTART_UNSUPPORTED', {}, '当前 bridge 不支持重开');
          lastBriefing = null;
          return await bridge.restartLevel();
        }
        case 'pvz_dismiss_objective': {
          lastBriefing = null;
          const r = await bridge.dismissObjective();
          return r;
        }
        case 'pvz_forecast': {
          if (typeof bridge.forecast !== 'function') return normalizeError('UNSUPPORTED', {}, '当前 bridge 没有 forecast');
          const r = await bridge.forecast();
          if (!r || r.ok === false) return r || normalizeError('NO_FORECAST', {}, '没有返回预测');
          const fc = r.forecast;
          if (!fc) return normalizeError('NO_FORECAST', {}, '本关没有波次数据');
          const n = Math.max(0, Math.min(20, Number(args && args.next) || 0));
          if (n > 0) {
            return {
              ok: true, source: fc.source, waveCount: fc.waveCount, dynamic: fc.dynamic,
              waves: (fc.waves || []).slice(0, n), totals: fc.totals, notes: fc.notes,
            };
          }
          return r;
        }
        case 'pvz_level_memory': {
          const a = args || {};
          if (a.all) {
            if (typeof bridge.listLevelMemory !== 'function') return normalizeError('UNSUPPORTED', {}, '当前 bridge 没有 level memory');
            return await bridge.listLevelMemory(Math.max(1, Math.min(100, Number(a.limit) || 30)));
          }
          const lessons = Array.isArray(a.lessons) ? a.lessons.map((s) => String(s)).filter(Boolean).slice(0, 6) : [];
          if (a.note != null || lessons.length) {
            if (typeof bridge.setLevelNote !== 'function') return normalizeError('UNSUPPORTED', {}, '当前 bridge 没有 level memory');
            let w = null;
            if (a.note != null) w = await bridge.setLevelNote(String(a.note), a.key || undefined);
            if (lessons.length) {
              const replace = !!a.replaceLessons && typeof bridge.setLevelLessons === 'function';
              if (!replace && typeof bridge.addLevelLessons !== 'function') return normalizeError('UNSUPPORTED', {}, '当前 bridge 不支持经验记录，请升级 bridge');
              const r = replace
                ? await bridge.setLevelLessons(lessons, a.key || undefined)
                : await bridge.addLevelLessons(lessons, a.key || undefined);
              if (r && r.ok === false) return r;
              w = r && r.key ? r : w;
            }
            if (w && w.ok === false) return w;
            return {
              ok: true, key: w && w.key, saved: true,
              note: a.note != null ? String(a.note) : undefined,
              lessons: lessons.length ? lessons : undefined,
              entry: w && w.entry,
            };
          }
          if (typeof bridge.getLevelMemory !== 'function') return normalizeError('UNSUPPORTED', {}, '当前 bridge 没有 level memory');
          const m = await bridge.getLevelMemory(a.key);
          const limit = Math.max(1, Math.min(10, Number(a.limit) || 4));
          if (m && m.ok && m.entry && Array.isArray(m.entry.runs)) {
            return { ...m, entry: { ...m.entry, runs: m.entry.runs.slice(0, limit) } };
          }
          return m;
        }
        case 'pvz_health': {
          const h = await bridge.health();
          return {
            ...h,
            serverVersion: version,
            namespace: 'pvz-llm-agent',
            tools: TOOL_NAMES,
            expectedTools: TOOL_NAMES.length,
            conditions: CONDITION_HELP,
          };
        }
        default:
          return normalizeError('UNKNOWN_TOOL', { tool: name }, `没有这个工具：${name}`);
      }
    } catch (e) {
      return normalizeError(e && e.code ? e.code : 'BRIDGE_ERROR', { tool: name, ...(e && e.extra ? e.extra : {}) }, String(e && e.message || e));
    }
  }

  function isPos(a) {
    return a && Number.isFinite(Number(a.lane)) && Number.isFinite(Number(a.column));
  }

  // 同一张卡批量落点：按真实冷却 retryAfter 自动等，单次最多阻塞 25 秒，
  // 不把 COOLDOWN 直接甩给模型（同一张卡连种 5 行本来就该等冷却）。
  async function plantCells(action, cards) {
    const cells = action.cells.slice(0, 8);
    const deadline = Date.now() + 25000;
    const perCell = [];
    for (const cell of cells) {
      const lane = Number(cell && cell.lane);
      const column = Number(cell && cell.column);
      if (!Number.isFinite(lane) || !Number.isFinite(column)) {
        perCell.push({ cell, ...normalizeError('BAD_POSITION') });
        continue;
      }
      const one = { ...action, lane, column };
      delete one.cells;
      let r = await bridge.act(one);
      let retries = 0;
      while (r && r.ok === false && r.code === 'COOLDOWN' && retries < 3 && Date.now() < deadline) {
        const secs = Number(r.retryAfter) || 0;
        // 长冷却（墙卡 20s 这类）干等不划算：停手，让模型换张卡补线
        if (secs > 3.5) break;
        await sleep(Math.max(200, secs * 1000) + 120);
        retries += 1;
        r = await bridge.act(one);
      }
      perCell.push({ lane, column, retries, ...(r || normalizeError('ACT_THREW', {}, '没有返回')) });
      if (r && r.ok === false && (r.code === 'SUN' || r.code === 'CARD_NOT_IN_DECK' || r.code === 'NO_CARD' || r.code === 'OCCUPIED')) {
        perCell.push({ ok: false, code: r.code, reason: `后面的格子没再尝试（${r.code}）`, retryable: r.retryable });
        break;
      }
      if (Date.now() >= deadline) {
        perCell.push({ ok: false, code: 'TIMEOUT', reason: '批量种植超过 25 秒，剩下的格子没种', retryable: true });
        break;
      }
    }
    const okCount = perCell.filter((c) => c.ok).length;
    return {
      ok: perCell.length > 0 && perCell.every((c) => c.ok),
      cells: perCell,
      okCount,
      failCount: perCell.length - okCount,
      planted: perCell.filter((c) => c.ok).map((c) => ({ lane: c.lane, column: c.column })),
    };
  }

  async function chooseDeck(args) {
    const cards = args && Array.isArray(args.cards) ? args.cards.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!cards.length) return normalizeError('BAD_DECK', { cards: [] }, 'cards 不能为空');
    const replace = args && args.replace !== false;
    const r = await bridge.chooseDeck(cards, replace);
    if (!r || typeof r !== 'object') return normalizeError('BAD_RESPONSE', {}, '选卡没有返回结果');
    // 卡组变了，下一次 briefing 要重新算 counterGaps，不能命中“和上次相同”的去重。
    lastBriefing = null;
    return r;
  }

  async function startLevel(args) {
    const dismiss = !args || args.dismiss_objective !== false;
    const timeout = Math.max(1, Math.min(20, Number(args && args.timeout) || 8));
    const before = await bridge.snapshot();
    const preplant = !!(before && before.ok && before.prep && before.prep.mode === 'preplant' && !before.prep.gameStarted);
    if (before && before.ok && before.phase === 'running' && !preplant) {
      return { ok: true, started: true, phase: before.phase, elapsed: 0, detail: '已经在战斗中' };
    }
    if (dismiss && before && before.ok && before.objective && before.objective.active) {
      const d = await bridge.dismissObjective();
      if (d && d.ok === false && d.code !== 'NO_OBJECTIVE') return d;
      await sleep(350);
    }
    const r = await bridge.startLevel();
    if (r && r.ok === false && !r.started) return r;
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt <= timeout * 1000) {
      last = await bridge.snapshot();
      const stillPreplant = !!(last && last.ok && last.prep && last.prep.mode === 'preplant' && !last.prep.gameStarted);
      if (last && last.ok && last.phase === 'running' && !stillPreplant) {
        return { ok: true, started: true, phase: last.phase, elapsed: Math.round((Date.now() - startedAt) / 100) / 10, detail: (r && r.detail) || '已开局' };
      }
      if (last && last.ok && (last.phase === 'won' || last.phase === 'lost')) {
        return { ok: true, started: true, phase: last.phase, elapsed: Math.round((Date.now() - startedAt) / 100) / 10, detail: '战斗直接结束' };
      }
      await sleep(300);
    }
    if (last && last.ok && last.phase === 'running' && last.prep && last.prep.mode === 'preplant' && !last.prep.gameStarted) {
      return normalizeError('PREPLANT_NOT_STARTED', {
        phase: last.phase, prep: last.prep,
        hint: '还在提前布阵阶段：阵型可以继续摆；若已经准备好，游戏里可能要点“开始！”按钮，而不是再次调用本工具。',
      }, '提前布阵关还没有进入波次');
    }
    return normalizeError('START_FAILED', {
      started: !!(r && r.started),
      phase: last && last.phase,
      waited: timeout,
      detail: r && r.detail,
      hint: '调用 pvz_state 看 phase；如果还在 preparing，检查卡组是否满、选卡界面是否就绪。',
    }, `开局后 ${timeout}s 内 phase 没有进入 running`);
  }

  async function act(args) {
    const list = args && Array.isArray(args.actions) ? args.actions.slice(0, 6) : [];
    if (!list.length) return normalizeError('NO_ACTIONS');
    // 一轮多个动作时，种植不在每株上等落地：全部发出去后统一等一次，避免 6 个动作串成 9 秒。
    const deferSettle = list.length > 1;
    let state = null;
    try { state = await bridge.snapshot(); } catch { state = null; }
    const cards = (state && state.cards) || [];
    const results = [];
    // 批量预检（纯计算）：同卡长冷却、同格冲突、同批“先种墙再把输出种到墙右侧”。
    // 只跳过不可能成功的动作并如实返回 code，不替模型换卡/换格。
    const pre = batchPreflight({ actions: list, cards, state });
    const preIssues = new Map();
    for (const issue of (pre && pre.issues) || []) {
      if (!preIssues.has(issue.index)) preIssues.set(issue.index, issue);
    }
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] || {};
      const type = String(raw.type || '');
      if (!ACTION_TYPE_SET.has(type)) {
        results.push({ index: i, action: type, type, ...normalizeError('UNKNOWN_ACTION', { type }) });
        continue;
      }
      const issue = preIssues.get(i);
      if (issue) {
        results.push({ index: i, action: type, type, ok: false, ...issue });
        continue;
      }
      if (type === 'wait') {
        const sec = Math.max(0, Math.min(15, Number(raw.seconds) || 0));
        if (sec > 0) await sleep(sec * 1000);
        results.push({ index: i, action: type, type, ok: true, seconds: sec, detail: sec ? `等待 ${sec}s` : '等待' });
        continue;
      }
      const a = { ...raw, type };
      if (type === 'plant' || type === 'replace') {
        if (!Number.isFinite(Number(a.card)) && !a.plant) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_ACTION', {}, '需要 card（下标）或 plant（codename）') });
          continue;
        }
        if (!Number.isFinite(Number(a.card)) && a.plant) {
          const hit = cards.find((c) => String(c.type) === String(a.plant));
          if (!hit) {
            results.push({ index: i, action: type, type, ...normalizeError('CARD_NOT_IN_DECK', { plant: a.plant, deck: cards.map((c) => c.type) }) });
            continue;
          }
          a.card = hit.index;
        }
        // cells：同一张卡按冷却排队种到多个格子。冷却期用 retryAfter 等，不把 COOLDOWN 直接甩给模型。
        if (Array.isArray(a.cells) && a.cells.length) {
          results.push({ index: i, action: type, type, ...(await plantCells(a, cards)) });
          continue;
        }
        if (!isPos(a)) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_POSITION') });
          continue;
        }
        a.lane = Number(a.lane);
        a.column = Number(a.column);
      }
      if (type === 'shovel' || type === 'plant_food' || type === 'activate') {
        if (!isPos(a)) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_POSITION') });
          continue;
        }
        a.lane = Number(a.lane);
        a.column = Number(a.column);
        if (type === 'activate' && (a.targetLane != null || a.targetColumn != null)) {
          if (!Number.isFinite(Number(a.targetLane)) || !Number.isFinite(Number(a.targetColumn))) {
            results.push({ index: i, action: type, type, ...normalizeError('NO_TARGET', {}, 'targetLane/targetColumn 必须同时是数字') });
            continue;
          }
          a.targetLane = Number(a.targetLane);
          a.targetColumn = Number(a.targetColumn);
        }
        if (type === 'plant_food') a.force = !!a.force;
      }
      if (type === 'move_cart') {
        if (!Number.isFinite(Number(a.cart))) {
          results.push({ index: i, action: type, type, ...normalizeError('NO_CART', {}, '需要 cart') });
          continue;
        }
        a.cart = Number(a.cart);
      }
      let r;
      try {
        r = await bridge.act(a, { deferSettle });
      } catch (e) {
        r = normalizeError('ACT_THREW', {}, String(e && e.message || e));
      }
      // 同一张卡在一批动作里会出现两次：短冷却（≤3.5s）自动等，长冷却直接返回让模型换卡。
      // 20 秒的墙卡在这里干等，等于把整轮节奏晾死。
      if (r && r.ok === false && r.code === 'COOLDOWN') {
        const budget = Date.now() + 20000;
        for (let retry = 0; retry < 2 && r && r.code === 'COOLDOWN' && Date.now() < budget; retry++) {
          const secs = Number(r.retryAfter) || 0;
          if (secs > 3.5) break;
          await sleep(Math.max(200, secs * 1000) + 120);
          try { r = await bridge.act(a, { deferSettle }); } catch (e) { r = normalizeError('ACT_THREW', {}, String(e && e.message || e)); }
        }
      }
      results.push({ index: i, action: type, ...(r || normalizeError('ACT_THREW', {}, '没有返回')) });
    }
    // 批量种植统一等一次落地；单动作仍由动作自己等，保持原来的真实返回。
    if (deferSettle) await settlePendingPlants(results);
    // 动作后直接把最新状态带回去：下一轮不用再单独 pvz_state，省掉一半模型往返。
    let stateNow = null;
    try { stateNow = await readState({ compact: true }); } catch { stateNow = null; }
    if (stateNow && stateNow.ok !== false) {
      lastActState = stateNow;
      lastActStateAt = Date.now();
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
      state: stateNow,
    };
  }

  async function settlePendingPlants(results) {
    const pending = (results || []).filter((r) => r && r.ok && r.pending && Number.isFinite(r.lane) && Number.isFinite(r.column));
    if (!pending.length) return;
    const deadline = Date.now() + 1800;
    const done = new Set();
    while (Date.now() < deadline) {
      let snap = null;
      try { snap = await bridge.snapshot(); } catch { snap = null; }
      const cells = new Set(((snap && snap.plants) || []).map((p) => `${p.lane}:${p.column}`));
      for (const r of pending) {
        const key = `${r.lane}:${r.column}`;
        if (done.has(key) || !cells.has(key)) continue;
        done.add(key);
        r.pending = false;
        r.settled = true;
        r.detail = `${r.type || '植物'} 已落地 @ ${r.lane},${r.column}`;
      }
      if (done.size >= pending.length) break;
      await sleep(120);
    }
    for (const r of pending) {
      if (!r.settled) r.detail = `${r.type || '植物'} 已发起，等待落地（下一轮 pvz_state 确认，不要立刻重种）`;
    }
  }

  async function waitUntil(args) {
    const cond = String((args && args.until) || '').trim();
    const timeout = Math.max(1, Math.min(60, Number(args && args.timeout) || 15));
    if (!cond) return normalizeError('BAD_CONDITION', { help: CONDITION_HELP }, 'until 不能为空');
    const startedAt = Date.now();
    let last = null;
    let firstCheck = null;
    while (Date.now() - startedAt <= timeout * 1000) {
      try {
        last = await bridge.snapshot();
      } catch (e) {
        last = { ok: false, code: 'BRIDGE_ERROR', reason: String(e && e.message || e) };
      }
      if (last && last.ok !== false) {
        const r = checkCondition(last, cond);
        firstCheck = firstCheck || r;
        if (!r.ok) return normalizeError('BAD_CONDITION', { condition: cond, help: CONDITION_HELP }, r.reason);
        if (r.hit) {
          return {
            ok: true, satisfied: true, condition: cond,
            elapsed: Math.round((Date.now() - startedAt) / 100) / 10,
            match: r,
            state: compactState(last),
            tip: '下次把 wait 动作放进 pvz_act（1–6 个动作），可省掉这一轮单独的模型往返。',
          };
        }
      }
      await sleep(250);
    }
    return normalizeError('TIMEOUT', {
      satisfied: false, condition: cond,
      elapsed: Math.round((Date.now() - startedAt) / 100) / 10,
      state: last && last.ok ? compactState(last) : null,
      check: firstCheck,
      tip: '下次把 wait 动作放进 pvz_act，可省掉这一轮单独的模型往返。',
    }, `等待 ${timeout}s 后条件仍未满足`);
  }

  return { call, names: TOOL_NAMES };
}
