/**
 * stats：从游戏资源里读"事实"。
 *
 * 这里只有数据：植物数值、僵尸数值、护甲、昼夜、关卡脚本、图鉴文本。
 * 不判断"该不该选/该种哪里"，也不产生任何建议。
 */

const numOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const textOf = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.zh || v.en || null;
};

/** 图鉴标签 / 弹道 / 障碍语义（与旧 bridge 一致，纯事实） */
export const SHOT_BY_FAMILY = {
  Lobber: 'lob', Magic: 'lob', Melee: 'melee', Peashooter: 'straight', Sharp: 'straight',
  Poison: 'straight', Electricity: 'beam', Fire: 'area', Shadow: 'straight',
  Defence: 'none', Sun: 'none', Explosive: 'instant', Cold: 'none', Slow: 'none', Nope: 'none',
};

export function shotOf(st) {
  if (!st) return null;
  const fam = String(st.family || '');
  const rng = String(st.range || '');
  let kind = SHOT_BY_FAMILY[fam] || null;
  if (fam === 'Fire') kind = 'area';
  if (/抛物|抛掷|投掷|高抛/.test(rng)) kind = 'lob';
  else if (/接近|近战/.test(rng) && fam !== 'Fire') kind = 'melee';
  else if (fam === 'Explosive') kind = 'instant';
  if ((kind === 'none' || !kind) && st.attack && st.attack.dps) kind = 'straight';
  if (!kind) return null;
  return {
    kind,
    overObstacle: kind === 'lob' || kind === 'melee' || kind === 'area' || kind === 'instant',
    blockedByStraightBlocker: kind === 'straight' || kind === 'beam',
  };
}

export const OBSTACLE_FACTS = {
  tomb: { name: '墓碑', blocksPlanting: true, blocksStraightShot: true, removeBy: 'gravebuster' },
  mold: { name: '霉斑', blocksPlanting: true, blocksStraightShot: null },
  ice: { name: '冰块', blocksPlanting: null, blocksStraightShot: null },
  vase: { name: '罐子', blocksPlanting: true, blocksStraightShot: null },
  slider: { name: '滑轨格', blocksPlanting: null, blocksStraightShot: null },
  gold: { name: '金瓷砖', blocksPlanting: false, blocksStraightShot: false },
};

export function zombieTagsFrom(props, almanacText = '') {
  const d = props || {};
  const tags = [];
  if (d.BarrelType) tags.push('rolling');
  if (d.ChooseToSpawnOnNonDeckRows) tags.push('flying');
  if (d.FlyingSpeed) tags.push('flying');
  if (d.ParrotCooldown) tags.push('steal');
  if (d.SmashDamage) tags.push('crush');
  if (d.ZombieSort === 'Gargantuar') tags.push('gargantuar');
  if (Array.isArray(d.StartingArmors) && d.StartingArmors.length) tags.push('armored');
  if (d.LivesInDeepWater) tags.push('amphibious');
  if (d.ImpType) tags.push('carries_imp');
  if (/跳舞|换行|disco/i.test(almanacText)) tags.push('lane_switch');
  if (d.SpeedUpWhenEatPlants) tags.push('rush');
  if (d.StealPlant) tags.push('steal');
  if (d.HypnotizeByPlantFood) tags.push('hypnotizable');
  return [...new Set(tags)];
}

/** 把图鉴文本里的"用法"抽成结构化事实（activation / area / needs）。 */
const ACTIVATION_RULES = [
  [/点击消耗阳光|消耗阳光发射|花费阳光/, 'click_sun'],
  [/点击后|点击发射|点击向前|点击冻结|点击选择一格|需要点击/, 'click'],
  [/必须种植在墓碑|种植在墓碑上/, 'on_tomb'],
  [/种植在冰块上|融化这?块?冰块/, 'on_ice'],
  [/被啃食|吃掉后|被吃掉后|吃下后/, 'contact'],
];
const AREA_RULES = [
  [/3x3|3×3|周围|范围(内|中)/, 'aoe3x3'],
  [/一整行|整行|本行所有/, 'row'],
  [/三行|向三行|三行僵尸/, 'multi_lane'],
  [/本行|身前|走过的僵尸/, 'lane'],
];
const NEED_RULES = [
  [/墓碑/, 'tomb'],
  [/冰块/, 'ice'],
  [/水面|水中|两栖/, 'water'],
  [/空中|飞天花盆/, 'pot'],
];

export function usageFacts(stats) {
  const text = [stats && stats.brief, ...((stats && stats.special) || [])].filter(Boolean).join(' ');
  const activation = (ACTIVATION_RULES.find(([re]) => re.test(text)) || [null, 'auto'])[1];
  const area = (AREA_RULES.find(([re]) => re.test(text)) || [null, 'single'])[1];
  const needs = NEED_RULES.filter(([re]) => re.test(text)).map(([, n]) => n);
  return {
    activation,
    area,
    needs,
    manual: activation === 'click' || activation === 'click_sun',
    onlyTomb: activation === 'on_tomb',
    onlyIce: activation === 'on_ice',
    contact: activation === 'contact',
  };
}

let assetBag = null;
let assetSource = null;
const ESSENTIAL_ASSETS = ['PlantProps', 'PlantAlmanac', 'ZombieProps', 'ZombieAlmanac', 'ArmorProps'];

function readAssets(getCc) {
  if (assetBag && ESSENTIAL_ASSETS.every((k) => assetBag[k])) return assetBag;
  try {
    const cc = getCc();
    const assets = cc && cc.assetManager && cc.assetManager.assets;
    if (!assets) return null;
    const bag = { ...(assetBag || {}) };
    const want = [
      'PlantProps', 'PlantAlmanac', 'PlantTypes', 'PlantFeatures',
      'ZombieProps', 'ZombieAlmanac', 'ZombieTypes', 'ZombieFeatures',
      'ArmorProps', 'LawnProps', 'TombstoneProps',
    ];
    assets.forEach((a) => {
      if (!a || !a.json) return;
      const hasObjects = Array.isArray(a.json.objects);
      const hasFeature = Array.isArray(a.json.PLANTS) || Array.isArray(a.json.ZOMBIES);
      if (!hasObjects && !hasFeature) return;
      if (want.includes(a.name)) bag[a.name] = a.json;
    });
    if (!Object.keys(bag).length) return null;
    assetBag = bag;
    assetSource = new Set(Object.keys(bag));
    return bag;
  } catch {
    return null;
  }
}

export function resetAssetCache() {
  assetBag = null;
  assetSource = null;
}

export function assetNames() {
  return assetSource ? [...assetSource] : [];
}

function firstObj(bag, name, alias) {
  const list = (bag && bag[name] && bag[name].objects) || [];
  return list.find((o) => (o.aliases || [])[0] === alias) || list.find((o) => (o.aliases || []).includes(alias)) || null;
}

function featureName(bag, kind, codename) {
  const key = kind === 'plant' ? 'PlantFeatures' : 'ZombieFeatures';
  const listKey = kind === 'plant' ? 'PLANTS' : 'ZOMBIES';
  const list = (bag && bag[key] && bag[key][listKey]) || [];
  const hit = list.find((o) => o && o.CODENAME === codename);
  if (!hit) return null;
  return { zh: textOf(hit.NAME), en: (hit.NAME && hit.NAME.en) || null };
}

function almanacOf(bag, kind, type) {
  const obj = firstObj(bag, kind === 'plant' ? 'PlantAlmanac' : 'ZombieAlmanac', type);
  return (obj && obj.objdata) || null;
}

function almanacFacts(bag, kind, type) {
  const a = almanacOf(bag, kind, type);
  if (!a) return { brief: null, introduction: null, special: [], weaknesses: [], elements: [] };
  const special = Array.isArray(a.Special)
    ? a.Special.map((x) => ({
      name: textOf(x && x.NAME),
      text: textOf(x && x.DESCRIPTION),
    })).filter((x) => x.text)
    : [];
  return {
    brief: textOf(a.BriefIntroduction),
    introduction: textOf(a.Introduction),
    special,
    weaknesses: special.filter((x) => /弱|缺点|weak/i.test(String(x.name || ''))).map((x) => x.text),
    elements: Array.isArray(a.Elements) ? a.Elements.map((e) => ({
      type: e && e.TYPE,
      value: e && e.VALUE != null ? e.VALUE : null,
      sort: e && e.SORT ? textOf(e.SORT) : null,
    })) : [],
  };
}

export function createStatsReader(getCc) {
  const plantCache = new Map();
  const zombieCache = new Map();
  const levelCache = new WeakMap();
  function bag() { return readAssets(getCc); }

  function plantStatsOf(type) {
    if (plantCache.has(type)) return plantCache.get(type);
    const st = buildPlantStats(type);
    if (st) plantCache.set(type, st);
    return st;
  }

  function buildPlantStats(type) {
    const b = bag();
    if (!b || !b.PlantProps) return null;
    let base = type;
    try {
      const t = firstObj(b, 'PlantTypes', type);
      const based = t && t.objdata && t.objdata.PlantBasedOn;
      if (based && based !== type) base = based;
    } catch { /* ignore */ }
    const rec = firstObj(b, 'PlantProps', base) || firstObj(b, 'PlantProps', type);
    if (!rec) return null;
    const d = rec.objdata || {};
    const alm = almanacFacts(b, 'plant', type);
    const el = alm.elements.find((e) => e.type === 'RANGE');
    const range = (el && el.sort) || null;
    const dmgAlm = (() => {
      const de = alm.elements.find((e) => e.type === 'DAMAGE');
      return de && Number.isFinite(Number(de.value)) ? Number(de.value) : null;
    })();
    const dmg = numOf(d.Damage) != null ? numOf(d.Damage) : dmgAlm;
    const interval = numOf(d.AttackInterval) || numOf(d.ThrowInterval) || numOf(d.ShootInterval) || null;
    const sunValue = numOf(d.SunValue);
    const list = Array.isArray(d.SunValueList) ? d.SunValueList.map(numOf).filter((v) => v > 0) : null;
    const prodDay = numOf(d.ProduceInterval);
    const prodNight = numOf(d.ProduceInterval_AtNight) != null ? numOf(d.ProduceInterval_AtNight) : prodDay;
    const stages = list && list.length ? list : (sunValue ? [sunValue] : []);
    const rate = (vals, iv) => (iv > 0 && vals.length ? vals.map((v) => Math.round((v / iv) * 1000) / 1000) : null);
    const cost = numOf(d.SunCost);
    const names = featureName(b, 'plant', type);
    const st = {
      type,
      name: (names && names.zh) || type,
      nameEn: (names && names.en) || null,
      cost,
      cd: numOf(d.Cooldown),
      hp: numOf(d.Toughness),
      family: d.Family || null,
      range,
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special.map((x) => `${x.name || '特点'}：${x.text}`),
      weaknesses: alm.weaknesses,
      attack: (dmg != null && interval) ? { dmg, interval, dps: Math.round((dmg / interval) * 10) / 10 } : null,
      splash: numOf(d.SplashDamage) || null,
      plantFood: numOf(d.PlantfoodDamage) || numOf(d.PlantfoodDamageNear) || null,
      sun: stages.length ? {
        stages, interval: prodDay, intervalNight: prodNight,
        perSecDay: rate(stages, prodDay), perSecNight: rate(stages, prodNight),
        paybackSec: cost && rate(stages, prodNight) ? Math.round(cost / rate(stages, prodNight)[stages.length - 1]) : null,
      } : null,
    };
    st.shot = shotOf(st);
    st.usage = usageFacts(st);
    return st;
  }

  function zombieStatsOf(type) {
    if (zombieCache.has(type)) return zombieCache.get(type);
    const st = buildZombieStats(type);
    if (st) zombieCache.set(type, st);
    return st;
  }

  function buildZombieStats(type) {
    const b = bag();
    if (!b || !b.ZombieProps) return null;
    const rec = firstObj(b, 'ZombieProps', type);
    if (!rec) return null;
    const d = rec.objdata || {};
    const armorOf = new Map();
    for (const o of (b.ArmorProps && b.ArmorProps.objects) || []) {
      const a = (o.aliases || [])[0];
      armorOf.set(a, { hp: numOf(o.objdata && o.objdata.Toughness), metal: !!(o.objdata && o.objdata.isMetal), ice: !!(o.objdata && o.objdata.isIce) });
    }
    const ids = Array.isArray(d.StartingArmors) ? d.StartingArmors : [];
    const armorDetail = ids.map((id) => ({ id, hp: (armorOf.get(id) || {}).hp || null, metal: !!(armorOf.get(id) || {}).metal, ice: !!(armorOf.get(id) || {}).ice }));
    const armorHp = armorDetail.reduce((s, a) => s + (a.hp || 0), 0);
    const hp = numOf(d.Toughness);
    const alm = almanacFacts(b, 'zombie', type);
    const almText = [alm.introduction, ...alm.special.map((x) => x.text)].filter(Boolean).join(' ');
    const names = featureName(b, 'zombie', type);
    return {
      type,
      name: (names && names.zh) || type,
      nameEn: (names && names.en) || null,
      hp,
      armorDetail: armorDetail.length ? armorDetail : null,
      armorHp: armorHp || null,
      ehp: hp != null ? hp + armorHp : null,
      speed: numOf(d.WalkSPS),
      eatDps: numOf(d.EatDPS),
      tags: zombieTagsFrom(d, almText),
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special.map((x) => `${x.name || '特点'}：${x.text}`),
      weaknesses: alm.weaknesses,
      behaviors: {
        gazes: d.GazeDPS != null ? numOf(d.GazeDPS) : null,
        smashDamage: d.SmashDamage != null ? numOf(d.SmashDamage) : null,
        flyingSpeed: d.FlyingSpeed != null ? numOf(d.FlyingSpeed) : null,
        barrelType: d.BarrelType || null,
        impType: d.ImpType || null,
        livesInDeepWater: d.LivesInDeepWater === true,
        speedUpWhenEatPlants: d.SpeedUpWhenEatPlants === true,
      },
    };
  }

  function lawnFacts(stageName) {
    const out = { stage: stageName || null, isAtNight: null, gravestoneHp: null, graveBuster: null, mower: null, railCart: null };
    try {
      const b = bag();
      if (!b || !b.LawnProps || !stageName) return out;
      const rec = firstObj(b, 'LawnProps', stageName);
      if (rec && rec.objdata) {
        if (typeof rec.objdata.IsAtNight === 'boolean') out.isAtNight = rec.objdata.IsAtNight;
        out.mower = rec.objdata.Mower || null;
        out.railCart = rec.objdata.RailCart || null;
        const gs = (rec.objdata.Gravestone || [])[0];
        if (gs && b.TombstoneProps) {
          const t = firstObj(b, 'TombstoneProps', gs);
          if (t && t.objdata) {
            out.gravestoneHp = numOf(t.objdata.Toughness);
            out.graveBuster = t.objdata.GraveBusterPlantable === true;
          }
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  function levelScriptOf(lvl) {
    const objs = lvl && Array.isArray(lvl.currentLevelObjects) ? lvl.currentLevelObjects : [];
    if (!objs.length) return null;
    if (levelCache.has(objs)) return levelCache.get(objs);
    const waves = [];
    const modules = [];
    let waveCount = null;
    let flagInterval = null;
    for (const o of objs) {
      const cls = String((o && o.objclass) || '');
      const alias = (o && o.aliases && o.aliases[0]) || '';
      const data = (o && o.objdata) || {};
      if (cls && !/^Wave/.test(cls)) modules.push({ cls, alias });
      if (cls === 'WaveManagerProperties') { waveCount = numOf(data.WaveCount); flagInterval = numOf(data.FlagWaveInterval); continue; }
      const m = /^Wave(\d+)$/.exec(alias);
      if (!m || !Array.isArray(data.Zombies)) continue;
      const counts = {};
      const rowsHint = [];
      for (const z of data.Zombies) {
        const t = String((z && z.Type) || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();
        if (!t) continue;
        counts[t] = (counts[t] || 0) + 1;
        const row = numOf(z && z.Row);
        if (row != null) rowsHint.push({ type: t, lane: row - 1 });
      }
      waves.push({
        n: Number(m[1]), zombies: counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        rowsHint, rowsAreHint: true,
        extraFood: numOf(data.ExtraPlantFood) || null,
      });
    }
    waves.sort((a, b) => a.n - b.n);
    const lanes = lvl && Array.isArray(lvl.onlyLanesForRandomSpawn) ? lvl.onlyLanesForRandomSpawn.map(Number) : null;
    const def = objs.find((o) => o && o.objclass === 'LevelDefinition');
    const sm = def && def.objdata ? def.objdata.StageModule : null;
    const mm = typeof sm === 'string' ? /RTID\(([^@()]+)@/.exec(sm) : null;
    const lawn = lawnFacts(mm ? mm[1] : null);
    const value = {
      waveCount: waveCount || waves.length,
      flagInterval,
      waves,
      lanePolicy: lanes ? { spawnLanes: lanes, random: lanes.length > 1 } : null,
      lawn,
      modules,
    };
    levelCache.set(objs, value);
    return value;
  }

  return { plantStatsOf, zombieStatsOf, lawnFacts, levelScriptOf, readAssets: bag };
}

export function featureList(getCc, kind) {
  const b = readAssets(getCc);
  const key = kind === 'plant' ? 'PlantFeatures' : 'ZombieFeatures';
  const listKey = kind === 'plant' ? 'PLANTS' : 'ZOMBIES';
  const direct = (b && b[key] && b[key][listKey]) || [];
  if (direct.length) return direct;
  // 资源里没有 Features 时，用 Props 的 alias 兜底（至少能按 codename 搜到）
  const props = (b && b[kind === 'plant' ? 'PlantProps' : 'ZombieProps'] && b[kind === 'plant' ? 'PlantProps' : 'ZombieProps'].objects) || [];
  return props.map((o) => ({ CODENAME: (o.aliases || [])[0], NAME: { zh: (o.aliases || [])[0], en: (o.aliases || [])[0] } })).filter((x) => x.CODENAME);
}

export function nameOf(getCc, kind, codename) {
  return featureName(readAssets(getCc), kind, codename);
}
