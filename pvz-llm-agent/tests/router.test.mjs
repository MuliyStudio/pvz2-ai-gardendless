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
  const router = createToolRouter({ bridge, version: '0.1.19' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('工具契约：名字唯一、每个工具都有 inputSchema', () => {
  assert.equal(TOOLS.length, 18);
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
    assert.ok(act.state && act.state.ok !== false, 'pvz_act 要带回动作后的 state');
    assert.equal(act.state.plants.length, 1);
    assert.equal(act.state.board, undefined, '默认状态不带棋盘，省 token');

    const dup = await router.call('pvz_state', {});
    assert.equal(dup.ok, true);
    assert.equal(dup.duplicate, true, '刚 act 过，紧接着的 pvz_state 应去重');

    const state = await router.call('pvz_state', { force: true });
    assert.equal(state.ok, true);
    assert.equal(state.plants.length, 1);
    assert.equal(state.board, undefined, 'pvz_state 默认精简');
    const full = await router.call('pvz_state', { full: true });
    assert.ok(Array.isArray(full.board) && full.board.length === 5, 'full=true 返回完整棋盘');
  } finally { teardown(bridge); }
});

test('router: 输出种在本行墙右侧返回 OUTPUT_IN_FRONT_OF_WALL', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    // fake-game 的 PlaceUIPlant 固定种 peashooter，这里直接放一株墙来构造场景
    game.grid[2][4].addPlant('wallnut');
    const out = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'peashooter', lane: 2, column: 5 }] });
    assert.equal(out.results[0].ok, false, JSON.stringify(out.results[0]));
    assert.equal(out.results[0].code, 'OUTPUT_IN_FRONT_OF_WALL');
    assert.equal(out.results[0].wallColumn, 4);
  } finally { teardown(bridge); }
});

test('router: 墙种在该行僵尸右侧时返回 WALL_TOO_LATE，并给左侧可种位', async () => {
  const { bridge, router } = setup({ slots: 3, zombies: [{ type: 'tutorial', lane: 2, column: 5, health: 190 }] });
  try {
    const deck = await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    assert.equal(deck.ok, true, JSON.stringify(deck));
    const r = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'wallnut', lane: 2, column: 6 }] });
    assert.equal(r.results[0].ok, false, JSON.stringify(r.results[0]));
    assert.equal(r.results[0].code, 'WALL_TOO_LATE');
    assert.ok(r.results[0].suggestedColumns.length > 0);
  } finally { teardown(bridge); }
});

test('router: 提前布阵关 start_level 不会被“已在 running”提前挡掉', async () => {
  const { game, bridge, router } = setup({ slots: 3, preplant: true });
  try {
    const before = await router.call('pvz_state', {});
    assert.equal(before.phase, 'running');
    assert.equal(before.prep.mode, 'preplant');
    const r = await router.call('pvz_start_level', {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(game.levelController.gameStarted, true);
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
    assert.equal(h.tools.length, 18);
    assert.equal(h.namespace, 'pvz-llm-agent');
    assert.equal(h.serverVersion, '0.1.19');
  } finally { teardown(bridge); }
});

test('router: set_plan 保存并从 state 回显', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    const plan = { style: '自定义', lanes: [{ lane: 0, role: '输出' }] };
    const r = await router.call('pvz_set_plan', { plan });
    assert.equal(r.ok, true);
    const s = await router.call('pvz_state', {});
    assert.equal(s.plan.style, '自定义');
    assert.equal(s.plan.text, '自定义');
    assert.equal(s.plan.schema, 'pvz-plan/v1');
    assert.equal(s.plan.lanes[0].lane, 0);
    assert.equal(s.plan.lanes[0].role, '输出');
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

test('router: 一批动作里同卡重复且基础冷却 >3.5s 时，提前返回 BATCH_COOLDOWN', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 300;
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'sunflower', lane: 0, column: 0 },
        { type: 'plant', plant: 'sunflower', lane: 1, column: 0 },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.results[0].ok, true, '第一个照常执行');
    assert.equal(r.results[1].code, 'BATCH_COOLDOWN');
    assert.equal(r.results[1].maxSuccess, 1, '告诉模型本轮最多成功几个');
    assert.ok(r.results[1].retryAfter >= 5);
    assert.equal(bridge.snapshot().plants.length, 1, '不会在同一轮里硬撞冷却');
  } finally { teardown(bridge); }
});

test('router: 同卡重复但基础冷却 ≤3.5s 时自动等冷却后仍能种下', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 300;
    // 把基础冷却压到 2s：模拟短冷却卡，预检不应拦截
    const snap = bridge.snapshot.bind(bridge);
    bridge.snapshot = () => {
      const s = snap();
      if (s && Array.isArray(s.cards)) for (const c of s.cards) c.baseCd = 2;
      return s;
    };
    const realAct = bridge.act;
    let cooling = 0;
    bridge.act = async (a) => {
      if (a.plant === 'sunflower' && cooling === 0) {
        cooling += 1;
        return { ok: false, code: 'COOLDOWN', retryAfter: 0.2, type: a.plant, card: a.card };
      }
      return realAct(a);
    };
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'sunflower', lane: 0, column: 0 },
        { type: 'plant', plant: 'sunflower', lane: 1, column: 0 },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(bridge.snapshot().plants.length, 2);
  } finally { teardown(bridge); }
});

test('router: 同一批里先种后铲同一格返回 BATCH_CONFLICT', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 400;
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'sunflower', lane: 0, column: 2 },
        { type: 'shovel', lane: 0, column: 2 },
      ],
    });
    assert.equal(r.results[1].code, 'BATCH_CONFLICT');
    assert.equal(r.results[1].conflictWith, 0);
    assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 0 && p.column === 2).length, 1, '铲除不会执行，植物还在');
  } finally { teardown(bridge); }
});

test('router: 同一批里先种墙、再把输出种到墙右侧返回 OUTPUT_IN_FRONT_OF_WALL', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 400;
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'wallnut', lane: 3, column: 4 },
        { type: 'plant', plant: 'peashooter', lane: 3, column: 5 },
      ],
    });
    assert.equal(r.results[1].code, 'OUTPUT_IN_FRONT_OF_WALL');
    assert.equal(r.results[1].wallColumn, 4);
    assert.ok(Array.isArray(r.results[1].behindCells));
  } finally { teardown(bridge); }
});

test('router: 一轮连发 3 个 20s 冷却的墙，只成功 1 个', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 900;
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'wallnut', lane: 0, column: 4 },
        { type: 'plant', plant: 'wallnut', lane: 1, column: 4 },
        { type: 'plant', plant: 'wallnut', lane: 2, column: 4 },
      ],
    });
    assert.equal(r.okCount, 1);
    assert.deepEqual(r.results.slice(1).map((x) => x.code), ['BATCH_COOLDOWN', 'BATCH_COOLDOWN']);
    assert.equal(r.results[1].maxSuccess, 1);
  } finally { teardown(bridge); }
});

test('router: 地刺种在墙后返回 SPIKE_BEHIND_WALL，墙前允许', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 500;
    game.cards.CFs.push({ Type: 'spikeweed', SUNCOST: 100, ID: 'spikeweed' });
    game.grid[2][4].addPlant('wallnut');

    const bad = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'spikeweed', lane: 2, column: 2 }] });
    assert.equal(bad.results[0].code, 'SPIKE_BEHIND_WALL', JSON.stringify(bad.results[0]));
    assert.ok(bad.results[0].suggestedColumns.includes(5), JSON.stringify(bad.results[0]));

    const good = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'spikeweed', lane: 2, column: 5 }] });
    assert.equal(good.results[0].ok, true, JSON.stringify(good.results[0]));
  } finally { teardown(bridge); }
});

test('router: 同一批先种墙、再把地刺种到墙后返回 SPIKE_BEHIND_WALL', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 900;
    game.cards.CFs.push({ Type: 'spikeweed', SUNCOST: 100, ID: 'spikeweed' });
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'wallnut', lane: 3, column: 4 },
        { type: 'plant', plant: 'spikeweed', lane: 3, column: 2 },
      ],
    });
    assert.equal(r.results[1].code, 'SPIKE_BEHIND_WALL', JSON.stringify(r.results[1]));
    assert.equal(r.results[1].wallColumn, 4);
  } finally { teardown(bridge); }
});

test('router: 长冷却（>3.5s）不干等，直接返回 COOLDOWN 让模型换卡', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 300;
    let calls = 0;
    bridge.act = async () => { calls += 1; return { ok: false, code: 'COOLDOWN', retryAfter: 12, type: 'wallnut' }; };
    const t0 = Date.now();
    const r = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'wallnut', lane: 0, column: 0 }] });
    const ms = Date.now() - t0;
    assert.equal(r.results[0].code, 'COOLDOWN');
    assert.equal(calls, 1, '长冷却不应该反复重试');
    assert.ok(ms < 1500, `不该阻塞等待，实际 ${ms}ms`);
  } finally { teardown(bridge); }
});

test('router: OCCUPIED 带同行 alternatives，方便直接换格重种', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 300;
    game.grid[1][3].addPlant('wallnut');
    const r = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'sunflower', lane: 1, column: 3 }] });
    const res = r.results[0];
    assert.equal(res.code, 'OCCUPIED');
    assert.ok(Array.isArray(res.alternatives) && res.alternatives.length > 0, JSON.stringify(res));
    assert.ok(res.alternatives.every((x) => x.lane === 1 && x.column !== 3), '候选必须是同行的其它格子');
    assert.ok(res.reason.includes('可改种'), res.reason);
  } finally { teardown(bridge); }
});

test('router: replace 一步换植（先铲后种）', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 400;
    const cell = game.grid[2][2];
    cell.addPlant('sunflower');
    cell.PlaceUIPlant = () => cell.addPlant('wallnut');
    const r = await router.call('pvz_act', { actions: [{ type: 'replace', plant: 'wallnut', lane: 2, column: 2 }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const own = bridge.snapshot().plants.filter((p) => p.lane === 2 && p.column === 2);
    assert.equal(own.length, 1, '同格只能剩一株');
    assert.equal(own[0].type, 'wallnut');
  } finally { teardown(bridge); }
});

test('router: replace 后新卡种不上时，明确告诉模型格子已经空了', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 400;
    const cell = game.grid[4][1];
    cell.addPlant('peashooter');
    cell.putPlantAvailable = () => false;
    const r = await router.call('pvz_act', { actions: [{ type: 'replace', plant: 'wallnut', lane: 4, column: 1 }] });
    const res = r.results[0];
    assert.equal(res.code, 'CELL_BLOCKED');
    assert.equal(res.emptyAfterRemoval, true, JSON.stringify(res));
    assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 4 && p.column === 1).length, 0);
  } finally { teardown(bridge); }
});

test('router: 同一批里先铲后种同一格（贴脸救急的连招）', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    game.sun.CurrentValue = 400;
    const cell = game.grid[0][1];
    cell.addPlant('sunflower');
    cell.PlaceUIPlant = () => cell.addPlant('peashooter');
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'shovel', lane: 0, column: 1 },
        { type: 'plant', plant: 'peashooter', lane: 0, column: 1 },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const own = bridge.snapshot().plants.filter((p) => p.lane === 0 && p.column === 1);
    assert.equal(own.length, 1);
    assert.equal(own[0].type, 'peashooter');
  } finally { teardown(bridge); }
});
