import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup(opts) {
  resetAssetCache();
  const game = createFakeGame(opts || { slots: 3 });
  const bridge = createBridge(game.ctx);
  const router = createToolRouter({ bridge, version: '0.1.22' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('同一批多个种植动作连续发出，最后统一等落地', async () => {
  const { game, bridge, router } = setup({ slots: 3 });
  try {
    const deck = await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    assert.equal(deck.ok, true, JSON.stringify(deck));
    game.sun.CurrentValue = 500;

    // 模拟游戏里种植是异步的：第 2 格 400ms 后才真正出现植物
    const delayed = game.grid[0][1];
    const orig = delayed.PlaceUIPlant.bind(delayed);
    delayed.PlaceUIPlant = () => { setTimeout(orig, 400); };

    const started = Date.now();
    const r = await router.call('pvz_act', {
      actions: [
        { type: 'plant', plant: 'sunflower', lane: 0, column: 0 },
        { type: 'plant', plant: 'peashooter', lane: 0, column: 1 },
        { type: 'plant', plant: 'wallnut', lane: 0, column: 2 },
      ],
    });
    const elapsed = Date.now() - started;

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.results.length, 3);
    assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
    assert.ok(r.results.every((x) => x.settled === true), JSON.stringify(r.results));
    assert.ok(elapsed < 2600, `批量种植耗时 ${elapsed}ms，应该是一次统一等待而不是逐株 1.5s`);
  } finally { teardown(bridge); }
});

test('state 给出 family / sunProducers / speed / etaToHouse', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 5 }],
  });
  try {
    game.grid[0][0].addPlant('sunflower');
    const s = await bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.plants[0].family, 'Sun');
    assert.equal(s.lanes[0].sunProducers, 1);
    assert.equal(s.zombies.length, 1);
    assert.equal(s.zombies[0].speed, 0.185);
    assert.ok(s.zombies[0].etaToHouse > 20, JSON.stringify(s.zombies[0]));
  } finally { teardown(bridge); }
});

test('种植结果带 timing：种在僵尸当前列会标 late，往前留一格不标', async () => {
  const { game, bridge, router } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 5 }],
  });
  try {
    const deck = await router.call('pvz_choose_deck', { cards: ['sunflower', 'peashooter', 'wallnut'], replace: true });
    assert.equal(deck.ok, true, JSON.stringify(deck));
    game.sun.CurrentValue = 500;

    const atZombie = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'sunflower', lane: 0, column: 5 }] });
    assert.equal(atZombie.ok, true, JSON.stringify(atZombie));
    assert.equal(atZombie.results[0].timing.late, true, JSON.stringify(atZombie.results[0]));
    assert.equal(atZombie.results[0].timing.suggestedColumn, 4, JSON.stringify(atZombie.results[0]));
    assert.match(atZombie.results[0].detail, /僵尸已到/);

    const ahead = await router.call('pvz_act', { actions: [{ type: 'plant', plant: 'wallnut', lane: 0, column: 3 }] });
    assert.equal(ahead.ok, true, JSON.stringify(ahead));
    assert.equal(ahead.results[0].timing.late, false, JSON.stringify(ahead.results[0]));
  } finally { teardown(bridge); }
});
