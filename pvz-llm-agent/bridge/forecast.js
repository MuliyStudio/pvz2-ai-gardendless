/**
 * forecast：把「关卡波次表」折成可验算的预测。
 *
 * 两种波：
 *  - 静态波：关卡 JSON 里写死，僵尸数量和类型每局相同；写死的 Row 固定，没写 Row 的生成时随机行。
 *  - 动态波：引擎在关卡初始化时按 DynamicZombies 规则用点数+权重随机生成，然后并进对应波次。
 *    规则 = StartingPoints + PointIncrementPerWave × (波次-1-StartingWave)，旗帜波再 ×2.5；
 *    每次按 Weight 抽一只、扣它的 WavePointCost，点数不够就换（并把买不起的类型从池子里移除）。
 *
 * 这里只算数字：每波的僵尸/血量、静态与动态各多少、动态池子与预算、以及（还没生成时）
 * 500 次模拟的期望出现概率。不写"该怎么打"，也不推荐卡组。
 */

/** 可复现的 PRNG（同一关卡同一参数 → 同一份预测）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COST_DEFAULT = 100;

function poolFacts(pool, stats) {
  const out = [];
  for (const type of pool || []) {
    const st = stats.zombieStatsOf(type);
    const cost = (st && st.wavePointCost != null) ? st.wavePointCost : COST_DEFAULT;
    const weight = (st && st.weight != null && st.weight > 0) ? st.weight : 1000;
    out.push({ type, cost, weight, ehp: st ? st.ehp : null, name: st ? st.name : type });
  }
  return out;
}

/** 单波动态预算（与引擎 generateDynamicZombieSpawnWaves 的算式一致） */
function budgetOf(rule, waveNumber, flagInterval) {
  const zeroBased = waveNumber - 1;
  if (rule.startingWave != null && rule.startingWave > zeroBased) return 0;
  let budget = (rule.startingPoints || 0) + (rule.pointIncrement || 0) * (zeroBased - (rule.startingWave || 0));
  if (flagInterval && waveNumber % flagInterval === 0) budget *= 2.5;
  return Math.max(0, Math.round(budget));
}

/** 单次按引擎逻辑抽一轮（只用于期望值，不是本局结果） */
function drawOnce(pool, budget, rnd) {
  const counts = {};
  let list = pool.filter((p) => p.cost <= budget);
  let remaining = budget;
  let min = list.reduce((m, p) => Math.min(m, p.cost), Infinity);
  while (list.length && remaining >= min) {
    let total = 0;
    for (const p of list) total += p.weight;
    let pick = rnd() * total;
    let hit = list[list.length - 1];
    for (const p of list) {
      if (pick < p.weight) { hit = p; break; }
      pick -= p.weight;
    }
    if (hit.cost <= remaining) {
      counts[hit.type] = (counts[hit.type] || 0) + 1;
      remaining -= hit.cost;
    } else {
      list = list.filter((p) => p !== hit);
      min = list.reduce((m, p) => Math.min(m, p.cost), Infinity);
    }
  }
  return counts;
}

function estimateWave(pool, budget, samples, seed) {
  if (!pool.length || budget <= 0) return null;
  const rnd = mulberry32(seed);
  const appear = {};
  const total = {};
  let zero = 0;
  for (let i = 0; i < samples; i++) {
    const c = drawOnce(pool, budget, rnd);
    const keys = Object.keys(c);
    if (!keys.length) zero += 1;
    for (const [t, n] of Object.entries(c)) {
      appear[t] = (appear[t] || 0) + 1;
      total[t] = (total[t] || 0) + n;
    }
  }
  const out = {};
  for (const t of Object.keys(appear)) {
    out[t] = {
      p: Math.round((appear[t] / samples) * 1000) / 1000,
      expected: Math.round((total[t] / samples) * 100) / 100,
    };
  }
  return { samples, pNone: Math.round((zero / samples) * 1000) / 1000, zombies: out };
}

const forecastCache = new WeakMap();

/**
 * @param {object} script   stats.levelScriptOf(lvl) 的结果
 * @param {object} stats    stats reader（zombieStatsOf）
 * @param {object} [opts]   { currentWave, samples }
 */
export function buildForecast(script, stats, opts) {
  if (!script || !Array.isArray(script.waves) || !script.waves.length) return null;
  const options = opts || {};
  const samples = Math.max(50, Math.min(2000, Number(options.samples) || 400));
  const cacheKey = `${samples}`;
  const cached = forecastCache.get(script);
  if (cached && cached.key === cacheKey) return cached.value;

  const flagInterval = script.flagInterval || null;
  const dyn = script.dynamic || {};
  const rule = dyn.rule || null;
  const flagWaves = (n) => !!(flagInterval && n % flagInterval === 0);

  // 本局是否已经能看到"动态追加"的结果（关卡初始化时就会写进波次列表）
  const hasGenerated = script.waves.some((w) => w.dynamicExtra && Object.keys(w.dynamicExtra).length > 0)
    || script.waves.some((w) => w.dynamicZombies && Object.keys(w.dynamicZombies).length > 0);

  const pool = rule ? poolFacts(rule.pool, stats) : [];
  const waveBudgets = {};
  if (rule) for (const w of script.waves) waveBudgets[w.n] = budgetOf(rule, w.n, flagInterval);

  const zombies = {};
  let totalZombies = 0;
  let totalEhp = 0;
  const waves = [];
  const seenTypes = new Set();

  for (const w of script.waves) {
    const entry = {
      wave: w.n,
      flag: flagWaves(w.n),
      total: w.total || 0,
      ehp: 0,
      zombies: {},
      firstWaveTypes: [],
      extraFood: w.extraFood || null,
      dynamicCount: 0,
    };
    for (const [type, count] of Object.entries(w.zombies || {})) {
      const st = stats.zombieStatsOf(type);
      const each = st && st.ehp != null ? st.ehp : null;
      const extra = (w.dynamicExtra && w.dynamicExtra[type]) || 0;
      entry.dynamicCount += extra;
      const fixedLanes = (w.rowsHint || []).filter((r) => r.type === type).map((r) => r.lane);
      entry.zombies[type] = {
        count,
        ehp: each,
        ehpTotal: each != null ? each * count : null,
        lanes: fixedLanes.length ? fixedLanes : null,
        dynamicCount: extra || null,
      };
      if (each != null) entry.ehp += each * count;
      if (!seenTypes.has(type)) entry.firstWaveTypes.push(type);
      const agg = zombies[type] || { count: 0, ehp: 0, name: st ? st.name : type, ehpEach: each };
      agg.count += count;
      if (each != null) agg.ehp += each * count;
      zombies[type] = agg;
      totalZombies += count;
      if (each != null) totalEhp += each * count;
      seenTypes.add(type);
    }
    // 动态规则存在但本局还没生成 → 给期望值
    if (rule && !hasGenerated && waveBudgets[w.n] > 0) {
      entry.estimate = estimateWave(pool, waveBudgets[w.n], samples, 7919 * w.n + (script.waveCount || 0));
      entry.dynamicBudget = waveBudgets[w.n];
    } else if (rule && hasGenerated) {
      entry.dynamicBudget = waveBudgets[w.n] || 0;
    }
    waves.push(entry);
  }

  const byType = Object.entries(zombies)
    .map(([type, v]) => ({
      type, name: v.name, count: v.count, ehpEach: v.ehpEach, ehp: v.ehp,
      share: totalEhp ? Math.round((v.ehp / totalEhp) * 1000) / 1000 : null,
    }))
    .sort((a, b) => b.ehp - a.ehp);

  const value = {
    ok: true,
    source: script.assetName || null,
    waveCount: script.waveCount || waves.length,
    flagInterval,
    firstWaveSecs: (script.manager && script.manager.firstWaveSecs) || null,
    hugeWaveDelay: (script.manager && script.manager.hugeWaveDelay) || null,
    waves,
    totals: { zombies: totalZombies, ehp: totalEhp, byType },
    dynamic: {
      active: !!rule,
      mode: hasGenerated ? 'generated' : (rule ? 'estimated' : 'none'),
      difficulty: dyn.difficulty != null ? dyn.difficulty : null,
      rule: rule ? {
        startingWave: rule.startingWave,
        startingPoints: rule.startingPoints,
        pointIncrement: rule.pointIncrement,
        pool: pool,
      } : null,
      budgets: rule ? waveBudgets : null,
    },
    notes: [
      '静态波：类型和数量每局固定；带 lanes 的是写死的行，lanes=null 的生成时随机行。',
      '动态波：按点数预算先从池子里按权重抽，抽到的扣 WavePointCost；旗帜波预算 ×2.5。',
      hasGenerated
        ? 'dynamic.mode=generated：本局动态僵尸已经在波次表里（dynamicCount 就是这一波随机追加的数量），结果已确定。'
        : (rule ? 'dynamic.mode=estimated：动态部分还没生成，estimate 是模拟期望（p=出现概率），不是本局结果。' : '本关在这一难度没有动态波。'),
    ],
  };
  forecastCache.set(script, { key: cacheKey, value });
  return value;
}

/** 给 pvz_state 用的薄片：当前波 + 之后 N 波，字段尽量小。 */
export function nextWaves(forecast, currentWave, count) {
  if (!forecast || !Array.isArray(forecast.waves)) return null;
  const from = Math.max(1, Number(currentWave) || 1);
  const n = Math.max(1, Math.min(6, Number(count) || 3));
  const list = forecast.waves.filter((w) => w.wave >= from).slice(0, n).map((w) => ({
    wave: w.wave,
    flag: w.flag || undefined,
    total: w.total,
    ehp: Math.round(w.ehp || 0),
    zombies: Object.entries(w.zombies).map(([type, v]) => (v.count > 1 ? `${type}x${v.count}` : type)),
    newTypes: w.firstWaveTypes && w.firstWaveTypes.length ? w.firstWaveTypes : undefined,
    dynamicCount: w.dynamicCount || undefined,
  }));
  return list.length ? list : null;
}
