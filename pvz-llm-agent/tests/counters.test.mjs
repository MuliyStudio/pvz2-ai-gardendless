import test from 'node:test';
import assert from 'node:assert/strict';
import { TAG_COUNTERS } from '../knowledge/worlds.js';

test('TAG_COUNTERS：滚桶必须靠地刺，墙无效；飞行只有空中能被三叶草吹', () => {
  const rolling = TAG_COUNTERS.rolling;
  assert.ok(rolling, 'rolling 必须有克制事实');
  assert.ok(rolling.plants.includes('spikeweed'));
  assert.ok(/墙.*挡不住/.test(rolling.text), rolling.text);

  const flying = TAG_COUNTERS.flying;
  assert.ok(flying);
  assert.ok(flying.plants.includes('blover'));
  assert.ok(/空中/.test(flying.text) && /落地/.test(flying.text), flying.text);

  assert.ok(TAG_COUNTERS.carries_imp);
  assert.ok(TAG_COUNTERS.crush);
});
