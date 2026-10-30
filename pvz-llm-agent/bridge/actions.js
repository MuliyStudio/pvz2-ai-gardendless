/**
 * actions：只执行 LLM 指定的动作，并把游戏的真实结果原样返回。
 *
 * 不补卡、不换卡、不改 LLM 的卡组；选卡只做校验 + 逐张执行 + 等待 UI 同步。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanType = (t) => String(t || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();

async function waitFor(fn, timeoutMs = 800, intervalMs = 50) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try { if (fn()) return true; } catch { /* keep polling */ }
    await sleep(intervalMs);
  }
  try { return !!fn(); } catch { return false; }
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
    if (phaseNow === 'objective') return fail('PREP_NOT_READY', { phase: phaseNow, retryable: true }, '先关闭任务说明弹窗，再选卡');
    if (phaseNow === 'running' || phaseNow === 'won' || phaseNow === 'lost') return fail('ALREADY_STARTED', { phase: phaseNow });
    if (cards.conveyor || (lvl && lvl.conveyorMode)) {
      return { ok: true, conveyor: true, slots: 0, requested: [], applied: [], skipped: [], missing: [], actualDeck: [], full: true, detail: '传送带关卡无需选卡' };
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
      const now = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
      if (now.includes(type)) { already.push(type); continue; }
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
    if (cards && cards.seedChooser) {
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

  async function act(a) {
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
      if (cd > 0) return fail('COOLDOWN', { card: index, type, retryAfter: Math.round(cd * 10) / 10 }, `${type} 冷却中 ${cd.toFixed(1)}s`);
      const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
      const sunNow = map.SunCount ? map.SunCount.CurrentValue : null;
      if (sunNow != null && sunNow < cost && !(cf.ca && cf.ca.free)) return fail('SUN', { card: index, type, need: cost, have: sunNow }, `阳光不足：需要 ${cost}，现有 ${sunNow}`);

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
        return fail('CELL_BLOCKED', {
          lane, column, card: index, type, alternatives,
          hint: alternatives.length ? '这格不能种（墓碑/水面/障碍）；alternatives 是同行可种位' : '这行没有可种的空位',
        }, `${lane} 行 ${column} 列不能种${alternatives.length ? `，可改种 ${alternatives.map((x) => `c${x.column}`).join('/')}` : ''}`);
      }
      if (ui && typeof ui.tryChangingIndex === 'function' && ui.index !== index) {
        ui.tryChangingIndex(index);
        // 等种子栏真正切到目标卡，再发起种植；否则 PlaceUIPlant 可能用旧卡。
        await waitFor(() => Number(ui.index) === index, 120);
      }
      const beforeLen = reader.cellPlants(cell).length;
      try {
        cell.PlaceUIPlant();
      } catch (e) {
        return fail('PLANT_NOT_SETTLED', { lane, column, card: index, type, started: false, retryable: true }, `${type} 发起失败：${String(e && e.message || e)}`);
      }
      // 种植落地是异步的；先把“已发起”如实返回，再等作物真正出现在格子里。
      const settled = await waitFor(() => reader.cellPlants(cell).length > beforeLen, 1500);
      if (!settled) {
        return {
          ok: true,
          pending: true,
          started: true,
          settled: false,
          lane, column, card: index, type,
          detail: `${type} 已发起，等待落地（下一拍 pvz_state 确认，不要立刻重种）`,
        };
      }
      return { ok: true, lane, column, card: index, type, settled: true, detail: `${a.type === 'replace' ? '换植' : '种下'} ${type} @ ${lane},${column}` };
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
      if (counter && !(counter.plantFoodNum > 0)) return fail('NO_FOOD', { have: counter.plantFoodNum || 0 });
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      // 同一批里「先种再给豆」时植物还没落地：等一小会儿再读，别直接 NO_PLANT。
      let p = reader.cellPlants(cell)[0];
      if (!p) {
        await waitFor(() => reader.cellPlants(cell).length > 0, 1200);
        p = reader.cellPlants(cell)[0];
      }
      if (!p) {
        return fail('NO_PLANT', {
          lane, column,
          hint: '这一格没有植物（可能刚被吃掉，或同一批里刚种下还没落地）；先 pvz_state 确认再用能量豆',
        }, `${lane} 行 ${column} 列没有植物`);
      }
      if (p.foodable === false) return fail('NOT_FOODABLE', { lane, column, type: cleanType(p.Plant_Type) });
      try {
        p.fooding = true;
        if (typeof p.doPlantFood === 'function') p.doPlantFood();
        return { ok: true, lane, column, type: cleanType(p.Plant_Type), detail: `能量豆 @ ${lane},${column}` };
      } catch (e) {
        return fail('FOOD_FAILED', { lane, column }, String(e && e.message || e));
      }
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
