/**
 * api：桥接层入口。只暴露"读状态 / 执行动作 / 发事件 / 存计划"。
 *
 * 这里没有 setStrategy、autoDeck、suggestDeck、本地队列 —— 决策只属于 LLM。
 */
import { createStatsReader, featureList } from './stats.js';
import { createSnapshotReader } from './snapshot.js';
import { createActions } from './actions.js';
import { createBriefing } from './briefing.js';
import { createPlanStore } from './plan.js';
import { createEventStreamApi } from './events.js';

export const BRIDGE_VERSION = '0.1.16';

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
  const reader = createSnapshotReader({ getCc, findCompByClass, stats, version: BRIDGE_VERSION });
  const planStore = createPlanStore(BRIDGE_VERSION);
  const actions = createActions({ getCc, findComps: reader.findComps, findCompByClass, stats, reader, version: BRIDGE_VERSION });
  const briefingApi = createBriefing({
    stats, reader, planStore, version: BRIDGE_VERSION,
    featureList: (kind) => featureList(getCc, kind),
    nameOf: null,
  });
  const eventsApi = createEventStreamApi({ snapshot: reader.snapshot });

  function snapshot() {
    const s = reader.snapshot();
    if (s && s.ok) {
      const p = planStore.getPlan();
      s.plan = p ? p.plan : null;
      s.planSavedAt = p ? p.savedAt : null;
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
      },
      eventStatus: eventsApi.status(),
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
    act: (a) => actions.act(a),
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
