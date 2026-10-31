#!/usr/bin/env node
/**
 * 植物数据覆盖率报告：用真实游戏资源跑一遍 bridge/stats.js，
 * 检查「新植物有没有被自动适配」。
 *
 * 用法：
 *   node scripts/plant-data-report.mjs                 # 汇总
 *   node scripts/plant-data-report.mjs bonkchoy ...    # 只看指定卡
 *   node scripts/plant-data-report.mjs --missing       # 列出仍然没被识别出伤害/能量豆的卡
 *
 * 退出码：0 正常；1 数据目录缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStatsReader, resetAssetCache } from '../bridge/stats.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const objectsDir = path.join(root, '..', 'game code', 'CODE', 'Objects');
const featureDir = path.join(root, '..', 'game code', 'CODE', 'Features');

if (!fs.existsSync(objectsDir)) {
  console.error(`[plants] 找不到游戏数据目录：${objectsDir}`);
  process.exit(1);
}

const read = (name) => {
  const a = path.join(objectsDir, name);
  const b = path.join(featureDir, name);
  const p = fs.existsSync(a) ? a : (fs.existsSync(b) ? b : null);
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

const assets = [
  'PlantProps', 'PlantAlmanac', 'PlantTypes', 'PlantFeatures',
  'ZombieProps', 'ZombieAlmanac', 'ZombieFeatures', 'ArmorProps',
  'LawnProps', 'ProjectileProps', 'ProjectileTypes', 'TombstoneProps',
].map((n) => ({ name: n, json: read(`${n}.json`) })).filter((a) => a.json);

resetAssetCache();
const stats = createStatsReader(() => ({ assetManager: { assets: new Map(assets.map((a) => [a.name, a])) } }));

const plantProps = read('PlantProps.json');
const almanac = read('PlantAlmanac.json');
const almMap = new Map(((almanac && almanac.objects) || []).map((o) => [(o.aliases || [])[0], o.objdata || {}]));
const all = ((plantProps && plantProps.objects) || []).map((o) => (o.aliases || [])[0]).filter(Boolean);

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--')));

const rows = [];
for (const t of all) {
  const st = stats.plantStatsOf(t);
  if (!st) continue;
  const a = almMap.get(t) || {};
  const almDmg = (a.Elements || []).some((e) => e.TYPE === 'DAMAGE' && Number(e.VALUE) > 0);
  rows.push({ t, st, almDmg });
}

if (only.length) {
  for (const t of only) {
    const st = stats.plantStatsOf(t);
    if (!st) { console.log(t, '没有数据'); continue; }
    console.log(`\n── ${t} ${st.name}`);
    console.log(JSON.stringify({
      cost: st.cost, cd: st.cd, hp: st.hp, hpMax: st.hpMax, family: st.family, range: st.range, reach: st.reach,
      attack: st.attack, burst: st.burst, effectiveDps: st.effectiveDps,
      damageType: st.damageType, ignoresArmor: st.ignoresArmor, armorState: st.armorState,
      shot: st.shot, plantFood: st.plantFood, usage: st.usage, hpNote: st.hpMax !== st.hp ? `max ${st.hpMax}` : undefined,
    }, null, 1));
  }
  process.exit(0);
}

const withAttack = rows.filter((r) => r.st.attack);
const withBurst = rows.filter((r) => r.st.burst);
const damageLess = rows.filter((r) => r.almDmg && !r.st.attack && !r.st.burst);
const pf = rows.filter((r) => r.st.plantFood);
const pfUnknown = rows.filter((r) => r.st.plantFood && r.st.plantFood.kind === 'unknown');
const manual = rows.filter((r) => r.st.usage && r.st.usage.manual);
const armorUnknown = rows.filter((r) => r.st.armorState === 'unknown');
const noHp = rows.filter((r) => r.st.hp == null);

console.log(`植物 ${rows.length} 张`);
console.log(`  持续输出 attack    ${withAttack.length}`);
console.log(`  单发/爆发 burst   ${withBurst.length}`);
console.log(`  图鉴有 DAMAGE 但没伤害值  ${damageLess.length}${damageLess.length ? '：' + damageLess.map((r) => r.t).join(', ') : ''}`);
console.log(`  能量豆结构化       ${pf.length}（其中 kind=unknown ${pfUnknown.length}）`);
console.log(`  点击/手动激活      ${manual.length}：${manual.map((r) => `${r.t}(${r.st.usage.activation}/${r.st.usage.aim})`).join(', ')}`);
console.log(`  护甲关系未知       ${armorUnknown.length}：${armorUnknown.map((r) => r.t).slice(0, 10).join(', ')}`);
console.log(`  没有血量           ${noHp.length}`);

const kinds = {};
for (const r of pf) kinds[r.st.plantFood.kind] = (kinds[r.st.plantFood.kind] || 0) + 1;
console.log('  能量豆 kind 分布：', JSON.stringify(kinds));

if (flags.has('--missing')) {
  console.log('\n── 有 plantfood 字段但没识别（应为 0）──');
  const pfAny = rows.filter((r) => Object.keys(r.st.props || {}).some((k) => /plantfood/i.test(k)));
  const miss = pfAny.filter((r) => !r.st.plantFood);
  console.log(miss.length ? miss.map((r) => r.t).join(', ') : '（无）');
  console.log('\n── kind=unknown（没看懂字段，但知道有能量豆效果）──');
  for (const r of pfUnknown) {
    console.log(`${r.t}  ←  ${Object.keys(r.st.props || {}).filter((k) => /plantfood/i.test(k)).join(', ')}`);
  }
}

if (flags.has('--zombies')) {
  const zp = read('ZombieProps.json');
  const ztypes = ((zp && zp.objects) || []).map((o) => (o.aliases || [])[0]).filter(Boolean);
  const zrows = ztypes.map((t) => ({ t, st: stats.zombieStatsOf(t) })).filter((r) => r.st);
  const withImmune = zrows.filter((r) => (r.st.immunities || []).length);
  const withSpawns = zrows.filter((r) => (r.st.spawns || []).length);
  const bosses = zrows.filter((r) => r.st.boss);
  const unknown = zrows.filter((r) => (r.st.behaviorUnknown || []).length);
  console.log(`\n僵尸 ${zrows.length} 只`);
  console.log(`  有免疫/限制事实   ${withImmune.length}`);
  console.log(`  会召唤/生成      ${withSpawns.length}`);
  console.log(`  Boss             ${bosses.length}：${bosses.map((r) => r.t).join(', ')}`);
  console.log(`  未归类免疫字段   ${unknown.length}${unknown.length ? '：' + unknown.slice(0, 8).map((r) => `${r.t}(${r.st.behaviorUnknown.join('|')})`).join(', ') : ''}`);
}
