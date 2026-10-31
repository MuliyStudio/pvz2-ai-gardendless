#!/usr/bin/env node
/**
 * 从游戏 JSON 自动生成统一 mechanics 数据。
 *
 * 只做数据整理，不做策略：
 *   - 所有 PlantProps / ZombieProps / ArmorProps / ProjectileProps 的标量字段
 *   - 关键字段单独提取（费用/冷却/血量/速度/啃食/护甲/出土时间）
 *   - 标签和 tag 克制关系
 *
 * 用法：npm run mechanics
 * 输出：knowledge/data/mechanics.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAG_COUNTERS } from '../knowledge/worlds.js';
import { zombieTagsFrom } from '../knowledge/tags.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const objectsDir = path.join(root, '..', 'game code', 'CODE', 'Objects');
const outFile = path.join(root, 'knowledge', 'data', 'mechanics.json');

if (!fs.existsSync(objectsDir)) {
  console.error(`[mechanics] 找不到游戏数据目录：${objectsDir}`);
  process.exit(1);
}

const readJson = (name) => {
  const p = path.join(objectsDir, name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    console.warn(`[mechanics] 跳过 ${name}: ${e.message}`);
    return null;
  }
};

function scalars(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 160);
  }
  return out;
}

function indexObjects(file) {
  const doc = readJson(file);
  const map = new Map();
  for (const o of (doc && doc.objects) || []) {
    const alias = (o.aliases && o.aliases[0]) || (o.objdata && o.objdata.CODENAME);
    if (!alias) continue;
    map.set(alias, o);
  }
  return map;
}

function tagsOf(text) {
  const s = String(text || '');
  const tags = new Set();
  const add = (t, re) => { if (re.test(s)) tags.add(t); };
  add('rolling', /滚桶|滚木|滚筒|barrel\s*roll|rolling/i);
  add('flying', /飞行|空中|荡索|飞越|jetpack|balloon|seagull|pelican|swashbuckler/i);
  add('armored', /护甲|铁桶|头盔|armor|bucket|helmet/i);
  add('crush', /锤|砸|碾压|crush|smash/i);
  add('gargantuar', /巨人|gargantuar/i);
  add('carries_imp', /小鬼|imp/i);
  add('steal', /偷|steal/i);
  add('amphibious', /水|swim|amphibious/i);
  add('lane_switch', /换行|换道|lane\s*switch|disco/i);
  add('hypnotizable', /魅惑|hypno/i);
  return [...tags];
}

const plantsRaw = indexObjects('PlantProps.json');
const zombiesRaw = indexObjects('ZombieProps.json');
const armorRaw = indexObjects('ArmorProps.json');
const projectileRaw = indexObjects('ProjectileProps.json');

const armors = {};
for (const [id, o] of armorRaw) {
  const d = o.objdata || {};
  armors[id] = { hp: d.Toughness ?? null, metal: !!d.isMetal, ice: !!d.isIce, props: scalars(d) };
}

const plants = {};
for (const [id, o] of plantsRaw) {
  const d = o.objdata || {};
  plants[id] = {
    family: d.Family || null,
    cost: d.SunCost ?? null,
    cooldown: d.Cooldown ?? null,
    hp: d.Toughness ?? null,
    damage: d.Damage ?? null,
    interval: d.AttackInterval ?? d.ThrowInterval ?? d.ShootInterval ?? null,
    armTimeSec: d.ChargeTime ?? d.ArmTime ?? d.ExplodeDelay ?? 0,
    props: scalars(d),
  };
}

const zombies = {};
for (const [id, o] of zombiesRaw) {
  const d = o.objdata || {};
  const armorIds = Array.isArray(d.StartingArmors) ? d.StartingArmors : [];
  const text = [d.BriefIntroduction, d.Introduction, ...(Array.isArray(d.Special) ? d.Special : [])]
    .map((x) => (x && (x.zh || x.en)) || '')
    .join(' ');
  zombies[id] = {
    hp: d.Toughness ?? null,
    speed: d.WalkSPS ?? null,
    eatDps: d.EatDPS ?? null,
    armors: armorIds.map((a) => ({ id: a, ...(armors[a] || {}) })),
    tags: tagsOf(text || id),
    props: scalars(d),
  };
}

const projectiles = {};
for (const [id, o] of projectileRaw) {
  const d = o.objdata || {};
  projectiles[id] = {
    damage: d.Damage ?? null,
    props: scalars(d),
  };
}

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: path.relative(root, objectsDir).replace(/\\/g, '/'),
  counts: {
    plants: Object.keys(plants).length,
    zombies: Object.keys(zombies).length,
    armors: Object.keys(armors).length,
    projectiles: Object.keys(projectiles).length,
  },
  tagCounters: TAG_COUNTERS,
  plants,
  zombies,
  armors,
  projectiles,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`[mechanics] ${Object.keys(plants).length} plants / ${Object.keys(zombies).length} zombies / ${Object.keys(armors).length} armors -> ${path.relative(root, outFile)}`);
