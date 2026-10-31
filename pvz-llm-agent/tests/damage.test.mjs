import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsReader, resetAssetCache } from '../bridge/stats.js';
import { cardCapabilities, coverageAudit } from '../bridge/mechanics.js';

function fakeAssets() {
  return [
    {
      name: 'PlantFeatures',
      json: {
        PLANTS: [
          { CODENAME: 'poisonpeashooter', NAME: { zh: '黏毒豌豆', en: 'Goo Peashooter' } },
          { CODENAME: 'spikeweed', NAME: { zh: '地刺', en: 'Spikeweed' } },
        ],
      },
    },
    {
      name: 'PlantProps',
      json: {
        objects: [
          { aliases: ['poisonpeashooter'], objdata: { ShootInterval: 1.35, SunCost: 150, Cooldown: 5, Toughness: 300, Family: 'Poison', PeaType: 'pea_goo' } },
          { aliases: ['spikeweed'], objdata: { Damage: 10, AttackInterval: 0.5, SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Sharp' } },
        ],
      },
    },
    {
      name: 'PlantAlmanac',
      json: {
        objects: [
          {
            aliases: ['poisonpeashooter'],
            objdata: {
              BriefIntroduction: { zh: '发射黏性毒液豌豆子弹' },
              Introduction: { zh: '黏毒豌豆' },
              Special: [],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 30 }, { TYPE: 'RANGE', SORT: { zh: '直线' } }, { TYPE: 'SPECIAL', SORT: { zh: '毒伤' } }],
            },
          },
          {
            aliases: ['spikeweed'],
            objdata: {
              BriefIntroduction: { zh: '对走过的僵尸造成伤害' },
              Introduction: { zh: '地刺' },
              Special: [{ NAME: { zh: '特点' }, DESCRIPTION: { zh: '不会被僵尸啃食' } }],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 10 }, { TYPE: 'AREA', SORT: { zh: '本格' } }],
            },
          },
        ],
      },
    },
    { name: 'PlantTypes', json: { objects: [] } },
    {
      name: 'ProjectileProps',
      json: {
        objects: [{
          aliases: ['pea_goo'],
          objdata: { Damage: 30, PoisonStacked: { DPS: 10, Duration: 5 }, ZombieSpeedStacked: { SpeedMult: 0.95, Duration: 5 } },
        }],
      },
    },
    {
      name: 'ProjectileTypes',
      json: { objects: [{ aliases: ['pea_goo'], objdata: { Props: 'RTID(pea_goo@ProjectileProps)' } }] },
    },
    { name: 'ZombieProps', json: { objects: [] } },
    { name: 'ZombieAlmanac', json: { objects: [] } },
    { name: 'ArmorProps', json: { objects: [] } },
    { name: 'LawnProps', json: { objects: [] } },
  ];
}

function fakeCc() {
  const list = fakeAssets();
  return { assetManager: { assets: new Map(list.map((a) => [a.name, a])) } };
}

test('stats：黏毒豌豆的毒伤/真伤从 ProjectileProps 读出来', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc());
  const st = stats.plantStatsOf('poisonpeashooter');
  assert.ok(st, '应读到 poisonpeashooter');
  assert.equal(st.attack.dps, 22.2);
  assert.equal(st.attack.ignoresArmor, false, '普通豌豆本身仍先打护甲');
  assert.equal(st.ignoresArmor, true, '毒伤直接打本体');
  assert.equal(st.trueDamage, true);
  assert.ok(st.poison, JSON.stringify(st));
  assert.equal(st.poison.dps, 10);
  assert.equal(st.poison.duration, 5);
  assert.equal(st.poison.total, 50);
  assert.deepEqual(st.poison.slow, { speedMult: 0.95, duration: 5 });
  assert.ok(cardCapabilities('poisonpeashooter', st).includes('true_damage'));
});

test('stats：地刺识别为 stepDamage（本格伤害），不是普通直线输出', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc());
  const st = stats.plantStatsOf('spikeweed');
  assert.equal(st.stepDamage, true);
  assert.equal(st.area, '本格');
  assert.equal(st.shot.kind, 'ground');
  assert.ok(cardCapabilities('spikeweed', st).includes('anti_rolling'));
});

test('coverageAudit：护甲可由 high_dps 或 true_damage 任一覆盖', () => {
  const statsOf = (t) => {
    if (t === 'poisonpeashooter') return { family: 'Poison', poison: { dps: 10 }, attack: { dps: 22.2, targets: 1, ignoresArmor: true } };
    if (t === 'peashooter') return { family: 'Peashooter', attack: { dps: 13.3, targets: 1 } };
    return null;
  };
  const miss = coverageAudit({ tags: ['armored'], deck: ['peashooter'], plantStatsOf: statsOf, pool: ['poisonpeashooter'] });
  assert.equal(miss.missing.length, 1);
  assert.equal(miss.missing[0].capability, 'high_dps');
  assert.deepEqual(miss.missing[0].alternatives, ['high_dps', 'true_damage']);
  assert.deepEqual(miss.missing[0].candidates, ['poisonpeashooter']);

  const ok = coverageAudit({ tags: ['armored'], deck: ['poisonpeashooter'], plantStatsOf: statsOf });
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.present.true_damage, ['poisonpeashooter']);
});
