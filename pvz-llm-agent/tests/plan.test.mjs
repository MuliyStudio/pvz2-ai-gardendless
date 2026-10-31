import test from 'node:test';
import assert from 'node:assert/strict';
import { auditPlan, normalizeCoverageGaps, createPlanStore } from '../bridge/plan.js';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { createFakeGame } from './helpers/fake-game.mjs';

const gap = {
  missing: [{
    capability: 'multi_target',
    tags: ['group'],
    candidates: ['bloomerang'],
  }],
};

test('plan audit：只有一段文本的计划会被要求补结构化字段', () => {
  const r = auditPlan({ text: '卷心菜主力', deck: ['sunflower'] }, {});
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some((w) => w.code === 'PLAN_TEXT_ONLY'), JSON.stringify(r.warnings));
});

test('plan audit：缺能力却没写 counter → PLAN_MISSING_COUNTER；写了就通过', () => {
  const base = {
    text: '先经济再输出',
    deck: ['sunflower', 'bloomerang'],
    lanes: [{ lane: 0, role: '经济' }],
  };
  const miss = auditPlan(base, { coverageGaps: gap, deck: ['sunflower', 'bloomerang'] });
  assert.ok(miss.warnings.some((w) => w.code === 'PLAN_MISSING_COUNTER' && w.capability === 'multi_target'), JSON.stringify(miss.warnings));

  const covered = auditPlan({ ...base, counters: [{ tag: 'group', card: 'bloomerang', lane: 'all' }] }, { coverageGaps: gap, deck: base.deck });
  assert.deepEqual(covered.warnings, []);
  assert.equal(covered.ok, true);

  // 用 capability 字段写也算覆盖
  const byCap = auditPlan({ ...base, counters: [{ capability: 'multi_target', card: 'bloomerang' }] }, { coverageGaps: gap, deck: base.deck });
  assert.deepEqual(byCap.warnings, []);
});

test('plan audit：计划卡组和实际卡组不一致 → PLAN_DECK_MISMATCH', () => {
  const r = auditPlan(
    { text: 'x', deck: ['sunflower', 'cherry_bomb'], lanes: [{ lane: 0, role: '经济' }] },
    { deck: ['sunflower', 'peashooter'] },
  );
  const w = r.warnings.find((x) => x.code === 'PLAN_DECK_MISMATCH');
  assert.ok(w, JSON.stringify(r.warnings));
  assert.deepEqual(w.missing, ['peashooter']);
  assert.deepEqual(w.extra, ['cherry_bomb']);
});

test('plan audit：lane 越界会被标出来', () => {
  const r = auditPlan({ text: 'x', lanes: [{ lane: 7, role: '输出' }] }, {});
  assert.ok(r.warnings.some((w) => w.code === 'PLAN_BAD_LANE'), JSON.stringify(r.warnings));
});

test('normalizeCoverageGaps：新能力缺口与旧 missingTags 都能读', () => {
  assert.deepEqual(normalizeCoverageGaps(gap), [{ capability: 'multi_target', tags: ['group'], candidates: ['bloomerang'] }]);
  assert.deepEqual(
    normalizeCoverageGaps([{ type: 'barrelroller', tags: ['rolling'], missingTags: ['rolling'] }]),
    [{ capability: 'rolling', tags: ['rolling'], candidates: [] }],
  );
  assert.deepEqual(normalizeCoverageGaps(null), []);
});

test('plan store：normalize 后 audit 用同一份事实', () => {
  const store = createPlanStore('test');
  const saved = store.setPlan({ style: '卷心菜', deck: { sunflower: true }, lanes: { 0: { role: '经济' } } });
  assert.equal(saved.ok, true);
  assert.equal(saved.plan.schema, 'pvz-plan/v1');
  assert.equal(saved.plan.text, '卷心菜');
  assert.deepEqual(saved.plan.deck, ['sunflower']);
  assert.equal(saved.plan.lanes[0].lane, 0);
  const audit = store.audit({ coverageGaps: gap, deck: ['sunflower'] });
  assert.ok(audit.warnings.some((w) => w.code === 'PLAN_MISSING_COUNTER'));
  store.reset();
  assert.equal(store.getPlan(), null);
});

function setup(opts) {
  resetAssetCache();
  const game = createFakeGame(opts);
  const bridge = createBridge(game.ctx);
  const router = createToolRouter({ bridge, version: 'test' });
  return { game, bridge, router };
}

function teardown(bridge) {
  try { bridge.dispose(); } catch { /* ignore */ }
  try { delete globalThis.PvzLlm; } catch { /* ignore */ }
}

test('router：pvz_set_plan 保存计划并按本关能力缺口返回 audit.warnings', async () => {
  const { bridge, router } = setup({ slots: 3 });
  try {
    // 模拟“本关有 group tag、卡组没有多目标卡”的整关能力缺口
    const realSnap = bridge.snapshot.bind(bridge);
    bridge.snapshot = () => {
      const s = realSnap();
      if (s && s.ok) {
        s.brief = {
          ...(s.brief || {}),
          coverageGaps: {
            tags: ['group'],
            required: ['multi_target'],
            present: {},
            missing: [{ capability: 'multi_target', name: '多目标', tags: ['group'], candidates: ['bloomerang'] }],
          },
        };
        s.deck = ['sunflower', 'peashooter', 'wallnut'];
      }
      return s;
    };
    const r = await router.call('pvz_set_plan', { plan: { text: '先经济', deck: ['sunflower', 'peashooter', 'wallnut'] } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.warnings) && r.warnings.length > 0, JSON.stringify(r.warnings));
    assert.ok(r.warnings.some((w) => w.code === 'PLAN_MISSING_COUNTER'));
    assert.ok(r.warnings.some((w) => w.code === 'PLAN_TEXT_ONLY'));
    assert.ok(r.audit && r.audit.ok === false);
  } finally { teardown(bridge); }
});
