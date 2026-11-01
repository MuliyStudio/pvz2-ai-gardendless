import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlantStats, checkZombieStats, matchup } from '../bridge/crosscheck.js';

test('crosscheck：植物派生 dps/multiDps 与原始字段不一致时给出 issue', () => {
  const st = {
    type: 'x', cost: 100, cd: 5, hp: 300, armTimeSec: 14,
    attack: { dmg: 40, interval: 2.7, dps: 20, targets: 2, hitsPerTarget: 1, multiDps: 40 },
    burst: null, sun: null,
  };
  const r = checkPlantStats(st, { SunCost: 100, Cooldown: 5, Toughness: 300, ChargeTime: 14, Damage: 40 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'attack.dps'), JSON.stringify(r.issues));
  assert.ok(r.issues.some((i) => i.field === 'attack.multiDps'), JSON.stringify(r.issues));
});

test('crosscheck：僵尸 ehp/护甲/速度与原始字段不一致时给出 issue', () => {
  const z = { type: 'z', hp: 190, armorHp: 100, ehp: 300, speed: 0.2, eatDps: 100, armorDetail: [{ hp: 50 }], behaviorUnknown: [] };
  const r = checkZombieStats(z, { Toughness: 190, WalkSPS: 0.185, EatDPS: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'ehp'), JSON.stringify(r.issues));
  assert.ok(r.issues.some((i) => i.field === 'armorHp'), JSON.stringify(r.issues));
  assert.ok(r.issues.some((i) => i.field === 'speed'), JSON.stringify(r.issues));
});

test('crosscheck：配对能看到免疫/护甲/多目标 ttk', () => {
  const plant = {
    type: 'ice', family: 'Cold', attack: { dps: 10, multiDps: 10, targets: 1, ignoresArmor: false },
    ignoresArmor: false, damageType: 'normal',
  };
  const zombie = {
    type: 'z', hp: 200, armorHp: 100, ehp: 300,
    immunities: [{ id: 'ice', text: '免疫冰冻' }],
  };
  const m = matchup(plant, zombie);
  assert.equal(m.immune.text, '免疫冰冻');
  assert.equal(m.verdict, 'immune');
  assert.equal(m.armorHp, 100);
  assert.equal(m.singleTtk, 30);
});
