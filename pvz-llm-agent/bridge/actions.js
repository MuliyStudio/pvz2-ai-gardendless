/**
 * actions：只执行 LLM 指定的动作，并把游戏的真实结果原样返回。
 *
 * 不补卡、不换卡、不改 LLM 的卡组；选卡只做校验 + 逐张执行 + 等待 UI 同步。
 */
import { plantFoodTargets } from '../knowledge/plant-rules.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanType = (t) => String(t || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();

// 点击类植物的触发入口候选名：游戏版本不同，方法名不一样，按顺序试。
const ACTIVATE_METHODS = ['activate', 'fire', 'launch', 'useSkill', 'onTap', 'onClick', 'click', 'doClick', 'trigger', 'triggerSkill'];

async function waitFor(fn, timeoutMs = 800, intervalMs = 50) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try { if (fn()) return true; } catch { /* keep polling */ }
    await sleep(intervalMs);
  }
  try { return !!fn(); } catch { return false; }
}

/** 本行最近的僵尸列（只读事实；读不到返回 null）。 */
function nearestZombieCol(C, lane) {
  try {
    const laneObj = C.getLane ? C.getLane(lane) : null;
    if (!laneObj) return null;
    const pool = [].concat(
      laneObj.zombiePool ? laneObj.zombiePool() : [],
      laneObj.hypnoZombiePool ? laneObj.hypnoZombiePool() : [],
    );
    let near = null;
    for (const z of pool) {
      if (!z) continue;
      let alive = true;
      try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
      if (!alive) continue;
      const x = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
      if (Number.isFinite(x) && (near == null || x < near)) near = x;
    }
    return near;
  } catch { return null; }
}

export function createActions({ getCc, findComps, findCompByClass, stats, reader, version }) {
  function fail(code, extra, reason) {
    return { ok: false, code, reason: reason || code, ...(extra || {}) };
  }

  function deckStatus() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!cards || !lvl) return fail('NO_SCENE');
    const phaseState = reader.snapshot();
    const slots = cards.maxSlotCount || 0;
    const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const seed = cards.seedChooser;
    const conveyor = !!(cards.conveyor || (lvl && lvl.conveyorMode));
    return {
      ok: true,
      phase: phaseState.phase,
      gameStarted: !!cards.gameStarted,
      prepReady: !!(seed && slots > 0),
      conveyor,
      slots,
      current,
      gameStartable: typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : null,
      available: seed && Array.isArray(seed.CFs)
        ? seed.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).map((cf) => {
          const type = cleanType(cf.Type);
          const st = stats.plantStatsOf(type);
          return { type, name: (st && st.name) || type, cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0 };
        })
        : [],
    };
  }

  async function dismissObjective() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const obj = findCompByClass(ctxg.scene, 'LevelObjectiveScreen');
    if (!obj) return { ok: true, detail: '没有任务弹窗' };
    if (typeof obj.continue === 'function') {
      try { obj.continue(); return { ok: true, detail: '已关闭任务说明' }; } catch (e) { return fail('DISMISS_FAILED', {}, String(e && e.message || e)); }
    }
    const node = obj.node || null;
    const findNodeByName = (n, name) => {
      if (!n) return null;
      if (n.name === name) return n;
      for (const ch of n.children || []) {
        const hit = findNodeByName(ch, name);
        if (hit) return hit;
      }
      return null;
    };
    const btn = node ? findNodeByName(node, 'ContinueButton') : null;
    if (btn) {
      try { btn.emit('click'); return { ok: true, detail: '已点击继续' }; } catch (e) { return fail('DISMISS_FAILED', {}, String(e && e.message || e)); }
    }
    return fail('CONTINUE_NOT_FOUND', {}, '找不到“继续”按钮');
  }

  async function resume() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const ui = ctxg.map.UIInGame;
    if (!ui || !ui.paused) return { ok: true, detail: '游戏未暂停', paused: false };
    const ps = findCompByClass(ctxg.scene, 'PauseScreen');
    if (ps && typeof ps.resume === 'function') {
      try { ps.resume(); return { ok: true, detail: '继续游戏', paused: false }; } catch { /* fall through */ }
    }
    try { ui.paused = false; } catch { /* ignore */ }
    return { ok: true, detail: '已取消暂停', paused: false };
  }

  async function collect() {
    return reader.collectPickups();
  }

  async function chooseDeck(requested, replace) {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!cards || !lvl) return fail('NO_SCENE');
    if (cards.gameStarted) return fail('ALREADY_STARTED', {}, '战斗已经开始，不能改卡组');
    let phaseNow = null;
    try { phaseNow = reader.snapshot().phase; } catch { phaseNow = null; }
    if (phaseNow === 'objective') {
      // 模型有时会先选卡再关弹窗；这里直接帮它关一次，省掉一轮报错重试。
      try { await dismissObjective(); } catch { /* ignore */ }
      await waitFor(() => {
        try { return reader.snapshot().phase !== 'objective'; } catch { return false; }
      }, 1200);
      try { phaseNow = reader.snapshot().phase; } catch { phaseNow = null; }
      if (phaseNow === 'objective') return fail('PREP_NOT_READY', { phase: phaseNow, retryable: true }, '任务弹窗还没关闭，再试一次');
    }
    if (phaseNow === 'running' || phaseNow === 'won' || phaseNow === 'lost') return fail('ALREADY_STARTED', { phase: phaseNow });
    if (cards.conveyor || (lvl && lvl.conveyorMode)) {
      return { ok: true, conveyor: true, slots: 0, requested: [], applied: [], skipped: [], missing: [], actualDeck: [], full: true, detail: '传送带关卡无需选卡' };
    }
    // 给定/锁定卡组：卡槽已满且没有可选卡（或全部锁定）。不要清空、不要报“缺卡”，原样返回。
    const slotsNow = Number(cards.maxSlotCount) || 0;
    const currentNow = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const lockedNow = (cards.CFs || []).filter((cf) => cf && cf.ca && cf.ca.locked).length;
    const seedUnlocked = cards.seedChooser && Array.isArray(cards.seedChooser.CFs)
      ? cards.seedChooser.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length
      : 0;
    if (slotsNow > 0 && currentNow.length >= slotsNow && (lockedNow >= slotsNow || seedUnlocked === 0)) {
      return {
        ok: true, forced: true, deckLocked: true, slots: slotsNow,
        requested: Array.isArray(requested) ? requested : [], applied: [], skipped: [], missing: [],
        actualDeck: currentNow, full: true,
        detail: '本关卡组由系统给定/锁定，无需也不能换卡；直接 pvz_start_level',
      };
    }
    if (!cards.seedChooser) return fail('PREP_NOT_READY', { retryable: true }, '选卡界面还没准备好');
    const slots = cards.maxSlotCount || 0;
    if (!slots) return fail('NO_SLOTS', { retryable: true }, '当前关卡没有可用卡槽');

    const wantedRaw = Array.isArray(requested) ? requested.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const dupes = [...new Set(wantedRaw.filter((t, i) => wantedRaw.indexOf(t) !== i))];
    if (dupes.length) return fail('BAD_DECK', { duplicates: dupes, slots }, `卡组里有重复卡：${dupes.join(', ')}`);

    const avail = new Map((cards.seedChooser.CFs || [])
      .filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed)))
      .map((cf) => [cleanType(cf.Type), cf]));
    const availableTypes = [...avail.keys()];
    const unknown = wantedRaw.filter((t) => !avail.has(t));
    if (unknown.length) {
      return fail('CARD_NOT_AVAILABLE', { cards: unknown, available: availableTypes, slots }, `这些卡不在本关卡池：${unknown.join(', ')}`);
    }

    const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const base = replace ? [] : current;
    const unique = [...new Set([...base, ...wantedRaw])];
    if (unique.length > slots) {
      return fail('BAD_DECK', { slots, requested: unique, current: base.length ? current : [], count: unique.length }, `卡组 ${unique.length} 张，超过 ${slots} 个卡槽`);
    }
    if (unique.length < slots) {
      const missing = slots - unique.length;
      return fail('DECK_NOT_FULL', {
        slots, have: unique.length, missing, current, requested: wantedRaw,
        hint: `还差 ${missing} 张；本工具不会自动补卡，请补满后再调用`,
      }, `卡组未满（${unique.length}/${slots}），还差 ${missing} 张`);
    }

    // ── 清空（replace=true）──
    let cleared = false;
    let clearIncomplete = [];
    if (replace) {
      if (typeof cards.spliceAllCards === 'function') {
        try { cards.spliceAllCards(); } catch { /* fall through */ }
      }
      cleared = await waitFor(() => cards.CFs.length === 0, 700);
      // spliceAllCards 有时留 1 张，再逐张删；删不掉就如实报告，不偷偷补卡。
      for (let guard = 0; !cleared && guard < slots + 4 && cards.CFs.length; guard++) {
        const cf = cards.CFs[cards.CFs.length - 1];
        const before = cards.CFs.length;
        try { if (typeof cards.removeCard === 'function') cards.removeCard(cf); } catch { /* ignore */ }
        if (!(await waitFor(() => cards.CFs.length < before, 300))) break;
      }
      cleared = await waitFor(() => cards.CFs.length === 0, 500);
      // 有些关卡在清空后会异步回填预设卡（实测会回填 2 张），等一拍再清一次。
      if (cleared) {
        await sleep(350);
        for (let guard = 0; guard < slots + 4 && cards.CFs.length; guard++) {
          const cf = cards.CFs[cards.CFs.length - 1];
          const before = cards.CFs.length;
          try { if (typeof cards.removeCard === 'function') cards.removeCard(cf); } catch { /* ignore */ }
          if (!(await waitFor(() => cards.CFs.length < before, 200))) break;
        }
        cleared = await waitFor(() => cards.CFs.length === 0, 300);
      }
      if (!cleared) {
        clearIncomplete = cards.CFs.map((c) => cleanType(c.Type));
        return fail('DECK_CLEAR_FAILED', {
          clearIncomplete, slots, current: clearIncomplete,
          hint: '旧卡没能清空；可以改用 replace:false 在现有卡组上追加，或先手动清空',
        }, `旧卡组没有清空（剩 ${clearIncomplete.length} 张）`);
      }
    }

    // ── 逐张加卡，每张都等 UI 同步 ──
    const applied = [];
    const skipped = [];
    const already = [];
    const tries = [];
    for (const type of wantedRaw) {
      let now = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
      if (now.includes(type)) { already.push(type); continue; }
      // 清空后又被回填的预设卡：加卡前把不在请求里的卡删掉，腾出真实槽位。
      if (replace && now.length >= slots) {
        for (let guard = 0; guard < slots + 2 && cards.CFs.length >= slots; guard++) {
          const extra = [...cards.CFs].reverse().find((cf) => cf && !wantedRaw.includes(cleanType(cf.Type)));
          if (!extra) break;
          const before = cards.CFs.length;
          try { cards.removeCard(extra); } catch { /* ignore */ }
          if (!(await waitFor(() => cards.CFs.length < before, 200))) break;
        }
        now = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
      }
      if (now.length >= slots) { skipped.push({ type, reason: 'no_slot' }); continue; }
      const before = cards.CFs.length;
      let thrown = null;
      try { cards.addCardByPlantTypeFromSeedbank(type); } catch (e) { thrown = String(e && e.message || e); }
      // 关键：加卡是异步的，必须等 cards.CFs.length 真的 +1，不能只看第一次调用返回。
      const grew = await waitFor(() => cards.CFs.length > before, 900);
      tries.push({ type, before, after: cards.CFs.length, grew });
      if (grew) applied.push(type);
      else skipped.push({ type, reason: thrown ? 'error' : 'rejected', message: thrown || undefined });
      await sleep(60);
    }

    // 最终校验：等 UI 稳定，再读一次真实卡组
    await waitFor(() => cards.CFs.length >= slots, 900);
    const actualDeck = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const missing = wantedRaw.filter((t) => !actualDeck.includes(t));
    const full = actualDeck.length >= slots;
    const result = {
      slots,
      requested: wantedRaw,
      applied,
      already,
      skipped,
      missing,
      actualDeck,
      full,
      clears: tries,
      cleared,
      clearIncomplete: clearIncomplete.length ? clearIncomplete : undefined,
    };

    if (!full) {
      return fail('DECK_NOT_FULL', {
        ...result,
        have: actualDeck.length,
        missingCount: slots - actualDeck.length,
        hint: '没有自动补卡；请检查 skipped 原因后重试',
      }, `选卡后仍是 ${actualDeck.length}/${slots}`);
    }
    if (missing.length) {
      return fail('CARD_SELECT_FAILED', {
        ...result,
        hint: '卡组已满但有指定卡没选中；请核对 actualDeck 后重试',
      }, `这些卡没有选中：${missing.join(', ')}`);
    }
    const warn = (missing.length || skipped.length)
      ? `实际卡组和你请求的不一致：缺 ${missing.join('、') || '无'}；被跳过 ${skipped.map((s) => `${s.type}(${s.reason})`).join('、') || '无'}。以 actualDeck 为准，没带上的卡不要当它有。`
      : undefined;
    return {
      ok: true,
      ...result,
      warning: warn,
      detail: `选卡完成（${actualDeck.length}/${slots}）`,
    };
  }

  async function startLevel() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!lvl || typeof lvl.letsRock !== 'function') return fail('NO_SCENE', {}, '当前场景无法开局');
    if (lvl.gameStarted) return { ok: true, detail: '已经在战斗中', started: true };
    if (cards && cards.seedChooser && !lvl.lastStandPrepareStarted) {
      if (typeof cards.GameStartable === 'function' && !cards.GameStartable()) {
        const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
        return fail('DECK_NOT_FULL', { current, slots: cards.maxSlotCount || 0 }, `卡组还没选满（${current.length}/${cards.maxSlotCount || 0}）`);
      }
    }
    if (lvl.lastStandPrepareStarted && !lvl.gameStarted && typeof lvl.startReadySet === 'function') {
      try { lvl.startReadySet(); return { ok: true, detail: '开始了提前布阵', started: true }; } catch (e) { return fail('START_FAILED', {}, String(e && e.message || e)); }
    }
    try {
      lvl.letsRock();
      return { ok: true, detail: '已开局', started: true };
    } catch (e) {
      // 传送带关的 letsRock 可能在隐藏种子栏 UI 时抛错，但战斗已经启动；交给上层用 phase 复核。
      return fail('START_FAILED', { started: !!(lvl.letsRocked || lvl.gameStarted || (cards && cards.gameStarted)) }, String(e && e.message || e));
    }
  }

  async function moveCart(cartId, direction) {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const { map } = ctxg;
    const ui = map.UIInGame;
    if (ui && ui.paused) return fail('PAUSED', { retryable: true });
    const C = map.Square && map.Square.constructor;
    if (!C) return fail('NO_SCENE');
    const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
    const id = Number(cartId);
    const ref = reader.cartRefs(C, lanes, cols)[id];
    if (!ref) return fail('NO_CART', { cart: id });
    const inL = ref.cart._inLnC;
    const dir = String(direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') return fail('CART_BLOCKED', { cart: id, direction: dir }, 'direction 只能是 up 或 down');
    const target = dir === 'up' ? (inL && inL.upper) : (inL && inL.lower);
    if (!target) return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'no_rail' }, '该方向没有轨道');
    let can = false;
    try { can = !!ref.cart.canMoveToLnC(target); } catch { can = false; }
    if (!can) return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'blocked', from: { lane: ref.lane, column: ref.column }, to: { lane: target.lIndex, column: target.cIndex } });
    const plants = reader.cellPlants(inL).map((p) => cleanType(p.Plant_Type));
    try {
      if (dir === 'up') ref.cart.moveUp(); else ref.cart.moveDown();
    } catch (e) {
      return fail('CART_BLOCKED', { cart: id, direction: dir }, '矿车移动失败：' + (e && e.message ? e.message : e));
    }
    return {
      ok: true, cart: id, direction: dir,
      from: { lane: ref.lane, column: ref.column },
      to: { lane: target.lIndex, column: target.cIndex },
      plants,
      detail: `矿车 #${id} ${dir === 'up' ? '上移' : '下移'}`,
    };
  }

  // 重开本关：走游戏自己的暂停菜单组件（PauseScreen.restart），比点 UI 稳。
  async function restartLevel() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    let before = null;
    try { before = reader.snapshot().phase; } catch { before = null; }
    const ps = findCompByClass(ctxg.scene, 'PauseScreen');
    if (!ps || typeof ps.restart !== 'function') {
      return fail('RESTART_UNSUPPORTED', { phase: before }, '这一关不支持重开（找不到 PauseScreen.restart）');
    }
    try {
      ps.restart();
    } catch (e) {
      return fail('RESTART_FAILED', { phase: before }, '重开失败：' + String(e && e.message || e));
    }
    const ok = await waitFor(() => {
      try {
        const s = reader.snapshot();
        return !!(s && s.ok && (s.phase === 'preparing' || s.phase === 'objective'));
      } catch { return false; }
    }, 8000);
    if (!ok) {
      return {
        ok: false, code: 'RESTART_TIMEOUT', restarted: false, phase: before, retryable: true,
        reason: '重开没有在 8 秒内回到选卡/任务阶段，用 pvz_state 看当前 phase',
      };
    }
    return { ok: true, restarted: true, from: before, phase: 'preparing', detail: '本关已重开（回到选卡阶段）' };
  }

  // 同行还能种的空格（按离目标列的距离排序）：占用/不可种时直接给候选，
  // 省掉"撞一次错误、再想一轮"的往返。
  function emptyCellsInLane(C, lane, wantColumn, cf, limit = 3) {
    const cols = C.ColumnCount || 9;
    const out = [];
    for (let c = 0; c < cols; c++) {
      if (c === wantColumn) continue;
      const cell = C.getLnC(lane, c);
      if (!cell) continue;
      try { if (reader.cellPlants(cell).length) continue; } catch { continue; }
      let ok = true;
      try { ok = cell.putPlantAvailable ? cell.putPlantAvailable(true, cf && cf.ID, true, true, cf && cf.spf) : true; } catch { ok = true; }
      if (ok) out.push({ lane, column: c });
    }
    out.sort((a, b) => Math.abs(a.column - wantColumn) - Math.abs(b.column - wantColumn));
    return out.slice(0, limit);
  }

  // 短手植物的“够得着”距离（格）。返回 null 表示不是短手，远程/整行/抛物不受保护格限制。
  // 只是几何事实：这张卡从这一格出发，能不能碰到站在保护格上的僵尸。
  function shortRangeReach(type) {
    let st = null;
    try { st = stats && stats.plantStatsOf ? stats.plantStatsOf(type) : null; } catch { st = null; }
    if (!st) return null;
    // 新数据直接带可算的列差；防御家族的高射程（花生 4 格）不算“短手”。
    if (st.reach != null) {
      if (String(st.family || '') === 'Defence' && Number(st.reach) > 1) return null;
      return Math.max(0, Math.min(2, Number(st.reach)));
    }
    const rng = String(st.range || '');
    // 先排除远程/整行/多行的标签，避免把“直线”“3 行”误判成短手。
    if (/直线|整行|全屏|多行|多个|抛物|右侧|多重|方阵/.test(rng)) return null;
    if (/接触/.test(rng)) return 0;
    if (/接近|前后|3x3/.test(rng)) return 1;
    const m = /(\d+)\s*格/.exec(rng);
    if (m) return Math.max(0, Math.min(2, Number(m[1])));
    if (String(st.family || '') === 'Melee') return 1;
    return null;
  }

  // 保护格同行的可种空位（优先保护格左右 1 格）：短手放错位置时直接给模型正确答案。
  function guardCellsFor(C, lane, protectCells, limit = 3) {
    const cols = (C && C.ColumnCount) || 9;
    const out = [];
    const seen = new Set();
    for (const p of protectCells) {
      for (const d of [1, 0, -1]) {
        const column = p.column + d;
        if (column < 0 || column >= cols || seen.has(column)) continue;
        seen.add(column);
        const cell = C.getLnC(lane, column);
        if (!cell) continue;
        try { if (reader.cellPlants(cell).length) continue; } catch { /* 读不到就当作可用 */ }
        out.push({ lane, column, protectColumn: p.column, distance: Math.abs(column - p.column) });
      }
    }
    out.sort((a, b) => a.distance - b.distance || b.column - a.column);
    return out.slice(0, limit);
  }

  function wallColumnsInLane(C, lane) {
    const cols = (C && C.ColumnCount) || 9;
    const out = [];
    for (let c = 0; c < cols; c++) {
      const cell = C.getLnC(lane, c);
      if (!cell) continue;
      let ps = [];
      try { ps = reader.cellPlants(cell) || []; } catch { ps = []; }
      for (const p of ps) {
        const t = cleanType(p && p.Plant_Type);
        let st = null;
        try { st = stats.plantStatsOf(t); } catch { st = null; }
        if (/peanut|tallnut|wallnut|holonut|endurian/i.test(t) || (st && String(st.family || '') === 'Defence')) {
          out.push({ column: c, type: t });
        }
      }
    }
    return out;
  }

  async function act(a, opts = {}) {
    const deferSettle = !!(opts && opts.deferSettle);
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const { map } = ctxg;
    const ui = map.UIInGame, cards = map.Cards;
    const C = map.Square && map.Square.constructor;
    if (!a || typeof a !== 'object') return fail('BAD_ACTION');
    if (ui && ui.paused && a.type !== 'resume') return fail('PAUSED', { retryable: true });

    if (a.type === 'resume') return resume();
    if (a.type === 'wait') return { ok: true, detail: '等待' };
    if (a.type === 'dismiss_objective') return dismissObjective();
    if (a.type === 'choose_deck') return chooseDeck(a.cards || a.plants, a.replace);
    if (a.type === 'start_level') return startLevel();
    if (a.type === 'restart') return restartLevel();
    if (a.type === 'collect') return collect();
    if (a.type === 'move_cart') return moveCart(a.cart, a.direction);

    if (!C) return fail('NO_SCENE');
    if (!cards) return fail('NO_SCENE', {}, '卡槽还没加载');
    const cols = C.ColumnCount || 9;

    const lane = Number(a.lane), column = Number(a.column);
    if (!Number.isFinite(lane) || !Number.isFinite(column)) return fail('BAD_POSITION');

    if (a.type === 'plant' || a.type === 'replace') {
      let index = Number(a.card);
      if (!Number.isFinite(index) && a.plant) {
        index = (cards.CFs || []).findIndex((cf) => cleanType(cf.Type) === String(a.plant));
      }
      const cf = cards && cards.CFs && cards.CFs[index];
      if (!cf) return fail('NO_CARD', { card: a.card, plant: a.plant || null });
      const type = cleanType(cf.Type);
      const upper = cards.cardsUIUpper && cards.cardsUIUpper[index];
      const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
      if (cd > 0) return fail('COOLDOWN', { card: index, type, retryAfter: Math.round(cd * 10) / 10 }, `${type} 冷却中 ${cd.toFixed(1)}s${a.type === 'replace' ? '（铲除本身没有冷却；这里是新卡的种子冷却）' : ''}`);
      const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
      const sunNow = map.SunCount ? map.SunCount.CurrentValue : null;
      if (sunNow != null && sunNow < cost && !(cf.ca && cf.ca.free)) return fail('SUN', { card: index, type, need: cost, have: sunNow }, `阳光不足：需要 ${cost}，现有 ${sunNow}`);

      // 三叶草只对空中单位生效；没有 airborne 目标时种下去就是浪费。
      if (/blover/i.test(type)) {
        let air = [];
        try { air = (reader.snapshot().zombies || []).filter((z) => z.airborne); } catch { air = []; }
        if (!air.length) {
          return fail('NO_AIR_TARGET', {
            lane, column, type,
            hint: '现在没有空中目标（airRaid=null）；三叶草只对空中的荡索/小鬼炮有效，落地后种就是浪费。等 airRaid 出现再种，或用菜问/樱桃处理已落地的。',
          }, '三叶草没有空中目标');
        }
      }

      // 保护任务硬约束：保护格本身不能种任何东西；短手离保护格超过射程也够不到。
      const reach = shortRangeReach(type);
      let prot = [];
      if (typeof reader.protectCells === 'function') {
        try { prot = (reader.protectCells() || []).filter((p) => p && !p.dead && p.lane === lane); } catch { prot = []; }
      }
      if (prot.length) {
        const onCell = prot.find((p) => Math.abs(column - p.column) < 0.75);
        if (onCell) {
          const guardCells = guardCellsFor(C, lane, prot);
          const cellText = guardCells.length ? guardCells.map((x) => `c${x.column}`).join('/') : '（保护格旁边没有空位）';
          return fail('PROTECT_CELL_BLOCKED', {
            lane, column, card: index, type,
            protectCells: prot.map((p) => ({ lane: p.lane, column: p.column })),
            guardCells,
            hint: `c${onCell.column} 本身是必须保护的植物，不能种别的；改种 ${cellText}（左侧远程/右侧墙或近战）。`,
          }, `${type} 不能种在保护格 c${onCell.column} 上；改种 ${cellText}`);
        }
        if (reach != null) {
          const nearest = prot.reduce((best, p) => Math.min(best, Math.abs(column - p.column)), Infinity);
          if (nearest > reach) {
            const guardCells = guardCellsFor(C, lane, prot);
            const cellText = guardCells.length
              ? guardCells.map((x) => `c${x.column}`).join('/')
              : '（保护格旁边没有空位，先铲一格或换远程卡）';
            return fail('PROTECT_TOO_FAR', {
              lane, column, card: index, type, reach,
              protectCells: prot.map((p) => ({ lane: p.lane, column: p.column })),
              guardCells,
              hint: `这行有必须保护的植物（c${prot.map((p) => p.column).join('/c')}）。${type} 是短手（最多够到 ${reach} 格），种在 c${column} 离保护格 ${nearest} 格，僵尸啃花时它够不到；改种 ${cellText}，或在保护格左侧放远程输出。`,
            }, `${type} 离保护格 ${nearest} 格，短手够不到；可改种 ${cellText}`);
          }
        }
      }

      // 输出种在本行墙的右侧（僵尸先啃输出再啃墙）：等于把墙白放了。
      // 输出应放墙左侧；没位置就 replace 墙为输出，再把新墙补到右侧。
      let stType = null;
      try { stType = stats.plantStatsOf(type); } catch { stType = null; }
      const isWallType = /peanut|tallnut|wallnut|holonut|endurian/i.test(type)
        || !!(stType && String(stType.family || '') === 'Defence');
      // 地刺类：伤害来自“僵尸走过这一格”，必须种在墙前（右侧），否则僵尸被墙挡住、永远踩不到。
      const isStepDamage = !!(stType && stType.stepDamage);
      const isOutputType = !!(stType && stType.attack && Number(stType.attack.dps) > 0 && !isWallType && !isStepDamage);
      if (isStepDamage) {
        const walls = wallColumnsInLane(C, lane);
        const frontWall = walls.length ? Math.max(...walls.map((w) => w.column)) : null;
        if (frontWall != null && column < frontWall) {
          const frontCells = emptyCellsInLane(C, lane, frontWall, cf, 8)
            .filter((x) => x.column > frontWall)
            .slice(0, 3);
          const frontText = frontCells.length ? frontCells.map((x) => `c${x.column}`).join('/') : '（墙前没有空位）';
          return fail('SPIKE_BEHIND_WALL', {
            lane, column, type,
            wallColumn: frontWall,
            suggestedColumns: frontCells.map((x) => x.column),
            hint: `本行 c${frontWall} 已经有墙。${type} 靠“僵尸走过这一格”造成伤害，种在墙后 c${column} 僵尸会被墙挡住，根本踩不到，等于白种。改种墙前 ${frontText}（僵尸先踩地刺再到墙）；墙前没空位就先铲/换墙，或把地刺种到墙前空行。`,
          }, `${type} 种在墙后 c${column} 打不到僵尸；改种墙前 ${frontText}`);
        }
      }
      if (isOutputType) {
        const walls = wallColumnsInLane(C, lane);
        const frontWall = walls.length ? Math.max(...walls.map((w) => w.column)) : null;
        if (frontWall != null && column > frontWall) {
          const behind = emptyCellsInLane(C, lane, Math.max(0, frontWall - 1), cf, 6)
            .filter((x) => x.column < frontWall)
            .slice(0, 3);
          const wallType = walls.find((w) => w.column === frontWall);
          const behindText = behind.length ? behind.map((x) => `c${x.column}`).join('/') : '（墙后没有空位）';
          return fail('OUTPUT_IN_FRONT_OF_WALL', {
            lane, column, type,
            wallColumn: frontWall,
            wallType: wallType ? wallType.type : null,
            behindCells: behind,
            replaceAt: { lane, column: frontWall },
            hint: `本行 c${frontWall} 已经有墙（${wallType ? wallType.type : '墙'}），你把输出种到 c${column} 在墙右侧，僵尸会先啃输出。改种墙左侧 ${behindText}；如果墙后没位置，先 replace 把 c${frontWall} 换成这株输出，再把新墙补到 c${Math.min(cols - 1, frontWall + 1)}。`,
          }, `${type} 不能种在墙 c${frontWall} 的右侧；改种 ${behindText} 或先 replace 墙`);
        }
      }

      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      if (a.type !== 'replace' && reader.cellPlants(cell).length > 0) {
        const occupants = reader.cellPlants(cell).map((p) => cleanType(p.Plant_Type));
        const alternatives = emptyCellsInLane(C, lane, column, cf);
        return fail('OCCUPIED', {
          lane, column, plants: occupants, alternatives,
          hint: alternatives.length
            ? '同格已有植物（可能是你自己或玩家手动种的）；直接换一格，alternatives 里就是同行空位'
            : '同格已有植物；这一行没有空位了，换行或先铲',
        }, `${lane} 行 ${column} 列已被 ${occupants.join('/') || '植物'} 占用${alternatives.length ? `，可改种 ${alternatives.map((x) => `c${x.column}`).join('/')}` : ''}`);
      }
      if (a.type === 'replace') {
        try { cell.removePlant(); } catch { /* ignore */ }
        // 铲除也是异步的：等格子真的空了，再种新卡，避免把旧植物数量当成新植物已落地。
        await waitFor(() => reader.cellPlants(cell).length === 0, 500);
      }
      let canPlace = true;
      try { canPlace = cell.putPlantAvailable ? cell.putPlantAvailable(true, cf.ID, true, true, cf.spf) : true; } catch { canPlace = true; }
      if (!canPlace) {
        reader.learnCell(lane, column, 'CELL_BLOCKED');
        const alternatives = emptyCellsInLane(C, lane, column, cf);
        const emptied = a.type === 'replace' && reader.cellPlants(cell).length === 0;
        return fail('CELL_BLOCKED', {
          lane, column, card: index, type, alternatives,
          emptyAfterRemoval: emptied || undefined,
          hint: emptied
            ? '旧植物已经被铲掉，这一格现在是空的；换个格子种，或者这一格其实不能种这种卡'
            : (alternatives.length ? '这格不能种（墓碑/水面/障碍）；alternatives 是同行可种位' : '这行没有可种的空位'),
        }, `${lane} 行 ${column} 列不能种${emptied ? '（旧植物已铲掉，现在空着）' : ''}${alternatives.length ? `，可改种 ${alternatives.map((x) => `c${x.column}`).join('/')}` : ''}`);
      }
      if (ui && typeof ui.tryChangingIndex === 'function' && ui.index !== index) {
        ui.tryChangingIndex(index);
        // 等种子栏真正切到目标卡，再发起种植；否则 PlaceUIPlant 可能用旧卡。
        await waitFor(() => Number(ui.index) === index, 120);
      }
      const beforeLen = reader.cellPlants(cell).length;
      const nearZombie = nearestZombieCol(C, lane);
      const suggestedColumn = nearZombie == null ? null : Math.max(0, Math.min(8, Math.floor(nearZombie) - 1));
      const timing = nearZombie == null ? null : {
        nearestZombieColumn: Math.round(nearZombie * 10) / 10,
        targetColumn: column,
        late: nearZombie <= column + 0.25,
        suggestedColumn,
      };
      const lateNote = timing && timing.late
        ? `；⚠ 僵尸已到 c${timing.nearestZombieColumn}，这个落点可能在它身后，下一轮改 c${timing.suggestedColumn} 或往左 1–2 格`
        : '';
      // 土豆雷有出土时间，不是瞬爆：按当前僵尸距离算，来不及就别埋在脸上。
      if (/potatomine/i.test(type) && stType && Number(stType.armTimeSec) > 0) {
        const arm = Number(stType.armTimeSec);
        let minEta = null;
        let closest = null;
        try {
          const snap = reader.snapshot();
          for (const z of (snap.zombies || [])) {
            if (z.lane !== lane) continue;
            const speed = Number(z.speed) > 0 ? Number(z.speed) : 0.18;
            const eta = (Number(z.column) - column) / speed;
            if (minEta == null || eta < minEta) { minEta = eta; closest = z; }
          }
        } catch { /* ignore */ }
        if (minEta != null && minEta < arm + 1) {
          const needCol = closest ? Math.max(0, Math.floor(Number(closest.column) - arm * 0.2)) : null;
          return fail('MINE_TOO_LATE', {
            lane, column, type, armTimeSec: arm,
            nearestZombieColumn: closest ? closest.column : null,
            etaSec: Math.round(minEta * 10) / 10,
            suggestedColumn: needCol,
            hint: `土豆地雷需要 ${arm} 秒出土，按当前僵尸速度只剩 ${Math.round(minEta * 10) / 10} 秒，埋在 c${column} 来不及。改种樱桃/倭瓜，或提前埋到 c${needCol != null ? needCol : '?'} 或更靠左（给足 ${arm} 秒）；不要把地雷种在贴脸僵尸脚下。`,
          }, `土豆地雷只剩 ${Math.round(minEta * 10) / 10}s 准备时间，来不及（需 ${arm}s）`);
        }
      }
      // 墙类植物种在最前僵尸的右侧/同列：它已经过去了，这面墙挡不到它。
      // 这是几何事实，不是打法建议；直接给出左侧可种位。
      let stNow = null;
      try { stNow = stats.plantStatsOf(type); } catch { stNow = null; }
      const isWall = !!(stNow && String(stNow.family || '') === 'Defence');
      if (isWall && timing && timing.late) {
        const want = Math.max(0, Math.floor(nearZombie) - 1);
        const leftCells = emptyCellsInLane(C, lane, want, cf, 6)
          .filter((x) => x.column < nearZombie)
          .slice(0, 3);
        const cellText = leftCells.length ? leftCells.map((x) => `c${x.column}`).join('/') : '（左侧没有空位）';
        return fail('WALL_TOO_LATE', {
          lane, column, type,
          nearestZombieColumn: Math.round(nearZombie * 10) / 10,
          suggestedColumns: leftCells.map((x) => x.column),
          hint: leftCells.length
            ? `该行最前僵尸已在 c${Math.round(nearZombie * 10) / 10}，你把墙种在 c${column} 在它右边，挡不到它；改种 ${cellText}，或用倭瓜/樱桃/三叶草先处理这只。`
            : `该行僵尸已经贴到 c${Math.round(nearZombie * 10) / 10}，左侧没有空位放墙；用一次性卡处理，别把墙种在它身后。`,
        }, `${type} 种在 c${column} 挡不到 c${Math.round(nearZombie * 10) / 10} 的僵尸；可改种 ${cellText}`);
      }
      try {
        cell.PlaceUIPlant();
      } catch (e) {
        return fail('PLANT_NOT_SETTLED', { lane, column, card: index, type, started: false, retryable: true, timing }, `${type} 发起失败：${String(e && e.message || e)}`);
      }
      // 批量动作里不在每株上等落地：先把同一轮的 6 个动作都发出去，router 最后统一等一次。
      if (deferSettle) {
        return {
          ok: true,
          pending: true,
          started: true,
          settled: false,
          lane, column, card: index, type, timing,
          detail: `${type} 已发起（批量动作不逐株等待落地）${lateNote}`,
        };
      }
      // 种植落地是异步的；先把“已发起”如实返回，再等作物真正出现在格子里。
      const settled = await waitFor(() => reader.cellPlants(cell).length > beforeLen, 1500);
      if (!settled) {
        return {
          ok: true,
          pending: true,
          started: true,
          settled: false,
          lane, column, card: index, type, timing,
          detail: `${type} 已发起，等待落地（下一拍 pvz_state 确认，不要立刻重种）${lateNote}`,
        };
      }
      return { ok: true, lane, column, card: index, type, settled: true, timing, detail: `${a.type === 'replace' ? '换植' : '种下'} ${type} @ ${lane},${column}${lateNote}` };
    }

    if (a.type === 'shovel') {
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const before = reader.cellPlants(cell).length;
      if (!before) return fail('EMPTY', { lane, column });
      try { cell.removePlant(); } catch { /* ignore */ }
      const gone = await waitFor(() => reader.cellPlants(cell).length < before, 500);
      if (!gone) return fail('SHOVEL_FAILED', { lane, column }, '铲除没有生效');
      return { ok: true, lane, column, detail: `铲除 @ ${lane},${column}` };
    }

    if (a.type === 'plant_food') {
      const counter = map.PlantFoodCount;
      const have = counter ? Number(counter.plantFoodNum) || 0 : null;
      if (counter && !(have > 0)) return fail('NO_FOOD', { have: have || 0 });
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      // 只从 plantInSquare 里挑「能吃豆」的植物：花盆/睡莲也在格子里，但它们不是目标。
      // 同一批里「先种再给豆」时植物还没落地：等一小会儿再读，别直接 NO_PLANT。
      const inCell = () => (Array.isArray(cell.plantInSquare) ? cell.plantInSquare : reader.cellPlants(cell));
      const pick = () => {
        const list = inCell().filter((x) => x && !x.fooding);
        return list.find((x) => x.foodable === true)
          || list.find((x) => x.foodable !== false && typeof x.food === 'function')
          || list.find((x) => x.foodable !== false && typeof x.doPlantFood === 'function')
          || null;
      };
      let p = pick();
      if (!p) {
        await waitFor(() => !!pick(), 1200);
        p = pick();
      }
      if (!p) {
        const plants = inCell().filter(Boolean).map((x) => cleanType(x.Plant_Type));
        if (plants.length) {
          return fail('NOT_FOODABLE', {
            lane, column, plants,
            hint: '这格有植物，但没有能吃能量豆的（花盆/睡莲/一次性卡等）；换一格 foodable=true 的植物',
          }, `这格植物不能使用能量豆：${plants.join(', ')}`);
        }
        return fail('NO_PLANT', {
          lane, column,
          hint: '这一格没有植物（可能刚被吃掉，或同一批里刚种下还没落地）；先 pvz_state 确认再用能量豆',
        }, `${lane} 行 ${column} 列没有植物`);
      }
      const type = cleanType(p.Plant_Type);

      // 空放校验：这株的能量豆只对某一范围生效时，范围内没僵尸就是纯浪费。
      // 只拦「几何上一定没用」的情况；self 型 buff/治疗/产阳光不拦。
      let foodFact = null;
      try { foodFact = stats.plantStatsOf(type) && stats.plantStatsOf(type).plantFood; } catch { foodFact = null; }
      if (foodFact && !a.force) {
        let zs = [];
        try { zs = (reader.snapshot().zombies || []); } catch { zs = []; }
        const t = plantFoodTargets(foodFact, { lane, column }, zs);
        const SELF_OK = new Set(['self', 'aura', 'buff', 'heal', 'summon', 'sun_burst', 'self_armor', 'taunt']);
        if (t && t.count === 0 && !SELF_OK.has(foodFact.area)) {
          const nearest = zs
            .filter((z) => z.lane === lane)
            .sort((x, y) => Math.abs(x.column - column) - Math.abs(y.column - column))[0] || null;
          return fail('FOOD_NO_TARGET', {
            lane, column, type,
            plantFood: { kind: foodFact.kind, area: foodFact.area, radius: foodFact.radius, total: foodFact.total },
            nearestZombie: nearest ? { lane: nearest.lane, column: nearest.column, cellsAway: Math.round(Math.abs(nearest.column - column) * 10) / 10 } : null,
            hint: `这株的能量豆只对「${foodFact.area}」生效，范围内现在没有僵尸；换一株、等僵尸靠近，或确实要浪费就传 force=true。`,
          }, `${type} 的能量豆范围内没有僵尸`);
        }
      }

      try {
        // 游戏内真实接口是 plant.food()；doPlantFood 仅为兼容旧版本保留。
        if (typeof p.food === 'function') p.food();
        else if (typeof p.doPlantFood === 'function') p.doPlantFood();
        else return fail('FOOD_FAILED', { lane, column, type }, '这株植物没有 food() 接口，无法释放能量豆');
        if (counter && typeof counter.plantFoodDec === 'function') counter.plantFoodDec();
        else if (counter && Number.isFinite(Number(counter.plantFoodNum))) {
          counter.plantFoodNum = Math.max(0, Number(counter.plantFoodNum) - 1);
        }
        const left = counter ? Number(counter.plantFoodNum) : null;
        const maxCap = counter && Number.isFinite(Number(counter.maxCount)) ? Number(counter.maxCount) : null;
        return {
          ok: true, lane, column, type,
          foodLeft: Number.isFinite(left) ? left : null,
          ...(maxCap != null ? { foodMax: maxCap, foodFull: Number.isFinite(left) ? left >= maxCap : null } : {}),
          detail: `能量豆 @ ${lane},${column}`,
        };
      } catch (e) {
        return fail('FOOD_FAILED', { lane, column, type }, String(e && e.message || e));
      }
    }

    if (a.type === 'activate') {
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const list = (Array.isArray(cell.plantInSquare) ? cell.plantInSquare : reader.cellPlants(cell)).filter(Boolean);
      // 一格可能同时有花盆/睡莲 + 真正要点的卡：优先挑「需要手动激活」的那株
      const statsOf = (obj) => {
        try { return stats.plantStatsOf(cleanType(obj && obj.Plant_Type)); } catch { return null; }
      };
      const picked = list.find((x) => {
        const s = statsOf(x);
        return !!(s && s.usage && s.usage.manual);
      }) || list[0] || null;
      const p = picked;
      if (!p) {
        return fail('NO_PLANT', {
          lane, column,
          hint: '这一格没有植物；点击类卡要先种下去，再加 activate',
        }, `${lane} 行 ${column} 列没有植物`);
      }
      const type = cleanType(p.Plant_Type);
      const st = statsOf(p);
      const usage = (st && st.usage) || null;
      if (!usage || !usage.manual) {
        return fail('NOT_ACTIVATABLE', {
          lane, column, type,
          activation: (usage && usage.activation) || 'auto',
          hint: '这株是自动攻击，不需要 activate；命中用 plant / plant_food / shovel。',
        }, `${type} 不是点击类植物`);
      }
      // 目标格（free_cell / swap 类需要）
      const hasTarget = Number.isFinite(Number(a.targetLane)) && Number.isFinite(Number(a.targetColumn));
      const targetCell = hasTarget ? C.getLnC(Number(a.targetLane), Number(a.targetColumn)) : null;
      const needsTarget = usage.aim === 'free_cell' || usage.aim === 'swap';
      if (needsTarget && !targetCell) {
        return fail('NO_TARGET', {
          lane, column, type, aim: usage.aim,
          hint: '这张卡点完后还要选目标格：activate 时同时传 targetLane/targetColumn。',
        }, `${type} 需要目标格（targetLane/targetColumn）`);
      }
      // 可读状态：为什么现在点不动
      const liveState = {};
      for (const k of ['sleepCD', 'shooting', 'fooding', 'shootCD', 'growthStage', 'LeftPrj', 'charging', 'sheepend', 'dead']) {
        try { if (p[k] != null) liveState[k] = typeof p[k] === 'boolean' ? p[k] : Number(p[k]); } catch { /* ignore */ }
      }
      const okReturn = (via) => ({
        ok: true, lane, column, type, via,
        ...(targetCell ? { target: { lane: Number(a.targetLane), column: Number(a.targetColumn) } } : {}),
        verified: false,
        detail: `已触发 ${type}（${via}）`,
      });

      // ① 游戏自己的点击入口：所有点击类植物都实现了 specialPlantOnMouseDown()，
      //    不需要鼠标事件；狙击类（冬青/香蕉/整人竹/槲寄冰仙子）在这里进入瞄准，
      //    随后由 trigger(LnC) 打出这一发。
      if (typeof p.specialPlantOnMouseDown === 'function') {
        let started = false;
        try { started = !!p.specialPlantOnMouseDown(); } catch (e) {
          return fail('ACTIVATE_FAILED', { lane, column, type, liveState }, String(e && e.message || e));
        }
        if (started) {
          if (targetCell && typeof p.trigger === 'function') {
            try { p.trigger(targetCell); } catch (e) {
              return fail('ACTIVATE_FAILED', { lane, column, type, liveState, stage: 'trigger' }, String(e && e.message || e));
            }
            await sleep(120);
            return okReturn('specialPlantOnMouseDown+trigger');
          }
          await sleep(120);
          return okReturn('specialPlantOnMouseDown');
        }
        return fail('NOT_READY', {
          lane, column, type, aim: usage.aim, liveState,
          hint: '这株现在点不动：sleepCD>0（椰子炮 15s 休息）/ 正在射击 / 正在放能量豆 / 阳光不够（棱镜草）/ 还没长成（爆浆草莓）。等状态变好再点，别原地重试。',
        }, `${type} 现在不能触发`);
      }

      // ② 退路：直接调 onMouseDown，并伪造一个左键事件
      if (typeof p.onMouseDown === 'function') {
        try {
          p.onMouseDown({ getButton: () => 0, getLocation: () => ({ x: 0, y: 0 }) });
          await sleep(120);
          return okReturn('onMouseDown');
        } catch (e) {
          return fail('ACTIVATE_FAILED', { lane, column, type, liveState, stage: 'onMouseDown' }, String(e && e.message || e));
        }
      }

      // ③ 最后再试常见方法名（不同版本可能有自己的封装）
      const tried = [];
      const errors = [];
      for (const name of ACTIVATE_METHODS) {
        let fn = null;
        try { fn = p[name]; } catch { fn = null; }
        if (typeof fn !== 'function') continue;
        tried.push(name);
        try {
          if (targetCell) {
            try { fn.call(p, targetCell); } catch (e1) {
              try { fn.call(p, Number(a.targetLane), Number(a.targetColumn)); } catch { throw e1; }
            }
          } else {
            fn.call(p);
          }
          await sleep(120);
          return okReturn(name);
        } catch (e) {
          errors.push(`${name}: ${String(e && e.message || e)}`);
        }
      }
      return fail('ACTIVATE_UNSUPPORTED', {
        lane, column, type, tried, errors: errors.slice(0, 4), aim: usage.aim, liveState,
        hint: '这个版本既没有 specialPlantOnMouseDown，也没有可调的触发方法。用 state.activatePlan[].api 看候选名。',
      }, `${type} 找不到可用的触发入口`);
    }

    return fail('UNKNOWN_ACTION', { type: a.type });
  }

  async function actAll(actions) {
    const list = Array.isArray(actions) ? actions.slice(0, 6) : [];
    if (!list.length) return fail('NO_ACTIONS', {}, 'actions 为空（一次 1–6 个）');
    const results = [];
    for (let i = 0; i < list.length; i++) {
      try {
        results.push({ index: i, type: list[i] && list[i].type, ...(await act(list[i])) });
      } catch (e) {
        results.push({ index: i, type: list[i] && list[i].type, ok: false, code: 'ACT_THREW', reason: String(e && e.message || e) });
      }
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
    };
  }

  return { act, actAll, chooseDeck, startLevel, restartLevel, dismissObjective, resume, collect, moveCart, deckStatus, fail };
}
