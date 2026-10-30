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
    assert.ok(!('stats' in ps), 'state.cards 不再重复带完整数值（在 pvz_briefing.cards 里）');
    assert.ok(s.levelScript == null || s.levelScript.waves === undefined, 'state 的 levelScript 只给波数摘要');
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
    assert.equal(h.version, '0.1.19');
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
    assert.deepEqual(s.objective.missions, [], '模板 missions 不能出现在 state 里（模型会直接读）');
    assert.equal(s.plantLimit, null, '模板文案不能被解析成植物上限');
    assert.ok(
      !s.missionHints.includes('Never have more than 18 plants'),
      JSON.stringify(s.missionHints),
    );
    const b = bridge.briefing();
    assert.deepEqual(b.objective.missions, [], 'briefing 也不能带模板 missions');
    assert.equal(b.plantLimit, null);
    assert.equal(b.constraints.find((c) => c.id === 'plant_limit'), undefined);
  } finally { teardown(bridge); }
});

test('objective：模板对象未激活时不抢真实任务（同场景两个组件）', () => {
  const { game, bridge } = setup({ slots: 3, noBoard: true });
  try {
    // 引擎里模板和真实任务可能同时挂在场景上：模板未激活、screenName 是占位符。
    const templateNode = { activeInHierarchy: false, active: false, children: [], _components: [] };
    const realNode = { activeInHierarchy: true, active: true, children: [], _components: [] };
    game.scene._components.push({
      __classname__: 'LevelObjectiveScreen',
      screenName: { string: '<LEVEL OBJECTIVE NAME>' },
      mission0: { string: 'Never have more than 18 plants' },
      node: templateNode,
      faded: false,
      continue() {},
    });
    game.scene._components.push({
      __classname__: 'LevelObjectiveScreen',
      screenName: { string: '海盗港湾 - 第 13 天目标' },
      mission0: { string: '本关最多只能种 24 株' },
      node: realNode,
      faded: false,
      continue() {},
    });

    const s = bridge.snapshot();
    assert.equal(s.objective.trusted, true);
    assert.equal(s.objective.screenName, '海盗港湾 - 第 13 天目标');
    assert.equal(s.plantLimit, 24, JSON.stringify(s.objective));
  } finally { teardown(bridge); }
});

test('plantLimit：结构化任务字段优先于任务文案', () => {
  const { bridge } = setup({ slots: 3, objective: true, task: { tip: '本关最多只能种 20 株', mode: 5, extra: { plantCountLimit: 12 } } });
  try {
    const s = bridge.snapshot();
    assert.equal(s.plantLimit, 12, 'LevelTaskCount.plantCountLimit 才是事实');
    assert.equal(s.limits.plantLimitSource, 'task');
  } finally { teardown(bridge); }
});

test('cards：cdReady / affordable / sunShort / ready 分开给', async () => {
  const { game, bridge } = setup({ slots: 3 });
  try {
    await bridge.chooseDeck(['sunflower', 'peashooter', 'wallnut'], true);
    game.sun.CurrentValue = 30;
    const s = bridge.snapshot();
    const sun = s.cards.find((c) => c.type === 'sunflower');
    assert.ok(sun, JSON.stringify(s.cards.map((c) => c.type)));
    assert.equal(sun.cost, 100, '假游戏的卡固定 100 阳光');
    assert.equal(sun.cdReady, true, '刚种下去才有冷却，这里应为 true');
    assert.equal(sun.affordable, false);
    assert.equal(sun.sunShort, 70);
    assert.equal(sun.ready, false);

    game.sun.CurrentValue = 200;
    const s2 = bridge.snapshot();
    const sun2 = s2.cards.find((c) => c.type === 'sunflower');
    assert.equal(sun2.affordable, true);
    assert.equal(sun2.sunShort, 0);
    assert.equal(sun2.ready, true);
  } finally { teardown(bridge); }
});

test('zombies：护甲给出 armorHp / ehp / ehpMax，不再只有本体血量', () => {
  const { bridge } = setup({ slots: 3, zombies: [{ lane: 0, column: 5, type: 'dark_armor2', health: 190, total: 650 }] });
  try {
    const s = bridge.snapshot();
    const z = s.zombies[0];
    assert.equal(z.type, 'dark_armor2');
    assert.equal(z.hp, 190);
    assert.equal(z.armorHp, null, '读不到护甲当前血量时给 null，不瞎猜');
    assert.equal(z.armorMax, 460);
    assert.equal(z.ehp, null);
    assert.equal(z.ehpMax, 650);
    assert.ok(s.lanes[0].ehp >= 650, JSON.stringify(s.lanes[0]));
    assert.equal(s.lanes[0].ehpExact, false);
  } finally { teardown(bridge); }
});

test('zombies：读得到护甲血量时 ehp = 本体 + 当前护甲', () => {
  const { bridge } = setup({ slots: 3, zombies: [{ lane: 0, column: 5, type: 'dark_armor2', health: 190, total: 650, armorHp: 300 }] });
  try {
    const s = bridge.snapshot();
    const z = s.zombies[0];
    assert.equal(z.armorHp, 300);
    assert.equal(z.ehp, 490);
    assert.equal(z.ehpMax, 650);
    assert.equal(s.lanes[0].ehpExact, true);
  } finally { teardown(bridge); }
});

test('seedSelection：选卡阶段不再带每张卡的完整数值', () => {
  const { bridge } = setup({ slots: 3 });
  try {
    const s = bridge.snapshot();
    assert.ok(s.seedSelection, '选卡阶段应有 seedSelection');
    assert.equal(typeof s.seedSelection.availableCount, 'number');
    const first = s.seedSelection.available[0];
    assert.ok(first.type && first.cost != null);
    assert.ok(!('stats' in first), 'available 条目不应再带 stats（完整数值在 briefing.cards）');
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
