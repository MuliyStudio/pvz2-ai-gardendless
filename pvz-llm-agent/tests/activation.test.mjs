import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup(opts) {
  resetAssetCache();
  const game = createFakeGame({ slots: 3, ...(opts || {}) });
  const bridge = createBridge(game.ctx);
  const router = createToolRouter({ bridge, version: '0.1.28' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('state 里点击卡带 activation/aim，brief.activatePlan 给出可直接点的位置', () => {
  const { game, bridge } = setup({ zombies: [{ lane: 0, column: 6, health: 190, type: 'tutorial' }] });
  try {
    game.grid[0][2].addPlant('coconutcannon');
    const s = bridge.snapshot();
    const p = s.plants.find((x) => x.type === 'coconutcannon');
    assert.equal(p.activation, 'click');
    assert.equal(p.aim, 'lane');
    const plan = s.brief.activatePlan.find((x) => x.type === 'coconutcannon');
    assert.ok(plan, JSON.stringify(s.brief.activatePlan));
    assert.equal(plan.lane, 0);
    assert.equal(plan.column, 2);
    assert.equal(plan.frontZombie, 6);
    assert.equal(plan.shouldAct, true);
    assert.match(String(plan.api), /^specialPlantOnMouseDown/, '要告诉模型这个版本能调哪个入口');
    assert.ok(plan.live && Object.keys(plan.live).length, '要带现场状态，模型才知道现在能不能点');
  } finally { teardown(bridge); }
});

test('activate 优先走游戏自己的点击入口 specialPlantOnMouseDown', async () => {
  const { game, bridge, router } = setup();
  try {
    const plant = game.grid[1][3].addPlant('coconutcannon');
    const r = await router.call('pvz_act', { actions: [{ type: 'activate', lane: 1, column: 3 }] });
    assert.equal(r.ok, true, JSON.stringify(r.results));
    const one = r.results[0];
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(one.via, 'specialPlantOnMouseDown');
    assert.equal(plant.activateCalls, 1);
    assert.equal(plant.fireCalls, 0, '不应该再去猜 fire()');
  } finally { teardown(bridge); }
});

test('狙击类点击卡：先进入瞄准，再用 trigger(目标格) 打出去', async () => {
  const { game, bridge } = setup();
  try {
    const plant = game.grid[2][1].addPlant('hollyknight');
    const r = await bridge.act({ type: 'activate', lane: 2, column: 1, targetLane: 1, targetColumn: 6 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.via, 'specialPlantOnMouseDown+trigger');
    assert.equal(plant.activateCalls, 1);
    assert.equal(plant.triggerCalls, 1);
    assert.deepEqual(r.target, { lane: 1, column: 6 });
  } finally { teardown(bridge); }
});

test('点不动时返回 NOT_READY + 现场状态，而不是假装成功', async () => {
  const { game, bridge } = setup();
  try {
    const plant = game.grid[0][4].addPlant('coconutcannon');
    plant.specialPlantOnMouseDown = function nope() { return false; };
    plant.sleepCD = 12.5;
    const r = await bridge.act({ type: 'activate', lane: 0, column: 4 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_READY');
    assert.equal(r.liveState.sleepCD, 12.5);
    assert.equal(plant.activateCalls, 0);
  } finally { teardown(bridge); }
});

test('没有 specialPlantOnMouseDown 时才回退到候选方法（fire）', async () => {
  const { game, bridge } = setup();
  try {
    const plant = game.grid[0][4].addPlant('coconutcannon');
    delete plant.specialPlantOnMouseDown;
    const r = await bridge.act({ type: 'activate', lane: 0, column: 4 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.via, 'fire');
    assert.equal(plant.fireCalls, 1);
  } finally { teardown(bridge); }
});

test('自动攻击的植物用 activate 返回 NOT_ACTIVATABLE（不假装成功）', async () => {
  const { game, bridge } = setup();
  try {
    game.grid[0][0].addPlant('peashooter');
    const r = await bridge.act({ type: 'activate', lane: 0, column: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_ACTIVATABLE');
    assert.equal(r.activation, 'auto');
  } finally { teardown(bridge); }
});

test('aim=free_cell 没给目标格 → NO_TARGET', async () => {
  const { game, bridge } = setup();
  try {
    game.grid[2][1].addPlant('hollyknight');
    const r = await bridge.act({ type: 'activate', lane: 2, column: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NO_TARGET');
    assert.equal(r.aim, 'free_cell');
  } finally { teardown(bridge); }
});

test('没有可调入口时返回 ACTIVATE_UNSUPPORTED + tried', async () => {
  const { game, bridge } = setup();
  try {
    const plant = game.grid[0][4].addPlant('coconutcannon');
    delete plant.specialPlantOnMouseDown;
    delete plant.fire;
    const r = await bridge.act({ type: 'activate', lane: 0, column: 4 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ACTIVATE_UNSUPPORTED');
    assert.ok(Array.isArray(r.tried));
  } finally { teardown(bridge); }
});

test('activate 对空格返回 NO_PLANT', async () => {
  const { bridge } = setup();
  try {
    const r = await bridge.act({ type: 'activate', lane: 3, column: 3 });
    assert.equal(r.code, 'NO_PLANT');
  } finally { teardown(bridge); }
});
