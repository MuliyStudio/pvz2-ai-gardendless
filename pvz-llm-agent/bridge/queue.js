/**
 * queue：模型写任务，本地按节拍执行“可行性”。
 *
 * 这里不做策略：种什么、哪一行、什么顺序都由模型在 plan.queue 里给出。
 * 本地只做三件事：
 *  1. 按 tick 读取实时局面；
 *  2. 用 cond（阳光/波次/僵尸/空格/无墙/无输出）判断任务是否可执行；
 *  3. 调 actions.act 执行；遇到 COOLDOWN/SUN/占格就跳过，继续试下一条任务。
 *
 * 这样模型不用为每一株植物等一次往返，冷却/阳光/落地时间由本地吃掉。
 */

const DEFAULT_TICK_MS = 450;
const MAX_TASKS = 32;
// 一拍里最多连发几个动作：不同卡、不同格可以背靠背执行（游戏里都是即时点击，
// 没有真正的多线程）；同卡仍受种子冷却限制，不会在一拍里重复种。
const MAX_ACTIONS_PER_TICK = 4;

const qNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const qNow = () => Date.now();

function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  const type = String(t.type || 'plant');
  if (!['plant', 'replace', 'shovel', 'plant_food', 'activate'].includes(type)) return null;
  const task = { ...t, type };
  if (t.id != null) task.id = String(t.id).slice(0, 64);
  if (t.plant != null) task.plant = String(t.plant);
  if (t.card != null) task.card = qNum(t.card);
  if (t.lane != null) task.lane = (typeof t.lane === 'string' ? t.lane : qNum(t.lane));
  if (t.column != null) task.column = (typeof t.column === 'string' ? t.column : qNum(t.column));
  if (t.cond && typeof t.cond === 'object') task.cond = t.cond;
  if (t.repeat === true) task.repeat = true;
  if (t.validForSec != null) task.validForSec = Math.max(0, Number(t.validForSec) || 0);
  if (t.deadline != null) task.deadline = t.deadline;
  if (t.stateVersion != null) task.stateVersion = String(t.stateVersion).slice(0, 64);
  if (t.onFail != null) task.onFail = String(t.onFail) === 'skip' ? 'skip' : 'retry';
  if (t.priority != null) task.priority = Number(t.priority) || 0;
  task.tag = t.tag ? String(t.tag).slice(0, 80) : null;
  return task;
}

function taskKey(task, i) {
  if (task.id) return `id:${task.id}`;
  return `${i}:${task.type}:${task.plant || task.card || ''}:${task.lane}:${task.column}`;
}

function expiresAtOf(task, now) {
  if (task.validForSec != null) return now + Math.max(0, Number(task.validForSec) || 0) * 1000;
  if (task.deadline == null) return null;
  const n = Number(task.deadline);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(task.deadline));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 把任务里的 lane/column 解析成游戏坐标。只做几何映射，不选卡。
 * lane: 0-4 | danger | protect
 * column: 0-8 | ahead | safe | back
 */
function resolvePosition(task, s) {
  let lane = qNum(task.lane);
  if (lane == null && task.lane === 'danger') {
    const lanes = (s.lanes || []).filter((l) => l && l.zombies > 0);
    lanes.sort((a, b) => (Number(b.gap) || 0) - (Number(a.gap) || 0)
      || (Number(a.lossIn) || 999) - (Number(b.lossIn) || 999));
    lane = lanes[0] ? Number(lanes[0].lane) : null;
  }
  if (lane == null && task.lane === 'protect') {
    const p = s.brief && s.brief.protect;
    lane = p && Array.isArray(p.unguardedLanes) && p.unguardedLanes.length
      ? Number(p.unguardedLanes[0]) : null;
  }
  // 空中目标行：三叶草/对空救场用；只取第一个 airborne 僵尸所在行。
  if (lane == null && task.lane === 'airborne') {
    const z = (s.zombies || []).find((x) => x && x.airborne === true);
    if (z) lane = Number(z.lane);
  }
  if (lane == null || !Number.isInteger(lane) || lane < 0 || lane > 4) return null;

  let column = qNum(task.column);
  if (column == null && task.column === 'ahead') {
    const l = (s.lanes || [])[lane];
    const front = l && l.front;
    if (!front) return null;
    column = Math.max(0, Math.floor(Number(front.column)) - 1);
  }
  if (column == null && task.column === 'safe') {
    const type = task.plant || (task.card != null && s.cards && s.cards[task.card] ? s.cards[task.card].type : null);
    const m = ((s.brief && s.brief.minePlan) || []).find((x) => x
      && x.lane === lane && (!type || x.card === type));
    column = m && m.latestSafeColumn != null ? Number(m.latestSafeColumn) : null;
  }
  if (column == null && task.column === 'back') column = 0;
  if (column == null || !Number.isInteger(column) || column < 0 || column > 8) return null;
  return { lane, column };
}

function laneInfo(s, lane) {
  return (s.lanes || []).find((l) => Number(l.lane) === Number(lane)) || null;
}

function cellOccupied(s, lane, column) {
  const row = s.board && s.board[lane];
  return !!(row && row.cells && row.cells[column]);
}

// 动态规则（lane:'airborne' / column:'back' 这类）落点不固定：
// 目标格被占时在同行走最近的空格，而不是把整条规则当“永久冲突”丢掉。
function firstEmptyCellInLane(s, lane, prefer) {
  const cols = (s.terrain && s.terrain.columns) || 9;
  const blocked = new Set(((s.blockedCells || []).filter((x) => x.lane === lane)).map((x) => x.column));
  for (let d = 0; d < cols; d++) {
    for (const c of [prefer + d, prefer - d]) {
      if (c < 0 || c >= cols) continue;
      if (blocked.has(c)) continue;
      if (!cellOccupied(s, lane, c)) return c;
    }
  }
  return null;
}

/** 只判断模型写下的 cond；不在这里发明新条件。 */
function conditionsOk(task, s, pos) {
  const c = task.cond || {};
  const l = laneInfo(s, pos.lane) || {};
  if (c.minSun != null && Number(s.sun) < Number(c.minSun)) return false;
  if (c.minPlantFood != null && Number(s.plantFood) < Number(c.minPlantFood)) return false;
  if (c.waveGte != null && Number(s.level && s.level.wave) < Number(c.waveGte)) return false;
  if (c.waveLte != null && Number(s.level && s.level.wave) > Number(c.waveLte)) return false;
  if (c.zombieInLane === true && !(Number(l.zombies) > 0)) return false;
  if (c.zombieInLane === false && Number(l.zombies) > 0) return false;
  // 空中目标：三叶草这类窗口只有 0.5–1s 的卡，交给本地队列抢帧，比等模型快。
  if (c.airborne === true && !(s.zombies || []).some((z) => z && z.airborne === true)) return false;
  if (c.airborne === false && (s.zombies || []).some((z) => z && z.airborne === true)) return false;
  if (c.zombieType != null) {
    const t = String(c.zombieType);
    if (!(s.zombies || []).some((z) => z && String(z.type) === t)) return false;
  }
  if (c.cardReady != null) {
    const t = String(c.cardReady);
    const list = (s.cards || []).concat((s.conveyor && s.conveyor.cards) || []);
    const card = list.find((x) => x && String(x.type) === t);
    if (!card || !card.ready) return false;
  }
  // 接触/踩踏型保护关：最短“还有几秒被碰到”，用于提前挡/秒杀。
  if (c.protectContactLt != null) {
    const cells = (s.brief && s.brief.protect && s.brief.protect.cells) || [];
    const min = cells.reduce((m, x) => (x && x.contactInSec != null ? Math.min(m, Number(x.contactInSec)) : m), Infinity);
    if (!(min <= Number(c.protectContactLt))) return false;
  }
  if (c.zombieColumnLt != null) {
    if (!(l.nearestZombie != null && Number(l.nearestZombie) < Number(c.zombieColumnLt))) return false;
  }
  if (c.noWall === true && Number(l.walls) > 0) return false;
  if (c.noShooter === true && Number(l.shooters) > 0) return false;
  if (c.cellEmpty === true && cellOccupied(s, pos.lane, pos.column)) return false;
  if (c.cellEmpty === false && !cellOccupied(s, pos.lane, pos.column)) return false;
  // 只有“波次计数到底 + 残敌不多”的收尾阶段才阻止往空行继续铺，
  // 避免旧队列在通关后还把钱花在空行。正常波次里场上任何位置有僵尸，
  // 都不该连带禁止其他空行预布防（否则会等到僵尸进门才开始补墙/补输出）。
  // 收尾阶段确实想预布防，写 cond.allowIdleLane=true。
  const residual = Number(s.brief && s.brief.residual && s.brief.residual.count) || 0;
  const waveDone = !!(s.brief && s.brief.wave && s.brief.wave.done);
  const cleanup = waveDone && residual > 0 && residual <= 6;
  if ((task.type === 'plant' || task.type === 'replace')
    && cleanup && Number(l.zombies) === 0 && c.allowIdleLane !== true) return false;
  return true;
}

function taskCardType(task, s) {
  if (task.plant) return String(task.plant);
  if (task.card != null && s && Array.isArray(s.cards) && s.cards[task.card]) {
    return String(s.cards[task.card].type || '');
  }
  return null;
}

function actionOf(task, pos, s) {
  const a = {
    type: task.type, lane: pos.lane, column: pos.column,
  };
  if (task.type === 'plant' || task.type === 'replace') {
    if (task.plant) a.plant = task.plant;
    else if (task.card != null) {
      // 兜底：入队时还没选卡、没解析出 codename 的话，执行时按当前卡槽解析，
      // 避免选卡后 card 下标漂移直接 NO_CARD。
      const c = s && Array.isArray(s.cards) ? s.cards[Number(task.card)] : null;
      if (c && c.type) a.plant = c.type;
      else a.card = task.card;
    }
  }
  if (task.type === 'plant_food' && task.force === true) a.force = true;
  if (task.type === 'activate') {
    if (task.targetLane != null) a.targetLane = qNum(task.targetLane);
    if (task.targetColumn != null) a.targetColumn = qNum(task.targetColumn);
  }
  if (task.type === 'shovel' && task.expect) a.expect = task.expect;
  return a;
}

export function createActionQueue({ reader, actions, onAction = null } = {}) {
  let tasks = [];
  let tickMs = DEFAULT_TICK_MS;
  let timer = null;
  let busy = false;
  let pausedUntil = 0;
  let lastActionAt = 0;
  let lastResult = null;
  let history = [];
  let blocked = new Map();
  let blockedCards = new Map();
  let doneIds = new Set();
  // 模型思考期间：普通队列任务暂停，只有 urgent 的本地规则（三叶草等短窗口救场）继续执行。
  // 否则队列会在模型算阳光的同时花掉阳光，模型下一轮按过期数值决策。
  let thinking = false;
  let stats = { ticks: 0, actions: 0, failures: 0, done: 0, expired: 0, stale: 0, skipped: 0, paused: 0, adjusted: 0 };

  function setThinking(v) { thinking = !!v; }

  function status() {
    return {
      ok: true,
      enabled: tasks.length > 0,
      tickMs,
      pending: tasks.length,
      paused: qNow() < pausedUntil,
      thinking,
      lastActionAt: lastActionAt || null,
      lastResult,
      stats: { ...stats },
      tasks: tasks.slice(0, 8).map((t) => ({
        id: t.id || null, type: t.type, plant: t.plant || null,
        card: t.card != null ? t.card : null,
        lane: t.lane, column: t.column, tag: t.tag, cond: t.cond || null,
        priority: t.priority != null ? t.priority : null,
        stateVersion: t.stateVersion || null,
        expiresAt: t.expiresAt || null,
        onFail: t.onFail || 'retry',
      })),
      history: history.slice(-8),
      recentSunSpent: history
        .filter((h) => h && h.sunSpent != null && (Date.now() - Date.parse(h.at)) < 8000)
        .reduce((sum, h) => sum + Number(h.sunSpent || 0), 0),
    };
  }

  function stopTimer() {
    if (timer) {
      try { clearInterval(timer); } catch { /* ignore */ }
      timer = null;
    }
  }

  function startTimer() {
    if (timer || !tasks.length) return;
    timer = setInterval(tick, tickMs);
    // Node 测试里不要把进程吊住；浏览器没有 unref。
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch { /* ignore */ }
  }

  function setTasks(list, opts = {}) {
    const now = qNow();
    const next = (Array.isArray(list) ? list : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS);
    // 优先级只按模型写的 priority 排；同优先级保持模型原始顺序。
    const ordered = next.map((t, i) => ({ t, i }))
      .sort((a, b) => (Number(b.t.priority) || 0) - (Number(a.t.priority) || 0) || a.i - b.i)
      .map(({ t }) => ({ ...t, expiresAt: expiresAtOf(t, now) }));
    tasks = ordered;
    blocked = new Map();
    blockedCards = new Map();
    if (opts.tickMs != null) tickMs = Math.max(200, Math.min(2000, Number(opts.tickMs) || DEFAULT_TICK_MS));
    if (opts.pausedUntil != null) pausedUntil = Number(opts.pausedUntil) || 0;
    stopTimer();
    if (tasks.length) startTimer();
    else tasks = [];
    return { ok: true, count: tasks.length, tickMs };
  }

  function clear() {
    stopTimer();
    tasks = [];
    blocked = new Map();
    blockedCards = new Map();
    doneIds = new Set();
    return { ok: true, cleared: true };
  }

  function pause(ms = 1500) {
    pausedUntil = Math.max(pausedUntil, qNow() + Math.max(0, Number(ms) || 0));
    stats.paused += 1;
    return { ok: true, pausedUntil };
  }

  async function tick() {
    if (busy || !tasks.length) return;
    if (qNow() < pausedUntil) return;
    busy = true;
    stats.ticks += 1;
    try {
      const s = reader.snapshot();
      if (!s || s.ok === false || s.phase !== 'running') return;
      const noteSkip = (task, code, detail) => {
        lastResult = {
          at: new Date().toISOString(), key: taskKey(task, 0), action: null, ok: false,
          code, detail: detail || null,
        };
        history.push(lastResult);
        if (history.length > 30) history.shift();
      };
      // 同一拍里已经发过的卡/格：不同卡可以连发，同卡要等种子冷却，同格会互相覆盖。
      const usedCards = new Set();
      const usedCells = new Set();
      const pendingCells = [];
      let executed = 0;
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!task) continue;
        // 模型思考期间只跑 urgent 规则（短窗口救场），普通建造任务等模型行动后再执行，
        // 避免“模型看到 100 阳光、队列先花掉、动作报 SUN 只剩 25”的过期决策。
        if (thinking && task.urgent !== true) continue;
        const key = taskKey(task, i);
        const now = qNow();
        // 过期 / 重复 id / 模型基于旧局面写的任务：直接丢弃，不再重试。
        if (task.expiresAt != null && now > Number(task.expiresAt)) {
          tasks.splice(i, 1); i -= 1;
          stats.expired += 1;
          noteSkip(task, 'TASK_EXPIRED', '任务已超过 validForSec/deadline');
          continue;
        }
        if (task.id && task.repeat !== true && doneIds.has(task.id)) {
          tasks.splice(i, 1); i -= 1;
          stats.skipped += 1;
          noteSkip(task, 'TASK_DONE', '同一 id 已执行过，跳过重复提交');
          continue;
        }
        // 只拦“换关/换模式”导致的旧任务；同一关换波不算 stale，交给 validForSec/cond。
        // 模型经常把 stateVersion 抄短（"1"、或把 "1167gff" 写成 "1167"），
        // 这种不完整的值不应该让整条任务作废：长度 <4 视为没写，前缀匹配视为同一局面。
        if (task.stateVersion && s.stateVersion) {
          const sv = String(task.stateVersion);
          const cur = String(s.stateVersion);
          const truncated = sv.length < 4 || (sv.length >= 4 && cur.startsWith(sv));
          if (sv !== cur && !truncated) {
            tasks.splice(i, 1); i -= 1;
            stats.stale += 1;
            noteSkip(task, 'STALE_ACTION', `任务属于旧关卡/模式 ${sv}，当前 ${cur}`);
            continue;
          }
        }
        const until = blocked.get(key) || 0;
        if (now < until) continue;
        const cardType = taskCardType(task, s);
        // 同一张卡在冷却时，整张卡的任务都先跳过；否则会在同一拍里连撞 5 次 COOLDOWN。
        if (cardType && ['plant', 'replace'].includes(task.type)
          && now < (blockedCards.get(cardType) || 0)) continue;
        const pos = resolvePosition(task, s);
        if (!pos) continue;
        // 关键字落点（lane:'airborne' / column:'back'|'ahead'|'safe'）是“就近找个能种的位置”，
        // 不是固定格：被占时自动挪到同行空格，避免规则触发一次就因 TASK_OCCUPIED 被删掉。
        if (task.type === 'plant' && (typeof task.column === 'string' || task.lane === 'airborne')
          && cellOccupied(s, pos.lane, pos.column)) {
          const alt = firstEmptyCellInLane(s, pos.lane, pos.column);
          if (alt == null) continue;
          pos.column = alt;
        }
        // 同一拍内：同一格不重复种/铲；同一张卡不连发（种子冷却在第一次种植后立即开始）。
        if (usedCells.has(`${pos.lane}:${pos.column}`)) continue;
        if (cardType && ['plant', 'replace'].includes(task.type) && usedCards.has(cardType)) continue;
        // 目标格已经是同一种植物：这条任务已经完成，直接移除。
        // 否则带 cond.cellEmpty:true 的重复任务会一直 pending，卡住 queue 空提醒。
        if (task.type === 'plant' && cellOccupied(s, pos.lane, pos.column)) {
          const currentType = s.board && s.board[pos.lane] && s.board[pos.lane].cells
            ? s.board[pos.lane].cells[pos.column] : null;
          const wantType = task.plant || taskCardType(task, s);
          if (currentType && wantType && String(currentType) === String(wantType)) {
            if (task.id) doneIds.add(task.id);
            tasks.splice(i, 1); i -= 1;
            stats.done += 1;
            noteSkip(task, 'TASK_ALREADY_PLANTED', `目标格 ${pos.lane},${pos.column} 已经有 ${currentType}`);
            continue;
          }
        }
        // plant 打到已有植物的格子：没有显式 cellEmpty 条件时是永久冲突，直接丢弃，
        // 不要每 2.5 秒撞一次 OCCUPIED；要换植必须由模型写 replace。
        if (task.type === 'plant' && cellOccupied(s, pos.lane, pos.column)
          && !(task.cond && task.cond.cellEmpty === true)) {
          tasks.splice(i, 1); i -= 1;
          stats.skipped += 1;
          noteSkip(task, 'TASK_OCCUPIED', `目标格 ${pos.lane},${pos.column} 已有植物，plant 任务丢弃`);
          continue;
        }
        if (!conditionsOk(task, s, pos)) continue;
        if (task.oncePerWave && task._doneWave === (Number(s.level && s.level.wave) || 0)) continue;
        const action = actionOf(task, pos, s);
        let r = null;
        try {
          // 一拍可能连发多株：先全部发起，结束这一拍前统一等一次落地，
          // 不要每株各等 1500ms（那会把 4 株的一拍拖成 6 秒）。
          r = await actions.act(action, { deferSettle: true });
        } catch (e) {
          r = { ok: false, code: 'ACT_THREW', reason: String(e && e.message || e) };
        }
        if (r && r.pending) pendingCells.push({ lane: pos.lane, column: pos.column });
        const ok = !!(r && (r.ok || r.pending));
        // 记录这一拍花了多少阳光：模型下一轮看到 queue.history 就能对账，
        // 不会再把“队列花掉的阳光”误判成“阳光被自动收走”。
        let sunSpent = null;
        if (ok && (task.type === 'plant' || task.type === 'replace') && taskCardType(task, s)) {
          const t = taskCardType(task, s);
          const card = (s.cards || []).concat((s.conveyor && s.conveyor.cards) || []).find((x) => x && String(x.type) === t);
          if (card && card.cost != null) sunSpent = Number(card.cost);
        }
        lastResult = {
          at: new Date().toISOString(), key, action, ok,
          code: (r && r.code) || null, detail: (r && r.detail) || (r && r.reason) || null,
          sunSpent,
        };
        history.push(lastResult);
        if (history.length > 30) history.shift();
        if (ok) {
          stats.actions += 1;
          lastActionAt = qNow();
          executed += 1;
          if (cardType) usedCards.add(cardType);
          usedCells.add(`${pos.lane}:${pos.column}`);
          if (task.repeat !== true && task.oncePerWave !== true && task.cooldownSec == null) {
            if (task.id) doneIds.add(task.id);
            tasks.splice(i, 1);
            i -= 1;
            stats.done += 1;
          } else {
            // 规则任务：执行成功后保留，按 oncePerWave / cooldownSec 控制下次触发的时机。
            if (task.oncePerWave) task._doneWave = Number(s.level && s.level.wave) || 0;
            const cool = task.cooldownSec != null ? Math.max(0.4, Number(task.cooldownSec) || 0) * 1000 : 0;
            blocked.set(key, qNow() + Math.max(400, tickMs, cool));
          }
          if (onAction) {
            try { onAction(lastResult); } catch { /* ignore */ }
          }
          // 不同卡、不同格在同一拍里继续执行；到上限或没有任务就结束这一拍。
          if (executed >= MAX_ACTIONS_PER_TICK) break;
          continue;
        }
        stats.failures += 1;
        const code = String((r && r.code) || '');
        // 没阳光/暂停/场景不可用时，后面几条也大概率失败，不该在一拍里全撞一遍。
        if (['SUN', 'PAUSED', 'NO_SCENE', 'NO_CELL'].includes(code)) break;
        // 写死的列在僵尸越过后失败（WALL_TOO_LATE/MINE_TOO_LATE/PLANT_BEHIND_ZOMBIE、
        // 墙后输出/地刺）时，按动作返回的 suggestedColumns 自动改一次列；
        // 这是模型已经授权的同一张卡/同一行，只把落点换到动作层算出来的可用格。
        const adjustCodes = ['WALL_TOO_LATE', 'MINE_TOO_LATE', 'PLANT_BEHIND_ZOMBIE',
          'OUTPUT_IN_FRONT_OF_WALL', 'SPIKE_BEHIND_WALL'];
        const suggestions = Array.isArray(r && r.suggestedColumns) ? r.suggestedColumns
          : (Array.isArray(r && r.behindCells) ? r.behindCells.map((x) => (x && x.column != null ? x.column : x)) : []);
        if (adjustCodes.includes(code) && !task.autoAdjusted
          && /^\d+$/.test(String(task.column)) && suggestions.length) {
          task.column = Number(suggestions[0]);
          task.autoAdjusted = true;
          // 占住新格子，避免同一拍后面的任务也落到这里（并行批处理的竞态）。
          usedCells.add(`${pos.lane}:${task.column}`);
          stats.adjusted += 1;
          lastResult.detail = `${lastResult.detail || code} → 自动改种 c${task.column + 1}`;
          blocked.set(key, qNow() + 250);
          continue;
        }
        if (code === 'COOLDOWN') {
          const wait = Math.max(0.4, Math.min(6, Number(r.retryAfter) || 1)) * 1000;
          blocked.set(key, qNow() + wait);
          if (cardType && ['plant', 'replace'].includes(task.type)) {
            blockedCards.set(cardType, qNow() + wait);
          }
        } else if (code === 'SUN') {
          blocked.set(key, qNow() + 800);
        } else if (['CELL_BLOCKED', 'WALL_TOO_LATE', 'MINE_TOO_LATE', 'OUTPUT_IN_FRONT_OF_WALL', 'SPIKE_BEHIND_WALL', 'PLANT_BEHIND_ZOMBIE'].includes(code)) {
          // 目标格/时机已经不可能靠等待变好：直接丢弃，避免 700 阳光却一直卡在一条坏任务上。
          // 模型会从 state.threatGaps 和 queue 空提醒看到该补什么。
          tasks.splice(i, 1);
          i -= 1;
          stats.skipped += 1;
          continue;
        } else if (code === 'OCCUPIED') {
          blocked.set(key, qNow() + 2500);
        } else if (['CARD_NOT_IN_DECK', 'NO_CARD'].includes(code)) {
          // 卡下标/卡组已经失效：重试不会变好，直接丢弃；模型下一轮按实际 deck 重写。
          tasks.splice(i, 1);
          i -= 1;
          stats.skipped += 1;
          continue;
        } else if (['CARD_UNAVAILABLE', 'NO_PLANT', 'EMPTY', 'NOT_FOODABLE'].includes(code)) {
          blocked.set(key, qNow() + 15000);
        } else if (code === 'FOOD_NO_TARGET' || code === 'NO_FOOD') {
          blocked.set(key, qNow() + 1200);
        } else {
          blocked.set(key, qNow() + 1200);
        }
        // onFail=skip：这一条失败后直接丢弃，不再每拍重试；默认 retry 保持旧行为。
        if (task.onFail === 'skip') {
          tasks.splice(i, 1);
          i -= 1;
          stats.skipped += 1;
        }
        // 失败后继续试下一条任务：这就是“这张卡冷却就遍历下一个”。
      }
      // 这一拍连发的植物统一等一次落地（最多 900ms），再交给下一拍。
      if (pendingCells.length && typeof actions.settlePending === 'function') {
        try { await actions.settlePending(pendingCells); } catch { /* ignore */ }
      }
    } finally {
      busy = false;
      if (!tasks.length) stopTimer();
    }
  }

  return { setTasks, clear, pause, setThinking, status, tick, dispose: stopTimer };
}
