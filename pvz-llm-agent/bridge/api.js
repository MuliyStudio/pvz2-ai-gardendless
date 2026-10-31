import { createStatsReader, featureList } from './stats.js';
import { createSnapshotReader } from './snapshot.js';
import { createActions } from './actions.js';
import { createBriefing } from './briefing.js';
import { buildForecast } from './forecast.js';
import { createPlanStore } from './plan.js';
import { createLevelMemory } from './level-memory.js';
import { createLatencyStore } from './latency.js';
import { createEventStreamApi } from './events.js';

/**
 * api：桥接层入口。只暴露"读状态 / 执行动作 / 发事件 / 存计划"。
 *
 * 这里没有 setStrategy、autoDeck、suggestDeck、本地队列 —— 决策只属于 LLM。
 */

export const BRIDGE_VERSION = '0.4.15';

export function createBridge(ctx) {
  const A = (() => (typeof window !== 'undefined' ? window : globalThis))();
  const getCc = () => {
    try { return (ctx && ctx.unsafe && ctx.unsafe.engine && ctx.unsafe.engine.getCc && ctx.unsafe.engine.getCc()) || A.cc || null; } catch { return null; }
  };

  function findCompByClass(root, cls) {
    let hit = null;
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k === cls) { hit = c; return; }
      }
      for (const ch of n.children || []) { walk(ch); if (hit) return; }
    };
    try { if (root) walk(root); } catch { /* ignore */ }
    return hit;
  }

  const stats = createStatsReader(getCc);
  const latency = createLatencyStore();
  const reader = createSnapshotReader({ getCc, findCompByClass, stats, latency, version: BRIDGE_VERSION });
  const planStore = createPlanStore(BRIDGE_VERSION);
  const levelMemory = createLevelMemory();
  const actions = createActions({ getCc, findComps: reader.findComps, findCompByClass, stats, reader, version: BRIDGE_VERSION });
  const briefingApi = createBriefing({
    stats, reader, planStore, levelMemory, version: BRIDGE_VERSION,
    featureList: (kind) => featureList(getCc, kind),
    nameOf: null,
  });
  const eventsApi = createEventStreamApi({
    snapshot: reader.snapshot,
    keyOf: (s) => levelMemory.keyOf(s),
    // 关卡结束（胜负 / 中途重开 / 退出）自动落一条总结；不管客户端在不在，采样器都在跑。
    onLevelEnd: (info) => {
      if (!info || !info.key) return null;
      const p = planStore.getPlan();
      return levelMemory.put(info.key, {
        at: new Date().toISOString(),
        result: info.result,
        wave: info.wave,
        waveCount: info.waveCount,
        durationSec: info.durationSec,
        deck: info.deck,
        name: info.name,
        plan: p ? p.plan : null,
        facts: info.facts,
        review: info.review || null,
      });
    },
  });

  function snapshot() {
    const s = reader.snapshot();
    if (s && s.ok) {
      const p = planStore.getPlan();
      s.plan = p ? p.plan : null;
      s.planSavedAt = p ? p.savedAt : null;
      // 关卡稳定 id：关卡结束后回到地图也能用它写回这一关的记忆。
      try { s.levelKey = levelMemory.keyOf(s); } catch { s.levelKey = null; }
    }
    return s;
  }

  function health() {
    let s = null;
    try { s = snapshot(); } catch { /* ignore */ }
    const api = [
      'snapshot', 'briefing', 'knowledge', 'act', 'actAll', 'events', 'pollEvents',
      'setPlan', 'getPlan', 'chooseDeck', 'deckStatus', 'startLevel',
      'restartLevel', 'dismissObjective', 'collect', 'moveCart', 'resume', 'health',
      'getLevelMemory', 'listLevelMemory', 'setLevelNote', 'addLevelLessons', 'setLevelLessons',
      'exportLevelMemory', 'importLevelMemory', 'forecast', 'latencyState',
    ];
    const missing = api.filter((k) => typeof apiObj[k] !== 'function');
    return {
      ok: !!s,
      version: BRIDGE_VERSION,
      scene: s && s.scene,
      phase: s && s.phase,
      api,
      missing,
      features: {
        briefing: true,
        knowledge: true,
        events: true,
        plan: true,
        deck: true,
        carts: Array.isArray(s && s.carts),
        terrain: !!(s && s.terrain && s.terrain.map),
        stats: !!(s && Object.keys(s.zombieStats || {}).length >= 0),
        autoCollect: true,
        localStrategy: false,
        autoDeck: false,
        queue: false,
        forecast: true,
        levelMemory: levelMemory.persistent,
        latency: true,
      },
      eventStatus: eventsApi.status(),
      latency: latency.state(),
      counts: {
        cards: (s && s.cards || []).length,
        plants: (s && s.plants || []).length,
        zombies: (s && s.zombies || []).length,
        waves: (s && s.levelScript && (s.levelScript.waveCount || (s.levelScript.waves || []).length)) || 0,
      },
    };
  }

  const apiObj = {
    version: BRIDGE_VERSION,
    snapshot,
    briefing: () => briefingApi.briefing(),
    knowledge: (args) => briefingApi.knowledge(args),
    act: (a, opts) => actions.act(a, opts),
    actAll: (list) => actions.actAll(list),
    events: (limit) => eventsApi.events(limit),
    pollEvents: (limit) => eventsApi.pollEvents(limit),
    eventStatus: () => eventsApi.status(),
    setEventSampler: (ms) => eventsApi.setEventSampler(ms),
    setPlan: (plan) => planStore.setPlan(plan),
    getPlan: () => planStore.getPlan(),
    chooseDeck: (cards, replace) => actions.chooseDeck(cards, replace),
    deckStatus: () => actions.deckStatus(),
    startLevel: () => actions.startLevel(),
    restartLevel: () => actions.restartLevel(),
    dismissObjective: () => actions.dismissObjective(),
    collect: () => actions.collect(),
    moveCart: (cart, direction) => actions.moveCart(cart, direction),
    resume: () => actions.resume(),
    // 延迟测量（游戏内 agent / router 上报；MCP 客户端测不到模型耗时时用默认 lead）
    latency: {
      recordModel: (ms) => latency.recordModel(ms),
      recordTool: (ms) => latency.recordTool(ms),
      state: () => latency.state(),
      setSettle: (ms) => { latency.setSettle ? latency.setSettle(ms) : null; return latency.state(); },
      reset: () => latency.reset(),
    },
    latencyState: () => latency.state(),
    // 关卡总结：key 缺省就是当前关；note 是模型自己写的过关心得（覆盖）
    getLevelMemory: (key) => {
      const k = key || (() => { try { return levelMemory.keyOf(snapshot()); } catch { return null; } })();
      if (!k) return { ok: false, code: 'NO_LEVEL', reason: '当前不在关卡内，也没有给 key' };
      return { ok: true, key: k, entry: levelMemory.get(k) };
    },
    listLevelMemory: (limit) => ({ ok: true, entries: levelMemory.list(limit) }),
    setLevelNote: (note, key) => {
      let k = key || null;
      if (!k) { try { k = levelMemory.keyOf(snapshot()); } catch { k = null; } }
      if (!k) return { ok: false, code: 'NO_LEVEL', reason: '当前不在关卡内，也没有给 key' };
      return { ok: true, key: k, entry: levelMemory.setNote(k, note) };
    },
    // 自动复盘写下的可执行经验：这一关隔离，跨局保留（localStorage）
    addLevelLessons: (lessons, key) => {
      let k = key || null;
      if (!k) { try { k = levelMemory.keyOf(snapshot()); } catch { k = null; } }
      if (!k) return { ok: false, code: 'NO_LEVEL', reason: '当前不在关卡内，也没有给 key' };
      return { ok: true, key: k, entry: levelMemory.addLessons(k, lessons) };
    },
    setLevelLessons: (lessons, key) => {
      let k = key || null;
      if (!k) { try { k = levelMemory.keyOf(snapshot()); } catch { k = null; } }
      if (!k) return { ok: false, code: 'NO_LEVEL', reason: '当前不在关卡内，也没有给 key' };
      return { ok: true, key: k, entry: levelMemory.setLessons(k, lessons) };
    },
    exportLevelMemory: () => ({ ok: true, json: levelMemory.exportAll() }),
    importLevelMemory: (json) => {
      const r = levelMemory.importAll(json);
      return r && r.ok ? { ok: true, levels: r.levels } : { ok: false, code: (r && r.code) || 'BAD_JSON' };
    },
    forecast: () => {
      const s = reader.snapshot({ full: true });
      if (!s || !s.ok) return { ok: false, code: s ? (s.code || 'NO_SCENE') : 'NO_SCENE', reason: s ? s.reason : '不在关卡内' };
      return { ok: true, forecast: buildForecast(s.levelScript, stats, {}) };
    },
    health,
    dispose: () => {
      eventsApi.dispose();
      if (reader.setAutoCollect) reader.setAutoCollect(false);
      return { ok: true };
    },
  };

  try { A.PvzLlm = apiObj; } catch { /* ignore */ }
  try { reader.setAutoCollect(true); } catch { /* ignore */ }
  try { eventsApi.setEventSampler(100); } catch { /* ignore */ }
  return apiObj;
}

