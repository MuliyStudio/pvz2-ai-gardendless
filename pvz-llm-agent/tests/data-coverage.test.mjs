import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStatsReader, resetAssetCache } from '../bridge/stats.js';

/**
 * 数据配额回归：拿真实游戏资源跑一遍，检查「新植物有没有被自动适配」。
 *
 * 这些断言故意写成“配额”，不是逐张卡断言：
 *   - 新卡只要落进已知字段族，配额自动满足；
 *   - 一旦掉配额（= 出现了没被识别的新字段），这里直接红，不用等玩家发现。
 *
 * 资源目录不在时自动跳过（换机器/CI 也能跑测试）。
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const objectsDir = path.join(root, '..', 'game code', 'CODE', 'Objects');
const featureDir = path.join(root, '..', 'game code', 'CODE', 'Features');
const hasAssets = fs.existsSync(path.join(objectsDir, 'PlantProps.json'));

const read = (name) => {
  for (const dir of [objectsDir, featureDir]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
    }
  }
  return null;
};

function loadAll() {
  const names = ['PlantProps', 'PlantAlmanac', 'PlantTypes', 'PlantFeatures',
    'ZombieProps', 'ZombieAlmanac', 'ZombieFeatures', 'ArmorProps',
    'LawnProps', 'ProjectileProps', 'ProjectileTypes'];
  const assets = names.map((n) => ({ name: n, json: read(`${n}.json`) })).filter((a) => a.json);
  resetAssetCache();
  const stats = createStatsReader(() => ({ assetManager: { assets: new Map(assets.map((a) => [a.name, a])) } }));
  const props = read('PlantProps.json');
  const almanac = read('PlantAlmanac.json');
  const almMap = new Map(((almanac && almanac.objects) || []).map((o) => [(o.aliases || [])[0], o.objdata || {}]));
  const types = ((props && props.objects) || []).map((o) => (o.aliases || [])[0]).filter(Boolean);
  const rows = types.map((t) => ({ t, st: stats.plantStatsOf(t), alm: almMap.get(t) || {} })).filter((r) => r.st);
  return rows;
}

test('数据配额：真实资源里没有「图鉴有 DAMAGE 但没有任何伤害值」的卡', { skip: !hasAssets && '没有 game code 目录' }, () => {
  const rows = loadAll();
  assert.ok(rows.length > 200, `只读到 ${rows.length} 张植物`);
  const bad = rows.filter(({ st, alm }) => {
    const hasAlmDmg = (alm.Elements || []).some((e) => e.TYPE === 'DAMAGE' && Number(e.VALUE) > 0);
    return hasAlmDmg && !st.attack && !st.burst;
  }).map((r) => r.t);
  assert.deepEqual(bad, [], `这些卡的伤害值丢了：${bad.join(', ')}`);
});

test('数据配额：有 plantfood 字段的卡必须给出结构化 plantFood，且不留 unknown', { skip: !hasAssets && '没有 game code 目录' }, () => {
  const rows = loadAll();
  const withFields = rows.filter(({ st }) => Object.keys(st.props || {}).some((k) => /plantfood/i.test(k)));
  assert.ok(withFields.length > 100, `只找到 ${withFields.length} 张带能量豆字段的卡`);
  const missing = withFields.filter(({ st }) => !st.plantFood).map((r) => r.t);
  assert.deepEqual(missing, [], `这些卡的能量豆没解析出来：${missing.join(', ')}`);
  const unknown = rows.filter(({ st }) => st.plantFood && st.plantFood.kind === 'unknown').map((r) => r.t);
  assert.deepEqual(unknown, [], `这些卡的能量豆类别没看懂（需要在 knowledge/plant-rules.js 加字段族）：${unknown.join(', ')}`);
});

test('数据配额：图鉴写明「点击」的卡必须被识别成手动激活，并给出 aim', { skip: !hasAssets && '没有 game code 目录' }, () => {
  const rows = loadAll();
  const clicky = rows.filter(({ alm }) => {
    const text = [
      alm.BriefIntroduction && alm.BriefIntroduction.zh,
      alm.Introduction && alm.Introduction.zh,
      ...((alm.Special || []).map((s) => s && s.DESCRIPTION && s.DESCRIPTION.zh)),
    ].filter(Boolean).join(' ');
    return /点击|轻触/.test(text);
  }).map((r) => r.t);
  assert.ok(clicky.length >= 12, `只识别到 ${clicky.length} 张点击卡`);
  const missed = rows.filter(({ t, st }) => clicky.includes(t) && !(st.usage && st.usage.manual)).map((r) => r.t);
  assert.deepEqual(missed, [], `这些点击卡没识别成手动激活：${missed.join(', ')}`);
  const noAim = rows.filter(({ t, st }) => clicky.includes(t) && !(st.usage && st.usage.aim)).map((r) => r.t);
  assert.deepEqual(noAim, [], `这些点击卡没有 aim（不知道点完打哪）：${noAim.join(', ')}`);
});

test('数据配额：每张有伤害的卡都能说清「打不打护甲」', { skip: !hasAssets && '没有 game code 目录' }, () => {
  const rows = loadAll();
  const unknown = rows.filter(({ st }) => st.armorState === 'unknown').map((r) => r.t);
  assert.deepEqual(unknown, [], `这些卡的伤害语义没分类（armorState=unknown）：${unknown.join(', ')}`);
});

test('数据配额：僵尸的免疫/召唤/Boss 字段不能被静默丢掉', { skip: !hasAssets && '没有 game code 目录' }, () => {
  const names = ['ZombieProps', 'ZombieAlmanac', 'ZombieFeatures', 'ArmorProps', 'LawnProps'];
  const assets = names.map((n) => ({ name: n, json: read(`${n}.json`) })).filter((a) => a.json);
  resetAssetCache();
  const stats = createStatsReader(() => ({ assetManager: { assets: new Map(assets.map((a) => [a.name, a])) } }));
  const props = read('ZombieProps.json');
  const types = ((props && props.objects) || []).map((o) => (o.aliases || [])[0]).filter(Boolean);
  const rows = types.map((t) => ({ t, st: stats.zombieStatsOf(t) })).filter((r) => r.st);
  assert.ok(rows.length > 300, `只读到 ${rows.length} 只僵尸`);
  const unknown = rows.filter((r) => (r.st.behaviorUnknown || []).length);
  assert.deepEqual(unknown.map((r) => `${r.t}(${r.st.behaviorUnknown.join('|')})`), [],
    '这些僵尸的免疫字段没归类（需要在 knowledge/zombie-rules.js 加规则）');
  const bosses = rows.filter((r) => r.st.boss);
  assert.ok(bosses.length > 0, 'Boss 一只都没识别出来');
  const immune = rows.filter((r) => (r.st.immunities || []).length);
  assert.ok(immune.length > 100, `只有 ${immune.length} 只僵尸有免疫事实，字段族可能没覆盖`);
});
