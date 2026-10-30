import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatToolCall, formatToolResult, formatPlan } from '../tools/format.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const plants = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', 'data', 'plants.json'), 'utf8'));
const zombies = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', 'data', 'zombies.json'), 'utf8'));

test('静态图鉴包含植物/僵尸事实，且不含策略结论', () => {
  assert.ok(plants.meta.counts.plants > 100);
  assert.ok(zombies.meta.counts.zombies > 100);
  const sf = plants.plants.sunflower;
  assert.equal(sf.name, '向日葵');
  assert.equal(sf.cost, 50);
  assert.ok(sf.sun.perSecDay[0] > 0);
  const z = zombies.zombies.pirate_armor1;
  assert.equal(z.name, '路障海盗');
  assert.equal(z.ehp, 560);
  assert.ok(z.tags.includes('armored'));
  const keys = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(x); }
  };
  walk(plants);
  walk(zombies);
  for (const bad of ['suggesteddeck', 'recommend', 'autodeck', 'bestdeck']) assert.ok(!keys.has(bad));
});

test('format：工具调用和结果都是人话，不整段 JSON', () => {
  const call = formatToolCall('pvz_act', { actions: [{ type: 'plant', plant: 'sunflower', lane: 1, column: 2 }] });
  assert.ok(call.includes('种植'));
  assert.ok(call.includes('第2行'));
  assert.ok(!call.includes('{'));

  const ok = formatToolResult('pvz_act', { ok: true, results: [{ type: 'plant', ok: true, plant: 'sunflower', detail: '种下 sunflower @ 1,2' }] });
  assert.ok(ok.includes('✅'));
  assert.ok(!ok.includes('{"'));

  const fail = formatToolResult('pvz_act', { ok: false, results: [{ type: 'plant', ok: false, code: 'COOLDOWN', reason: '冷却中', retryAfter: 2 }] });
  assert.ok(fail.includes('COOLDOWN'));
  assert.ok(fail.includes('2s'));

  const pending = formatToolResult('pvz_act', { ok: true, results: [{ action: 'plant', type: 'squash', ok: true, pending: true, detail: 'squash 已发起，等待落地' }] });
  assert.ok(pending.includes('⏳'));
  assert.ok(pending.includes('等待落地'));

  const deck = formatToolResult('pvz_choose_deck', { ok: false, code: 'DECK_NOT_FULL', actualDeck: ['sunflower'], slots: 3, missing: ['wallnut'] });
  assert.ok(deck.includes('1/3'));
  assert.ok(deck.includes('wallnut'));

  const plan = formatPlan({ style: 'test', deck: ['sunflower'], lanes: ['L1 输出'], thresholds: { sun: 150 } });
  assert.ok(plan.includes('风格'));
  assert.ok(plan.includes('L1'));

  const plan2 = formatPlan({
    style: '经济优先',
    deck: { sunshroom: '25, 早期经济' },
    layout: { col0: '阳光菇 x5' },
    contingency: { 某行被突破: '樱桃清行' },
  });
  assert.ok(plan2.includes('sunshroom（25, 早期经济）'));
  assert.ok(plan2.includes('布置'));
  assert.ok(plan2.includes('col0'));
  assert.ok(plan2.includes('某行被突破'));
});

test('format：events 数组变成可读行', () => {
  const text = formatToolResult('pvz_events', [
    { t: 'wave_started', wave: 3, detail: '第3波' },
    { t: 'lane_threat', lane: 1, detail: '最近僵尸 c2' },
  ]);
  assert.ok(text.includes('波次开始'));
  assert.ok(text.includes('第2行'));
  assert.ok(!text.includes('"t"'));
});
