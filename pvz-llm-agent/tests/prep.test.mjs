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

test('prep：普通关是 normal，选卡路径不变', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const p = bridge.snapshot().prep;
    assert.equal(p.mode, 'normal');
    assert.equal(p.conveyor, false);
    assert.equal(p.deckLocked, false);
  } finally { teardown(bridge); }
});

test('prep：没有选卡页 + 任务原文“使用给定植物通关”识别成 forced_deck', () => {
  const { game, bridge } = setup({ slots: 3, task: { tip: '使用给定植物通关' } });
  try {
    game.cards.seedChooser = null;
    const p = bridge.snapshot().prep;
    assert.equal(p.mode, 'forced_deck');
    assert.equal(p.mustPlanBeforeStart, true);
  } finally { teardown(bridge); }
});

test('prep：没有选卡页 + 任务原文“提前布阵击败僵尸”识别成 preplant', () => {
  const { game, bridge } = setup({ slots: 3, task: { tip: '提前布阵击败僵尸' } });
  try {
    game.cards.seedChooser = null;
    const p = bridge.snapshot().prep;
    assert.equal(p.mode, 'preplant');
    assert.equal(p.mustPlanBeforeStart, true);
  } finally { teardown(bridge); }
});

test('prep：传送带关不能选卡，mode=conveyor，可直接开始', async () => {
  const { bridge } = setup({ slots: 3, conveyor: true });
  try {
    const p = bridge.snapshot().prep;
    assert.equal(p.mode, 'conveyor');
    assert.equal(p.canStart, true);
    const r = await bridge.chooseDeck(['sunflower', 'peashooter']);
    assert.equal(r.ok, true);
    assert.equal(r.conveyor, true);
    assert.equal(r.detail, '传送带关卡无需选卡');
  } finally { teardown(bridge); }
});

test('prep：给定/锁定卡组，choose_deck 原样返回、不报缺卡', async () => {
  const { bridge } = setup({ slots: 3, forcedDeck: true });
  try {
    const p = bridge.snapshot().prep;
    assert.equal(p.mode, 'forced_deck');
    assert.equal(p.deckLocked, true);
    assert.equal(p.lockedCount, 3);
    assert.equal(p.availableCount, 0);
    assert.equal(p.hasSeedChooser, false);
    assert.equal(p.mustPlanBeforeStart, true);
    const r = await bridge.chooseDeck(['peashooter'], true);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.forced, true);
    assert.deepEqual(r.actualDeck, ['sunflower', 'peashooter', 'wallnut']);
    assert.equal(r.missing.length, 0);
  } finally { teardown(bridge); }
});

test('prep：提前布阵关 phase 仍是 running，但 prep.mode=preplant；先有计划才能开打', async () => {
  const { game, bridge } = setup({ slots: 3, preplant: true });
  try {
    const s = bridge.snapshot();
    assert.equal(s.phase, 'running');
    assert.equal(s.prep.mode, 'preplant');
    assert.equal(s.prep.phase, 'preplant');
    assert.equal(s.prep.gameStarted, false);
    assert.equal(s.prep.canStart, true);
    assert.equal(s.prep.mustPlanBeforeStart, true);
    const denied = await bridge.startLevel();
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.code, 'NEED_PLAN');
    assert.equal(game.levelController.gameStarted, false);
    bridge.setPlan({ text: '先布阵再开打', lanes: [{ lane: 2, role: 'main' }], counters: [{ tag: 'flying', card: 'blover' }] });
    const r = await bridge.startLevel();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(game.levelController.gameStarted, true);
    assert.equal(bridge.snapshot().prep.gameStarted, true);
    assert.equal(bridge.snapshot().prep.phase, 'fighting');
  } finally { teardown(bridge); }
});

test('prep：传送带组件存在时 state.cards 是带上当前卡，种植走 chooseCard', async () => {
  const { game, bridge } = setup({ slots: 3, conveyor: true });
  try {
    const s = bridge.snapshot();
    assert.equal(s.prep.mode, 'conveyor');
    assert.equal(s.conveyor.enabled, true);
    assert.deepEqual(s.deck, ['sunflower', 'peashooter', 'wallnut']);
    assert.deepEqual(s.cards.map((c) => c.index), [0, 1, 2]);
    assert.equal(s.cards[0].cost, 0);
    assert.equal(s.cards[0].ready, true);
    const started = await bridge.startLevel();
    assert.equal(started.ok, true, JSON.stringify(started));
    const r = await bridge.act({ type: 'plant', card: 0, lane: 1, column: 2 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.conveyor, undefined, '返回沿用普通种植结构');
    assert.equal(game.conveyorComp.chooseCalls, 1);
    assert.equal(game.grid[1][2].plantInSquare.length, 1);
  } finally { teardown(bridge); }
});
