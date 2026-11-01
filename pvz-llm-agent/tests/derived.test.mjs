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

test('derived: short-range plants do not contribute dps to a far zombie', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 7 }],
  });
  try {
    game.grid[0][1].addPlant('bonkchoy'); // reach 1, cannot hit column 7
    game.grid[0][2].addPlant('peashooter');
    const s = await bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    const lane = s.lanes[0];
    // peashooter: 20 / 1.5 = 13.3; bonkchoy would add 15 / 0.3 = 50 if reach were ignored.
    assert.ok(lane.dpsOnFront < 20, `dpsOnFront=${lane.dpsOnFront}`);
    assert.ok(lane.dpsEffective < 20, `dpsEffective=${lane.dpsEffective}`);
  } finally { teardown(bridge); }
});

test('derived: 无墙行生成一键补墙决策', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 5.6 }],
  });
  try {
    game.cards.CFs = [
      { Type: 'sunflower', SUNCOST: 50, ID: 'sunflower' },
      { Type: 'cabbagepult', SUNCOST: 100, ID: 'cabbagepult' },
      { Type: 'wallnut', SUNCOST: 50, ID: 'wallnut' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    const s = await bridge.snapshot();
    const dec = (s.decisions || []).find((d) => d.kind === 'wall');
    assert.ok(dec, JSON.stringify(s.decisions));
    assert.equal(dec.action.type, 'plant');
    assert.equal(dec.action.plant, 'wallnut');
    assert.equal(dec.action.lane, 0);
    assert.ok(dec.action.column < 5.6, JSON.stringify(dec.action));
  } finally { teardown(bridge); }
});

test('derived: 同线多只 + 阳光够时生成 upgrade replace 决策', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 5.6 },
      { lane: 0, type: 'tutorial', health: 190, column: 6.4 },
      { lane: 0, type: 'tutorial', health: 190, column: 7.2 },
    ],
  });
  try {
    game.cards.CFs = [
      { Type: 'sunflower', SUNCOST: 50, ID: 'sunflower' },
      { Type: 'cabbagepult', SUNCOST: 100, ID: 'cabbagepult' },
      { Type: 'bloomerang', SUNCOST: 175, ID: 'bloomerang' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    game.grid[0][1].addPlant('cabbagepult');
    game.grid[0][2].addPlant('cabbagepult');
    const s = await bridge.snapshot();
    assert.ok(s.brief.upgradePlan && s.brief.upgradePlan.length, JSON.stringify(s.brief.upgradePlan));
    const dec = (s.decisions || []).find((d) => d.kind === 'upgrade');
    assert.ok(dec, JSON.stringify(s.decisions));
    assert.equal(dec.action.type, 'replace');
    assert.equal(dec.action.plant, 'bloomerang');
    assert.ok(dec.action.column === 1 || dec.action.column === 2, JSON.stringify(dec.action));
  } finally { teardown(bridge); }
});

test('derived: 全行 ehp/clearSec + 阳光富余时后排向日葵可换输出', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 5.6 },
      { lane: 0, type: 'tutorial', health: 190, column: 6.4 },
      { lane: 0, type: 'tutorial', health: 190, column: 7.2 },
    ],
  });
  try {
    game.cards.CFs = [
      { Type: 'sunflower', SUNCOST: 50, ID: 'sunflower' },
      { Type: 'cabbagepult', SUNCOST: 100, ID: 'cabbagepult' },
      { Type: 'bloomerang', SUNCOST: 175, ID: 'bloomerang' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    game.grid[0][0].addPlant('sunflower');
    game.grid[0][2].addPlant('cabbagepult');
    const s = await bridge.snapshot();
    const lane = s.lanes[0];
    assert.ok(lane.ehp > 0, JSON.stringify(lane));
    assert.ok(lane.clearSec > 0, JSON.stringify(lane));
    const cap = (s.brief.capacityGaps || [])[0];
    assert.ok(cap, JSON.stringify(s.brief.capacityGaps));
    assert.equal(cap.lane, 0);
    assert.ok(cap.missingDps > 0, JSON.stringify(cap));
    assert.ok((cap.economyCells || []).some((x) => x.column === 0), JSON.stringify(cap));
    const up = (s.brief.upgradePlan || [])[0];
    assert.ok(up, JSON.stringify(s.brief.upgradePlan));
    assert.equal(up.sunAbundant, true);
    assert.ok((up.economyCells || []).some((x) => x.column === 0), JSON.stringify(up));
    const cand = (up.candidates || [])[0];
    assert.ok((cand.replaceCells || []).some((x) => x.role === 'economy' && x.column === 0), JSON.stringify(cand));
  } finally { teardown(bridge); }
});

test('derived: 守不住时 lastResortPlan 给“后排向日葵换雷”的决策', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 2.0 },
      { lane: 0, type: 'tutorial', health: 190, column: 2.6 },
      { lane: 0, type: 'tutorial', health: 190, column: 3.2 },
    ],
  });
  try {
    game.cards.CFs = [
      { Type: 'sunflower', SUNCOST: 50, ID: 'sunflower' },
      { Type: 'wallnut', SUNCOST: 50, ID: 'wallnut' },
      { Type: 'potatomine', SUNCOST: 25, ID: 'potatomine' },
    ];
    game.cards.cardsUIUpper = [{ CD: 0 }, { CD: 0 }, { CD: 0 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;
    const wall = game.grid[0][1].addPlant('wallnut');
    wall.health = 4000;
    wall.toughness = 4000;
    game.grid[0][0].addPlant('sunflower');
    const s = await bridge.snapshot();
    assert.ok(s.brief.capacityGaps && s.brief.capacityGaps.length, JSON.stringify(s.brief.capacityGaps));
    const lr = (s.brief.lastResortPlan || [])[0];
    assert.ok(lr, JSON.stringify(s.brief.lastResortPlan));
    assert.equal(lr.lane, 0);
    assert.equal(lr.replaceCell.column, 0);
    assert.equal(lr.mine, 'potatomine');
    const dec = (s.decisions || []).find((d) => d.kind === 'last_resort');
    assert.ok(dec, JSON.stringify(s.decisions));
    assert.equal(dec.action.type, 'replace');
    assert.equal(dec.action.plant, 'potatomine');
    assert.equal(dec.action.column, 0);
  } finally { teardown(bridge); }
});

test('derived: brief.matchups 给出 deck × 当前僵尸的交叉配对', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 6 }],
  });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    const s = await bridge.snapshot();
    assert.ok(Array.isArray(s.brief.matchups) && s.brief.matchups.length, JSON.stringify(s.brief.matchups));
    const m = s.brief.matchups.find((x) => x.plant === 'peashooter' && x.zombie === 'tutorial');
    assert.ok(m, JSON.stringify(s.brief.matchups));
    assert.equal(m.ehp, 190);
    assert.ok(m.singleTtk > 0, JSON.stringify(m));
    assert.ok(['good', 'ok', 'immune', 'blocked'].includes(m.verdict), JSON.stringify(m));
  } finally { teardown(bridge); }
});

test('derived: multi-target dps scales with the actual number of targets', async () => {
  const one = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 7 }],
  });
  try {
    one.game.grid[0][1].addPlant('bloomerang'); // targets=3, unit dps=10
    const s = await one.bridge.snapshot();
    assert.equal(s.lanes[0].dpsOnFront, 10, JSON.stringify(s.lanes[0]));
  } finally { teardown(one.bridge); }

  const three = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 7 },
      { lane: 0, type: 'tutorial', health: 190, column: 8 },
      { lane: 0, type: 'tutorial', health: 190, column: 8.5 },
    ],
  });
  try {
    three.game.grid[0][1].addPlant('bloomerang');
    const s = await three.bridge.snapshot();
    assert.equal(s.lanes[0].dpsOnFront, 30, JSON.stringify(s.lanes[0]));
  } finally { teardown(three.bridge); }
});

test('derived: a straight shooter blocked by a tomb is excluded from effective dps', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 6 }],
  });
  try {
    game.grid[0][1].addPlant('peashooter');
    game.grid[0][3].haveTomb = true;
    const s = await bridge.snapshot();
    assert.ok(s.plants[0].blockedAt, JSON.stringify(s.plants[0]));
    assert.ok(s.lanes[0].dpsBlocked > 0, JSON.stringify(s.lanes[0]));
    assert.equal(s.lanes[0].dpsEffective, 0, JSON.stringify(s.lanes[0]));
    assert.equal(s.lanes[0].dpsOnFront, 0, JSON.stringify(s.lanes[0]));
  } finally { teardown(bridge); }
});

test('derived: a tomb only blocks shots at zombies behind it', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 3 }],
  });
  try {
    game.grid[0][1].addPlant('peashooter');
    game.grid[0][5].haveTomb = true;
    const s = await bridge.snapshot();
    assert.ok(s.plants[0].blockedAt, JSON.stringify(s.plants[0]));
    assert.ok(s.lanes[0].dpsEffective > 0, JSON.stringify(s.lanes[0]));
    assert.ok(s.lanes[0].dpsOnFront > 0, JSON.stringify(s.lanes[0]));
  } finally { teardown(bridge); }
});

test('derived: spikeweed only contributes dps to a zombie standing on its tile', async () => {
  const far = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 7 }],
  });
  try {
    far.game.grid[0][1].addPlant('spikeweed');
    const s = await far.bridge.snapshot();
    assert.equal(s.lanes[0].dpsStep, 20, JSON.stringify(s.lanes[0]));
    assert.equal(s.lanes[0].dpsEffective, 0, JSON.stringify(s.lanes[0]));
  } finally { teardown(far.bridge); }

  const on = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 1.5 }],
  });
  try {
    on.game.grid[0][1].addPlant('spikeweed');
    const s = await on.bridge.snapshot();
    assert.equal(s.lanes[0].dpsEffective, 20, JSON.stringify(s.lanes[0]));
    assert.equal(s.lanes[0].dpsOnFront, 20, JSON.stringify(s.lanes[0]));
  } finally { teardown(on.bridge); }
});

test('derived: layered plants expose every layer and the cell total hp', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    game.grid[0][0].addPlant('peashooter');
    game.grid[0][0].addPlant('wallnut');
    game.grid[0][0].lilypad = { Plant_Type: 'lilypad', health: 300, toughness: 300, isAlive: () => true };
    const s = await bridge.snapshot();
    const p = s.plants[0];
    assert.equal(p.type, 'peashooter');
    // fake-game 的 addPlant 固定 300 HP；这里只验证“所有层都被累加”。
    assert.equal(p.cellHp, 300 * 3, JSON.stringify(p));
    assert.ok(Array.isArray(p.layers) && p.layers.length === 3, JSON.stringify(p.layers));
    assert.deepEqual(p.layers.map((x) => x.role), ['main', 'main', 'lilypad']);
  } finally { teardown(bridge); }
});

test('derived: placement tags come from PlantFeatures.TAGS', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const k = bridge.knowledge({ type: 'seashooter' });
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.ok(k.entry.placement, JSON.stringify(k.entry));
    assert.ok(k.entry.placement.tags.includes('amphibious'), JSON.stringify(k.entry.placement));
  } finally { teardown(bridge); }
});

test('derived: aimOptions are neutral per-cell facts, never a recommendation', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 4 },
      { lane: 0, type: 'tutorial', health: 190, column: 5 },
    ],
  });
  try {
    game.cards.CFs = [{ Type: 'cherry_bomb', SUNCOST: 150 }];
    const s = await bridge.snapshot();
    const opts = s.brief.aimOptions || [];
    assert.ok(opts.length > 0, JSON.stringify(s.brief));
    const at4 = opts.find((o) => o.card === 'cherry_bomb' && o.lane === 0 && o.column === 4);
    assert.ok(at4, JSON.stringify(opts));
    assert.equal(at4.scope, 'box');
    assert.equal(at4.hits, 2);
    assert.equal(at4.dmg, 1800);
    assert.equal(at4.total, 3600);
    assert.equal(at4.kills, 2);
    assert.equal(at4.overkill, (1800 - 190) * 2);
    for (const o of opts) {
      assert.ok(!('best' in o) && !('recommended' in o) && !('priority' in o), JSON.stringify(o));
    }
  } finally { teardown(bridge); }
});

test('derived: threatGaps reports a no_wall lane without a wall task', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 6 }],
  });
  try {
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    const s = await bridge.snapshot();
    assert.ok((s.threatGaps || []).some((g) => g.kind === 'wall' && g.lane === 0), JSON.stringify(s.threatGaps));
  } finally { teardown(bridge); }
});

test('derived: no plant-food decisions when the player has zero plant food', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 6 }],
  });
  try {
    game.grid[0][0].addPlant('cabbagepult');
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.food.plantFoodNum = 0;
    const s = await bridge.snapshot();
    assert.equal(s.plantFood, 0);
    assert.ok(!(s.decisions || []).some((d) => d.kind === 'plant_food'), JSON.stringify(s.decisions));
  } finally { teardown(bridge); }
});

test('derived: pvz_decide only executes the chosen local micro-decision', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 4 },
      { lane: 0, type: 'tutorial', health: 190, column: 5 },
    ],
  });
  try {
    game.cards.CFs = [{ Type: 'cherry_bomb', SUNCOST: 150 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    game.sun.CurrentValue = 500;

    const s = await bridge.snapshot();
    const dec = (s.decisions || []).find((d) => d.kind === 'aim');
    assert.ok(dec, JSON.stringify(s.decisions));

    const no = await bridge.decide(dec.id, 'no');
    assert.equal(no.ok, true, JSON.stringify(no));
    assert.equal(no.skipped, true);
    assert.equal(bridge.snapshot().plants.length, 0);

    const s2 = await bridge.snapshot();
    const dec2 = (s2.decisions || []).find((d) => d.kind === 'aim');
    assert.ok(dec2, JSON.stringify(s2.decisions));
    const yes = await bridge.decide(dec2.id, 'yes');
    assert.equal(yes.ok, true, JSON.stringify(yes));
    assert.equal(yes.choice, 'yes');
    assert.ok(bridge.snapshot().plants.length > 0, 'yes should execute the action');
  } finally { teardown(bridge); }
});

test('derived: single-target aimOptions count one zombie even in a stacked cell', async () => {
  const { game, bridge } = setup({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 4 },
      { lane: 0, type: 'tutorial', health: 190, column: 4.2 },
    ],
  });
  try {
    game.cards.CFs = [{ Type: 'squash', SUNCOST: 50 }];
    const s = await bridge.snapshot();
    const opt = (s.brief.aimOptions || []).find((o) => o.card === 'squash');
    assert.ok(opt, JSON.stringify(s.brief));
    assert.equal(opt.scope, 'single');
    assert.equal(opt.hits, 1, JSON.stringify(opt));
    assert.equal(opt.total, 1800);
    assert.equal(opt.kills, 1);
  } finally { teardown(bridge); }
});

test('derived: zombie hp-threshold phases expose the next trigger', async () => {
  const { bridge } = setup({
    slots: 3,
    zombies: [{ lane: 0, type: 'tutorial', health: 190, column: 5 }],
  });
  try {
    const s = await bridge.snapshot();
    const z = s.zombies[0];
    assert.equal(z.nextPhase.effect, 'throw_imp', JSON.stringify(z));
    assert.equal(z.nextPhase.spawn, 'imp');
    assert.equal(z.nextPhase.atHp, 152);
    assert.equal(z.phases.length, 1);

    const b = bridge.briefing();
    const entry = b.zombies.find((x) => x.type === 'tutorial');
    assert.ok(entry.phases && entry.phases[0].effect === 'throw_imp', JSON.stringify(entry));
  } finally { teardown(bridge); }
});
