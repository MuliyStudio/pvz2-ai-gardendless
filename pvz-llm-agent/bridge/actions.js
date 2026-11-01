/**
 * actions：只执行 LLM 指定的动作，并把游戏的真实结果原样返回。
 *
 * 不补卡、不换卡、不改 LLM 的卡组；选卡只做校验 + 逐张执行 + 等待 UI 同步。
 */
import { plantFoodTargets } from '../knowledge/plant-rules.js';
import { isWallCard } from './mechanics.js';

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

export function createActions({ getCc, findComps, findCompByClass, stats, reader, version, getPlan, getLevelKey }) {
  const isWallType = (type) => {
    try { return isWallCard(type, stats.plantStatsOf(type)); } catch { return isWallCard(type, null); }
  };
  function fail(code, extra, reason) {
    return { ok: false, code, reason: reason || code, ...(extra || {}) };
  }

  // 传送带：当前带上的卡在 Conveyor.getCards()，不在 Cards.CFs。
  // 关卡 JSON 里有 Conveyor 模块时也算（组件还没初始化时，至少模式判断正确）。
  function conveyorInfo(map, cards) {
    const cv = map && (map.Conveyor || map.ConveyorBelt || null);
    let ls = null;
    try { ls = map && map.levelController ? stats.levelScriptOf(map.levelController) : null; } catch { ls = null; }
    const fromLevel = !!(ls && ls.seedBank && ls.seedBank.conveyor);
    if (!cv && !fromLevel) return null;
    let list = [];
    let slots = [];
    let plantList = [];
    try {
      if (cv) {
        list = (typeof cv.getCards === 'function' ? cv.getCards() : []) || [];
        slots = [].concat(cv.lane1slots || [], cv.lane2slots || [], cv.laneVertslots || []).filter(Boolean);
        plantList = (Array.isArray(cv.plantList) ? cv.plantList : [])
          .map((p) => cleanType(p && (p.PlantType || p.Type) || p)).filter(Boolean);
      }
    } catch { /* ignore */ }
    const cardCount = cards && Array.isArray(cards.CFs) ? cards.CFs.length : 0;
    const enabled = cv
      ? (list.length > 0 || plantList.length > 0 || cardCount === 0)
      : (fromLevel && cardCount === 0);
    if (!enabled) return null;
    return { cv, cards: list, slots, plantList, enabled: true };
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
    const cinfo = conveyorInfo(ctxg.map, cards);
    const conveyor = !!(cinfo && cinfo.enabled) || !!(cards.conveyor || (lvl && lvl.conveyorMode));
    return {
      ok: true,
      phase: phaseState.phase,
      gameStarted: !!cards.gameStarted,
      prepReady: !!(seed && slots > 0),
      conveyor,
      conveyorCards: cinfo && cinfo.enabled
        ? cinfo.cards.map((cf, i) => ({ index: i, type: cleanType(cf.Type), name: (stats.plantStatsOf(cleanType(cf.Type)) || {}).name || cleanType(cf.Type) }))
        : [],
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
    const cinfo = conveyorInfo(ctxg.map, cards);
    if ((cinfo && cinfo.enabled) || cards.conveyor || (lvl && lvl.conveyorMode)) {
      return { ok: true, conveyor: true, slots: 0, requested: [], applied: [], skipped: [], missing: [], actualDeck: [], full: true, detail: '传送带关卡无需选卡' };
    }
    // 给定/锁定卡组：卡槽已满且没有可选卡（或全部锁定）。不要清空、不要报“缺卡”，原样返回。
    const slotsNow = Number(cards.maxSlotCount) || 0;
    const currentNow = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const lockedNow = (cards.CFs || []).filter((cf) => cf && cf.ca && cf.ca.locked).length;
    const seedUnlocked = cards.seedChooser && Array.isArray(cards.seedChooser.CFs)
      ? cards.seedChooser.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length
      : 0;
    const noChooser = !cards.seedChooser;
    const forcedFlag = !!(cards.forcedDeck || cards.deckLocked || cards.presetDeck)
      || !!(lvl && (lvl.forcedDeck || lvl.deckLocked || lvl.presetDeck || lvl.givenDeck));
    if (forcedFlag || (currentNow.length > 0 && (noChooser || (slotsNow > 0 && currentNow.length >= slotsNow && (lockedNow >= slotsNow || seedUnlocked === 0))))) {
      return {
        ok: true, forced: true, deckLocked: true, slots: slotsNow,
        requested: Array.isArray(requested) ? requested : [], applied: [], skipped: [], missing: [],
        actualDeck: currentNow, full: true,
        mustPlanBeforeStart: true,
        detail: '本关卡组由系统给定/锁定，无需也不能换卡；先 pvz_briefing + pvz_set_plan，再 pvz_start_level',
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

  // 提前布阵关的“开始！”按钮在不同版本里可能是节点，而不是 lvl 方法。
  function clickSceneNode(scene, names) {
    const wanted = names.map((x) => String(x).toLowerCase());
    let hit = null;
    const walk = (n) => {
      if (hit || !n) return;
      const name = String(n.name || '').toLowerCase();
      if (wanted.includes(name)) { hit = n; return; }
      for (const ch of n.children || []) { walk(ch); if (hit) return; }
    };
    try { walk(scene); } catch { return false; }
    if (!hit) return false;
    for (const method of ['emit', 'click', 'onClick', 'trigger']) {
      try {
        if (typeof hit[method] !== 'function') continue;
        if (method === 'emit') hit.emit('click');
        else hit[method]();
        return true;
      } catch { /* try next */ }
    }
    return false;
  }

  async function startLevel() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!lvl) return fail('NO_SCENE', {}, '当前场景无法开局');
    if (lvl.gameStarted) return { ok: true, detail: '已经在战斗中', started: true };
    const prep = (() => { try { return reader.snapshot().prep; } catch { return null; } })();
    // 给定卡组 / 提前布阵必须先把整关波次和对策写进计划，再允许点开始。
    // 这不是替模型决策：只要求“先想再开局”，计划内容仍完全由模型写。
    if (prep && prep.mustPlanBeforeStart) {
      const p = typeof getPlan === 'function' ? getPlan() : null;
      let levelKey = null;
      try { levelKey = typeof getLevelKey === 'function' ? getLevelKey() : null; } catch { levelKey = null; }
      const stale = !!(p && p.plan && levelKey && p.plan.levelKey && p.plan.levelKey !== levelKey);
      if (!p || !p.plan || !String(p.plan.text || '').trim() || stale) {
        return fail('NEED_PLAN', {
          prep,
          stalePlan: stale || undefined,
          hint: stale
            ? '这份计划是上一关的；先针对本关重新 pvz_briefing + pvz_set_plan，再开局。'
            : '先用 pvz_briefing 读完整关波次/卡组/克制，再用 pvz_set_plan 写下对策（text + lanes/counters/phases），然后才能 pvz_start_level。',
        }, stale ? '计划属于上一关，需要按本关事实重写' : '还没有作战计划：先想清楚卡组对策再开局');
      }
    }
    const cinfoStart = conveyorInfo(ctxg.map, cards);
    const conveyorStart = !!(cinfoStart && cinfoStart.enabled);
    if (!conveyorStart && cards && cards.seedChooser && !(prep && prep.preplant)) {
      if (typeof cards.GameStartable === 'function' && !cards.GameStartable()) {
        const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
        return fail('DECK_NOT_FULL', { current, slots: cards.maxSlotCount || 0 }, `卡组还没选满（${current.length}/${cards.maxSlotCount || 0}）`);
      }
    }
    if (prep && prep.preplant) {
      // 不同版本的方法名：startReadySet / readySetPlant / startGame。
      for (const method of ['startReadySet', 'readySetPlant', 'startGame']) {
        try {
          if (typeof lvl[method] !== 'function') continue;
          lvl[method]();
          return { ok: true, detail: `开始了提前布阵（${method}）`, started: true };
        } catch { /* try next */ }
      }
      if (clickSceneNode(ctxg.scene, ['LastStandStartButton', 'StartReadyButton', 'StartButton', 'ReadyButton'])) {
        return { ok: true, detail: '已点击提前布阵“开始！”按钮', started: true };
      }
    }
    if (typeof lvl.letsRock !== 'function') {
      return fail('START_UNSUPPORTED', { prep }, '当前关卡没有 letsRock / 提前布阵开始入口');
    }
    try {
      lvl.letsRock();
      return { ok: true, detail: '已开局', started: true };
    } catch (e) {
      // 传送带关的 letsRock 可能在隐藏种子栏 UI 时抛错，但战斗已经启动；交给上层用 phase 复核。
      const started = !!(lvl.letsRocked || lvl.gameStarted || (cards && cards.gameStarted));
      if (started) return { ok: true, detail: '已开局（启动时 UI 有非致命异常）', started: true, warning: String(e && e.message || e) };
      return fail('START_FAILED', { started }, String(e && e.message || e));
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
  function emptyCellsInLane(C, lane, wantColumn, cf, limit = 3, excludeColumn = wantColumn) {
    const cols = C.ColumnCount || 9;
    const out = [];
    for (let c = 0; c < cols; c++) {
      if (c === excludeColumn) continue;
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

  /**
   * 僵尸还在“左边/前面”的空格：墙必须种在这僵尸的左侧（column 更小），
   * 否则僵尸已经走过去，墙只会种在它背后。
   * 这里用与 WALL_TOO_LATE 相同的 0.25 格提前量，并排除本次目标格，
   * 避免返回“可改种 c1”但 c1 就是当前格这种死循环。
   */
  function emptyCellsInFrontOfZombie(C, lane, zombieColumn, cf, limit = 3, excludeColumn = null) {
    const cols = C.ColumnCount || 9;
    const out = [];
    for (let c = 0; c < cols; c++) {
      if (c === excludeColumn) continue;
      if (c + 0.25 >= zombieColumn) continue;
      const cell = C.getLnC(lane, c);
      if (!cell) continue;
      try { if (reader.cellPlants(cell).length) continue; } catch { continue; }
      let ok = true;
      try { ok = cell.putPlantAvailable ? cell.putPlantAvailable(true, cf && cf.ID, true, true, cf && cf.spf) : true; } catch { ok = true; }
      if (ok) out.push({ lane, column: c });
    }
    // 离僵尸最近的可挡位优先（列号越大越靠前）。
    out.sort((a, b) => b.column - a.column);
    return out.slice(0, limit);
  }

  /** 僵尸前方、已被占用的格子；给 WALL_TOO_LATE 提供“可 replace 哪个植物”。 */
  function occupiedCellsInFrontOfZombie(C, lane, zombieColumn, excludeColumn = null, limit = 3) {
    const cols = C.ColumnCount || 9;
    const out = [];
    for (let c = 0; c < cols; c++) {
      if (c === excludeColumn || c + 0.25 >= zombieColumn) continue;
      const cell = C.getLnC(lane, c);
      if (!cell) continue;
      const plants = reader.cellPlants(cell);
      if (!plants.length) continue;
      const type = cleanType(plants[0] && plants[0].Plant_Type);
      let st = null;
      try { st = stats.plantStatsOf(type); } catch { st = null; }
      out.push({
        lane, column: c, type,
        family: (st && st.family) || null,
        hp: Math.round((plants[0] && (plants[0].health || plants[0].toughness)) || 0),
        dps: (st && st.attack && st.attack.dps) || null,
      });
    }
    out.sort((a, b) => b.column - a.column);
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
      // d=0 是保护格本身，永远不能当“守卫格”推荐出去。
      for (const d of [1, -1]) {
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
        if (isWallType(t)) {
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
    // 传送带可以没有常规卡槽组件；只要 Conveyor 在就不算“卡槽还没加载”。
    const preCinfo = conveyorInfo(map, cards);
    if (!cards && !(preCinfo && preCinfo.enabled)) return fail('NO_SCENE', {}, '卡槽还没加载');
    const cols = C.ColumnCount || 9;

    const lane = Number(a.lane), column = Number(a.column);
    if (!Number.isFinite(lane) || !Number.isFinite(column)) return fail('BAD_POSITION');

    if (a.type === 'plant' || a.type === 'replace') {
      const cinfo = conveyorInfo(map, cards);
      const conveyorMode = !!(cinfo && cinfo.enabled);
      let index = Number(a.card);
      let cf = null;
      let conveyorSlot = null;
      if (conveyorMode) {
        // 传送带 index 会随带子变化：只要模型给了 codename，就以 codename 为准，
        // 避免旧的 card 下标在下一轮指到另一张卡。
        if (a.plant) {
          index = cinfo.cards.findIndex((x) => cleanType(x && x.Type) === String(a.plant));
        }
        cf = Number.isFinite(index) ? cinfo.cards[index] : null;
        if (!cf) {
          return fail('NO_CARD', {
            conveyor: true, card: a.card, plant: a.plant || null,
            available: cinfo.cards.map((x, i) => ({ index: i, type: cleanType(x && x.Type) })),
            hint: '传送带卡会变：用本轮 state.cards / state.conveyor.cards 的最新 index，不要沿用上一轮。',
          }, `传送带当前没有这张卡（现在有 ${cinfo.cards.length} 张）`);
        }
        conveyorSlot = cinfo.slots.find((s) => s && s.card === cf) || null;
        if (!conveyorSlot) {
          return fail('CARD_UNAVAILABLE', { conveyor: true, card: index, type: cleanType(cf.Type) }, '这张卡已经离开传送带，重新读 state.cards 取最新的卡');
        }
      } else {
        if (!Number.isFinite(index) && a.plant) {
          index = (cards.CFs || []).findIndex((x) => cleanType(x.Type) === String(a.plant));
        }
        cf = cards && cards.CFs && cards.CFs[index];
        if (!cf) return fail('NO_CARD', { card: a.card, plant: a.plant || null });
      }
      const type = cleanType(cf.Type);
      if (!conveyorMode) {
        const upper = cards.cardsUIUpper && cards.cardsUIUpper[index];
        const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
        if (cd > 0) return fail('COOLDOWN', { card: index, type, retryAfter: Math.round(cd * 10) / 10 }, `${type} 冷却中 ${cd.toFixed(1)}s${a.type === 'replace' ? '（铲除本身没有冷却；这里是新卡的种子冷却）' : ''}`);
        const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
        const sunNow = map.SunCount ? map.SunCount.CurrentValue : null;
        if (sunNow != null && sunNow < cost && !(cf.ca && cf.ca.free)) return fail('SUN', { card: index, type, need: cost, have: sunNow }, `阳光不足：需要 ${cost}，现有 ${sunNow}`);
      }

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
          // 保护格不一定是“不能种的格子”：很多关的花是地块装饰，格位本身可以种。
          // 只有这一格真的有植物实体时才拒绝；否则交给游戏判定（被占会报 OCCUPIED）。
          let occupied = false;
          try { occupied = reader.cellPlants(C.getLnC(lane, column)).length > 0; } catch { occupied = false; }
          if (occupied) {
            const guardCells = guardCellsFor(C, lane, prot);
            const cellText = guardCells.length ? guardCells.map((x) => `c${x.column}`).join('/') : '（保护格旁边没有空位）';
            return fail('PROTECT_CELL_BLOCKED', {
              lane, column, card: index, type,
              protectCells: prot.map((p) => ({ lane: p.lane, column: p.column })),
              guardCells,
              hint: `c${onCell.column} 上有保护植物实体，不能覆盖；改种 ${cellText}（左侧远程/右侧墙或近战）。`,
            }, `${type} 不能覆盖保护格 c${onCell.column} 上的植物；改种 ${cellText}`);
          }
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
        // 墙/高血量肉盾种在保护格左侧（房子侧）= 完全没用：僵尸从右往左来，
        // 先踩到花才轮到这面墙。吸血牛肝菌这种高血量卡也算“墙”。
        const tankProbe = (() => { try { return stats.plantStatsOf(type); } catch { return null; } })();
        const tanky = isWallType(type) || !!(tankProbe && Number(tankProbe.hp) >= 1000
          && !(tankProbe.attack && Number(tankProbe.attack.dps) > 0) && !tankProbe.burst);
        const behindCells = prot.filter((p) => column < p.column - 0.25);
        if (tanky && behindCells.length) {
          const p = behindCells[0];
          const frontCol = Math.min(cols - 1, p.column + 1);
          const guardCells = guardCellsFor(C, lane, prot);
          const suggest = [frontCol, ...guardCells.map((x) => x.column)].filter((c, i, arr) => arr.indexOf(c) === i && c > p.column);
          return fail('WALL_BEHIND_PROTECT', {
            lane, column, card: index, type, protectColumn: p.column,
            suggestedColumns: suggest,
            protectCells: prot.map((x) => ({ lane: x.lane, column: x.column })),
            hint: `${type} 是高血量肉盾，但种在 c${column} 位于保护格 c${p.column} 的左侧（房子侧）：僵尸从右往左走，会先踩/啃到花，这面墙挡不到任何东西。改种保护格右侧 c${suggest.join('/c')}，或者用一次性/远程卡在花前方解决。`,
          }, `${type} 种在保护格 c${p.column} 左侧挡不到；应种在右侧 c${suggest.join('/c')}`);
        }
      }

      // 输出种在本行墙的右侧（僵尸先啃输出再啃墙）：等于把墙白放了。
      // 输出应放墙左侧；没位置就 replace 墙为输出，再把新墙补到右侧。
      let stType = null;
      try { stType = stats.plantStatsOf(type); } catch { stType = null; }
      const isWallPlant = isWallType(type);
      // 地刺类：伤害来自“僵尸走过这一格”，必须种在墙前（右侧），否则僵尸被墙挡住、永远踩不到。
      const isStepDamage = !!(stType && stType.stepDamage);
      // 土豆雷/地雷虽然被标成 stepDamage（本格），但它是“接触触发的一次性爆炸”，
      // 不是地刺那种“走过就持续掉血”。雷种在墙后是有效的最后防线：墙拖时间，
      // 雷在后面出土，僵尸破墙后踩上一起炸。不能按 SPIKE_BEHIND_WALL 拒绝。
      const isMinePlant = !!(stType && (Number(stType.armTimeSec) > 0 || String(stType.family || '') === 'Explosive'));
      const isOutputType = !!(stType && stType.attack && Number(stType.attack.dps) > 0 && !isWallPlant && !isStepDamage);
      // 整行/全屏一次性卡（寒冰辣椒、果冻蔓越莓、火爆辣椒…）的效果与落点无关：
      // 站在僵尸左边还是右边都能命中，之前按“输出只能打右侧”拒绝，会把救场卡全部挡掉。
      const rowWideEffect = !!(stType && /整行|本行|一行|全屏|全场|多行/.test(String(stType.area || '')));
      if (isStepDamage && !isMinePlant) {
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
      if (conveyorMode) {
        try {
          cinfo.cv.chooseCard(cf, conveyorSlot);
        } catch (e) {
          return fail('CARD_UNAVAILABLE', { conveyor: true, card: index, type }, `传送带选卡失败：${String(e && e.message || e)}`);
        }
        if (ui && ui.currentFreeCF && ui.currentFreeCF !== cf) {
          return fail('CARD_UNAVAILABLE', { conveyor: true, card: index, type }, '传送带卡没有选中');
        }
      } else if (ui && typeof ui.tryChangingIndex === 'function' && ui.index !== index) {
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
      const lateNote = timing && timing.late && !rowWideEffect
        ? `；⚠ 僵尸已到 c${timing.nearestZombieColumn}，这个落点打不到它，只对右侧更远的僵尸有效`
        : '';
      // 输出种在本行最前僵尸的右侧/同格：它已经走过这一格，而输出只向右打，
      // 这株现在打不到它。如果目标格右侧也没有别的僵尸，这一株这波就是纯浪费
      // （扣阳光 + 吃种子冷却），必须在扣资源前拒绝，而不是种下后再警告。
      if (isOutputType && !rowWideEffect && timing && timing.late) {
        let rightZombies = [];
        try {
          const snap = reader.snapshot();
          rightZombies = (snap.zombies || []).filter((z) => Number(z.lane) === lane
            && Number(z.column) > column + 0.25);
        } catch { rightZombies = []; }
        if (!rightZombies.length) {
          const safeCells = emptyCellsInFrontOfZombie(C, lane, nearZombie, cf, 3, column);
          const replaceCells = occupiedCellsInFrontOfZombie(C, lane, nearZombie, column, 3);
          const emptyText = safeCells.length ? safeCells.map((x) => `c${x.column}`).join('/c') : null;
          const replaceText = replaceCells.length
            ? replaceCells.map((x) => `c${x.column}(${x.type}${x.dps ? ` ${x.dps}dps` : ''})`).join('/')
            : null;
          const parts = [];
          if (emptyText) parts.push(`改种左侧空位 c${emptyText}`);
          if (replaceText) parts.push(`或 replace ${replaceText} 腾格`);
          if (!parts.length) parts.push('前方没有可种/可换的格子，改用冰冻/一次性/能量豆，或等这波清完再补');
          return fail('PLANT_BEHIND_ZOMBIE', {
            lane,
            column,
            type,
            nearestZombieColumn: timing.nearestZombieColumn,
            suggestedColumns: safeCells.map((x) => x.column),
            replaceCells,
            hint: `僵尸已到 c${timing.nearestZombieColumn}，${type} 种在 c${column} 已经在它身后（输出只向右打，打不到它），目标格右侧也没有别的僵尸；现在种只会白扣阳光和冷却。${parts.join('；')}。`,
          }, `${type} 落在僵尸 c${timing.nearestZombieColumn} 身后，打不到；先处理这只再补`);
        }
      }
      // 土豆雷有出土时间，不是瞬爆：按当前僵尸距离算，来不及就别埋在脸上。
      if (stType && Number(stType.armTimeSec) > 0 && String(stType.family || '') === 'Explosive') {
        const arm = Number(stType.armTimeSec);
        let minEta = null;
        let closest = null;
        let planOk = false;
        try {
          const snap = reader.snapshot();
          for (const z of (snap.zombies || [])) {
            if (z.lane !== lane) continue;
            const speed = Number(z.speed) > 0 ? Number(z.speed) : 0.18;
            const eta = (Number(z.column) - column) / speed;
            if (minEta == null || eta < minEta) { minEta = eta; closest = z; }
          }
          // 本地 minePlan 已经把“路上植物/墙的啃食时间”算进去了；
          // 它在 safeColumns 里就说明雷能在僵尸到达前出土（哪怕直接距离不够）。
          const mp = (snap.brief && snap.brief.minePlan || [])
            .find((m) => m && m.card === type && Number(m.lane) === Number(lane));
          planOk = !!(mp && Array.isArray(mp.safeColumns) && mp.safeColumns.includes(Number(column)));
        } catch { /* ignore */ }
        if (minEta != null && minEta < arm + 1 && !planOk) {
          // 安全列：c <= 僵尸列 - (arm+1) × 真实速度。不能用固定 0.2 或
          // “僵尸列 - 几格”拍脑袋，否则会给到仍然来不及的列。
          const speed = closest && Number(closest.speed) > 0 ? Number(closest.speed) : 0.18;
          const latestSafe = closest ? Math.floor(Number(closest.column) - (arm + 1) * speed) : null;
          const candidates = latestSafe == null ? [] : emptyCellsInLane(C, lane, latestSafe, cf, 6, column)
            .filter((x) => x.column <= latestSafe)
            .sort((a, b) => b.column - a.column)
            .slice(0, 3);
          const needCol = candidates.length ? candidates[0].column : null;
          return fail('MINE_TOO_LATE', {
            lane, column, type, armTimeSec: arm,
            nearestZombieColumn: closest ? closest.column : null,
            speed,
            etaSec: Math.round(minEta * 10) / 10,
            latestSafeColumn: latestSafe,
            suggestedColumn: needCol,
            suggestedColumns: candidates.map((x) => x.column),
            hint: `土豆地雷需要 ${arm} 秒出土，按当前僵尸速度（${speed} 格/秒）只剩 ${Math.round(minEta * 10) / 10} 秒，埋在 c${column} 来不及。按计算最晚安全列是 c${latestSafe != null ? latestSafe : '?'}；${needCol != null ? `可提前埋到 c${needCol} 或更靠左` : '前方没有空位，改用樱桃/倭瓜/冰冻等瞬发手段'}。不要把地雷种在贴脸僵尸脚下。`,
          }, `土豆地雷只剩 ${Math.round(minEta * 10) / 10}s 准备时间，来不及（需 ${arm}s）`);
        }
      }
      // 接触触发植物（冰冻生菜等）种在僵尸右侧/身后：僵尸已经走过，不会被踩到。
      // 和输出一样，在扣阳光前拒绝；一次性爆炸卡不受这条限制（3x3 仍可能覆盖）。
      const isContactEffect = !!(stType && !stType.attack && !isWallPlant
        && (String(stType.family || '') === 'Cold' || !!(stType.usage && stType.usage.contact)));
      if (isContactEffect && !rowWideEffect && timing && timing.late) {
        const candidates = emptyCellsInLane(C, lane, Math.max(0, Math.floor(nearZombie)), cf, 4, column)
          .filter((x) => x.column <= nearZombie)
          .sort((a, b) => b.column - a.column);
        const cols = candidates.map((x) => x.column);
        return fail('PLANT_BEHIND_ZOMBIE', {
          lane,
          column,
          type,
          nearestZombieColumn: timing.nearestZombieColumn,
          suggestedColumns: cols,
          hint: `僵尸已到 c${timing.nearestZombieColumn}，${type} 是接触触发，种在 c${column} 在它身后不会被踩到；${cols.length ? `改种僵尸所在格或左侧 c${cols.join('/c')}` : '前方没有空位，改用输出/能量豆或等这波清完'}。`,
        }, `${type} 落在僵尸 c${timing.nearestZombieColumn} 身后，踩不到`);
      }
      // 墙类植物种在最前僵尸的右侧/同列：它已经过去了，这面墙挡不到它。
      // 这是几何事实，不是打法建议；直接给出左侧可种位。
      let stNow = null;
      try { stNow = stats.plantStatsOf(type); } catch { stNow = null; }
      const isWall = !!(stNow && String(stNow.family || '') === 'Defence');
      if (isWall && timing && timing.late) {
        // 墙必须种在僵尸左侧（column 更小）。这里排除本次目标格，且只给
        // c + 0.25 < 僵尸列 的格子，避免出现“可改种 c1”但目标就是 c1 的死循环。
        const safeCells = emptyCellsInFrontOfZombie(C, lane, nearZombie, cf, 3, column);
        const replaceCells = occupiedCellsInFrontOfZombie(C, lane, nearZombie, column, 3);
        const emptyText = safeCells.length ? safeCells.map((x) => `c${x.column}`).join('/c') : null;
        const replaceText = replaceCells.length
          ? replaceCells.map((x) => `c${x.column}(${x.type}${x.dps ? ` ${x.dps}dps` : ''})`).join('/')
          : null;
        const parts = [];
        if (emptyText) parts.push(`空位改种 c${emptyText}`);
        if (replaceText) parts.push(`或 replace ${replaceText} 腾格`);
        if (!parts.length) parts.push('前方已经没有可种/可换的格子');
        return fail('WALL_TOO_LATE', {
          lane, column, type,
          nearestZombieColumn: Math.round(nearZombie * 10) / 10,
          suggestedColumns: safeCells.map((x) => x.column),
          replaceCells,
          blockable: !!(safeCells.length || replaceCells.length),
          hint: `本行最前僵尸已在 c${Math.round(nearZombie * 10) / 10}，墙必须种在它左侧（column 更小）才挡得住；c${column} 已经是它背后。${parts.join('；')}。如果来不及种墙，就不要继续试墙，改用输出/一次性卡/冰冻先把这只僵尸磨掉。`,
        }, `${type} 种在 c${column} 挡不到 c${Math.round(nearZombie * 10) / 10} 的僵尸；${parts.join('，')}`);
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

  /** 批量发起后统一等落地：队列一拍连发多株时不用每株各等一次。 */
  async function settlePending(pending) {
    const list = (Array.isArray(pending) ? pending : []).filter((p) => p
      && Number.isInteger(Number(p.lane)) && Number.isInteger(Number(p.column)));
    if (!list.length) return { ok: true, settled: true, count: 0 };
    const ctxg = findComps();
    const map = ctxg && ctxg.map;
    const C = map && map.Square && map.Square.constructor;
    if (!C) return { ok: false, code: 'NO_SCENE' };
    const settled = await waitFor(() => list.every((p) => {
      const cell = C.getLnC(Number(p.lane), Number(p.column));
      return !!(cell && reader.cellPlants(cell).length > 0);
    }), 900);
    return { ok: settled, settled, count: list.length };
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

  return { act, actAll, settlePending, chooseDeck, startLevel, restartLevel, dismissObjective, resume, collect, moveCart, deckStatus, fail };
}
