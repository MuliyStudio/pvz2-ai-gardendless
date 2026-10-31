/**
 * briefing / knowledge：把"做决定需要的事实"整理给 LLM。
 *
 * 明确不返回：推荐卡组、本地建议、打法结论。卡组和打法只能由 LLM 自己给。
 */
import { worldFactOf, TAG_COUNTERS } from '../knowledge/worlds.js';
import { buildForecast } from './forecast.js';
import { coverageAudit, deckCapabilities, cardCapabilities } from './mechanics.js';
import { auditPlan } from './plan.js';

export function createBriefing({ stats, reader, planStore, levelMemory = null, version, featureList, nameOf }) {
  // 卡牌归类只用图鉴事实（家族 / 弹道 / 是否有攻击 / 是否一次性），不判断强弱。
  function roleOf(st) {
    if (!st) return 'unknown';
    const fam = String(st.family || '');
    const special = (st.special || []).join(' ') + ' ' + ((st.usage && st.usage.activation) || '');
    if (fam === 'Sun' || (st.sun && st.sun.stages)) return 'economy';
    if (/(一次性|立刻|instant)/.test(special)) return 'instant';
    if (/Defence/i.test(fam)) return 'wall';
    if (/Cold|Slow/i.test(fam)) return 'control';
    if (st.shot && st.shot.kind === 'lob') return 'lobber';
    if (st.attack && st.attack.dps) return 'shooter';
    if (st.burst && Number(st.burst.dmg) > 0) return 'burst';
    return 'support';
  }

  /** 能量豆在 lean 模式下只留决策必需的四个数。 */
  function compactFood(pf) {
    if (!pf) return null;
    return {
      kind: pf.kind, area: pf.area, radius: pf.radius, total: pf.total,
      durationSec: pf.durationSec, confidence: pf.confidence,
    };
  }

  function plantEntry(type, lean = false) {
    const st = stats.plantStatsOf(type);
    if (!st) return null;
    return {
      type,
      name: st.name,
      cost: st.cost,
      cd: st.cd,
      hp: st.hp,
      family: st.family,
      range: st.range,
      reach: st.reach,
      armTimeSec: st.armTimeSec || 0,
      // 三叶草的生效时机是硬事实：只对空中单位有效，落地后吹不走。
      timing: type === 'blover' ? '只对空中单位有效；荡索/小鬼落地后无效' : undefined,
      attack: st.attack,
      burst: st.burst || null,
      effectiveDps: st.effectiveDps || null,
      area: st.area || null,
      stepDamage: !!st.stepDamage,
      poison: st.poison || null,
      // 伤害与护甲：yes/no/unknown 三态 + 语义（normal/pierce/true/poison/drain）
      ignoresArmor: st.ignoresArmor,
      armorState: st.armorState,
      damageType: st.damageType,
      sun: st.sun,
      splash: st.splash,
      // 能量豆：kind/area/radius/total；lean 只留 4 个数
      plantFood: lean ? compactFood(st.plantFood) : st.plantFood,
      // 激活方式必须常驻：点击卡如果模型不知道要手点，等于不能用的卡
      activation: (st.usage && st.usage.activation) || 'auto',
      aim: (st.usage && st.usage.aim) || null,
      shot: st.shot,
      brief: st.brief,
      // 图鉴长文本只在 pvz_knowledge 单查时给；简报里省掉能省一大截 token
      introduction: lean ? undefined : st.introduction,
      special: st.special,
      weaknesses: lean ? undefined : st.weaknesses,
      usage: lean ? undefined : st.usage,
      props: lean ? undefined : st.props,
    };
  }

  function zombieEntry(type, lean = false) {
    const st = stats.zombieStatsOf(type);
    if (!st) return null;
    return {
      type,
      name: st.name,
      hp: st.hp,
      armorHp: st.armorHp,
      armorDetail: st.armorDetail,
      ehp: st.ehp,
      speed: st.speed,
      eatDps: st.eatDps,
      tags: st.tags,
      counters: (st.tags || [])
        .map((tag) => ({ tag, ...(TAG_COUNTERS[tag] || null) }))
        .filter((x) => x && x.text),
      behaviors: st.behaviors,
      // 怕什么 / 会放什么 / Boss：一句话 + 结构化
      immunities: st.immunities && st.immunities.length ? st.immunities : undefined,
      spawns: st.spawns && st.spawns.length ? st.spawns : undefined,
      boss: st.boss || undefined,
      behaviorText: st.behaviorText || undefined,
      brief: st.brief,
      introduction: lean ? undefined : st.introduction,
      special: st.special,
      weaknesses: st.weaknesses,
      props: lean ? undefined : st.props,
    };
  }

  function wavesOf(state) {
    const ls = state.levelScript;
    if (!ls || !Array.isArray(ls.waves)) return [];
    const flagInterval = ls.flagInterval || null;
    return ls.waves.map((w) => {
      const zombieStats = {};
      const rowsByType = {};
      for (const r of w.rowsHint || []) {
        if (!r || !r.type || !Number.isFinite(Number(r.lane))) continue;
        (rowsByType[r.type] = rowsByType[r.type] || []).push(Number(r.lane));
      }
      let ehp = 0;
      for (const [type, count] of Object.entries(w.zombies || {})) {
        const z = stats.zombieStatsOf(type);
        const e = (z && z.ehp) || null;
        const lanes = rowsByType[type] ? rowsByType[type].slice().sort((a, b) => a - b) : null;
        zombieStats[type] = {
          count, ehpEach: e, ehp: e != null ? e * count : null,
          // lanes=null 表示生成时随机行；有值就是关卡写死的固定行（0-4）。
          lanes,
        };
        if (e != null) ehp += e * count;
      }
      return {
        wave: w.n,
        flag: flagInterval ? w.n % flagInterval === 0 : false,
        total: w.total,
        ehp,
        zombies: zombieStats,
        rowsHint: w.rowsHint && w.rowsHint.length ? w.rowsHint : null,
        extraFood: w.extraFood || null,
      };
    });
  }

  function briefing() {
    const state = reader.snapshot({ full: true });
    if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason || '不在关卡内' };
    const seed = state.seedSelection;
    const pool = (seed && seed.available) || state.cards || [];
    const cards = pool.map((c) => plantEntry(c.type, true)).filter(Boolean);

    const waveList = wavesOf(state);
    const waveTypes = new Set();
    for (const w of waveList) for (const t of Object.keys(w.zombies || {})) waveTypes.add(t);
    for (const z of state.zombies || []) waveTypes.add(z.type);
    const zombies = [...waveTypes].map((z) => zombieEntry(z, true)).filter(Boolean);
    const zombieIndex = new Map(zombies.map((z) => [z.type, z]));
    const threatCounters = zombies.filter((z) => z.counters && z.counters.length).map((z) => ({
      type: z.type, name: z.name, tags: z.tags, counters: z.counters,
    }));
    for (const w of waveList) {
      for (const [type, info] of Object.entries(w.zombies)) {
        if (info.ehp == null && zombieIndex.get(type)) info.ehp = (zombieIndex.get(type).ehp || 0) * info.count;
      }
      if (!w.ehp) w.ehp = Object.values(w.zombies).reduce((s, x) => s + (x.ehp || 0), 0);
    }

    // 保护关 + 飞行单位：荡索/小鬼炮会越过前排直接落到保护格，只堆墙必输。
    const flyingThreats = zombies
      .filter((z) => Array.isArray(z.tags) && z.tags.includes('flying'))
      .map((z) => ({ type: z.type, name: z.name, brief: z.brief || null }));

    // 最早哪一波出现飞行单位：保护关要在这一波之前把每行守花位补好。
    let firstAirWave = null;
    for (const w of waveList) {
      const types = [];
      for (const [type, info] of Object.entries(w.zombies || {})) {
        const z = zombieIndex.get(type);
        if (z && Array.isArray(z.tags) && z.tags.includes('flying')) types.push(z.name || type);
      }
      if (types.length && (!firstAirWave || w.wave < firstAirWave.wave)) firstAirWave = { wave: w.wave, types };
    }

    const world = state.world || null;
    const worldMechanics = world ? world.mechanics.map((text, i) => ({ id: `${world.key}_${i}`, text, source: 'world' })) : [];
    const mechanics = [...worldMechanics, ...(state.mechanicFacts || [])].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);

    const constraints = [];
    const missionText = [].concat(state.missionHints || [], (state.objective && state.objective.missions) || []);
    if (state.plantLimit != null) constraints.push({ id: 'plant_limit', text: `本关植物上限：${state.plantLimit} 株`, source: 'objective' });
    // 保护类任务：把“够不够得着”写成硬约束，避免模型把短手植物种在花后面 2 格。
    const liveProtect = (state.protectCells || []).filter((c) => c && !c.dead);
    if (liveProtect.length) {
      const byLane = new Map();
      for (const c of liveProtect) {
        if (!byLane.has(c.lane)) byLane.set(c.lane, []);
        byLane.get(c.lane).push(c.column);
      }
      const where = [...byLane.entries()].map(([l, cols]) => `第${l}行 c${cols.slice().sort((a, b) => a - b).join('/c')}`).join('；');
      constraints.push({
        id: 'protect_cells',
        text: `${where} 是必须保护的植物。僵尸会走到这些格上啃它：短手植物（接触/接近/前后/3x3/N 格）只能种在同行、离保护格不超过它的射程（多数是 1 格）的位置；远程/整行/抛物种在保护格左侧同一行就能覆盖。种在保护格左侧 2 格以外，短手既打不到僵尸也保护不到。`,
        source: 'task',
      });
    }
    if (liveProtect.length && flyingThreats.length) {
      const names = flyingThreats.map((z) => z.name || z.type).join('、');
      const when = firstAirWave ? `最早第 ${firstAirWave.wave} 波（${firstAirWave.types.join('、')}）` : '本关';
      constraints.push({
        id: 'protect_air',
        text: `本关有飞行单位（${names}）：它们会越过前排直接落到保护格上，墙/地刺/花生都拦不住。${when}出现；在这一波之前，每一行保护格旁边（射程 1 格内）必须有菜问/近战或对空手段，这个优先级高于继续铺经济。三叶草只在它们还在空中时有效，已经落在花上啃咬时吹不走；落地后改用菜问/樱桃。只在保护格前面堆墙必输。`,
        source: 'task',
      });
    }
    const protNow = state.brief && state.brief.protect;
    if (protNow && Array.isArray(protNow.unguardedLanes) && protNow.unguardedLanes.length) {
      constraints.push({
        id: 'protect_unguarded',
        text: `第 ${protNow.unguardedLanes.map((l) => l + 1).join('/')} 行的保护格还没有墙/近战守花。下一波前优先补这些行（墙放 c${protNow.cells && protNow.cells[0] ? protNow.cells[0].frontColumn : 4}，近战放保护格左右 1 格），优先级高于继续铺经济。`,
        source: 'task',
      });
    }
    const airRaid = (state.brief && state.brief.airRaid) || null;
    if (airRaid) {
      constraints.push({
        id: 'air_raid',
        text: `现在有 ${airRaid.count} 个空中目标（${airRaid.cells.map((z) => `第${z.lane + 1}行 ${z.name || z.type} c${z.column}`).join('；')}）。三叶草只在这个窗口有效，立刻用；一旦落地就改菜问/樱桃。`,
        source: 'task',
      });
    }
    const tombNow = state.brief && state.brief.tomb;
    if (tombNow && Array.isArray(tombNow.lanes) && tombNow.lanes.length) {
      constraints.push({
        id: 'tomb_lanes',
        text: `墓碑只影响这些行的直线弹道：${tombNow.lanes.map((x) => `第${x.lane + 1}行 c${x.columns.join('/c')}`).join('；')}。其余行（${tombNow.unblockedLanes.map((l) => l + 1).join('/') || '无'}）没有墓碑，可以正常用豌豆/直线输出；不要因为本关有墓碑就全关只用投手。`,
        source: 'terrain',
      });
    }
    for (const t of state.tasks || []) {
      constraints.push({ id: `task_${t.key}`, text: t.tip + (t.hint ? `（${t.hint}）` : ''), source: 'task' });
    }
    if (threatCounters.length) {
      constraints.push({
        id: 'threat_counters',
        text: threatCounters.map((z) => `${z.name || z.type}（${z.tags.join('/')}）：${z.counters.map((c) => c.text).join('；')}`).join(' | '),
        source: 'knowledge',
      });
    }
    // 准备模式：同一套 prompt 要能覆盖普通选卡、提前布阵、传送带、给定卡组。
    const prep = state.prep || null;
    if (prep) {
      if (prep.mode === 'preplant') {
        constraints.push({
          id: 'preplant',
          text: `提前布阵关：波次还没开始，但已经可以种植物。先用给定阳光把阵型摆好；准备好后调用 pvz_start_level 开打（现在 canStart=${prep.canStart}）。不要一直种下去不等开始，也不要在开打前反复读状态。`,
          source: 'prep',
        });
      } else if (prep.mode === 'conveyor') {
        constraints.push({
          id: 'conveyor',
          text: '传送带关：卡组由传送带给定，不能选卡也不能改卡组，直接 pvz_start_level 开打；之后每轮看 cards 里当前可用的传送带卡，种完等下一张。',
          source: 'prep',
        });
      }
      if (prep.deckLocked && prep.mode !== 'conveyor') {
        constraints.push({
          id: 'forced_deck',
          text: `本关卡组是给定的（锁定 ${prep.lockedCount}/${prep.slots} 张，可选 ${prep.availableCount} 张）：不要尝试换卡；卡组已满就直接 pvz_start_level。choose_deck 会原样返回 actualDeck。`,
          source: 'prep',
        });
      }
    }
    if (state.levelScript && state.levelScript.lawn && state.levelScript.lawn.isAtNight) {
      constraints.push({ id: 'night', text: '夜间：没有天空掉落阳光', source: 'lawn' });
    }
    if (world) constraints.push({ id: 'world', text: `世界：${world.name}`, source: 'world' });

    const plan = planStore.getPlan();
    // 卡组结构事实：只数「有几张能干什么」，不写该不该带。
    const deckTypes = (seed && seed.current) || state.deck || [];
    const coverage = { economy: 0, shooter: 0, lobber: 0, wall: 0, instant: 0, control: 0, support: 0 };
    for (const t of deckTypes) {
      const st = stats.plantStatsOf(t);
      coverage[roleOf(st)] += 1;
    }
    const plantStats = (t) => {
      try { return stats.plantStatsOf(t); } catch { return null; }
    };
    // 整关 tag 集合：所有波次出现过的僵尸 + 场上僵尸。新增僵尸只加 tag 规则，不改这里。
    const levelTags = new Set();
    for (const z of zombies) for (const tag of z.tags || []) levelTags.add(tag);
    for (const z of state.zombies || []) {
      let zs = null;
      try { zs = stats.zombieStatsOf(z.type); } catch { zs = null; }
      for (const tag of (zs && zs.tags) || []) levelTags.add(tag);
    }
    const poolTypes = cards.map((c) => c.type);
    // 能力审计：tag → 需要什么能力 → 卡组有没有 → 卡池里谁能补（只给事实）。
    const capAudit = coverageAudit({
      tags: [...levelTags],
      deck: deckTypes,
      plantStatsOf: plantStats,
      pool: poolTypes,
    });
    const deckCaps = deckCapabilities({ deck: deckTypes, plantStatsOf: plantStats });
    // 兼容旧读法：逐僵尸类型的 missingTags（由 counterMatrix 同源规则算）。
    const counterGaps = threatCounters.map((tc) => {
      const required = [...new Set(tc.counters.flatMap((c) => c.plants || []))];
      const present = required.filter((p) => deckTypes.includes(p));
      return {
        type: tc.type,
        name: tc.name,
        tags: tc.tags,
        requiredPlants: required,
        presentPlants: present,
        missing: required.length > 0 && present.length === 0,
      };
    }).filter((x) => x.requiredPlants.length);
    const missingCounters = counterGaps.filter((x) => x.missing);
    if (capAudit.missing.length) {
      constraints.push({
        id: 'capability_gaps',
        text: '整关能力缺口：' + capAudit.missing.map((m) => `${m.name}（${(m.alternatives || [m.capability]).join('/')}，来自 ${m.tags.join('/')}）${m.candidates.length ? `可补 ${m.candidates.join('/')}` : '卡池里没有直接对应的卡，需要写替代方案'}`).join('；') + '。这些能力按本关所有波次的 tag 汇总，不是只看当前波。',
        source: 'knowledge',
      });
    }
    if (missingCounters.length) {
      constraints.push({
        id: 'counter_gaps',
        text: missingCounters.map((x) => `${x.name || x.type}（${x.tags.join('/')}）需要 ${x.requiredPlants.join('/')}，当前卡组没有`).join('；') + '。开局前补齐，或用你确认有效的替代方案写进计划。',
        source: 'knowledge',
      });
    }
    // 计划审计：缺能力却没写 counter、卡组和实际不一致、只有一段文本 → 要求重写。
    const planAudit = plan && plan.plan ? auditPlan(plan.plan, { coverageGaps: capAudit, deck: deckTypes }) : null;
    if (planAudit && planAudit.warnings.length) {
      constraints.push({
        id: 'plan_audit',
        text: '你记录的计划和本关事实对不上：' + planAudit.warnings.map((w) => w.reason).join('；') + '。用 pvz_set_plan 重写计划（保留 text，补 lanes/counters/phases/triggers）。',
        source: 'plan',
      });
    }

    // 关卡预测：每波确定/随机、动态规则、以及动态部分的生成结果或期望
    const forecast = buildForecast(state.levelScript, stats, {});

    // 本关历史（localStorage，跨局保留）：不管输赢，开局先读，结束再写。
    const levelKey = levelMemory ? levelMemory.keyOf(state) : null;
    const mem = levelMemory && levelKey ? levelMemory.get(levelKey) : null;
    const history = mem ? {
      key: levelKey,
      note: mem.note || null,
      lessons: Array.isArray(mem.lessons) ? mem.lessons.slice(0, 6) : [],
      lastResult: mem.runs && mem.runs[0] ? mem.runs[0].result : null,
      runs: (mem.runs || []).slice(0, 2).map((r) => ({
        at: r.at, result: r.result, wave: r.wave, waveCount: r.waveCount,
        durationSec: r.durationSec, deck: r.deck, facts: r.facts, note: r.note,
        review: r.review || null,
      })),
    } : null;

    // 卡池数值事实（按 DPS / 产阳光排序，只是排序，不是推荐）
    const dpsTop = cards
      .filter((c) => c.attack && c.attack.dps)
      .sort((a, b) => b.attack.dps - a.attack.dps)
      .slice(0, 6)
      .map((c) => ({ type: c.type, name: c.name, cost: c.cost, dps: c.attack.dps, range: c.range, kind: c.shot ? c.shot.kind : null }));
    const economyTop = cards
      .filter((c) => c.sun && c.sun.perSecDay && c.sun.perSecDay.length)
      .sort((a, b) => b.sun.perSecDay[b.sun.perSecDay.length - 1] - a.sun.perSecDay[a.sun.perSecDay.length - 1])
      .slice(0, 5)
      .map((c) => {
        const idx = c.sun.perSecDay.length - 1;
        return { type: c.type, name: c.name, cost: c.cost, sunPerSec: c.sun.perSecDay[idx], paybackSec: c.sun.paybackSec };
      });
    const multiDpsTop = cards
      .filter((c) => c.attack && c.attack.targets > 1 && c.attack.multiDps)
      .sort((a, b) => b.attack.multiDps - a.attack.multiDps)
      .slice(0, 5)
      .map((c) => ({
        type: c.type, name: c.name, cost: c.cost, dps: c.attack.dps,
        targets: c.attack.targets, hitsPerTarget: c.attack.hitsPerTarget,
        multiDps: c.attack.multiDps, pierceCount: c.attack.pierceCount,
      }));
    const costs = cards.map((c) => c.cost).filter((v) => v != null);
    const poolFacts = {
      size: cards.length,
      costMin: costs.length ? Math.min(...costs) : null,
      costMax: costs.length ? Math.max(...costs) : null,
      costAvg: costs.length ? Math.round(costs.reduce((s, v) => s + v, 0) / costs.length) : null,
      dpsTop,
      multiDpsTop,
      economyTop,
      instantCount: cards.filter((c) => {
        const st = plantStats(c.type);
        return !!(st && st.usage && /instant|一次性/.test(String(st.usage.activation)));
      }).length,
      lobberCount: cards.filter((c) => c.shot && c.shot.kind === 'lob').length,
      noAttackCount: cards.filter((c) => !c.attack || !c.attack.dps).length,
    };
    const presets = (state.levelScript && state.levelScript.seedBank && state.levelScript.seedBank.presets) || [];

    // 整关上下文（一次看全）：世界/地形摘要 + 逐波类型 + 全部僵尸索引 + 卡池能力 + 卡组缺口 + 历史。
    // 详细字段仍在上面的顶层（waves/zombies/cards/terrain），这里只做“索引 + 能力”，避免重复长文本。
    const cardIndex = cards.map((c) => ({
      type: c.type,
      name: c.name,
      cost: c.cost,
      cd: c.cd,
      hp: c.hp,
      family: c.family,
      reach: c.reach,
      armTimeSec: c.armTimeSec,
      dps: c.attack ? c.attack.dps : null,
      effectiveDps: c.effectiveDps || null,
      targets: c.attack ? c.attack.targets : null,
      pierceCount: c.attack ? c.attack.pierceCount : null,
      multiDps: c.attack ? c.attack.multiDps : null,
      ignoresArmor: !!(c.attack && c.attack.ignoresArmor) || !!c.ignoresArmor,
      poison: c.poison || null,
      stepDamage: !!c.stepDamage,
      kind: c.shot ? c.shot.kind : null,
      capabilities: deckCaps.byCard[c.type] || cardCapabilities(c.type, plantStats(c.type)),
    }));
    const waveIndex = waveList.map((w) => ({
      wave: w.wave,
      flag: w.flag,
      total: w.total,
      ehp: w.ehp,
      zombies: Object.fromEntries(Object.entries(w.zombies).map(([t, v]) => [t, v.count])),
      lanes: Object.fromEntries(Object.entries(w.zombies)
        .filter(([, v]) => v.lanes)
        .map(([t, v]) => [t, v.lanes])),
      randomRows: Object.entries(w.zombies).filter(([, v]) => !v.lanes).map(([t]) => t),
    }));
    const obstacleTypes = [...new Set((state.obstacles || []).map((o) => o && o.type).filter(Boolean))];
    const levelContext = {
      world: world ? { key: world.key, name: world.name, mechanics: world.mechanics } : null,
      terrain: {
        lanes: state.terrain ? state.terrain.lanes : 0,
        columns: state.terrain ? state.terrain.columns : 0,
        map: state.terrain ? state.terrain.map : [],
        obstacleTypes,
        blockedCells: (state.blockedCells || []).length,
        protectCells: state.protectCells || [],
      },
      waves: waveIndex,
      zombies: zombies.map((z) => ({
        type: z.type, name: z.name, ehp: z.ehp, speed: z.speed, eatDps: z.eatDps,
        tags: z.tags, counters: (z.counters || []).map((c) => c.text),
        special: (z.special || []).slice(0, 4), behaviors: z.behaviors || null,
      })),
      cards: cardIndex,
      deck: {
        slots: seed ? seed.slots : (state.cards || []).length,
        current: deckTypes,
        capabilities: deckCaps.byCapability,
        gaps: capAudit.missing,
      },
      history: history ? { key: history.key, note: history.note, lessons: history.lessons, lastResult: history.lastResult } : null,
      facts: {
        totalWaveEhp: waveList.reduce((s, w) => s + (w.ehp || 0), 0),
        tags: capAudit.tags,
        requiredCapabilities: capAudit.required,
      },
    };

    return {
      ok: true,
      version,
      phase: state.phase,
      scene: state.scene,
      objective: state.objective,
      missionHints: state.missionHints,
      levelContext,
      level: {
        name: state.level.name || null,
        asset: (state.level.source && state.level.source.asset) || null,
        wave: state.level.wave,
        waves: state.level.waves,
        nextWaveIn: state.level.nextWaveIn,
        source: state.level.source,
        world: world ? { key: world.key, name: world.name } : null,
      },
      world: world ? { key: world.key, name: world.name, mechanics: world.mechanics, zombies: world.zombies } : null,
      terrain: {
        lanes: state.terrain ? state.terrain.lanes : 0,
        columns: state.terrain ? state.terrain.columns : 0,
        map: state.terrain ? state.terrain.map : [],
        squareTypes: state.terrain ? state.terrain.squareTypes : [],
        legend: state.terrain ? state.terrain.legend : {},
        blockedCells: state.blockedCells || [],
        plantable: state.plantable || [],
        obstacles: state.obstacles || [],
        protectCells: state.protectCells || [],
      },
      waves: waveList,
      zombies,
      threatCounters,
      cards,
      deck: {
        slots: seed ? seed.slots : (state.cards || []).length,
        current: seed ? seed.current : (state.deck || []),
        gameStartable: seed ? seed.gameStartable : null,
        coverage,
        capabilities: deckCaps.byCapability,
        counterGaps,
        coverageGaps: capAudit,
        presets,
        poolFacts,
      },
      startingSun: state.startingSun,
      plantLimit: state.plantLimit,
      prep,
      airRaid,
      minePlan: (state.brief && state.brief.minePlan) || null,
      laneMath: (state.brief && state.brief.laneMath) || null,
      counterMatrix: (state.brief && state.brief.counterMatrix) || null,
      coverageGaps: capAudit,
      deckCapabilities: deckCaps.byCapability,
      tomb: (state.brief && state.brief.tomb) || null,
      wallPlan: (state.brief && state.brief.wallPlan) || null,
      wallRebuildPlan: (state.brief && state.brief.wallRebuildPlan) || null,
      protect: (state.brief && state.brief.protect)
        ? { ...state.brief.protect, airThreats: flyingThreats.map((z) => z.type) }
        : (liveProtect.length && flyingThreats.length ? { airThreats: flyingThreats.map((z) => z.type) } : null),
      constraints,
      mechanics,
      forecast,
      history,
      plan: plan ? plan.plan : null,
      planSavedAt: plan ? plan.savedAt : null,
      planAudit,
      facts: {
        sun: state.sun,
        plantFood: state.plantFood,
        // 豆上限是硬机制：满了再掉豆就浪费，模型必须知道
        plantFoodMax: state.plantFoodMax,
        plantFoodFull: state.plantFoodFull,
        plantFoodUseful: state.plantFoodUseful,
        plantsOnLawn: (state.plants || []).length,
        zombiesOnLawn: (state.zombies || []).length,
        totalWaveEhp: waveList.reduce((s, w) => s + (w.ehp || 0), 0),
        missionText,
      },
      notes: [
        '这是事实清单：没有推荐卡组，也没有本地打法。选卡、每行职责、阈值都由你决定。',
        'stats 里的 ehp = 本体血量 + 全部护甲；dps = 伤害 / 攻击间隔。',
        'levelContext 是整关的一次性索引：世界/地形摘要、逐波类型与固定行、全部僵尸 tag、卡池能力、卡组缺口、历史。详细数值看 waves/zombies/cards；开局读一次就够。',
        'poolFacts.multiDpsTop 是多目标/穿透卡的有效群体 DPS（targets × hitsPerTarget），和单目标 dps 分开看；例如回旋镖 7.4 单体 / 44.4 三目标。',
        'threatCounters 是僵尸标签对应的机制克制关系（例如 rolling 会被地刺扎破、墙挡不住；flying 只有三叶草在空中有效）。它是事实，不是卡组推荐；选卡和计划要覆盖本关出现的 tags。',
        'coverageGaps / deck.capabilities 按“能力”算：group→multi_target、rolling→anti_rolling、flying→anti_air、armored→high_dps、crush/gargantuar→control/burst。missing 非空就是卡组缺这项能力，candidates 是卡池里能满足它的卡（事实，不是推荐）。',
        'deck.counterGaps 是逐僵尸类型的旧读法：missing=true 表示卡组里一个对应卡都没有。',
        'plantable 只排除已占格、障碍格、水面/天空；特殊卡（睡莲等）的落点仍要按卡牌说明判断。',
        'plantLimit 为 null 就是本关没有植物数量上限；不要从任务原文、图鉴或以往关卡推断上限。objective.trusted=false 表示只是未初始化的模板，missions 已清空。',
        'forecast 是逐波的确定信息：带 lanes 的僵尸是写死的行，lanes=null 的生成时随机行；dynamic.mode=generated 表示本局动态僵尸已经生成（dynamicCount 是随机追加的数量），estimated 表示还没生成、estimate 是模拟期望。',
        'history 是这一关以前的结果记录（含用过的卡组、打到第几波、计划、备注）。它来自你的上一局，不是系统建议；开局先看它，结束时系统会自动把本局结果写回去。history.lessons 是以前（含自动复盘）写下的可执行经验，优先读。',
        'prep 是准备模式：mode=normal 正常选卡；preplant 提前布阵（先种，再 pvz_start_level）；conveyor 传送带（不能选卡）；forced_deck 卡组已给定/锁定（不要换卡，直接开局）。',
        ...(state.objective && state.objective.trusted === false
          ? ['本关没有下发任务文本（objective 是模板），tasks 为空就按普通关卡打。']
          : []),
      ],
    };
  }

  function normalizeQuery(args) {
    const a = args || {};
    const type = a.type || a.id || a.codename || a.name || null;
    return {
      type: type == null ? null : String(type),
      kind: a.kind ? String(a.kind) : null,
      query: a.query ? String(a.query) : null,
    };
  }

  function search(q, kind) {
    const text = q.toLowerCase();
    const out = [];
    const kinds = kind ? [kind] : ['plant', 'zombie'];
    for (const k of kinds) {
      for (const f of featureList(k)) {
        const code = String(f.CODENAME || '');
        if (!code) continue;
        const name = f.NAME || {};
        const almanac = k === 'plant' ? stats.plantStatsOf(code) : stats.zombieStatsOf(code);
        const hay = [code, name.zh, name.en, almanac && almanac.brief, almanac && almanac.introduction,
          ...((almanac && almanac.special) || [])].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(text)) continue;
        out.push({
          kind: k,
          type: code,
          name: name.zh || code,
          nameEn: name.en || null,
          cost: almanac && almanac.cost,
          hp: almanac && almanac.hp,
          ehp: almanac && almanac.ehp,
          brief: almanac && almanac.brief,
          score: (code === text ? 100 : 0) + (String(name.zh || '').includes(q) ? 50 : 0) + 1,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...x }) => x);
  }

  function knowledge(args) {
    const { type, kind, query } = normalizeQuery(args);
    if (kind && !['plant', 'zombie', 'level'].includes(kind)) {
      return { ok: false, code: 'BAD_QUERY', reason: 'kind 只能是 plant / zombie / level' };
    }
    if (kind === 'level') {
      const state = reader.snapshot({ full: true });
      if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason };
      return {
        ok: true,
        kind: 'level',
        entry: {
          name: state.level.name || null,
          wave: state.level.wave,
          waves: state.level.waves,
          source: state.level.source,
          world: state.world,
          objective: state.objective,
          missionHints: state.missionHints,
          tasks: state.tasks,
          terrain: state.terrain,
          zombieStats: state.zombieStats,
          levelScript: state.levelScript,
        },
      };
    }
    if (query && !type) {
      const matches = search(query, kind);
      return {
        ok: true,
        query,
        matches,
        hint: matches.length ? '用 type 再查一次可拿完整图鉴与数值。' : '没有匹配项；可以换 codename 或中文名。',
      };
    }
    if (!type) {
      return {
        ok: false,
        code: 'BAD_QUERY',
        reason: '需要 type（codename）或 query（中文/英文关键词）',
        examples: [
          { type: 'sunshroom' },
          { type: 'pirate_armor1' },
          { query: '海盗 水 僵尸' },
        ],
      };
    }
    const t = type.trim();
    if (kind === 'plant' || (!kind && stats.plantStatsOf(t))) {
      const entry = plantEntry(t);
      if (entry) {
        if (t === 'blover') entry.timing = '只对空中单位有效；荡索/小鬼落地后无效';
        return { ok: true, kind: 'plant', entry };
      }
    }
    if (kind === 'zombie' || (!kind && stats.zombieStatsOf(t))) {
      const entry = zombieEntry(t);
      if (entry) return { ok: true, kind: 'zombie', entry };
    }
    if ((!kind || kind === 'level') && (t === 'level' || t === '本关')) {
      const state = reader.snapshot({ full: true });
      if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason };
      return {
        ok: true,
        kind: 'level',
        entry: {
          name: state.level.name || null,
          wave: state.level.wave,
          waves: state.level.waves,
          source: state.level.source,
          world: state.world,
          objective: state.objective,
          missionHints: state.missionHints,
          tasks: state.tasks,
          terrain: state.terrain,
          zombieStats: state.zombieStats,
          levelScript: state.levelScript,
        },
      };
    }
    const matches = search(t, kind);
    return {
      ok: false,
      code: 'KNOWLEDGE_NOT_FOUND',
      reason: `没有找到 ${t}`,
      matches,
      hint: '从 matches 里选一个 codename 再查。',
    };
  }

  function fieldGuide() {
    return {
      plants: featureList('plant').map((f) => ({ type: f.CODENAME, name: (f.NAME && f.NAME.zh) || f.CODENAME, en: (f.NAME && f.NAME.en) || null })),
      zombies: featureList('zombie').map((f) => ({ type: f.CODENAME, name: (f.NAME && f.NAME.zh) || f.CODENAME, en: (f.NAME && f.NAME.en) || null })),
    };
  }

  function worldOf(text) {
    return worldFactOf(text);
  }

  return { briefing, knowledge, plantEntry, zombieEntry, fieldGuide, worldOf };
}
