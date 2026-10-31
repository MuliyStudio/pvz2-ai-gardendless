import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup() {
  resetAssetCache();
  const game = createFakeGame({ slots: 3 });
  const bridge = createBridge(game.ctx);
  const router = createToolRouter({ bridge, version: '0.1.22' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('state.plants 带 foodable，给豆调用 food() 并扣掉一颗', async () => {
  const { game, bridge } = setup();
  try {
    const plant = game.grid[0][0].addPlant('peashooter');
    const before = bridge.snapshot();
    assert.equal(before.plants[0].foodable, true);
    assert.equal(before.plantFoodUsable, 1);

    const r = await bridge.act({ type: 'plant_food', lane: 0, column: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.type, 'peashooter');
    assert.equal(r.foodLeft, 0);
    assert.equal(plant.foodCalls, 1);
    assert.equal(game.food.plantFoodNum, 0);

    // food() 之后 fooding=true，不能再吃豆
    const after = bridge.snapshot();
    assert.equal(after.plants[0].foodable, false);
    assert.equal(after.plantFoodUsable, 0);
    game.food.plantFoodNum = 1;
    const again = await bridge.act({ type: 'plant_food', lane: 0, column: 0 });
    assert.equal(again.code, 'NOT_FOODABLE');
  } finally { teardown(bridge); }
});

test('同格有花盆时选真正能吃豆的植物', async () => {
  const { game, bridge } = setup();
  try {
    // 模拟花盆先入格、植物后入格：不能拿到 p.foodable === false 的花盆
    game.grid[0][1].plantInSquare.push({ Plant_Type: 'floawerPot', health: 300, toughness: 300, foodable: false });
    const plant = game.grid[0][1].addPlant('sunflower');

    const r = await bridge.act({ type: 'plant_food', lane: 0, column: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.type, 'sunflower');
    assert.equal(plant.foodCalls, 1);
  } finally { teardown(bridge); }
});

test('空格 / 只有花盆 / 没豆 返回真实 code', async () => {
  const { game, bridge } = setup();
  try {
    const empty = await bridge.act({ type: 'plant_food', lane: 2, column: 2 });
    assert.equal(empty.code, 'NO_PLANT');

    game.grid[0][2].plantInSquare.push({ Plant_Type: 'floawerPot', health: 300, toughness: 300, foodable: false });
    const pot = await bridge.act({ type: 'plant_food', lane: 0, column: 2 });
    assert.equal(pot.code, 'NOT_FOODABLE');
    assert.deepEqual(pot.plants, ['floawerPot']);

    game.food.plantFoodNum = 0;
    game.grid[0][3].addPlant('peashooter');
    const noFood = await bridge.act({ type: 'plant_food', lane: 0, column: 3 });
    assert.equal(noFood.code, 'NO_FOOD');
    assert.equal(noFood.have, 0);
  } finally { teardown(bridge); }
});

test('pvz_plant_food 和 pvz_act.plant_food 都能走通', async () => {
  const { game, bridge, router } = setup();
  try {
    game.grid[1][1].addPlant('peashooter');
    game.grid[2][1].addPlant('wallnut');
    game.food.plantFoodNum = 2;

    const one = await router.call('pvz_plant_food', { lane: 1, column: 1 });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(one.foodLeft, 1);

    const batch = await router.call('pvz_act', { actions: [{ type: 'plant_food', lane: 2, column: 1 }] });
    assert.equal(batch.ok, true, JSON.stringify(batch));
    assert.equal(batch.results[0].ok, true);
    assert.equal(batch.results[0].foodLeft, 0);
  } finally { teardown(bridge); }
});

test('能量豆上限：state 带 plantFoodMax/plantFoodFull，满豆时明确标出来', () => {
  const { game, bridge } = setup();
  try {
    game.food.plantFoodNum = 5;
    const full = bridge.snapshot();
    assert.equal(full.plantFoodMax, 5);
    assert.equal(full.plantFoodFull, true);

    game.food.plantFoodNum = 2;
    const mid = bridge.snapshot();
    assert.equal(mid.plantFoodFull, false);

    // briefing 的 facts 里也要有（选卡/开局就要知道上限）
    const b = bridge.briefing();
    if (b && b.ok) {
      assert.equal(b.facts.plantFoodMax, 5);
      assert.equal(b.facts.plantFoodFull, false);
    }
  } finally { teardown(bridge); }
});

test('能量豆：菜问范围里没有僵尸 → FOOD_NO_TARGET，并给出最近僵尸的位置', async () => {
  resetAssetCache();
  const game = createFakeGame({ slots: 3, zombies: [{ lane: 0, column: 6, health: 500, type: 'tutorial' }] });
  const bridge = createBridge(game.ctx);
  try {
    game.grid[0][0].addPlant('bonkchoy');
    const s = bridge.snapshot();
    const p = s.plants.find((x) => x.type === 'bonkchoy');
    assert.equal(p.food.kind, 'self_aoe_multi');
    assert.equal(p.food.radius, 1);
    assert.equal(p.food.total, 1500);
    assert.equal(p.food.targets, 0);
    assert.equal(p.food.whiff, true);

    const r = await bridge.act({ type: 'plant_food', lane: 0, column: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FOOD_NO_TARGET');
    assert.equal(r.plantFood.kind, 'self_aoe_multi');
    assert.equal(r.nearestZombie.column, 6);
    assert.equal(game.food.plantFoodNum, 1, '被拦下时不能扣豆');
  } finally { teardown(bridge); }
});

test('能量豆：僵尸进入范围后可以正常给；force=true 也允许强制浪费', async () => {
  resetAssetCache();
  const game = createFakeGame({ slots: 3, zombies: [{ lane: 0, column: 1, health: 500, type: 'tutorial' }] });
  const bridge = createBridge(game.ctx);
  try {
    const plant = game.grid[0][0].addPlant('bonkchoy');
    const s = bridge.snapshot();
    assert.equal(s.plants[0].food.targets, 1);
    const plan = s.brief.plantFoodPlan.find((x) => x.type === 'bonkchoy');
    assert.equal(plan.targets, 1);

    const r = await bridge.act({ type: 'plant_food', lane: 0, column: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(plant.foodCalls, 1);
  } finally { teardown(bridge); }

  // force：范围内没僵尸也允许（返回 ok，豆被扣掉）
  resetAssetCache();
  const game2 = createFakeGame({ slots: 3 });
  const bridge2 = createBridge(game2.ctx);
  try {
    const plant = game2.grid[0][0].addPlant('bonkchoy');
    const blocked = await bridge2.act({ type: 'plant_food', lane: 0, column: 0 });
    assert.equal(blocked.code, 'FOOD_NO_TARGET');
    const forced = await bridge2.act({ type: 'plant_food', lane: 0, column: 0, force: true });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(plant.foodCalls, 1);
    assert.equal(game2.food.plantFoodNum, 0);
  } finally { teardown(bridge2); }
});

test('能量豆：本行连射型（barrage）只要本行前方有僵尸就允许', async () => {
  resetAssetCache();
  const game = createFakeGame({ slots: 3, zombies: [{ lane: 1, column: 7, health: 500, type: 'tutorial' }] });
  const bridge = createBridge(game.ctx);
  try {
    game.grid[1][0].addPlant('cabbagepult');
    const s = bridge.snapshot();
    assert.equal(s.plants[0].food.kind, 'lob_barrage');
    assert.equal(s.plants[0].food.area, 'row');
    assert.equal(s.plants[0].food.targets, 1);
    const r = await bridge.act({ type: 'plant_food', lane: 1, column: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { teardown(bridge); }
});

