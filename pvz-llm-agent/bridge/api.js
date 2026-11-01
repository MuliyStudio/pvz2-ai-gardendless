import { createStatsReader, featureList } from './stats.js';
import { createSnapshotReader } from './snapshot.js';
import { createActions } from './actions.js';
import { createBriefing } from './briefing.js';
import { buildForecast } from './forecast.js';
import { createPlanStore } from './plan.js';
import { isWallCard } from './mechanics.js';
import { createLevelMemory } from './level-memory.js';
import { createLatencyStore } from './latency.js';
import { createEventStreamApi } from './events.js';
import { createActionQueue } from './queue.js';

/**
 * api：桥接层入口。只暴露"读状态 / 执行动作 / 发事件 / 存计划"。
 *
 * 这里没有 setStrategy、autoDeck、suggestDeck、本地队列 —— 决策只属于 LLM。
 */

export const BRIDGE_VERSION = '0.4.17';

export function createBridge(ctx, opts = {}) {
  // 测试/纯工具场景可以显式关掉“开局强制读图鉴”门；游戏内默认开启。
  const knowledgeGateEnabled = opts && opts.knowledgeGate != null
    ? !!opts.knowledgeGate : !(ctx && ctx.testMode);
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
  const actions = createActions({
    getCc, findComps: reader.findComps, findCompByClass, stats, reader, version: BRIDGE_VERSION,
    getPlan: () => planStore.getPlan(),
    getLevelKey: () => {
      try { return levelMemory.keyOf(snapshot()); } catch { return null; }
    },
  });
  // 模型在 plan.queue 里写任务，本地按 tick 执行可行的那一条。
  // 这里不选择卡/行，只处理冷却、阳光、占格和 cond；任务顺序仍由模型决定。
  const queue = createActionQueue({ reader, actions });

  // 旧计划不能跨关卡/跨模式继续生效：传送带的 plan 留到普通关会误导模型。
  // 只在新一局/关卡 key 或 prep 模式变化时清空；不碰局内正常重写。
  let lastPlanScope = null;
  let lastPhaseSeen = null;
  function planScopeOf(s) {
    if (!s) return null;
    const mode = s.prep && s.prep.mode ? String(s.prep.mode) : null;
    if (!s.levelKey && !mode) return null;
    return {
      key: s.levelKey || null,
      mode,
      conveyor: !!(s.prep && s.prep.conveyor),
    };
  }
  function samePlanScope(a, b) {
    if (!a || !b) return true;
    // 关卡 key 还没解析出来时是 null，不能因此把刚写的计划清掉。
    if (a.key && b.key && a.key !== b.key) return false;
    if (a.conveyor !== b.conveyor) return false;
    if (a.mode && b.mode && a.mode !== b.mode) return false;
    return true;
  }
  // 本地算好的微决策：只给“这条动作现在值不值得做”的 yes/no，
  // 不替模型选卡/选行；模型可以回 other 自己用 pvz_act。
  const decisionStore = new Map();
  // 开局强制读图鉴：briefing 后必须用 pvz_knowledge 查完卡池植物和本关僵尸，
  // 才允许选卡/写计划/开局。换关/重开时重置。
  let knowledgeGate = { briefed: false, deck: [], zombies: [], read: new Set() };
  function resetKnowledgeGate() {
    knowledgeGate = { briefed: false, deck: [], zombies: [], read: new Set() };
  }
  function resetPlanState() {
    try { planStore.reset(); } catch { /* ignore */ }
    try { queue.clear(); } catch { /* ignore */ }
    decisionStore.clear();
    resetKnowledgeGate();
    lastPlanScope = null;
  }
  // 只给事实：哪些威胁在当前 plan/queue 里没有对应任务。
  // 不替模型写任务，模型看到后自己决定补什么。
  function buildThreatGaps(s) {
    if (!s || !s.brief) return [];
    const tasks = (s && s.queue && s.queue.tasks) || [];
    const plantSt = (type) => {
      try { return stats.plantStatsOf(type); } catch { return null; }
    };
    const isWallTask = (t) => {
      if (!t || t.type !== 'plant') return false;
      const st = plantSt(t.plant);
      return isWallCard(t.plant, st);
    };
    const isOutputTask = (t) => {
      if (!t || t.type !== 'plant') return false;
      const st = plantSt(t.plant);
      if (!st || isWallCard(t.plant, st)) return false;
      return !!(st.attack && Number(st.attack.dps) > 0)
        || !!(st.burst && Number(st.burst.dmg) > 0);
    };
    const taskLanes = new Set(tasks.map((t) => Number(t.lane)).filter(Number.isFinite));
    const wallLanes = new Set(tasks.filter(isWallTask).map((t) => Number(t.lane)));
    const outputLanes = new Set(tasks.filter(isOutputTask).map((t) => Number(t.lane)));
    const counters = (s.plan && Array.isArray(s.plan.counters)) ? s.plan.counters : [];
    const counterCovers = (g) => counters.some((c) => {
      if (!c || typeof c !== 'object') return false;
      if (g.tags && c.tag && g.tags.includes(String(c.tag))) return true;
      if (g.requiredCapability && c.capability
        && [g.requiredCapability, ...(g.alternatives || [])].includes(String(c.capability))) return true;
      if (g.candidates && c.card && g.candidates.includes(String(c.card))) return true;
      return false;
    });
    const gaps = [];
    for (const w of (s.brief.wallPlan || [])) {
      if (!w || w.risk !== 'no_wall' || wallLanes.has(Number(w.lane))) continue;
      gaps.push({
        kind: 'wall', lane: w.lane, etaSec: w.frontEta, wallHp: w.wallHp,
        reason: 'wallPlan no_wall 且 queue 没有该行墙任务',
      });
    }
    for (const r of (s.brief.rescuePlan || [])) {
      if (!r || r.lane == null || !r.window) continue;
      if (!(r.window.killBeforeWindow === false || r.window.killBeforeHouse === false)) continue;
      if (outputLanes.has(Number(r.lane))) continue;
      gaps.push({
        kind: 'rescue', lane: r.lane, etaSec: r.window.contactInSec,
        deficit: r.window.killSec, q: r.window.killBeforeWindow,
        reason: 'rescuePlan 该行打不过且 queue 没有输出/救场任务',
      });
    }
    for (const l of (s.lanes || [])) {
      if (!l.front) continue;
      if (!(Number(l.gap) > 0 || l.killBeforeHouse === false)) continue;
      if (outputLanes.has(Number(l.lane))) continue;
      gaps.push({
        kind: 'output', lane: l.lane, etaSec: l.lossIn, deficit: l.gap,
        reason: '本行 dps 低于 incoming 且 queue 没有输出任务',
      });
    }
    for (const m of (s.brief.minePlan || [])) {
      if (!m || !(m.tooLate || m.latestSafeColumn == null)) continue;
      if (tasks.some((t) => t.type === 'plant' && Number(t.lane) === Number(m.lane))) continue;
      gaps.push({
        kind: 'mine', lane: m.lane, etaSec: m.etaAtLatest,
        reason: '地雷已来不及且 queue 没有该行任务',
      });
    }
    const protect = s.brief.protect;
    for (const lane of (protect && protect.unguardedLanes) || []) {
      if (!tasks.some((t) => Number(t.lane) === Number(lane))) {
        gaps.push({ kind: 'protect', lane, reason: '保护行没有 queue 任务' });
      }
    }
    const missing = (s.brief.coverageGaps && s.brief.coverageGaps.missing) || [];
    for (const g of missing) {
      if (!g || counterCovers(g)) continue;
      gaps.push({
        kind: 'capability',
        lane: null,
        requiredCapability: g.capability,
        alternatives: g.alternatives || [],
        tags: g.tags || [],
        candidates: g.candidates || [],
        reason: g.text || `卡组缺少 ${g.capability}，计划里也没有 counter`,
      });
    }
    return gaps.slice(0, 12);
  }

  function makeDecisions(s) {
    const now = Date.now();
    for (const [id, d] of decisionStore) {
      if (!d || d.expiresAt <= now) decisionStore.delete(id);
    }
    if (!s || s.phase !== 'running') return [];
    const out = [];
    const add = (id, kind, question, action, facts, ttl = 4) => {
      if (out.length >= 6) return;
      const expiresAt = now + ttl * 1000;
      decisionStore.set(id, { action, stateVersion: s.stateVersion, expiresAt });
      out.push({
        id, kind, question, action, facts,
        stateVersion: s.stateVersion, expiresInSec: ttl,
      });
    };
    const ver = s.stateVersion || '0';
    // 没有豆时不要生成“给豆”决策：否则模型点 yes 只会拿到 NO_FOOD。
    if (Number(s.plantFood) > 0) {
      for (const f of ((s.brief && s.brief.plantFoodPlan) || []).slice(0, 3)) {
        if (!(f && Number(f.targets) > 0) || f.whiff === true) continue;
        add(
          `food:${f.lane}:${f.column}:${ver}`,
          'plant_food',
          `给第 ${Number(f.lane) + 1} 行第 ${Number(f.column) + 1} 列的 ${f.name || f.type} 能量豆？`,
          { type: 'plant_food', lane: f.lane, column: f.column },
          { targets: f.targets, total: f.total, kind: f.kind },
        );
      }
    }
    // 最后防线：这一行已经守不住、但前面墙/植物还能拖时，把后排向日葵换成雷。
    // minePlan 已把阻挡物啃食时间算进 safeColumns；这里只做交叉引用，不替模型执行。
    for (const r of ((s.brief && s.brief.lastResortPlan) || []).slice(0, 2)) {
      if (!r || !r.replaceCell) continue;
      const card = (s.cards || []).find((c) => c.type === r.mine);
      if (!card || !card.ready || Number(s.sun) < Number(card.cost)) continue;
      const queued = ((s.plan && s.plan.queue) || []).some((t) => t
        && t.type === 'replace' && Number(t.lane) === Number(r.lane)
        && Number(t.column) === Number(r.replaceCell.column)
        && String(t.plant) === String(r.mine));
      if (queued) continue;
      add(
        `last:${r.lane}:${r.replaceCell.column}:${r.mine}:${ver}`,
        'last_resort',
        `第 ${Number(r.lane) + 1} 行守不住（clearSec ${r.clearSec}s > lossIn ${r.lossIn}s）；前面植物能拖到雷出土，把 c${Number(r.replaceCell.column) + 1} 的 ${r.replaceCell.type} 换成 ${r.mine}？`,
        { type: 'replace', lane: r.lane, column: r.replaceCell.column, plant: r.mine },
        { armTimeSec: r.armTimeSec, etaSec: r.etaSec, tiles: r.tiles },
        5,
      );
    }

    // 缺墙/墙快倒：给一条可一键补墙的决策。僵尸进 c2 以内时不补（先救场），
    // 只在还有时间立墙时出现；仍然只执行模型回 yes 的那一条。
    const wallCandidates = ((s.brief && s.brief.wallPlan) || [])
      .filter((w) => w && (w.risk === 'no_wall' || w.risk === 'wall_too_thin')
        && w.frontColumn != null && Number(w.frontColumn) >= 1.5 && Number(w.frontColumn) <= 8)
      .sort((a, b) => Number(a.frontColumn) - Number(b.frontColumn));
    if (wallCandidates.length) {
      const w = wallCandidates[0];
      const lane = Number(w.lane);
      const cardType = String(w.wallCard || 'wallnut');
      const card = (s.cards || []).find((c) => c.type === cardType);
      if (card && card.ready && Number(s.sun) >= Number(card.cost) + 25) {
        const row = s.board && s.board[lane];
        let col = Math.min(8, Math.floor(Number(w.frontColumn)) - 1);
        while (col >= 0 && row && row.cells && row.cells[col]) col -= 1;
        const queued = ((s.plan && s.plan.queue) || []).some((t) => t
          && t.type === 'plant' && Number(t.lane) === lane && String(t.plant) === cardType);
        if (col >= 0 && !queued) {
          add(
            `wall:${lane}:${col}:${cardType}:${ver}`,
            'wall',
            `第 ${lane + 1} 行${w.risk === 'no_wall' ? '没有墙' : '墙快倒'}，${w.frontType || '僵尸'}已到 c${Number(w.frontColumn).toFixed(1)}；在 c${col + 1} 补 ${cardType}？`,
            { type: 'plant', lane, column: col, plant: cardType },
            { risk: w.risk, frontColumn: w.frontColumn, wallHp: w.wallHp },
            5,
          );
        }
      }
    }

    // 波间升级：把 brief.upgradePlan 变成一条可一键接受的 replace 决策。
    // 只在“僵尸还没贴脸、阳光留出余量、卡就绪”时出现；任何一行进 c3 以内
    // 或有 rescuePlan 时，升级让位于救场，不再生成。
    // 只有“真的贴脸/已经来不及”才让升级让位：不能因为 rescuePlan 里有远一点的
    // 弱线就整个波次都不让升级，否则永远等不到波间窗口。
    const emergency = (s.lanes || []).some((l) => l && l.front && (
      Number(l.front.column) < 3
      || (l.lossIn != null && Number(l.lossIn) < 10)
      || (l.actBy != null && Number(l.actBy) < 0)
    ));
    const upgrades = (emergency ? [] : ((s.brief && s.brief.upgradePlan) || []))
      .filter((u) => u && Number(u.zombies) >= 2)
      .sort((a, b) => (b.zombies - a.zombies)
        || ((b.candidates && b.candidates[0] && b.candidates[0].multiDps) || 0)
        - ((a.candidates && a.candidates[0] && a.candidates[0].multiDps) || 0))
      .slice(0, 3);
    for (const u of upgrades) {
      const lane = (s.lanes || []).find((l) => Number(l.lane) === Number(u.lane));
      const front = lane && lane.front;
      if (!front || Number(front.column) < 4) continue; // 贴脸先救场，不在 c4 以内做升级
      const c = (u.candidates || [])[0];
      if (!c || !Array.isArray(c.replaceCells) || !c.replaceCells.length) continue;
      const card = (s.cards || []).find((x) => x.type === c.card);
      if (!card || !card.ready) continue;
      const cost = Number(c.cost) || 0;
      if (Number(s.sun) < cost + 75) continue; // 至少给下一株墙/应急留 75 阳光
      const cell = c.replaceCells.find((x) => Number(x.column) < Number(front.column));
      if (!cell) continue;
      const queued = ((s.plan && s.plan.queue) || []).some((t) => t
        && t.type === 'replace'
        && Number(t.lane) === Number(u.lane)
        && Number(t.column) === Number(cell.column)
        && String(t.plant) === String(c.card));
      if (queued) continue;
      add(
        `upg:${u.lane}:${cell.column}:${c.card}:${ver}`,
        'upgrade',
        `第 ${Number(u.lane) + 1} 行有 ${u.zombies} 只僵尸、现有 ${u.outputs} 株单体输出（${u.outputDps} dps）；花 ${cost} 把 c${Number(cell.column) + 1} 的 ${cell.type} 换成 ${c.card}（${c.targets || 3} 目标 ${c.multiDps}）？`,
        { type: 'replace', lane: u.lane, column: cell.column, plant: c.card },
        { zombies: u.zombies, currentDps: u.outputDps, multiDps: c.multiDps, cost },
        6,
      );
    }
    for (const a of (s.aimOptions || []).slice(0, 3)) {
      if (!a || a.column == null) continue;
      add(
        `aim:${a.card}:${a.lane}:${a.column}:${ver}`,
        'aim',
        `把 ${a.card} 放在第 ${Number(a.lane) + 1} 行第 ${Number(a.column) + 1} 列？`,
        { type: 'plant', plant: a.card, lane: a.lane, column: a.column },
        { hits: a.hits, total: a.total, kills: a.kills },
      );
    }
    for (const a of ((s.brief && s.brief.activatePlan) || []).slice(0, 2)) {
      if (!a || !a.shouldAct || a.aim === 'free_cell' || a.aim === 'swap') continue;
      add(
        `activate:${a.lane}:${a.column}:${ver}`,
        'activate',
        `激活第 ${Number(a.lane) + 1} 行第 ${Number(a.column) + 1} 列的 ${a.name || a.type}？`,
        { type: 'activate', lane: a.lane, column: a.column },
        { aim: a.aim, targets: a.targets },
      );
    }
    return out;
  }

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
      // 关卡稳定 id：关卡结束后回到地图也能用它写回这一关的记忆。
      try { s.levelKey = levelMemory.keyOf(s); } catch { s.levelKey = null; }

      // 新一局/回菜单后再进关：上一局的 plan 不能继续生效。
      const endPhase = ['won', 'lost', 'menu', 'worldmap'];
      const startPhase = ['preparing', 'objective', 'running'];
      const newRun = !!(lastPhaseSeen
        && ((endPhase.includes(lastPhaseSeen) && startPhase.includes(s.phase))
          || (lastPhaseSeen === 'running' && s.phase === 'preparing')));
      lastPhaseSeen = s.phase || lastPhaseSeen;
      if (newRun) resetPlanState();

      // 同一关但模式变了（传送带 → 普通关）也要丢弃旧计划。
      const scope = planScopeOf(s);
      if (scope && lastPlanScope && !samePlanScope(scope, lastPlanScope)) resetPlanState();
      if (scope) lastPlanScope = scope;

      const p = planStore.getPlan();
      s.plan = p ? p.plan : null;
      s.planSavedAt = p ? p.savedAt : null;
      // 每回合带一份审计结果：旧 plan 的 deck 和实际不符时，模型下一轮能看到并重写。
      try {
        // 选卡还没完成时 deck 还不稳定，先不判 deck mismatch，避免刚写计划就报假警。
        const prep = s.prep;
        const deckFinal = !prep || prep.gameStarted || prep.deckLocked
          || prep.mode === 'conveyor' || !prep.hasSeedChooser;
        const wallTypes = (s.deck || []).filter((t) => {
          try { const st = stats.plantStatsOf(t); return !!(st && String(st.family) === 'Defence'); } catch { return false; }
        });
        const mineTypes = (s.deck || []).filter((t) => {
          try { const st = stats.plantStatsOf(t); return !!(st && Number(st.armTimeSec) > 0); } catch { return false; }
        });
        const audit = planStore.audit({
          coverageGaps: s.brief && s.brief.coverageGaps,
          deck: deckFinal ? s.deck : null,
          wallTypes,
          mineTypes,
          phase: s.phase,
        });
        if (audit && audit.ok === false) s.planAudit = audit;
      } catch { /* ignore */ }
      try {
        const decisions = makeDecisions(s);
        if (decisions.length) s.decisions = decisions;
      } catch { /* ignore */ }

      // 关卡结束/回菜单：队列没有意义，直接停，避免下一场景继续种。
      if (s.phase === 'won' || s.phase === 'lost' || s.phase === 'menu' || s.phase === 'worldmap') {
        try { queue.clear(); } catch { /* ignore */ }
      }
      s.queue = queue.status();
      try {
        const gaps = buildThreatGaps(s);
        if (gaps.length) s.threatGaps = gaps;
      } catch { /* ignore */ }
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
      'setQueue', 'queueStatus', 'clearQueue', 'setQueueThinking', 'decide',
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
        // 队列只执行模型写下的任务；不本地选卡/改计划。
        queue: true,
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

  function knowledgeGateFail(extraTypes) {
    if (!knowledgeGateEnabled) return null;
    let s = null;
    try { s = snapshot(); } catch { s = null; }
    if (!s || s.ok === false || s.phase !== 'preparing') return null;
    const prep = s.prep;
    // 普通/提前布阵/给定卡组都要先读图鉴；传送带关没有选卡环节，不拦。
    if (!prep || prep.gameStarted || prep.mode === 'conveyor') return null;
    if (!knowledgeGate.briefed) {
      return {
        ok: false, code: 'NEED_BRIEFING',
        reason: '开局选卡/写计划前先 pvz_briefing 读完整关事实。',
        hint: 'briefing 里已经带了本关僵尸图鉴；之后只需查当前卡组和保护/预置植物。',
      };
    }
    // 只强制“这一局真正会用到的东西”：当前卡组 + 保护植物 + 预置植物 + 本次要换上的卡。
    // 不再要求查完整卡池（52 张）——那会把选卡阶段变成两次大图鉴轰炸。
    const deck = knowledgeGate.deck.length ? knowledgeGate.deck : (s.deck || []).filter(Boolean);
    const protectedTypes = ((s.protectCells || []).map((c) => c && c.plant && c.plant.type))
      .filter(Boolean);
    const preplaced = (s.plants || []).map((p) => p && p.type).filter(Boolean);
    const required = [...new Set([
      ...deck, ...protectedTypes, ...preplaced,
      ...(Array.isArray(extraTypes) ? extraTypes : []),
    ].map((x) => x && String(x)).filter(Boolean))];
    const missing = required.filter((t) => !knowledgeGate.read.has(t));
    if (missing.length) {
      return {
        ok: false, code: 'NEED_KNOWLEDGE',
        missing,
        required: required.length,
        read: knowledgeGate.read.size,
        scope: 'deck+protect',
        reason: `只差 ${missing.length}/${required.length} 个“当前卡组/保护植物”没查图鉴。`,
        hint: `用 pvz_knowledge {types:[...]} 查 ${missing.join(', ')}，再继续；不需要整张卡池全查。`,
      };
    }
    return null;
  }

  const apiObj = {
    version: BRIDGE_VERSION,
    snapshot,
    briefing: () => {
      const r = briefingApi.briefing();
      if (r && r.ok) {
        knowledgeGate.briefed = true;
        // 只记“这局会用到”的卡：当前卡组 + 保护植物 + 预置植物。
        // 卡池 52 张不再进强制清单。
        knowledgeGate.deck = [...new Set([
          ...(((r.deck && r.deck.current) || []).filter(Boolean)),
          ...(((r.protect && r.protect.cells) || []).map((c) => c && c.plant && c.plant.type).filter(Boolean)),
        ])];
        knowledgeGate.zombies = [...new Set((r.zombies || []).map((z) => z && z.type).filter(Boolean))];
      }
      return r;
    },
    knowledge: (args) => {
      const r = briefingApi.knowledge(args);
      if (r && r.ok) {
        const add = (e) => { if (e && e.type) knowledgeGate.read.add(String(e.type)); };
        add(r.entry);
        if (Array.isArray(r.entries)) r.entries.forEach(add);
      }
      return r;
    },
    act: async (a, opts) => {
      // 模型手动动作优先；队列短暂让路，避免同一格/同一卡抢操作。
      try { queue.pause(1800); } catch { /* ignore */ }
      const restart = !!(a && a.type === 'restart');
      const r = await actions.act(a, opts);
      // SUN 失败多半不是“没阳光”，而是模型思考期间队列已经花掉了：
      // 把队列最近 8 秒花的阳光带回去，模型就知道该按哪个数重试。
      if (r && r.ok === false && r.code === 'SUN') {
        try {
          const q = queue.status();
          if (q && q.recentSunSpent) {
            r.queueSpentRecent = q.recentSunSpent;
            r.hint = `执行时只有 ${r.have} 阳光，本地队列最近 8 秒已花 ${q.recentSunSpent}；按返回的 have 重新算，不要沿用上一轮 state 的阳光。`;
          }
        } catch { /* ignore */ }
      }
      if (restart && r && r.ok !== false) resetPlanState();
      return r;
    },
    actAll: async (list) => {
      try { queue.pause(1800); } catch { /* ignore */ }
      const restart = Array.isArray(list) && list.some((x) => x && x.type === 'restart');
      const r = await actions.actAll(list);
      if (restart && r && r.ok !== false) resetPlanState();
      return r;
    },
    clearMemory: (scope) => {
      let key = null;
      try { if (scope !== 'all') key = levelMemory.keyOf(snapshot()); } catch { key = null; }
      const r = levelMemory.clear(key || null);
      // 记忆和当前计划/队列一起清，避免清完历史还挂着上一关的旧计划。
      try { resetPlanState(); } catch { /* ignore */ }
      return { ...(r || { ok: true }), scope: key ? 'level' : 'all', key };
    },
    setQueue: (tasks, opts) => queue.setTasks(tasks, opts),
    queueStatus: () => queue.status(),
    clearQueue: () => queue.clear(),
    // 模型请求期间暂停普通队列；urgent 规则（本地短窗口救场）仍执行。
    setQueueThinking: (v) => { queue.setThinking(v); return { ok: true, thinking: !!v }; },
    // 模型对本地微决策回 yes/no/other；yes 才执行对应 action，no 只跳过。
    decide: async (id, choice, reason) => {
      const key = String(id || '');
      const d = decisionStore.get(key);
      if (!d) return { ok: false, code: 'NO_DECISION', reason: 'decision 不存在或已被清理' };
      if (Date.now() > Number(d.expiresAt)) {
        decisionStore.delete(key);
        return { ok: false, code: 'STALE_DECISION', id: key, reason: 'decision 已过期' };
      }
      const now = snapshot();
      if (now && now.stateVersion && d.stateVersion && now.stateVersion !== d.stateVersion) {
        decisionStore.delete(key);
        return {
          ok: false, code: 'STALE_DECISION', id: key,
          reason: `局面已变化（${d.stateVersion} → ${now.stateVersion}）`,
          currentStateVersion: now.stateVersion,
        };
      }
      const c = String(choice || '').toLowerCase();
      if (['no', 'skip', 'b'].includes(c)) {
        decisionStore.delete(key);
        return { ok: true, id: key, choice: 'no', skipped: true, reason: reason || null };
      }
      if (c === 'other') {
        decisionStore.delete(key);
        return { ok: true, id: key, choice: 'other', skipped: true, hint: '用 pvz_act 自己下动作' };
      }
      if (!['yes', 'a', 'accept', 'ok'].includes(c)) {
        return { ok: false, code: 'BAD_CHOICE', id: key, choice: String(choice || ''), reason: 'choice 只能是 yes/no/other' };
      }
      decisionStore.delete(key);
      const r = await actions.act(d.action);
      return {
        ok: !(r && r.ok === false), id: key, choice: 'yes',
        action: d.action, result: r,
      };
    },
    // 测试/调试用：手动推进一拍；正常游戏由 450ms timer 自己跑。
    queueTick: () => queue.tick(),
    events: (limit) => eventsApi.events(limit),
    pollEvents: (limit) => eventsApi.pollEvents(limit),
    eventStatus: () => eventsApi.status(),
    setEventSampler: (ms) => eventsApi.setEventSampler(ms),
    setPlan: (plan) => {
      const gate = knowledgeGateFail();
      if (gate) return gate;
      const r = planStore.setPlan(plan);
      if (r && r.ok) {
        if (!r.plan) queue.clear();
        else {
          // rules 是“当局本地规则”：开局由模型写好，交给 450ms 队列抢短窗口。
          // 它和 queue 共用同一个执行器；rules 默认 repeat + oncePerWave/cooldownSec 限频。
          const ruleTasks = Array.isArray(r.plan.rules)
            ? r.plan.rules.map((rule, i) => {
              const doObj = { ...((rule && rule.do) || {}) };
              const limits = (rule && rule.limits) || {};
              const when = (rule && (rule.when || rule.cond)) || {};
              if (!doObj || !doObj.type) return null;
              // 模型经常只写 lane:'airborne' 不写 column；默认 back（c0），否则整条规则无法定位。
              if ((doObj.type === 'plant' || doObj.type === 'replace') && doObj.column == null) doObj.column = 'back';
              if (doObj.lane == null) doObj.lane = /blover/i.test(String(doObj.plant || '')) ? 'airborne' : 'danger';
              return {
                id: (rule && rule.id) || `rule-${i + 1}`,
                ...doObj,
                cond: { ...when },
                validForSec: limits.validForSec != null ? limits.validForSec : (rule && rule.validForSec),
                repeat: true,
                cooldownSec: limits.cooldownSec != null ? limits.cooldownSec : (rule && rule.cooldownSec),
                oncePerWave: !!(limits.oncePerWave != null ? limits.oncePerWave : (rule && rule.oncePerWave)),
                // 规则默认 urgent：模型思考期间也允许执行，用来抢三叶草这类短窗口。
                urgent: limits.urgent != null ? !!limits.urgent : (rule && rule.urgent != null ? !!rule.urgent : true),
                onFail: (rule && rule.onFail) || 'retry',
                priority: (rule && rule.priority),
              };
            }).filter(Boolean)
            : null;
          const hasRules = Array.isArray(r.plan.rules);
          if (Array.isArray(r.plan.queue) || hasRules) {
            // 队列里用 card 下标的旧任务，入队时能解析就转成 codename；
            // 解析不了的留给队列报 NO_CARD 并丢弃，避免选卡后下标漂移种错卡。
            let s = null;
            try { s = snapshot(); } catch { s = null; }
            const cards = (s && s.cards) || [];
            const tasks = [...(Array.isArray(r.plan.queue) ? r.plan.queue : []), ...(ruleTasks || [])].map((t) => {
              if (!t || typeof t !== 'object' || t.plant != null || t.card == null) return t;
              const c = cards[Number(t.card)];
              return c && c.type ? { ...t, plant: c.type } : t;
            });
            queue.setTasks(tasks, {
              // 有规则时把本地拍加快到 200ms，给三叶草这类 0.5–1s 窗口留出手速。
              tickMs: (ruleTasks && ruleTasks.length)
                ? Math.min(Number(r.plan.queueTickMs) || 450, 200)
                : r.plan.queueTickMs,
              pausedUntil: r.plan.queuePausedUntil,
            });
          }
        }
      }
      return r;
    },
    getPlan: () => planStore.getPlan(),
    chooseDeck: async (cards, replace) => {
      // 想换上的卡必须先查过图鉴（先定对策，再查需要的那几张）。
      const gate = knowledgeGateFail(cards);
      if (gate) return gate;
      const r = await actions.chooseDeck(cards, replace);
      // 选完卡立刻把新卡组的 coverageGaps 带回去，避免模型拿选卡前的缺口当结论。
      if (r && r.ok) {
        try {
          const s = snapshot();
          if (s && s.ok !== false) {
            r.deck = s.deck;
            r.coverageGaps = s.brief && s.brief.coverageGaps;
            r.deckCapabilities = s.brief && s.brief.deckCapabilities;
          }
        } catch { /* ignore */ }
      }
      return r;
    },
    deckStatus: () => actions.deckStatus(),
    startLevel: () => {
      const gate = knowledgeGateFail();
      if (gate) return gate;
      return actions.startLevel();
    },
    restartLevel: async () => {
      const r = await actions.restartLevel();
      if (r && r.ok !== false) resetPlanState();
      return r;
    },
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
      try { queue.dispose(); } catch { /* ignore */ }
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

