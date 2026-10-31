import test from 'node:test';
import assert from 'node:assert/strict';
import {
  travelSec, ttkSec, canKillBeforeHouse, armWindow, counterMatrix, laneMath,
  cardCapabilities, deckCapabilities, coverageAudit, wallSurvive, wallRebuildPlan, batchPreflight,
} from '../bridge/mechanics.js';

test('mechanics：到达时间 / 击杀时间 / 能否在到房子前清掉', () => {
  assert.equal(travelSec(10, 0.2), 50);
  assert.equal(ttkSec(1000, 25), 40);
  const r = canKillBeforeHouse({ ehp: 500, dps: 50, column: 7, speed: 0.2 });
  assert.equal(r.killSec, 10);
  assert.equal(r.etaSec, 35);
  assert.equal(r.ok, true);
});

test('mechanics：土豆雷 14s 出土窗口', () => {
  const late = armWindow({ armTimeSec: 14, leadSec: 0, plantColumn: 8, zombie: { column: 10, speed: 0.2 } });
  assert.equal(late.feasible, false, JSON.stringify(late));
  const ok = armWindow({ armTimeSec: 14, leadSec: 0, plantColumn: 7, zombie: { column: 10, speed: 0.2 } });
  assert.equal(ok.feasible, true, JSON.stringify(ok));
  assert.ok(ok.latestColumn <= 7);
});

test('mechanics：counterMatrix 直接给 deckAnswers 和 missingTags', () => {
  const statsOf = (t) => (t === 'barrelroller' ? { name: '滚桶僵尸', tags: ['rolling'] } : null);
  const hit = counterMatrix({ types: ['barrelroller'], deck: ['spikeweed', 'sunflower'], zombieStatsOf: statsOf });
  assert.equal(hit[0].deckAnswers.includes('spikeweed'), true);
  assert.deepEqual(hit[0].missingTags, []);
  const miss = counterMatrix({ types: ['barrelroller'], deck: ['sunflower'], zombieStatsOf: statsOf });
  assert.deepEqual(miss[0].missingTags, ['rolling']);
});

test('mechanics：laneMath 用最前僵尸算 kill/eta，群体时用 dpsGroup', () => {
  const out = laneMath({
    lanes: [{ lane: 0, dps: 50, dpsGroup: 90, wallHp: 0, gap: -10 }],
    zombies: [{ type: 'pirate', lane: 0, column: 5, speed: 0.2, ehp: 500 }],
  });
  assert.equal(out[0].frontType, 'pirate');
  assert.equal(out[0].killSec, 10);
  assert.equal(out[0].etaSec, 25);
  assert.equal(out[0].canKillBeforeHouse, true);
  // 同一行 ≥2 只僵尸 → 用群体 DPS，而不是单目标 DPS
  const group = laneMath({
    lanes: [{ lane: 0, dps: 10, dpsGroup: 90, wallHp: 0, gap: 0 }],
    zombies: [
      { type: 'camel', lane: 0, column: 6, speed: 0.2, ehp: 900 },
      { type: 'camel', lane: 0, column: 7, speed: 0.2, ehp: 900 },
    ],
  });
  assert.equal(group[0].dps, 90);
  assert.equal(group[0].killSec, 10);
});

test('mechanics：卡牌能力从数值 + 克制事实推导', () => {
  const bloomerang = { family: 'Sharp', attack: { dps: 7.4, targets: 3, pierceCount: 3, multiDps: 44.4 } };
  const caps = cardCapabilities('bloomerang', bloomerang);
  assert.ok(caps.includes('multi_target'), JSON.stringify(caps));
  assert.ok(caps.includes('pierce'));
  assert.ok(!caps.includes('high_dps'), '单目标 7.4 / 群体 44.4 不该被当成高单体 DPS');

  assert.ok(cardCapabilities('spikeweed', { family: 'Nope' }).includes('anti_rolling'), '地刺从 rolling 克制事实获得 anti_rolling');
  assert.ok(cardCapabilities('blover', { family: 'Nope', special: ['吹走空中的僵尸'] }).includes('anti_air'));
  assert.ok(cardCapabilities('wallnut', { family: 'Defence', hp: 4000 }).includes('wall'));
  assert.ok(cardCapabilities('cherry_bomb', { family: 'Explosive' }).includes('burst'));
});

test('mechanics：整关能力审计（group→multi_target、rolling→anti_rolling）', () => {
  const statsOf = (t) => {
    if (t === 'bloomerang') return { family: 'Sharp', attack: { dps: 7.4, targets: 3, pierceCount: 3, multiDps: 44.4 } };
    if (t === 'spikeweed') return { family: 'Nope' };
    if (t === 'sunflower') return { family: 'Sun', sun: { stages: [25] } };
    return null;
  };
  const missing = coverageAudit({
    tags: ['group', 'rolling'],
    deck: ['sunflower'],
    plantStatsOf: statsOf,
    pool: ['bloomerang', 'spikeweed', 'sunflower'],
  });
  assert.deepEqual(missing.required.sort(), ['anti_rolling', 'multi_target']);
  assert.deepEqual(missing.missing.map((m) => m.capability).sort(), ['anti_rolling', 'multi_target']);
  const group = missing.missing.find((m) => m.capability === 'multi_target');
  assert.deepEqual(group.tags, ['group']);
  assert.deepEqual(group.candidates, ['bloomerang'], '候选只按能力给事实');
  const rolling = missing.missing.find((m) => m.capability === 'anti_rolling');
  assert.deepEqual(rolling.candidates, ['spikeweed']);

  const ok = coverageAudit({ tags: ['group', 'rolling'], deck: ['bloomerang', 'spikeweed'], plantStatsOf: statsOf });
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.present.multi_target, ['bloomerang']);
});

test('mechanics：多只僵尸叠加啃墙时，支撑时间按总 eatDps 算', () => {
  const one = wallSurvive({ wallHp: 4000, eatDps: [100] });
  assert.equal(one.surviveSec, 40);
  const two = wallSurvive({ wallHp: 4000, eatDps: [100, 100] });
  assert.equal(two.totalEatDps, 200);
  assert.equal(two.surviveSec, 20, '两只一起啃，墙只撑一半时间');
  assert.equal(wallSurvive({ wallHp: 0, eatDps: [100] }).surviveSec, null);
});

test('mechanics：多行缺墙按风险排序，并给出补墙时间', () => {
  const plan = wallRebuildPlan({
    leadSec: 3,
    wallPlan: [
      { lane: 0, risk: 'ok', frontEta: 30 },
      { lane: 1, risk: 'wall_too_thin', frontEta: 40, wallSurviveSec: 5, wallCd: 0, wallBaseCd: 20 },
      { lane: 2, risk: 'no_wall', frontEta: 12, wallCd: 4, wallBaseCd: 20 },
    ],
  });
  assert.deepEqual(plan.map((x) => x.lane), [2, 1], 'no_wall 优先，其次按 frontEta');
  assert.equal(plan[0].order, 1);
  assert.equal(plan[0].startInSec, 4, '第一面墙等当前冷却');
  assert.equal(plan[1].startInSec, 24, '第二面墙要再等一个基础冷却');
  assert.equal(plan[1].feasible, true);
  const late = wallRebuildPlan({ leadSec: 5, wallPlan: [{ lane: 0, risk: 'no_wall', frontEta: 10, wallCd: 20, wallBaseCd: 20 }] });
  assert.equal(late[0].feasible, false, '冷却 20s + 提前量已经赶不上');
});

test('mechanics：批量预检 BATCH_COOLDOWN / BATCH_CONFLICT / 墙前输出', () => {
  const cards = [
    { index: 0, type: 'wallnut', family: 'Defence', baseCd: 20 },
    { index: 1, type: 'peashooter', family: 'Peashooter', dps: 13.3, baseCd: 5 },
    { index: 2, type: 'sunflower', family: 'Sun', baseCd: 3 },
  ];
  const walls = batchPreflight({
    cards,
    actions: [
      { type: 'plant', card: 0, lane: 0, column: 4 },
      { type: 'plant', card: 0, lane: 1, column: 4 },
      { type: 'plant', card: 0, lane: 2, column: 4 },
    ],
  });
  assert.deepEqual(walls.issues.map((i) => i.index), [1, 2]);
  assert.ok(walls.issues.every((i) => i.code === 'BATCH_COOLDOWN' && i.maxSuccess === 1));

  const short = batchPreflight({
    cards,
    actions: [
      { type: 'plant', card: 2, lane: 0, column: 0 },
      { type: 'plant', card: 2, lane: 1, column: 0 },
    ],
  });
  assert.deepEqual(short.issues, [], '基础冷却 ≤3.5s 交给执行层自动等');

  const conflict = batchPreflight({
    cards,
    actions: [
      { type: 'plant', card: 1, lane: 0, column: 2 },
      { type: 'shovel', lane: 0, column: 2 },
      { type: 'plant', card: 1, lane: 0, column: 2 },
    ],
  });
  assert.deepEqual(conflict.issues.map((i) => [i.index, i.code]), [[1, 'BATCH_CONFLICT'], [2, 'BATCH_CONFLICT']]);

  const combo = batchPreflight({
    cards,
    actions: [
      { type: 'shovel', lane: 0, column: 2 },
      { type: 'plant', card: 1, lane: 0, column: 2 },
    ],
  });
  assert.deepEqual(combo.issues, [], '先铲后种是合法连招');

  const wallFirst = batchPreflight({
    cards,
    state: { board: [{ cells: [null, null, null, null, null, null, null, null, null] }] },
    actions: [
      { type: 'plant', card: 0, lane: 0, column: 4 },
      { type: 'plant', card: 1, lane: 0, column: 5 },
    ],
  });
  assert.equal(wallFirst.issues.length, 1);
  assert.equal(wallFirst.issues[0].code, 'OUTPUT_IN_FRONT_OF_WALL');
  assert.equal(wallFirst.issues[0].wallColumn, 4);
});
