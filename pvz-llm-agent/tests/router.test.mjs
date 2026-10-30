import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { TOOLS, TOOL_NAMES } from '../tools/definitions.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup(opts) {
  resetAssetCache();
  const game = createFakeGame(opts);
  const bridge = createBridge(game.ctx);
  const router = createToolRouter({ bridge, version: '0.1.13' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('工具契约：名字唯一、每个工具都有 inputSchema', () => {
  assert.equal(TOOLS.length, 16);
  assert.equal(new Set(TOOL_NAMES).size, TOOLS.length);
  for (const t of TOOLS) {
    assert.ok(t.name.startsWith('pvz_'), t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  for (const bad of ['pvz_auto_deck', 'pvz_suggest_deck', 'pvz_set_strategy', 'pvz_queue']) {
    assert.ok(!TOOL_NAMES.includes(bad), `不应注册 ${bad}`);
  }
});

test('router: 选卡 / 种植（按 codename 解析）/ 状态', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    const deck = await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    assert.equal(deck.ok, true, JSON.stringify(deck));
    assert.equal(deck.actualDeck.length, 3);

    const act = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'sunflower', lane: 0, column: 0 }] });
    assert.equal(act.ok, true, JSON.stringify(act));
    assert.equal(act.results[0].card, 0);

    const state = await router.call('pvz_state', {});
    assert.equal(state.ok, true);
    assert.equal(state.plants.length, 1);
  } finally { teardown(bridge); }
});

test('router: 卡不在卡组时不执行并返回 CARD_NOT_IN_DECK', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    const r = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'cherry_bomb', lane: 0, column: 0 }] });
    assert.equal(r.ok, false);
    assert.equal(r.results[0].code, 'CARD_NOT_IN_DECK');
    assert.equal(bridge.snapshot().plants.length, 0);
  } finally { teardown(bridge); }
});

test('router: wait_until 立即满足 / 超时 / 非法条件', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    const ok = await router.call('pvz_wait_until', { until: 'sun>=100', timeout: 1 });
    assert.equal(ok.ok, true);
    assert.equal(ok.satisfied, true);

    const bad = await router.call('pvz_wait_until', { until: 'not-a-condition', timeout: 1 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'BAD_CONDITION');

    const timeout = await router.call('pvz_wait_until', { until: 'sun>=9999', timeout: 1 });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.code, 'TIMEOUT');
    assert.equal(timeout.satisfied, false);
    assert.ok(timeout.state);
  } finally { teardown(bridge); }
});

test('router: start_level 后轮询到 running', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    const r = await router.call('pvz_start_level', { timeout: 3 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.phase, 'running');
    assert.equal(bridge.snapshot().phase, 'running');
    const st = await router.call('pvz_state', {});
    assert.equal(st.seedSelection, null, '战斗中不再携带完整卡池');
    assert.ok(st.cards.length > 0);
  } finally { teardown(bridge); }
});

test('router: health 带工具清单和版本', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    const h = await router.call('pvz_health', {});
    assert.equal(h.ok, true);
    assert.equal(h.tools.length, 16);
    assert.equal(h.namespace, 'pvz-llm-agent');
    assert.equal(h.serverVersion, '0.1.13');
  } finally { teardown(bridge); }
});

test('router: set_plan 保存并从 state 回显', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    const plan = { style: '自定义', lanes: [{ lane: 0, role: '输出' }] };
    const r = await router.call('pvz_set_plan', { plan });
    assert.equal(r.ok, true);
    const s = await router.call('pvz_state', {});
    assert.deepEqual(s.plan, plan);
  } finally { teardown(bridge); }
});

test('router: pvz_state.changesSinceLast 报出植物新增与损失', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'] });

    // 首次读取没有基线，不应编造 diff
    const s1 = await router.call('pvz_state', {});
    assert.equal(s1.ok, true, JSON.stringify(s1));
    assert.equal(s1.changesSinceLast, undefined);

    // 状态没变
    const s2 = await router.call('pvz_state', {});
    assert.ok(s2.changesSinceLast, '第二次读取应带 changesSinceLast');
    assert.equal(s2.changesSinceLast.none, true, JSON.stringify(s2.changesSinceLast));

    // 场上来一株
    game.grid[1][2].addPlant('sunflower');
    const s3 = await router.call('pvz_state', {});
    assert.equal(s3.changesSinceLast.none, false);
    assert.ok(
      s3.changesSinceLast.plantsAdded.some((p) => p.lane === 1 && p.column === 2 && p.type === 'sunflower'),
      JSON.stringify(s3.changesSinceLast),
    );
    assert.equal(s3.changesSinceLast.plantsLost.length, 0);

    // 被吃掉（这正是之前模型发现不了的情况）
    game.grid[1][2].removePlant();
    const s4 = await router.call('pvz_state', {});
    assert.equal(s4.changesSinceLast.none, false);
    assert.ok(
      s4.changesSinceLast.plantsLost.some((p) => p.lane === 1 && p.column === 2 && p.type === 'sunflower'),
      JSON.stringify(s4.changesSinceLast),
    );
    assert.equal(s4.changesSinceLast.plantsAdded.length, 0);
  } finally { teardown(bridge); }
});

test('router: plant 传 cells 批量落点，遇冷却自动等 retryAfter', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    const realAct = bridge.act;
    let calls = 0;
    bridge.act = async (a) => {
      calls += 1;
      // 第一枪故意回冷却，验证工具会等待重试而不是把 COOLDOWN 甩给模型
      if (calls === 1) return { ok: false, code: 'COOLDOWN', retryAfter: 0.2, type: a.plant, card: a.card };
      return realAct(a);
    };
    const r = await router.call('pvz_act', {
      actions: [{ type: 'plant', plant: 'sunflower', cells: [{ lane: 0, column: 0 }, { lane: 1, column: 0 }] }],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.results[0].okCount, 2, JSON.stringify(r.results[0]));
    assert.equal(r.results[0].cells[0].retries, 1);
    assert.equal(bridge.snapshot().plants.length, 2);
  } finally { teardown(bridge); }
});

test('router: plant cells 遇到阳光不足就停手，不空转', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    // 假游戏不会自己扣阳光，这里手动扣，模拟真实“种完就没钱”
    for (const row of game.grid) {
      for (const c of row) {
        const orig = c.PlaceUIPlant.bind(c);
        c.PlaceUIPlant = () => { game.sun.CurrentValue -= 100; orig(); };
      }
    }
    game.sun.CurrentValue = 150;
    const r = await router.call('pvz_act', {
      actions: [{ type: 'plant', plant: 'sunflower', cells: [{ lane: 0, column: 0 }, { lane: 1, column: 0 }, { lane: 2, column: 0 }] }],
    });
    assert.equal(r.ok, false);
    assert.ok(r.results[0].cells.some((c) => c.code === 'SUN'), JSON.stringify(r.results[0]));
    assert.equal(bridge.snapshot().plants.length, 1, '只种下买得起的那一株');
  } finally { teardown(bridge); }
});

test('router: pvz_restart 重开本关回到选卡阶段', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    const start = await router.call('pvz_start_level', {});
    assert.equal(start.ok, true, JSON.stringify(start));
    assert.equal(bridge.snapshot().phase, 'running');

    const r = await router.call('pvz_restart', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.restarted, true);
    assert.equal(game.pauseScreen.restarts, 1);
    const s = bridge.snapshot();
    assert.equal(s.phase, 'preparing');
    assert.equal(s.plants.length, 0);
  } finally { teardown(bridge); }
});
