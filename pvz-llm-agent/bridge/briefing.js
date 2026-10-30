/**
 * briefing / knowledge：把"做决定需要的事实"整理给 LLM。
 *
 * 明确不返回：推荐卡组、本地建议、打法结论。卡组和打法只能由 LLM 自己给。
 */
import { worldFactOf } from '../knowledge/worlds.js';

export function createBriefing({ stats, reader, planStore, version, featureList, nameOf }) {
  function plantEntry(type) {
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
      attack: st.attack,
      sun: st.sun,
      splash: st.splash,
      plantFood: st.plantFood,
      shot: st.shot,
      brief: st.brief,
      introduction: st.introduction,
      special: st.special,
      weaknesses: st.weaknesses,
      usage: st.usage,
    };
  }

  function zombieEntry(type) {
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
      behaviors: st.behaviors,
      brief: st.brief,
      introduction: st.introduction,
      special: st.special,
      weaknesses: st.weaknesses,
    };
  }

  function wavesOf(state) {
    const ls = state.levelScript;
    if (!ls || !Array.isArray(ls.waves)) return [];
    const flagInterval = ls.flagInterval || null;
    return ls.waves.map((w) => {
      const zombieStats = {};
      let ehp = 0;
      for (const [type, count] of Object.entries(w.zombies || {})) {
        const z = stats.zombieStatsOf(type);
        const e = (z && z.ehp) || null;
        zombieStats[type] = { count, ehpEach: e, ehp: e != null ? e * count : null };
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
    const state = reader.snapshot();
    if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason || '不在关卡内' };
    const seed = state.seedSelection;
    const pool = (seed && seed.available) || state.cards || [];
    const cards = pool.map((c) => plantEntry(c.type)).filter(Boolean);

    const waveList = wavesOf(state);
    const waveTypes = new Set();
    for (const w of waveList) for (const t of Object.keys(w.zombies || {})) waveTypes.add(t);
    for (const z of state.zombies || []) waveTypes.add(z.type);
    const zombies = [...waveTypes].map(zombieEntry).filter(Boolean);
    const zombieIndex = new Map(zombies.map((z) => [z.type, z]));
    for (const w of waveList) {
      for (const [type, info] of Object.entries(w.zombies)) {
        if (info.ehp == null && zombieIndex.get(type)) info.ehp = (zombieIndex.get(type).ehp || 0) * info.count;
      }
      if (!w.ehp) w.ehp = Object.values(w.zombies).reduce((s, x) => s + (x.ehp || 0), 0);
    }

    const world = state.world || null;
    const worldMechanics = world ? world.mechanics.map((text, i) => ({ id: `${world.key}_${i}`, text, source: 'world' })) : [];
    const mechanics = [...worldMechanics, ...(state.mechanicFacts || [])].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);

    const constraints = [];
    const missionText = [].concat(state.missionHints || [], (state.objective && state.objective.missions) || []);
    if (state.plantLimit != null) constraints.push({ id: 'plant_limit', text: `本关植物上限：${state.plantLimit} 株`, source: 'objective' });
    for (const t of state.tasks || []) {
      constraints.push({ id: `task_${t.key}`, text: t.tip + (t.hint ? `（${t.hint}）` : ''), source: 'task' });
    }
    if (state.levelScript && state.levelScript.lawn && state.levelScript.lawn.isAtNight) {
      constraints.push({ id: 'night', text: '夜间：没有天空掉落阳光', source: 'lawn' });
    }
    if (world) constraints.push({ id: 'world', text: `世界：${world.name}`, source: 'world' });

    const plan = planStore.getPlan();
    return {
      ok: true,
      version,
      phase: state.phase,
      scene: state.scene,
      objective: state.objective,
      missionHints: state.missionHints,
      level: {
        name: state.level.name || null,
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
      },
      waves: waveList,
      zombies,
      cards,
      deck: {
        slots: seed ? seed.slots : (state.cards || []).length,
        current: seed ? seed.current : (state.deck || []),
        gameStartable: seed ? seed.gameStartable : null,
      },
      startingSun: state.startingSun,
      plantLimit: state.plantLimit,
      constraints,
      mechanics,
      plan: plan ? plan.plan : null,
      planSavedAt: plan ? plan.savedAt : null,
      facts: {
        sun: state.sun,
        plantFood: state.plantFood,
        plantsOnLawn: (state.plants || []).length,
        zombiesOnLawn: (state.zombies || []).length,
        totalWaveEhp: waveList.reduce((s, w) => s + (w.ehp || 0), 0),
        missionText,
      },
      notes: [
        '这是事实清单：没有推荐卡组，也没有本地打法。选卡、每行职责、阈值都由你决定。',
        'stats 里的 ehp = 本体血量 + 全部护甲；dps = 伤害 / 攻击间隔。',
        'plantable 只排除已占格、障碍格、水面/天空；特殊卡（睡莲等）的落点仍要按卡牌说明判断。',
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
      const state = reader.snapshot();
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
      if (entry) return { ok: true, kind: 'plant', entry };
    }
    if (kind === 'zombie' || (!kind && stats.zombieStatsOf(t))) {
      const entry = zombieEntry(t);
      if (entry) return { ok: true, kind: 'zombie', entry };
    }
    if ((!kind || kind === 'level') && (t === 'level' || t === '本关')) {
      const state = reader.snapshot();
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
