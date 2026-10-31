import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsReader, resetAssetCache } from '../bridge/stats.js';

/**
 * 数据适配回归：新字段/新卡只要落进字段族就自动生效，
 * 不再需要为每张卡写 if。
 */

function assets(plants, almanac = []) {
  return [
    { name: 'PlantFeatures', json: { PLANTS: plants.map((p) => ({ CODENAME: p.alias, NAME: { zh: p.alias, en: p.alias } })) } },
    { name: 'PlantProps', json: { objects: plants.map((p) => ({ aliases: [p.alias], objdata: p.props })) } },
    { name: 'PlantAlmanac', json: { objects: almanac.map((a) => ({ aliases: [a.alias], objdata: a.objdata })) } },
    { name: 'PlantTypes', json: { objects: [] } },
    { name: 'ProjectileProps', json: { objects: [] } },
    { name: 'ProjectileTypes', json: { objects: [] } },
    { name: 'ZombieProps', json: { objects: [] } },
    { name: 'ZombieAlmanac', json: { objects: [] } },
    { name: 'ArmorProps', json: { objects: [] } },
    { name: 'LawnProps', json: { objects: [] } },
  ];
}

function readerOf(list) {
  resetAssetCache();
  const cc = { assetManager: { assets: new Map(list.map((a) => [a.name, a])) } };
  return createStatsReader(() => cc);
}

test('单发卡：有 Damage 没有间隔 → burst，而不是 null', () => {
  const stats = readerOf(assets([
    { alias: 'cherry_bomb', props: { SunCost: 150, Cooldown: 35, Toughness: 300, Family: 'Explosive', Damage: 1800 } },
  ]));
  const st = stats.plantStatsOf('cherry_bomb');
  assert.equal(st.attack, null);
  assert.equal(st.burst.dmg, 1800);
  assert.equal(st.burst.basis, 'single');
});

test('图鉴 DAMAGE 兜底：属性里没有伤害字段也能算出 burst（椰子炮 900）', () => {
  const stats = readerOf(assets(
    [{ alias: 'coconutcannon', props: { SunCost: 400, Cooldown: 5, Toughness: 300, Family: 'Lobber', PeaType: 'coconut', RestTime: 15 } }],
    [{
      alias: 'coconutcannon',
      objdata: {
        BriefIntroduction: { zh: '点击发射一颗爆炸性椰子炮弹' },
        Introduction: { zh: '椰子加农炮沿着本行发射' },
        Special: [{ NAME: { zh: '用途' }, DESCRIPTION: { zh: '点击发射' } }],
        Elements: [{ TYPE: 'DAMAGE', VALUE: 900 }, { TYPE: 'AREA', SORT: { zh: '3x3 范围' } }],
      },
    }],
  ));
  const st = stats.plantStatsOf('coconutcannon');
  assert.equal(st.burst.dmg, 900);
  assert.equal(st.usage.activation, 'click');
  assert.equal(st.usage.aim, 'lane', '沿本行发射 → aim=lane');
  assert.equal(st.usage.restSec, 15);
});

test('吸血流：DPS + AttackDuration + “吸取血量” → drain / 无视护甲 / 光环', () => {
  const stats = readerOf(assets(
    [{ alias: 'vamporcini', props: { SunCost: 100, Cooldown: 20, Toughness: 4000, MaxToughness: 6000, Family: 'Poison', DPS: 40, AttackDuration: 6, DPSPlantfood: 40, AttackDurationPlantfood: 10 } }],
    [{
      alias: 'vamporcini',
      objdata: {
        BriefIntroduction: { zh: '一段时间内吸收周围僵尸的血量' },
        Introduction: { zh: '从周围的僵尸吸取血量以强化自身' },
        Special: [{ NAME: { zh: '特点' }, DESCRIPTION: { zh: '从僵尸吸取的血量用于增加自身血量' } }],
        Elements: [{ TYPE: 'RANGE', SORT: { zh: '3x3 范围' } }],
      },
    }],
  ));
  const st = stats.plantStatsOf('vamporcini');
  assert.equal(st.attack.dps, 40);
  assert.equal(st.attack.durationSec, 6);
  assert.equal(st.damageType, 'drain');
  assert.equal(st.ignoresArmor, true);
  assert.equal(st.armorState, 'yes');
  assert.equal(st.shot.kind, 'aura');
  assert.equal(st.hpMax, 6000);
  // 能量豆：DPS × 持续 = 400，范围跟本体一样是周围 3x3
  assert.equal(st.plantFood.kind, 'self_aoe_dot');
  assert.equal(st.plantFood.total, 400);
  assert.equal(st.plantFood.radius, 1);
});

test('新字段自动适配：AttackDPS + AttackDuration（不用改代码）', () => {
  const stats = readerOf(assets([
    { alias: 'firegourd', props: { SunCost: 150, Cooldown: 10, Toughness: 300, Family: 'Fire', AttackDPS: 20, AttackDuration: 3 } },
  ]));
  const st = stats.plantStatsOf('firegourd');
  assert.equal(st.attack.dps, 20);
  assert.equal(st.attack.durationSec, 3);
  assert.equal(st.attack.basis, 'dps');
});

test('能量豆字段族：近身多段 / 本行连射 / 图鉴写法都能分类', () => {
  const stats = readerOf(assets(
    [
      { alias: 'bonkchoy', props: { SunCost: 150, Cooldown: 5, Toughness: 300, Family: 'Melee', Damage: 15, AttackInterval: 0.3, DamagePlantfood: 60, PlantfoodHitCount: 25 } },
      { alias: 'peashooter', props: { SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Peashooter', ShootInterval: 1.35, PeaTypePlantfood: 'pea', PlantfoodPeaCount: 60 } },
      { alias: 'wallnut', props: { SunCost: 50, Cooldown: 20, Toughness: 4000, Family: 'Defence', ToughnessPlantfooded: 8000 } },
      { alias: 'newplant', props: { SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Nope', FancyPlantfoodThing: 3 } },
    ],
    [{ alias: 'bonkchoy', objdata: { BriefIntroduction: { zh: '快速击打身前或身后的敌人' }, Elements: [{ TYPE: 'RANGE', SORT: { zh: '接近' } }] } }],
  ));
  const bonk = stats.plantStatsOf('bonkchoy');
  assert.equal(bonk.plantFood.kind, 'self_aoe_multi');
  assert.equal(bonk.plantFood.total, 1500);
  assert.equal(bonk.plantFood.radius, 1);
  assert.equal(bonk.plantFood.confidence, 'high');

  const pea = stats.plantStatsOf('peashooter');
  assert.equal(pea.plantFood.kind, 'barrage');
  assert.equal(pea.plantFood.area, 'row');

  const wall = stats.plantStatsOf('wallnut');
  assert.equal(wall.plantFood.kind, 'self_armor');

  // 没见过的字段：也要给出「有能量豆效果」这个事实，只是 kind=unknown
  const np = stats.plantStatsOf('newplant');
  assert.ok(np.plantFood, '未知字段不能把 plantFood 变成 null');
  assert.equal(np.plantFood.kind, 'unknown');
  assert.equal(np.plantFood.confidence, 'low');
});

test('点击识别：瞄准/再点击也能认出来，并且区分 aim', () => {
  const stats = readerOf(assets(
    [
      { alias: 'hollyknight', props: { SunCost: 150, Cooldown: 15, Toughness: 2500, Family: 'Defence', AttackDamage: 20, AttackInterval: 1, MaxProjectileCount: 3 } },
      { alias: 'escaperoot', props: { SunCost: 50, Cooldown: 20, Toughness: 300, Family: 'Nope' } },
      { alias: 'glaciershroom', props: { SunCost: 75, Cooldown: 30, Toughness: 300, Family: 'Cold' } },
    ],
    [
      { alias: 'hollyknight', objdata: { BriefIntroduction: { zh: '伤害身边的僵尸，点击发射障碍' }, Special: [{ NAME: { zh: '用途' }, DESCRIPTION: { zh: '点击瞄准，再点击目标格子发射' } }] } },
      { alias: 'escaperoot', objdata: { BriefIntroduction: { zh: '点击逃脱树根后，再点击另一株植物来交换位置' } } },
      { alias: 'glaciershroom', objdata: { BriefIntroduction: { zh: '点击寒冰菇冻结全屏的僵尸' }, Elements: [{ TYPE: 'AREA', SORT: { zh: '全屏' } }] } },
    ],
  ));
  const holly = stats.plantStatsOf('hollyknight');
  assert.equal(holly.usage.activation, 'click');
  assert.equal(holly.usage.aim, 'free_cell');
  assert.equal(holly.usage.charges, 3);
  assert.equal(holly.attack.dmg, 20, 'AttackDamage + AttackInterval 要能算出攻击');

  const esc = stats.plantStatsOf('escaperoot');
  assert.equal(esc.usage.activation, 'click');
  assert.equal(esc.usage.aim, 'swap');

  const glacier = stats.plantStatsOf('glaciershroom');
  assert.equal(glacier.usage.activation, 'click');
  assert.equal(glacier.usage.aim, 'self');
});
