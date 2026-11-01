import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
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

function start(game) {
  game.levelController.gameStarted = true;
  game.cards.gameStarted = true;
}

function wallGap(s, lane) {
  return (s.threatGaps || []).find((g) => g.kind === 'wall' && Number(g.lane) === Number(lane));
}

test('matrix：normal 关的地形/墓碑/轨道/水面事实通用读取', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 6 }],
  });
  try {
    game.grid[0][3].haveTomb = true;
    game.grid[1][2].rail = true;
    game.grid[2][2].squareType = 2; // water
    game.grid[3][5].vases = [{}];
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    const s = await bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.ok(s.terrain.map[2].includes('W'), JSON.stringify(s.terrain.map));
    assert.ok(s.obstacles.some((o) => o.type === 'tomb' && o.lane === 0 && o.column === 3), JSON.stringify(s.obstacles));
    assert.ok(s.obstacles.some((o) => o.type === 'rail' && o.lane === 1 && o.column === 2), JSON.stringify(s.obstacles));
    assert.ok(s.obstacles.some((o) => o.type === 'vase' && o.lane === 3 && o.column === 5), JSON.stringify(s.obstacles));
    assert.ok(s.lanes[0].tombColumns.includes(3), JSON.stringify(s.lanes[0]));
    assert.ok(wallGap(s, 0), JSON.stringify(s.threatGaps));
  } finally { teardown(bridge); }
});

test('matrix：night 关从 LawnProps 识别，不靠关卡名', async () => {
  const { game, bridge } = setup({ slots: 3, night: true });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    const s = await bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.ok((s.mechanics || []).some((m) => m.id === 'night'), JSON.stringify(s.mechanics));
  } finally { teardown(bridge); }
});

test('matrix：protect 行进入 protectCells，不依赖特定关卡代码', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    game.scene._components.push({
      __classname__: 'flowerLine', lIndex: 1, cIndex: 4, tip: 'protect me',
    });
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    const s = await bridge.snapshot();
    assert.ok((s.protectCells || []).some((c) => Number(c.lane) === 1 && Number(c.column) === 4),
      JSON.stringify(s.protectCells));
  } finally { teardown(bridge); }
});

test('matrix：air/boss 通过 zombie tag 生成 capability threatGaps', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'seagull', health: 190, column: 6 }],
  });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    const s = await bridge.snapshot();
    assert.ok(s.zombies[0].tags.includes('flying'), JSON.stringify(s.zombies[0]));
    assert.ok((s.threatGaps || []).some((g) => g.kind === 'capability' && g.requiredCapability === 'anti_air'),
      JSON.stringify(s.threatGaps));
  } finally { teardown(bridge); }

  const boss = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'gargantuar', health: 3000, column: 6 }],
  });
  try {
    await boss.bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(boss.game);
    const s = await boss.bridge.snapshot();
    assert.ok(s.zombies[0].tags.includes('gargantuar'), JSON.stringify(s.zombies[0]));
    assert.ok((s.threatGaps || []).some((g) => g.kind === 'capability'), JSON.stringify(s.threatGaps));
  } finally { teardown(boss.bridge); }
});

test('matrix：conveyor / forced_deck / preplant 三种准备模式都不崩', async () => {
  const conveyor = setup({ slots: 3, conveyor: true });
  try {
    start(conveyor.game);
    const s = await conveyor.bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.prep.mode, 'conveyor', JSON.stringify(s.prep));
    assert.ok(Array.isArray(s.cards) && s.cards.length > 0, JSON.stringify(s.cards));
  } finally { teardown(conveyor.bridge); }

  const forced = setup({ slots: 3, forcedDeck: true });
  try {
    const s = await forced.bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.prep.mode, 'forced_deck', JSON.stringify(s.prep));
    assert.equal(s.deck.length, 3);
  } finally { teardown(forced.bridge); }

  const pre = setup({ slots: 3, preplant: true });
  try {
    const s = await pre.bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.prep.mode, 'preplant', JSON.stringify(s.prep));
    assert.equal(s.prep.gameStarted, false);
  } finally { teardown(pre.bridge); }
});

test('matrix：preparing 写的 queue 在每个模式下都不因 phase 变化 stale', async () => {
  const cases = [
    { name: 'normal', opts: { slots: 3 } },
    { name: 'conveyor', opts: { slots: 3, conveyor: true } },
    { name: 'forced_deck', opts: { slots: 3, forcedDeck: true } },
  ];
  const rows = [];
  for (const c of cases) {
    const { game, bridge } = setup(c.opts);
    try {
      if (c.name === 'normal') await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
      const s0 = await bridge.snapshot();
      const version = s0.stateVersion;
      await bridge.setPlan({
        text: `matrix ${c.name}`,
        queueTickMs: 2000,
        queue: [{ id: `q-${c.name}`, type: 'plant', plant: 'sunflower', lane: 0, column: 0, stateVersion: version }],
      });
      start(game);
      await bridge.queueTick();
      const s = await bridge.snapshot();
      rows.push({ name: c.name, ok: s.ok, stale: s.queue.stats.stale, pending: s.queue.pending });
      assert.equal(s.ok, true, c.name);
      assert.equal(s.queue.stats.stale, 0, `${c.name}: ${JSON.stringify(s.queue)}`);
    } finally { teardown(bridge); }
  }
  console.log('[level-matrix]', JSON.stringify(rows));
});
