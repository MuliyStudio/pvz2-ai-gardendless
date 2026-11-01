#!/usr/bin/env node
/**
 * 全量数据交叉校验：knowledge/data/{plants,zombies}.json × game code 原始 props。
 *
 * 只比较两边都有的字段，输出 issue 清单；用于发现“图鉴/解析值和原始 JSON 对不上”的字段。
 * 运行：npm run crosscheck
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlantStats, checkZombieStats } from '../bridge/crosscheck.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAME = process.env.PVZ_GAME_CODE || path.join(root, '..', 'game code', 'CODE');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const obj = (name) => {
  const p = path.join(GAME, 'Objects', `${name}.json`);
  return fs.existsSync(p) ? read(p) : { objects: [] };
};
const first = (list, alias) => (list || []).find((o) => (o.aliases || [])[0] === alias) || null;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

const PlantProps = obj('PlantProps');
const PlantTypes = obj('PlantTypes');
const ZombieProps = obj('ZombieProps');
const ArmorProps = obj('ArmorProps');

const armorOf = new Map();
for (const o of ArmorProps.objects || []) {
  armorOf.set((o.aliases || [])[0], {
    hp: n(o.objdata && o.objdata.Toughness),
    metal: !!(o.objdata && o.objdata.isMetal),
  });
}

const knowledgePlants = read(path.join(root, 'knowledge', 'data', 'plants.json')).plants || {};
const knowledgeZombies = read(path.join(root, 'knowledge', 'data', 'zombies.json')).zombies || {};

const report = { at: new Date().toISOString(), plants: { checked: 0, issues: 0, byField: {}, samples: [] }, zombies: { checked: 0, issues: 0, byField: {}, samples: [] } };

for (const [type, st] of Object.entries(knowledgePlants)) {
  const t = first(PlantTypes.objects, type);
  const base = (t && t.objdata && t.objdata.PlantBasedOn) || type;
  const rec = first(PlantProps.objects, base) || first(PlantProps.objects, type);
  if (!rec) continue;
  report.plants.checked += 1;
  const r = checkPlantStats({
    ...st,
    armTimeSec: st.armTimeSec != null ? st.armTimeSec : null,
  }, rec.objdata || {});
  if (!r.ok) {
    report.plants.issues += r.issues.length;
    for (const it of r.issues) {
      report.plants.byField[it.field] = (report.plants.byField[it.field] || 0) + 1;
      if (report.plants.samples.length < 30) report.plants.samples.push({ type, ...it });
    }
  }
}

for (const [type, zs] of Object.entries(knowledgeZombies)) {
  const rec = first(ZombieProps.objects, type);
  if (!rec) continue;
  report.zombies.checked += 1;
  const d = rec.objdata || {};
  const armorDetail = (Array.isArray(zs.armorDetail) ? zs.armorDetail : []).map((a) => ({
    ...a, hp: a.hp != null ? a.hp : (armorOf.get(a.id) || {}).hp,
  }));
  const r = checkZombieStats({
    ...zs, armorDetail,
    armorHp: zs.armorHp != null ? zs.armorHp : null,
  }, d);
  if (!r.ok) {
    report.zombies.issues += r.issues.length;
    for (const it of r.issues) {
      report.zombies.byField[it.field] = (report.zombies.byField[it.field] || 0) + 1;
      if (report.zombies.samples.length < 30) report.zombies.samples.push({ type, ...it });
    }
  }
}

const outFile = path.join(root, 'data-crosscheck.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`crosscheck -> ${path.relative(root, outFile)}`);
console.log(`plants: ${report.plants.checked} checked, ${report.plants.issues} issues`, JSON.stringify(report.plants.byField));
console.log(`zombies: ${report.zombies.checked} checked, ${report.zombies.issues} issues`, JSON.stringify(report.zombies.byField));
for (const s of report.plants.samples.slice(0, 5)) console.log('  plant', s.type, s.field, s.expected, '!=', s.actual);
for (const s of report.zombies.samples.slice(0, 5)) console.log('  zombie', s.type, s.field, s.expected, '!=', s.actual);
