import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createFakeGame } from './helpers/fake-game.mjs';

function setup() {
  resetAssetCache();
  const game = createFakeGame({ slots: 3 });
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

test('queue：模型任务按 cond 执行，阳光不够先等，够了再种', async () => {
  const { game, bridge } = setup();
  try {
    const deck = await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    assert.equal(deck.ok, true, JSON.stringify(deck));
    start(game);
    game.sun.CurrentValue = 10;

    const plan = await bridge.setPlan({
      text: 'queue test',
      queueTickMs: 2000,
      queue: [{ type: 'plant', plant: 'sunflower', lane: 0, column: 0, cond: { minSun: 50, cellEmpty: true }, tag: 'econ' }],
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    await bridge.queueTick();
    assert.equal(bridge.snapshot().plants.length, 0, '阳光不够时不能种');

    game.sun.CurrentValue = 100;
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 1, JSON.stringify(s.queue));
    assert.equal(s.queue.pending, 0, '任务完成后应从队列移除');
  } finally { teardown(bridge); }
});

test('queue：不同卡、不同格可以同一拍连发，同卡仍只种一次', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 800;
    await bridge.setPlan({
      text: 'parallel queue',
      queueTickMs: 2000,
      queue: [
        { id: 'p1', type: 'plant', plant: 'sunflower', lane: 0, column: 0 },
        { id: 'p2', type: 'plant', plant: 'wallnut', lane: 1, column: 0 },
        { id: 'p3', type: 'plant', plant: 'sunflower', lane: 2, column: 0 },
      ],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 0).length, 1, '第一株向日葵');
    assert.equal(s.plants.filter((p) => p.lane === 1).length, 1, '坚果是不同卡，同一拍也要种下');
    assert.equal(s.plants.filter((p) => p.lane === 2).length, 0, '同卡向日葵不能在冷却前连发');
    assert.ok(s.queue.stats.actions >= 2, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：上一张卡失败/占格时继续试下一条任务', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.grid[0][0].addPlant('wallnut');
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'fallback queue',
      queueTickMs: 2000,
      queue: [
        { type: 'plant', plant: 'sunflower', lane: 0, column: 0, cond: { cellEmpty: true }, tag: 'occupied' },
        { type: 'plant', plant: 'sunflower', lane: 1, column: 0, cond: { cellEmpty: true }, tag: 'next' },
      ],
    });
    await bridge.queueTick();
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 1 && p.column === 0).length, 1, JSON.stringify(s.queue));
    assert.equal(s.queue.pending, 1, '被占格的 cond 任务保留，等格子空出来；本轮已遍历到第二条');
  } finally { teardown(bridge); }
});

test('queue：danger / ahead 由本地几何解析，但仍只执行模型指定的卡', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 3,
    zombies: [{ lane: 2, type: 'tutorial', health: 190, column: 4.6 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'danger queue',
      queueTickMs: 2000,
      queue: [{
        type: 'plant', plant: 'wallnut', lane: 'danger', column: 'ahead',
        cond: { zombieInLane: true, cellEmpty: true }, tag: 'wall-front',
      }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 1, JSON.stringify(s.queue));
    const p = s.plants[0];
    assert.equal(p.lane, 2, 'danger 选有僵尸的第 3 行');
    assert.equal(p.column, 3, 'ahead = 最前僵尸 c4.6 左侧一格');
  } finally { teardown(bridge); }
});

test('queue：有残敌时默认不往空行种，显式 allowIdleLane 才预布防', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 4.6 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.levelController.currentWave = 1; // wave 2/2：进入残敌收尾阶段
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'idle guard',
      queueTickMs: 2000,
      queue: [{ type: 'plant', plant: 'sunflower', lane: 1, column: 0, cond: { cellEmpty: true } }],
    });
    await bridge.queueTick();
    assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 1).length, 0, '残敌阶段默认不种空行');

    await bridge.setPlan({
      text: 'idle guard allow',
      queueTickMs: 2000,
      queue: [{ type: 'plant', plant: 'sunflower', lane: 1, column: 0, cond: { cellEmpty: true, allowIdleLane: true } }],
    });
    await bridge.queueTick();
    assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 1).length, 1, '显式允许后才预布防空行');
  } finally { teardown(bridge); }
});

test('queue：输出落在僵尸身后且右侧无目标时丢弃，不扣阳光', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 0.4 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'behind zombie',
      queueTickMs: 2000,
      queue: [{ id: 'behind1', type: 'plant', plant: 'peashooter', lane: 0, column: 2 }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 0, '第一拍不能种在已越过的僵尸身后');
    assert.equal(s.sun, 500, '失败不应扣阳光');
    assert.equal(s.queue.pending, 1, '自动改列后任务保留到下一拍');
    assert.ok(s.queue.stats.adjusted >= 1, JSON.stringify(s.queue.stats));
    assert.equal(s.queue.history[s.queue.history.length - 1].code, 'PLANT_BEHIND_ZOMBIE', JSON.stringify(s.queue.history));
    await new Promise((r) => setTimeout(r, 320));
    await bridge.queueTick();
    const s2 = bridge.snapshot();
    assert.equal(s2.plants.filter((p) => p.lane === 0 && p.column === 0).length, 1, JSON.stringify(s2.plants));
  } finally { teardown(bridge); }
});

test('queue：冰冻生菜种在僵尸身后被拒绝，不扣阳光', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 2,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 4.6 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    game.cards.CFs = [
      { Type: 'sunflower', SUNCOST: 50, ID: 'sunflower' },
      { Type: 'iceburg', SUNCOST: 0, ID: 'iceburg' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'contact behind',
      queueTickMs: 2000,
      queue: [{ id: 'ice1', type: 'plant', plant: 'iceburg', lane: 0, column: 6 }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 0, '接触触发植物不能种在已越过的僵尸身后');
    assert.equal(s.sun, 500, '失败不应扣阳光');
    assert.equal(s.queue.history[s.queue.history.length - 1].code, 'PLANT_BEHIND_ZOMBIE', JSON.stringify(s.queue.history));
  } finally { teardown(bridge); }
});

test('queue：墙后的土豆雷按 minePlan 交叉计算，允许最后防线', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 2,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 2.0 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    game.cards.CFs = [
      { Type: 'wallnut', SUNCOST: 50, ID: 'wallnut' },
      { Type: 'potatomine', SUNCOST: 25, ID: 'potatomine' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    const wall = game.grid[0][1].addPlant('wallnut');
    wall.health = 4000;
    wall.toughness = 4000;
    const before = await bridge.snapshot();
    const mp = (before.brief.minePlan || []).find((m) => m.lane === 0 && m.card === 'potatomine');
    assert.ok(mp && mp.safeColumns.includes(0), JSON.stringify(mp));
    await bridge.setPlan({
      text: 'last resort mine',
      queueTickMs: 2000,
      queue: [{ id: 'lm1', type: 'plant', plant: 'potatomine', lane: 0, column: 0 }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    const last = s.queue.history[s.queue.history.length - 1];
    assert.equal(last.ok, true, JSON.stringify(last));
    assert.equal(last.code, null, '墙后雷不应报 MINE_TOO_LATE / SPIKE_BEHIND_WALL');
    assert.equal(s.plants.filter((p) => p.lane === 0 && p.column === 0).length, 1, '墙后雷应落地');
  } finally { teardown(bridge); }
});

test('queue：写死的墙列在 WALL_TOO_LATE 后自动改用 suggestedColumns', async () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 2,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 4.6 }],
  });
  const bridge = createBridge(game.ctx);
  try {
    await bridge.chooseDeck(['sunflower', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'auto adjust wall',
      queueTickMs: 2000,
      queue: [{ id: 'aw1', type: 'plant', plant: 'wallnut', lane: 0, column: 5 }],
    });
    await bridge.queueTick();
    const q1 = bridge.queueStatus();
    assert.equal(q1.history[q1.history.length - 1].code, 'WALL_TOO_LATE', JSON.stringify(q1.history));
    assert.ok(q1.stats.adjusted >= 1, JSON.stringify(q1.stats));
    assert.equal(q1.pending, 1, '自动改列后任务应保留到下一拍');
    const col = q1.tasks[0].column;
    assert.ok(col < 5, JSON.stringify(q1.tasks[0]));

    await new Promise((r) => setTimeout(r, 320));
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 0 && p.column === col).length, 1, JSON.stringify(s.plants));
  } finally { teardown(bridge); }
});

test('queue：同一张卡冷却时只撞一次，不在一拍里连续失败', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 1000;
    await bridge.setPlan({
      text: 'card cooldown queue',
      queueTickMs: 2000,
      queue: [
        { type: 'plant', plant: 'peashooter', lane: 0, column: 1 },
        { type: 'plant', plant: 'peashooter', lane: 1, column: 1 },
        { type: 'plant', plant: 'peashooter', lane: 2, column: 1 },
      ],
    });
    await bridge.queueTick(); // 第一株成功
    game.cards.cardsUIUpper = [{ CD: 5 }, { CD: 5 }, { CD: 5 }];
    await bridge.queueTick(); // 第二株撞 COOLDOWN；第三株应被同卡冷却跳过
    const q = bridge.queueStatus();
    assert.equal(q.stats.actions, 1, JSON.stringify(q));
    assert.equal(q.stats.failures, 1, JSON.stringify(q.history));
    // 第三条任务还在队列里，但被“同卡冷却”跳过，没有在同一拍再撞一次。
    assert.equal(q.pending, 2, JSON.stringify(q.tasks));
  } finally { teardown(bridge); }
});

test('queue：preparing 写的 stateVersion 任务在 running 仍可执行', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    const version = bridge.snapshot().stateVersion;
    await bridge.setPlan({
      text: 'prepare queue',
      queueTickMs: 2000,
      queue: [{ id: 'prep1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, stateVersion: version }],
    });
    start(game);
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 1, JSON.stringify(s.queue));
    assert.equal(s.queue.stats.stale, 0, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：card 下标入队时能解析就转 codename，失效卡直接丢弃', async () => {
  const { game, bridge } = setup();
  try {
    game.cards.CFs = [{ Type: 'sunflower', SUNCOST: 50 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'card index queue',
      queueTickMs: 2000,
      queue: [{ id: 'idx1', type: 'plant', card: 0, lane: 0, column: 0 }],
    });
    assert.equal(bridge.queueStatus().tasks[0].plant, 'sunflower', JSON.stringify(bridge.queueStatus().tasks));

    await bridge.setPlan({
      text: 'bad card queue',
      queueTickMs: 2000,
      queue: [{ id: 'bad1', type: 'plant', card: 9, lane: 0, column: 1 }],
    });
    await bridge.queueTick();
    const q = bridge.queueStatus();
    assert.equal(q.pending, 0, JSON.stringify(q.tasks));
    assert.ok(q.stats.skipped >= 1, JSON.stringify(q.stats));
    assert.equal(q.history[q.history.length - 1].code, 'NO_CARD', JSON.stringify(q.history));
  } finally { teardown(bridge); }
});

test('queue：目标格已有同种植物时任务直接完成，不长期 pending', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    game.grid[0][0].addPlant('sunflower');
    await bridge.setPlan({
      text: 'already planted',
      queueTickMs: 2000,
      queue: [{ id: 'dup1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, cond: { cellEmpty: true } }],
    });
    await bridge.queueTick();
    const q = bridge.queueStatus();
    assert.equal(q.pending, 0, JSON.stringify(q.tasks));
    assert.ok(q.stats.done >= 1, JSON.stringify(q.stats));
    assert.equal(q.history[q.history.length - 1].code, 'TASK_ALREADY_PLANTED', JSON.stringify(q.history));
  } finally { teardown(bridge); }
});

test('queue：plant 任务撞到已有植物时直接丢弃，不反复 OCCUPIED', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    game.grid[0][0].addPlant('wallnut');
    await bridge.setPlan({
      text: 'occupied queue',
      queueTickMs: 2000,
      queue: [{ id: 'occ1', type: 'plant', plant: 'sunflower', lane: 0, column: 0 }],
    });
    await bridge.queueTick();
    const q = bridge.queueStatus();
    assert.equal(q.pending, 0, JSON.stringify(q.tasks));
    assert.ok(q.stats.skipped >= 1, JSON.stringify(q.stats));
    assert.equal(q.history[q.history.length - 1].code, 'TASK_OCCUPIED', JSON.stringify(q.history));
  } finally { teardown(bridge); }
});

test('queue：SPIKE_BEHIND_WALL 自动改到墙前，不长期卡队列', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    game.cards.CFs.push({ Type: 'spikeweed', SUNCOST: 100 });
    start(game);
    game.sun.CurrentValue = 1000;
    game.grid[0][4].addPlant('wallnut');
    await bridge.setPlan({
      text: 'permanent bad cell',
      queueTickMs: 2000,
      queue: [
        { id: 'spike1', type: 'plant', plant: 'spikeweed', lane: 0, column: 1 },
      ],
    });
    await bridge.queueTick();
    const q = bridge.queueStatus();
    assert.equal(q.pending, 1, '自动改到墙前，任务保留到下一拍');
    assert.ok(q.stats.adjusted >= 1, JSON.stringify(q.stats));
    const codes = q.history.map((h) => h.code);
    assert.ok(codes.includes('SPIKE_BEHIND_WALL'), JSON.stringify(codes));
    await new Promise((r) => setTimeout(r, 320));
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 0 && p.column > 4).length >= 1, true, JSON.stringify(s.plants));
  } finally { teardown(bridge); }
});

test('queue：validForSec 过期任务直接丢弃', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'expiry queue',
      queueTickMs: 2000,
      queue: [{ id: 'exp1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, validForSec: 0.01 }],
    });
    await new Promise((r) => setTimeout(r, 40));
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 0, JSON.stringify(s.queue));
    assert.equal(s.queue.pending, 0);
    assert.ok(s.queue.stats.expired >= 1, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：stateVersion 抄短/前缀不整条作废，只有明确不同的完整值才 stale', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    const v = String(bridge.snapshot().stateVersion);

    // 模型常见的两种抄写错误：只写 "1"，或把完整 hash 截成前几位。
    await bridge.setPlan({
      text: 'short version',
      queueTickMs: 2000,
      queue: [{ id: 'sv1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, stateVersion: '1' }],
    });
    await bridge.queueTick();
    assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 0).length, 1, '短 stateVersion 不应作废');

    if (v.length > 4) {
      await bridge.setPlan({
        text: 'prefix version',
        queueTickMs: 2000,
        queue: [{ id: 'sv2', type: 'plant', plant: 'sunflower', lane: 1, column: 0, stateVersion: v.slice(0, 4) }],
      });
      await bridge.queueTick();
      assert.equal(bridge.snapshot().plants.filter((p) => p.lane === 1).length, 1, 'stateVersion 前缀应视为同一局面');
    }

    await bridge.setPlan({
      text: 'real stale version',
      queueTickMs: 2000,
      queue: [{ id: 'sv3', type: 'plant', plant: 'sunflower', lane: 2, column: 0, stateVersion: 'stale-version' }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 2).length, 0, '完整且不同的 stateVersion 才 stale');
    assert.ok(s.queue.stats.stale >= 1, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：stateVersion 不匹配的旧任务不执行', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'stale queue',
      queueTickMs: 2000,
      queue: [{ id: 'old1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, stateVersion: 'old-version' }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.length, 0, JSON.stringify(s.queue));
    assert.equal(s.queue.pending, 0);
    assert.ok(s.queue.stats.stale >= 1, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：priority 只按模型写的值排序，id 重复不二次执行', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'priority queue',
      queueTickMs: 2000,
      queue: [
        { id: 'low', type: 'plant', plant: 'sunflower', lane: 0, column: 0, priority: 0 },
        { id: 'high', type: 'plant', plant: 'sunflower', lane: 1, column: 0, priority: 10 },
      ],
    });
    const q = bridge.queueStatus();
    assert.equal(q.tasks[0].id, 'high', JSON.stringify(q.tasks));
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.plants.filter((p) => p.lane === 1 && p.column === 0).length, 1, JSON.stringify(s.queue));

    // 同一 id 再提交一次：已执行过，直接跳过。
    await bridge.setPlan({
      text: 'priority queue',
      queueTickMs: 2000,
      queue: [{ id: 'high', type: 'plant', plant: 'sunflower', lane: 2, column: 0 }],
    });
    await bridge.queueTick();
    const s2 = bridge.snapshot();
    assert.equal(s2.plants.filter((p) => p.lane === 2 && p.column === 0).length, 0, JSON.stringify(s2.queue));
    assert.ok(s2.queue.stats.skipped >= 1, JSON.stringify(s2.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：onFail=skip 失败后丢弃，不每拍重试', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    game.grid[0][0].addPlant('wallnut');
    await bridge.setPlan({
      text: 'skip queue',
      queueTickMs: 2000,
      queue: [{ id: 'skip1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, cond: { cellEmpty: true }, onFail: 'skip' }],
    });
    // cond 不满足时任务保留；把 cond 去掉，让执行层真正撞 OCCUPIED。
    await bridge.setPlan({
      text: 'skip queue',
      queueTickMs: 2000,
      queue: [{ id: 'skip1', type: 'plant', plant: 'sunflower', lane: 0, column: 0, onFail: 'skip' }],
    });
    await bridge.queueTick();
    const s = bridge.snapshot();
    assert.equal(s.queue.pending, 0, JSON.stringify(s.queue));
    assert.ok(s.queue.stats.skipped >= 1, JSON.stringify(s.queue.stats));
  } finally { teardown(bridge); }
});

test('queue：清空计划/队列后停止，不再执行', async () => {
  const { game, bridge } = setup();
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    start(game);
    game.sun.CurrentValue = 500;
    await bridge.setPlan({
      text: 'clear queue',
      queueTickMs: 2000,
      queue: [{ type: 'plant', plant: 'sunflower', lane: 0, column: 0 }],
    });
    const cleared = await bridge.clearQueue();
    assert.equal(cleared.ok, true);
    await bridge.queueTick();
    assert.equal(bridge.snapshot().plants.length, 0);
    assert.equal(bridge.queueStatus().enabled, false);
  } finally { teardown(bridge); }
});
