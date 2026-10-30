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

function allKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

test('briefing 返回需求要求的全部事实字段', () => {
  const { bridge } = setup({ slots: 3, objective: true });
  try {
    const b = bridge.briefing();
    assert.equal(b.ok, true, JSON.stringify(b));
    for (const k of ['objective', 'missionHints', 'level', 'world', 'terrain', 'waves', 'zombies', 'cards', 'deck', 'startingSun', 'plantLimit', 'constraints', 'mechanics']) {
      assert.ok(k in b, `缺少 ${k}`);
    }
    assert.equal(b.deck.slots, 3);
    assert.equal(b.cards.length, 4);
    assert.equal(b.plantLimit, 18);
    assert.equal(b.waves.length, 2);
    assert.equal(b.waves[0].zombies.tutorial.count, 1);
    assert.equal(b.zombies[0].type, 'tutorial');
    assert.equal(b.cards.find((c) => c.type === 'sunflower').cost, 50);
    assert.equal(b.cards.find((c) => c.type === 'sunflower').sun.stages[0], 25);
    assert.ok(b.cards.find((c) => c.type === 'peashooter').attack.dps > 0);
    assert.ok(Array.isArray(b.terrain.map) && b.terrain.map.length === 5);
    assert.ok(b.terrain.plantable[0].columns.length > 0);
    assert.equal(b.startingSun, 150);
  } finally { teardown(bridge); }
});

test('briefing 在任务说明阶段（还没有棋盘）仍返回关卡/卡池/波次', () => {
  const { bridge } = setup({ slots: 3, objective: true, noBoard: true });
  try {
    const s = bridge.snapshot();
    assert.equal(s.ok, true);
    assert.equal(s.phase, 'objective');
    assert.equal(s.terrain, null);
    const b = bridge.briefing();
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.deck.slots, 3);
    assert.equal(b.cards.length, 4);
    assert.equal(b.waves.length, 2);
    assert.equal(b.plantLimit, 18);
    assert.ok(b.objective.missions.length > 0);
  } finally { teardown(bridge); }
});

test('briefing 不包含推荐卡组 / 本地建议字段', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const b = bridge.briefing();
    const keys = allKeys(b).map((k) => k.toLowerCase());
    for (const bad of ['suggesteddeck', 'recommend', 'suggestion', 'autodeck', 'strategy']) {
      assert.ok(!keys.some((k) => k.includes(bad)), `不应出现 ${bad}`);
    }
  } finally { teardown(bridge); }
});

test('snapshot 有棋盘、限制、地形和真实卡组', async () => {
  const { bridge } = setup({ slots: 3 });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    const s = bridge.snapshot();
    assert.equal(s.ok, true);
    assert.equal(s.phase, 'preparing');
    assert.equal(s.deck.length, 3);
    assert.equal(s.board.length, 5);
    assert.equal(s.board[0].cells.length, 9);
    assert.equal(s.terrain.map.length, 5);
    assert.equal(s.limits.slots, 3);
    assert.equal(s.plantLimit, null);
    assert.ok(Array.isArray(s.plantable));
    const ps = s.cards.find((c) => c.type === 'peashooter');
    assert.equal(ps.cost, 100);
    assert.ok(ps.stats.attack.dps > 0);
  } finally { teardown(bridge); }
});

test('knowledge 查植物/僵尸/关键词/本关', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const p = bridge.knowledge({ type: 'sunflower' });
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'plant');
    assert.equal(p.entry.cost, 50);
    assert.equal(p.entry.name, '向日葵');
    assert.equal(p.entry.usage.activation, 'auto');

    const z = bridge.knowledge({ type: 'tutorial' });
    assert.equal(z.ok, true);
    assert.equal(z.kind, 'zombie');
    assert.equal(z.entry.ehp, 190);

    const q = bridge.knowledge({ query: '普通' });
    assert.equal(q.ok, true);
    assert.ok(q.matches.some((m) => m.type === 'tutorial'));

    const lv = bridge.knowledge({ type: 'level', kind: 'level' });
    assert.equal(lv.ok, true);
    assert.equal(lv.kind, 'level');
  } finally { teardown(bridge); }
});

test('setPlan 只保存，snapshot 回显，不产生执行动作', () => {
  const { bridge, game } = setup({ slots: 3 });
  try {
    const plan = { style: 'test', deck: ['sunflower'], thresholds: { sun: 150 } };
    const r = bridge.setPlan(plan);
    assert.equal(r.ok, true);
    assert.deepEqual(r.plan, plan);
    assert.deepEqual(bridge.snapshot().plan, plan);
    assert.equal(game.cards.CFs.length, 0, 'setPlan 不应改游戏');
    assert.equal(bridge.getPlan().plan.style, 'test');
  } finally { teardown(bridge); }
});

test('tasks 带语义/剩余/urgent，供 LLM 读硬约束', () => {
  const { bridge } = setup({
    slots: 3,
    task: { tip: '击杀僵尸', count: '8/10', mode: 5, startingObjdata: { ZombiesToKill: 10 } },
  });
  try {
    const s = bridge.snapshot();
    assert.equal(s.tasks.length, 1);
    const t = s.tasks[0];
    assert.equal(t.semantics, 'kill_count');
    assert.equal(t.value, 8);
    assert.equal(t.total, 10);
    assert.ok(t.hint.includes('8/10'));
  } finally { teardown(bridge); }
});

test('events 产生波次事件（增量、去抖）', () => {
  const { bridge, game } = setup({ slots: 3 });
  try {
    bridge.pollEvents();
    game.levelController.currentWave = 1;
    const list = bridge.pollEvents();
    assert.ok(list.some((e) => e.t === 'wave_started' && e.wave === 2), JSON.stringify(list));
  } finally { teardown(bridge); }
});

test('health 报告能力，且明确没有本地策略/自动卡组/队列', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const h = bridge.health();
    assert.equal(h.ok, true);
    assert.equal(h.version, '0.1.10');
    assert.equal(h.features.localStrategy, false);
    assert.equal(h.features.autoDeck, false);
    assert.equal(h.features.queue, false);
    assert.equal(h.missing.length, 0);
  } finally { teardown(bridge); }
});

test('objective：占位符 screenName 的模板对象不被当成真实任务', () => {
  const { game, bridge } = setup({ slots: 3, objective: true });
  try {
    // 真实关卡会把 screenName 本地化成「海盗港湾 - 第 13 天目标」；
    // 未初始化的模板对象则是 "<LEVEL OBJECTIVE NAME>"，mission0 是引擎默认英文文案。
    const obj = game.scene._components.find((c) => c.__classname__ === 'LevelObjectiveScreen');
    assert.ok(obj, '假游戏应带 LevelObjectiveScreen');
    obj.screenName.string = '<LEVEL OBJECTIVE NAME>';
    obj.mission0.string = 'Never have more than 18 plants';

    const s = bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.objective.trusted, false);
    assert.equal(s.plantLimit, null, '模板文案不能被解析成植物上限');
    assert.ok(
      !s.missionHints.includes('Never have more than 18 plants'),
      JSON.stringify(s.missionHints),
    );
  } finally { teardown(bridge); }
});

test('objective：本地化后的 screenName 仍能正常解析植物上限', () => {
  const { game, bridge } = setup({ slots: 3, objective: true });
  try {
    const obj = game.scene._components.find((c) => c.__classname__ === 'LevelObjectiveScreen');
    obj.screenName.string = '海盗港湾 - 第 13 天目标';
    const s = bridge.snapshot();
    assert.equal(s.objective.trusted, true);
    assert.equal(s.plantLimit, 18, '真实任务文案应被采信');
  } finally { teardown(bridge); }
});
