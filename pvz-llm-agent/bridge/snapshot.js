/**
 * snapshot：把游戏对象树读成结构化状态。
 *
 * 只读；不判断、不建议、不改游戏。所有派生量都写明算法（ehp、dps、格数）。
 */
import { OBSTACLE_FACTS } from './stats.js';
import { buildForecast, nextWaves } from './forecast.js';
import { laneMath, counterMatrix, deckCapabilities, coverageAudit, wallSurvive, wallRebuildPlan, isWallCard } from './mechanics.js';
import { buildMatchups } from './crosscheck.js';
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

// 产阳光的判定不写死 family：不同世界有 Sun/SunShroom 等，
// 统一看 stats.sun 或 Sun 家族，换关后仍然成立。
const isSunPlant = (p) => !!(p && (p.sun != null || /^Sun$/i.test(String(p.family || ''))));

// PlantFeatures.TAGS 里只影响“能不能种/种哪层”的标签；角色标签（sunProducer/mint…）不进 state。
const PLACEMENT_TAGS = new Set([
  'amphibious', 'aquatic', 'deepAquatic', 'fly', 'vine',
  'tile', 'powertile', 'lilypad', 'floawerPot', 'any', 'allowOverlap',
]);

// 粗粒度局面版本：关卡/阶段/波次变化才变，不因阳光或僵尸走格而抖动。
function versionHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

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
  // 保护格上原本有没有植物：只有“见过有、现在没了”才判定死亡，
  // 避免开局加载那几帧把保护植物误报成 dead。
  const protectSeen = new Set();
  let protectSeenScope = null;
  const protectTypeMemo = new Map();
  // 保护格本身会随保护植物死亡一起从场景里消失：只按“当前格子”统计，
  // 复盘会变成“没有保护植物死亡”。这里按本局记住所有见过的保护格。
  const protectKnown = new Map();
  let protectKnownScope = null;
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

  // 同一格可能叠多株：主植物 + 藤蔓 + 地块植物 + 模仿者 + 花盆/睡莲。
  // 旧实现只把 list[0] 给模型，南瓜套/藤蔓/睡莲层会直接消失。
  function cellPlantLayers(cell) {
    if (!cell) return [];
    const out = [];
    const groups = [
      [cell.plantInSquare, 'main'],
      [cell.vineInSquare, 'vine'],
      [cell.tilePlantInSquare, 'tile'],
      [cell.iminaterInSquare, 'imitater'],
      [cell.floawerpot ? [cell.floawerpot] : null, 'pot'],
      [cell.lilypad ? [cell.lilypad] : null, 'lilypad'],
    ];
    for (const [g, role] of groups) {
      if (!Array.isArray(g)) continue;
      for (const p of g) {
        if (!p || out.some((x) => x.p === p)) continue;
        let alive = true;
        try { alive = p.isAlive ? p.isAlive() : true; } catch { alive = true; }
        if (alive) out.push({ p, role });
      }
    }
    return out;
  }

  function cellPlants(cell) {
    return cellPlantLayers(cell).map((x) => x.p);
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
    // 关卡资源名（egypt1 这种）只是模板/文件名，不等于世界：
    // 自定义包经常复用模板资源名（海盗港湾第 16 天的 Level 就叫 egypt1）。
    // 游戏在 levelController 上直接给了世界名和“世界 - 第 N 天”的显示名，优先用它们。
    const worldName = (lvl && (lvl._levelWorldName || lvl.levelWorldName || lvl.worldName)) || '';
    const rawDisplay = (lvl && (lvl.levelNameString || lvl.levelName)) || '';
    const displayName = rawDisplay && !/^[<【]|template/i.test(rawDisplay) ? rawDisplay : '';
    const source = {
      world: worldName || (lvl && (lvl.worldName || lvl.worldKey || lvl.world || lvl.stageName)) || null,
      worldName: worldName || null,
      levelId: (lvl && (lvl.levelId || lvl.levelID)) || null,
      custom: !!(lvl && (lvl.isCustomLevel || lvl.customLevel)),
      description: (lvl && (lvl.levelDescriptionString || lvl.levelDescription || lvl.description)) || null,
      // 资源名（cowboy13 这种）是这一关最稳定的 id：关卡总结按它归档
      asset: (lvl && lvl.Level && (lvl.Level.name || lvl.Level._name)) || (lvl && lvl.levelKey) || null,
      number: (lvl && lvl.levelDefinition && Number.isFinite(Number(lvl.levelDefinition.LevelNumber)))
        ? Number(lvl.levelDefinition.LevelNumber) : null,
      // 传送带关只看关卡模块字段，不看“当前卡槽空不空”：
      // 选卡过渡帧卡槽本来就是空的，靠卡槽判断会把普通关误判成传送带。
      conveyor: !!(() => {
        try {
          const def = lvl && lvl.levelDefinition;
          const mods = (def && Array.isArray(def.Modules)) ? def.Modules : [];
          const text = mods.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
            + ' ' + String((def && def.StageModule) || '');
          return /conveyor/i.test(text);
        } catch { return false; }
      })(),
      scene: sceneName || null,
    };
    // 有世界名/显示名时不再把资源名拼进去：否则 "海盗港湾 … egypt1" 会被 /egypt/ 抢先匹配成埃及。
    const worldText = [displayName, worldName, source.world].filter(Boolean).join(' ');
    const fact = worldFactOf(worldText) || worldFactOf(source.asset) || worldFactOf(sceneName);
    return {
      name: displayName || name,
      source,
      world: fact ? { key: fact.key, name: fact.name, mechanics: fact.mechanics.slice(), zombies: fact.zombies.slice() } : null,
    };
  }

  // 传送带的真实入口是场景里的 Conveyor 组件：卡不在 Cards.CFs 里，
  // 当前带上的卡由 getCards() 给，种植走 chooseCard(cf, slot) + PlaceUIPlant()。
  // 关卡 JSON 里有 Conveyor 模块时，即使组件还没初始化也先把模式标出来。
  function readConveyor(map, cards, ls) {
    const cv = map && (map.Conveyor || map.ConveyorBelt || null);
    const fromLevel = !!(ls && ls.seedBank && ls.seedBank.conveyor);
    if (!cv && !fromLevel) return null;
    let list = [];
    let slots = [];
    let plantList = [];
    try {
      if (cv) {
        list = (typeof cv.getCards === 'function' ? cv.getCards() : []) || [];
        slots = [].concat(cv.lane1slots || [], cv.lane2slots || [], cv.laneVertslots || [])
          .filter(Boolean)
          .map((s) => cleanCodename(s.card && s.card.Type));
        plantList = (Array.isArray(cv.plantList) ? cv.plantList : [])
          .map((p) => cleanCodename(p && (p.PlantType || p.Type) || p))
          .filter(Boolean);
      }
    } catch { /* ignore */ }
    const cardCount = cards && Array.isArray(cards.CFs) ? cards.CFs.length : 0;
    // 选卡界面已经就绪（有可选卡）时，绝不能因为“卡组还是空的 + 场景里有 Conveyor 组件”
    // 就把普通关误判成传送带；否则模型会跳过选卡，开局失败后一直用预填卡组。
    const chooserReady = !!(cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)
      && cards.seedChooser.CFs.length > 0);
    const realConveyor = list.length > 0 || plantList.length > 0;
    const enabled = realConveyor || (fromLevel && !chooserReady && cardCount === 0);
    if (!enabled) return null;
    return {
      enabled: true,
      vertical: !!(cv && cv.isVertical),
      source: fromLevel ? 'level' : 'component',
      cards: list.map((cf, i) => {
        const type = cleanCodename(cf && cf.Type);
        const st = stats.plantStatsOf(type);
        return {
          index: i,
          type,
          name: (st && st.name) || type,
          // 传送带不扣阳光、不吃种子冷却；保留 ready 兼容旧读法。
          cost: 0,
          cd: 0,
          cdReady: true,
          affordable: true,
          sunShort: 0,
          ready: true,
          cooling: false,
          family: (st && st.family) || null,
          dps: (st && st.attack && st.attack.dps) || null,
          effectiveDps: (st && st.effectiveDps) || null,
          reach: st ? st.reach : null,
          stepDamage: !!(st && st.stepDamage),
          ignoresArmor: !!(st && st.ignoresArmor),
          targets: (st && st.attack && st.attack.targets) || 1,
          multiDps: (st && st.attack && st.attack.multiDps) || null,
          activation: st && st.usage && st.usage.manual ? st.usage.activation : undefined,
          burstDmg: (st && st.burst && st.burst.dmg) || undefined,
          damageType: (st && st.damageType && st.damageType !== 'normal') ? st.damageType : undefined,
          armorState: (st && st.armorState && st.armorState !== 'no') ? st.armorState : undefined,
          foodKind: (st && st.plantFood && st.plantFood.kind) || undefined,
        };
      }),
      plantList,
      slots,
    };
  }

  function cardState(cards, sunNow, conveyor) {
    const out = { cards: [], deck: [], seedSelection: null, conveyor: conveyor || null };
    // 传送带：state.cards 就是当前带上的卡，index 每轮都可能变；没有阳光/冷却。
    if (conveyor && conveyor.enabled) {
      out.cards = (conveyor.cards || []).map((c) => ({ ...c, conveyor: true }));
      out.deck = out.cards.map((c) => c.type);
      return out;
    }
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
            // 放置类别（amphibious/fly/vine/lilypad…）；普通卡为空，不占 token。
            placementTags: (st && st.placement && st.placement.tags || [])
              .filter((t) => PLACEMENT_TAGS.has(t)),
            plantPlace: (st && st.placement && st.placement.plantPlace) || undefined,
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
                placementTags: (st && st.placement && st.placement.tags || [])
                  .filter((t) => PLACEMENT_TAGS.has(t)),
                plantPlace: (st && st.placement && st.placement.plantPlace) || undefined,
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

  // 提前布阵：不同版本字段名不一样（lastStandPrepareStarted / preset.active / prepareStarted）。
  // 只认明确的“布阵已开始但波次未开始”标志，不靠“阳光多”这类现象猜。
  function preplantNow(lvl, gameStarted) {
    if (!lvl || gameStarted) return false;
    const preset = lvl.preset;
    return !!(
      lvl.lastStandPrepareStarted
      || lvl.prepareStarted
      || lvl.plantingPhase
      || lvl.lastStandMode
      || (preset && (preset.active === true || preset.prepare === true || preset.started === true))
    );
  }

  // 关卡准备模式：普通选卡 / 提前布阵 / 传送带 / 给定锁定卡组。
  // 这几种关卡的“开局前该做什么”不一样，必须当成结构化事实给模型，不能靠它从 phase 猜。
  function prepState(cards, lvl, phase, conveyor, ls, hintText) {
    if (phase === 'menu' || phase === 'worldmap' || phase === 'other') return null;
    const conveyorOn = !!(conveyor && conveyor.enabled)
      // 兜底：关卡模块字段明确写了 Conveyor 才算传送带；选卡界面有可选卡时以选卡为准。
      || !!(() => {
        try {
          const def = lvl && lvl.levelDefinition;
          const text = ((def && def.Modules) || []).map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join(' ')
            + ' ' + String((def && def.StageModule) || '');
          const chooserReady = !!(cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)
            && cards.seedChooser.CFs.length > 0);
          return !chooserReady && /conveyor/i.test(text);
        } catch { return false; }
      })();
    const gameStarted = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted);
    const seed = cards && cards.seedChooser;
    const slots = Number(cards && cards.maxSlotCount) || 0;
    const current = ((cards && cards.CFs) || []).filter(Boolean).map((c) => cleanCodename(c.Type));
    const locked = ((cards && cards.CFs) || []).filter((cf) => cf && cf.ca && cf.ca.locked).length;
    const available = seed && Array.isArray(seed.CFs)
      ? seed.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length
      : 0;
    const text = String(hintText || '');
    // 关卡标题/任务原文兜底：只在“已经进入布阵期（phase=running）”或“没有选卡页”时才算，
    // 不能在选卡前的 preparing 阶段就把普通选卡关误判成提前布阵。
    const textPreplant = !gameStarted && /提前布阵|先布阵|pre-?plant/i.test(text)
      && (phase === 'running' || !seed);
    // 给定卡组同理：有可选卡池时先按正常选卡；无选卡页/可选为 0 才用文本兜底。
    const textForced = !seed || available === 0
      ? /使用给定|给定植物|固定卡组|锁定卡组|given plants?|fixed deck|preset deck|locked deck/i.test(text)
      : false;
    const preplant = preplantNow(lvl, gameStarted) || textPreplant;
    // 没有选卡页（没有 seedChooser）但已经拿到卡组，就是“使用给定植物通关”；
    // 卡槽全锁/可选为 0/关卡配置明说不是 chooser 也算。不能因为 availableCount=0 就退回 normal。
    const noChooser = !seed;
    const forcedFlag = !!(cards && (cards.forcedDeck || cards.deckLocked || cards.presetDeck))
      || !!(lvl && (lvl.forcedDeck || lvl.deckLocked || lvl.presetDeck || lvl.givenDeck));
    const selection = ls && ls.seedBank ? ls.seedBank.selectionMethod : null;
    const presetSelection = !!(selection && !/chooser/i.test(String(selection)));
    const deckLocked = !conveyorOn && (forcedFlag || textForced || (current.length > 0
      && (noChooser || presetSelection
        || (slots > 0 && current.length >= slots && (locked >= slots || available === 0)))));
    let canStart = false;
    if (conveyorOn) canStart = true;
    else if (preplant && !gameStarted) canStart = true;
    else {
      try { canStart = typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : current.length > 0; } catch { canStart = current.length > 0; }
    }
    let mode = 'normal';
    if (conveyorOn) mode = 'conveyor';
    else if (preplant) mode = 'preplant';
    else if (deckLocked) mode = 'forced_deck';
    // 给定卡组没有选卡页：只要卡组已经下发，就可以先想对策再开局。
    if (mode === 'forced_deck' && current.length > 0) canStart = true;
    return {
      mode,
      phase: preplant && !gameStarted ? 'preplant' : (gameStarted ? 'fighting' : 'preparing'),
      // 卡槽/卡池还没初始化时（objective 刚结束、页面过渡）不要据此判断传送带。
      ready: conveyorOn || !!seed && (slots > 0 || gameStarted) && (available > 0 || current.length > 0) || gameStarted,
      modePending: !gameStarted && !conveyorOn && !preplant && !deckLocked && !seed && current.length === 0,
      conveyor: conveyorOn,
      preplant,
      deckLocked,
      gameStarted,
      canStart,
      // 这几种关必须先想清楚再开局；router/actions 会用这个字段拦“直接点开始”。
      mustPlanBeforeStart: !gameStarted && (mode === 'forced_deck' || mode === 'preplant'),
      hasSeedChooser: !!seed,
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
      const presetNow = preplantNow(lvl, !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted));
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
      let lsFull = null;
      try { lsFull = lvl ? stats.levelScriptOf(lvl) : null; } catch { lsFull = null; }
      const conveyor = readConveyor(map, cards, lsFull);
      const cs = cardState(cards, sunNow, conveyor);
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
        conveyor: cs.conveyor,
        prep: prepState(cards, lvl, phase, conveyor, lsFull, [level.name, ...missionHints].filter(Boolean).join(' ')),
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
    const isWall = (type) => {
      try { return isWallCard(type, stats.plantStatsOf(type)); } catch { return isWallCard(type, null); }
    };

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
    const conveyorNow = readConveyor(map, cards, lsFull);
    if (phase === 'preparing' || phase === 'objective' || preplantNow(lvl, !!(lvl && lvl.gameStarted))) out.startingSun = out.sun;

    // 卡片 / 选卡
    const cs = cardState(cards, out.sun, conveyorNow);
    out.cards = cs.cards;
    out.deck = cs.deck;
    out.conveyor = cs.conveyor;
    out.prep = prepState(cards, lvl, phase, conveyorNow, lsFull, [out.level.name, ...missionHints].filter(Boolean).join(' '));
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
        const entries = cellPlantLayers(cell);
        if (entries.length) {
          const p = entries[0].p;
          const type = cleanCodename(p.Plant_Type);
          const pst = stats.plantStatsOf(type);
          cells[c] = type;
          const layers = entries.map((e) => {
            const t = cleanCodename(e.p.Plant_Type);
            const st = stats.plantStatsOf(t);
            return {
              role: e.role, type: t, name: (st && st.name) || t,
              hp: Math.round(e.p.health || 0), maxHp: Math.round(e.p.toughness || 0),
            };
          });
          out.plants.push({
            lane: r, column: c, type, name: (pst && pst.name) || type,
            hp: Math.round(p.health || 0), maxHp: Math.round(p.toughness || 0),
            // 同一格的总血量：只有多层时才给，单层用 hp 即可。
            cellHp: layers.length > 1 ? layers.reduce((s, x) => s + (x.hp || 0), 0) : undefined,
            layers: layers.length > 1 ? layers : undefined,
            atk: pst ? pst.attack : null,
            effectiveDps: pst ? pst.effectiveDps : null,
            stepDamage: !!(pst && pst.stepDamage),
            shot: pst ? pst.shot : null,
            family: (pst && pst.family) || null,
            sun: pst && pst.sun ? {
              perSecDay: pst.sun.perSecDay,
              paybackSec: pst.sun.paybackSec,
            } : undefined,
            reach: pst ? pst.reach : null,
            armTimeSec: pst ? pst.armTimeSec : null,
            // 放置类别（amphibious/fly/vine/lilypad…）：只原样上报游戏 TAGS。
            placementTags: (pst && pst.placement && pst.placement.tags || [])
              .filter((t) => PLACEMENT_TAGS.has(t)),
            // 点击类植物：不知道 activation 的模型只会“种下去然后看着它不动”。
            activation: (pst && pst.usage && pst.usage.activation) || 'auto',
            aim: (pst && pst.usage && pst.usage.aim) || null,
            // 能量豆事实先放紧凑结构，targets 等僵尸读完后统一算（见下面 foodPlan）。
            food: (pst && pst.plantFood) ? {
              kind: pst.plantFood.kind,
              area: pst.plantFood.area,
              radius: pst.plantFood.radius,
              total: pst.plantFood.total,
              totalPerTarget: pst.plantFood.totalPerTarget,
              maxTotal: pst.plantFood.maxTotal,
              sunTotal: pst.plantFood.sunTotal,
              sunValue: pst.plantFood.sunValue,
              count: pst.plantFood.count,
              projectileDamage: pst.plantFood.projectileDamage,
              targetsPerHit: pst.plantFood.targetsPerHit,
              hitsPerTarget: pst.plantFood.hitsPerTarget,
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
        const eating = !!(z.isEating || z.eating || z.isEatingPlant || z.eatTarget
          || z.targetPlant || z.eatingPlant || z.attackTarget);
        // 血量阈值阶段（巨人扔小鬼/狂暴/掉手…）：只给“还没触发、最近的那个”。
        const phases = (zst && Array.isArray(zst.phases)) ? zst.phases : [];
        const nextPhase = phases.length && zst.hp
          ? phases
            .map((ph) => ({ ...ph, atHp: Math.round(Number(zst.hp) * Number(ph.atHpPct)) }))
            .filter((ph) => ph.atHp < hp)
            .sort((a, b) => b.atHp - a.atHp)[0] || null
          : null;
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
          // 只给“下一阶段还差多少血”，不把完整阶段表塞进每回合。
          nextPhase: nextPhase ? {
            atHp: nextPhase.atHp,
            atHpPct: nextPhase.atHpPct,
            effect: nextPhase.effect,
            spawn: nextPhase.spawn || undefined,
          } : undefined,
          phases: phases.length ? phases.map((ph) => ({
            atHpPct: ph.atHpPct, effect: ph.effect, spawn: ph.spawn || undefined,
          })) : undefined,
          // 飞行标签只说明“会飞”；荡索落地后会走到 c4 附近。用列位置给一个可操作的空中窗口。
          // 游戏本身还暴露了 swinging / _flying / flyZombie：优先用这些真实状态，
          // 否则荡索在空中时列位置可能已经压到 4.5 以下，三叶草会被判成“没有空中目标”。
          airborne: (() => {
            const tags = (zst && zst.tags) || [];
            const rawAir = !!(z.swinging || z._flying || z.flyZombie || z.currentFlyZombie);
            if (rawAir) return true;
            if (!tags.includes('flying')) return false;
            if (/swashbuckler/i.test(String(type))) return col >= 4.5;
            return true;
          })(),
          speed,
          eatDps: (zst && Number(zst.eatDps) > 0) ? Number(zst.eatDps) : null,
          eating,
          etaToHouse: speed > 0 ? Math.round((col / speed) * 10) / 10 : null,
        });
      }
    }
    out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);
    for (const row of out.board) row.zombies = out.zombies.filter((z) => z.lane === row.lane);

    // 僵尸啃咬：按列位置判断谁已经在同一格/贴住植物，再算这株还能撑多久。
    // 只有真正接触的僵尸算啃食 DPS；同行的远处僵尸不计入，否则会严重低估支撑时间。
    const PLANT_CONTACT_AHEAD = 1.1;
    const PLANT_CONTACT_BEHIND = 0.3;
    for (const p of out.plants) {
      const contact = out.zombies.filter((z) => z.lane === p.lane
        && z.column >= p.column - PLANT_CONTACT_BEHIND
        && z.column <= p.column + PLANT_CONTACT_AHEAD);
      const eatDps = contact.reduce((s, z) => s + (Number(z.eatDps) || 0), 0);
      const approaching = out.zombies
        .filter((z) => z.lane === p.lane && z.column > p.column + PLANT_CONTACT_AHEAD)
        .sort((a, b) => a.column - b.column)[0] || null;
      if (contact.length) {
        p.underAttack = true;
        p.eaters = contact.length;
        p.eatDps = Math.round(eatDps * 10) / 10;
        // 血量按当前 hp（不是 maxHp），因为墙/输出已经被啃掉一部分。
        p.holdSec = eatDps > 0 ? Math.round(((p.hp || 0) / eatDps) * 10) / 10 : null;
      }
      if (approaching) {
        const speed = Number(approaching.speed) > 0 ? Number(approaching.speed) : 0.18;
        p.contactInSec = Math.max(0, Math.round(((approaching.column - (p.column + PLANT_CONTACT_AHEAD)) / speed) * 10) / 10);
      }
    }

    // ── 输出口径：射程 / 实际目标数 / 墓碑遮挡 / 毒伤 / 地刺 ──
    // 只算几何与字段事实，不判断该打谁。
    const ZOMBIE_HIT_BEHIND = 1.1;
    function zombieInPlantRange(p, z) {
      if (!p || !p.atk) return false;
      // 直线弹道只被“僵尸与植物之间”的墓碑挡住；僵尸在墓碑前面时仍然打得到。
      if (p.blockedAt && Number(z.column) > Number(p.blockedAt.column)) return false;
      const gap = Number(z.column) - (p.column + 0.5);
      if (p.stepDamage) return Math.abs(gap) <= 0.55;
      if (p.reach == null) return gap >= -0.05;
      return gap >= -ZOMBIE_HIT_BEHIND && gap <= Number(p.reach) + 0.5;
    }
    // 这张卡当前能同时命中几只（不超过 targets）。
    function plantHitCount(p, zs) {
      if (!p.atk) return 0;
      const base = Number(p.effectiveDps) || Number(p.atk.dps) || 0;
      if (!(base > 0)) return 0;
      // 地刺只打“踩在本格”的僵尸，不是整行输出。
      if (p.stepDamage) {
        const onTile = zs.filter((z) => Math.abs(Number(z.column) - (p.column + 0.5)) <= 0.55).length;
        return Math.min(1, onTile);
      }
      const n = zs.filter((z) => zombieInPlantRange(p, z)).length;
      return Math.min(Math.max(1, Number(p.atk.targets) || 1), n);
    }
    function plantLaneDps(p, zs) {
      const hits = plantHitCount(p, zs);
      if (!hits) return 0;
      const base = Number(p.effectiveDps) || Number(p.atk.dps) || 0;
      return base * hits * (Number(p.atk.hitsPerTarget) || 1);
    }

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
      // 实际可用输出：排除墓碑遮挡、地刺（只打本格）和射程外的目标；
      // 多目标按“当前真能同时打到几只”算，而不是固定按 targets 上限算。
      const dpsEffective = Math.round(ps.reduce((s, p) => s + plantLaneDps(p, zs), 0) * 10) / 10;
      const dpsBlocked = Math.round(ps.reduce((s, p) => s
        + (p.blockedAt && p.atk ? Number(p.atk.dps) || 0 : 0), 0) * 10) / 10;
      const dpsStep = Math.round(ps.reduce((s, p) => s
        + (p.stepDamage && p.atk ? Number(p.atk.dps) || 0 : 0), 0) * 10) / 10;
      // 威胁率：每秒会有多少 EHP 走到房子（ehp / 到房子的秒数），和本行 dps 直接同量纲
      const incoming = zs.reduce((s, z) => {
        const eta = z.etaToHouse;
        const e = z.ehp != null ? z.ehp : (z.ehpMax || 0);
        return s + (eta && eta > 0 ? e / eta : 0);
      }, 0);
      const lossIn = zs.length ? Math.min(...zs.map((z) => (z.etaToHouse == null ? Infinity : z.etaToHouse))) : null;
      const front = zs.length ? zs.reduce((a, b) => (b.column < a.column ? b : a)) : null;
      // 最前僵尸前方（左侧）最近的一株植物；它才是僵尸接下来会啃的阻挡物。
      // 包含“僵尸已经进入同一格”的植物（p.column <= zombie.column + 0.5），
      // 这样正在被啃的那株才会成为 frontPlant，而不是跳到它后面那株。
      const aheadPlants = front
        ? ps.filter((p) => p.column <= front.column + 0.5).sort((a, b) => b.column - a.column)
        : [];
      const frontPlant = aheadPlants[0] || null;
      const speed = front && Number(front.speed) > 0 ? Number(front.speed) : 0.18;
      const contactInSec = frontPlant && front
        ? Math.max(0, Math.round(((front.column - (frontPlant.column + 0.5)) / speed) * 10) / 10)
        : null;
      const holdSec = frontPlant
        ? (frontPlant.holdSec != null
          ? frontPlant.holdSec
          : Math.round(((frontPlant.hp || 0) / (Number(front && front.eatDps) || 100)) * 10) / 10)
        : null;
      const killWindowSec = contactInSec != null && holdSec != null
        ? Math.round((contactInSec + holdSec) * 10) / 10 : null;
      // 先看射程：短手植物够不到最前僵尸就不算；远程植物只看是否在它左侧（不能打背后）。
      const dpsOnFront = Math.round(ps.reduce((s, p) => {
        if (!front || !zombieInPlantRange(p, front)) return s;
        return s + plantLaneDps(p, zs);
      }, 0) * 10) / 10;
      const frontEhp = front ? (front.ehp != null ? front.ehp : (front.ehpMax || 0)) : null;
      const killSec = front && dpsOnFront > 0 && frontEhp != null
        ? Math.round((frontEhp / dpsOnFront) * 10) / 10 : null;
      const killBeforeWindow = killSec != null && killWindowSec != null ? killSec <= killWindowSec : null;
      // 沿路把所有会挡路的植物按“接触 → 啃掉 → 继续走”估一遍，
      // 这样墙/向日葵/输出被啃的时间都会算进“还能拖多久”。
      let projectedHouseSec = null;
      if (front && aheadPlants.length) {
        let pos = front.column;
        let t = 0;
        for (const p of aheadPlants) {
          const contactPos = p.column + 0.5;
          if (pos > contactPos) t += (pos - contactPos) / speed;
          const eat = p.holdSec != null
            ? p.holdSec
            : ((p.hp || 0) / (Number(front.eatDps) || 100));
          t += eat;
          pos = contactPos;
        }
        t += Math.max(0, pos) / speed;
        projectedHouseSec = Math.round(t * 10) / 10;
      }
      const killBeforeHouse = killSec != null && projectedHouseSec != null
        ? killSec <= projectedHouseSec : null;
      const tombColumns = obstacles
        .filter((o) => o && o.type === 'tomb' && o.lane === r)
        .map((o) => o.column)
        .sort((a, b) => a - b);
      // 全行口径：不是只看最前一只。ehp 是本行所有僵尸的剩余总血量，
      // clearSec 是用本行全部有效 dps 清完这一行要多久（近似值，多目标按实际覆盖算）。
      const laneEhp = Math.round(zs.reduce((s, z) => s + (z.ehp != null ? z.ehp : z.ehpMax || 0), 0));
      const clearSec = laneEhp > 0 && dpsEffective > 0
        ? Math.round((laneEhp / dpsEffective) * 10) / 10 : null;
      const clearBeforeHouse = clearSec != null && lossIn != null && Number.isFinite(lossIn)
        ? clearSec <= lossIn : null;
      out.lanes.push({
        lane: r, zombies: zs.length,
        nearestZombie: zs.length ? Math.min(...zs.map((z) => z.column)) : null,
        shooters: ps.filter((p) => p.atk && p.atk.dps).length,
        walls: ps.filter((p) => isWall(p.type)).length,
        wallCells: ps.filter((p) => isWall(p.type))
          .map((p) => ({ column: p.column, type: p.type, hp: p.hp, maxHp: p.maxHp })),
        shooterCells: ps.filter((p) => p.atk && p.atk.dps).map((p) => ({ column: p.column, type: p.type, dps: p.atk.dps })),
        sunProducers: ps.filter(isSunPlant).length,
        plants: ps.length,
        dps,
        dpsGroup,
        dpsEffective,
        dpsBlocked,
        dpsStep,
        wallHp: ps.reduce((s, p) => s + (isWall(p.type) ? (p.hp || 0) : 0), 0),
        tombColumns,
        straightBlocked: tombColumns.length > 0,
        // 本行在场上僵尸的剩余 EHP 合计（读不到护甲时用 ehpMax 上界），以及是否全是精确值
        ehp: laneEhp,
        ehpExact: zs.every((z) => z.ehp != null),
        // 全行清怪时间：ehp / dpsEffective；和 lossIn 比，看这行能不能在到家前清完。
        clearSec,
        clearBeforeHouse,
        // 防御缺口：incomingPerSec > 实际可用 dps 就说明这行会被压穿。
        // gap 用 dpsEffective（排除遮挡/地刺/射程外）；gapRaw 保留名义口径，方便对照。
        incomingPerSec: Math.round(incoming * 10) / 10,
        gap: Math.round((incoming - dpsEffective) * 10) / 10,
        gapRaw: Math.round((incoming - dps) * 10) / 10,
        lossIn: lossIn == null || !Number.isFinite(lossIn) ? null : Math.round(lossIn * 10) / 10,
        // 把 AI 延迟算进去后，最晚什么时候必须动手；<0 就是已经来不及
        actBy: lossIn == null || !Number.isFinite(lossIn) ? null : Math.round((lossIn - lead) * 10) / 10,
        // 救场计算：僵尸左侧还能打到它的 dps、前方阻挡植物能拖多久、够不够在植物被啃完前杀掉。
        dpsOnFront,
        killSec,
        frontPlant: frontPlant ? {
          lane: frontPlant.lane, column: frontPlant.column, type: frontPlant.type,
          hp: frontPlant.hp, eatDps: frontPlant.eatDps || null,
          underAttack: !!frontPlant.underAttack, holdSec,
        } : null,
        contactInSec,
        holdSec,
        killWindowSec,
        killBeforeWindow,
        // 把沿路所有植物能拖的时间都算进去：即使这株挡不住，也可能在到房子前磨死它。
        killBeforeHouse,
        projectedHouseSec,
        front: front ? {
          column: front.column, type: front.type,
          ehp: front.ehp != null ? front.ehp : front.ehpMax,
          speed, eatDps: front.eatDps || null, eating: !!front.eating,
        } : null,
        mower,
      });
    }

    // ── 提前量：波次 ETA / 卡牌可用时间 / 一次性卡落点窗口 / 每回合摘要 ──
    let fc = null;
    try { fc = lsFull ? buildForecast(lsFull, stats) : null; } catch { fc = null; }
    const totalDps = Math.round((out.lanes || []).reduce((s, l) => s + (l.dpsEffective != null ? l.dpsEffective : (l.dps || 0)), 0) * 10) / 10;
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

    // 一次性/范围卡的落点事实：只回答“放在这个已有僵尸的格子上，会命中几只、总伤害多少、能杀几只”。
    // 不排序、不标 best、不选卡；空格的“最佳落点”留给模型自己判断。
    const aimOptions = [];
    const aimScopeOf = (areaText) => {
      const area = String(areaText || '');
      const r = /半径\s*([\d.]+)/.exec(area);
      if (r) return { scope: 'radius', radius: Number(r[1]) };
      if (/5x5|5×5/.test(area)) return { scope: 'box', radius: 2 };
      if (/3x3|3×3/.test(area)) return { scope: 'box', radius: 1 };
      if (/1x3|1×3/.test(area)) return { scope: '1x3', radius: 1 };
      if (/全屏|全场/.test(area)) return { scope: 'all', radius: null };
      if (/三行|多行/.test(area)) return { scope: 'lanes3', radius: null };
      if (/整行|本行|一行/.test(area)) return { scope: 'lane', radius: null };
      if (/本格|Tile/i.test(area)) return { scope: 'tile', radius: 0 };
      return { scope: 'single', radius: 0 };
    };
    const aimHits = (opt, cell) => out.zombies.filter((z) => {
      const zc = Math.max(0, Math.min(cols - 1, Math.floor(z.column)));
      const dx = zc - cell.column;
      const dy = z.lane - cell.lane;
      if (opt.scope === 'all') return true;
      if (opt.scope === 'lane') return dy === 0;
      if (opt.scope === 'lanes3') return Math.abs(dy) <= 1;
      if (opt.scope === 'single' || opt.scope === 'tile') {
        return dy === 0 && dx === 0;
      }
      if (opt.scope === 'radius') return Math.hypot(dx, dy) <= opt.radius;
      if (opt.scope === '1x3') return dy === 0 && Math.abs(dx) <= 1;
      return Math.abs(dx) <= opt.radius && Math.abs(dy) <= opt.radius;
    });
    for (const c of out.cards || []) {
      const st = stats.plantStatsOf(c.type);
      if (!st || !st.burst || !(Number(st.burst.dmg) > 0)) continue;
      const area = st.burst.area || st.area || '';
      // Explosive 但没有任何范围字段：不猜它是单体还是全屏，宁可不给落点。
      if (!area && st.family === 'Explosive') continue;
      const oneShot = (st.shot && st.shot.kind === 'instant')
        || (st.shot && st.shot.kind === 'aimed')
        || (st.shot && st.shot.kind === 'area' && area)
        || (st.usage && st.usage.manual)
        || (!st.attack && area && Number(st.burst.dmg) >= 100)
        || (st.shot && st.shot.kind === 'melee' && Number(st.burst.dmg) >= 1000);
      if (!oneShot) continue;
      const opt = aimScopeOf(area);
      const dmg = Number(st.burst.dmg);
      const cells = [];
      if (opt.scope === 'all') {
        cells.push({ lane: null, column: null });
      } else if (opt.scope === 'lane' || opt.scope === 'lanes3') {
        for (const lane of [...new Set(out.zombies.map((z) => z.lane))].sort((a, b) => a - b)) {
          if (opt.scope === 'lane' && !out.zombies.some((z) => z.lane === lane)) continue;
          cells.push({ lane, column: null });
        }
      } else {
        const seen = new Set();
        for (const z of out.zombies) {
          const column = Math.max(0, Math.min(cols - 1, Math.floor(z.column)));
          const key = `${z.lane}:${column}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cells.push({ lane: z.lane, column });
        }
      }
      for (const cell of cells) {
        const allHits = aimHits(opt, cell);
        // 单体卡只打一只；同格多只时按快照顺序取第一只，只作为几何事实。
        const hits = opt.scope === 'single' ? allHits.slice(0, 1) : allHits;
        if (!hits.length) continue;
        // 已经有植物的格子不能直接种；要换植得用 replace，不在 aimOptions 里假装可种。
        if (cell.column != null) {
          const row = out.board[cell.lane];
          if (row && row.cells && row.cells[cell.column]) continue;
        }
        // 土豆雷/地雷有 armTime：僵尸到得太早的落点不算有效选项。
        if (st.armTimeSec > 0 && cell.column != null) {
          const minEta = Math.min(...hits.map((z) => {
            const speed = Number(z.speed) > 0 ? Number(z.speed) : 0.18;
            return (Number(z.column) - (cell.column + 0.5)) / speed;
          }));
          if (!(minEta >= Number(st.armTimeSec) + Number(lead || 0) + 1)) continue;
        }
        let total = 0;
        let kills = 0;
        let overkill = 0;
        for (const z of hits) {
          const ehp = z.ehp != null ? z.ehp : (z.ehpMax || 0);
          total += dmg;
          if (dmg >= ehp) {
            kills += 1;
            overkill += dmg - ehp;
          }
        }
        aimOptions.push({
          card: c.type, scope: opt.scope,
          lane: cell.lane, column: cell.column,
          hits: hits.length, dmg, total, kills,
          overkill: Math.round(overkill),
        });
      }
    }
    out.aimOptions = aimOptions;

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
    // 保护格的 scope：换关/重开才清空“见过植物”的记录。
    const protectScope = `${level.source.asset || level.name || ''}#${level.source.number == null ? '' : level.source.number}`;
    const protectRunStarted = !!(lvl && lvl.gameStarted);
    if (protectScope !== protectSeenScope || protectScope !== protectKnownScope || !protectRunStarted) {
      protectSeenScope = protectScope;
      protectKnownScope = protectScope;
      protectSeen.clear();
      protectKnown.clear();
    }
    // 保护关有两种判负：被啃死（eat）和碰到就输（contact，如“别让僵尸踩坏鲜花”）。
    // 这决定布防逻辑（挡/秒杀 vs 拼 DPS），必须显式告诉模型。
    const protectText = [].concat(missionHints || [], (objective && objective.missions) || []).join(' ');
    const protectMode = /踩|踏|碰|接触|撞|trample|touch/i.test(protectText) ? 'contact' : 'eat';
    const protectInfo = protectCellsNow.length ? (() => {
      const plantAt = (lane, col) => (out.plants || []).find((p) => p.lane === lane && Math.abs(Number(p.column) - col) < 0.75) || null;
      const statsOf = (p) => {
        if (!p) return null;
        try { return stats.plantStatsOf(p.type); } catch { return null; }
      };
      const isWall = (p) => {
        const st = statsOf(p);
        // 有伤害的“高血量卡”（吸血牛肝菌 4000 血 + 3x3 吸血）不是墙，不能按阻挡位摆后排。
        return !!(st && (st.family === 'Defence'
          || ((st.hp || 0) >= 1000 && !(st.attack && Number(st.attack.dps) > 0) && !st.burst)));
      };
      const isMelee = (p) => {
        const st = statsOf(p);
        return !!(st && (st.family === 'Melee' || /接触|接近|前后|3x3/.test(String(st.range || ''))));
      };
      // 保护植物本身也要给模型看：是哪张卡、现在多少血、有什么被动/冷却。
      // 只有坐标的话，模型会把它当成“空格/花盆”，复盘时只能瞎归因（比如怪到向日葵头上）。
      const plantFacts = (p) => {
        if (!p) return null;
        const st = statsOf(p);
        const props = (st && st.props) || {};
        const out0 = {
          type: p.type, name: p.name || p.type, hp: p.hp, maxHp: p.maxHp || null,
          family: (st && st.family) || p.family || null,
          brief: (st && st.brief) || null,
        };
        if (st && Array.isArray(st.special) && st.special.length) out0.special = st.special.slice(0, 3);
        const usage = st && st.usage;
        if (usage && (usage.restSec != null || usage.activation)) {
          out0.usage = { activation: usage.activation || 'auto' };
          if (usage.restSec != null) out0.usage.restSec = usage.restSec;
        }
        if (props.KnockbackDistance != null) out0.knockback = props.KnockbackDistance;
        if (props.RestTime != null) out0.restSec = props.RestTime;
        return out0;
      };
      const cells = protectCellsNow.map((c) => {
        const guards = [];
        for (const d of [1, -1]) {
          const cc = c.column + d;
          if (cc >= 0 && cc < cols) guards.push({ lane: c.lane, column: cc });
        }
        const own = plantAt(c.lane, c.column);
        const seenKey = `${c.lane}:${c.column}`;
        let dead = !!c.dead;
        if (own) {
          protectSeen.add(seenKey);
          // 同一格可能也有别的植物，逐个标上 protected，工具层和复盘就不用再猜坐标。
          own.protected = true;
        } else if (protectSeen.has(seenKey)) {
          dead = true;
        }
        // 保护判定是“踩踏/接触”时，僵尸走到这一格就直接判负：
        // 算清楚最前僵尸还有几秒碰到保护格，模型才知道该提前挡还是硬杀。
        const laneZ = (out.zombies || []).filter((z) => z.lane === c.lane && Number(z.column) > c.column);
        const frontZ = laneZ.sort((a, b) => Number(a.column) - Number(b.column))[0] || null;
        const spd = frontZ && Number(frontZ.speed) > 0 ? Number(frontZ.speed) : 0.18;
        const contactInSec = frontZ ? Math.max(0, Math.round(((Number(frontZ.column) - c.column - 1) / spd) * 10) / 10) : null;
        const front = plantAt(c.lane, c.column + 1);
        const back = plantAt(c.lane, c.column - 1);
        const meleeGuard = [front, back].find((p) => p && isMelee(p)) || null;
        const wallGuard = front && isWall(front) ? front : null;
        const cellType = own ? own.type : protectTypeMemo.get(`${protectScope}|${c.lane}:${c.column}`) || null;
        if (protectRunStarted) protectKnown.set(`${c.lane}:${c.column}`, { lane: c.lane, column: c.column, type: cellType });
        return {
          lane: c.lane, column: c.column, dead,
          frontColumn: Math.min(cols - 1, c.column + 1),
          guardColumns: guards,
          // 保护目标本体：类型/血量/技能/冷却；死了之后 plant=null、type 保留最后一次见到的卡。
          plant: plantFacts(own),
          type: cellType,
          // 还有几秒被踩到/被接触到；null = 本行暂时没有更靠右的僵尸。
          contactInSec,
          frontZombie: frontZ ? { type: frontZ.type, column: frontZ.column, speed: frontZ.speed } : null,
          wall: wallGuard ? wallGuard.type : null,
          melee: meleeGuard ? meleeGuard.type : null,
          // 地面防线是否已有墙/近战；false 表示这一行还没布防，优先补。
          groundGuarded: !!(wallGuard || meleeGuard),
        };
      });
      // 本局见过、但现在整个消失的保护格 = 保护植物已经死了（游戏会把格子和植物一起移除）。
      if (protectRunStarted) {
        for (const v of protectKnown.values()) {
          if (cells.some((x) => x.lane === v.lane && x.column === v.column)) continue;
          cells.push({
            lane: v.lane, column: v.column, dead: true, missing: true,
            atLoss: !!(lvl && lvl.gameLost),
            frontColumn: Math.min(cols - 1, v.column + 1),
            guardColumns: [],
            plant: null,
            type: v.type || null,
            wall: null, melee: null, groundGuarded: false,
          });
        }
        cells.sort((a, b) => a.lane - b.lane || a.column - b.column);
      }
      // 记住最后一个活着的保护植物类型，死亡后仍能说清“死的是弹簧豆”。
      for (const c of cells) {
        if (c.plant && c.plant.type) protectTypeMemo.set(`${protectScope}|${c.lane}:${c.column}`, c.plant.type);
      }
      const airCards = (out.deck || []).filter((t) => t === 'blover' || t === 'lightningreed');
      return {
        count: cells.length,
        dead: cells.filter((c) => c.dead).length,
        // 判负时游戏可能把所有保护格一起清掉：这种情况不能断言“5/5 全死”，
        // 只能说明“保护目标被突破”。
        lossTriggered: !!(lvl && lvl.gameLost),
        // contact = 碰到即判负（踩坏鲜花）；eat = 被啃到没血才判负。
        mode: protectMode,
        types: [...new Set(cells.map((c) => c.type).filter(Boolean))],
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
        // 同格聚集情况：地雷/土豆雷的爆炸按“格”结算，同一格里的多只僵尸
        // 会被同一次爆炸一起打到。给模型看哪里聚得最多，而不是只盯着最前一只。
        const tiles = [];
        for (const z of zs) {
          const c = Math.max(0, Math.min(cols - 1, Math.floor(Number(z.column))));
          let t = tiles.find((x) => x.column === c);
          if (!t) { t = { column: c, count: 0, ehp: 0, types: [] }; tiles.push(t); }
          t.count += 1;
          t.ehp += Number(z.ehp != null ? z.ehp : (z.ehpMax || z.hp || 0)) || 0;
          if (z.type && !t.types.includes(z.type)) t.types.push(z.type);
        }
        tiles.sort((a, b) => b.count - a.count || a.column - b.column);
        const row = out.board[lane];
        // 僵尸到雷格的时间 = 直接走过去的时间 + 路上所有植物的啃食时间。
        // 这正是“最后把向日葵换雷、靠前面墙/植物拖到雷出土”的算法；只看
        // (front.column - c)/speed 会把墙前/墙后的雷全判成太晚。
        const etaTo = (c) => {
          const direct = (front.column - c) / speed;
          const hold = (out.plants || []).filter((p) => p.lane === lane
            && Number(p.column) > c && Number(p.column) <= front.column + 0.5)
            .reduce((s, p) => s + (p.holdSec != null
              ? Number(p.holdSec)
              : (Number(p.hp) || 0) / (Number(front.eatDps) || 100)), 0);
          return direct + hold;
        };
        const safe = [];
        for (let c = 0; c < cols; c++) {
          const occupied = row && row.cells && row.cells[c];
          const terr = row && row.terrain && row.terrain[c];
          if (occupied || terr === 'W' || terr === 'S') continue;
          if (etaTo(c) >= arm + lead + 1) safe.push(c);
        }
        const latest = safe.length ? Math.max(...safe) : null;
        minePlan.push({
          card: type,
          lane,
          armTimeSec: arm,
          front: { type: front.type, name: front.name, column: front.column, speed },
          latestSafeColumn: latest,
          safeColumns: safe.slice(-5),
          etaAtLatest: latest == null ? null : Math.round(etaTo(latest) * 10) / 10,
          tooLate: latest == null,
          // 当前每格聚了多少只（按数量降序）：同格多只 = 一次爆炸多杀。
          tiles: tiles.slice(0, 4).map((t) => ({ column: t.column, count: t.count, ehp: Math.round(t.ehp), types: t.types })),
        });
      }
    }
    const laneCalculations = laneMath({ lanes: out.lanes, zombies: out.zombies });

    // 救场事实：僵尸贴到家门口时，哪几格还能打到它、哪株低价值植物可以铲掉换输出、
    // 前方植物还能拖几秒、哪些一次性卡/能量豆能覆盖它。只给可执行事实，不替模型做选择。
    const rescuePlan = [];
    const rescueWallCard = (out.deck || []).find((t) => isWall(t)) || null;
    const roleOfPlant = (p) => {
      if (isSunPlant(p)) return 'economy';
      if (String(p.family || '') === 'Defence') return 'wall';
      if (p.atk && Number(p.atk.dps) > 0) return 'output';
      return 'support';
    };
    for (const l of out.lanes) {
      if (!l.front) continue;
      const front = l.front;
      const urgent = (l.actBy != null && l.actBy <= 3)
        || (l.front.column <= 3)
        || l.killBeforeWindow === false;
      if (!urgent) continue;
      const ps = out.plants.filter((p) => p.lane === l.lane);
      const cells = [];
      for (let c = 0; c < cols; c++) {
        // 输出/墙都必须放在僵尸左侧（column 更小）才打得到/挡得住它。
        if (c + 0.25 >= front.column) continue;
        const p = ps.find((x) => x.column === c) || null;
        cells.push({
          column: c,
          occupied: !!p,
          plant: p ? { type: p.type, role: roleOfPlant(p), hp: p.hp, dps: (p.atk && p.atk.dps) || null, family: p.family } : null,
        });
      }
      const emptyColumns = cells.filter((x) => !x.occupied).map((x) => x.column).sort((a, b) => b - a).slice(0, 3);
      const replaceCandidates = cells.filter((x) => x.occupied)
        .sort((a, b) => {
          const ra = a.plant.role === 'economy' ? 0 : (a.plant.role === 'support' ? 1 : 2);
          const rb = b.plant.role === 'economy' ? 0 : (b.plant.role === 'support' ? 1 : 2);
          if (ra !== rb) return ra - rb;
          return (a.plant.dps || 0) - (b.plant.dps || 0) || b.column - a.column;
        })
        .slice(0, 4)
        .map((x) => ({ lane: l.lane, ...x }));
      const outputCards = (out.cards || [])
        .filter((c) => (Number(c.dps) > 0 || Number(c.burstDmg) > 0) && c.type !== rescueWallCard)
        .map((c) => ({
          card: c.index, type: c.type, cost: c.cost,
          dps: c.dps || null, burstDmg: c.burstDmg || null,
          ready: !!c.ready, affordable: !!c.affordable,
          // 放在空位/替换低价值植物后，按这一行现有输出粗算击杀这只僵尸的时间。
          ttkSec: (() => {
            const gain = Number(c.dps) || 0;
            const dps = (l.dpsOnFront || 0) + gain;
            const ehp = Number(front.ehp) || 0;
            return dps > 0 && ehp > 0 ? Math.round((ehp / dps) * 10) / 10 : null;
          })(),
          canHitFrontFrom: emptyColumns.concat(replaceCandidates.map((x) => x.column)),
        }))
        .sort((a, b) => (b.dps || b.burstDmg || 0) - (a.dps || a.burstDmg || 0))
        .slice(0, 4);
      rescuePlan.push({
        lane: l.lane,
        urgency: (l.actBy != null && l.actBy <= 0) || l.front.column <= 1 ? 'critical' : 'high',
        front,
        window: {
          contactInSec: l.contactInSec,
          holdSec: l.holdSec,
          killWindowSec: l.killWindowSec,
          killSec: l.killSec,
          killBeforeWindow: l.killBeforeWindow,
          killBeforeHouse: l.killBeforeHouse,
          projectedHouseSec: l.projectedHouseSec,
        },
        frontPlant: l.frontPlant,
        emptyColumns,
        replaceCandidates,
        wallColumns: rescueWallCard ? emptyColumns.concat(replaceCandidates.map((x) => x.column)).slice(0, 4) : [],
        wallBlockable: !!(rescueWallCard && (emptyColumns.length || replaceCandidates.length)),
        outputCards,
        instantCards: (out.cards || []).filter((c) => Number(c.burstDmg) > 0)
          .map((c) => ({ card: c.index, type: c.type, burstDmg: c.burstDmg, cost: c.cost, ready: !!c.ready, affordable: !!c.affordable }))
          .slice(0, 4),
        food: (out.plantFoodPlan || []).filter((f) => f.lane === l.lane).slice(0, 3),
        wallCard: rescueWallCard,
      });
    }
    rescuePlan.sort((a, b) => (a.urgency === 'critical' ? -1 : 1) - (b.urgency === 'critical' ? -1 : 1)
      || (a.front.column - b.front.column));
    const rescueTop = rescuePlan.slice(0, 3);

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
    // 支撑时间只算“已经贴住这面墙”的僵尸总啃食 DPS；同行远处僵尸没碰到墙，不能算进去。
    const wallCardOf = (out.deck || []).find((t) => isWall(t)) || null;
    const wallCardState = wallCardOf ? (out.cards || []).find((c) => c.type === wallCardOf) : null;
    const wallCardStats = wallCardOf ? plantStats(wallCardOf) : null;
    const wallBaseCd = (wallCardStats && Number(wallCardStats.cd)) || null;
    const wallPlan = out.lanes.map((l) => {
      const zs = out.zombies.filter((z) => z.lane === l.lane).sort((a, b) => a.column - b.column);
      const front = zs[0] || null;
      const walls = (l.wallCells || []).slice().sort((a, b) => b.column - a.column);
      // 只有僵尸左侧（column 更小）的墙才在它前进路径上；它右侧的墙已经被越过了。
      const frontWall = front ? walls.find((w) => w.column + 0.5 < front.column) || null : (walls[0] || null);
      const eaters = frontWall
        ? zs.filter((z) => z.column >= frontWall.column - 0.3 && z.column <= frontWall.column + 1.1)
        : [];
      const survival = wallSurvive({
        wallHp: frontWall ? frontWall.hp : 0,
        eatDps: eaters.map((z) => (Number(z.eatDps) > 0 ? Number(z.eatDps) : 100)),
      });
      const frontEta = front ? Math.round((front.column / (front.speed > 0 ? front.speed : 0.18)) * 10) / 10 : null;
      const wallEta = frontWall && front
        ? Math.max(0, Math.round(((front.column - (frontWall.column + 0.5)) / (front.speed > 0 ? front.speed : 0.18)) * 10) / 10)
        : null;
      const risk = !front ? 'ok'
        : !frontWall ? 'no_wall'
          : (survival.surviveSec != null && l.killSec != null && survival.surviveSec < l.killSec ? 'wall_too_thin' : 'ok');
      return {
        lane: l.lane,
        wallHp: frontWall ? frontWall.hp : 0,
        wallType: frontWall ? frontWall.type : null,
        wallBehind: !frontWall && walls.length > 0,
        frontType: front ? front.type : null,
        frontColumn: front ? front.column : null,
        frontEta,
        wallEta,
        eatDps: survival.totalEatDps,
        eaters: eaters.length,
        wallSurviveSec: survival.surviveSec,
        killSec: l.killSec,
        risk,
        wallCard: wallCardOf,
        wallCd: wallCardState ? wallCardState.cd : null,
        wallBaseCd,
      };
    });
    const wallRebuild = wallRebuildPlan({ wallPlan, leadSec: lead });
    // 旗帜波/波次计数结束 != 关卡结束：场上还有僵尸就是残敌。
    // 这组事实用来阻止模型在空行继续按旧计划补墙/输出。
    const waveTotal = out.level.waves;
    const activeLanes = [...new Set((out.zombies || []).map((z) => Number(z.lane)).filter(Number.isFinite))]
      .sort((a, b) => a - b);
    const idleLanes = out.lanes.filter((l) => !(l.zombies > 0)).map((l) => l.lane);
    const residualEhp = Math.round((out.zombies || []).reduce((s, z) => s + (z.ehp != null ? z.ehp : (z.ehpMax || 0)), 0));
    const residual = out.zombies && out.zombies.length ? {
      count: out.zombies.length,
      lanes: activeLanes,
      ehp: residualEhp,
      front: out.zombies.reduce((a, b) => (b.column < a.column ? b : a), out.zombies[0]),
    } : null;
    // 卡效对比：把“单体 dps”和“多目标 multiDps”的差距、每阳光收益摊开。
    // 不排序推荐，也不替模型选卡；只让“同线多只僵尸时多目标卡更值”变成可算的事实。
    const cardEfficiency = (out.cards || [])
      .filter((c) => Number(c.dps) > 0 || Number(c.multiDps) > 0)
      .map((c) => {
        let st = null;
        try { st = stats.plantStatsOf(c.type); } catch { st = null; }
        const dps = Number(c.dps) || 0;
        const multi = Number(c.multiDps) || dps;
        const cost = Number(c.cost) || 0;
        return {
          card: c.type,
          cost,
          dps,
          targets: Number(c.targets) || 1,
          multiDps: Math.round(multi * 10) / 10,
          dpsPerSun: cost ? Math.round((dps / cost) * 1000) / 1000 : null,
          multiDpsPerSun: cost ? Math.round((multi / cost) * 1000) / 1000 : null,
          shot: (st && st.shot && st.shot.kind) || null,
          overObstacle: !!(st && st.shot && st.shot.overObstacle),
          blockedByStraightBlocker: !!(st && st.shot && st.shot.blockedByStraightBlocker),
        };
      });
    // 同格升级事实：这一行已经有 2 株以上单体输出、且同线僵尸≥2 时，
    // 列出“可换的多目标卡”和最低价值的可换格。换植不返还阳光，成本和冷却由模型自己算。
    const upgradePlan = [];
    for (const l of out.lanes) {
      if (!(Number(l.zombies) >= 2)) continue;
      const outs = (out.plants || [])
        .filter((p) => p.lane === l.lane && p.atk && Number(p.atk.dps) > 0)
        .sort((a, b) => Number(a.atk.dps) - Number(b.atk.dps));
      if (!outs.length) continue;
      // 后期/阳光富余时，后排向日葵也是“可换输出”的格子：一路的 dps 不够时，
      // 不是只在已有输出里换更强的，而是把经济位也转成输出。
      const sunAbundant = Number(out.sun) >= 300
        || (waveTotal != null && waveNow >= waveTotal - 1);
      const econ = (out.plants || [])
        .filter((p) => p.lane === l.lane && isSunPlant(p) && Number(p.column) <= 3)
        .sort((a, b) => Number(a.column) - Number(b.column));
      const replaceBase = (sunAbundant && econ.length)
        ? [...econ.map((p) => ({ p, role: 'economy' })), ...outs.map((p) => ({ p, role: 'output' }))]
        : outs.map((p) => ({ p, role: 'output' }));
      if (replaceBase.length < 2) continue;
      const candidates = (out.cards || [])
        .filter((c) => c.ready && c.affordable && Number(c.multiDps) > 0
          && Number(c.multiDps) > Number(c.dps) * 1.8)
        .map((c) => {
          let st = null;
          try { st = stats.plantStatsOf(c.type); } catch { st = null; }
          const blocked = (obstacles || [])
            .filter((o) => o && Number(o.lane) === l.lane && o.blocksStraightShot !== false)
            .map((o) => ({ column: o.column, hp: o.hp }));
          const straight = !!(st && st.shot && String(st.shot.kind) === 'straight');
          // 直线弹道只被“目标格右侧”的障碍挡住；左边的墓碑不影响。
          const usable = replaceBase.filter(({ p }) => !straight
            || !blocked.some((o) => Number(o.column) > Number(p.column)));
          if (!usable.length) return null;
          return {
            card: c.type,
            cost: c.cost,
            dps: c.dps,
            targets: c.targets || 1,
            multiDps: c.multiDps,
            shot: (st && st.shot && st.shot.kind) || null,
            // 这些格子已经有植物：要换只能 replace（先铲后种），不是再 plant 一株。
            use: 'replace',
            blockedBy: straight && blocked.length ? blocked : undefined,
            replaceCells: usable.slice(0, 3).map(({ p, role }) => ({
              column: p.column, type: p.type, dps: (p.atk && p.atk.dps) || 0, role,
            })),
          };
        })
        .filter((c) => c && c.replaceCells.length)
        .sort((a, b) => (b.multiDps / (b.cost || 1)) - (a.multiDps / (a.cost || 1)))
        .slice(0, 2);
      if (!candidates.length) continue;
      upgradePlan.push({
        lane: l.lane,
        zombies: l.zombies,
        outputs: outs.length,
        outputDps: Math.round(outs.reduce((s, p) => s + Number(p.atk.dps || 0), 0) * 10) / 10,
        laneEhp: l.ehp,
        clearSec: l.clearSec,
        sunAbundant,
        economyCells: econ.map((p) => ({ column: p.column, type: p.type })),
        candidates,
      });
    }
    // 每行还差多少输出：用“本行总 EHP / 可用时间”算需要的 dps，
    // 再减去当前有效 dps。不是只看最前一只，也不只是“补一株就够”。
    const capacityGaps = [];
    for (const l of out.lanes) {
      const laneEhp = Number(l.ehp) || 0;
      const laneDps = Number(l.dpsEffective) || 0;
      if (!(l.zombies > 0) || !(laneEhp > 0) || l.lossIn == null) continue;
      const nextIn = Number(out.level && out.level.nextWaveIn);
      const budgetSec = Math.max(3, Math.min(Number(l.lossIn) || 30,
        Number.isFinite(nextIn) && nextIn > 0 ? nextIn : (Number(l.lossIn) || 30)));
      const neededDps = Math.round((laneEhp / budgetSec) * 10) / 10;
      const missingDps = Math.round((neededDps - laneDps) * 10) / 10;
      if (!(missingDps > 0)) continue;
      const row = out.board && out.board[l.lane];
      const empties = [];
      if (row && Array.isArray(row.cells)) {
        for (let c = 0; c < row.cells.length; c++) if (!row.cells[c]) empties.push(c);
      }
      const frontCol = l.front ? Number(l.front.column) : 99;
      const addCells = empties.filter((c) => c <= frontCol + 0.5)
        .sort((a, b) => b - a).slice(0, 3);
      const economyCells = (out.plants || [])
        .filter((p) => p.lane === l.lane && isSunPlant(p))
        .sort((a, b) => a.column - b.column)
        .slice(0, 2)
        .map((p) => ({ column: p.column, type: p.type }));
      capacityGaps.push({
        lane: l.lane,
        ehp: laneEhp,
        dpsEffective: laneDps,
        clearSec: l.clearSec,
        lossIn: l.lossIn,
        budgetSec: Math.round(budgetSec * 10) / 10,
        neededDps,
        missingDps,
        addCells,
        economyCells,
        note: `按 ${Math.round(budgetSec * 10) / 10}s 内清完本行需要 ${neededDps} dps；当前 ${laneDps}，还差 ${missingDps}。`,
      });
    }
    capacityGaps.sort((a, b) => b.missingDps - a.missingDps);
    // 最后防线：这一行已经 clearBeforeHouse=false / 输出缺口大时，把后排向日葵
    // 换成雷也来得及——前提是前面的墙/植物能拖到雷出土。minePlan 已经把这些
    // 阻挡物的啃食时间算进 safeColumns，所以这里直接交叉引用，不再只看直接距离。
    const lastResortPlan = [];
    for (const l of out.lanes) {
      if (!l.front || l.lossIn == null) continue;
      const gap = capacityGaps.find((g) => g.lane === l.lane);
      const falling = l.clearBeforeHouse === false
        || !!(gap && Number(gap.missingDps) >= 20);
      if (!falling) continue;
      const mine = minePlan.find((m) => m && Number(m.lane) === Number(l.lane));
      if (!mine) continue;
      const front = l.front;
      const speed = Number(front.speed) > 0 ? Number(front.speed) : 0.18;
      const suns = (out.plants || [])
        .filter((p) => p.lane === l.lane && isSunPlant(p) && Number(p.column) <= 3)
        .sort((a, b) => Number(a.column) - Number(b.column));
      for (const s of suns) {
        // 换植格本身可能被向日葵占着，minePlan 只列空格；这里单独算
        // “僵尸走到这个太阳花格”的时间，并把路上所有植物的啃食时间加进去。
        const hold = (out.plants || []).filter((p) => p.lane === l.lane
          && Number(p.column) > Number(s.column) && Number(p.column) <= Number(front.column) + 0.5)
          .reduce((sum, p) => sum + (p.holdSec != null
            ? Number(p.holdSec)
            : (Number(p.hp) || 0) / (Number(front.eatDps) || 100)), 0);
        const eta = (Number(front.column) - Number(s.column)) / speed + hold;
        if (!(eta >= Number(mine.armTimeSec) + 1)) continue;
        lastResortPlan.push({
          lane: l.lane,
          replaceCell: { column: s.column, type: s.type },
          mine: mine.card,
          armTimeSec: mine.armTimeSec,
          latestSafeColumn: mine.latestSafeColumn,
          etaSec: Math.round(eta * 10) / 10,
          frontColumn: l.front.column,
          lossIn: l.lossIn,
          clearSec: l.clearSec,
          tiles: mine.tiles,
          note: `本行 clearSec ${l.clearSec}s > lossIn ${l.lossIn}s；前面的墙/植物还能拖 ${Math.round(hold)}s，把 ${s.type} @c${s.column} 换 ${mine.card}，雷约 ${Math.round(eta)}s 后到达（需 ${mine.armTimeSec}s）。`,
        });
        break;
      }
    }
    // 数据交叉校验汇总：deck 植物和场上僵尸的解析值 vs 原始字段。
    // 只在有 issue 时才带样本；正常情况下这里接近 0 成本。
    const dataChecks = { plants: 0, zombies: 0, issues: 0, samples: [] };
    const addChecks = (kind, type, checks) => {
      if (!checks || !Array.isArray(checks.issues) || !checks.issues.length) return;
      dataChecks.issues += checks.issues.length;
      for (const it of checks.issues.slice(0, 2)) {
        if (dataChecks.samples.length >= 8) break;
        dataChecks.samples.push({ kind, type, ...it });
      }
    };
    for (const type of [...new Set(out.deck || [])]) {
      let st = null;
      try { st = stats.plantStatsOf(type); } catch { st = null; }
      if (!st) continue;
      dataChecks.plants += 1;
      addChecks('plant', type, st.checks);
    }
    for (const type of [...new Set((out.zombies || []).map((z) => z.type))]) {
      let zs = null;
      try { zs = stats.zombieStatsOf(type); } catch { zs = null; }
      if (!zs) continue;
      dataChecks.zombies += 1;
      addChecks('zombie', type, zs.checks);
    }
    // 植物 × 当前僵尸的配对事实：护甲、免疫、直线遮挡、单/多目标 TTK。
    const matchupList = buildMatchups(
      out.deck || [],
      (out.zombies || []).map((z) => z.type),
      (t) => { try { return stats.plantStatsOf(t); } catch { return null; } },
      (t) => { try { return stats.zombieStatsOf(t); } catch { return null; } },
      { budgetSec: 20 },
    ).filter((m) => m && m.verdict !== 'no_damage')
      .sort((a, b) => (a.verdict === 'good' ? -1 : 0) - (b.verdict === 'good' ? -1 : 0)
        || (a.singleTtk == null ? 999 : a.singleTtk) - (b.singleTtk == null ? 999 : b.singleTtk))
      .slice(0, 10);

    out.brief = {
      leadSec: lead,
      totalDps,
      sunRate,
      wave: {
        now: waveNow, total: waveTotal,
        etaSec: waveEta == null ? null : Math.round(waveEta * 10) / 10,
        basis: waveBasis,
        flag: !!(waveFc && waveFc.flag),
        done: !!(waveTotal != null && waveNow >= waveTotal),
        residual: residual ? { count: residual.count, lanes: residual.lanes, ehp: residual.ehp } : null,
      },
      activeLanes,
      idleLanes,
      residual,
      incoming,
      pressure,
      safeLanes: out.lanes.filter((l) => !(l.gap > 0)).map((l) => l.lane),
      airRaid: airRaid.length ? { count: airRaid.length, cells: airRaid } : null,
      minePlan,
      rescuePlan: rescueTop,
      laneMath: laneCalculations,
      counterMatrix: counterCalculations,
      deckCapabilities: deckCaps.byCapability,
      cardEfficiency: cardEfficiency.length ? cardEfficiency : undefined,
      upgradePlan: upgradePlan.length ? upgradePlan : undefined,
      dataChecks: dataChecks.issues ? dataChecks : undefined,
      matchups: matchupList.length ? matchupList : undefined,
      capacityGaps: capacityGaps.length ? capacityGaps.slice(0, 3) : undefined,
      lastResortPlan: lastResortPlan.length ? lastResortPlan.slice(0, 3) : undefined,
      coverageGaps,
      tomb,
      wallPlan,
      wallRebuildPlan: wallRebuild,
      protect: protectInfo,
      // 本地算好的两个“值不值”：模型不用自己数格子/比列号
      plantFoodPlan: out.plantFoodPlan,
      activatePlan: out.activatePlan,
      aimOptions: aimOptions.length ? aimOptions : undefined,
    };

    out.latency = latency ? latency.state() : null;
    // 保护格对外统一用“带本体”的版本：坐标 + plant(type/name/hp/brief/restSec) + dead。
    // 只有坐标时，模型和复盘都会把保护目标当成空格，把失败归因到别的植物。
    out.protectCells = (protectInfo && protectInfo.cells && protectInfo.cells.length)
      ? protectInfo.cells
      : protectCellsNow;

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

    // 队列任务用来判断“是不是换关/换模式了”：不包含 phase/wave，
    // 否则开局前写的任务会在 preparing→running 的瞬间全部被判 STALE_ACTION。
    // 时间敏感由 validForSec/deadline 负责。
    out.stateVersion = versionHash([
      (out.level && (out.level.name || out.level.assetName)) || '',
      (out.prep && out.prep.mode) || '',
      (out.prep && out.prep.conveyor) ? 'conveyor' : 'normal',
    ].join('|'));

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
