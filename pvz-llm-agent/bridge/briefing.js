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
      kind: pf.kind, area: pf.area, radius: pf.radius,
      total: pf.total, totalPerTarget: pf.totalPerTarget, maxTotal: pf.maxTotal,
      sunTotal: pf.sunTotal, sunValue: pf.sunValue,
      count: pf.count, projectileDamage: pf.projectileDamage,
      targetsPerHit: pf.targetsPerHit, hitsPerTarget: pf.hitsPerTarget,
      durationSec: pf.durationSec, confidence: pf.confidence,
      assumptions: pf.assumptions,
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
      // 短射程输出（reach<=1 且有伤害）必须贴住僵尸，不能当后排墙用。
      role: (st.reach != null && Number(st.reach) <= 1 && ((st.attack && Number(st.attack.dps) > 0) || st.burst))
        ? 'melee_output'
        : (String(st.family || '') === 'Defence' ? 'wall'
          : (st.sun ? 'economy' : (st.attack ? 'ranged' : 'support'))),
      needsContact: (st.reach != null && Number(st.reach) <= 1 && !!((st.attack && Number(st.attack.dps) > 0) || st.burst)) || undefined,
      // once = 触发一次、持续几秒；repeat = 按 interval 反复打。
      trigger: (st.attack && st.attack.trigger) || undefined,
      repeatAttack: st.attack ? !!st.attack.repeat : undefined,
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
      // 放置类别：游戏 TAGS 原样上报（amphibious / fly / vine / lilypad …）
      placement: st.placement || null,
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
      // 血量阈值阶段：巨人扔小鬼 / 狂暴 / 掉手 / 放鸡 / 放黄鼠狼
      phases: st.phases && st.phases.length ? st.phases : undefined,
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
    const levelNow = state.level || {};
    const sourceNow = levelNow.source || {};
    // 页面过渡/回地图时可能返回 ok 但关卡、世界、波次全空；不要给模型一份“空简报”。
    const hasLevel = !!((sourceNow.asset || sourceNow.world || sourceNow.levelId)
      || levelNow.name || state.world || state.levelScript);
    if (!hasLevel) {
      return {
        ok: false,
        code: 'BRIEFING_NOT_READY',
        retry: true,
        reason: '关卡数据还没加载完（可能是关卡切换/回地图的过渡帧），稍后再读一次。',
      };
    }
    const seed = state.seedSelection;
    const pool = (seed && seed.available) || state.cards || [];
    const cards = pool.map((c) => plantEntry(c.type, true)).filter(Boolean);

    const waveList = wavesOf(state);
    // 过渡帧里 Level.name 还在（asset=egypt1），但波次/卡池全空——这不是有效简报。
    // 以前这种骨架会被当成事实喂给模型（卡槽 undefined / 起始阳光 ? / 波次 0），
    // 模型再转手去读一次，形成“反复读开局简报”的循环。
    const dataReady = !!(state.level && state.level.gameStarted)
      || waveList.length > 0
      || (state.cards || []).length > 0
      || ((state.seedSelection && state.seedSelection.available) || []).length > 0;
    if (!dataReady) {
      return {
        ok: false,
        code: 'BRIEFING_NOT_READY',
        retry: true,
        reason: '关卡/卡槽还在加载（波次和卡池都为空），稍后再读一次。',
      };
    }
    if (!waveList.length && state.phase === 'objective') {
      return {
        ok: false,
        code: 'BRIEFING_NOT_READY',
        retry: true,
        reason: '关卡波次还没初始化（objective 阶段常见），关闭目标弹窗进入准备后再读。',
      };
    }
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
      // 保护目标是谁也要写清：只有坐标时，模型会把它当空格，失败后把锅甩给向日葵。
      const protectTypes = [...new Set(liveProtect
        .map((c) => (c.plant && (c.plant.name || c.plant.type)) || c.type)
        .filter(Boolean))];
      const ability = liveProtect.map((c) => c.plant).filter(Boolean).map((p) => {
        const extra = [];
        if (p.brief) extra.push(p.brief);
        if (p.restSec != null) extra.push(`触发后休息 ${p.restSec}s`);
        if (p.knockback != null) extra.push(`击退 ${p.knockback} 格`);
        return `${p.name || p.type}${extra.length ? '：' + extra.join('，') : ''}`;
      });
      constraints.push({
        id: 'protect_cells',
        text: `${where} 是必须保护的植物${protectTypes.length ? `（${protectTypes.join('、')}）` : ''}${ability.length ? `；它们的特性：${ability.join('；')}` : ''}。判负条件是这些植物死，不是普通防线植物。僵尸会走到这些格上啃它：短手植物（接触/接近/前后/3x3/N 格）只能种在同行、离保护格不超过它的射程（多数是 1 格）的位置；远程/整行/抛物种在保护格左侧同一行就能覆盖。种在保护格左侧 2 格以外，短手既打不到僵尸也保护不到。`,
        source: 'task',
      });
    }
    if (liveProtect.length && state.brief && state.brief.protect && state.brief.protect.mode === 'contact') {
      constraints.push({
        id: 'protect_contact',
        text: '本关是“踩踏/接触”判定：僵尸只要走到保护格就判负，不需要啃食。防守必须在保护格右侧挡住或提前击杀；高血量墙/肉盾也要种在保护格右侧，种左侧完全无效。',
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
          text: `提前布阵关：波次还没开始，但已经可以种植物。开局数据已算好（forecast/levelContext 是整关全部波次）；先用 pvz_set_plan 按波次写清每行职责、counter 和应急，再用给定阳光布阵。阵型好后调用 pvz_start_level 开打（现在 canStart=${prep.canStart}）。没有计划就点开始会返回 NEED_PLAN；不要一直种下去不等开始，也不要在开打前反复读状态。`,
          source: 'prep',
        });
      } else if (prep.mode === 'conveyor') {
        constraints.push({
          id: 'conveyor',
          text: '传送带关：卡组由传送带动态给定，不能选卡也不能改卡组。state.cards / conveyor.cards 是当前带上的卡（index 每轮可能变），不扣阳光、不吃种子冷却；一张卡只种一次，不要用 cells 铺多格。实时性最高：每轮用最新 index 先堵最危险行，不要把卡攒到下一波。',
          source: 'prep',
        });
      }
      if (prep.deckLocked && prep.mode !== 'conveyor') {
        constraints.push({
          id: 'forced_deck',
          text: `本关是“使用给定植物通关”（锁定 ${prep.lockedCount}/${prep.slots} 张，可选 ${prep.availableCount} 张）：没有选卡页，不要换卡也不要直接点开始。先用本简报的整关波次/卡组数值/coverageGaps 想清楚每张给定卡的对策，用 pvz_set_plan 写 counters 和分波次方案，然后再 pvz_start_level。choose_deck 会原样返回 actualDeck；没有计划就开局会返回 NEED_PLAN。`,
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

    // 开局脚本建议：按本关卡组 + 判定自动生成，模型直接抄进 plan.rules 即可。
    // 只是模板，不替模型选卡；不在卡组里的卡不会出现。
    const deckSet = new Set(deckTypes);
    const cardOf = (t) => cards.find((c) => c && c.type === t) || null;
    const suggestedRules = [];
    if (deckSet.has('blover')) {
      suggestedRules.push({
        id: 'blover-air',
        when: { airborne: true, cardReady: 'blover', minSun: (cardOf('blover') && cardOf('blover').cost) || 50 },
        do: { type: 'plant', plant: 'blover', lane: 'airborne', column: 'back' },
        limits: { cooldownSec: 20, validForSec: 240 },
        onFail: 'ask',
      });
    }
    const protectModeNow = state.brief && state.brief.protect && state.brief.protect.mode;
    if (liveProtect.length && protectModeNow === 'contact') {
      for (const t of ['squash', 'chillypepper', 'cranjelly']) {
        if (!deckSet.has(t)) continue;
        const c = cardOf(t);
        suggestedRules.push({
          id: `guard-${t}`,
          when: {
            protectContactLt: t === 'squash' ? 2.5 : 3,
            cardReady: t,
            minSun: (c && c.cost) || 50,
          },
          do: { type: 'plant', plant: t, lane: 'protect', column: t === 'squash' ? 'ahead' : 'back' },
          limits: { cooldownSec: 20, validForSec: 240 },
          onFail: 'ask',
        });
      }
    }

    return {
      ok: true,
      version,
      phase: state.phase,
      scene: state.scene,
      objective: state.objective,
      missionHints: state.missionHints,
      levelContext,
      level: {
        name: state.level.name || (world
          ? `${world.name}${levelNow.source && levelNow.source.number ? ` ${levelNow.source.number}` : ''}`
          : (sourceNow.asset || null)),
        label: state.level.name || (world
          ? `${world.name}${levelNow.source && levelNow.source.number ? ` ${levelNow.source.number}` : ''}`
          : (sourceNow.asset || '本关')),
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
      // 传送带当前带上的卡（index/type/name）；战斗中也每轮从 state.cards 刷新。
      conveyor: state.conveyor || null,
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
      suggestedRules,
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
        'prep 是准备模式：mode=normal 正常选卡；preplant 提前布阵（先按整关波次写计划，再种，最后 pvz_start_level）；conveyor 传送带（不能选卡，当前卡在 conveyor.cards，index 每轮会变）；forced_deck 使用给定植物通关（没有选卡页，先写计划对策再开局，不能直接 start）。prep.mustPlanBeforeStart=true 表示现在点开始会返回 NEED_PLAN。',
        ...(prep && prep.ready === false
          ? ['准备还没就绪：卡槽/卡池尚未初始化（常见于关卡目标弹窗或页面过渡）。不要据此判断传送带或卡组；进入选卡/准备阶段后再 pvz_briefing 一次。']
          : []),
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
    // 批量图鉴：开局强制读卡池/僵尸时一次查多张，避免几十次往返。
    if (args && Array.isArray(args.types) && args.types.length) {
      const entries = [];
      const missing = [];
      for (const t of args.types.slice(0, 24)) {
        if (!t) continue;
        const r = knowledge({ type: String(t), kind: args.kind });
        if (r && r.ok && r.entry) entries.push(r.entry);
        else missing.push(String(t));
      }
      return {
        ok: entries.length > 0,
        batch: true,
        count: entries.length,
        entries,
        missing,
        hint: missing.length ? 'missing 里的 codename 没查到，可单独用 query 搜中文名。' : undefined,
      };
    }
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
