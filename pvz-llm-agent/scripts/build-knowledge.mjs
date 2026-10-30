#!/usr/bin/env node
/**
 * 从游戏数据生成静态图鉴：knowledge/data/{plants,zombies}.json
 *
 * 只抽事实字段；不含"推荐/打法"。运行时仍以游戏内资源为准，静态包用于测试、
 * MCP 端预读和没有资源缓存时的兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAME = process.env.PVZ_GAME_CODE || path.join(root, '..', 'game code', 'CODE');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const txt = (v) => (v == null ? null : (typeof v === 'string' ? v : (v.zh || v.en || null)));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const first = (list, alias) => (list || []).find((o) => (o.aliases || [])[0] === alias) || null;

function load() {
  const obj = (name) => {
    const p = path.join(GAME, 'Objects', `${name}.json`);
    return fs.existsSync(p) ? readJson(p) : { objects: [] };
  };
  const feat = (name) => {
    const p = path.join(GAME, 'Features', `${name}.json`);
    return fs.existsSync(p) ? readJson(p)[name === 'PlantFeatures' ? 'PLANTS' : 'ZOMBIES'] || [] : [];
  };
  return {
    PlantProps: obj('PlantProps'), PlantAlmanac: obj('PlantAlmanac'), PlantTypes: obj('PlantTypes'),
    ZombieProps: obj('ZombieProps'), ZombieAlmanac: obj('ZombieAlmanac'), ArmorProps: obj('ArmorProps'),
    plants: feat('PlantFeatures'), zombies: feat('ZombieFeatures'),
  };
}

function almanacFacts(almObj) {
  const d = (almObj && almObj.objdata) || {};
  const els = Array.isArray(d.Elements) ? d.Elements : [];
  const rangeEl = els.find((e) => e && e.TYPE === 'RANGE');
  const dmgEl = els.find((e) => e && e.TYPE === 'DAMAGE');
  const special = (Array.isArray(d.Special) ? d.Special : []).map((x) => ({
    name: txt(x && x.NAME),
    text: txt(x && x.DESCRIPTION),
  })).filter((x) => x.text);
  return {
    brief: txt(d.BriefIntroduction),
    introduction: txt(d.Introduction),
    range: rangeEl && rangeEl.SORT ? txt(rangeEl.SORT) : null,
    damage: dmgEl && num(dmgEl.VALUE) != null ? num(dmgEl.VALUE) : null,
    special,
    weaknesses: special.filter((x) => /弱|缺点|weak/i.test(String(x.name || ''))).map((x) => x.text),
  };
}

const TAG_RULES = [
  ['rolling', (d) => !!d.BarrelType],
  ['flying', (d) => !!(d.FlyingSpeed || d.ChooseToSpawnOnNonDeckRows)],
  ['steal', (d) => !!(d.ParrotCooldown || d.StealPlant)],
  ['crush', (d) => !!d.SmashDamage],
  ['gargantuar', (d) => d.ZombieSort === 'Gargantuar'],
  ['armored', (d) => Array.isArray(d.StartingArmors) && d.StartingArmors.length > 0],
  ['amphibious', (d) => !!d.LivesInDeepWater],
  ['carries_imp', (d) => !!d.ImpType],
  ['rush', (d) => !!d.SpeedUpWhenEatPlants],
  ['lane_switch', (d, text) => /跳舞|换行|disco/i.test(text)],
];

function buildPlants(data) {
  const out = {};
  for (const f of data.plants) {
    const code = f.CODENAME;
    if (!code) continue;
    const type = first(data.PlantTypes.objects, code);
    const base = (type && type.objdata && type.objdata.PlantBasedOn) || code;
    const rec = first(data.PlantProps.objects, base) || first(data.PlantProps.objects, code);
    if (!rec) continue;
    const d = rec.objdata || {};
    const alm = almanacFacts(first(data.PlantAlmanac.objects, code));
    const dmg = num(d.Damage) != null ? num(d.Damage) : alm.damage;
    const interval = num(d.AttackInterval) || num(d.ThrowInterval) || num(d.ShootInterval) || null;
    const sunValues = Array.isArray(d.SunValueList) ? d.SunValueList.map(num).filter((x) => x > 0) : (num(d.SunValue) ? [num(d.SunValue)] : []);
    const cost = num(d.SunCost);
    const prodDay = num(d.ProduceInterval);
    const prodNight = num(d.ProduceInterval_AtNight) != null ? num(d.ProduceInterval_AtNight) : prodDay;
    out[code] = {
      type: code,
      name: txt(f.NAME) || code,
      nameEn: (f.NAME && f.NAME.en) || null,
      world: f.OBTAINWORLD || null,
      cost,
      cd: num(d.Cooldown),
      hp: num(d.Toughness),
      family: d.Family || null,
      range: alm.range,
      attack: dmg != null && interval ? { dmg, interval, dps: Math.round((dmg / interval) * 10) / 10 } : null,
      sun: sunValues.length ? {
        stages: sunValues, interval: prodDay, intervalNight: prodNight,
        perSecDay: prodDay ? sunValues.map((v) => Math.round((v / prodDay) * 1000) / 1000) : null,
        perSecNight: prodNight ? sunValues.map((v) => Math.round((v / prodNight) * 1000) / 1000) : null,
      } : null,
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special,
      weaknesses: alm.weaknesses,
    };
  }
  return out;
}

function buildZombies(data) {
  const armor = new Map();
  for (const o of data.ArmorProps.objects) {
    armor.set((o.aliases || [])[0], {
      hp: num(o.objdata && o.objdata.Toughness),
      metal: !!(o.objdata && o.objdata.isMetal),
      ice: !!(o.objdata && o.objdata.isIce),
    });
  }
  const out = {};
  for (const f of data.zombies) {
    const code = f.CODENAME;
    if (!code) continue;
    const rec = first(data.ZombieProps.objects, code);
    if (!rec) continue;
    const d = rec.objdata || {};
    const alm = almanacFacts(first(data.ZombieAlmanac.objects, code));
    const text = [alm.introduction, ...alm.special.map((x) => x.text)].filter(Boolean).join(' ');
    const armorDetail = (Array.isArray(d.StartingArmors) ? d.StartingArmors : []).map((id) => ({
      id, ...(armor.get(id) || { hp: null, metal: false, ice: false }),
    }));
    const armorHp = armorDetail.reduce((s, a) => s + (a.hp || 0), 0);
    const hp = num(d.Toughness);
    out[code] = {
      type: code,
      name: txt(f.NAME) || code,
      nameEn: (f.NAME && f.NAME.en) || null,
      world: f.OBTAINWORLD || null,
      hp,
      armorDetail: armorDetail.length ? armorDetail : null,
      armorHp: armorHp || null,
      ehp: hp != null ? hp + armorHp : null,
      speed: num(d.WalkSPS),
      eatDps: num(d.EatDPS),
      tags: TAG_RULES.filter(([, fn]) => fn(d, text)).map(([t]) => t),
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special,
      weaknesses: alm.weaknesses,
    };
  }
  return out;
}

function main() {
  const data = load();
  const plants = buildPlants(data);
  const zombies = buildZombies(data);
  const outDir = path.join(root, 'knowledge', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    generatedAt: new Date().toISOString(),
    source: path.relative(root, GAME) || GAME,
    counts: { plants: Object.keys(plants).length, zombies: Object.keys(zombies).length },
  };
  fs.writeFileSync(path.join(outDir, 'plants.json'), JSON.stringify({ meta, plants }), 'utf8');
  fs.writeFileSync(path.join(outDir, 'zombies.json'), JSON.stringify({ meta, zombies }), 'utf8');
  console.log(`knowledge -> ${path.relative(root, outDir)} (plants ${meta.counts.plants}, zombies ${meta.counts.zombies})`);
}

main();
