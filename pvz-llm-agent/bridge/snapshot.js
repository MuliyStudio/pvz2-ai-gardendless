/**
 * snapshot：把游戏对象树读成结构化状态。
 *
 * 只读；不判断、不建议、不改游戏。所有派生量都写明算法（ehp、dps、格数）。
 */
import { OBSTACLE_FACTS } from './stats.js';
import { worldFactOf } from '../knowledge/worlds.js';

const SQUARE_TYPE_LETTER = { 0: 'L', 1: 'S', 2: 'W', 3: 'W', 4: 'P' };
const SQUARE_TYPE_NAME = { 0: 'land', 1: 'sky', 2: 'water', 3: 'sea', 4: 'plank' };

const TASK_MODE_NAME = {
  0: 'plant_count_limit', 1: 'plant_lose_limit', 2: 'sun_cost_limit',
  3: 'sun_produce_request', 4: 'sun_cost_countdown', 5: 'kill_count_request', 6: 'timed_kill',
};
const TASK_MODE_SEMANTICS = {
  0: 'count_limit', 1: 'loss_limit', 2: 'sun_budget', 3: 'sun_produce',
  4: 'countdown', 5: 'kill_count', 6: 'sliding_window',
};
const TASK_LIMIT_KEYS = ['plantCountLimit', 'plantLoseLimit', 'sunCostLimit', 'sunProduceRequest', 'sunCostCountDownLimit', 'zombieKillCount'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const firstNumber = (s) => {
  const m = String(s == null ? '' : s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export function cleanCodename(t) {
  return String(t || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();
}

export function parsePlantLimit(texts) {
  for (const raw of texts || []) {
    const s = String(raw || '');
    const m = /(?:no more than|more than|over|at most|maximum of|max(?:imum)?)\s*(\d+)\s*plants?/i.exec(s)
      || /(\d+)\s*plants?\s*(?:max|limit)/i.exec(s)
      || /(?:最多|不超过|只能种|上限).{0,8}?(\d+)\s*株/.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}

export function createSnapshotReader({ getCc, findCompByClass, stats, version }) {
  let compCache = { scene: null, map: null, at: 0 };
  const learnedCells = new Map();
  const taskTrack = new Map();
  const collectStats = { total: 0, lastAt: 0, kinds: {} };
  let autoCollectTimer = null;

  function findComps() {
    const cc = getCc();
    const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
    if (!scene) return null;
    const now = Date.now();
    if (compCache.scene === scene && compCache.map && now - compCache.at < 500) return { cc, scene, map: compCache.map };
    const map = Object.create(null);
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k && !map[k]) map[k] = c;
      }
      for (const ch of n.children || []) walk(ch);
    };
    walk(scene);
    compCache = { scene, map, at: now };
    return { cc, scene, map };
  }

  function cellPlants(cell) {
    if (!cell) return [];
    const out = [];
    for (const g of [cell.plantInSquare, cell.vineInSquare, cell.tilePlantInSquare, cell.iminaterInSquare,
      cell.floawerpot ? [cell.floawerpot] : null, cell.lilypad ? [cell.lilypad] : null]) {
      if (!Array.isArray(g)) continue;
      for (const p of g) {
        if (!p || out.includes(p)) continue;
        let alive = true;
        try { alive = p.isAlive ? p.isAlive() : true; } catch { alive = true; }
        if (alive) out.push(p);
      }
    }
    return out;
  }

  function learnCell(lane, column, code) {
    learnedCells.set(`${lane}:${column}`, { until: Date.now() + 15000, code: code || 'CELL_BLOCKED' });
  }

  // 场景里可能同时存在「未激活的模板」和「本关真实的」LevelObjectiveScreen。
  // 模板的 screenName 是占位符（<LEVEL OBJECTIVE NAME>），mission0 是引擎默认文案
  // （典型："Never have more than 18 plants"）——那不是本关任务，必须整块丢掉，
  // 否则模型会把它当成本关规则（曾被误读成"18 株上限"）。
  // 僵尸护甲当前血量：引擎没有统一字段，这里按几种常见挂法读，读不到就返回 null（不猜）。
  function liveArmorHp(z) {
    if (!z) return null;
    try {
      for (const v of [z.armorHp, z.armorHealth, z.armorHpNum]) {
        if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
      }
      for (const list of [z.armors, z.armorList, z.armorComponents]) {
        if (!Array.isArray(list)) continue;
        let sum = 0, any = false;
        for (const a of list) {
          const hp = a && (typeof a.hp === 'number' ? a.hp : (typeof a.health === 'number' ? a.health : (typeof a.toughness === 'number' ? a.toughness : null)));
          if (hp != null) { sum += hp; any = true; }
        }
        if (any) return Math.max(0, sum);
      }
      for (const one of [z.armor, z.helmet]) {
        if (!one || typeof one !== 'object') continue;
        const hp = typeof one.hp === 'number' ? one.hp : (typeof one.health === 'number' ? one.health : null);
        if (hp != null) return Math.max(0, hp);
      }
      const kids = z.node && z.node.children;
      if (Array.isArray(kids)) {
        let sum = 0, any = false;
        for (const k of kids) {
          for (const c of (k && k._components) || []) {
            const cls = String(c && (c.__classname__ || (c.constructor && c.constructor.name)) || '');
            if (!/armor/i.test(cls)) continue;
            const hp = typeof c.health === 'number' ? c.health : (typeof c.hp === 'number' ? c.hp : null);
            if (hp != null) { sum += hp; any = true; }
          }
        }
        if (any) return Math.max(0, sum);
      }
    } catch { /* ignore */ }
    return null;
  }

  function readObjective(scene) {
    const found = [];
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k === 'LevelObjectiveScreen') found.push({ comp: c, node: n });
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { if (scene) walk(scene); } catch { /* ignore */ }
    if (!found.length) return null;

    const describe = ({ comp, node }) => {
      const screenName = comp.screenName && typeof comp.screenName.string === 'string' ? comp.screenName.string : '';
      // 占位符 / 空名称 = 未初始化的模板对象，它的 mission0 是引擎默认英文文案。
      // 真实关卡会把 screenName 本地化成诸如「海盗港湾 - 第 13 天目标」。
      const trusted = !!screenName.trim() && !/^[<【].*[>】]$/.test(screenName.trim());
      const active = !!node && node.activeInHierarchy !== false && node.active !== false && !comp.faded;
      return { comp, node, screenName, trusted, active, canContinue: typeof comp.continue === 'function' };
    };
    const all = found.map(describe);
    // 优先「正在显示的真实任务」，其次任意已本地化的，最后才是模板。
    const hit = all.find((x) => x.active && x.trusted)
      || all.find((x) => x.trusted)
      || all.find((x) => x.active)
      || all[0];

    if (!hit.trusted) {
      // 不信任时连 missions 也不返回：留一个空数组，模型就没东西可误读。
      return { screenName: hit.screenName, missions: [], active: hit.active, trusted: false, canContinue: hit.canContinue };
    }

    const missions = [];
    const push = (t) => {
      const s = String(t || '').trim();
      if (!s || s.length < 3) return;
      if (s === hit.screenName) return;
      if (/^[<【].*[>】]$/.test(s)) return;
      if (/^(继续|开始|开始游戏|确定|下一步|返回|取消|continue|ok|next|back|cancel)$/i.test(s)) return;
      if (/^(关卡任务|任务|任务目标|目标|本关任务|任务说明|任务要点|level objectives?|objectives?)$/i.test(s)) return;
      if (missions.indexOf(s) < 0) missions.push(s);
    };
    if (hit.comp.mission0 && typeof hit.comp.mission0.string === 'string') push(hit.comp.mission0.string);
    const walkLabels = (n) => {
      for (const c of n._components || []) {
        const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (cls === 'cc.Label' && typeof c.string === 'string') push(c.string);
      }
      for (const ch of n.children || []) walkLabels(ch);
    };
    if (hit.node) walkLabels(hit.node);
    return { screenName: hit.screenName, missions, active: hit.active, trusted: true, canContinue: hit.canContinue };
  }

  // 植物上限优先取结构化字段（LevelTaskCount.plantCountLimit），
  // 文本匹配只作为兜底，而且只用在「已本地化的真实任务」上。
  function taskPlantLimit(tasks) {
    for (const t of tasks || []) {
      const v = t && t.limits ? t.limits.plantCountLimit : null;
      if (typeof v === 'number' && v > 0) return v;
    }
    return null;
  }

  function applyTaskSemantics(t) {
    const mode = t.mode;
    const start = t.starting || {};
    const obj = t.detail || {};
    const countNum = firstNumber(t.count);
    const now = Date.now();

    if (mode === 6) {
      const total = t.total || num(start.ZombiesToKill) || 0;
      const limit = t.timeLimit || num(start.Time) || 0;
      let st = taskTrack.get(t.key);
      if (!st) { st = { lastValue: 0, kills: [], updatedAt: now }; taskTrack.set(t.key, st); }
      if (typeof t.value === 'number') {
        const delta = t.value - st.lastValue;
        if (delta > 0) { for (let i = 0; i < delta && i < 40; i++) st.kills.push(now); }
        else if (delta < 0) st.kills.splice(0, Math.min(st.kills.length, -delta));
        st.lastValue = t.value;
      }
      if (limit > 0) while (st.kills.length && now - st.kills[0] > limit * 1000) st.kills.shift();
      st.updatedAt = now;
      const timeLeft = limit > 0 && st.kills.length ? Math.max(0, limit - (now - st.kills[0]) / 1000) : null;
      const need = total > 0 && typeof t.value === 'number' ? Math.max(0, total - t.value) : null;
      t.timeSemantics = 'sliding_window';
      t.windowActive = !t.completed && !t.failed && (timeLeft !== null ? timeLeft > 0 : !!t.value);
      t.timeLeft = timeLeft === null ? null : Math.round(timeLeft * 10) / 10;
      t.windowKills = limit > 0 ? st.kills.length : (t.value || 0);
      t.timeLimit = limit || null;
      t.need = need;
      t.urgent = !t.completed && !t.failed && need !== null && need > 0
        && ((t.timeLeft !== null && t.timeLeft <= 5) || (total > 0 && (t.value || 0) / total >= 0.75));
      if (t.completed) t.hint = '任务已完成';
      else if (t.failed) t.hint = '任务已失败';
      else if (t.timeLeft !== null && t.windowActive) t.hint = `滑动窗口还剩 ${t.timeLeft.toFixed(1)} 秒，当前 ${t.value}/${total}，需再杀 ${need} 个`;
      else if (need !== null) t.hint = `最近 ${limit} 秒窗口内击杀 ${t.value}/${total}，还需 ${need} 个`;
      return;
    }

    t.semantics = mode === null ? 'unknown' : (TASK_MODE_SEMANTICS[mode] || 'unknown');
    switch (mode) {
      case 0: {
        const total = num(start.MaximumPlants) ?? t.total;
        const left = countNum ?? num(obj.LeftPlants);
        if (total && left !== null) {
          t.total = total;
          t.value = Math.max(0, total - left);
          t.percent = Math.round((t.value / total) * 100);
        }
        t.left = left;
        t.hint = `还能种 ${left ?? '?'} 株（上限 ${total ?? '?'}）`;
        t.urgent = left !== null && left <= 2;
        break;
      }
      case 1: {
        const total = num(start.MaximumPlantsLost) ?? t.total;
        const left = num(obj.LeftPlantsToLose) ?? countNum;
        if (total && left !== null) {
          t.total = total;
          t.value = Math.max(0, total - left);
          t.percent = Math.round((t.value / total) * 100);
        }
        t.left = left;
        t.hint = `还可损失 ${left ?? '?'} 株（上限 ${total ?? '?'}），再丢就失败`;
        t.urgent = left !== null && left <= 1;
        break;
      }
      case 2: {
        const left = num(obj.LeftSun) ?? countNum;
        t.left = left;
        t.hint = `剩余阳光额度 ${left ?? '?'}`;
        t.urgent = left !== null && left <= 100;
        break;
      }
      case 3: {
        const produced = num(obj.SunProduced) ?? t.value;
        const total = num(start.TargetSun) ?? t.total;
        t.value = produced;
        t.total = total;
        if (produced !== null && total) t.percent = Math.round((produced / total) * 100);
        t.hint = `已产生 ${produced ?? '?'}/${total ?? '?'} 阳光`;
        t.urgent = produced !== null && total ? produced / total >= 0.8 : false;
        break;
      }
      case 4: {
        const left = num(obj.LeftTime) ?? t.timeLeft;
        t.timeSemantics = 'countdown';
        t.timeLimit = num(start.HoldoutSeconds) ?? t.timeLimit;
        t.timeLeft = left !== null ? Math.round(left * 10) / 10 : null;
        t.windowActive = left !== null && left > 0;
        t.hint = `倒计时 ${t.timeLeft ?? '?'} 秒`;
        t.urgent = left !== null && left <= 5;
        break;
      }
      case 5:
        t.hint = `击杀 ${t.value ?? '?'}/${t.total ?? '?'}`;
        t.urgent = false;
        break;
      default:
        t.hint = t.count || '';
        t.urgent = false;
    }
  }

  function readTasks(scene) {
    const tasks = [];
    if (!scene) return tasks;
    const walk = (n) => {
      for (const c of n._components || []) {
        const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (cls !== 'LevelTaskCount') continue;
        const tip = typeof c.tip === 'string' ? c.tip : '';
        const count = c.count && typeof c.count.string === 'string' ? c.count.string : '';
        const mode = num(c.mode);
        let value = null;
        let total = null;
        if (count && count.indexOf('/') >= 0) {
          const parts = count.split('/');
          value = Number(parts[0]);
          total = Number(parts[1]);
          if (!Number.isFinite(value)) value = null;
          if (!Number.isFinite(total)) total = null;
        }
        const limits = {};
        for (const k of TASK_LIMIT_KEYS) {
          const v = c[k];
          if (typeof v === 'number' && v !== 0) limits[k] = v;
        }
        const starting = {};
        try {
          if (c.startingObjdata && typeof c.startingObjdata === 'object') {
            for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds', 'LeftSun']) {
              const v = c.startingObjdata[k];
              if (typeof v === 'number') starting[k] = v;
            }
            for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds']) {
              if (starting[k] === undefined && typeof c[k] === 'number') starting[k] = c[k];
            }
          }
        } catch { /* ignore */ }
        let detail;
        try {
          if (c.objdata && typeof c.objdata === 'object') {
            detail = {};
            let n2 = 0;
            for (const k of Object.keys(c.objdata)) {
              const v = c.objdata[k];
              if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') detail[k] = v;
              if (++n2 >= 8) break;
            }
          }
        } catch { detail = undefined; }

        const task = {
          key: tip || ('mode_' + mode),
          tip,
          count,
          value,
          total,
          percent: value !== null && total ? Math.round((value / total) * 100) : null,
          mode,
          modeName: mode === null ? null : (TASK_MODE_NAME[mode] || 'mode_' + mode),
          completed: !!c.completed,
          failed: !!c.failed,
          limits: Object.keys(limits).length ? limits : undefined,
          starting: Object.keys(starting).length ? starting : undefined,
          timeLimit: mode === 6 ? num(starting.Time) : (mode === 4 ? num(starting.HoldoutSeconds) : null),
          detail,
        };
        if (task.value === null && task.percent === null && (mode === null || TASK_MODE_SEMANTICS[mode] === undefined)
          && c.progress && typeof c.progress._progress === 'number') {
          const p = c.progress._progress;
          task.percent = Math.round(p * 100);
          if (task.percent > 100) task.percent = 100;
        }
        if (!task.modeName && task.mode !== null) task.modeName = 'mode_' + task.mode;
        applyTaskSemantics(task);
        tasks.push(task);
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { walk(scene); } catch { /* ignore */ }
    return tasks;
  }

  function collectPickups() {
    const ctxg = findComps();
    if (!ctxg || !ctxg.scene) return { ok: false, code: 'NO_SCENE', reason: '不在游戏场景内', count: 0, kinds: {} };
    const kinds = Object.create(null);
    let count = 0;
    const isUnderNames = (node, names) => {
      let p = node, depth = 0;
      while (p && depth++ < 12) {
        if (p.name && names.indexOf(p.name) >= 0) return true;
        p = p.parent;
      }
      return false;
    };
    const walk = (n) => {
      if (!n || n.active === false) return;
      for (const c of n._components || []) {
        if (!c || c.collected !== false || c.mouseListen !== true) continue;
        if (typeof c.collect !== 'function') continue;
        if (isUnderNames(n, ['Prizes', 'CurrencyShower'])) continue;
        try { if (c.collectable && !c.collectable()) continue; } catch { /* ignore */ }
        try {
          const type = c.DroppingType || c.__classname__ || (c.constructor && c.constructor.name) || 'item';
          c.collect();
          kinds[type] = (kinds[type] || 0) + 1;
          count++;
        } catch { /* ignore one drop */ }
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { walk(ctxg.scene); } catch { /* ignore */ }
    if (count) {
      collectStats.total += count;
      collectStats.lastAt = Date.now();
      for (const k of Object.keys(kinds)) collectStats.kinds[k] = (collectStats.kinds[k] || 0) + kinds[k];
    }
    return { ok: true, count, kinds };
  }

  function setAutoCollect(on) {
    if (autoCollectTimer) { clearInterval(autoCollectTimer); autoCollectTimer = null; }
    if (on !== false) {
      autoCollectTimer = setInterval(() => {
        try { collectPickups(); } catch { /* ignore */ }
      }, 900);
    }
    return { ok: true, on: on !== false };
  }

  function collectCartRefs(C, lanes, cols) {
    const seen = new Set();
    const refs = [];
    for (let r = 0; r < lanes; r++) {
      for (let c = 0; c < cols; c++) {
        let cell = null;
        try { cell = C.getLnC(r, c); } catch { cell = null; }
        if (!cell || !cell.rail) continue;
        let cart = null;
        try { cart = cell.cart; } catch { cart = null; }
        if (!cart || seen.has(cart)) continue;
        seen.add(cart);
        const inL = cart._inLnC || null;
        const lane = inL && Number.isFinite(inL.lIndex) ? inL.lIndex : null;
        const column = inL && Number.isFinite(inL.cIndex) ? inL.cIndex : null;
        const railLanes = [];
        if (column !== null) {
          for (let rr = 0; rr < lanes; rr++) {
            let cc = null;
            try { cc = C.getLnC(rr, column); } catch { cc = null; }
            if (cc && cc.rail && Array.isArray(cc.rail.carts) && cc.rail.carts.indexOf(cart) >= 0) railLanes.push(rr);
          }
        }
        let canUp = false, canDown = false;
        try { canUp = !!(inL && inL.upper && cart.canMoveToLnC(inL.upper)); } catch { canUp = false; }
        try { canDown = !!(inL && inL.lower && cart.canMoveToLnC(inL.lower)); } catch { canDown = false; }
        refs.push({ cart, lane, column, railLanes, canUp, canDown });
      }
    }
    return refs;
  }

  function readCarts(C, lanes, cols) {
    return collectCartRefs(C, lanes, cols).map((ref, i) => ({
      id: i,
      lane: ref.lane,
      column: ref.column,
      railLanes: ref.railLanes,
      plants: ref.lane !== null && ref.column !== null
        ? cellPlants(C.getLnC(ref.lane, ref.column)).map((p) => {
          const type = cleanCodename(p.Plant_Type || '');
          const st = stats.plantStatsOf(type);
          return { type, name: (st && st.name) || type, hp: Math.round(p.health || 0) };
        })
        : [],
      canUp: ref.canUp,
      canDown: ref.canDown,
    }));
  }

  function levelFacts(lvl, sceneName) {
    const name = (lvl && lvl.levelName) || '';
    const source = {
      world: (lvl && (lvl.worldName || lvl.worldKey || lvl.world || lvl.stageName)) || null,
      levelId: (lvl && (lvl.levelId || lvl.levelID)) || null,
      custom: !!(lvl && (lvl.isCustomLevel || lvl.customLevel)),
      description: (lvl && (lvl.levelDescription || lvl.description)) || null,
      scene: sceneName || null,
    };
    const fact = worldFactOf([name, source.world, sceneName].filter(Boolean).join(' '));
    return {
      name,
      source,
      world: fact ? { key: fact.key, name: fact.name, mechanics: fact.mechanics.slice(), zombies: fact.zombies.slice() } : null,
    };
  }

  function cardState(cards, sunNow) {
    const out = { cards: [], deck: [], seedSelection: null };
    try {
      if (cards && Array.isArray(cards.CFs)) {
        out.cards = cards.CFs.map((cf, i) => {
          const upper = cards.cardsUIUpper && cards.cardsUIUpper[i];
          const cdRaw = upper ? Math.max(0, +upper.CD || 0) : 0;
          const cd = Math.round(cdRaw * 10) / 10;
          const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
          const st = stats.plantStatsOf(cleanCodename(cf.Type));
          const cdReady = cd <= 0;
          const affordable = sunNow == null ? true : sunNow >= cost;
          return {
            index: i, type: cleanCodename(cf.Type), name: (st && st.name) || cleanCodename(cf.Type), cost,
            cd, cdReady, affordable,
            // 还差多少阳光；买得起时是 0
            sunShort: affordable ? 0 : Math.max(0, cost - (sunNow || 0)),
            // ready = 冷却好了 且 买得起（旧字段，语义保持）
            ready: cdReady && affordable,
            cooling: !cdReady,
            // 完整数值只在 pvz_briefing.cards 里给一次；每回合都带会让 prompt 翻几倍
          };
        });
        out.deck = out.cards.map((c) => c.type);
      }
    } catch { /* ignore */ }
    try {
      if (cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)) {
        out.seedSelection = {
          slots: cards.maxSlotCount || 0,
          current: (cards.CFs || []).map((c) => cleanCodename(c.Type)),
          gameStartable: typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : null,
          availableCount: cards.seedChooser.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length,
          // 只留选卡需要的轻量字段：完整数值在 pvz_briefing.cards 里，别每个回合都塞一遍。
          available: cards.seedChooser.CFs
            .filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed)))
            .map((cf) => {
              const type = cleanCodename(cf.Type);
              const st = stats.plantStatsOf(type);
              return {
                type,
                name: (st && st.name) || type,
                cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0,
                chosen: !!(cf.ca && cf.ca.chosen),
              };
            }),
        };
      }
    } catch { /* ignore */ }
    return out;
  }

  function snapshot(opts) {
    const full = !!(opts && opts.full);
    // lean = 每回合都发的状态：cards 不带数值、levelScript 只留波数摘要。
    // full = pvz_briefing 用：要完整波次表。完整数值体积差 3-4 倍，直接决定模型延迟。
    const leanLevelScript = (ls) => (ls ? { waveCount: ls.waveCount, flagInterval: ls.flagInterval, isAtNight: !!(ls.lawn && ls.lawn.isAtNight) } : null);
    const ctxg = findComps();
    if (!ctxg) return { ok: false, code: 'NO_SCENE', reason: '不在游戏场景内' };
    const { map, scene } = ctxg;
    const C = map.Square && map.Square.constructor;
    const sceneName = scene.name || '';
    const lvl = map.levelController;
    const ui = map.UIInGame;
    const cards = map.Cards;

    let phase = 'other';
    if (sceneName === 'mainScene') phase = 'menu';
    else if (/worldmap/i.test(sceneName)) phase = 'worldmap';
    else if (sceneName === 'inGameScene' || C) {
      const presetNow = !!(lvl && lvl.lastStandPrepareStarted && !lvl.gameStarted);
      const fighting = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted) || presetNow;
      if (lvl && lvl.gameWon) phase = 'won';
      else if (lvl && lvl.gameLost) phase = 'lost';
      else if (!fighting) phase = 'preparing';
      else phase = 'running';
    }

    const objective = readObjective(scene);
    if (phase === 'preparing' && objective && objective.active) phase = 'objective';
    const tasks = readTasks(scene);
    // readObjective 已经丢掉模板 missions；这里只与 tasks.tip 去重后作为任务原文。
    const objectiveMissions = objective && objective.trusted ? objective.missions : [];
    const missionHints = [...new Set(
      objectiveMissions.concat(tasks.map((t) => t.tip).filter(Boolean)),
    )];

    if (!C) {
      // 任务说明/选卡阶段可能还没有棋盘；仍然要返回任务、关卡脚本、卡池，供 briefing 使用。
      const level = levelFacts(lvl, sceneName);
      let sunNow = null, foodNow = null;
      try { sunNow = map.SunCount ? map.SunCount.CurrentValue : null; } catch { /* ignore */ }
      try { foodNow = map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null; } catch { /* ignore */ }
      const cs = cardState(cards, sunNow);
      let lsFull = null;
      try { lsFull = lvl ? stats.levelScriptOf(lvl) : null; } catch { lsFull = null; }
      const ls = full ? lsFull : leanLevelScript(lsFull);
      const limitFromTask = taskPlantLimit(tasks);
      const limit = limitFromTask != null ? limitFromTask : parsePlantLimit(missionHints);
      return {
        ok: phase !== 'other', version, scene: sceneName, phase,
        reason: '场景还没有棋盘',
        paused: !!(ui && ui.paused),
        objective, tasks, missionHints,
        sun: sunNow, plantFood: foodNow,
        level: {
          ...level,
          wave: lvl && Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0,
          waves: lvl && lvl.waveManagerProps ? lvl.waveManagerProps.WaveCount : null,
          nextWaveIn: lvl && Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null,
          gameStarted: !!(lvl && lvl.gameStarted),
        },
        cards: cs.cards, deck: cs.deck, seedSelection: cs.seedSelection,
        plants: [], zombies: [], lanes: [], board: [],
        terrain: null, blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [], mechanics: [],
        levelScript: ls, zombieStats: {},
        limits: { plantLimit: limit, plantsPlanted: 0, plantsLeft: limit, slots: cs.seedSelection ? cs.seedSelection.slots : 0, plantLimitSource: limit == null ? null : (limitFromTask != null ? 'task' : 'objective') },
        plantLimit: limit,
        startingSun: phase === 'preparing' || phase === 'objective' ? sunNow : null,
        carts: [],
        collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
        world: level.world,
      };
    }
    const lanes = C.LaneCount || 5;
    const cols = C.ColumnCount || 9;

    const level = levelFacts(lvl, sceneName);
    const out = {
      ok: true, version, scene: sceneName,
      phase, paused: !!(ui && ui.paused),
      sun: null, plantFood: null,
      level: { ...level, wave: 0, waves: null, nextWaveIn: null, gameStarted: false },
      cards: [], deck: [], plants: [], zombies: [], board: [], lanes: [],
      blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [],
      levelScript: null, seedSelection: null, zombieStats: {}, tasks, objective, missionHints,
      terrain: { lanes, columns: cols, map: [], legend: { L: 'land', W: 'water', P: 'plank', S: 'sky', R: 'rail', '?': 'unknown' } },
      limits: { plantLimit: null, plantsPlanted: 0, plantsLeft: null, slots: 0 },
      plantLimit: null, startingSun: null, carts: [], mechanics: [],
      collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
      world: level.world,
    };
    try { out.sun = map.SunCount ? map.SunCount.CurrentValue : null; } catch { /* ignore */ }
    try { out.plantFood = map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null; } catch { /* ignore */ }

    let lsFull = null;
    if (lvl) {
      out.level.wave = Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0;
      out.level.waves = lvl.waveManagerProps ? lvl.waveManagerProps.WaveCount : null;
      out.level.nextWaveIn = Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null;
      out.level.gameStarted = !!lvl.gameStarted;
      try { lsFull = stats.levelScriptOf(lvl); } catch { lsFull = null; }
      out.levelScript = full ? lsFull : leanLevelScript(lsFull);
      if (!out.level.waves && lsFull) out.level.waves = lsFull.waveCount || null;
    }
    if (phase === 'preparing' || phase === 'objective') out.startingSun = out.sun;

    // 卡片 / 选卡
    const cs = cardState(cards, out.sun);
    out.cards = cs.cards;
    out.deck = cs.deck;
    // 只在选卡/任务阶段返回完整可选卡池；战斗中已经有卡组，避免每次状态都塞 30KB 的卡池。
    out.seedSelection = (phase === 'preparing' || phase === 'objective') ? cs.seedSelection : null;
    out.limits.slots = (cards && cards.maxSlotCount) || (out.seedSelection && out.seedSelection.slots) || (out.deck || []).length || 0;

    // 棋盘 / 植物 / 障碍
    const blocked = [];
    const obstacles = [];
    out.plants = [];
    out.board = [];
    out.terrain.map = [];
    const squareTypes = [];
    for (let r = 0; r < lanes; r++) {
      const cells = new Array(cols).fill(null);
      const terrainRow = new Array(cols).fill('?');
      const typeRow = new Array(cols).fill(null);
      for (let c = 0; c < cols; c++) {
        const cell = C.getLnC(r, c);
        if (!cell) continue;
        let st = null;
        try { st = num(cell.squareType); } catch { st = null; }
        if (st === null) { try { st = num(cell._squareType); } catch { st = null; } }
        typeRow[c] = st;
        if (st !== null) terrainRow[c] = SQUARE_TYPE_LETTER[st] || '?';
        try { if (cell.rail) terrainRow[c] = 'R'; } catch { /* ignore */ }
        try {
          if (cell.rail) obstacles.push({ lane: r, column: c, type: 'rail', name: '矿车轨道', blocksPlanting: null, blocksStraightShot: false, removeBy: null });
        } catch { /* ignore */ }
        if (terrainRow[c] === 'W') blocked.push({ lane: r, column: c, reason: 'water' });
        else if (terrainRow[c] === 'S') blocked.push({ lane: r, column: c, reason: 'sky' });
        try {
          if (terrainRow[c] === 'R' && !cell.cart) blocked.push({ lane: r, column: c, reason: 'rail' });
        } catch { /* ignore */ }
        const list = cellPlants(cell);
        if (list.length) {
          const p = list[0];
          const type = cleanCodename(p.Plant_Type);
          const pst = stats.plantStatsOf(type);
          cells[c] = type;
          out.plants.push({
            lane: r, column: c, type, name: (pst && pst.name) || type,
            hp: Math.round(p.health || 0), maxHp: Math.round(p.toughness || 0),
            atk: pst ? pst.attack : null, shot: pst ? pst.shot : null,
            protected: false,
          });
        }
        if (cell.haveTomb) { blocked.push({ lane: r, column: c, reason: 'tomb' }); obstacles.push({ lane: r, column: c, type: 'tomb', name: '墓碑', ...OBSTACLE_FACTS.tomb }); }
        if (cell.mold) { blocked.push({ lane: r, column: c, reason: 'mold' }); obstacles.push({ lane: r, column: c, type: 'mold', name: '霉斑', ...OBSTACLE_FACTS.mold }); }
        if (cell.iceTile) { blocked.push({ lane: r, column: c, reason: 'ice' }); obstacles.push({ lane: r, column: c, type: 'ice', name: '冰块', ...OBSTACLE_FACTS.ice }); }
        try {
          if (cell.vases && cell.vases.length) {
            blocked.push({ lane: r, column: c, reason: 'vase' });
            obstacles.push({ lane: r, column: c, type: 'vase', name: '罐子', ...OBSTACLE_FACTS.vase });
          }
        } catch { /* ignore */ }
        try {
          for (const t of cell.tilesInSquare || []) {
            const cls = String((t && (t.__classname__ || (t.constructor && t.constructor.name))) || '');
            if (/goldTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'gold', name: '金瓷砖', ...OBSTACLE_FACTS.gold });
            else if (/sliderTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'slider', name: '滑轨格', ...OBSTACLE_FACTS.slider });
            else if (/endangeredTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'endangered', name: '濒危植物格', blocksPlanting: null, blocksStraightShot: null });
          }
        } catch { /* ignore */ }
      }
      out.board.push({ lane: r, cells, terrain: terrainRow.slice(), zombies: [] });
      out.terrain.map.push(terrainRow.join(''));
      squareTypes.push(typeRow);
    }
    out.terrain.squareTypes = squareTypes;
    // 直线遮挡
    const straightBlockers = obstacles.filter((o) => o.blocksStraightShot === true);
    for (const p of out.plants) {
      if (!p.shot || !p.shot.blockedByStraightBlocker) continue;
      const hit = straightBlockers.filter((b) => b.lane === p.lane && b.column > p.column).sort((a, b) => a.column - b.column)[0];
      if (hit) p.blockedAt = { lane: hit.lane, column: hit.column, type: hit.type };
    }

    // 僵尸
    for (let r = 0; r < lanes; r++) {
      const lane = C.getLane && C.getLane(r);
      if (!lane) continue;
      let pool = [];
      try { pool = (lane.zombiePool ? lane.zombiePool() : []).concat(lane.hypnoZombiePool ? lane.hypnoZombiePool() : []); } catch { pool = []; }
      for (const z of pool) {
        if (!z) continue;
        let alive = true;
        try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
        if (!alive) continue;
        const col = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
        const type = cleanCodename(z.Zombie_Type);
        const zst = out.zombieStats[type] || stats.zombieStatsOf(type);
        out.zombieStats[type] = zst;
        const hp = Math.round(z.health || 0);
        const armorNow = liveArmorHp(z);
        const armorMax = zst && zst.armorHp != null ? zst.armorHp : 0;
        out.zombies.push({
          lane: r, column: Math.round(col * 10) / 10, type, name: (zst && zst.name) || type,
          hp, maxHp: Math.round((z.totalHealth ? z.totalHealth() : z.health) || 0),
          // 护甲：armorHp 读不到时为 null；ehp 是「本体 + 当前护甲」，读不到护甲时只给 ehpMax 上界
          armorHp: armorNow,
          armorMax: armorMax || null,
          ehp: armorNow != null ? hp + armorNow : null,
          ehpMax: hp + armorMax,
          tags: (zst && zst.tags) || [],
        });
      }
    }
    out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);
    for (const row of out.board) row.zombies = out.zombies.filter((z) => z.lane === row.lane);

    // 行信息（只给事实：数量、最近列、推车、射手/墙株数、dps 合计）
    out.lanes = [];
    for (let r = 0; r < lanes; r++) {
      const zs = out.zombies.filter((z) => z.lane === r);
      const ps = out.plants.filter((p) => p.lane === r);
      let mower = false;
      try {
        const lane = C.getLane && C.getLane(r);
        mower = !!(lane && lane.mower);
      } catch { mower = false; }
      out.lanes.push({
        lane: r, zombies: zs.length,
        nearestZombie: zs.length ? Math.min(...zs.map((z) => z.column)) : null,
        shooters: ps.filter((p) => p.atk && p.atk.dps).length,
        walls: ps.filter((p) => /peanut|tallnut|wallnut|holonut|endurian/i.test(p.type)).length,
        plants: ps.length,
        dps: Math.round(ps.reduce((s, p) => s + ((p.atk && p.atk.dps) || 0), 0) * 10) / 10,
        wallHp: ps.reduce((s, p) => s + (/peanut|tallnut|wallnut|holonut|endurian/i.test(p.type) ? (p.hp || 0) : 0), 0),
        // 本行在场上僵尸的剩余 EHP 合计（读不到护甲时用 ehpMax 上界），以及是否全是精确值
        ehp: Math.round(zs.reduce((s, z) => s + (z.ehp != null ? z.ehp : z.ehpMax || 0), 0)),
        ehpExact: zs.every((z) => z.ehp != null),
        mower,
      });
    }

    // 最近 15 秒被判 CELL_BLOCKED 的格子
    try {
      const now = Date.now();
      const seen = new Set(blocked.map((b) => `${b.lane}:${b.column}`));
      for (const [k, v] of learnedCells) {
        if (!v || v.until <= now) { learnedCells.delete(k); continue; }
        const [lane, column] = k.split(':').map(Number);
        if (seen.has(k)) continue;
        seen.add(k);
        blocked.push({ lane, column, reason: v.code || 'blocked', learned: true });
      }
    } catch { /* ignore */ }

    out.blockedCells = blocked;
    out.obstacles = obstacles;
    out.plantable = out.board.map((row) => ({
      lane: row.lane,
      columns: row.cells.map((v, c) => (v ? null : c)).filter((c) => c != null
        && !blocked.some((b) => b.lane === row.lane && b.column === c)
        && row.terrain[c] !== 'W' && row.terrain[c] !== 'S'),
    }));

    // 本关机制事实
    try {
      const tagSet = new Set();
      for (const t of Object.keys(out.zombieStats || {})) for (const g of ((out.zombieStats[t] || {}).tags || [])) tagSet.add(g);
      const TAG_TEXT = {
        rolling: '滚动僵尸（滚桶/滚木）：会被地刺类破坏，普通射手无法阻挡',
        flying: '飞行僵尸：地刺与地面阻挡无效',
        steal: '偷植物能力：关键株被偷会空一格',
        crush: '砸毁植物的巨尸：锤击会直接移除植物',
        gargantuar: '巨人僵尸：高血量单位',
        armored: '装甲僵尸：护甲计入 EHP',
        carries_imp: '会投出小鬼：后排可能被绕后',
        lane_switch: '会换行：火力不能只压一行',
        rush: '吃到植物后会加速',
        amphibious: '可进入深水',
        hypnotizable: '可被魅惑',
      };
      for (const g of tagSet) if (TAG_TEXT[g]) out.mechanicFacts.push({ id: g, text: TAG_TEXT[g], source: 'zombie-tags' });
    } catch { /* ignore */ }

    const ls = lsFull;
    if (out.terrain.map.some((row) => /[WS]/.test(row))) out.mechanicFacts.push({ id: 'water', text: '存在水面/天空格：普通植物不能直接种在这些格子上', source: 'terrain' });
    if (out.terrain.map.some((row) => /R/.test(row))) out.mechanicFacts.push({ id: 'rail', text: '存在矿车轨道：矿车可载植物上下移动', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'tomb')) out.mechanicFacts.push({ id: 'tomb', text: '墓碑占格并阻挡直线弹道', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'ice')) out.mechanicFacts.push({ id: 'ice', text: '冰块占格，需要对应卡牌处理', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'gold')) out.mechanicFacts.push({ id: 'gold', text: '存在金瓷砖格', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'slider')) out.mechanicFacts.push({ id: 'slider', text: '存在滑轨格', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'vase')) out.mechanicFacts.push({ id: 'vase', text: '存在罐子格（占格）', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'endangered')) out.mechanicFacts.push({ id: 'endangered', text: '存在濒危植物格', source: 'terrain' });
    if (ls) {
      if (ls.lawn && ls.lawn.isAtNight) out.mechanicFacts.push({ id: 'night', text: '夜间关卡：没有天空掉落的阳光', source: 'lawn' });
      for (const m of ls.modules || []) {
        if (/Portal/i.test(m.cls)) out.mechanicFacts.push({ id: 'portal', text: '关卡包含传送门模块', source: 'module' });
        if (/Dino/i.test(m.cls)) out.mechanicFacts.push({ id: 'dino', text: '关卡包含恐龙模块', source: 'module' });
        if (/Tide/i.test(m.cls)) out.mechanicFacts.push({ id: 'tide', text: '关卡包含潮汐模块', source: 'module' });
        if (/SunDropper/i.test(m.cls)) out.mechanicFacts.push({ id: 'sun_dropper', text: '天空会掉落阳光', source: 'module' });
      }
    }
    out.mechanics = deDupe(out.mechanicFacts);
    out.carts = readCarts(C, lanes, cols);

    // 关卡限制与图表事实：结构化字段优先，文本只作兜底（且只来自已本地化的真实任务）
    const limitFromTask = taskPlantLimit(tasks);
    const limit = limitFromTask != null ? limitFromTask : (parsePlantLimit(missionHints) || (out.levelScript && out.levelScript.plantLimit) || null);
    out.plantLimit = limit;
    out.limits.plantLimit = limit;
    out.limits.plantLimitSource = limit == null ? null : (limitFromTask != null ? 'task' : 'objective');
    out.limits.plantsPlanted = out.plants.length;
    out.limits.plantsLeft = limit != null ? Math.max(0, limit - out.plants.length) : null;

    // 每回合都发的精简版不带 zombieStats（完整数值 + 标签只在 pvz_briefing 里给）
    if (!full) delete out.zombieStats;

    return out;
  }

  function deDupe(list) {
    const seen = new Set();
    const out = [];
    for (const x of list || []) {
      if (!x || !x.id || seen.has(x.id)) continue;
      seen.add(x.id);
      out.push(x);
    }
    return out;
  }

  return {
    findComps, snapshot, readObjective, readTasks, cellPlants,
    collectPickups, setAutoCollect, collectStats,
    learnCell, learnedCells, readCarts, cartRefs: collectCartRefs,
  };
}
