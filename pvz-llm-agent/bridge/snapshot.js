/**
 * snapshot：把游戏对象树读成结构化状态。
 *
 * 只读；不判断、不建议、不改游戏。所有派生量都写明算法（ehp、dps、格数）。
 */
import { OBSTACLE_FACTS } from './stats.js';
import { buildForecast, nextWaves } from './forecast.js';
import { laneMath, counterMatrix, deckCapabilities, coverageAudit, wallSurvive, wallRebuildPlan } from './mechanics.js';
import { worldFactOf, TAG_COUNTERS } from '../knowledge/worlds.js';
import { plantFoodTargets } from '../knowledge/plant-rules.js';

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

export function createSnapshotReader({ getCc, findCompByClass, stats, latency = null, version }) {
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

  // 需要保护的鲜花格（海盗第 15 天这类任务）：场景里是 flowerLine 组件，带 lIndex/cIndex
  function protectCells() {
    const out = [];
    try {
      const cc = getCc();
      const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
      if (!scene) return out;
      const walk = (n) => {
        for (const c of n._components || []) {
          const k = String((c && (c.__classname__ || (c.constructor && c.constructor.name))) || '');
          if (k !== 'flowerLine') continue;
          const lane = Number(c.lIndex);
          const column = Number(c.cIndex);
          if (!Number.isFinite(lane) || !Number.isFinite(column)) continue;
          out.push({
            lane, column, dead: !!c.dead, tip: c.tip || null,
            // 僵尸从右往左走：column+1 是朝僵尸的一侧（前排），column-1 是朝房子的一侧（后排）。
            // 想挡住啃花的僵尸，防线应放在 column+1 或同列相邻；放到 column-2 及更左就完全够不到花。
            frontColumn: column + 1,
          });
        }
        for (const ch of n.children || []) walk(ch);
      };
      walk(scene);
    } catch { /* ignore */ }
    return out.slice(0, 12);
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
      // 资源名（cowboy13 这种）是这一关最稳定的 id：关卡总结按它归档
      asset: (lvl && lvl.Level && (lvl.Level.name || lvl.Level._name)) || (lvl && lvl.levelKey) || null,
      number: (lvl && lvl.levelDefinition && Number.isFinite(Number(lvl.levelDefinition.LevelNumber)))
        ? Number(lvl.levelDefinition.LevelNumber) : null,
      scene: sceneName || null,
    };
    const fact = worldFactOf([name, source.world, source.asset, sceneName].filter(Boolean).join(' '));
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
            // 基础冷却/定位/单体 DPS/射程：批量动作预检和“同卡一轮最多成功几个”要用，
            // 只有 4 个小字段，不会像完整数值那样把 prompt 撑大。
            baseCd: st ? st.cd : null,
            family: (st && st.family) || null,
            dps: (st && st.attack && st.attack.dps) || null,
            effectiveDps: (st && st.effectiveDps) || null,
            reach: st ? st.reach : null,
            stepDamage: !!(st && st.stepDamage),
            ignoresArmor: !!(st && st.ignoresArmor),
            targets: (st && st.attack && st.attack.targets) || 1,
            multiDps: (st && st.attack && st.attack.multiDps) || null,
            // 点击类 / 单发伤害 / 能量豆：每回合都要看得到，否则「能选不能用」。
            // 只放极短的 4 个字段，完整对象在 pvz_briefing.cards[]。
            activation: st && st.usage && st.usage.manual ? st.usage.activation : undefined,
            burstDmg: (st && st.burst && st.burst.dmg) || undefined,
            damageType: (st && st.damageType && st.damageType !== 'normal') ? st.damageType : undefined,
            armorState: (st && st.armorState && st.armorState !== 'no') ? st.armorState : undefined,
            foodKind: (st && st.plantFood && st.plantFood.kind) || undefined,
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
              const sunRate = st && st.sun && st.sun.perSecDay ? st.sun.perSecDay[st.sun.perSecDay.length - 1] : null;
              return {
                type,
                name: (st && st.name) || type,
                cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0,
                chosen: !!(cf.ca && cf.ca.chosen),
                // 选卡阶段直接带决策用的数值：历史消息被裁剪后，模型仍能按这些数比卡
                family: (st && st.family) || null,
                hp: st ? st.hp : null,
                cd: st ? st.cd : null,
                reach: st ? st.reach : null,
                armTimeSec: st ? st.armTimeSec : null,
                dps: (st && st.attack && st.attack.dps) || null,
                sunPerSec: sunRate != null ? Math.round(sunRate * 100) / 100 : null,
                paybackSec: (st && st.sun && st.sun.paybackSec) || null,
                kind: st && st.shot ? st.shot.kind : null,
                activation: (st && st.usage && st.usage.manual) ? st.usage.activation : undefined,
                burstDmg: (st && st.burst && st.burst.dmg) || undefined,
                foodKind: (st && st.plantFood && st.plantFood.kind) || undefined,
              };
            }),
        };
      }
    } catch { /* ignore */ }
    return out;
  }

  // 关卡准备模式：普通选卡 / 提前布阵 / 传送带 / 给定锁定卡组。
  // 这几种关卡的“开局前该做什么”不一样，必须当成结构化事实给模型，不能靠它从 phase 猜。
  function prepState(cards, lvl, phase) {
    if (phase === 'menu' || phase === 'worldmap' || phase === 'other') return null;
    const conveyor = !!(cards && (cards.conveyor || (lvl && lvl.conveyorMode)));
    const preplant = !!(lvl && lvl.lastStandPrepareStarted && !lvl.gameStarted);
    const seed = cards && cards.seedChooser;
    const slots = Number(cards && cards.maxSlotCount) || 0;
    const current = ((cards && cards.CFs) || []).filter(Boolean).map((c) => cleanCodename(c.Type));
    const locked = ((cards && cards.CFs) || []).filter((cf) => cf && cf.ca && cf.ca.locked).length;
    const available = seed && Array.isArray(seed.CFs)
      ? seed.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length
      : 0;
    const deckLocked = !conveyor && slots > 0 && current.length >= slots
      && (locked >= slots || (!!seed && available === 0));
    const gameStarted = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted);
    let canStart = false;
    if (conveyor) canStart = true;
    else if (preplant && !gameStarted) canStart = true;
    else {
      try { canStart = typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : current.length > 0; } catch { canStart = current.length > 0; }
    }
    let mode = 'normal';
    if (conveyor) mode = 'conveyor';
    else if (preplant) mode = 'preplant';
    else if (deckLocked) mode = 'forced_deck';
    return {
      mode,
      phase: preplant && !gameStarted ? 'preplant' : (gameStarted ? 'fighting' : 'preparing'),
      conveyor,
      preplant,
      deckLocked,
      gameStarted,
      canStart,
      slots,
      currentCount: current.length,
      lockedCount: locked,
      availableCount: available,
    };
  }

  function snapshot(opts) {
    const full = !!(opts && opts.full);
    // lean = 每回合都发的状态：cards 不带数值、levelScript 只留波数摘要。
    // full = pvz_briefing 用：要完整波次表。完整数值体积差 3-4 倍，直接决定模型延迟。
    const leanLevelScript = (ls) => (ls ? { waveCount: ls.waveCount, flagInterval: ls.flagInterval, isAtNight: !!(ls.lawn && ls.lawn.isAtNight) } : null);
    // 未来几波的预测：体积很小（3 波 × 类型），但能让模型提前布防；完整版在 pvz_briefing.forecast。
    const forecastPreview = (ls, waveNow) => {
      try {
        const fc = buildForecast(ls, stats);
        const next = fc ? nextWaves(fc, waveNow || 1, 3) : null;
        if (!next) return null;
        return {
          dynamic: { active: fc.dynamic.active, mode: fc.dynamic.mode, difficulty: fc.dynamic.difficulty },
          next,
        };
      } catch { return null; }
    };
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
          won: !!(lvl && lvl.gameWon),
          lost: !!(lvl && lvl.gameLost),
        },
        cards: cs.cards, deck: cs.deck, seedSelection: cs.seedSelection,
        prep: prepState(cards, lvl, phase),
        plants: [], zombies: [], lanes: [], board: [],
        terrain: null, blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [], mechanics: [],
        levelScript: ls, zombieStats: {},
        forecast: full ? null : forecastPreview(lsFull, lvl && Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0),
        limits: { plantLimit: limit, plantsPlanted: 0, plantsLeft: limit, slots: cs.seedSelection ? cs.seedSelection.slots : 0, plantLimitSource: limit == null ? null : (limitFromTask != null ? 'task' : 'objective') },
        plantLimit: limit,
        plantFoodUsable: 0,
        plantFoodUseful: 0,
        plantFoodMax: (() => { try { const c = map.PlantFoodCount && Number(map.PlantFoodCount.maxCount); return Number.isFinite(c) && c > 0 ? c : null; } catch { return null; } })(),
        plantFoodFull: false,
        plantFoodPlan: [],
        activatePlan: [],
        startingSun: phase === 'preparing' || phase === 'objective' ? sunNow : null,
        carts: [],
        collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
        world: level.world,
        protectCells: protectCells(),
        brief: null,
        instantAim: null,
        latency: latency ? latency.state() : null,
      };
    }
    const lanes = C.LaneCount || 5;
    const cols = C.ColumnCount || 9;

    const level = levelFacts(lvl, sceneName);
    const out = {
      ok: true, version, scene: sceneName,
      phase, paused: !!(ui && ui.paused),
      sun: null, plantFood: null,
      level: { ...level, wave: 0, waves: null, nextWaveIn: null, gameStarted: false, won: false, lost: false },
      cards: [], deck: [], plants: [], zombies: [], board: [], lanes: [],
      blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [],
      levelScript: null, seedSelection: null, zombieStats: {}, tasks, objective, missionHints,
      terrain: { lanes, columns: cols, map: [], legend: { L: 'land', W: 'water', P: 'plank', S: 'sky', R: 'rail', '?': 'unknown' } },
      limits: { plantLimit: null, plantsPlanted: 0, plantsLeft: null, slots: 0 },
      plantLimit: null, plantFoodUsable: 0, plantFoodUseful: 0, plantFoodMax: null, plantFoodFull: false,
      startingSun: null, carts: [], mechanics: [],
      plantFoodPlan: [], activatePlan: [],
      collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
      world: level.world,
    };
    try { out.sun = map.SunCount ? map.SunCount.CurrentValue : null; } catch { /* ignore */ }
    try { out.plantFood = map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null; } catch { /* ignore */ }
    // 豆上限（真机 PlantFoodCount.maxCount = 5）：满了以后再掉豆就是纯浪费。
    try {
      const cap = map.PlantFoodCount && Number(map.PlantFoodCount.maxCount);
      if (Number.isFinite(cap) && cap > 0) out.plantFoodMax = cap;
    } catch { /* ignore */ }
    out.plantFoodFull = out.plantFoodMax != null && out.plantFood != null
      ? out.plantFood >= out.plantFoodMax : false;

    let lsFull = null;
    if (lvl) {
      out.level.wave = Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0;
      out.level.waves = lvl.waveManagerProps ? lvl.waveManagerProps.WaveCount : null;
      out.level.nextWaveIn = Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null;
      out.level.gameStarted = !!lvl.gameStarted;
      out.level.won = !!lvl.gameWon;
      out.level.lost = !!lvl.gameLost;
      try { lsFull = stats.levelScriptOf(lvl); } catch { lsFull = null; }
      out.levelScript = full ? lsFull : leanLevelScript(lsFull);
      out.forecast = full ? null : forecastPreview(lsFull, out.level.wave);
      if (!out.level.waves && lsFull) out.level.waves = lsFull.waveCount || null;
    }
    if (phase === 'preparing' || phase === 'objective' || (lvl && lvl.lastStandPrepareStarted && !lvl.gameStarted)) out.startingSun = out.sun;

    // 卡片 / 选卡
    const cs = cardState(cards, out.sun);
    out.cards = cs.cards;
    out.deck = cs.deck;
    out.prep = prepState(cards, lvl, phase);
    // 只在选卡/任务阶段返回完整可选卡池；战斗中已经有卡组，避免每次状态都塞 30KB 的卡池。
    out.seedSelection = (phase === 'preparing' || phase === 'objective') ? cs.seedSelection : null;
    out.limits.slots = (cards && cards.maxSlotCount) || (out.seedSelection && out.seedSelection.slots) || (out.deck || []).length || 0;

    // 棋盘 / 植物 / 障碍
    const blocked = [];
    const obstacles = [];
    out.plants = [];
    out.board = [];
    out.terrain.map = [];
    const plantRefs = new Map();
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
            family: (pst && pst.family) || null,
            reach: pst ? pst.reach : null,
            armTimeSec: pst ? pst.armTimeSec : null,
            // 点击类植物：不知道 activation 的模型只会“种下去然后看着它不动”。
            activation: (pst && pst.usage && pst.usage.activation) || 'auto',
            aim: (pst && pst.usage && pst.usage.aim) || null,
            // 能量豆事实先放紧凑结构，targets 等僵尸读完后统一算（见下面 foodPlan）。
            food: (pst && pst.plantFood) ? {
              kind: pst.plantFood.kind,
              area: pst.plantFood.area,
              radius: pst.plantFood.radius,
              total: pst.plantFood.total,
              durationSec: pst.plantFood.durationSec,
            } : null,
            foodable: !!p.foodable && !p.fooding,
            protected: false,
          });
          plantRefs.set(`${r}:${c}`, p);
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
          let markedEndangered = false;
          try {
            markedEndangered = !!(cell.endangered || cell.protectPlant || cell.isEndangered || cell.haveEndangered);
          } catch { markedEndangered = false; }
          if (markedEndangered) obstacles.push({ lane: r, column: c, type: 'endangered', name: '濒危植物格', blocksPlanting: null, blocksStraightShot: null });
          for (const t of cell.tilesInSquare || []) {
            const cls = String((t && (t.__classname__ || (t.constructor && t.constructor.name))) || '');
            if (/goldTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'gold', name: '金瓷砖', ...OBSTACLE_FACTS.gold });
            else if (/sliderTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'slider', name: '滑轨格', ...OBSTACLE_FACTS.slider });
            else if (/endangered|protect_plant/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'endangered', name: '濒危植物格', blocksPlanting: null, blocksStraightShot: null });
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
        const speed = zst && zst.speed != null ? zst.speed : null;
        out.zombies.push({
          lane: r, column: Math.round(col * 10) / 10, type, name: (zst && zst.name) || type,
          hp, maxHp: Math.round((z.totalHealth ? z.totalHealth() : z.health) || 0),
          // 护甲：armorHp 读不到时为 null；ehp 是「本体 + 当前护甲」，读不到护甲时只给 ehpMax 上界
          armorHp: armorNow,
          armorMax: armorMax || null,
          newspaperHp: (zst && zst.newspaperHp) || null,
          ehp: armorNow != null ? hp + armorNow + ((zst && zst.newspaperHp) || 0) : null,
          ehpMax: hp + armorMax + ((zst && zst.newspaperHp) || 0),
          tags: (zst && zst.tags) || [],
          counters: ((zst && zst.tags) || []).map((tag) => TAG_COUNTERS[tag]).filter(Boolean).map((c) => c.text),
          // 飞行标签只说明“会飞”；荡索落地后会走到 c4 附近。用列位置给一个可操作的空中窗口。
          airborne: (() => {
            const tags = (zst && zst.tags) || [];
            if (!tags.includes('flying')) return false;
            if (/swashbuckler/i.test(String(type))) return col >= 4.5;
            return true;
          })(),
          speed,
          etaToHouse: speed > 0 ? Math.round((col / speed) * 10) / 10 : null,
        });
      }
    }
    out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);
    for (const row of out.board) row.zombies = out.zombies.filter((z) => z.lane === row.lane);

    // ── 能量豆 / 点击卡的“值不值”在本地算好 ──
    // 只给几何事实（范围内几只、本行最近僵尸在哪），不建议该不该给。
    const FOOD_NO_TARGET_OK = new Set(['self', 'aura', 'buff', 'heal', 'summon', 'sun_burst', 'self_armor', 'taunt']);
    const plantFoodPlan = [];
    const activatePlan = [];
    for (const p of out.plants) {
      if (p.food) {
        const t = plantFoodTargets(p.food, p, out.zombies);
        p.food.targets = t ? t.count : null;
        p.food.whiff = FOOD_NO_TARGET_OK.has(p.food.area) ? null : (t ? t.count === 0 : null);
        if (p.food.targets > 0) p.food.cells = t.cells.slice(0, 4);
        if (p.foodable) {
          plantFoodPlan.push({
            lane: p.lane, column: p.column, type: p.type, name: p.name,
            kind: p.food.kind, area: p.food.area, targets: p.food.targets,
            total: p.food.total, whiff: p.food.whiff,
          });
        }
      }
      if (p.activation !== 'auto') {
        const ahead = out.zombies.filter((z) => z.lane === p.lane && z.column >= p.column);
        const raw = plantRefs.get(`${p.lane}:${p.column}`) || null;
        const pst0 = (() => { try { return stats.plantStatsOf(p.type); } catch { return null; } })();
        activatePlan.push({
          lane: p.lane, column: p.column, type: p.type, name: p.name,
          activation: p.activation, aim: p.aim,
          frontZombie: ahead.length ? ahead[0].column : null,
          targets: ahead.length,
          shouldAct: !!(ahead.length && (p.aim === 'lane' || p.aim === 'self' || p.aim === 'free_cell')),
          // 这个版本里能调到的触发入口（null = 找不到，只能模拟点屏）
          api: (() => {
            try {
              if (raw && typeof raw.specialPlantOnMouseDown === 'function') {
                return typeof raw.trigger === 'function' ? 'specialPlantOnMouseDown+trigger' : 'specialPlantOnMouseDown';
              }
              const names = ['activate', 'fire', 'launch', 'useSkill', 'onTap', 'onClick', 'click', 'doClick', 'trigger', 'triggerSkill'];
              for (const n of names) if (raw && typeof raw[n] === 'function') return n;
            } catch { /* ignore */ }
            return null;
          })(),
          // 现场状态：为什么现在点不动（sleepCD / 正在射击 / 阳光不够 / 没长成）
          live: (() => {
            const s = {};
            try {
              for (const k of ['sleepCD', 'shooting', 'fooding', 'shootCD', 'growthStage', 'LeftPrj', 'charging']) {
                if (raw && raw[k] != null) s[k] = typeof raw[k] === 'boolean' ? raw[k] : Number(raw[k]);
              }
            } catch { /* ignore */ }
            return Object.keys(s).length ? s : null;
          })(),
          charges: (pst0 && pst0.usage && pst0.usage.charges) || null,
          restSec: (pst0 && pst0.usage && pst0.usage.restSec) || null,
        });
      }
    }
    plantFoodPlan.sort((a, b) => (b.targets || 0) - (a.targets || 0) || (b.total || 0) - (a.total || 0));
    out.plantFoodPlan = plantFoodPlan.slice(0, 6);
    out.activatePlan = activatePlan.slice(0, 8);
    // 现在给豆“真的有用”的株数（范围里有僵尸），和能吃豆的总数分开
    out.plantFoodUseful = out.plants.filter((p) => p.foodable && p.food && p.food.targets > 0).length;

    // 行信息（只给事实：数量、最近列、推车、射手/墙株数、dps 合计）
    const lead = latency ? latency.leadSec() : 6;
    out.lanes = [];
    for (let r = 0; r < lanes; r++) {
      const zs = out.zombies.filter((z) => z.lane === r);
      const ps = out.plants.filter((p) => p.lane === r);
      let mower = false;
      try {
        const lane = C.getLane && C.getLane(r);
        mower = !!(lane && lane.mower);
      } catch { mower = false; }
      const dps = Math.round(ps.reduce((s, p) => s + ((p.atk && p.atk.dps) || 0), 0) * 10) / 10;
      const dpsGroup = Math.round(ps.reduce((s, p) => {
        const atk = p.atk;
        if (!atk) return s;
        return s + (atk.targets > 1 ? (atk.multiDps || atk.dps || 0) : (atk.dps || 0));
      }, 0) * 10) / 10;
      // 威胁率：每秒会有多少 EHP 走到房子（ehp / 到房子的秒数），和本行 dps 直接同量纲
      const incoming = zs.reduce((s, z) => {
        const eta = z.etaToHouse;
        const e = z.ehp != null ? z.ehp : (z.ehpMax || 0);
        return s + (eta && eta > 0 ? e / eta : 0);
      }, 0);
      const lossIn = zs.length ? Math.min(...zs.map((z) => (z.etaToHouse == null ? Infinity : z.etaToHouse))) : null;
      const front = zs.length ? zs.reduce((a, b) => (b.column < a.column ? b : a)) : null;
      const tombColumns = obstacles
        .filter((o) => o && o.type === 'tomb' && o.lane === r)
        .map((o) => o.column)
        .sort((a, b) => a - b);
      out.lanes.push({
        lane: r, zombies: zs.length,
        nearestZombie: zs.length ? Math.min(...zs.map((z) => z.column)) : null,
        shooters: ps.filter((p) => p.atk && p.atk.dps).length,
        walls: ps.filter((p) => /peanut|tallnut|wallnut|holonut|endurian/i.test(p.type)).length,
        wallCells: ps.filter((p) => /peanut|tallnut|wallnut|holonut|endurian/i.test(p.type))
          .map((p) => ({ column: p.column, type: p.type, hp: p.hp, maxHp: p.maxHp })),
        shooterCells: ps.filter((p) => p.atk && p.atk.dps).map((p) => ({ column: p.column, type: p.type, dps: p.atk.dps })),
        sunProducers: ps.filter((p) => /^Sun$/i.test(String(p.family || ''))).length,
        plants: ps.length,
        dps,
        dpsGroup,
        wallHp: ps.reduce((s, p) => s + (/peanut|tallnut|wallnut|holonut|endurian/i.test(p.type) ? (p.hp || 0) : 0), 0),
        tombColumns,
        straightBlocked: tombColumns.length > 0,
        // 本行在场上僵尸的剩余 EHP 合计（读不到护甲时用 ehpMax 上界），以及是否全是精确值
        ehp: Math.round(zs.reduce((s, z) => s + (z.ehp != null ? z.ehp : z.ehpMax || 0), 0)),
        ehpExact: zs.every((z) => z.ehp != null),
        // 防御缺口：incomingPerSec > dps 就说明这行会被压穿；gap 是每秒净增的威胁
        incomingPerSec: Math.round(incoming * 10) / 10,
        gap: Math.round((incoming - dps) * 10) / 10,
        lossIn: lossIn == null || !Number.isFinite(lossIn) ? null : Math.round(lossIn * 10) / 10,
        // 把 AI 延迟算进去后，最晚什么时候必须动手；<0 就是已经来不及
        actBy: lossIn == null || !Number.isFinite(lossIn) ? null : Math.round((lossIn - lead) * 10) / 10,
        front: front ? { column: front.column, type: front.type, ehp: front.ehp != null ? front.ehp : front.ehpMax } : null,
        mower,
      });
    }

    // ── 提前量：波次 ETA / 卡牌可用时间 / 一次性卡落点窗口 / 每回合摘要 ──
    let fc = null;
    try { fc = lsFull ? buildForecast(lsFull, stats) : null; } catch { fc = null; }
    const totalDps = Math.round((out.lanes || []).reduce((s, l) => s + (l.dps || 0), 0) * 10) / 10;
    const waveNow = out.level.wave || 0;
    const waveFc = fc && waveNow ? (fc.waves || []).find((w) => w.wave === waveNow) : null;
    const threshold = (lsFull && lsFull.manager && lsFull.manager.minNextHealth != null) ? lsFull.manager.minNextHealth : 0.5;
    const onLawnEhp = (out.zombies || []).reduce((s, z) => s + (z.ehp != null ? z.ehp : (z.ehpMax || 0)), 0);
    let healthEta = null;
    if (waveFc && totalDps > 0) healthEta = Math.max(0, (onLawnEhp - (waveFc.ehp || 0) * threshold) / totalDps);
    const timerEta = out.level.nextWaveIn != null ? out.level.nextWaveIn : null;
    let waveEta = null;
    let waveBasis = null;
    if (healthEta != null && timerEta != null) {
      if (healthEta <= timerEta) { waveEta = healthEta; waveBasis = 'health'; } else { waveEta = timerEta; waveBasis = 'timer'; }
    } else if (timerEta != null) { waveEta = timerEta; waveBasis = 'timer'; }
    else if (healthEta != null) { waveEta = healthEta; waveBasis = 'health'; }

    // 卡牌可用时间：阳光够不够（按当前产阳光速度）+ 冷却还剩多少
    const isNightLane = !!(lsFull && lsFull.lawn && lsFull.lawn.isAtNight);
    let sunRate = 0;
    for (const p of out.plants) {
      const st = stats.plantStatsOf(p.type);
      const arr = st && st.sun ? (isNightLane ? (st.sun.perSecNight || st.sun.perSecDay) : st.sun.perSecDay) : null;
      if (arr && arr.length) sunRate += arr[arr.length - 1];
    }
    sunRate = Math.round(sunRate * 100) / 100;
    for (const c of out.cards) {
      const need = Math.max(0, (c.cost || 0) - (out.sun || 0));
      const etaSun = sunRate > 0 ? need / sunRate : (need > 0 ? null : 0);
      c.etaSun = etaSun == null ? null : Math.round(etaSun * 10) / 10;
      c.etaReady = Math.round(Math.max(etaSun || 0, c.cd || 0) * 10) / 10;
    }

    // 一次性卡的落点窗口：按 AI 延迟 + 引信时间反推该投哪几列
    const instantCards = (out.cards || [])
      .map((c) => c.type)
      .filter((t) => {
        const st = stats.plantStatsOf(t);
        return st && ((st.shot && st.shot.kind === 'instant') || st.family === 'Explosive');
      });
    const aims = [];
    for (const t of instantCards) {
      for (const l of out.lanes) {
        if (!l.zombies || !l.front) continue;
        const z = out.zombies.find((zz) => zz.lane === l.lane && zz.column === l.front.column);
        const v = z && z.speed > 0 ? z.speed : 0.18;
        const to = Math.floor(l.front.column - v * (lead + 0.6));
        const from = Math.ceil(l.front.column - v * (lead + 3.2));
        if (to < 0) continue;
        aims.push({
          card: t, lane: l.lane, frontColumn: l.front.column,
          from: Math.max(0, Math.min(cols - 1, from)),
          to: Math.max(0, Math.min(cols - 1, to)),
          late: to < 0,
        });
      }
    }
    out.instantAim = aims.length ? aims.sort((a, b) => a.lane - b.lane).slice(0, 8) : null;

    const pressure = out.lanes
      .filter((l) => l.gap > 0)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 3)
      .map((l) => ({ lane: l.lane, gap: l.gap, lossIn: l.lossIn, actBy: l.actBy, front: l.front }));
    // 接下来两波会出现什么：让模型在僵尸出场前就能布防（摆荡/小鬼炮/铁桶都是提前几步就知道的）
    const incoming = fc && waveNow
      ? (fc.waves || []).filter((w) => w.wave > waveNow && w.wave <= waveNow + 2).map((w) => ({
        wave: w.wave,
        flag: !!w.flag,
        total: w.total,
        ehp: Math.round(w.ehp || 0),
        types: Object.keys(w.zombies || {}),
        newTypes: w.firstWaveTypes || [],
        flying: Object.keys(w.zombies || {}).filter((t) => {
          const zs = stats.zombieStatsOf(t);
          return !!(zs && Array.isArray(zs.tags) && zs.tags.includes('flying'));
        }),
        counters: [...new Set(Object.keys(w.zombies || {}).flatMap((t) => {
          const zs = stats.zombieStatsOf(t);
          return ((zs && zs.tags) || []).map((tag) => TAG_COUNTERS[tag] && TAG_COUNTERS[tag].text).filter(Boolean);
        }))],
      }))
      : null;
    // 保护任务的可操作几何：模型不用自己算「差几格才算护得住」。
    // 短手植物（接触/接近/前后/3x3/N 格）只有在与保护格同行的列差 <= reach 时才可能碰到啃花的僵尸；
    // 远程/整行/抛物只要在保护格左侧同一行就能覆盖。
    const protectCellsNow = protectCells();
    // 有些关（花园无尽的“保护濒危植物”）不在 flowerLine 上，而是 endangered/protect_plant 地块。
    // 地块本身就是要守的位置：合并进来，后面 prompt / 种植校验 / 复盘才能用同一份坐标。
    try {
      for (const o of obstacles) {
        if (!o || o.type !== 'endangered') continue;
        if (protectCellsNow.some((c) => c.lane === o.lane && c.column === o.column)) continue;
        protectCellsNow.push({
          lane: o.lane, column: o.column, dead: false, tip: '濒危植物格', source: 'tile',
          frontColumn: Math.min(cols - 1, o.column + 1),
        });
      }
    } catch { /* ignore */ }
    const protectInfo = protectCellsNow.length ? (() => {
      const plantAt = (lane, col) => (out.plants || []).find((p) => p.lane === lane && p.column === col) || null;
      const statsOf = (p) => {
        if (!p) return null;
        try { return stats.plantStatsOf(p.type); } catch { return null; }
      };
      const isWall = (p) => {
        const st = statsOf(p);
        return !!(st && (st.family === 'Defence' || (st.hp || 0) >= 1000));
      };
      const isMelee = (p) => {
        const st = statsOf(p);
        return !!(st && (st.family === 'Melee' || /接触|接近|前后|3x3/.test(String(st.range || ''))));
      };
      const cells = protectCellsNow.map((c) => {
        const guards = [];
        for (const d of [1, -1]) {
          const cc = c.column + d;
          if (cc >= 0 && cc < cols) guards.push({ lane: c.lane, column: cc });
        }
        const front = plantAt(c.lane, c.column + 1);
        const back = plantAt(c.lane, c.column - 1);
        const meleeGuard = [front, back].find((p) => p && isMelee(p)) || null;
        const wallGuard = front && isWall(front) ? front : null;
        return {
          lane: c.lane, column: c.column, dead: c.dead,
          frontColumn: Math.min(cols - 1, c.column + 1),
          guardColumns: guards,
          wall: wallGuard ? wallGuard.type : null,
          melee: meleeGuard ? meleeGuard.type : null,
          // 地面防线是否已有墙/近战；false 表示这一行还没布防，优先补。
          groundGuarded: !!(wallGuard || meleeGuard),
        };
      });
      const airCards = (out.deck || []).filter((t) => t === 'blover' || t === 'lightningreed');
      return {
        count: cells.length,
        dead: cells.filter((c) => c.dead).length,
        cells,
        unguardedLanes: cells.filter((c) => !c.dead && !c.groundGuarded).map((c) => c.lane),
        airCards,
      };
    })() : null;
    const airRaid = out.zombies.filter((z) => z.airborne).map((z) => ({
      type: z.type, name: z.name, lane: z.lane, column: z.column, tags: z.tags,
    }));
    // 地雷类卡的“能不能在僵尸到之前出土”本地算好：省掉模型心算速度和倒计时。
    const minePlan = [];
    for (const type of out.deck || []) {
      let st = null;
      try { st = stats.plantStatsOf(type); } catch { st = null; }
      const arm = st && Number(st.armTimeSec);
      if (!arm || arm <= 0) continue;
      for (let lane = 0; lane < lanes; lane++) {
        const zs = out.zombies.filter((z) => z.lane === lane);
        if (!zs.length) continue;
        const front = zs.reduce((a, b) => (b.column < a.column ? b : a));
        const speed = Number(front.speed) > 0 ? Number(front.speed) : 0.18;
        const row = out.board[lane];
        const safe = [];
        for (let c = 0; c < cols; c++) {
          const occupied = row && row.cells && row.cells[c];
          const terr = row && row.terrain && row.terrain[c];
          if (occupied || terr === 'W' || terr === 'S') continue;
          const eta = (front.column - c) / speed;
          if (eta >= arm + lead + 1) safe.push(c);
        }
        const latest = safe.length ? Math.max(...safe) : null;
        minePlan.push({
          card: type,
          lane,
          armTimeSec: arm,
          front: { type: front.type, name: front.name, column: front.column, speed },
          latestSafeColumn: latest,
          safeColumns: safe.slice(-5),
          etaAtLatest: latest == null ? null : Math.round(((front.column - latest) / speed) * 10) / 10,
          tooLate: latest == null,
        });
      }
    }
    const laneCalculations = laneMath({ lanes: out.lanes, zombies: out.zombies });
    // 整关威胁类型：不只是场上和接下来两波，而是 levelScript 里所有波次出现过的僵尸。
    // 这样 coverageGaps 才能覆盖整关（例如第 12 波才出现的滚桶/骆驼牌）。
    const levelWaveTypes = [];
    try {
      for (const w of (lsFull && lsFull.waves) || []) {
        for (const t of Object.keys(w.zombies || {})) levelWaveTypes.push(t);
      }
    } catch { /* ignore */ }
    const threatTypes = [...new Set([
      ...out.zombies.map((z) => z.type),
      ...levelWaveTypes,
      ...((incoming || []).flatMap((w) => w.types || [])),
    ])];
    const counterCalculations = counterMatrix({
      types: threatTypes,
      deck: out.deck || [],
      zombieStatsOf: (t) => stats.zombieStatsOf(t),
    });
    // 整关 tag 集合 → 能力审计（group→multi_target、rolling→anti_rolling…）。
    // 新增僵尸只加 tag 规则，不改这里。
    const levelTags = new Set();
    for (const t of threatTypes) {
      let zs = null;
      try { zs = stats.zombieStatsOf(t); } catch { zs = null; }
      for (const tag of (zs && zs.tags) || []) levelTags.add(tag);
    }
    const plantStats = (t) => {
      try { return stats.plantStatsOf(t); } catch { return null; }
    };
    const deckCaps = deckCapabilities({ deck: out.deck || [], plantStatsOf: plantStats });
    const capabilityGaps = coverageAudit({
      tags: [...levelTags],
      deck: out.deck || [],
      plantStatsOf: plantStats,
      // 战斗中没有完整卡池；选卡阶段由 briefing 补 candidates。
      pool: out.deck || [],
    });
    const coverageGaps = {
      tags: capabilityGaps.tags,
      required: capabilityGaps.required,
      present: capabilityGaps.present,
      missing: capabilityGaps.missing,
      // 兼容旧读法：逐僵尸的 missingTags（现在统一从能力缺口推导）
      byType: counterCalculations
        .filter((c) => c.missingTags && c.missingTags.length)
        .map((c) => ({ type: c.type, name: c.name, tags: c.tags, missingTags: c.missingTags })),
    };
    const tomb = {
      lanes: out.lanes.filter((l) => l.tombColumns && l.tombColumns.length).map((l) => ({ lane: l.lane, columns: l.tombColumns })),
      unblockedLanes: out.lanes.filter((l) => !(l.tombColumns && l.tombColumns.length)).map((l) => l.lane),
    };
    // 墙的“还能撑多久 / 下一张墙什么时候好”，本地算好，避免一口气连发多张 20s 冷却的墙。
    // 支撑时间按该行所有僵尸的总啃食 DPS 算（多只叠在一起时不是只看最前一只）。
    const wallCardOf = (out.deck || []).find((t) => /wallnut|tallnut|peanut|endurian|holonut/i.test(t)) || null;
    const wallCardState = wallCardOf ? (out.cards || []).find((c) => c.type === wallCardOf) : null;
    const wallCardStats = wallCardOf ? plantStats(wallCardOf) : null;
    const wallBaseCd = (wallCardStats && Number(wallCardStats.cd)) || null;
    const wallPlan = out.lanes.map((l) => {
      const zs = out.zombies.filter((z) => z.lane === l.lane).sort((a, b) => a.column - b.column);
      const front = zs[0] || null;
      const eaters = [];
      for (const z of zs) {
        let dps = null;
        try {
          const zst = stats.zombieStatsOf(z.type);
          if (zst && Number(zst.eatDps) > 0) dps = Number(zst.eatDps);
        } catch { /* ignore */ }
        if (dps != null) eaters.push({ type: z.type, column: z.column, eatDps: dps });
      }
      const survival = wallSurvive({ wallHp: l.wallHp, eatDps: eaters.map((e) => e.eatDps) });
      const frontEta = front ? Math.round((front.column / (front.speed > 0 ? front.speed : 0.18)) * 10) / 10 : null;
      return {
        lane: l.lane,
        wallHp: l.wallHp,
        wallType: (l.wallCells && l.wallCells[0] && l.wallCells[0].type) || null,
        frontType: front ? front.type : null,
        frontColumn: front ? front.column : null,
        frontEta,
        eatDps: survival.totalEatDps,
        eaters: eaters.length,
        wallSurviveSec: survival.surviveSec,
        wallCard: wallCardOf,
        wallCd: wallCardState ? wallCardState.cd : null,
        wallBaseCd,
        risk: !l.wallHp && front ? 'no_wall' : (survival.surviveSec != null && frontEta != null && survival.surviveSec < frontEta ? 'wall_too_thin' : 'ok'),
      };
    });
    const wallRebuild = wallRebuildPlan({ wallPlan, leadSec: lead });
    out.brief = {
      leadSec: lead,
      totalDps,
      sunRate,
      wave: {
        now: waveNow, total: out.level.waves,
        etaSec: waveEta == null ? null : Math.round(waveEta * 10) / 10,
        basis: waveBasis,
        flag: !!(waveFc && waveFc.flag),
      },
      incoming,
      pressure,
      safeLanes: out.lanes.filter((l) => !(l.gap > 0)).map((l) => l.lane),
      airRaid: airRaid.length ? { count: airRaid.length, cells: airRaid } : null,
      minePlan,
      laneMath: laneCalculations,
      counterMatrix: counterCalculations,
      deckCapabilities: deckCaps.byCapability,
      coverageGaps,
      tomb,
      wallPlan,
      wallRebuildPlan: wallRebuild,
      protect: protectInfo,
      // 本地算好的两个“值不值”：模型不用自己数格子/比列号
      plantFoodPlan: out.plantFoodPlan,
      activatePlan: out.activatePlan,
    };

    out.latency = latency ? latency.state() : null;
    out.protectCells = protectCellsNow;

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

    // 本关机制事实：文案来自 knowledge/worlds.js 的 TAG_COUNTERS（唯一规则表），
    // 新增僵尸/机制只加 tag 规则，不改这里。
    try {
      const tagSet = new Set();
      for (const t of Object.keys(out.zombieStats || {})) for (const g of ((out.zombieStats[t] || {}).tags || [])) tagSet.add(g);
      for (const g of tagSet) {
        const rule = TAG_COUNTERS[g];
        if (rule && rule.text) out.mechanicFacts.push({ id: g, text: rule.text, source: 'zombie-tags' });
      }
    } catch { /* ignore */ }

    const ls = lsFull;
    if (out.terrain.map.some((row) => /[WS]/.test(row))) out.mechanicFacts.push({ id: 'water', text: '存在水面/天空格：普通植物不能直接种在这些格子上', source: 'terrain' });
    if (out.terrain.map.some((row) => /R/.test(row))) out.mechanicFacts.push({ id: 'rail', text: '存在矿车轨道：矿车可载植物上下移动', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'tomb')) out.mechanicFacts.push({ id: 'tomb', text: '墓碑占格并只阻挡所在行的直线弹道；其他行不受影响', source: 'terrain' });
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
    out.plantFoodUsable = out.plants.filter((p) => p.foodable).length;

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
    findComps, snapshot, readObjective, readTasks, cellPlants, protectCells,
    collectPickups, setAutoCollect, collectStats,
    learnCell, learnedCells, readCarts, cartRefs: collectCartRefs,
  };
}
