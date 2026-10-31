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
    const r = await bridge.chooseDeck(['peashooter'], true);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.forced, true);
    assert.deepEqual(r.actualDeck, ['sunflower', 'peashooter', 'wallnut']);
    assert.equal(r.missing.length, 0);
  } finally { teardown(bridge); }
});

test('prep：提前布阵关 phase 仍是 running，但 prep.mode=preplant，start_level 能开打', async () => {
  const { game, bridge } = setup({ slots: 3, preplant: true });
  try {
    const s = bridge.snapshot();
    assert.equal(s.phase, 'running');
    assert.equal(s.prep.mode, 'preplant');
    assert.equal(s.prep.phase, 'preplant');
    assert.equal(s.prep.gameStarted, false);
    assert.equal(s.prep.canStart, true);
    const r = await bridge.startLevel();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(game.levelController.gameStarted, true);
    assert.equal(bridge.snapshot().prep.gameStarted, true);
    assert.equal(bridge.snapshot().prep.phase, 'fighting');
  } finally { teardown(bridge); }
});
