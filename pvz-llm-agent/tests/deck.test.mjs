import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, BRIDGE_VERSION } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup(opts) {
  resetAssetCache();
  const game = createFakeGame(opts);
  const bridge = createBridge(game.ctx);
  return { game, bridge };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('chooseDeck 逐张等待异步 UI 同步，最终 3/3', async () => {
  const { bridge } = setup({ slots: 3, asyncAddMs: 40 });
  try {
    const r = await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slots, 3);
    assert.deepEqual(r.actualDeck.sort(), ['peashooter', 'sunflower', 'wallnut']);
    assert.equal(r.applied.length, 3);
    assert.equal(r.full, true);
    assert.equal(bridge.snapshot().deck.length, 3);
  } finally { teardown(bridge); }
});

test('chooseDeck 不足槽位返回 DECK_NOT_FULL，且不自动补卡', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    const r = await bridge.chooseDeck(['sunflower', 'peashooter'], true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DECK_NOT_FULL');
    assert.equal(r.missing, 1);
    assert.equal(game.cards.CFs.length, 0, '校验失败时不应改卡组');
  } finally { teardown(bridge); }
});

test('chooseDeck 卡不在卡池返回 CARD_NOT_AVAILABLE + available', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const r = await bridge.chooseDeck(['sunflower', 'nope', 'wallnut'], true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CARD_NOT_AVAILABLE');
    assert.deepEqual(r.cards, ['nope']);
    assert.ok(r.available.includes('sunflower'));
  } finally { teardown(bridge); }
});

test('chooseDeck 重复卡返回 BAD_DECK', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const r = await bridge.chooseDeck(['sunflower', 'sunflower', 'wallnut'], true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_DECK');
    assert.deepEqual(r.duplicates, ['sunflower']);
  } finally { teardown(bridge); }
});

test('chooseDeck 超过卡槽返回 BAD_DECK', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const r = await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut', 'cherry_bomb'], true);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_DECK');
    assert.equal(r.count, 4);
  } finally { teardown(bridge); }
});

test('act 返回真实结果：种植 / 占用 / 冷却 / 阳光 / 格子不可种', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    const plant = await bridge.act({ type: 'plant', card: 0, lane: 0, column: 0 });
    assert.equal(plant.ok, true, JSON.stringify(plant));
    assert.equal(plant.type, 'sunflower');

    const dup = await bridge.act({ type: 'plant', card: 0, lane: 0, column: 0 });
    assert.equal(dup.code, 'OCCUPIED');

    game.cards.cardsUIUpper[0] = { CD: 2.5 };
    const cd = await bridge.act({ type: 'plant', card: 0, lane: 1, column: 0 });
    assert.equal(cd.code, 'COOLDOWN');
    assert.equal(cd.retryAfter, 2.5);

    game.cards.cardsUIUpper[0] = { CD: 0 };
    game.sun.CurrentValue = 10;
    const sun = await bridge.act({ type: 'plant', card: 1, lane: 1, column: 0 });
    assert.equal(sun.code, 'SUN');
    assert.equal(sun.need, 100);

    game.sun.CurrentValue = 500;
    game.grid[2][2].putPlantAvailable = () => false;
    const blocked = await bridge.act({ type: 'plant', card: 0, lane: 2, column: 2 });
    assert.equal(blocked.code, 'CELL_BLOCKED');
    assert.ok(bridge.snapshot().blockedCells.some((b) => b.lane === 2 && b.column === 2));
  } finally { teardown(bridge); }
});

test('act 对“已发起但未落地”返回 pending，不再报红色错误', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    game.grid[0][0].PlaceUIPlant = function PlaceUIPlant() {
      this.spawningPromiseCount = (this.spawningPromiseCount || 0) + 1;
      // 故意不把植物塞进格子里：模拟异步落地/一次性植物已触发
    };
    const r = await bridge.act({ type: 'plant', card: 0, lane: 0, column: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pending, true);
    assert.equal(r.settled, false);
    assert.equal(r.code, undefined);
  } finally { teardown(bridge); }
});

test('actAll 部分失败不抛异常，并返回每个动作的真实 code', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    const r = await bridge.actAll([
      { type: 'wait' },
      { type: 'shovel', lane: 0, column: 5 },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.okCount, 1);
    assert.equal(r.failCount, 1);
    assert.equal(r.results[1].code, 'EMPTY');
  } finally { teardown(bridge); }
});
