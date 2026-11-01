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

test('plan reset: restart clears the previous plan', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const saved = await bridge.setPlan({ text: 'old plan', deck: ['sunflower'] });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.ok(bridge.getPlan());
    const r = await bridge.restartLevel();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(bridge.getPlan(), null, 'restart must not keep the old plan');
  } finally { teardown(bridge); }
});

test('plan reset: switching prep mode (normal -> preplant) clears the old plan', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    game.cards.CFs = [{ Type: 'sunflower', SUNCOST: 50 }];
    await bridge.snapshot();
    await bridge.setPlan({ text: 'normal plan', deck: ['sunflower'] });
    assert.ok(bridge.getPlan());

    game.levelController.lastStandPrepareStarted = true;
    const s = await bridge.snapshot();
    assert.equal(s.prep.mode, 'preplant', JSON.stringify(s.prep));
    assert.equal(bridge.getPlan(), null, 'mode change must clear the old plan');
  } finally { teardown(bridge); }
});

test('plan audit: a mismatched deck is visible every round', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    game.cards.CFs = [{ Type: 'sunflower', SUNCOST: 50 }];
    game.levelController.gameStarted = true;
    game.cards.gameStarted = true;
    await bridge.setPlan({ text: 'stale conveyor plan', deck: ['conveyor'] });
    const s = await bridge.snapshot();
    assert.equal(s.plan.deck[0], 'conveyor');
    assert.ok(s.planAudit && s.planAudit.ok === false, JSON.stringify(s.planAudit));
    const warn = (s.planAudit.warnings || []).find((w) => w.code === 'PLAN_DECK_MISMATCH');
    assert.ok(warn, JSON.stringify(s.planAudit));
    assert.deepEqual(warn.missing, ['sunflower']);
    assert.deepEqual(warn.extra, ['conveyor']);
  } finally { teardown(bridge); }
});
