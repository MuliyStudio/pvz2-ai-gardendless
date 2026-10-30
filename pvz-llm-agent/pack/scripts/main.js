// 由 scripts/build.mjs 生成，请勿直接编辑。
// 源文件：bridge + tools + in-game
'use strict';
// ── knowledge/worlds.js ──
/**
 * 世界事实：只列"这个世界有什么机制"，不写"该怎么打"。
 * 运行时以 snapshot.mechanicFacts / levelScript / 实际地形为准。
 */

const WORLD_FACTS = [
  {
    key: 'egypt', re: /埃及|egypt/i, name: '神秘埃及',
    mechanics: ['墓碑占格并阻挡直线弹道', '法老、太阳神、探险家等特殊僵尸'],
    zombies: ['mummy', 'mummy_armor1', 'mummy_armor2', 'explorer', 'tomb_raiser', 'pharaoh', 'egypt_gargantuar'],
  },
  {
    key: 'pirate', re: /海盗|pirate/i, name: '海盗港湾',
    mechanics: ['海面/木板地形：普通植物不能种在水面', '海鸥可飞越地面阻挡', '滚桶会碾压植物', '船长鹦鹉会偷走植物'],
    zombies: ['pirate', 'swashbuckler', 'seagull', 'barrelroller', 'pirate_captain', 'pirate_gargantuar'],
  },
  {
    key: 'west', re: /西部|牛仔|cowboy|west/i, name: '狂野西部',
    mechanics: ['矿车轨道：矿车可载植物上下移动', '钢琴会碾压并换行', '淘金者可跳到后排', '养鸡人释放鸡群'],
    zombies: ['cowboy', 'prospector', 'piano', 'poncho', 'chicken_farmer', 'west_bull', 'cowboy_gargantuar'],
  },
  {
    key: 'future', re: /未来|future/i, name: '遥远未来',
    mechanics: ['机甲护甲', '喷气背包可飞越', '迪斯科会换行', '部分僵尸带护盾'],
    zombies: ['future', 'jetpack', 'protector', 'mech_cone', 'football_mech', 'disco_mech', 'future_gargantuar'],
  },
  {
    key: 'dark', re: /黑暗|dark/i, name: '黑暗时代',
    mechanics: ['夜间关卡（无天空阳光）', '墓碑占格', '巫师可变羊', '小丑会反弹', '国王会给僵尸加护甲'],
    zombies: ['dark', 'dark_juggler', 'dark_wizard', 'dark_king', 'dark_gargantuar'],
  },
  {
    key: 'beach', re: /沙滩|海滩|beach/i, name: '巨浪沙滩',
    mechanics: ['潮汐会改变水线位置', '章鱼会封住植物', '渔夫会拉走植物', '冲浪/潜水僵尸'],
    zombies: ['beach', 'beach_snorkel', 'beach_surfer', 'beach_octopus', 'beach_fisherman', 'beach_gargantuar'],
  },
  {
    key: 'iceage', re: /冰河|冰川|iceage/i, name: '冰河世界',
    mechanics: ['冰块占格', '猎人投冰', '渡渡鸟可跳越', '黄鼠狼会放出小怪'],
    zombies: ['iceage', 'iceage_hunter', 'iceage_dodo', 'iceage_troglobite', 'iceage_weaselhoarder', 'iceage_gargantuar'],
  },
  {
    key: 'lostcity', re: /失落|古城|lostcity/i, name: '遗落古城',
    mechanics: ['金瓷砖', '濒危植物格', '飞行员会绕后', '挖掘者会挖走植物'],
    zombies: ['lostcity', 'lostcity_lostpilot', 'lostcity_excavator', 'lostcity_jane', 'lostcity_bug', 'lostcity_crystalskull', 'lostcity_gargantuar'],
  },
  {
    key: 'kongfu', re: /功夫|kongfu|kungfu/i, name: '功夫世界',
    mechanics: ['气功洞会推拉植物和僵尸', '武僧/方丈等特殊僵尸'],
    zombies: ['kongfu', 'monk', 'abbot'],
  },
  {
    key: 'jurassic', re: /侏罗纪|jurassic|dino/i, name: '侏罗纪沼泽',
    mechanics: ['恐龙会干扰阵型：剑龙击退、翼龙抓走、迅猛龙召唤等'],
    zombies: ['dino', 'dino_armor1', 'dino_armor2', 'dino_bully', 'dino_imp', 'dino_gargantuar'],
  },
  {
    key: 'sky', re: /天空|sky/i, name: '天空之城',
    mechanics: ['天空格：需要能种在空中的植物或花盆', '飞行僵尸'],
    zombies: ['sky', 'sky_flag', 'sky_imp', 'sky_twin', 'sky_gargantuar'],
  },
  {
    key: 'modern', re: /现代|modern/i, name: '现代年华',
    mechanics: ['多个时代的僵尸混编', '机制随关卡轮换'],
    zombies: [],
  },
];

function worldFactOf(text) {
  const s = String(text || '');
  for (const w of WORLD_FACTS) if (w.re.test(s)) return w;
  return null;
}


// ── bridge/stats.js ──
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
const SHOT_BY_FAMILY = {
  Lobber: 'lob', Magic: 'lob', Melee: 'melee', Peashooter: 'straight', Sharp: 'straight',
  Poison: 'straight', Electricity: 'beam', Fire: 'area', Shadow: 'straight',
  Defence: 'none', Sun: 'none', Explosive: 'instant', Cold: 'none', Slow: 'none', Nope: 'none',
};

function shotOf(st) {
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

const OBSTACLE_FACTS = {
  tomb: { name: '墓碑', blocksPlanting: true, blocksStraightShot: true, removeBy: 'gravebuster' },
  mold: { name: '霉斑', blocksPlanting: true, blocksStraightShot: null },
  ice: { name: '冰块', blocksPlanting: null, blocksStraightShot: null },
  vase: { name: '罐子', blocksPlanting: true, blocksStraightShot: null },
  slider: { name: '滑轨格', blocksPlanting: null, blocksStraightShot: null },
  gold: { name: '金瓷砖', blocksPlanting: false, blocksStraightShot: false },
};

function zombieTagsFrom(props, almanacText = '') {
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

function usageFacts(stats) {
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

function resetAssetCache() {
  assetBag = null;
  assetSource = null;
}

function assetNames() {
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

function createStatsReader(getCc) {
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

function featureList(getCc, kind) {
  const b = readAssets(getCc);
  const key = kind === 'plant' ? 'PlantFeatures' : 'ZombieFeatures';
  const listKey = kind === 'plant' ? 'PLANTS' : 'ZOMBIES';
  const direct = (b && b[key] && b[key][listKey]) || [];
  if (direct.length) return direct;
  // 资源里没有 Features 时，用 Props 的 alias 兜底（至少能按 codename 搜到）
  const props = (b && b[kind === 'plant' ? 'PlantProps' : 'ZombieProps'] && b[kind === 'plant' ? 'PlantProps' : 'ZombieProps'].objects) || [];
  return props.map((o) => ({ CODENAME: (o.aliases || [])[0], NAME: { zh: (o.aliases || [])[0], en: (o.aliases || [])[0] } })).filter((x) => x.CODENAME);
}

function nameOf(getCc, kind, codename) {
  return featureName(readAssets(getCc), kind, codename);
}


// ── bridge/snapshot.js ──
/**
 * snapshot：把游戏对象树读成结构化状态。
 *
 * 只读；不判断、不建议、不改游戏。所有派生量都写明算法（ehp、dps、格数）。
 */

const SQUARE_TYPE_LETTER = { 0: 'L', 1: 'S', 2: 'W', 3: 'W', 4: 'P' };
const SQUARE_TYPE_NAME = { 0: 'land', 1: 'sky', 2: 'water', 3: 'sea', 4: 'plank' };

const TASK_MODE_NAME = {
  0: 'plant_count_limit', 1: 'plant_lose_limit', 2: 'sun_cost_limit',
  3: 'sun_produce_request', 4: 'sun_cost_countdown', 5: 'kill_count_request', 6: 'timed_kill',
};
const TASK_MODE_SEMANTICS = {
  0: 'count_limit', 1: 'loss_limit', 2: 'sun_budget', 3: 'sun_produce',
  4: 'countdown', 5: 'kill_count', 6: 'sliding_window',
};
const TASK_LIMIT_KEYS = ['plantCountLimit', 'plantLoseLimit', 'sunCostLimit', 'sunProduceRequest', 'sunCostCountDownLimit', 'zombieKillCount'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const firstNumber = (s) => {
  const m = String(s == null ? '' : s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function cleanCodename(t) {
  return String(t || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();
}

function parsePlantLimit(texts) {
  for (const raw of texts || []) {
    const s = String(raw || '');
    const m = /(?:no more than|more than|over|at most|maximum of|max(?:imum)?)\s*(\d+)\s*plants?/i.exec(s)
      || /(\d+)\s*plants?\s*(?:max|limit)/i.exec(s)
      || /(?:最多|不超过|只能种|上限).{0,8}?(\d+)\s*株/.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}

function createSnapshotReader({ getCc, findCompByClass, stats, version }) {
  let compCache = { scene: null, map: null, at: 0 };
  const learnedCells = new Map();
  const taskTrack = new Map();
  const collectStats = { total: 0, lastAt: 0, kinds: {} };
  let autoCollectTimer = null;

  function findComps() {
    const cc = getCc();
    const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
    if (!scene) return null;
    const now = Date.now();
    if (compCache.scene === scene && compCache.map && now - compCache.at < 500) return { cc, scene, map: compCache.map };
    const map = Object.create(null);
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k && !map[k]) map[k] = c;
      }
      for (const ch of n.children || []) walk(ch);
    };
    walk(scene);
    compCache = { scene, map, at: now };
    return { cc, scene, map };
  }

  function cellPlants(cell) {
    if (!cell) return [];
    const out = [];
    for (const g of [cell.plantInSquare, cell.vineInSquare, cell.tilePlantInSquare, cell.iminaterInSquare,
      cell.floawerpot ? [cell.floawerpot] : null, cell.lilypad ? [cell.lilypad] : null]) {
      if (!Array.isArray(g)) continue;
      for (const p of g) {
        if (!p || out.includes(p)) continue;
        let alive = true;
        try { alive = p.isAlive ? p.isAlive() : true; } catch { alive = true; }
        if (alive) out.push(p);
      }
    }
    return out;
  }

  function learnCell(lane, column, code) {
    learnedCells.set(`${lane}:${column}`, { until: Date.now() + 15000, code: code || 'CELL_BLOCKED' });
  }

  // 场景里可能同时存在「未激活的模板」和「本关真实的」LevelObjectiveScreen。
  // 模板的 screenName 是占位符（<LEVEL OBJECTIVE NAME>），mission0 是引擎默认文案
  // （典型："Never have more than 18 plants"）——那不是本关任务，必须整块丢掉，
  // 否则模型会把它当成本关规则（曾被误读成"18 株上限"）。
  // 僵尸护甲当前血量：引擎没有统一字段，这里按几种常见挂法读，读不到就返回 null（不猜）。
  function liveArmorHp(z) {
    if (!z) return null;
    try {
      for (const v of [z.armorHp, z.armorHealth, z.armorHpNum]) {
        if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
      }
      for (const list of [z.armors, z.armorList, z.armorComponents]) {
        if (!Array.isArray(list)) continue;
        let sum = 0, any = false;
        for (const a of list) {
          const hp = a && (typeof a.hp === 'number' ? a.hp : (typeof a.health === 'number' ? a.health : (typeof a.toughness === 'number' ? a.toughness : null)));
          if (hp != null) { sum += hp; any = true; }
        }
        if (any) return Math.max(0, sum);
      }
      for (const one of [z.armor, z.helmet]) {
        if (!one || typeof one !== 'object') continue;
        const hp = typeof one.hp === 'number' ? one.hp : (typeof one.health === 'number' ? one.health : null);
        if (hp != null) return Math.max(0, hp);
      }
      const kids = z.node && z.node.children;
      if (Array.isArray(kids)) {
        let sum = 0, any = false;
        for (const k of kids) {
          for (const c of (k && k._components) || []) {
            const cls = String(c && (c.__classname__ || (c.constructor && c.constructor.name)) || '');
            if (!/armor/i.test(cls)) continue;
            const hp = typeof c.health === 'number' ? c.health : (typeof c.hp === 'number' ? c.hp : null);
            if (hp != null) { sum += hp; any = true; }
          }
        }
        if (any) return Math.max(0, sum);
      }
    } catch { /* ignore */ }
    return null;
  }

  function readObjective(scene) {
    const found = [];
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k === 'LevelObjectiveScreen') found.push({ comp: c, node: n });
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { if (scene) walk(scene); } catch { /* ignore */ }
    if (!found.length) return null;

    const describe = ({ comp, node }) => {
      const screenName = comp.screenName && typeof comp.screenName.string === 'string' ? comp.screenName.string : '';
      // 占位符 / 空名称 = 未初始化的模板对象，它的 mission0 是引擎默认英文文案。
      // 真实关卡会把 screenName 本地化成诸如「海盗港湾 - 第 13 天目标」。
      const trusted = !!screenName.trim() && !/^[<【].*[>】]$/.test(screenName.trim());
      const active = !!node && node.activeInHierarchy !== false && node.active !== false && !comp.faded;
      return { comp, node, screenName, trusted, active, canContinue: typeof comp.continue === 'function' };
    };
    const all = found.map(describe);
    // 优先「正在显示的真实任务」，其次任意已本地化的，最后才是模板。
    const hit = all.find((x) => x.active && x.trusted)
      || all.find((x) => x.trusted)
      || all.find((x) => x.active)
      || all[0];

    if (!hit.trusted) {
      // 不信任时连 missions 也不返回：留一个空数组，模型就没东西可误读。
      return { screenName: hit.screenName, missions: [], active: hit.active, trusted: false, canContinue: hit.canContinue };
    }

    const missions = [];
    const push = (t) => {
      const s = String(t || '').trim();
      if (!s || s.length < 3) return;
      if (s === hit.screenName) return;
      if (/^[<【].*[>】]$/.test(s)) return;
      if (/^(继续|开始|开始游戏|确定|下一步|返回|取消|continue|ok|next|back|cancel)$/i.test(s)) return;
      if (/^(关卡任务|任务|任务目标|目标|本关任务|任务说明|任务要点|level objectives?|objectives?)$/i.test(s)) return;
      if (missions.indexOf(s) < 0) missions.push(s);
    };
    if (hit.comp.mission0 && typeof hit.comp.mission0.string === 'string') push(hit.comp.mission0.string);
    const walkLabels = (n) => {
      for (const c of n._components || []) {
        const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (cls === 'cc.Label' && typeof c.string === 'string') push(c.string);
      }
      for (const ch of n.children || []) walkLabels(ch);
    };
    if (hit.node) walkLabels(hit.node);
    return { screenName: hit.screenName, missions, active: hit.active, trusted: true, canContinue: hit.canContinue };
  }

  // 植物上限优先取结构化字段（LevelTaskCount.plantCountLimit），
  // 文本匹配只作为兜底，而且只用在「已本地化的真实任务」上。
  function taskPlantLimit(tasks) {
    for (const t of tasks || []) {
      const v = t && t.limits ? t.limits.plantCountLimit : null;
      if (typeof v === 'number' && v > 0) return v;
    }
    return null;
  }

  function applyTaskSemantics(t) {
    const mode = t.mode;
    const start = t.starting || {};
    const obj = t.detail || {};
    const countNum = firstNumber(t.count);
    const now = Date.now();

    if (mode === 6) {
      const total = t.total || num(start.ZombiesToKill) || 0;
      const limit = t.timeLimit || num(start.Time) || 0;
      let st = taskTrack.get(t.key);
      if (!st) { st = { lastValue: 0, kills: [], updatedAt: now }; taskTrack.set(t.key, st); }
      if (typeof t.value === 'number') {
        const delta = t.value - st.lastValue;
        if (delta > 0) { for (let i = 0; i < delta && i < 40; i++) st.kills.push(now); }
        else if (delta < 0) st.kills.splice(0, Math.min(st.kills.length, -delta));
        st.lastValue = t.value;
      }
      if (limit > 0) while (st.kills.length && now - st.kills[0] > limit * 1000) st.kills.shift();
      st.updatedAt = now;
      const timeLeft = limit > 0 && st.kills.length ? Math.max(0, limit - (now - st.kills[0]) / 1000) : null;
      const need = total > 0 && typeof t.value === 'number' ? Math.max(0, total - t.value) : null;
      t.timeSemantics = 'sliding_window';
      t.windowActive = !t.completed && !t.failed && (timeLeft !== null ? timeLeft > 0 : !!t.value);
      t.timeLeft = timeLeft === null ? null : Math.round(timeLeft * 10) / 10;
      t.windowKills = limit > 0 ? st.kills.length : (t.value || 0);
      t.timeLimit = limit || null;
      t.need = need;
      t.urgent = !t.completed && !t.failed && need !== null && need > 0
        && ((t.timeLeft !== null && t.timeLeft <= 5) || (total > 0 && (t.value || 0) / total >= 0.75));
      if (t.completed) t.hint = '任务已完成';
      else if (t.failed) t.hint = '任务已失败';
      else if (t.timeLeft !== null && t.windowActive) t.hint = `滑动窗口还剩 ${t.timeLeft.toFixed(1)} 秒，当前 ${t.value}/${total}，需再杀 ${need} 个`;
      else if (need !== null) t.hint = `最近 ${limit} 秒窗口内击杀 ${t.value}/${total}，还需 ${need} 个`;
      return;
    }

    t.semantics = mode === null ? 'unknown' : (TASK_MODE_SEMANTICS[mode] || 'unknown');
    switch (mode) {
      case 0: {
        const total = num(start.MaximumPlants) ?? t.total;
        const left = countNum ?? num(obj.LeftPlants);
        if (total && left !== null) {
          t.total = total;
          t.value = Math.max(0, total - left);
          t.percent = Math.round((t.value / total) * 100);
        }
        t.left = left;
        t.hint = `还能种 ${left ?? '?'} 株（上限 ${total ?? '?'}）`;
        t.urgent = left !== null && left <= 2;
        break;
      }
      case 1: {
        const total = num(start.MaximumPlantsLost) ?? t.total;
        const left = num(obj.LeftPlantsToLose) ?? countNum;
        if (total && left !== null) {
          t.total = total;
          t.value = Math.max(0, total - left);
          t.percent = Math.round((t.value / total) * 100);
        }
        t.left = left;
        t.hint = `还可损失 ${left ?? '?'} 株（上限 ${total ?? '?'}），再丢就失败`;
        t.urgent = left !== null && left <= 1;
        break;
      }
      case 2: {
        const left = num(obj.LeftSun) ?? countNum;
        t.left = left;
        t.hint = `剩余阳光额度 ${left ?? '?'}`;
        t.urgent = left !== null && left <= 100;
        break;
      }
      case 3: {
        const produced = num(obj.SunProduced) ?? t.value;
        const total = num(start.TargetSun) ?? t.total;
        t.value = produced;
        t.total = total;
        if (produced !== null && total) t.percent = Math.round((produced / total) * 100);
        t.hint = `已产生 ${produced ?? '?'}/${total ?? '?'} 阳光`;
        t.urgent = produced !== null && total ? produced / total >= 0.8 : false;
        break;
      }
      case 4: {
        const left = num(obj.LeftTime) ?? t.timeLeft;
        t.timeSemantics = 'countdown';
        t.timeLimit = num(start.HoldoutSeconds) ?? t.timeLimit;
        t.timeLeft = left !== null ? Math.round(left * 10) / 10 : null;
        t.windowActive = left !== null && left > 0;
        t.hint = `倒计时 ${t.timeLeft ?? '?'} 秒`;
        t.urgent = left !== null && left <= 5;
        break;
      }
      case 5:
        t.hint = `击杀 ${t.value ?? '?'}/${t.total ?? '?'}`;
        t.urgent = false;
        break;
      default:
        t.hint = t.count || '';
        t.urgent = false;
    }
  }

  function readTasks(scene) {
    const tasks = [];
    if (!scene) return tasks;
    const walk = (n) => {
      for (const c of n._components || []) {
        const cls = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (cls !== 'LevelTaskCount') continue;
        const tip = typeof c.tip === 'string' ? c.tip : '';
        const count = c.count && typeof c.count.string === 'string' ? c.count.string : '';
        const mode = num(c.mode);
        let value = null;
        let total = null;
        if (count && count.indexOf('/') >= 0) {
          const parts = count.split('/');
          value = Number(parts[0]);
          total = Number(parts[1]);
          if (!Number.isFinite(value)) value = null;
          if (!Number.isFinite(total)) total = null;
        }
        const limits = {};
        for (const k of TASK_LIMIT_KEYS) {
          const v = c[k];
          if (typeof v === 'number' && v !== 0) limits[k] = v;
        }
        const starting = {};
        try {
          if (c.startingObjdata && typeof c.startingObjdata === 'object') {
            for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds', 'LeftSun']) {
              const v = c.startingObjdata[k];
              if (typeof v === 'number') starting[k] = v;
            }
            for (const k of ['Time', 'ZombiesToKill', 'TargetSun', 'MaximumPlants', 'MaximumPlantsLost', 'HoldoutSeconds']) {
              if (starting[k] === undefined && typeof c[k] === 'number') starting[k] = c[k];
            }
          }
        } catch { /* ignore */ }
        let detail;
        try {
          if (c.objdata && typeof c.objdata === 'object') {
            detail = {};
            let n2 = 0;
            for (const k of Object.keys(c.objdata)) {
              const v = c.objdata[k];
              if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') detail[k] = v;
              if (++n2 >= 8) break;
            }
          }
        } catch { detail = undefined; }

        const task = {
          key: tip || ('mode_' + mode),
          tip,
          count,
          value,
          total,
          percent: value !== null && total ? Math.round((value / total) * 100) : null,
          mode,
          modeName: mode === null ? null : (TASK_MODE_NAME[mode] || 'mode_' + mode),
          completed: !!c.completed,
          failed: !!c.failed,
          limits: Object.keys(limits).length ? limits : undefined,
          starting: Object.keys(starting).length ? starting : undefined,
          timeLimit: mode === 6 ? num(starting.Time) : (mode === 4 ? num(starting.HoldoutSeconds) : null),
          detail,
        };
        if (task.value === null && task.percent === null && (mode === null || TASK_MODE_SEMANTICS[mode] === undefined)
          && c.progress && typeof c.progress._progress === 'number') {
          const p = c.progress._progress;
          task.percent = Math.round(p * 100);
          if (task.percent > 100) task.percent = 100;
        }
        if (!task.modeName && task.mode !== null) task.modeName = 'mode_' + task.mode;
        applyTaskSemantics(task);
        tasks.push(task);
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { walk(scene); } catch { /* ignore */ }
    return tasks;
  }

  function collectPickups() {
    const ctxg = findComps();
    if (!ctxg || !ctxg.scene) return { ok: false, code: 'NO_SCENE', reason: '不在游戏场景内', count: 0, kinds: {} };
    const kinds = Object.create(null);
    let count = 0;
    const isUnderNames = (node, names) => {
      let p = node, depth = 0;
      while (p && depth++ < 12) {
        if (p.name && names.indexOf(p.name) >= 0) return true;
        p = p.parent;
      }
      return false;
    };
    const walk = (n) => {
      if (!n || n.active === false) return;
      for (const c of n._components || []) {
        if (!c || c.collected !== false || c.mouseListen !== true) continue;
        if (typeof c.collect !== 'function') continue;
        if (isUnderNames(n, ['Prizes', 'CurrencyShower'])) continue;
        try { if (c.collectable && !c.collectable()) continue; } catch { /* ignore */ }
        try {
          const type = c.DroppingType || c.__classname__ || (c.constructor && c.constructor.name) || 'item';
          c.collect();
          kinds[type] = (kinds[type] || 0) + 1;
          count++;
        } catch { /* ignore one drop */ }
      }
      for (const ch of n.children || []) walk(ch);
    };
    try { walk(ctxg.scene); } catch { /* ignore */ }
    if (count) {
      collectStats.total += count;
      collectStats.lastAt = Date.now();
      for (const k of Object.keys(kinds)) collectStats.kinds[k] = (collectStats.kinds[k] || 0) + kinds[k];
    }
    return { ok: true, count, kinds };
  }

  function setAutoCollect(on) {
    if (autoCollectTimer) { clearInterval(autoCollectTimer); autoCollectTimer = null; }
    if (on !== false) {
      autoCollectTimer = setInterval(() => {
        try { collectPickups(); } catch { /* ignore */ }
      }, 900);
    }
    return { ok: true, on: on !== false };
  }

  function collectCartRefs(C, lanes, cols) {
    const seen = new Set();
    const refs = [];
    for (let r = 0; r < lanes; r++) {
      for (let c = 0; c < cols; c++) {
        let cell = null;
        try { cell = C.getLnC(r, c); } catch { cell = null; }
        if (!cell || !cell.rail) continue;
        let cart = null;
        try { cart = cell.cart; } catch { cart = null; }
        if (!cart || seen.has(cart)) continue;
        seen.add(cart);
        const inL = cart._inLnC || null;
        const lane = inL && Number.isFinite(inL.lIndex) ? inL.lIndex : null;
        const column = inL && Number.isFinite(inL.cIndex) ? inL.cIndex : null;
        const railLanes = [];
        if (column !== null) {
          for (let rr = 0; rr < lanes; rr++) {
            let cc = null;
            try { cc = C.getLnC(rr, column); } catch { cc = null; }
            if (cc && cc.rail && Array.isArray(cc.rail.carts) && cc.rail.carts.indexOf(cart) >= 0) railLanes.push(rr);
          }
        }
        let canUp = false, canDown = false;
        try { canUp = !!(inL && inL.upper && cart.canMoveToLnC(inL.upper)); } catch { canUp = false; }
        try { canDown = !!(inL && inL.lower && cart.canMoveToLnC(inL.lower)); } catch { canDown = false; }
        refs.push({ cart, lane, column, railLanes, canUp, canDown });
      }
    }
    return refs;
  }

  function readCarts(C, lanes, cols) {
    return collectCartRefs(C, lanes, cols).map((ref, i) => ({
      id: i,
      lane: ref.lane,
      column: ref.column,
      railLanes: ref.railLanes,
      plants: ref.lane !== null && ref.column !== null
        ? cellPlants(C.getLnC(ref.lane, ref.column)).map((p) => {
          const type = cleanCodename(p.Plant_Type || '');
          const st = stats.plantStatsOf(type);
          return { type, name: (st && st.name) || type, hp: Math.round(p.health || 0) };
        })
        : [],
      canUp: ref.canUp,
      canDown: ref.canDown,
    }));
  }

  function levelFacts(lvl, sceneName) {
    const name = (lvl && lvl.levelName) || '';
    const source = {
      world: (lvl && (lvl.worldName || lvl.worldKey || lvl.world || lvl.stageName)) || null,
      levelId: (lvl && (lvl.levelId || lvl.levelID)) || null,
      custom: !!(lvl && (lvl.isCustomLevel || lvl.customLevel)),
      description: (lvl && (lvl.levelDescription || lvl.description)) || null,
      scene: sceneName || null,
    };
    const fact = worldFactOf([name, source.world, sceneName].filter(Boolean).join(' '));
    return {
      name,
      source,
      world: fact ? { key: fact.key, name: fact.name, mechanics: fact.mechanics.slice(), zombies: fact.zombies.slice() } : null,
    };
  }

  function cardState(cards, sunNow) {
    const out = { cards: [], deck: [], seedSelection: null };
    try {
      if (cards && Array.isArray(cards.CFs)) {
        out.cards = cards.CFs.map((cf, i) => {
          const upper = cards.cardsUIUpper && cards.cardsUIUpper[i];
          const cdRaw = upper ? Math.max(0, +upper.CD || 0) : 0;
          const cd = Math.round(cdRaw * 10) / 10;
          const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
          const st = stats.plantStatsOf(cleanCodename(cf.Type));
          const cdReady = cd <= 0;
          const affordable = sunNow == null ? true : sunNow >= cost;
          return {
            index: i, type: cleanCodename(cf.Type), name: (st && st.name) || cleanCodename(cf.Type), cost,
            cd, cdReady, affordable,
            // 还差多少阳光；买得起时是 0
            sunShort: affordable ? 0 : Math.max(0, cost - (sunNow || 0)),
            // ready = 冷却好了 且 买得起（旧字段，语义保持）
            ready: cdReady && affordable,
            cooling: !cdReady,
            // 完整数值只在 pvz_briefing.cards 里给一次；每回合都带会让 prompt 翻几倍
          };
        });
        out.deck = out.cards.map((c) => c.type);
      }
    } catch { /* ignore */ }
    try {
      if (cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)) {
        out.seedSelection = {
          slots: cards.maxSlotCount || 0,
          current: (cards.CFs || []).map((c) => cleanCodename(c.Type)),
          gameStartable: typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : null,
          availableCount: cards.seedChooser.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).length,
          // 只留选卡需要的轻量字段：完整数值在 pvz_briefing.cards 里，别每个回合都塞一遍。
          available: cards.seedChooser.CFs
            .filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed)))
            .map((cf) => {
              const type = cleanCodename(cf.Type);
              const st = stats.plantStatsOf(type);
              return {
                type,
                name: (st && st.name) || type,
                cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0,
                chosen: !!(cf.ca && cf.ca.chosen),
              };
            }),
        };
      }
    } catch { /* ignore */ }
    return out;
  }

  function snapshot(opts) {
    const full = !!(opts && opts.full);
    // lean = 每回合都发的状态：cards 不带数值、levelScript 只留波数摘要。
    // full = pvz_briefing 用：要完整波次表。完整数值体积差 3-4 倍，直接决定模型延迟。
    const leanLevelScript = (ls) => (ls ? { waveCount: ls.waveCount, flagInterval: ls.flagInterval, isAtNight: !!(ls.lawn && ls.lawn.isAtNight) } : null);
    const ctxg = findComps();
    if (!ctxg) return { ok: false, code: 'NO_SCENE', reason: '不在游戏场景内' };
    const { map, scene } = ctxg;
    const C = map.Square && map.Square.constructor;
    const sceneName = scene.name || '';
    const lvl = map.levelController;
    const ui = map.UIInGame;
    const cards = map.Cards;

    let phase = 'other';
    if (sceneName === 'mainScene') phase = 'menu';
    else if (/worldmap/i.test(sceneName)) phase = 'worldmap';
    else if (sceneName === 'inGameScene' || C) {
      const presetNow = !!(lvl && lvl.lastStandPrepareStarted && !lvl.gameStarted);
      const fighting = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted) || presetNow;
      if (lvl && lvl.gameWon) phase = 'won';
      else if (lvl && lvl.gameLost) phase = 'lost';
      else if (!fighting) phase = 'preparing';
      else phase = 'running';
    }

    const objective = readObjective(scene);
    if (phase === 'preparing' && objective && objective.active) phase = 'objective';
    const tasks = readTasks(scene);
    // readObjective 已经丢掉模板 missions；这里只与 tasks.tip 去重后作为任务原文。
    const objectiveMissions = objective && objective.trusted ? objective.missions : [];
    const missionHints = [...new Set(
      objectiveMissions.concat(tasks.map((t) => t.tip).filter(Boolean)),
    )];

    if (!C) {
      // 任务说明/选卡阶段可能还没有棋盘；仍然要返回任务、关卡脚本、卡池，供 briefing 使用。
      const level = levelFacts(lvl, sceneName);
      let sunNow = null, foodNow = null;
      try { sunNow = map.SunCount ? map.SunCount.CurrentValue : null; } catch { /* ignore */ }
      try { foodNow = map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null; } catch { /* ignore */ }
      const cs = cardState(cards, sunNow);
      let lsFull = null;
      try { lsFull = lvl ? stats.levelScriptOf(lvl) : null; } catch { lsFull = null; }
      const ls = full ? lsFull : leanLevelScript(lsFull);
      const limitFromTask = taskPlantLimit(tasks);
      const limit = limitFromTask != null ? limitFromTask : parsePlantLimit(missionHints);
      return {
        ok: phase !== 'other', version, scene: sceneName, phase,
        reason: '场景还没有棋盘',
        paused: !!(ui && ui.paused),
        objective, tasks, missionHints,
        sun: sunNow, plantFood: foodNow,
        level: {
          ...level,
          wave: lvl && Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0,
          waves: lvl && lvl.waveManagerProps ? lvl.waveManagerProps.WaveCount : null,
          nextWaveIn: lvl && Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null,
          gameStarted: !!(lvl && lvl.gameStarted),
        },
        cards: cs.cards, deck: cs.deck, seedSelection: cs.seedSelection,
        plants: [], zombies: [], lanes: [], board: [],
        terrain: null, blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [], mechanics: [],
        levelScript: ls, zombieStats: {},
        limits: { plantLimit: limit, plantsPlanted: 0, plantsLeft: limit, slots: cs.seedSelection ? cs.seedSelection.slots : 0, plantLimitSource: limit == null ? null : (limitFromTask != null ? 'task' : 'objective') },
        plantLimit: limit,
        startingSun: phase === 'preparing' || phase === 'objective' ? sunNow : null,
        carts: [],
        collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
        world: level.world,
      };
    }
    const lanes = C.LaneCount || 5;
    const cols = C.ColumnCount || 9;

    const level = levelFacts(lvl, sceneName);
    const out = {
      ok: true, version, scene: sceneName,
      phase, paused: !!(ui && ui.paused),
      sun: null, plantFood: null,
      level: { ...level, wave: 0, waves: null, nextWaveIn: null, gameStarted: false },
      cards: [], deck: [], plants: [], zombies: [], board: [], lanes: [],
      blockedCells: [], plantable: [], obstacles: [], mechanicFacts: [],
      levelScript: null, seedSelection: null, zombieStats: {}, tasks, objective, missionHints,
      terrain: { lanes, columns: cols, map: [], legend: { L: 'land', W: 'water', P: 'plank', S: 'sky', R: 'rail', '?': 'unknown' } },
      limits: { plantLimit: null, plantsPlanted: 0, plantsLeft: null, slots: 0 },
      plantLimit: null, startingSun: null, carts: [], mechanics: [],
      collect: { total: collectStats.total, kinds: { ...collectStats.kinds } },
      world: level.world,
    };
    try { out.sun = map.SunCount ? map.SunCount.CurrentValue : null; } catch { /* ignore */ }
    try { out.plantFood = map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null; } catch { /* ignore */ }

    let lsFull = null;
    if (lvl) {
      out.level.wave = Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0;
      out.level.waves = lvl.waveManagerProps ? lvl.waveManagerProps.WaveCount : null;
      out.level.nextWaveIn = Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null;
      out.level.gameStarted = !!lvl.gameStarted;
      try { lsFull = stats.levelScriptOf(lvl); } catch { lsFull = null; }
      out.levelScript = full ? lsFull : leanLevelScript(lsFull);
      if (!out.level.waves && lsFull) out.level.waves = lsFull.waveCount || null;
    }
    if (phase === 'preparing' || phase === 'objective') out.startingSun = out.sun;

    // 卡片 / 选卡
    const cs = cardState(cards, out.sun);
    out.cards = cs.cards;
    out.deck = cs.deck;
    // 只在选卡/任务阶段返回完整可选卡池；战斗中已经有卡组，避免每次状态都塞 30KB 的卡池。
    out.seedSelection = (phase === 'preparing' || phase === 'objective') ? cs.seedSelection : null;
    out.limits.slots = (cards && cards.maxSlotCount) || (out.seedSelection && out.seedSelection.slots) || (out.deck || []).length || 0;

    // 棋盘 / 植物 / 障碍
    const blocked = [];
    const obstacles = [];
    out.plants = [];
    out.board = [];
    out.terrain.map = [];
    const squareTypes = [];
    for (let r = 0; r < lanes; r++) {
      const cells = new Array(cols).fill(null);
      const terrainRow = new Array(cols).fill('?');
      const typeRow = new Array(cols).fill(null);
      for (let c = 0; c < cols; c++) {
        const cell = C.getLnC(r, c);
        if (!cell) continue;
        let st = null;
        try { st = num(cell.squareType); } catch { st = null; }
        if (st === null) { try { st = num(cell._squareType); } catch { st = null; } }
        typeRow[c] = st;
        if (st !== null) terrainRow[c] = SQUARE_TYPE_LETTER[st] || '?';
        try { if (cell.rail) terrainRow[c] = 'R'; } catch { /* ignore */ }
        try {
          if (cell.rail) obstacles.push({ lane: r, column: c, type: 'rail', name: '矿车轨道', blocksPlanting: null, blocksStraightShot: false, removeBy: null });
        } catch { /* ignore */ }
        if (terrainRow[c] === 'W') blocked.push({ lane: r, column: c, reason: 'water' });
        else if (terrainRow[c] === 'S') blocked.push({ lane: r, column: c, reason: 'sky' });
        try {
          if (terrainRow[c] === 'R' && !cell.cart) blocked.push({ lane: r, column: c, reason: 'rail' });
        } catch { /* ignore */ }
        const list = cellPlants(cell);
        if (list.length) {
          const p = list[0];
          const type = cleanCodename(p.Plant_Type);
          const pst = stats.plantStatsOf(type);
          cells[c] = type;
          out.plants.push({
            lane: r, column: c, type, name: (pst && pst.name) || type,
            hp: Math.round(p.health || 0), maxHp: Math.round(p.toughness || 0),
            atk: pst ? pst.attack : null, shot: pst ? pst.shot : null,
            protected: false,
          });
        }
        if (cell.haveTomb) { blocked.push({ lane: r, column: c, reason: 'tomb' }); obstacles.push({ lane: r, column: c, type: 'tomb', name: '墓碑', ...OBSTACLE_FACTS.tomb }); }
        if (cell.mold) { blocked.push({ lane: r, column: c, reason: 'mold' }); obstacles.push({ lane: r, column: c, type: 'mold', name: '霉斑', ...OBSTACLE_FACTS.mold }); }
        if (cell.iceTile) { blocked.push({ lane: r, column: c, reason: 'ice' }); obstacles.push({ lane: r, column: c, type: 'ice', name: '冰块', ...OBSTACLE_FACTS.ice }); }
        try {
          if (cell.vases && cell.vases.length) {
            blocked.push({ lane: r, column: c, reason: 'vase' });
            obstacles.push({ lane: r, column: c, type: 'vase', name: '罐子', ...OBSTACLE_FACTS.vase });
          }
        } catch { /* ignore */ }
        try {
          for (const t of cell.tilesInSquare || []) {
            const cls = String((t && (t.__classname__ || (t.constructor && t.constructor.name))) || '');
            if (/goldTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'gold', name: '金瓷砖', ...OBSTACLE_FACTS.gold });
            else if (/sliderTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'slider', name: '滑轨格', ...OBSTACLE_FACTS.slider });
            else if (/endangeredTile/i.test(cls)) obstacles.push({ lane: r, column: c, type: 'endangered', name: '濒危植物格', blocksPlanting: null, blocksStraightShot: null });
          }
        } catch { /* ignore */ }
      }
      out.board.push({ lane: r, cells, terrain: terrainRow.slice(), zombies: [] });
      out.terrain.map.push(terrainRow.join(''));
      squareTypes.push(typeRow);
    }
    out.terrain.squareTypes = squareTypes;
    // 直线遮挡
    const straightBlockers = obstacles.filter((o) => o.blocksStraightShot === true);
    for (const p of out.plants) {
      if (!p.shot || !p.shot.blockedByStraightBlocker) continue;
      const hit = straightBlockers.filter((b) => b.lane === p.lane && b.column > p.column).sort((a, b) => a.column - b.column)[0];
      if (hit) p.blockedAt = { lane: hit.lane, column: hit.column, type: hit.type };
    }

    // 僵尸
    for (let r = 0; r < lanes; r++) {
      const lane = C.getLane && C.getLane(r);
      if (!lane) continue;
      let pool = [];
      try { pool = (lane.zombiePool ? lane.zombiePool() : []).concat(lane.hypnoZombiePool ? lane.hypnoZombiePool() : []); } catch { pool = []; }
      for (const z of pool) {
        if (!z) continue;
        let alive = true;
        try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
        if (!alive) continue;
        const col = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
        const type = cleanCodename(z.Zombie_Type);
        const zst = out.zombieStats[type] || stats.zombieStatsOf(type);
        out.zombieStats[type] = zst;
        const hp = Math.round(z.health || 0);
        const armorNow = liveArmorHp(z);
        const armorMax = zst && zst.armorHp != null ? zst.armorHp : 0;
        out.zombies.push({
          lane: r, column: Math.round(col * 10) / 10, type, name: (zst && zst.name) || type,
          hp, maxHp: Math.round((z.totalHealth ? z.totalHealth() : z.health) || 0),
          // 护甲：armorHp 读不到时为 null；ehp 是「本体 + 当前护甲」，读不到护甲时只给 ehpMax 上界
          armorHp: armorNow,
          armorMax: armorMax || null,
          ehp: armorNow != null ? hp + armorNow : null,
          ehpMax: hp + armorMax,
          tags: (zst && zst.tags) || [],
        });
      }
    }
    out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);
    for (const row of out.board) row.zombies = out.zombies.filter((z) => z.lane === row.lane);

    // 行信息（只给事实：数量、最近列、推车、射手/墙株数、dps 合计）
    out.lanes = [];
    for (let r = 0; r < lanes; r++) {
      const zs = out.zombies.filter((z) => z.lane === r);
      const ps = out.plants.filter((p) => p.lane === r);
      let mower = false;
      try {
        const lane = C.getLane && C.getLane(r);
        mower = !!(lane && lane.mower);
      } catch { mower = false; }
      out.lanes.push({
        lane: r, zombies: zs.length,
        nearestZombie: zs.length ? Math.min(...zs.map((z) => z.column)) : null,
        shooters: ps.filter((p) => p.atk && p.atk.dps).length,
        walls: ps.filter((p) => /peanut|tallnut|wallnut|holonut|endurian/i.test(p.type)).length,
        plants: ps.length,
        dps: Math.round(ps.reduce((s, p) => s + ((p.atk && p.atk.dps) || 0), 0) * 10) / 10,
        wallHp: ps.reduce((s, p) => s + (/peanut|tallnut|wallnut|holonut|endurian/i.test(p.type) ? (p.hp || 0) : 0), 0),
        // 本行在场上僵尸的剩余 EHP 合计（读不到护甲时用 ehpMax 上界），以及是否全是精确值
        ehp: Math.round(zs.reduce((s, z) => s + (z.ehp != null ? z.ehp : z.ehpMax || 0), 0)),
        ehpExact: zs.every((z) => z.ehp != null),
        mower,
      });
    }

    // 最近 15 秒被判 CELL_BLOCKED 的格子
    try {
      const now = Date.now();
      const seen = new Set(blocked.map((b) => `${b.lane}:${b.column}`));
      for (const [k, v] of learnedCells) {
        if (!v || v.until <= now) { learnedCells.delete(k); continue; }
        const [lane, column] = k.split(':').map(Number);
        if (seen.has(k)) continue;
        seen.add(k);
        blocked.push({ lane, column, reason: v.code || 'blocked', learned: true });
      }
    } catch { /* ignore */ }

    out.blockedCells = blocked;
    out.obstacles = obstacles;
    out.plantable = out.board.map((row) => ({
      lane: row.lane,
      columns: row.cells.map((v, c) => (v ? null : c)).filter((c) => c != null
        && !blocked.some((b) => b.lane === row.lane && b.column === c)
        && row.terrain[c] !== 'W' && row.terrain[c] !== 'S'),
    }));

    // 本关机制事实
    try {
      const tagSet = new Set();
      for (const t of Object.keys(out.zombieStats || {})) for (const g of ((out.zombieStats[t] || {}).tags || [])) tagSet.add(g);
      const TAG_TEXT = {
        rolling: '滚动僵尸（滚桶/滚木）：会被地刺类破坏，普通射手无法阻挡',
        flying: '飞行僵尸：地刺与地面阻挡无效',
        steal: '偷植物能力：关键株被偷会空一格',
        crush: '砸毁植物的巨尸：锤击会直接移除植物',
        gargantuar: '巨人僵尸：高血量单位',
        armored: '装甲僵尸：护甲计入 EHP',
        carries_imp: '会投出小鬼：后排可能被绕后',
        lane_switch: '会换行：火力不能只压一行',
        rush: '吃到植物后会加速',
        amphibious: '可进入深水',
        hypnotizable: '可被魅惑',
      };
      for (const g of tagSet) if (TAG_TEXT[g]) out.mechanicFacts.push({ id: g, text: TAG_TEXT[g], source: 'zombie-tags' });
    } catch { /* ignore */ }

    const ls = lsFull;
    if (out.terrain.map.some((row) => /[WS]/.test(row))) out.mechanicFacts.push({ id: 'water', text: '存在水面/天空格：普通植物不能直接种在这些格子上', source: 'terrain' });
    if (out.terrain.map.some((row) => /R/.test(row))) out.mechanicFacts.push({ id: 'rail', text: '存在矿车轨道：矿车可载植物上下移动', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'tomb')) out.mechanicFacts.push({ id: 'tomb', text: '墓碑占格并阻挡直线弹道', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'ice')) out.mechanicFacts.push({ id: 'ice', text: '冰块占格，需要对应卡牌处理', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'gold')) out.mechanicFacts.push({ id: 'gold', text: '存在金瓷砖格', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'slider')) out.mechanicFacts.push({ id: 'slider', text: '存在滑轨格', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'vase')) out.mechanicFacts.push({ id: 'vase', text: '存在罐子格（占格）', source: 'terrain' });
    if (obstacles.some((o) => o.type === 'endangered')) out.mechanicFacts.push({ id: 'endangered', text: '存在濒危植物格', source: 'terrain' });
    if (ls) {
      if (ls.lawn && ls.lawn.isAtNight) out.mechanicFacts.push({ id: 'night', text: '夜间关卡：没有天空掉落的阳光', source: 'lawn' });
      for (const m of ls.modules || []) {
        if (/Portal/i.test(m.cls)) out.mechanicFacts.push({ id: 'portal', text: '关卡包含传送门模块', source: 'module' });
        if (/Dino/i.test(m.cls)) out.mechanicFacts.push({ id: 'dino', text: '关卡包含恐龙模块', source: 'module' });
        if (/Tide/i.test(m.cls)) out.mechanicFacts.push({ id: 'tide', text: '关卡包含潮汐模块', source: 'module' });
        if (/SunDropper/i.test(m.cls)) out.mechanicFacts.push({ id: 'sun_dropper', text: '天空会掉落阳光', source: 'module' });
      }
    }
    out.mechanics = deDupe(out.mechanicFacts);
    out.carts = readCarts(C, lanes, cols);

    // 关卡限制与图表事实：结构化字段优先，文本只作兜底（且只来自已本地化的真实任务）
    const limitFromTask = taskPlantLimit(tasks);
    const limit = limitFromTask != null ? limitFromTask : (parsePlantLimit(missionHints) || (out.levelScript && out.levelScript.plantLimit) || null);
    out.plantLimit = limit;
    out.limits.plantLimit = limit;
    out.limits.plantLimitSource = limit == null ? null : (limitFromTask != null ? 'task' : 'objective');
    out.limits.plantsPlanted = out.plants.length;
    out.limits.plantsLeft = limit != null ? Math.max(0, limit - out.plants.length) : null;

    return out;
  }

  function deDupe(list) {
    const seen = new Set();
    const out = [];
    for (const x of list || []) {
      if (!x || !x.id || seen.has(x.id)) continue;
      seen.add(x.id);
      out.push(x);
    }
    return out;
  }

  return {
    findComps, snapshot, readObjective, readTasks, cellPlants,
    collectPickups, setAutoCollect, collectStats,
    learnCell, learnedCells, readCarts, cartRefs: collectCartRefs,
  };
}


// ── bridge/actions.js ──
/**
 * actions：只执行 LLM 指定的动作，并把游戏的真实结果原样返回。
 *
 * 不补卡、不换卡、不改 LLM 的卡组；选卡只做校验 + 逐张执行 + 等待 UI 同步。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanType = (t) => String(t || '').replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim();

async function waitFor(fn, timeoutMs = 800, intervalMs = 50) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try { if (fn()) return true; } catch { /* keep polling */ }
    await sleep(intervalMs);
  }
  try { return !!fn(); } catch { return false; }
}

function createActions({ getCc, findComps, findCompByClass, stats, reader, version }) {
  function fail(code, extra, reason) {
    return { ok: false, code, reason: reason || code, ...(extra || {}) };
  }

  function deckStatus() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!cards || !lvl) return fail('NO_SCENE');
    const phaseState = reader.snapshot();
    const slots = cards.maxSlotCount || 0;
    const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const seed = cards.seedChooser;
    const conveyor = !!(cards.conveyor || (lvl && lvl.conveyorMode));
    return {
      ok: true,
      phase: phaseState.phase,
      gameStarted: !!cards.gameStarted,
      prepReady: !!(seed && slots > 0),
      conveyor,
      slots,
      current,
      gameStartable: typeof cards.GameStartable === 'function' ? !!cards.GameStartable() : null,
      available: seed && Array.isArray(seed.CFs)
        ? seed.CFs.filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed))).map((cf) => {
          const type = cleanType(cf.Type);
          const st = stats.plantStatsOf(type);
          return { type, name: (st && st.name) || type, cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0 };
        })
        : [],
    };
  }

  async function dismissObjective() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const obj = findCompByClass(ctxg.scene, 'LevelObjectiveScreen');
    if (!obj) return { ok: true, detail: '没有任务弹窗' };
    if (typeof obj.continue === 'function') {
      try { obj.continue(); return { ok: true, detail: '已关闭任务说明' }; } catch (e) { return fail('DISMISS_FAILED', {}, String(e && e.message || e)); }
    }
    const node = obj.node || null;
    const findNodeByName = (n, name) => {
      if (!n) return null;
      if (n.name === name) return n;
      for (const ch of n.children || []) {
        const hit = findNodeByName(ch, name);
        if (hit) return hit;
      }
      return null;
    };
    const btn = node ? findNodeByName(node, 'ContinueButton') : null;
    if (btn) {
      try { btn.emit('click'); return { ok: true, detail: '已点击继续' }; } catch (e) { return fail('DISMISS_FAILED', {}, String(e && e.message || e)); }
    }
    return fail('CONTINUE_NOT_FOUND', {}, '找不到“继续”按钮');
  }

  async function resume() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const ui = ctxg.map.UIInGame;
    if (!ui || !ui.paused) return { ok: true, detail: '游戏未暂停', paused: false };
    const ps = findCompByClass(ctxg.scene, 'PauseScreen');
    if (ps && typeof ps.resume === 'function') {
      try { ps.resume(); return { ok: true, detail: '继续游戏', paused: false }; } catch { /* fall through */ }
    }
    try { ui.paused = false; } catch { /* ignore */ }
    return { ok: true, detail: '已取消暂停', paused: false };
  }

  async function collect() {
    return reader.collectPickups();
  }

  async function chooseDeck(requested, replace) {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!cards || !lvl) return fail('NO_SCENE');
    if (cards.gameStarted) return fail('ALREADY_STARTED', {}, '战斗已经开始，不能改卡组');
    let phaseNow = null;
    try { phaseNow = reader.snapshot().phase; } catch { phaseNow = null; }
    if (phaseNow === 'objective') return fail('PREP_NOT_READY', { phase: phaseNow, retryable: true }, '先关闭任务说明弹窗，再选卡');
    if (phaseNow === 'running' || phaseNow === 'won' || phaseNow === 'lost') return fail('ALREADY_STARTED', { phase: phaseNow });
    if (cards.conveyor || (lvl && lvl.conveyorMode)) {
      return { ok: true, conveyor: true, slots: 0, requested: [], applied: [], skipped: [], missing: [], actualDeck: [], full: true, detail: '传送带关卡无需选卡' };
    }
    if (!cards.seedChooser) return fail('PREP_NOT_READY', { retryable: true }, '选卡界面还没准备好');
    const slots = cards.maxSlotCount || 0;
    if (!slots) return fail('NO_SLOTS', { retryable: true }, '当前关卡没有可用卡槽');

    const wantedRaw = Array.isArray(requested) ? requested.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const dupes = [...new Set(wantedRaw.filter((t, i) => wantedRaw.indexOf(t) !== i))];
    if (dupes.length) return fail('BAD_DECK', { duplicates: dupes, slots }, `卡组里有重复卡：${dupes.join(', ')}`);

    const avail = new Map((cards.seedChooser.CFs || [])
      .filter((cf) => cf && cf.Type && !(cf.ca && (cf.ca.locked || cf.ca.disallowed)))
      .map((cf) => [cleanType(cf.Type), cf]));
    const availableTypes = [...avail.keys()];
    const unknown = wantedRaw.filter((t) => !avail.has(t));
    if (unknown.length) {
      return fail('CARD_NOT_AVAILABLE', { cards: unknown, available: availableTypes, slots }, `这些卡不在本关卡池：${unknown.join(', ')}`);
    }

    const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const base = replace ? [] : current;
    const unique = [...new Set([...base, ...wantedRaw])];
    if (unique.length > slots) {
      return fail('BAD_DECK', { slots, requested: unique, current: base.length ? current : [], count: unique.length }, `卡组 ${unique.length} 张，超过 ${slots} 个卡槽`);
    }
    if (unique.length < slots) {
      const missing = slots - unique.length;
      return fail('DECK_NOT_FULL', {
        slots, have: unique.length, missing, current, requested: wantedRaw,
        hint: `还差 ${missing} 张；本工具不会自动补卡，请补满后再调用`,
      }, `卡组未满（${unique.length}/${slots}），还差 ${missing} 张`);
    }

    // ── 清空（replace=true）──
    let cleared = false;
    let clearIncomplete = [];
    if (replace) {
      if (typeof cards.spliceAllCards === 'function') {
        try { cards.spliceAllCards(); } catch { /* fall through */ }
      }
      cleared = await waitFor(() => cards.CFs.length === 0, 700);
      // spliceAllCards 有时留 1 张，再逐张删；删不掉就如实报告，不偷偷补卡。
      for (let guard = 0; !cleared && guard < slots + 4 && cards.CFs.length; guard++) {
        const cf = cards.CFs[cards.CFs.length - 1];
        const before = cards.CFs.length;
        try { if (typeof cards.removeCard === 'function') cards.removeCard(cf); } catch { /* ignore */ }
        if (!(await waitFor(() => cards.CFs.length < before, 300))) break;
      }
      cleared = await waitFor(() => cards.CFs.length === 0, 500);
      if (!cleared) {
        clearIncomplete = cards.CFs.map((c) => cleanType(c.Type));
        return fail('DECK_CLEAR_FAILED', {
          clearIncomplete, slots, current: clearIncomplete,
          hint: '旧卡没能清空；可以改用 replace:false 在现有卡组上追加，或先手动清空',
        }, `旧卡组没有清空（剩 ${clearIncomplete.length} 张）`);
      }
    }

    // ── 逐张加卡，每张都等 UI 同步 ──
    const applied = [];
    const skipped = [];
    const already = [];
    const tries = [];
    for (const type of wantedRaw) {
      const now = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
      if (now.includes(type)) { already.push(type); continue; }
      if (now.length >= slots) { skipped.push({ type, reason: 'no_slot' }); continue; }
      const before = cards.CFs.length;
      let thrown = null;
      try { cards.addCardByPlantTypeFromSeedbank(type); } catch (e) { thrown = String(e && e.message || e); }
      // 关键：加卡是异步的，必须等 cards.CFs.length 真的 +1，不能只看第一次调用返回。
      const grew = await waitFor(() => cards.CFs.length > before, 900);
      tries.push({ type, before, after: cards.CFs.length, grew });
      if (grew) applied.push(type);
      else skipped.push({ type, reason: thrown ? 'error' : 'rejected', message: thrown || undefined });
      await sleep(60);
    }

    // 最终校验：等 UI 稳定，再读一次真实卡组
    await waitFor(() => cards.CFs.length >= slots, 900);
    const actualDeck = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
    const missing = wantedRaw.filter((t) => !actualDeck.includes(t));
    const full = actualDeck.length >= slots;
    const result = {
      slots,
      requested: wantedRaw,
      applied,
      already,
      skipped,
      missing,
      actualDeck,
      full,
      clears: tries,
      cleared,
      clearIncomplete: clearIncomplete.length ? clearIncomplete : undefined,
    };

    if (!full) {
      return fail('DECK_NOT_FULL', {
        ...result,
        have: actualDeck.length,
        missingCount: slots - actualDeck.length,
        hint: '没有自动补卡；请检查 skipped 原因后重试',
      }, `选卡后仍是 ${actualDeck.length}/${slots}`);
    }
    if (missing.length) {
      return fail('CARD_SELECT_FAILED', {
        ...result,
        hint: '卡组已满但有指定卡没选中；请核对 actualDeck 后重试',
      }, `这些卡没有选中：${missing.join(', ')}`);
    }
    return {
      ok: true,
      ...result,
      detail: `选卡完成（${actualDeck.length}/${slots}）`,
    };
  }

  async function startLevel() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const cards = ctxg.map.Cards;
    const lvl = ctxg.map.levelController;
    if (!lvl || typeof lvl.letsRock !== 'function') return fail('NO_SCENE', {}, '当前场景无法开局');
    if (lvl.gameStarted) return { ok: true, detail: '已经在战斗中', started: true };
    if (cards && cards.seedChooser) {
      if (typeof cards.GameStartable === 'function' && !cards.GameStartable()) {
        const current = (cards.CFs || []).filter(Boolean).map((c) => cleanType(c.Type));
        return fail('DECK_NOT_FULL', { current, slots: cards.maxSlotCount || 0 }, `卡组还没选满（${current.length}/${cards.maxSlotCount || 0}）`);
      }
    }
    if (lvl.lastStandPrepareStarted && !lvl.gameStarted && typeof lvl.startReadySet === 'function') {
      try { lvl.startReadySet(); return { ok: true, detail: '开始了提前布阵', started: true }; } catch (e) { return fail('START_FAILED', {}, String(e && e.message || e)); }
    }
    try {
      lvl.letsRock();
      return { ok: true, detail: '已开局', started: true };
    } catch (e) {
      // 传送带关的 letsRock 可能在隐藏种子栏 UI 时抛错，但战斗已经启动；交给上层用 phase 复核。
      return fail('START_FAILED', { started: !!(lvl.letsRocked || lvl.gameStarted || (cards && cards.gameStarted)) }, String(e && e.message || e));
    }
  }

  async function moveCart(cartId, direction) {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const { map } = ctxg;
    const ui = map.UIInGame;
    if (ui && ui.paused) return fail('PAUSED', { retryable: true });
    const C = map.Square && map.Square.constructor;
    if (!C) return fail('NO_SCENE');
    const lanes = C.LaneCount || 5, cols = C.ColumnCount || 9;
    const id = Number(cartId);
    const ref = reader.cartRefs(C, lanes, cols)[id];
    if (!ref) return fail('NO_CART', { cart: id });
    const inL = ref.cart._inLnC;
    const dir = String(direction || '').toLowerCase();
    if (dir !== 'up' && dir !== 'down') return fail('CART_BLOCKED', { cart: id, direction: dir }, 'direction 只能是 up 或 down');
    const target = dir === 'up' ? (inL && inL.upper) : (inL && inL.lower);
    if (!target) return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'no_rail' }, '该方向没有轨道');
    let can = false;
    try { can = !!ref.cart.canMoveToLnC(target); } catch { can = false; }
    if (!can) return fail('CART_BLOCKED', { cart: id, direction: dir, reason: 'blocked', from: { lane: ref.lane, column: ref.column }, to: { lane: target.lIndex, column: target.cIndex } });
    const plants = reader.cellPlants(inL).map((p) => cleanType(p.Plant_Type));
    try {
      if (dir === 'up') ref.cart.moveUp(); else ref.cart.moveDown();
    } catch (e) {
      return fail('CART_BLOCKED', { cart: id, direction: dir }, '矿车移动失败：' + (e && e.message ? e.message : e));
    }
    return {
      ok: true, cart: id, direction: dir,
      from: { lane: ref.lane, column: ref.column },
      to: { lane: target.lIndex, column: target.cIndex },
      plants,
      detail: `矿车 #${id} ${dir === 'up' ? '上移' : '下移'}`,
    };
  }

  // 重开本关：走游戏自己的暂停菜单组件（PauseScreen.restart），比点 UI 稳。
  async function restartLevel() {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    let before = null;
    try { before = reader.snapshot().phase; } catch { before = null; }
    const ps = findCompByClass(ctxg.scene, 'PauseScreen');
    if (!ps || typeof ps.restart !== 'function') {
      return fail('RESTART_UNSUPPORTED', { phase: before }, '这一关不支持重开（找不到 PauseScreen.restart）');
    }
    try {
      ps.restart();
    } catch (e) {
      return fail('RESTART_FAILED', { phase: before }, '重开失败：' + String(e && e.message || e));
    }
    const ok = await waitFor(() => {
      try {
        const s = reader.snapshot();
        return !!(s && s.ok && (s.phase === 'preparing' || s.phase === 'objective'));
      } catch { return false; }
    }, 8000);
    if (!ok) {
      return {
        ok: false, code: 'RESTART_TIMEOUT', restarted: false, phase: before, retryable: true,
        reason: '重开没有在 8 秒内回到选卡/任务阶段，用 pvz_state 看当前 phase',
      };
    }
    return { ok: true, restarted: true, from: before, phase: 'preparing', detail: '本关已重开（回到选卡阶段）' };
  }

  async function act(a) {
    const ctxg = findComps();
    if (!ctxg) return fail('NO_SCENE');
    const { map } = ctxg;
    const ui = map.UIInGame, cards = map.Cards;
    const C = map.Square && map.Square.constructor;
    if (!a || typeof a !== 'object') return fail('BAD_ACTION');
    if (ui && ui.paused && a.type !== 'resume') return fail('PAUSED', { retryable: true });

    if (a.type === 'resume') return resume();
    if (a.type === 'wait') return { ok: true, detail: '等待' };
    if (a.type === 'dismiss_objective') return dismissObjective();
    if (a.type === 'choose_deck') return chooseDeck(a.cards || a.plants, a.replace);
    if (a.type === 'start_level') return startLevel();
    if (a.type === 'restart') return restartLevel();
    if (a.type === 'collect') return collect();
    if (a.type === 'move_cart') return moveCart(a.cart, a.direction);

    if (!C) return fail('NO_SCENE');
    if (!cards) return fail('NO_SCENE', {}, '卡槽还没加载');

    const lane = Number(a.lane), column = Number(a.column);
    if (!Number.isFinite(lane) || !Number.isFinite(column)) return fail('BAD_POSITION');

    if (a.type === 'plant' || a.type === 'replace') {
      let index = Number(a.card);
      if (!Number.isFinite(index) && a.plant) {
        index = (cards.CFs || []).findIndex((cf) => cleanType(cf.Type) === String(a.plant));
      }
      const cf = cards && cards.CFs && cards.CFs[index];
      if (!cf) return fail('NO_CARD', { card: a.card, plant: a.plant || null });
      const type = cleanType(cf.Type);
      const upper = cards.cardsUIUpper && cards.cardsUIUpper[index];
      const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
      if (cd > 0) return fail('COOLDOWN', { card: index, type, retryAfter: Math.round(cd * 10) / 10 }, `${type} 冷却中 ${cd.toFixed(1)}s`);
      const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
      const sunNow = map.SunCount ? map.SunCount.CurrentValue : null;
      if (sunNow != null && sunNow < cost && !(cf.ca && cf.ca.free)) return fail('SUN', { card: index, type, need: cost, have: sunNow }, `阳光不足：需要 ${cost}，现有 ${sunNow}`);

      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      if (a.type !== 'replace' && reader.cellPlants(cell).length > 0) {
        const occupants = reader.cellPlants(cell).map((p) => cleanType(p.Plant_Type));
        return fail('OCCUPIED', {
          lane, column, plants: occupants,
          hint: '同格已有植物；要换植用 replace（先铲后种），只腾位用 shovel',
        }, `${lane} 行 ${column} 列已被 ${occupants.join('/') || '植物'} 占用，可用 replace 先铲后种`);
      }
      if (a.type === 'replace') {
        try { cell.removePlant(); } catch { /* ignore */ }
        // 铲除也是异步的：等格子真的空了，再种新卡，避免把旧植物数量当成新植物已落地。
        await waitFor(() => reader.cellPlants(cell).length === 0, 500);
      }
      let canPlace = true;
      try { canPlace = cell.putPlantAvailable ? cell.putPlantAvailable(true, cf.ID, true, true, cf.spf) : true; } catch { canPlace = true; }
      if (!canPlace) {
        reader.learnCell(lane, column, 'CELL_BLOCKED');
        return fail('CELL_BLOCKED', { lane, column, card: index, type }, `${lane} 行 ${column} 列不能种`);
      }
      if (ui && typeof ui.tryChangingIndex === 'function' && ui.index !== index) {
        ui.tryChangingIndex(index);
        // 等种子栏真正切到目标卡，再发起种植；否则 PlaceUIPlant 可能用旧卡。
        await waitFor(() => Number(ui.index) === index, 120);
      }
      const beforeLen = reader.cellPlants(cell).length;
      try {
        cell.PlaceUIPlant();
      } catch (e) {
        return fail('PLANT_NOT_SETTLED', { lane, column, card: index, type, started: false, retryable: true }, `${type} 发起失败：${String(e && e.message || e)}`);
      }
      // 种植落地是异步的；先把“已发起”如实返回，再等作物真正出现在格子里。
      const settled = await waitFor(() => reader.cellPlants(cell).length > beforeLen, 1500);
      if (!settled) {
        return {
          ok: true,
          pending: true,
          started: true,
          settled: false,
          lane, column, card: index, type,
          detail: `${type} 已发起，等待落地（下一拍 pvz_state 确认，不要立刻重种）`,
        };
      }
      return { ok: true, lane, column, card: index, type, settled: true, detail: `${a.type === 'replace' ? '换植' : '种下'} ${type} @ ${lane},${column}` };
    }

    if (a.type === 'shovel') {
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const before = reader.cellPlants(cell).length;
      if (!before) return fail('EMPTY', { lane, column });
      try { cell.removePlant(); } catch { /* ignore */ }
      const gone = await waitFor(() => reader.cellPlants(cell).length < before, 500);
      if (!gone) return fail('SHOVEL_FAILED', { lane, column }, '铲除没有生效');
      return { ok: true, lane, column, detail: `铲除 @ ${lane},${column}` };
    }

    if (a.type === 'plant_food') {
      const counter = map.PlantFoodCount;
      if (counter && !(counter.plantFoodNum > 0)) return fail('NO_FOOD', { have: counter.plantFoodNum || 0 });
      const cell = C.getLnC(lane, column);
      if (!cell) return fail('NO_CELL', { lane, column });
      const p = reader.cellPlants(cell)[0];
      if (!p) return fail('NO_PLANT', { lane, column });
      if (!p.foodable) return fail('NOT_FOODABLE', { lane, column, type: cleanType(p.Plant_Type) });
      try {
        p.fooding = true;
        if (typeof p.doPlantFood === 'function') p.doPlantFood();
        return { ok: true, lane, column, type: cleanType(p.Plant_Type), detail: `能量豆 @ ${lane},${column}` };
      } catch (e) {
        return fail('FOOD_FAILED', { lane, column }, String(e && e.message || e));
      }
    }

    return fail('UNKNOWN_ACTION', { type: a.type });
  }

  async function actAll(actions) {
    const list = Array.isArray(actions) ? actions.slice(0, 6) : [];
    if (!list.length) return fail('NO_ACTIONS', {}, 'actions 为空（一次 1–6 个）');
    const results = [];
    for (let i = 0; i < list.length; i++) {
      try {
        results.push({ index: i, type: list[i] && list[i].type, ...(await act(list[i])) });
      } catch (e) {
        results.push({ index: i, type: list[i] && list[i].type, ok: false, code: 'ACT_THREW', reason: String(e && e.message || e) });
      }
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
    };
  }

  return { act, actAll, chooseDeck, startLevel, restartLevel, dismissObjective, resume, collect, moveCart, deckStatus, fail };
}


// ── bridge/briefing.js ──
/**
 * briefing / knowledge：把"做决定需要的事实"整理给 LLM。
 *
 * 明确不返回：推荐卡组、本地建议、打法结论。卡组和打法只能由 LLM 自己给。
 */

function createBriefing({ stats, reader, planStore, version, featureList, nameOf }) {
  // 卡牌归类只用图鉴事实（家族 / 弹道 / 是否有攻击 / 是否一次性），不判断强弱。
  function roleOf(st) {
    if (!st) return 'unknown';
    const fam = String(st.family || '');
    const special = (st.special || []).join(' ') + ' ' + ((st.usage && st.usage.activation) || '');
    if (fam === 'Sun' || (st.sun && st.sun.stages)) return 'economy';
    if (/(一次性|立刻|instant)/.test(special)) return 'instant';
    if (/Defence/i.test(fam)) return 'wall';
    if (/Cold|Slow/i.test(fam)) return 'control';
    if (st.shot && st.shot.kind === 'lob') return 'lobber';
    if (st.attack && st.attack.dps) return 'shooter';
    return 'support';
  }

  function plantEntry(type) {
    const st = stats.plantStatsOf(type);
    if (!st) return null;
    return {
      type,
      name: st.name,
      cost: st.cost,
      cd: st.cd,
      hp: st.hp,
      family: st.family,
      range: st.range,
      attack: st.attack,
      sun: st.sun,
      splash: st.splash,
      plantFood: st.plantFood,
      shot: st.shot,
      brief: st.brief,
      introduction: st.introduction,
      special: st.special,
      weaknesses: st.weaknesses,
      usage: st.usage,
    };
  }

  function zombieEntry(type) {
    const st = stats.zombieStatsOf(type);
    if (!st) return null;
    return {
      type,
      name: st.name,
      hp: st.hp,
      armorHp: st.armorHp,
      armorDetail: st.armorDetail,
      ehp: st.ehp,
      speed: st.speed,
      eatDps: st.eatDps,
      tags: st.tags,
      behaviors: st.behaviors,
      brief: st.brief,
      introduction: st.introduction,
      special: st.special,
      weaknesses: st.weaknesses,
    };
  }

  function wavesOf(state) {
    const ls = state.levelScript;
    if (!ls || !Array.isArray(ls.waves)) return [];
    const flagInterval = ls.flagInterval || null;
    return ls.waves.map((w) => {
      const zombieStats = {};
      let ehp = 0;
      for (const [type, count] of Object.entries(w.zombies || {})) {
        const z = stats.zombieStatsOf(type);
        const e = (z && z.ehp) || null;
        zombieStats[type] = { count, ehpEach: e, ehp: e != null ? e * count : null };
        if (e != null) ehp += e * count;
      }
      return {
        wave: w.n,
        flag: flagInterval ? w.n % flagInterval === 0 : false,
        total: w.total,
        ehp,
        zombies: zombieStats,
        rowsHint: w.rowsHint && w.rowsHint.length ? w.rowsHint : null,
        extraFood: w.extraFood || null,
      };
    });
  }

  function briefing() {
    const state = reader.snapshot({ full: true });
    if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason || '不在关卡内' };
    const seed = state.seedSelection;
    const pool = (seed && seed.available) || state.cards || [];
    const cards = pool.map((c) => plantEntry(c.type)).filter(Boolean);

    const waveList = wavesOf(state);
    const waveTypes = new Set();
    for (const w of waveList) for (const t of Object.keys(w.zombies || {})) waveTypes.add(t);
    for (const z of state.zombies || []) waveTypes.add(z.type);
    const zombies = [...waveTypes].map(zombieEntry).filter(Boolean);
    const zombieIndex = new Map(zombies.map((z) => [z.type, z]));
    for (const w of waveList) {
      for (const [type, info] of Object.entries(w.zombies)) {
        if (info.ehp == null && zombieIndex.get(type)) info.ehp = (zombieIndex.get(type).ehp || 0) * info.count;
      }
      if (!w.ehp) w.ehp = Object.values(w.zombies).reduce((s, x) => s + (x.ehp || 0), 0);
    }

    const world = state.world || null;
    const worldMechanics = world ? world.mechanics.map((text, i) => ({ id: `${world.key}_${i}`, text, source: 'world' })) : [];
    const mechanics = [...worldMechanics, ...(state.mechanicFacts || [])].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);

    const constraints = [];
    const missionText = [].concat(state.missionHints || [], (state.objective && state.objective.missions) || []);
    if (state.plantLimit != null) constraints.push({ id: 'plant_limit', text: `本关植物上限：${state.plantLimit} 株`, source: 'objective' });
    for (const t of state.tasks || []) {
      constraints.push({ id: `task_${t.key}`, text: t.tip + (t.hint ? `（${t.hint}）` : ''), source: 'task' });
    }
    if (state.levelScript && state.levelScript.lawn && state.levelScript.lawn.isAtNight) {
      constraints.push({ id: 'night', text: '夜间：没有天空掉落阳光', source: 'lawn' });
    }
    if (world) constraints.push({ id: 'world', text: `世界：${world.name}`, source: 'world' });

    const plan = planStore.getPlan();
    // 卡组结构事实：只数「有几张能干什么」，不写该不该带。
    const deckTypes = (seed && seed.current) || state.deck || [];
    const coverage = { economy: 0, shooter: 0, lobber: 0, wall: 0, instant: 0, control: 0, support: 0 };
    for (const t of deckTypes) {
      const st = stats.plantStatsOf(t);
      coverage[roleOf(st)] += 1;
    }
    return {
      ok: true,
      version,
      phase: state.phase,
      scene: state.scene,
      objective: state.objective,
      missionHints: state.missionHints,
      level: {
        name: state.level.name || null,
        wave: state.level.wave,
        waves: state.level.waves,
        nextWaveIn: state.level.nextWaveIn,
        source: state.level.source,
        world: world ? { key: world.key, name: world.name } : null,
      },
      world: world ? { key: world.key, name: world.name, mechanics: world.mechanics, zombies: world.zombies } : null,
      terrain: {
        lanes: state.terrain ? state.terrain.lanes : 0,
        columns: state.terrain ? state.terrain.columns : 0,
        map: state.terrain ? state.terrain.map : [],
        squareTypes: state.terrain ? state.terrain.squareTypes : [],
        legend: state.terrain ? state.terrain.legend : {},
        blockedCells: state.blockedCells || [],
        plantable: state.plantable || [],
        obstacles: state.obstacles || [],
      },
      waves: waveList,
      zombies,
      cards,
      deck: {
        slots: seed ? seed.slots : (state.cards || []).length,
        current: seed ? seed.current : (state.deck || []),
        gameStartable: seed ? seed.gameStartable : null,
        coverage,
      },
      startingSun: state.startingSun,
      plantLimit: state.plantLimit,
      constraints,
      mechanics,
      plan: plan ? plan.plan : null,
      planSavedAt: plan ? plan.savedAt : null,
      facts: {
        sun: state.sun,
        plantFood: state.plantFood,
        plantsOnLawn: (state.plants || []).length,
        zombiesOnLawn: (state.zombies || []).length,
        totalWaveEhp: waveList.reduce((s, w) => s + (w.ehp || 0), 0),
        missionText,
      },
      notes: [
        '这是事实清单：没有推荐卡组，也没有本地打法。选卡、每行职责、阈值都由你决定。',
        'stats 里的 ehp = 本体血量 + 全部护甲；dps = 伤害 / 攻击间隔。',
        'plantable 只排除已占格、障碍格、水面/天空；特殊卡（睡莲等）的落点仍要按卡牌说明判断。',
        'plantLimit 为 null 就是本关没有植物数量上限；不要从任务原文、图鉴或以往关卡推断上限。objective.trusted=false 表示只是未初始化的模板，missions 已清空。',
        ...(state.objective && state.objective.trusted === false
          ? ['本关没有下发任务文本（objective 是模板），tasks 为空就按普通关卡打。']
          : []),
      ],
    };
  }

  function normalizeQuery(args) {
    const a = args || {};
    const type = a.type || a.id || a.codename || a.name || null;
    return {
      type: type == null ? null : String(type),
      kind: a.kind ? String(a.kind) : null,
      query: a.query ? String(a.query) : null,
    };
  }

  function search(q, kind) {
    const text = q.toLowerCase();
    const out = [];
    const kinds = kind ? [kind] : ['plant', 'zombie'];
    for (const k of kinds) {
      for (const f of featureList(k)) {
        const code = String(f.CODENAME || '');
        if (!code) continue;
        const name = f.NAME || {};
        const almanac = k === 'plant' ? stats.plantStatsOf(code) : stats.zombieStatsOf(code);
        const hay = [code, name.zh, name.en, almanac && almanac.brief, almanac && almanac.introduction,
          ...((almanac && almanac.special) || [])].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(text)) continue;
        out.push({
          kind: k,
          type: code,
          name: name.zh || code,
          nameEn: name.en || null,
          cost: almanac && almanac.cost,
          hp: almanac && almanac.hp,
          ehp: almanac && almanac.ehp,
          brief: almanac && almanac.brief,
          score: (code === text ? 100 : 0) + (String(name.zh || '').includes(q) ? 50 : 0) + 1,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 12).map(({ score, ...x }) => x);
  }

  function knowledge(args) {
    const { type, kind, query } = normalizeQuery(args);
    if (kind && !['plant', 'zombie', 'level'].includes(kind)) {
      return { ok: false, code: 'BAD_QUERY', reason: 'kind 只能是 plant / zombie / level' };
    }
    if (kind === 'level') {
      const state = reader.snapshot({ full: true });
      if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason };
      return {
        ok: true,
        kind: 'level',
        entry: {
          name: state.level.name || null,
          wave: state.level.wave,
          waves: state.level.waves,
          source: state.level.source,
          world: state.world,
          objective: state.objective,
          missionHints: state.missionHints,
          tasks: state.tasks,
          terrain: state.terrain,
          zombieStats: state.zombieStats,
          levelScript: state.levelScript,
        },
      };
    }
    if (query && !type) {
      const matches = search(query, kind);
      return {
        ok: true,
        query,
        matches,
        hint: matches.length ? '用 type 再查一次可拿完整图鉴与数值。' : '没有匹配项；可以换 codename 或中文名。',
      };
    }
    if (!type) {
      return {
        ok: false,
        code: 'BAD_QUERY',
        reason: '需要 type（codename）或 query（中文/英文关键词）',
        examples: [
          { type: 'sunshroom' },
          { type: 'pirate_armor1' },
          { query: '海盗 水 僵尸' },
        ],
      };
    }
    const t = type.trim();
    if (kind === 'plant' || (!kind && stats.plantStatsOf(t))) {
      const entry = plantEntry(t);
      if (entry) return { ok: true, kind: 'plant', entry };
    }
    if (kind === 'zombie' || (!kind && stats.zombieStatsOf(t))) {
      const entry = zombieEntry(t);
      if (entry) return { ok: true, kind: 'zombie', entry };
    }
    if ((!kind || kind === 'level') && (t === 'level' || t === '本关')) {
      const state = reader.snapshot({ full: true });
      if (!state.ok) return { ok: false, code: state.code || 'NO_SCENE', reason: state.reason };
      return {
        ok: true,
        kind: 'level',
        entry: {
          name: state.level.name || null,
          wave: state.level.wave,
          waves: state.level.waves,
          source: state.level.source,
          world: state.world,
          objective: state.objective,
          missionHints: state.missionHints,
          tasks: state.tasks,
          terrain: state.terrain,
          zombieStats: state.zombieStats,
          levelScript: state.levelScript,
        },
      };
    }
    const matches = search(t, kind);
    return {
      ok: false,
      code: 'KNOWLEDGE_NOT_FOUND',
      reason: `没有找到 ${t}`,
      matches,
      hint: '从 matches 里选一个 codename 再查。',
    };
  }

  function fieldGuide() {
    return {
      plants: featureList('plant').map((f) => ({ type: f.CODENAME, name: (f.NAME && f.NAME.zh) || f.CODENAME, en: (f.NAME && f.NAME.en) || null })),
      zombies: featureList('zombie').map((f) => ({ type: f.CODENAME, name: (f.NAME && f.NAME.zh) || f.CODENAME, en: (f.NAME && f.NAME.en) || null })),
    };
  }

  function worldOf(text) {
    return worldFactOf(text);
  }

  return { briefing, knowledge, plantEntry, zombieEntry, fieldGuide, worldOf };
}


// ── bridge/plan.js ──
/**
 * plan：只记录 LLM 自己写的整关计划。
 * 读写之外不做任何事——不解析成执行队列，不修正，更不参与本地决策。
 */
function createPlanStore(version) {
  let plan = null;
  let savedAt = null;

  function setPlan(value) {
    if (value == null) {
      plan = null;
      savedAt = null;
      return { ok: true, plan: null, savedAt: null, detail: '已清空计划' };
    }
    if (typeof value !== 'object') {
      return { ok: false, code: 'BAD_PLAN', reason: 'plan 必须是对象' };
    }
    plan = JSON.parse(JSON.stringify(value));
    savedAt = new Date().toISOString();
    return { ok: true, plan, savedAt, detail: '计划已记录（只保存，不执行）' };
  }

  function getPlan() {
    return plan ? { plan, savedAt } : null;
  }

  function reset() {
    plan = null;
    savedAt = null;
  }

  return { setPlan, getPlan, reset, version };
}


// ── bridge/events.js ──
/**
 * events：把两次 snapshot 的差异变成增量事件。
 * 只做变更检测 + 去抖，不做判断。LLM 自己决定这些事件意味着什么。
 */

const keyOf = (e) => `${e.t}:${e.lane == null ? '' : e.lane}:${e.detail || ''}`;

function createEventStreamApi({ snapshot }) {
  const debounceMs = 2500;
  const queue = [];
  const lastAt = new Map();
  let prev = null;
  let dropped = 0;
  let timer = null;
  let interval = 100;

  function emit(list, ev, now) {
    const k = keyOf(ev);
    const t = lastAt.get(k) || 0;
    if (now - t < debounceMs) return;
    lastAt.set(k, now);
    list.push({ ...ev, at: new Date(now).toISOString() });
  }

  function push(state, now = Date.now()) {
    const out = [];
    if (!state || state.ok === false) { prev = state; return out; }
    if (!prev || prev.ok === false) { prev = state; return out; }

    const w1 = (prev.level && prev.level.wave) || 0;
    const w2 = (state.level && state.level.wave) || 0;
    if (w2 > w1) {
      const types = [...new Set((state.zombies || []).map((z) => z.type))];
      const ehpTotal = (state.zombies || []).reduce((s, z) => s + (((state.zombieStats || {})[z.type] || {}).ehp || 0), 0);
      emit(out, { t: 'wave_started', wave: w2, types, ehpTotal, detail: `第${w2}波${types.length ? ' ' + types.join(',') : ''}` }, now);
    }

    for (const lane of state.lanes || []) {
      const before = (prev.lanes || []).find((l) => l.lane === lane.lane);
      if (before && before.mower !== false && lane.mower === false) {
        emit(out, { t: 'mower_lost', lane: lane.lane, detail: '该行失去推车（再漏一只就输）' }, now);
      }
    }
    for (const p of prev.plants || []) {
      if (!(state.plants || []).some((q) => q.lane === p.lane && q.column === p.column)) {
        emit(out, { t: 'plant_lost', lane: p.lane, detail: `${p.type} @c${p.column}` }, now);
      }
    }

    for (const lane of state.lanes || []) {
      const before = (prev.lanes || []).find((l) => l.lane === lane.lane) || {};
      const nearBefore = before.nearestZombie;
      const nearNow = lane.nearestZombie;
      if (nearNow == null) continue;
      const isNew = (before.zombies || 0) === 0;
      const gotCloser = nearBefore != null && nearNow < nearBefore - 1;
      if (isNew || gotCloser) {
        emit(out, {
          t: 'lane_threat', lane: lane.lane, nearestCol: nearNow,
          count: lane.zombies, walls: lane.walls, shooters: lane.shooters,
          detail: `最近僵尸 c${nearNow}${isNew ? '（新来）' : ''} 墙${lane.walls || 0} 输出${lane.shooters || 0}`,
        }, now);
      }
    }

    const prevCards = new Map((prev.cards || []).map((c) => [c.type, c.ready]));
    const nowReady = (state.cards || []).filter((c) => c.ready && prevCards.get(c.type) === false).map((c) => c.type);
    if (nowReady.length) emit(out, { t: 'card_ready', types: nowReady, detail: nowReady.join(',') }, now);

    const prevTypes = new Set((prev.zombies || []).map((z) => z.type));
    const newTypes = [...new Set((state.zombies || []).map((z) => z.type))].filter((t) => !prevTypes.has(t));
    if (newTypes.length) emit(out, { t: 'zombie_new', types: newTypes, detail: newTypes.join(',') }, now);

    const prevTasks = new Map((prev.tasks || []).map((t) => [t.key, t]));
    for (const t of state.tasks || []) {
      const before = prevTasks.get(t.key);
      if (t.completed && before && !before.completed) emit(out, { t: 'task_done', detail: t.tip }, now);
      if (t.failed && before && !before.failed) emit(out, { t: 'task_failed', detail: t.tip }, now);
      if (t.urgent && !(before && before.urgent)) emit(out, { t: 'task_urgent', detail: t.hint || t.tip }, now);
    }

    if (state.phase === 'won' && prev.phase !== 'won') emit(out, { t: 'level_won', detail: '关卡胜利' }, now);
    if (state.phase === 'lost' && prev.phase !== 'lost') emit(out, { t: 'level_lost', detail: '关卡失败' }, now);

    prev = state;
    return out;
  }

  function sample() {
    let s = null;
    try { s = snapshot(); } catch { return; }
    if (!s || s.ok === false) return;
    let evs = [];
    try { evs = push(s); } catch { evs = []; }
    if (!evs.length) return;
    queue.push(...evs);
    if (queue.length > 200) {
      dropped += queue.length - 200;
      queue.splice(0, queue.length - 200);
    }
  }

  function setEventSampler(ms) {
    interval = Math.max(50, Math.min(1000, Number(ms) || 100));
    if (timer) { clearInterval(timer); timer = null; }
    timer = setInterval(sample, interval);
    return { ok: true, interval };
  }

  function events(limit) {
    const max = Math.max(1, Math.min(200, Number(limit) || 200));
    return queue.splice(0, max);
  }

  function pollEvents(limit) {
    sample();
    return events(limit);
  }

  function status() {
    return { ok: true, interval, pending: queue.length, dropped, debounceMs };
  }

  function reset() {
    prev = null;
    lastAt.clear();
    queue.length = 0;
    dropped = 0;
  }

  function dispose() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { push, sample, events, pollEvents, status, reset, dispose, setEventSampler };
}


// ── bridge/api.js ──
/**
 * api：桥接层入口。只暴露"读状态 / 执行动作 / 发事件 / 存计划"。
 *
 * 这里没有 setStrategy、autoDeck、suggestDeck、本地队列 —— 决策只属于 LLM。
 */

const BRIDGE_VERSION = '0.1.14';

function createBridge(ctx) {
  const A = (() => (typeof window !== 'undefined' ? window : globalThis))();
  const getCc = () => {
    try { return (ctx && ctx.unsafe && ctx.unsafe.engine && ctx.unsafe.engine.getCc && ctx.unsafe.engine.getCc()) || A.cc || null; } catch { return null; }
  };

  function findCompByClass(root, cls) {
    let hit = null;
    const walk = (n) => {
      for (const c of n._components || []) {
        const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
        if (k === cls) { hit = c; return; }
      }
      for (const ch of n.children || []) { walk(ch); if (hit) return; }
    };
    try { if (root) walk(root); } catch { /* ignore */ }
    return hit;
  }

  const stats = createStatsReader(getCc);
  const reader = createSnapshotReader({ getCc, findCompByClass, stats, version: BRIDGE_VERSION });
  const planStore = createPlanStore(BRIDGE_VERSION);
  const actions = createActions({ getCc, findComps: reader.findComps, findCompByClass, stats, reader, version: BRIDGE_VERSION });
  const briefingApi = createBriefing({
    stats, reader, planStore, version: BRIDGE_VERSION,
    featureList: (kind) => featureList(getCc, kind),
    nameOf: null,
  });
  const eventsApi = createEventStreamApi({ snapshot: reader.snapshot });

  function snapshot() {
    const s = reader.snapshot();
    if (s && s.ok) {
      const p = planStore.getPlan();
      s.plan = p ? p.plan : null;
      s.planSavedAt = p ? p.savedAt : null;
    }
    return s;
  }

  function health() {
    let s = null;
    try { s = snapshot(); } catch { /* ignore */ }
    const api = [
      'snapshot', 'briefing', 'knowledge', 'act', 'actAll', 'events', 'pollEvents',
      'setPlan', 'getPlan', 'chooseDeck', 'deckStatus', 'startLevel',
      'restartLevel', 'dismissObjective', 'collect', 'moveCart', 'resume', 'health',
    ];
    const missing = api.filter((k) => typeof apiObj[k] !== 'function');
    return {
      ok: !!s,
      version: BRIDGE_VERSION,
      scene: s && s.scene,
      phase: s && s.phase,
      api,
      missing,
      features: {
        briefing: true,
        knowledge: true,
        events: true,
        plan: true,
        deck: true,
        carts: Array.isArray(s && s.carts),
        terrain: !!(s && s.terrain && s.terrain.map),
        stats: !!(s && Object.keys(s.zombieStats || {}).length >= 0),
        autoCollect: true,
        localStrategy: false,
        autoDeck: false,
        queue: false,
      },
      eventStatus: eventsApi.status(),
      counts: {
        cards: (s && s.cards || []).length,
        plants: (s && s.plants || []).length,
        zombies: (s && s.zombies || []).length,
        waves: (s && s.levelScript && (s.levelScript.waveCount || (s.levelScript.waves || []).length)) || 0,
      },
    };
  }

  const apiObj = {
    version: BRIDGE_VERSION,
    snapshot,
    briefing: () => briefingApi.briefing(),
    knowledge: (args) => briefingApi.knowledge(args),
    act: (a) => actions.act(a),
    actAll: (list) => actions.actAll(list),
    events: (limit) => eventsApi.events(limit),
    pollEvents: (limit) => eventsApi.pollEvents(limit),
    eventStatus: () => eventsApi.status(),
    setEventSampler: (ms) => eventsApi.setEventSampler(ms),
    setPlan: (plan) => planStore.setPlan(plan),
    getPlan: () => planStore.getPlan(),
    chooseDeck: (cards, replace) => actions.chooseDeck(cards, replace),
    deckStatus: () => actions.deckStatus(),
    startLevel: () => actions.startLevel(),
    restartLevel: () => actions.restartLevel(),
    dismissObjective: () => actions.dismissObjective(),
    collect: () => actions.collect(),
    moveCart: (cart, direction) => actions.moveCart(cart, direction),
    resume: () => actions.resume(),
    health,
    dispose: () => {
      eventsApi.dispose();
      if (reader.setAutoCollect) reader.setAutoCollect(false);
      return { ok: true };
    },
  };

  try { A.PvzLlm = apiObj; } catch { /* ignore */ }
  try { reader.setAutoCollect(true); } catch { /* ignore */ }
  try { eventsApi.setEventSampler(100); } catch { /* ignore */ }
  return apiObj;
}


// ── tools/definitions.js ──
/**
 * 工具契约（MCP / 游戏内 LLM 客户端共用）。
 *
 * 原则：
 *  - 只给事实、执行动作、返回真实结果、记录 LLM 的计划；
 *  - 没有"推荐卡组 / 自动补卡 / 本地策略队列"这类工具；
 *  - 参数名、错误码与 docs/tool-contract.md 保持一致。
 */

const ACTION_TYPES = ['plant', 'replace', 'shovel', 'plant_food', 'move_cart', 'resume', 'wait', 'restart', 'dismiss_objective', 'collect'];

const actionSchema = {
  type: 'object',
  description: '一个精确动作。一次 pvz_act 最多 6 个，按数组顺序执行。',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    card: { type: 'integer', minimum: 0, description: '当前卡槽下标（pvz_state.cards[].index）。与 plant 二选一。' },
    plant: { type: 'string', description: '植物 codename（如 sunflower）。与 card 二选一，适合不想记下标时。' },
    lane: { type: 'integer', minimum: 0, description: '行号，0 在最上面。' },
    column: { type: 'integer', minimum: 0, description: '列号，0 在最左边（房子一侧）。' },
    cells: {
      type: 'array', minItems: 1, maxItems: 8,
      description: '批量落点（只对 plant/replace 有效）：一次把同一张卡种到多个格子。工具会按卡的冷却自动等 retryAfter 再重试，最多阻塞 25 秒。给了 cells 就不要再给 lane/column。',
      items: {
        type: 'object', additionalProperties: false, required: ['lane', 'column'],
        properties: { lane: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 } },
      },
    },
    cart: { type: 'integer', minimum: 0, description: '矿车 id（pvz_state.carts[].id）。' },
    direction: { type: 'string', enum: ['up', 'down'], description: '矿车移动方向。' },
    seconds: { type: 'number', minimum: 0, maximum: 15, description: 'wait 动作的秒数。' },
  },
};

const TOOLS = [
  {
    name: 'pvz_briefing',
    title: '开局简报（全量事实）',
    description:
      '在 objective / preparing 阶段读取本关全部事实：任务原文、世界与机制、地形/障碍/可种格、波次与每波僵尸/总 EHP、僵尸图鉴与数值、全部可用卡（费用/冷却/血量/DPS/产阳光/射程/弹道/用法）、卡槽数与当前卡组、植物上限、起始阳光。' +
      '不返回推荐卡组，也不返回本地打法。选卡前调用一次，把返回内容当作唯一事实来源。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_knowledge',
    title: '图鉴 / 数值查询',
    description:
      '查询植物、僵尸或本关的事实：图鉴简介、特殊能力/弱点、hp/护甲/EHP/速度/啃食 DPS、费用/冷却/DPS/产阳光/射程/弹道/用法（自动、点击、只能墓碑、只能冰块、被啃食）。' +
      '给 type 拿完整条目；给 query 做关键词搜索（中文/英文/codename）；kind 可选 plant/zombie/level。只给事实，不给结论。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', description: 'codename，例如 sunflower、pirate_armor1。' },
        query: { type: 'string', description: '关键词，例如 “海盗 水 僵尸”。' },
        kind: { type: 'string', enum: ['plant', 'zombie', 'level'], description: '限定查询类别。' },
      },
    },
  },
  {
    name: 'pvz_state',
    title: '实时状态',
    description:
      '读取当前实时状态：phase、暂停、阳光/能量豆、波次与倒计时、任务、卡槽（cd/cdReady/affordable/sunShort/ready）、植物、僵尸（hp/maxHp/armorHp/ehp/ehpMax）、5×9 棋盘、每行事实（僵尸数/最近列/推车/输出株数/墙血/dps 合计/剩余 ehp）、地形图、可种格、障碍、机制清单、矿车、当前计划。' +
      'changesSinceLast 是工具算好的「自上次调用 pvz_state 以来的变化」：plantsLost（哪格哪株消失）、plantsAdded、mowerLost（哪行丢车）、waveDelta、sunDelta、zombieDelta、plantsLeft；没有变化时 none=true。' +
      '坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_events',
    title: '增量事件',
    description:
      '取走自上次调用以来的事件：波次开始、行威胁、丢车、植物损失、卡牌就绪、新僵尸类型、任务紧急/完成/失败、胜负。同 lane/同类事件 2.5 秒内合并。没有事件时返回空数组。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 200。' },
      },
    },
  },
  {
    name: 'pvz_set_plan',
    title: '记录整关计划',
    description:
      '记录你自己制定的计划（风格、卡组、每行职责、关键阈值、应急方案）。工具只保存并在 pvz_state.plan 里回显，不执行、不修正、不参与任何本地决策。传 null 清空。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: { anyOf: [{ type: 'object' }, { type: 'null' }], description: '任意 JSON 对象；建议含 style/deck/lanes/thresholds/contingency。传 null 清空。' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'pvz_choose_deck',
    title: '选卡（只校验 + 执行）',
    description:
      '在选卡阶段按你给的卡组逐张选卡。工具只校验和执行：卡不在卡池返回 CARD_NOT_AVAILABLE + available；重复/超槽位返回 BAD_DECK；数量不足返回 DECK_NOT_FULL + 还差几张；合法才执行。' +
      '逐张加卡并等待 UI 同步，最后返回 actualDeck/applied/skipped/missing。绝不自动补卡，绝不替换你指定的卡。replace=true 会先清空当前卡组。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cards: { type: 'array', minItems: 1, items: { type: 'string' }, description: '植物 codename 列表，数量必须等于卡槽数（replace=false 时含已选卡）。' },
        replace: { type: 'boolean', default: true, description: 'true=清空现有卡组后重新选；false=在现有卡组上追加。' },
      },
      required: ['cards'],
    },
  },
  {
    name: 'pvz_start_level',
    title: '开局',
    description:
      '关闭任务说明弹窗（如还在）并开始战斗。若卡组未满返回 DECK_NOT_FULL。默认等待最多 8 秒确认 phase 进入 running；返回 started/phase/elapsed。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dismiss_objective: { type: 'boolean', default: true, description: '开局前是否关闭任务说明弹窗。' },
        timeout: { type: 'number', minimum: 1, maximum: 20, default: 8, description: '等待进入 running 的秒数。' },
      },
    },
  },
  {
    name: 'pvz_act',
    title: '执行精确动作',
    description:
      '执行 1–6 个精确动作：plant（种植）、replace（同格换植）、shovel（铲除）、plant_food（能量豆）、move_cart（矿车）、resume（继续）、wait（等待）、restart（重开本关）、dismiss_objective、collect。' +
      'plant/replace 传 cells 可以把同一张卡一次种到多个格子（工具按冷却自动等待重试）。' +
      '同一张卡在一批动作里出现两次时，工具也会自动等它的冷却（单次≤6 秒、最多重试 2 次）再执行。' +
      '每个动作返回真实 ok/code/reason/retryAfter（如 COOLDOWN/SUN/OCCUPIED/CELL_BLOCKED）。部分失败不会抛异常；按每个 result 自己决定下一步。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: { type: 'array', minItems: 1, maxItems: 6, items: actionSchema },
      },
      required: ['actions'],
    },
  },
  {
    name: 'pvz_wait_until',
    title: '条件等待',
    description:
      '轮询实时状态，直到条件满足或超时（1–60 秒）。支持：sun>=N / sun<=N / plantfood>=N / card_ready:<type|index> / zombie_in_lane:<lane> / no_zombie_in_lane:<lane> / zombie_near:<column> / phase:<phase> / plants>=N / tasks_ready。' +
      '复合条件用 && 或 ||（一条里只用一种）。超时返回 TIMEOUT + 最后状态，不是错误崩溃。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        until: { type: 'string', description: '条件表达式，例如 sun>=150 && card_ready:sunflower。' },
        timeout: { type: 'number', minimum: 1, maximum: 60, default: 15, description: '超时秒数。' },
      },
      required: ['until'],
    },
  },
  {
    name: 'pvz_collect',
    title: '收掉落物',
    description: '立即收取场上所有可点击掉落物（阳光/能量豆/金币/钻石）。正常会自动收，此工具用于兜底。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_plant_food',
    title: '能量豆',
    description: '给指定格子的植物释放能量豆。返回 NO_FOOD / NO_PLANT / NOT_FOODABLE 等真实 code。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: { type: 'integer', minimum: 0 },
        column: { type: 'integer', minimum: 0 },
      },
      required: ['lane', 'column'],
    },
  },
  {
    name: 'pvz_move_cart',
    title: '移动矿车',
    description: '把矿车向上或向下移动到相邻轨道；植物会随车移动。返回 from/to 与车上植物。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cart: { type: 'integer', minimum: 0, description: '矿车 id。' },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['cart', 'direction'],
    },
  },
  {
    name: 'pvz_resume',
    title: '继续游戏',
    description: '如果游戏处于暂停状态则继续；未暂停时无副作用。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_restart',
    title: '重开本关',
    description:
      '重开当前关卡（回到选卡/任务阶段，阳光、植物、推车、波次全部重置）。不需要先进暂停菜单，工具直接走游戏自己的重开流程。' +
      '返回 restarted/from/phase；8 秒内没回到 preparing 会返回 RESTART_TIMEOUT（不是崩溃，用 pvz_state 看 phase）。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_dismiss_objective',
    title: '关闭任务说明',
    description: '关闭开局的关卡目标说明弹窗，返回本关任务文本。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_health',
    title: '健康检查',
    description: '返回模组/工具版本、已注册工具、桥接能力、当前场景与 phase、事件队列状态。用于确认版本匹配。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.name);

/** OpenAI 兼容 tool calling 的 tools 字段。 */
function openAiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** 文档/测试用的返回结构摘要（不是运行时校验器）。 */
const RETURN_SHAPES = {
  pvz_briefing: ['ok', 'phase', 'objective', 'missionHints', 'level', 'world', 'terrain', 'waves', 'zombies', 'cards', 'deck', 'startingSun', 'plantLimit', 'constraints', 'mechanics', 'facts', 'notes'],
  pvz_knowledge: ['ok', 'kind', 'entry | matches'],
  pvz_state: ['ok', 'phase', 'paused', 'sun', 'plantFood', 'level', 'objective', 'tasks', 'cards', 'deck', 'seedSelection', 'plants', 'zombies', 'board', 'lanes', 'terrain', 'blockedCells', 'plantable', 'obstacles', 'mechanics', 'carts', 'limits', 'plan', 'changesSinceLast'],
  pvz_events: ['array of {t, at, lane?, detail?, ...}'],
  pvz_set_plan: ['ok', 'plan', 'savedAt'],
  pvz_choose_deck: ['ok', 'slots', 'requested', 'applied', 'skipped', 'missing', 'actualDeck', 'full'],
  pvz_start_level: ['ok', 'started', 'phase', 'elapsed', 'detail'],
  pvz_act: ['ok', 'results[]', 'okCount', 'failCount'],
  pvz_wait_until: ['ok', 'satisfied', 'condition', 'elapsed', 'state'],
  pvz_collect: ['ok', 'count', 'kinds'],
  pvz_plant_food: ['ok', 'lane', 'column', 'type'],
  pvz_move_cart: ['ok', 'cart', 'direction', 'from', 'to', 'plants'],
  pvz_resume: ['ok', 'paused'],
  pvz_dismiss_objective: ['ok', 'detail', 'tasks'],
  pvz_health: ['ok', 'version', 'api', 'missing', 'features', 'counts', 'eventStatus'],
};


// ── tools/errors.js ──
/**
 * 结构化错误码。工具只返回真实 code；"下一步怎么办"由 LLM 自己决定。
 * retryable 只描述"同一个调用稍后是否可能成功"，不是建议。
 */

const ERROR_CODES = {
  // 场景 / 生命周期
  NO_SCENE: { text: '不在游戏场景内（或棋盘还没加载）', retryable: true },
  NOT_IN_LEVEL: { text: '当前不在关卡里', retryable: true },
  ALREADY_STARTED: { text: '战斗已经开始，不能再选卡', retryable: false },
  PREP_NOT_READY: { text: '选卡/开局界面还没准备好', retryable: true },
  NO_SEED_SELECTION: { text: '当前不在选卡界面', retryable: true },
  NO_SLOTS: { text: '本关没有可用卡槽', retryable: false },

  // 选卡
  BAD_DECK: { text: '卡组不合法（重复、超槽位或数量不对）', retryable: false },
  CARD_NOT_AVAILABLE: { text: '指定的卡不在本关卡池或未解锁', retryable: false },
  DECK_NOT_FULL: { text: '卡组没选满；工具不会自动补卡', retryable: false },
  DECK_CLEAR_FAILED: { text: '旧卡组没能清空', retryable: true },
  CARD_SELECT_FAILED: { text: '卡组已满但有指定卡没选中', retryable: true },
  CARD_NOT_IN_DECK: { text: '这张卡不在当前卡槽里', retryable: false },

  // 动作
  BAD_ACTION: { text: '动作对象不合法', retryable: false },
  BAD_POSITION: { text: 'lane/column 不是数字', retryable: false },
  NO_CARD: { text: '没有这张卡（index 越界）', retryable: false },
  COOLDOWN: { text: '卡牌冷却中', retryable: true },
  SUN: { text: '阳光不足', retryable: true },
  OCCUPIED: { text: '格子已有植物', retryable: false },
  CELL_BLOCKED: { text: '该格不能种植（地形/障碍/滑轨）', retryable: false },
  PLANT_NOT_SETTLED: { text: '种植发起失败（尚未进入异步落地）', retryable: true },
  SHOVEL_FAILED: { text: '铲除没有生效', retryable: true },
  EMPTY: { text: '该格没有植物', retryable: false },
  NO_FOOD: { text: '没有能量豆', retryable: true },
  NO_PLANT: { text: '该格没有植物', retryable: false },
  NOT_FOODABLE: { text: '该植物不能使用能量豆', retryable: false },
  FOOD_FAILED: { text: '能量豆释放失败', retryable: true },
  NO_CELL: { text: '该格不存在', retryable: false },
  PAUSED: { text: '游戏暂停中；先 pvz_resume', retryable: true },
  UNKNOWN_ACTION: { text: '未知动作类型', retryable: false },
  ACT_THREW: { text: '执行动作时抛异常', retryable: false },
  NO_ACTIONS: { text: 'actions 为空', retryable: false },

  // 矿车 / 任务
  NO_CART: { text: '没有这辆矿车', retryable: false },
  CART_BLOCKED: { text: '矿车不能向该方向移动', retryable: false },
  NO_OBJECTIVE: { text: '当前没有关卡目标弹窗', retryable: true },
  CONTINUE_NOT_FOUND: { text: '找不到“继续”按钮', retryable: true },
  DISMISS_FAILED: { text: '关闭任务弹窗失败', retryable: true },
  START_FAILED: { text: '开局调用失败', retryable: true },

  // 等待
  BAD_CONDITION: { text: '无法识别的等待条件', retryable: false },
  TIMEOUT: { text: '等待超时（条件未满足）', retryable: true },

  // 知识 / 计划
  BAD_QUERY: { text: 'knowledge 需要 type 或 query', retryable: false },
  KNOWLEDGE_NOT_FOUND: { text: '没有找到该图鉴条目', retryable: false },
  BAD_PLAN: { text: 'plan 必须是对象', retryable: false },

  // 传输 / 桥
  MOD_NOT_LOADED: { text: '游戏内模组没加载（window.PvzLlm 不存在）', retryable: true },
  CDP_DISCONNECTED: { text: '与游戏的调试连接断开', retryable: true },
  CDP_NO_PAGE: { text: '没有找到游戏调试页面', retryable: true },
  BRIDGE_ERROR: { text: '游戏页面执行异常', retryable: true },
  BAD_RESPONSE: { text: '游戏页面返回了无法解析的结果', retryable: true },
  UNKNOWN_TOOL: { text: '未知工具名', retryable: false },

  // LLM 客户端
  BAD_CONFIG: { text: 'API Base / 模型 / Key 不完整', retryable: true },
  BAD_TOOL_ARGS: { text: '模型返回的工具参数不是合法 JSON', retryable: false },
  TOOL_FAILED: { text: '工具执行时抛异常', retryable: true },
  LLM_HTTP: { text: '模型接口返回 HTTP 错误', retryable: true },
  LLM_REQUEST_FAILED: { text: '模型请求失败（网络/CSP/鉴权）', retryable: true },
  NO_TOOL_CALL: { text: '模型连续没有调用工具；按需求停住，不本地接管', retryable: true },
  STEP_LIMIT: { text: '单轮步数上限；已停住，不本地接管', retryable: true },
  STOPPED: { text: '已停止', retryable: true },
};

function errorInfo(code) {
  return ERROR_CODES[code] || { text: code || 'UNKNOWN', retryable: false };
}

/** 工具回包里统一带上 code/reason/retryable，方便 LLM 复述。 */
function normalizeError(code, extra = {}, reason) {
  const info = errorInfo(code);
  return {
    ok: false,
    code,
    reason: reason || info.text,
    retryable: extra.retryable != null ? !!extra.retryable : !!info.retryable,
    ...extra,
  };
}


// ── tools/wait.js ──
/**
 * wait：把条件字符串解析成对 snapshot 的判断。
 * 纯函数，离线可测；不做任何"该等到什么时候"的建议。
 */

function checkCondition(state, cond) {
  const c = String(cond == null ? '' : cond).trim();
  if (!c) return { ok: false, reason: '空条件' };
  if (!state || state.ok === false) return { ok: true, hit: false, reason: 'state 不可用' };

  if (c.includes('&&') || c.includes('||')) {
    const andMode = c.includes('&&');
    if (andMode && c.includes('||')) return { ok: false, reason: '一条条件里只能使用 && 或 || 其中一种' };
    const parts = c.split(andMode ? '&&' : '||').map((x) => x.trim()).filter(Boolean);
    const rs = parts.map((p) => checkCondition(state, p));
    const bad = rs.find((r) => !r.ok);
    if (bad) return bad;
    return {
      ok: true,
      hit: andMode ? rs.every((r) => r.hit) : rs.some((r) => r.hit),
      parts: parts.map((p, i) => ({ condition: p, hit: rs[i].hit })),
    };
  }

  let m;
  if ((m = /^sun\s*>=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) >= Number(m[1]), actual: state.sun };
  if ((m = /^sun\s*<=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) <= Number(m[1]), actual: state.sun };
  if ((m = /^sun\s*>\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) > Number(m[1]), actual: state.sun };
  if ((m = /^sun\s*<\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) < Number(m[1]), actual: state.sun };
  if ((m = /^plantfood\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: Number(state.plantFood || 0) >= Number(m[1]), actual: state.plantFood };
  if ((m = /^card_ready\s*:\s*(.+)$/i.exec(c))) {
    const v = m[1].trim();
    const list = (state.cards || []);
    const card = list.find((x) => String(x.type) === v) || list[Number(v)];
    return { ok: true, hit: !!(card && card.ready), card: card ? { index: card.index, type: card.type, ready: card.ready, cd: card.cd } : null };
  }
  if ((m = /^zombie_in_lane\s*:\s*(\d+)$/i.exec(c))) {
    const lane = Number(m[1]);
    const n = (state.zombies || []).filter((z) => Number(z.lane) === lane).length;
    return { ok: true, hit: n > 0, count: n };
  }
  if ((m = /^no_zombie_in_lane\s*:\s*(\d+)$/i.exec(c))) {
    const lane = Number(m[1]);
    const n = (state.zombies || []).filter((z) => Number(z.lane) === lane).length;
    return { ok: true, hit: n === 0, count: n };
  }
  if ((m = /^zombie_near\s*:\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) {
    const col = Number(m[1]);
    const zs = (state.zombies || []).filter((z) => Number(z.column) <= col);
    return { ok: true, hit: zs.length > 0, count: zs.length, nearest: zs.length ? Math.min(...zs.map((z) => Number(z.column))) : null };
  }
  if (/^no_zombie$/i.test(c)) return { ok: true, hit: (state.zombies || []).length === 0, count: (state.zombies || []).length };
  if ((m = /^phase\s*:\s*(\w+)$/i.exec(c))) return { ok: true, hit: state.phase === m[1].toLowerCase(), actual: state.phase };
  if ((m = /^plants\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: (state.plants || []).length >= Number(m[1]), actual: (state.plants || []).length };
  if ((m = /^plants_in_lane\s*:\s*(\d+)\s*>=\s*(\d+)$/i.exec(c))) {
    const n = (state.plants || []).filter((p) => Number(p.lane) === Number(m[1])).length;
    return { ok: true, hit: n >= Number(m[2]), actual: n };
  }
  if ((m = /^wave\s*>=\s*(\d+)$/i.exec(c))) {
    const w = state.level && state.level.wave;
    return { ok: true, hit: Number(w) >= Number(m[1]), actual: w };
  }
  if (/^tasks_ready$/i.test(c)) {
    const list = state.tasks || [];
    return { ok: true, hit: list.length > 0 && list.every((t) => t.completed || t.failed) };
  }
  return { ok: false, reason: `无法识别的条件：${c}` };
}

const CONDITION_HELP = [
  'sun>=N', 'sun<=N', 'sun>N', 'sun<N',
  'plantfood>=N', 'card_ready:<type|index>',
  'zombie_in_lane:<lane>', 'no_zombie_in_lane:<lane>', 'zombie_near:<column>', 'no_zombie',
  'phase:<objective|preparing|running|won|lost>',
  'plants>=N', 'plants_in_lane:<lane>>=N', 'wave>=N', 'tasks_ready',
  '复合：a && b，或 a || b（一条里只用一种）',
];


// ── tools/format.js ──
/**
 * format：给人和给 LLM 的两种呈现。
 *
 * UI 只调用 formatToolCall / formatToolResult，保证思考窗里没有整段原始 JSON。
 * 工具返回给模型的仍是结构化对象。
 */

const n = (v) => (v == null ? '?' : v);

function compactState(s) {
  if (!s || s.ok === false) return { ok: false, code: s && s.code, reason: s && s.reason };
  return {
    phase: s.phase,
    paused: s.paused,
    sun: s.sun,
    plantFood: s.plantFood,
    wave: s.level && s.level.wave,
    waves: s.level && s.level.waves,
    nextWaveIn: s.level && s.level.nextWaveIn,
    level: s.level && s.level.name,
    tasks: (s.tasks || []).map((t) => ({ tip: t.tip, hint: t.hint, completed: t.completed, failed: t.failed, urgent: t.urgent })),
    objective: s.objective ? { active: s.objective.active, missions: s.objective.missions } : null,
    counts: {
      cards: (s.cards || []).length,
      plants: (s.plants || []).length,
      zombies: (s.zombies || []).length,
    },
    lanes: (s.lanes || []).map((l) => ({
      lane: l.lane, zombies: l.zombies, nearestZombie: l.nearestZombie,
      plantCount: l.plants, dps: l.dps, wallHp: l.wallHp, mower: l.mower,
    })),
    plantLimit: s.plantLimit,
    plan: s.plan || null,
  };
}

function stateLine(s) {
  if (!s || s.ok === false) return `状态不可用：${(s && (s.code || s.reason)) || '未知'}`;
  const lv = s.level || {};
  const bits = [
    `阶段 ${s.phase}${s.paused ? '（暂停）' : ''}`,
    `阳光 ${n(s.sun)}`,
    `能量豆 ${n(s.plantFood)}`,
    `第 ${n(lv.wave)}/${n(lv.waves)} 波`,
    `植物 ${(s.plants || []).length}`,
    `僵尸 ${(s.zombies || []).length}`,
  ];
  return bits.join('｜');
}

const ACTION_CN = {
  plant: '种植', replace: '换植', shovel: '铲除', plant_food: '能量豆',
  move_cart: '移动矿车', resume: '继续', wait: '等待', restart: '重开本关',
  dismiss_objective: '关闭任务说明', collect: '收掉落物',
};

function formatAction(a) {
  if (!a || typeof a !== 'object') return '?';
  const type = ACTION_CN[a.type] || a.type || '?';
  if (Array.isArray(a.cells) && a.cells.length) {
    const who = a.plant ? ` ${a.plant}` : (a.card != null ? ` #${a.card}` : '');
    const cells = a.cells.map((c) => `第${Number(c.lane) + 1}行第${Number(c.column) + 1}列`).join('、');
    return `${type}${who} ×${a.cells.length}：${cells}`;
  }
  const pos = Number.isFinite(Number(a.lane)) && Number.isFinite(Number(a.column))
    ? ` 第${Number(a.lane) + 1}行 第${Number(a.column) + 1}列` : '';
  const who = a.plant ? ` ${a.plant}` : (a.card != null ? ` #${a.card}` : '');
  if (a.type === 'move_cart') return `${type} #${a.cart} ${a.direction || ''}`;
  if (a.type === 'wait') return `${type} ${a.seconds == null ? '' : a.seconds + 's'}`;
  return `${type}${who}${pos}`.trim();
}

function formatToolCall(name, args) {
  const a = args || {};
  switch (name) {
    case 'pvz_briefing': return '读取开局简报';
    case 'pvz_state': return '读取实时状态';
    case 'pvz_events': return '读取增量事件';
    case 'pvz_knowledge': return `查图鉴：${a.type || a.query || '?'}`;
    case 'pvz_set_plan': return '记录计划';
    case 'pvz_choose_deck': return `选卡：${(a.cards || []).join('、') || '?'}${a.replace === false ? '（追加）' : '（替换）'}`;
    case 'pvz_start_level': return '开始战斗';
    case 'pvz_act': return Array.isArray(a.actions) ? a.actions.map(formatAction).join('；') : '?';
    case 'pvz_wait_until': return `等待：${a.until || '?'}`;
    case 'pvz_collect': return '收掉落物';
    case 'pvz_plant_food': return `能量豆 第${Number(a.lane) + 1}行 第${Number(a.column) + 1}列`;
    case 'pvz_move_cart': return `矿车 #${a.cart} ${a.direction || ''}`;
    case 'pvz_resume': return '继续游戏';
    case 'pvz_restart': return '重开本关';
    case 'pvz_dismiss_objective': return '关闭任务说明';
    case 'pvz_health': return '健康检查';
    default: return name;
  }
}

function codeText(r) {
  if (!r) return '';
  const code = r.code ? `${r.code}` : '';
  const extra = [];
  if (r.retryAfter != null) extra.push(`${r.retryAfter}s 后可重试`);
  if (r.need != null && r.have != null) extra.push(`需要 ${r.need} / 现有 ${r.have}`);
  if (r.retryable === true) extra.push('可重试');
  return [code, extra.join('，')].filter(Boolean).join('（') + (extra.length ? '）' : '');
}

function formatToolResult(name, r) {
  if (name === 'pvz_events') {
    const list = Array.isArray(r) ? r : [];
    if (!list.length) return '没有新事件';
    return list.map((e) => `· ${eventText(e)}`).join('\n');
  }
  if (!r || typeof r !== 'object') return String(r == null ? '无返回' : r);
  const okMark = r.ok === false ? '❌' : '✅';

  if (name === 'pvz_briefing') {
    if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const z = (r.zombies || []).map((x) => `${x.name}×${(r.waves || []).reduce((s, w) => s + ((w.zombies[x.type] || {}).count || 0), 0) || '?'}`).join('、');
    return [
      `${okMark} 简报：${r.level && r.level.name ? r.level.name : '本关'}｜卡槽 ${r.deck && r.deck.slots}｜起始阳光 ${n(r.startingSun)}`,
      `任务：${(r.missionHints || []).join('；') || '无文本'}`,
      `僵尸：${z || '未读到'}`,
      `可用卡 ${(r.cards || []).length} 张｜波次 ${(r.waves || []).length}`,
    ].join('\n');
  }

  if (name === 'pvz_state') {
    if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    const tasks = (r.tasks || []).map((t) => `${t.tip}${t.hint ? `（${t.hint}）` : ''}`).join('；');
    const lanes = (r.lanes || []).map((l) => `L${l.lane + 1} 僵尸${l.zombies} 输出${l.shooters} dps${l.dps}${l.mower ? '' : ' 无车'}`).join('｜');
    return [
      `${okMark} ${stateLine(r)}`,
      tasks ? `任务：${tasks}` : null,
      lanes ? `行：${lanes}` : null,
      r.plan ? '计划：已记录' : null,
    ].filter(Boolean).join('\n');
  }

  if (name === 'pvz_choose_deck') {
    if (r.ok) return `${okMark} 选卡完成 ${(r.actualDeck || []).length}/${r.slots}：${(r.actualDeck || []).join('、')}`;
    const bits = [`${okMark} ${r.code || ''} ${r.reason || ''}`.trim()];
    if (r.actualDeck) bits.push(`实际卡组 ${r.actualDeck.length}/${r.slots || '?'}：${r.actualDeck.join('、')}`);
    if (r.missing && r.missing.length) bits.push(`未选中：${r.missing.join('、')}`);
    if (r.skipped && r.skipped.length) bits.push(`跳过：${r.skipped.map((x) => `${x.type}(${x.reason})`).join('、')}`);
    return bits.join('\n');
  }

  if (name === 'pvz_act') {
    if (r.ok === false && !Array.isArray(r.results)) return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
    return (r.results || []).map((x) => {
      const actType = x.action || x.type;
      const act = ACTION_CN[actType] || actType;
      if (x.pending) return `⏳ ${x.detail || `${act} 已发起，等待落地`}`;
      if (x.ok && x.detail) return `✅ ${x.detail}`;
      if (x.ok) return `✅ ${act}${actType === 'plant' || actType === 'replace' ? ` ${x.plant || x.type}` : ''}`;
      return `❌ ${act} ${x.code || ''} ${x.reason || ''}${x.retryAfter != null ? `（${x.retryAfter}s 后重试）` : ''}`.trim();
    }).join('\n');
  }

  if (name === 'pvz_wait_until') {
    if (r.ok && r.satisfied) return `✅ 条件满足：${r.condition}（${r.elapsed}s）`;
    if (r.code === 'TIMEOUT') return `⌛ 等待超时：${r.condition}（${r.elapsed}s）`;
    return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_set_plan') {
    return r.ok ? `✅ 计划已保存${r.savedAt ? `（${r.savedAt}）` : ''}` : `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_knowledge') {
    if (r.ok && r.entry) {
      const e = r.entry;
      const bits = [`${e.name || e.type}`];
      if (e.cost != null) bits.push(`${e.cost} 阳光`);
      if (e.hp != null) bits.push(`${e.hp} 血`);
      if (e.ehp != null) bits.push(`${e.ehp} EHP`);
      if (e.attack && e.attack.dps) bits.push(`${e.attack.dps} DPS`);
      if (e.brief) bits.push(e.brief);
      return bits.join('｜');
    }
    if (r.matches) return r.matches.length ? `找到 ${r.matches.length} 条：${r.matches.map((x) => `${x.name}(${x.type})`).join('、')}` : '没有匹配';
    return `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (name === 'pvz_health') {
    return r.ok ? `✅ 模组 v${r.version}｜phase ${r.phase}｜工具 ${(r.tools || []).length} 个` : `❌ ${r.code || ''} ${r.reason || ''}`.trim();
  }

  if (r.ok === false) return `❌ ${r.code || ''} ${r.reason || ''}${codeText(r) ? ` ${codeText(r)}` : ''}`.trim();
  const bits = [];
  for (const k of ['count', 'collected', 'paused', 'lane', 'column', 'type', 'detail', 'started', 'phase']) {
    if (r[k] != null) bits.push(`${k}=${typeof r[k] === 'object' ? '[对象]' : r[k]}`);
  }
  return `${okMark} ${bits.join(' ') || '完成'}`;
}

function eventText(e) {
  if (!e) return '?';
  const names = {
    wave_started: '波次开始', lane_threat: '行威胁', mower_lost: '小推车丢失',
    plant_lost: '植物损失', card_ready: '卡片就绪', zombie_new: '新僵尸',
    task_urgent: '任务紧急', task_done: '任务完成', task_failed: '任务失败',
    level_won: '关卡胜利', level_lost: '关卡失败',
  };
  const head = names[e.t] || e.t;
  const bits = [];
  if (e.lane != null) bits.push(`第${e.lane + 1}行`);
  if (e.wave != null) bits.push(`第${e.wave}波`);
  if (e.detail) bits.push(e.detail);
  return `${head}${bits.length ? '：' + bits.join(' ') : ''}`;
}

/** 计划的人话呈现（UI 用），不解析成执行指令。 */
function formatPlan(plan) {
  if (!plan || typeof plan !== 'object') return '暂无计划';
  const lines = [];
  const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (plan.style) lines.push(`风格：${asText(plan.style)}`);
  if (Array.isArray(plan.deck) && plan.deck.length) lines.push(`卡组：${plan.deck.join('、')}`);
  else if (plan.deck && typeof plan.deck === 'object') {
    const deck = Object.entries(plan.deck).map(([k, v]) => `${k}（${asText(v)}）`);
    if (deck.length) lines.push(`卡组：${deck.join('、')}`);
  }
  if (plan.layout && typeof plan.layout === 'object') {
    lines.push('布置：');
    for (const [k, v] of Object.entries(plan.layout)) lines.push(`· ${k}：${asText(v)}`);
  }
  if (Array.isArray(plan.lanes)) {
    for (const l of plan.lanes) {
      if (typeof l === 'string') lines.push(`· ${l}`);
      else if (l && typeof l === 'object') lines.push(`· L${(l.lane != null ? Number(l.lane) + 1 : '?')} ${l.role || ''} ${l.plan || l.notes || ''}`.trim());
    }
  }
  if (plan.thresholds && typeof plan.thresholds === 'object') {
    lines.push('阈值：' + Object.entries(plan.thresholds).map(([k, v]) => `${k}=${asText(v)}`).join(' / '));
  }
  if (plan.contingency) {
    if (typeof plan.contingency === 'string') lines.push(`应急：${plan.contingency}`);
    else if (typeof plan.contingency === 'object') {
      lines.push('应急：');
      for (const [k, v] of Object.entries(plan.contingency)) lines.push(`· ${k}：${asText(v)}`);
    }
  }
  if (!lines.length) return '计划已记录（自定义字段）';
  return lines.join('\n');
}


// ── tools/router.js ──
/**
 * router：工具名 → handler。
 *
 * MCP 和游戏内 LLM 客户端调用同一个 router；bridge 可以是异步的（CDP）也可以是同步的（游戏内）。
 * 这里只做参数校验、动作编排、等待和错误归一化，不做任何策略决定。
 */

const routerSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTION_TYPE_SET = new Set(['plant', 'replace', 'shovel', 'plant_food', 'move_cart', 'resume', 'wait', 'restart', 'dismiss_objective', 'collect']);

/**
 * 对比两次 pvz_state，算出"自上次读取以来"的变化。
 *
 * 存在的理由：模型每轮只看到当前快照，历史快照会被 compactOldToolResults 压掉，
 * 所以它无法自己 diff 出"哪株被吃了"。这里由工具直接算好，字段很小，不会被压缩。
 */
function diffSnapshot(prev, cur) {
  if (!prev || !cur || !prev.ok || !cur.ok) return null;
  // 跨 phase / 跨关卡不报 diff，避免把上一局的数据算进来
  if (prev.phase !== cur.phase) return null;
  const pk = (p) => `${p.lane}:${p.column}`;
  const prevPlants = new Map((prev.plants || []).map((p) => [pk(p), p]));
  const curPlants = new Map((cur.plants || []).map((p) => [pk(p), p]));

  const plantsLost = [];
  const plantsAdded = [];
  for (const [k, p] of prevPlants) {
    if (!curPlants.has(k)) plantsLost.push({ lane: p.lane, column: p.column, type: p.type });
  }
  for (const [k, p] of curPlants) {
    if (!prevPlants.has(k)) plantsAdded.push({ lane: p.lane, column: p.column, type: p.type });
  }

  const mowerLost = [];
  for (const lane of cur.lanes || []) {
    const before = (prev.lanes || []).find((l) => l.lane === lane.lane);
    if (before && before.mower !== false && lane.mower === false) mowerLost.push(lane.lane);
  }

  const prevWave = (prev.level && prev.level.wave) || 0;
  const curWave = (cur.level && cur.level.wave) || 0;
  const sunDelta = prev.sun == null || cur.sun == null ? null : cur.sun - prev.sun;
  const zombieDelta = (cur.zombies || []).length - (prev.zombies || []).length;

  const none = !plantsLost.length && !plantsAdded.length && !mowerLost.length
    && curWave === prevWave && !zombieDelta && !sunDelta;

  return {
    none,
    plantsLost,
    plantsAdded,
    mowerLost,
    waveDelta: curWave - prevWave,
    sunDelta,
    zombieDelta,
    plantsLeft: cur.limits ? cur.limits.plantsLeft : null,
  };
}

function createToolRouter({ bridge, version = '0.1.14', sleep = routerSleep }) {
  if (!bridge) throw new Error('createToolRouter 需要 bridge');

  // 上一次 pvz_state 的原始快照，只用于算 changesSinceLast。
  // 仅由 pvz_state 更新，UI 直接调 bridge.snapshot() 不会污染它。
  let lastSeenState = null;

  async function call(name, args = {}) {
    try {
      switch (name) {
        case 'pvz_briefing': return await bridge.briefing();
        case 'pvz_knowledge': return await bridge.knowledge(args || {});
        case 'pvz_state': {
          const s = await bridge.snapshot();
          if (s && s.ok) {
            const changes = diffSnapshot(lastSeenState, s);
            if (changes) s.changesSinceLast = changes;
            lastSeenState = s;
          }
          return s;
        }
        case 'pvz_events': {
          const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 200));
          const list = typeof bridge.pollEvents === 'function' ? await bridge.pollEvents(limit) : await bridge.events(limit);
          return Array.isArray(list) ? list : [];
        }
        case 'pvz_set_plan': {
          if (!args || !('plan' in args)) return normalizeError('BAD_PLAN', {}, '需要 plan 字段');
          return await bridge.setPlan(args.plan);
        }
        case 'pvz_choose_deck': return await chooseDeck(args);
        case 'pvz_start_level': return await startLevel(args);
        case 'pvz_act': return await act(args);
        case 'pvz_wait_until': return await waitUntil(args);
        case 'pvz_collect': {
          const r = await bridge.collect();
          return r && r.ok === false ? r : { ok: true, ...r };
        }
        case 'pvz_plant_food': {
          if (!isPos(args)) return normalizeError('BAD_POSITION');
          const r = await bridge.act({ type: 'plant_food', lane: Number(args.lane), column: Number(args.column) });
          return r;
        }
        case 'pvz_move_cart': {
          if (!args || !Number.isFinite(Number(args.cart))) return normalizeError('NO_CART', {}, '需要 cart');
          const dir = String(args.direction || '').toLowerCase();
          if (dir !== 'up' && dir !== 'down') return normalizeError('CART_BLOCKED', { direction: dir }, 'direction 只能是 up/down');
          return await bridge.moveCart(Number(args.cart), dir);
        }
        case 'pvz_resume': return await bridge.resume();
        case 'pvz_restart': {
          if (typeof bridge.restartLevel !== 'function') return normalizeError('RESTART_UNSUPPORTED', {}, '当前 bridge 不支持重开');
          return await bridge.restartLevel();
        }
        case 'pvz_dismiss_objective': {
          const r = await bridge.dismissObjective();
          return r;
        }
        case 'pvz_health': {
          const h = await bridge.health();
          return {
            ...h,
            serverVersion: version,
            namespace: 'pvz-llm-agent',
            tools: TOOL_NAMES,
            expectedTools: TOOL_NAMES.length,
            conditions: CONDITION_HELP,
          };
        }
        default:
          return normalizeError('UNKNOWN_TOOL', { tool: name }, `没有这个工具：${name}`);
      }
    } catch (e) {
      return normalizeError(e && e.code ? e.code : 'BRIDGE_ERROR', { tool: name, ...(e && e.extra ? e.extra : {}) }, String(e && e.message || e));
    }
  }

  function isPos(a) {
    return a && Number.isFinite(Number(a.lane)) && Number.isFinite(Number(a.column));
  }

  // 同一张卡批量落点：按真实冷却 retryAfter 自动等，单次最多阻塞 25 秒，
  // 不把 COOLDOWN 直接甩给模型（同一张卡连种 5 行本来就该等冷却）。
  async function plantCells(action, cards) {
    const cells = action.cells.slice(0, 8);
    const deadline = Date.now() + 25000;
    const perCell = [];
    for (const cell of cells) {
      const lane = Number(cell && cell.lane);
      const column = Number(cell && cell.column);
      if (!Number.isFinite(lane) || !Number.isFinite(column)) {
        perCell.push({ cell, ...normalizeError('BAD_POSITION') });
        continue;
      }
      const one = { ...action, lane, column };
      delete one.cells;
      let r = await bridge.act(one);
      let retries = 0;
      while (r && r.ok === false && r.code === 'COOLDOWN' && retries < 3 && Date.now() < deadline) {
        const waitMs = Math.min(8000, Math.max(200, (Number(r.retryAfter) || 1) * 1000));
        await sleep(waitMs);
        retries += 1;
        r = await bridge.act(one);
      }
      perCell.push({ lane, column, retries, ...(r || normalizeError('ACT_THREW', {}, '没有返回')) });
      if (r && r.ok === false && (r.code === 'SUN' || r.code === 'CARD_NOT_IN_DECK' || r.code === 'NO_CARD' || r.code === 'OCCUPIED')) {
        perCell.push({ ok: false, code: r.code, reason: `后面的格子没再尝试（${r.code}）`, retryable: r.retryable });
        break;
      }
      if (Date.now() >= deadline) {
        perCell.push({ ok: false, code: 'TIMEOUT', reason: '批量种植超过 25 秒，剩下的格子没种', retryable: true });
        break;
      }
    }
    const okCount = perCell.filter((c) => c.ok).length;
    return {
      ok: perCell.length > 0 && perCell.every((c) => c.ok),
      cells: perCell,
      okCount,
      failCount: perCell.length - okCount,
      planted: perCell.filter((c) => c.ok).map((c) => ({ lane: c.lane, column: c.column })),
    };
  }

  async function chooseDeck(args) {
    const cards = args && Array.isArray(args.cards) ? args.cards.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!cards.length) return normalizeError('BAD_DECK', { cards: [] }, 'cards 不能为空');
    const replace = args && args.replace !== false;
    const r = await bridge.chooseDeck(cards, replace);
    if (!r || typeof r !== 'object') return normalizeError('BAD_RESPONSE', {}, '选卡没有返回结果');
    return r;
  }

  async function startLevel(args) {
    const dismiss = !args || args.dismiss_objective !== false;
    const timeout = Math.max(1, Math.min(20, Number(args && args.timeout) || 8));
    const before = await bridge.snapshot();
    if (before && before.ok && before.phase === 'running') {
      return { ok: true, started: true, phase: before.phase, elapsed: 0, detail: '已经在战斗中' };
    }
    if (dismiss && before && before.ok && before.objective && before.objective.active) {
      const d = await bridge.dismissObjective();
      if (d && d.ok === false && d.code !== 'NO_OBJECTIVE') return d;
      await sleep(350);
    }
    const r = await bridge.startLevel();
    if (r && r.ok === false && !r.started) return r;
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt <= timeout * 1000) {
      last = await bridge.snapshot();
      if (last && last.ok && last.phase === 'running') {
        return { ok: true, started: true, phase: last.phase, elapsed: Math.round((Date.now() - startedAt) / 100) / 10, detail: (r && r.detail) || '已开局' };
      }
      if (last && last.ok && (last.phase === 'won' || last.phase === 'lost')) {
        return { ok: true, started: true, phase: last.phase, elapsed: Math.round((Date.now() - startedAt) / 100) / 10, detail: '战斗直接结束' };
      }
      await sleep(300);
    }
    return normalizeError('START_FAILED', {
      started: !!(r && r.started),
      phase: last && last.phase,
      waited: timeout,
      detail: r && r.detail,
      hint: '调用 pvz_state 看 phase；如果还在 preparing，检查卡组是否满、选卡界面是否就绪。',
    }, `开局后 ${timeout}s 内 phase 没有进入 running`);
  }

  async function act(args) {
    const list = args && Array.isArray(args.actions) ? args.actions.slice(0, 6) : [];
    if (!list.length) return normalizeError('NO_ACTIONS');
    let state = null;
    try { state = await bridge.snapshot(); } catch { state = null; }
    const cards = (state && state.cards) || [];
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] || {};
      const type = String(raw.type || '');
      if (!ACTION_TYPE_SET.has(type)) {
        results.push({ index: i, action: type, type, ...normalizeError('UNKNOWN_ACTION', { type }) });
        continue;
      }
      if (type === 'wait') {
        const sec = Math.max(0, Math.min(15, Number(raw.seconds) || 0));
        if (sec > 0) await sleep(sec * 1000);
        results.push({ index: i, action: type, type, ok: true, seconds: sec, detail: sec ? `等待 ${sec}s` : '等待' });
        continue;
      }
      const a = { ...raw, type };
      if (type === 'plant' || type === 'replace') {
        if (!Number.isFinite(Number(a.card)) && !a.plant) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_ACTION', {}, '需要 card（下标）或 plant（codename）') });
          continue;
        }
        if (!Number.isFinite(Number(a.card)) && a.plant) {
          const hit = cards.find((c) => String(c.type) === String(a.plant));
          if (!hit) {
            results.push({ index: i, action: type, type, ...normalizeError('CARD_NOT_IN_DECK', { plant: a.plant, deck: cards.map((c) => c.type) }) });
            continue;
          }
          a.card = hit.index;
        }
        // cells：同一张卡按冷却排队种到多个格子。冷却期用 retryAfter 等，不把 COOLDOWN 直接甩给模型。
        if (Array.isArray(a.cells) && a.cells.length) {
          results.push({ index: i, action: type, type, ...(await plantCells(a, cards)) });
          continue;
        }
        if (!isPos(a)) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_POSITION') });
          continue;
        }
        a.lane = Number(a.lane);
        a.column = Number(a.column);
      }
      if (type === 'shovel' || type === 'plant_food') {
        if (!isPos(a)) {
          results.push({ index: i, action: type, type, ...normalizeError('BAD_POSITION') });
          continue;
        }
        a.lane = Number(a.lane);
        a.column = Number(a.column);
      }
      if (type === 'move_cart') {
        if (!Number.isFinite(Number(a.cart))) {
          results.push({ index: i, action: type, type, ...normalizeError('NO_CART', {}, '需要 cart') });
          continue;
        }
        a.cart = Number(a.cart);
      }
      let r;
      try {
        r = await bridge.act(a);
      } catch (e) {
        r = normalizeError('ACT_THREW', {}, String(e && e.message || e));
      }
      // 同一张卡在一批动作里会出现两次：等它自己的冷却，而不是把 COOLDOWN 甩给模型。
      // 单次最多等 6 秒、重试 2 次；整批最多再花 20 秒，避免一次调用把人晾住。
      if (r && r.ok === false && r.code === 'COOLDOWN') {
        const budget = Date.now() + 20000;
        for (let retry = 0; retry < 2 && r && r.code === 'COOLDOWN' && Date.now() < budget; retry++) {
          const waitMs = Math.min(6000, Math.max(200, (Number(r.retryAfter) || 1) * 1000));
          await sleep(waitMs);
          try { r = await bridge.act(a); } catch (e) { r = normalizeError('ACT_THREW', {}, String(e && e.message || e)); }
        }
      }
      results.push({ index: i, action: type, ...(r || normalizeError('ACT_THREW', {}, '没有返回')) });
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      okCount: results.filter((r) => r.ok).length,
      failCount: results.filter((r) => !r.ok).length,
    };
  }

  async function waitUntil(args) {
    const cond = String((args && args.until) || '').trim();
    const timeout = Math.max(1, Math.min(60, Number(args && args.timeout) || 15));
    if (!cond) return normalizeError('BAD_CONDITION', { help: CONDITION_HELP }, 'until 不能为空');
    const startedAt = Date.now();
    let last = null;
    let firstCheck = null;
    while (Date.now() - startedAt <= timeout * 1000) {
      try {
        last = await bridge.snapshot();
      } catch (e) {
        last = { ok: false, code: 'BRIDGE_ERROR', reason: String(e && e.message || e) };
      }
      if (last && last.ok !== false) {
        const r = checkCondition(last, cond);
        firstCheck = firstCheck || r;
        if (!r.ok) return normalizeError('BAD_CONDITION', { condition: cond, help: CONDITION_HELP }, r.reason);
        if (r.hit) {
          return {
            ok: true, satisfied: true, condition: cond,
            elapsed: Math.round((Date.now() - startedAt) / 100) / 10,
            match: r,
            state: compactState(last),
          };
        }
      }
      await sleep(250);
    }
    return normalizeError('TIMEOUT', {
      satisfied: false, condition: cond,
      elapsed: Math.round((Date.now() - startedAt) / 100) / 10,
      state: last && last.ok ? compactState(last) : null,
      check: firstCheck,
    }, `等待 ${timeout}s 后条件仍未满足`);
  }

  return { call, names: TOOL_NAMES };
}


// ── in-game/prompt.js ──
/**
 * 游戏内 LLM 的系统提示词。
 *
 * 只描述协议、坐标和工具用法；不写卡组、不写打法、不写"什么时候该种什么"。
 * 所有决策都必须由模型在读到事实后自己给出。
 */

const SYSTEM_PROMPT = `你是《植物大战僵尸2 花园无尽》的唯一决策者。你不是助手，也不是执行器：所有选卡、布阵、实时操作都由你决定。

工具只做四件事：
1. 给事实：关卡任务、世界机制、地形、波次、僵尸、卡池、图鉴、实时状态、增量事件。
2. 执行动作：选卡、开局、种植、铲除、换植、能量豆、矿车、继续、关闭任务弹窗。
3. 返回真实结果：ok / code / reason / retryAfter / 冷却 / 阳光 / 占用。
4. 记录计划：pvz_set_plan 只保存你写的计划，不执行、不修正。

硬性规则：
- 思考过程尽量用中文；工具调用参数和 codename 除外。推理原文只显示在顶部滚动框，决策日志只记录你的动作、真实结果和计划。
- 没有任何"推荐卡组"或本地打法。不要等系统给你建议；先 pvz_briefing / pvz_knowledge 查事实，再自己决定。
- 选卡用 pvz_choose_deck。工具不会自动补卡，也不会替换你指定的卡。数量不足会返回 DECK_NOT_FULL；补满后重新调用。
- 卡槽状态看 cards：cdReady（冷却好了）/ affordable（买得起）/ sunShort（还差多少阳光）；ready 只有两者都满足才是 true。
- 僵尸厚度看 zombies 的 hp / armorHp / ehp / ehpMax：ehp 可读时是「本体 + 当前护甲」，为 null 时用 ehpMax 当上界；不要只看 hp。
- 铺同一种卡到多格时用 pvz_act 的 cells，工具会按冷却自动等待重试；不要为了同一张卡连续调用 5 次。
- 想重开本关用 pvz_restart（不用先进暂停菜单）。
- 每次工具往返都有网络延迟：一轮尽量把能做的都做完（pvz_act 最多 6 个动作，铺同一种卡用 cells），不要每轮只种一株。
- 每次动作前先看 pvz_state（至少看阳光、卡槽冷却、格子占用、僵尸位置）。失败后读 code，不要对同一个格子/同一张卡反复撞同一个错误。
- 阳光、能量豆、金币会自动收；需要时也可以 pvz_collect。
- 关卡任务失败可能直接判负：把 tasks 的 tip/hint/timeLeft/urgent 当作硬约束。
- 关卡规则只看结构化字段：植物数量上限以 plantLimit / limits.plantLimit 为准，为 null 就是没有上限。objective.trusted=false 或 missions 为空时，说明这关没有下发任务文本；不要从任务原文残留、图鉴知识或"以往这类关卡"推断"最多 18 株"之类的限制。tasks 为空就按普通关卡打，不要自己加限制。
- 不要空转：需要等条件时用 pvz_wait_until（阳光/冷却/僵尸进某行/任务完成），不要连续调用同一个查询。
- 你可以在 pvz_set_plan 里写风格、卡组、每行职责、阈值、应急方案；之后用 pvz_state.plan 回看。计划只属于你，文字尽量用中文（codename 除外）。

坐标：
- lane 0-4，从上到下；column 0-8，从左（房子一侧）到右（僵尸出生点）。
- 僵尸 column 越小越靠近房子；一格一株（特殊叠加卡按图鉴说明）。

标准循环：
1. phase=objective：先 pvz_dismiss_objective，再 pvz_briefing。
2. phase=preparing：pvz_briefing（含卡池/波次/地形）→ 自己定卡组 → pvz_set_plan → pvz_choose_deck → pvz_start_level。
3. phase=running：每一轮都先 pvz_events 取增量（即使为空也要取），再 pvz_state。pvz_state.changesSinceLast 是工具替你算好的「自上次读取以来的变化」（plantsLost / plantsAdded / mowerLost / waveDelta / sunDelta / zombieDelta），它不受历史消息裁剪影响；有变化时先把这些变化纳入判断，再 pvz_act（1–6 个动作）→ 需要时 pvz_wait_until → 重复。
4. phase=won/lost：停止操作，向玩家说明结果。

失败处理：
- COOLDOWN / SUN / PAUSED 可以稍后重试；OCCUPIED / CELL_BLOCKED / CARD_NOT_AVAILABLE / BAD_DECK 不要原样重试。
- pending:true 表示动作已发起但还没落地：不要立刻重种同一格，先 pvz_state 确认。
- DECK_NOT_FULL 表示你选的卡不够槽位；工具不会替你补。自己决定补哪几张。
- TIMEOUT 不是崩溃，返回里有最后状态；据此重新判断。
- 每轮只做你真正需要的动作，避免无意义地刷状态。

思考窗会展示你的推理、工具调用、真实结果和计划。不要输出整段原始 JSON 给玩家；用简短的人话说明你的判断。`;

function initialUserMessage() {
  return [
    '开始本关。',
    '先调用 pvz_health 确认模组可用；然后按当前 phase 调用 pvz_briefing（objective 阶段先 pvz_dismiss_objective）。',
    '读完事实后，自己制定整关计划并用 pvz_set_plan 记录，再 pvz_choose_deck、pvz_start_level。',
    '进入 running 后自己循环决策，直到胜利或失败。不要等待本地建议。',
  ].join('\n');
}

function continueMessage(note) {
  const base = '继续。先调 pvz_events 取增量（即使为空也要取），再 pvz_state。先看 changesSinceLast：有 plantsLost / mowerLost / waveDelta / zombieDelta 时，先把这些变化纳入判断（例如某格植物消失、某行丢车），再按你的计划执行下一步；需要等待时用 pvz_wait_until。';
  return note ? `${base}\n补充：${note}` : base;
}

function phaseNudge(phase) {
  if (phase === 'objective') return '当前在关卡目标弹窗：调用 pvz_dismiss_objective。';
  if (phase === 'preparing') return '当前在选卡阶段：先 pvz_briefing，再自己选卡并开局。';
  if (phase === 'running') return '战斗中：读状态/事件后执行动作。';
  if (phase === 'won' || phase === 'lost') return `本关已结束（${phase}），停止操作。`;
  return '先 pvz_state 确认当前 phase，再决定下一步。';
}


// ── in-game/agent.js ──
/**
 * 游戏内 OpenAI 兼容 LLM 客户端。
 *
 * 唯一决策者是模型：这里只负责
 *   - 发 messages / tools
 *   - 执行模型返回的 tool_calls（经 router）
 *   - 把真实结果回填给模型
 *   - 把推理 / 工具 / 结果 / 计划推给思考窗
 *
 * 没有任何本地决策、卡组修正或策略队列。
 */

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeBaseUrl(base) {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/chat\/completions$/i.test(s)) return s;
  return `${s}/chat/completions`;
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { __parseError: s.slice(0, 500) }; }
}

function makeError(code, message, extra = {}) {
  const e = new Error(message || code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

const DEFAULT_LLM = Object.freeze({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

/**
 * 预置服务商。只填 baseUrl / model，不碰决策逻辑。
 * OpenCode Go 走 OpenAI 兼容的 chat/completions，DeepSeek V4.1 Flash 正在这一组里。
 */
const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '按量计费，key 形如 sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go（本地代理）',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'deepseek-v4.1-flash',
    hint: '先运行 node scripts/local-proxy.mjs。opencode.ai 的 chat 接口不带 CORS 头，浏览器不能直连，必须经本地代理。Key 在 opencode.ai/console 取。',
    models: [
      'deepseek-v4.1-flash',
      'glm-5.3-flash',
      'kimi-k2.7-code',
      'mimo-v2.6-flash',
      'qwen3.8-flash',
      'minimax-m3.1-flash',
      'longcat-2.0',
      'glm-5.2',
    ],
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    hint: '任意 OpenAI 兼容端点，手动填 Base 和模型名',
    models: [],
  },
]);

// OpenCode Go 建议带稳定的会话 ID，用于路由与 prompt 缓存；同一页面生命周期内保持不变。
let openCodeSession = '';
function getOpenCodeSession() {
  if (!openCodeSession) {
    openCodeSession = `pvzllm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return openCodeSession;
}

function createLlmAgent({ fetchImpl, router, cfg = {}, onEvent = () => {}, sleep = sleepDefault, version = '0.1.10' }) {
  const config = {
    baseUrl: DEFAULT_LLM.baseUrl,
    model: DEFAULT_LLM.model,
    apiKey: '',
    temperature: 0.3,
    stream: true,
    maxSteps: 80,
    loopDelayMs: 350,
    ...cfg,
  };
  let messages = [];
  let running = false;
  let stopRequested = false;
  let controller = null;
  let stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 };
  let lastPlan = null;
  let lastPhase = null;
  let everRunning = false;
  let lastError = null;

  const fetchAny = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  let eventHandler = onEvent;

  function emit(ev) {
    try { eventHandler(ev); } catch { /* UI must not break the agent */ }
  }

  function setEventHandler(fn) {
    eventHandler = typeof fn === 'function' ? fn : () => {};
    return { ok: true };
  }

  function setConfig(patch) {
    Object.assign(config, patch || {});
    return getConfig();
  }

  function getConfig() {
    return {
      ...config,
      apiKey: config.apiKey ? `${String(config.apiKey).slice(0, 3)}***${String(config.apiKey).slice(-2)}` : '',
      hasKey: !!config.apiKey,
    };
  }

  function ensureConfig() {
    if (!config.baseUrl) throw makeError('BAD_CONFIG', '缺少 API Base（OpenAI 兼容）');
    if (!config.model) throw makeError('BAD_CONFIG', '缺少模型名');
    if (!config.apiKey) throw makeError('BAD_CONFIG', '缺少 API Key');
    if (!fetchAny) throw makeError('BAD_CONFIG', '当前环境没有 fetch');
  }

  function headers() {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
    // OpenCode Go 要求稳定会话 ID；直连和本地代理两种形式都带上（Authorization 已触发预检，不多一次）
    const s = String(config.baseUrl || '');
    if (/opencode\.ai/i.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1/i.test(s)) {
      h['x-opencode-session'] = getOpenCodeSession();
    }
    return h;
  }

  async function testConnection() {
    ensureConfig();
    const started = Date.now();
    const url = normalizeBaseUrl(config.baseUrl);
    try {
      const res = await fetchAny(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: 'Reply with OK only.' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 8,
          stream: false,
          temperature: 0,
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, code: 'LLM_HTTP', status: res.status, reason: text.slice(0, 500), latencyMs: Date.now() - started };
      let data = null;
      try { data = JSON.parse(text); } catch { /* ignore */ }
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? (data.choices[0].message.content || '') : '';
      return { ok: true, latencyMs: Date.now() - started, model: config.model, content: String(content).slice(0, 120) };
    } catch (e) {
      return { ok: false, code: 'LLM_REQUEST_FAILED', reason: String(e && e.message || e), latencyMs: Date.now() - started };
    }
  }

  function addUsage(usage) {
    if (!usage) return;
    stats.promptTokens += Number(usage.prompt_tokens || 0);
    stats.completionTokens += Number(usage.completion_tokens || 0);
  }

  async function callModel({ stream }) {
    ensureConfig();
    const url = normalizeBaseUrl(config.baseUrl);
    const body = {
      model: config.model,
      messages,
      tools: openAiTools(),
      tool_choice: 'auto',
      temperature: Number(config.temperature) || 0,
      stream: !!stream,
    };
    controller = new AbortController();
    let res;
    try {
      res = await fetchAny(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw makeError('STOPPED', '已停止');
      throw makeError('LLM_REQUEST_FAILED', String(e && e.message || e));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeError('LLM_HTTP', `模型接口 ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
    }
    stats.requests++;

    if (stream) {
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw makeError('LLM_STREAM_UNSUPPORTED', '响应没有可读流');
      }
      const out = { content: '', reasoning: '', toolCalls: [], usage: null, finishReason: null };
      const calls = new Map();
      const handleChunk = (data) => {
        if (!data) return;
        if (data.error) throw makeError('LLM_HTTP', data.error.message || JSON.stringify(data.error));
        if (data.usage) out.usage = data.usage;
        const ch = data.choices && data.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (d.reasoning_content) {
          out.reasoning += d.reasoning_content;
          emit({ type: 'thinking', delta: d.reasoning_content, text: out.reasoning });
        } else if (d.reasoning) {
          out.reasoning += d.reasoning;
          emit({ type: 'thinking', delta: d.reasoning, text: out.reasoning });
        }
        if (d.content) {
          out.content += d.content;
          emit({ type: 'assistant_delta', delta: d.content, text: out.content });
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = Number.isFinite(tc.index) ? tc.index : 0;
            const cur = calls.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name += tc.function.name;
            if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
        if (ch.finish_reason) out.finishReason = ch.finish_reason;
      };
      await readSse(res.body, handleChunk);
      out.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
        id: c.id || `call_${i + 1}`,
        name: c.name,
        args: parseToolArgs(c.args),
        rawArgs: c.args,
      }));
      addUsage(out.usage);
      return out;
    }

    const data = await res.json().catch((e) => { throw makeError('BAD_RESPONSE', '模型返回不是 JSON：' + String(e && e.message || e)); });
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw makeError('BAD_RESPONSE', '模型返回缺少 choices[0].message');
    const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
      id: tc.id || `call_${i + 1}`,
      name: tc.function && tc.function.name,
      args: parseToolArgs(tc.function && tc.function.arguments),
      rawArgs: (tc.function && tc.function.arguments) || '',
    }));
    addUsage(data.usage);
    return {
      content: msg.content || '',
      reasoning: msg.reasoning_content || msg.reasoning || '',
      toolCalls,
      usage: data.usage || null,
      finishReason: data.choices[0].finish_reason || null,
    };
  }

  async function readSse(body, onChunk) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return;
          try { onChunk(JSON.parse(data)); } catch (e) { if (e && e.code) throw e; }
        }
      }
      const tail = buf.trim();
      if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data && data !== '[DONE]') { try { onChunk(JSON.parse(data)); } catch { /* ignore */ } }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async function callWithFallback() {
    try {
      return await callModel({ stream: !!config.stream });
    } catch (e) {
      if (stopRequested || (e && e.name === 'AbortError')) throw e;
      if (config.stream && e && e.code && e.code !== 'STOPPED' && !(e.status >= 400 && e.status < 500)) {
        emit({ type: 'log', text: '流式失败，改用非流式重试：' + (e.message || e.code) });
        return await callModel({ stream: false });
      }
      throw e;
    }
  }

  function trimMessages() {
    const MAX = 40;
    if (messages.length > MAX) {
      const system = messages[0];
      let rest = messages.slice(1);
      // 从后往前保留，但不要从 tool 消息开始丢出孤立 tool 结果
      rest = rest.slice(rest.length - (MAX - 1));
      while (rest.length && rest[0].role === 'tool') rest.shift();
      messages = [system, ...rest];
    }
    compactOldToolResults();
  }

  function compactOldToolResults() {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    // 最近 4 条工具结果保留原文；更早的大结果压成一句状态摘要。
    // 每份 pvz_state 约 9KB，留 8 份会让单轮 prompt 冲到 30k+ token，模型响应直接慢到 20-30 秒。
    for (let i = 0; i < toolMsgs.length - 4; i++) {
      const m = toolMsgs[i];
      if (!m.content || m.content.length <= 800) continue;
      let note = '旧工具结果已省略；需要时重新调用 pvz_state / pvz_knowledge';
      try {
        const o = JSON.parse(m.content);
        if (o && o.phase) {
          note = `旧状态已省略：phase=${o.phase} 阳光=${o.sun} 第${(o.level && o.level.wave) || '?'}波 植物${(o.plants || []).length} 僵尸${(o.zombies || []).length}`;
        } else if (o && o.ok === false && o.code) {
          note = `旧失败结果：${o.code} ${String(o.reason || '').slice(0, 60)}`;
        }
      } catch { /* 非 JSON 结果就只留一句 */ }
      m.content = JSON.stringify({ ok: true, omitted: true, note });
    }
  }

  function notePhase(phase) {
    if (!phase) return;
    lastPhase = phase;
    if (phase === 'running') everRunning = true;
    // 关卡结束：胜负，或真正打过 running 后回到主菜单/世界地图。
    // 不能只靠 won/lost —— 有的关卡先回地图再结算，AI 会一直空转调工具。
    const ended = phase === 'won' || phase === 'lost'
      || (everRunning && (phase === 'menu' || phase === 'worldmap'));
    if (ended && !stopRequested) {
      emit({ type: 'game_over', phase });
      stopRequested = true;
    }
  }

  async function executeToolCall(tc, index) {
    if (!tc.name) {
      const bad = { ok: false, code: 'BAD_TOOL_ARGS', reason: '模型返回了空的工具名' };
      emit({ type: 'tool_result', name: '(空)', result: bad });
      messages.push({ role: 'tool', tool_call_id: tc.id || `call_${index + 1}`, content: JSON.stringify(bad) });
      return bad;
    }
    emit({ type: 'tool_call', name: tc.name, args: tc.args, id: tc.id });
    stats.toolCalls++;
    let result;
    if (tc.args && tc.args.__parseError) {
      result = { ok: false, code: 'BAD_TOOL_ARGS', reason: '工具参数不是合法 JSON', raw: tc.args.__parseError };
    } else {
      try {
        result = await router.call(tc.name, tc.args || {});
      } catch (e) {
        result = { ok: false, code: 'TOOL_FAILED', reason: String(e && e.message || e) };
      }
    }
    emit({ type: 'tool_result', name: tc.name, result, ok: !(result && result.ok === false) });
    if (tc.name === 'pvz_set_plan' && result && result.ok) {
      lastPlan = result.plan;
      emit({ type: 'plan', plan: result.plan, savedAt: result.savedAt });
    }
    if (result && result.plan && tc.name === 'pvz_state') {
      lastPlan = result.plan;
      emit({ type: 'plan', plan: result.plan, savedAt: result.planSavedAt });
    }
    if (tc.name === 'pvz_state' && result && result.ok) {
      emit({ type: 'state', state: result });
      notePhase(result.phase);
    }
    if (tc.name === 'pvz_start_level' && result && result.phase) {
      notePhase(result.phase);
      emit({ type: 'state_phase', phase: result.phase });
    }
    if (result && result.phase) {
      notePhase(result.phase);
    }
    messages.push({
      role: 'tool',
      tool_call_id: tc.id || `call_${index + 1}`,
      name: tc.name,
      content: JSON.stringify(result),
    });
    return result;
  }

  async function runLoop() {
    let steps = 0;
    let idleNudges = 0;
    lastError = null;
    emit({ type: 'run_start', version, model: config.model });
    while (running && !stopRequested) {
      steps++;
      if (steps > Number(config.maxSteps || 80)) {
        emit({ type: 'error', code: 'STEP_LIMIT', reason: `连续 ${steps - 1} 步没有结束；已停止（不会本地接管）` });
        break;
      }
      let reply;
      try {
        emit({ type: 'request', step: steps, messageCount: messages.length });
        reply = await callWithFallback();
      } catch (e) {
        if (e && (e.code === 'STOPPED' || e.name === 'AbortError')) break;
        lastError = e;
        emit({ type: 'error', code: e.code || 'LLM_FAILED', reason: e.message || String(e) });
        break;
      }
      if (!running || stopRequested) break;

      if (reply.reasoning) emit({ type: 'thinking_final', text: reply.reasoning });
      if (reply.content) emit({ type: 'assistant', text: reply.content });

      if (reply.toolCalls && reply.toolCalls.length) {
        idleNudges = 0;
        messages.push({
          role: 'assistant',
          content: reply.content || '',
          tool_calls: reply.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.rawArgs === 'string' ? tc.rawArgs : JSON.stringify(tc.args || {}) },
          })),
        });
        for (let i = 0; i < reply.toolCalls.length; i++) {
          if (!running || stopRequested) break;
          await executeToolCall(reply.toolCalls[i], i);
        }
        trimMessages();
        await sleep(Number(config.loopDelayMs) || 0);
        continue;
      }

      // 模型没调用工具：最多提醒 3 次；再不行就停，不本地接管。
      messages.push({ role: 'assistant', content: reply.content || '' });
      idleNudges++;
      if (idleNudges >= 3) {
        emit({
          type: 'error',
          code: 'NO_TOOL_CALL',
          reason: '模型连续 3 次没有调用任何工具；按需求停住，不启动本地决策',
        });
        break;
      }
      messages.push({ role: 'user', content: continueMessage(phaseNudge(lastPhase || 'unknown')) });
      await sleep(700);
    }
    running = false;
    emit({
      type: 'run_end',
      phase: lastPhase,
      stats: { ...stats },
      plan: lastPlan,
      error: lastError ? { code: lastError.code, reason: lastError.message } : null,
    });
  }

  async function start(instruction) {
    if (running) return { ok: false, code: 'ALREADY_RUNNING', reason: '已经在运行' };
    try { ensureConfig(); } catch (e) {
      emit({ type: 'error', code: e.code || 'BAD_CONFIG', reason: e.message });
      return { ok: false, code: e.code || 'BAD_CONFIG', reason: e.message };
    }
    running = true;
    stopRequested = false;
    stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 };
    lastPhase = null;
    everRunning = false;
    lastError = null;
    controller = null;
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: instruction ? `${initialUserMessage()}\n玩家补充：${instruction}` : initialUserMessage() },
    ];
    const done = runLoop().catch((e) => {
      lastError = e;
      emit({ type: 'error', code: e.code || 'AGENT_FAILED', reason: String(e && e.message || e) });
      running = false;
    });
    return { ok: true, done };
  }

  function stop(reason) {
    if (!running) return { ok: true, running: false };
    stopRequested = true;
    running = false;
    try { if (controller) controller.abort(); } catch { /* ignore */ }
    emit({ type: 'stopped', reason: reason || '手动停止' });
    return { ok: true, running: false };
  }

  function sendInstruction(text) {
    const s = String(text || '').trim();
    if (!s) return { ok: false, code: 'EMPTY', reason: '指令为空' };
    if (!running) return start(s);
    messages.push({ role: 'user', content: `玩家指示：${s}\n按指示调整，但不要违反关卡事实和工具返回。` });
    emit({ type: 'user', text: s });
    return { ok: true, running: true };
  }

  return {
    start, stop, sendInstruction, testConnection,
    setConfig, getConfig, setEventHandler,
    isRunning: () => running,
    getMessages: () => messages.slice(),
    getStats: () => ({ ...stats }),
    getPlan: () => lastPlan,
    getPhase: () => lastPhase,
    version,
  };
}


// ── in-game/ui.js ──
/**
 * 游戏内浮窗 + 思考窗。
 *
 * 只展示：推理、工具调用、真实结果、计划、状态摘要、失败原因。
 * 不展示：本地卡池建议、卡组修正、策略队列、整段原始 JSON。
 *
 * 视觉方向：PvZ 深绿工具面板 + 暖阳光强调色；推理和决策日志分开，
 * 思考窗只保留一个滚动推理区，决策日志只记录动作/结果/计划。
 */

const CFG_KEY = 'pvzllm.ui.cfg.v1';
const GEOM_KEY = 'pvzllm.ui.geom.v2';
const CSS_ID = 'pvzllm-style';
const PANEL_ID = 'pvzllm-panel';
const THOUGHT_ID = 'pvzllm-thought';
const DEFAULT_BASE_URL = DEFAULT_LLM.baseUrl;
const DEFAULT_MODEL = DEFAULT_LLM.model;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phaseCN = { menu: '菜单', worldmap: '地图', objective: '任务说明', preparing: '准备', running: '战斗中', won: '已胜利', lost: '已失败', other: '其他' };

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function loadCfg() {
  try {
    const raw = (window.localStorage && window.localStorage.getItem(CFG_KEY)) || '';
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCfg(cfg) {
  try {
    if (window.localStorage) window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch { /* ignore */ }
}

function loadGeom() {
  try {
    const raw = (window.localStorage && window.localStorage.getItem(GEOM_KEY)) || '';
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveGeom(geom) {
  try {
    if (window.localStorage) window.localStorage.setItem(GEOM_KEY, JSON.stringify(geom || {}));
  } catch { /* ignore */ }
}

function cspInfo() {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const doc = A.document;
  const metas = doc ? [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.getAttribute('http-equiv') || '')) : [];
  const policies = metas.map((m) => m.getAttribute('content') || '').filter(Boolean);
  return {
    metaCount: metas.length,
    policies,
    hasTauri: !!(A.__TAURI__ || A.__TAURI_INTERNALS__),
    origin: A.location ? A.location.origin : null,
    note: metas.length
      ? '检测到 meta CSP。删除 meta 标签不保证解除已生效的策略；可靠方案是用 PvZAI_Launcher.exe 启动。'
      : '未检测到 meta CSP。如果是 WebView2 响应头 CSP，页面脚本无法修改；可靠方案是用 PvZAI_Launcher.exe 启动。',
  };
}

const CSS = `
#${PANEL_ID},#${THOUGHT_ID} {
  --bg:rgba(13,20,15,.96);--bg2:rgba(23,36,26,.98);--line:rgba(151,196,160,.18);--line2:rgba(151,196,160,.3);
  --text:#eaf5ea;--muted:#adc7b2;--dim:#79957f;--green:#93d49e;--sun:#f2c964;--sun2:#d9a93f;
  --danger:#ff9388;--pending:#f4c95d;--shadow:0 18px 50px rgba(0,0,0,.48);
  box-sizing:border-box;color:var(--text);text-align:left;
  font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
}
:is(#${PANEL_ID},#${THOUGHT_ID}) * {box-sizing:border-box}
:is(#${PANEL_ID},#${THOUGHT_ID}) button {font-family:inherit}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar {width:6px;height:6px}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar-thumb {background:rgba(151,196,160,.22);border-radius:99px}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar-track {background:transparent}

#${PANEL_ID} {position:fixed;right:16px;top:64px;z-index:2147483000;width:340px;min-width:260px;min-height:120px;background:linear-gradient(180deg,rgba(25,40,28,.98),rgba(11,18,13,.98));border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(12px)}
#${PANEL_ID}.pl-min {width:50px !important;height:50px !important;min-width:50px;min-height:50px;border-radius:50%;box-shadow:0 10px 26px rgba(0,0,0,.55)}
#${PANEL_ID}.pl-min .p-body,#${PANEL_ID}.pl-min .pl-resize {display:none}
#${PANEL_ID}.pl-min .p-head {height:50px;padding:0;justify-content:center;border-bottom:0;background:linear-gradient(180deg,rgba(48,92,58,.72),rgba(18,30,21,.5));cursor:pointer}
#${PANEL_ID}.pl-min .p-brand,#${PANEL_ID}.pl-min .p-head-actions {display:none}
#${PANEL_ID}.pl-min .p-mini {display:flex}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {display:flex;align-items:center;gap:8px;padding:0 12px;height:46px;background:linear-gradient(180deg,rgba(45,88,55,.55),rgba(18,30,21,.2));border-bottom:1px solid var(--line);cursor:move;user-select:none;touch-action:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {height:44px;padding:0 10px 0 12px;background:linear-gradient(180deg,rgba(44,83,54,.42),rgba(17,28,20,.2))}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-brand {display:flex;align-items:center;gap:9px;min-width:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mini {display:none;align-items:center;gap:4px;font-size:10.5px;font-weight:700;color:var(--sun);letter-spacing:.04em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mini b {font-weight:700}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot {width:6px;height:6px;border-radius:50%;background:var(--dim);box-shadow:0 0 0 2px rgba(151,196,160,.12)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.on {background:var(--green)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.err {background:var(--danger)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.pending {background:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mark {width:10px;height:10px;flex:none;border-radius:50%;background:var(--sun);box-shadow:0 0 0 3px rgba(242,201,100,.14),0 0 14px rgba(242,201,100,.35)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-title {font-size:12.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-sub {font-size:9.5px;color:var(--dim);margin-top:1px;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head-actions,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-actions {display:flex;align-items:center;gap:3px;margin-left:auto;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn {width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);font-size:12px;line-height:1;display:grid;place-items:center;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:hover {background:rgba(255,255,255,.07);border-color:var(--line);color:var(--text)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:focus-visible {outline:2px solid var(--sun);outline-offset:1px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-body {padding:11px 12px 12px;display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-status {display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.025);font-size:11px;color:var(--muted);min-height:29px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot {width:7px;height:7px;flex:none;border-radius:50%;background:var(--dim);box-shadow:0 0 0 3px rgba(151,196,160,.1)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.on {background:var(--green);box-shadow:0 0 0 3px rgba(147,212,158,.13)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.err {background:var(--danger);box-shadow:0 0 0 3px rgba(255,147,136,.13)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.pending {background:var(--pending);box-shadow:0 0 0 3px rgba(244,201,93,.13)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field {display:flex;flex-direction:column;gap:4px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-label {display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px;color:var(--dim);letter-spacing:.04em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-label em {font-style:normal;color:#66806d;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input {width:100%;height:31px;padding:0 9px;background:rgba(8,15,10,.72);border:1px solid var(--line);border-radius:7px;color:var(--text);font:11.5px/1.4 inherit;outline:none;transition:border-color .12s,background .12s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input::placeholder {color:#5e7764}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input:hover {border-color:var(--line2)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input:focus {border-color:rgba(242,201,100,.65);background:rgba(8,15,10,.94);box-shadow:0 0 0 3px rgba(242,201,100,.08)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select {width:100%;height:31px;padding:0 26px 0 9px;background:rgba(8,15,10,.72);border:1px solid var(--line);border-radius:7px;color:var(--text);font:11.5px/1.4 inherit;outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,#8aa792 50%),linear-gradient(135deg,#8aa792 50%,transparent 50%);background-position:calc(100% - 14px) 13px,calc(100% - 10px) 13px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select:hover {border-color:var(--line2)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select:focus {border-color:rgba(242,201,100,.65);box-shadow:0 0 0 3px rgba(242,201,100,.08)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-flags {display:flex;align-items:center;gap:14px;padding:1px 0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .check {display:flex;align-items:center;gap:5px;color:var(--muted);font-size:10.5px;cursor:pointer;user-select:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .check input {width:12px;height:12px;margin:0;accent-color:var(--sun)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-note {font-size:9.5px;color:var(--dim);line-height:1.5}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp {display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--dim);cursor:help;line-height:1.4}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp::before {content:'';width:5px;height:5px;flex:none;border-radius:50%;background:#6d8974}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn {color:#c8b47b}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn::before {background:var(--pending)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-actions {display:grid;grid-template-columns:1fr 1.45fr 1fr;gap:6px;margin-top:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn {height:33px;padding:0 8px;border:1px solid var(--line2);border-radius:8px;background:transparent;color:var(--text);font-size:11.5px;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s,filter .12s,transform .08s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:hover {background:rgba(255,255,255,.06)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:focus-visible {outline:2px solid var(--sun);outline-offset:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary {background:linear-gradient(180deg,var(--sun),var(--sun2));border-color:rgba(0,0,0,.16);color:#1b2417;box-shadow:0 4px 16px rgba(242,201,100,.16)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary:hover {filter:brightness(1.06)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.ghost {color:var(--muted)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.danger {color:var(--danger);border-color:rgba(255,147,136,.32)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.danger:hover {background:rgba(255,147,136,.08)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-foot {text-align:center;font-size:9px;color:var(--dim);letter-spacing:.04em;margin-top:1px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resize {position:absolute;right:0;bottom:0;width:17px;height:17px;cursor:nwse-resize;z-index:6;background:linear-gradient(135deg,transparent 42%,rgba(242,201,100,.38) 43%,rgba(242,201,100,.38) 52%,transparent 53%);opacity:.8;touch-action:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resize:hover {opacity:1}
:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resizing {user-select:none}

#${THOUGHT_ID} {position:fixed;left:14px;bottom:64px;z-index:2147482999;width:min(470px,46vw);height:min(560px,68vh);min-width:300px;min-height:260px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);background:linear-gradient(180deg,rgba(20,33,23,.98),rgba(10,17,12,.98));border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(12px)}
#${THOUGHT_ID}.pl-hidden {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-brand {display:flex;align-items:center;gap:7px;min-width:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-title {font-size:12.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-meta {font-size:9.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-body {flex:1;min-height:0;overflow:auto;padding:10px 11px 12px;display:flex;flex-direction:column;gap:8px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card {border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.022);padding:0;flex:none;overflow:hidden}
:is(#${PANEL_ID},#${THOUGHT_ID}) .section-head {display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;letter-spacing:.08em;color:var(--dim);margin-bottom:4px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .section-head span:last-child {letter-spacing:0;color:#627d69;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head {width:100%;margin:0;padding:7px 9px;border:0;background:transparent;color:var(--dim);font:inherit;cursor:pointer;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head:hover {background:rgba(255,255,255,.035)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head:focus-visible,:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head:focus-visible {outline:2px solid var(--sun);outline-offset:-2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-title {flex:none;font-size:10px;letter-spacing:.08em;color:var(--dim)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-brief {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--muted);text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-at {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan {display:none;max-height:100px;overflow:auto;padding:0 9px 9px;white-space:pre-wrap;font-size:11px;line-height:1.55;color:#cfe4d3;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card.open .plan {display:block}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card.open .plan-head .chev {transform:rotate(90deg)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .state-strip {display:flex;flex-wrap:wrap;gap:4px;min-height:20px;align-items:center;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .state-empty {font-size:10.5px;color:var(--dim);padding:1px 2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip {display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:rgba(255,255,255,.018);font-size:9.5px;color:var(--muted);white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip b {font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip.hot {border-color:rgba(244,201,93,.42);color:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip.bad {border-color:rgba(255,147,136,.36);color:var(--danger)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap {border:1px solid var(--line);border-left:2px solid rgba(242,201,100,.55);border-radius:0 9px 9px 0;background:rgba(242,201,100,.035);overflow:hidden;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head {width:100%;display:flex;align-items:center;gap:6px;padding:6px 8px;border:0;background:transparent;color:var(--dim);font-size:10px;letter-spacing:.06em;text-align:left;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head:hover {background:rgba(255,255,255,.04)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-label {font-weight:600;color:var(--muted);letter-spacing:.03em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-hint {color:#627d69;font-size:9px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chev {margin-left:auto;color:#627d69;transition:transform .15s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .think-body {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .chev {transform:rotate(-90deg)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body {max-height:120px;overflow:auto;padding:0 9px 8px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.55;color:#b7cdbc;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body.empty {color:var(--dim)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .log-head {display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 2px 4px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.08em;color:var(--dim);flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-count {font-variant-numeric:tabular-nums;letter-spacing:0;color:#627d69;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log {display:flex;flex-direction:column;flex:1;min-height:120px;overflow:auto}
:is(#${PANEL_ID},#${THOUGHT_ID}) .empty {padding:14px 4px;color:var(--dim);font-size:10.5px;text-align:center}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry {display:grid;grid-template-columns:13px minmax(0,1fr);gap:6px;padding:7px 2px;border-bottom:1px solid rgba(151,196,160,.075);align-items:start;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry:last-child {border-bottom:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .ico {font-size:10px;color:var(--dim);text-align:center;padding-top:1px;line-height:1.4}
:is(#${PANEL_ID},#${THOUGHT_ID}) .text {font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--muted);min-width:0;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="call"] .ico {color:var(--sun)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="call"] .text {color:#e3d5ad}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="ok"] .ico {color:var(--green)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="ok"] .text {color:#cfe4d3}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="fail"] .ico {color:var(--danger)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="fail"] .text {color:#ffd0cc}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="pending"] .ico {color:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="pending"] .text {color:#f2dfa8}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="plan"] .ico {color:#8fd8cf}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="plan"] .text {color:#b9e1dc}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="sys"] .text {color:#b6c9ba}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="user"] .ico {color:#8ecdf0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="user"] .text {color:#c8e7f5}

@media (max-width:900px){
  #${PANEL_ID}{right:8px;top:56px;width:min(320px,calc(100vw - 16px))}
  #${THOUGHT_ID}{left:8px;bottom:56px;width:min(420px,calc(100vw - 16px))}
}
@media (max-width:760px){
  #${PANEL_ID}{width:min(300px,calc(100vw - 16px))}
  #${THOUGHT_ID}{width:min(360px,calc(100vw - 16px))}
}
@media (max-width:680px){
  #${PANEL_ID}{width:min(280px,calc(100vw - 16px))}
  #${THOUGHT_ID}{width:min(330px,calc(100vw - 16px))}
}
@media (max-width:560px){
  #${PANEL_ID}{left:8px;right:8px;top:8px;width:auto;max-height:45vh;min-height:0}
  #${THOUGHT_ID}{left:8px;right:8px;bottom:8px;width:auto;height:45vh;min-height:0}
}
`;

function createInGameUI({ agent, bridge }) {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const doc = A.document;
  if (!doc || !doc.body) return null;

  try { const old = doc.getElementById(PANEL_ID); if (old) old.remove(); } catch { /* ignore */ }
  try { const old = doc.getElementById(THOUGHT_ID); if (old) old.remove(); } catch { /* ignore */ }
  try { const old = doc.getElementById(CSS_ID); if (old) old.remove(); } catch { /* ignore */ }

  const style = el(doc, 'style');
  style.id = CSS_ID;
  style.textContent = CSS;
  (doc.head || doc.body).appendChild(style);

  const cfg = loadCfg();
  const csp = cspInfo();

  const panel = el(doc, 'div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'PVZ AI 控制面板');
  panel.innerHTML = `
    <div class="p-head" data-drag="panel">
      <div class="p-brand">
        <span class="p-mark"></span>
        <div>
          <div class="p-title">PVZ · AI 指挥</div>
          <div class="p-sub">LLM 唯一决策者</div>
        </div>
      </div>
      <span class="p-mini" aria-hidden="true"><span class="mini-dot" data-el="miniDot"></span><b>AI</b></span>
      <div class="p-head-actions">
        <button class="icon-btn" data-act="think" title="显示/隐藏思考窗（F10）" aria-label="显示或隐藏思考窗">思</button>
        <button class="icon-btn" data-act="min" title="收起/展开面板" aria-label="收起或展开面板">—</button>
      </div>
    </div>
    <div class="p-body">
      <div class="p-status"><span class="status-dot" data-el="dot"></span><span data-el="status">待机</span></div>
      <div class="p-field">
        <div class="p-label"><span>服务商</span><em data-el="providerHint">预设</em></div>
        <select data-f="provider">
          ${PROVIDER_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="p-field">
        <div class="p-label"><span>API Base</span><em>OpenAI 兼容</em></div>
        <input data-f="baseUrl" placeholder="${DEFAULT_BASE_URL}" spellcheck="false" />
      </div>
      <div class="p-field">
        <div class="p-label"><span>模型</span><em data-el="modelHint">DeepSeek</em></div>
        <input data-f="model" list="pvzllm-model-hints" placeholder="${DEFAULT_MODEL}" spellcheck="false" />
        <datalist id="pvzllm-model-hints"></datalist>
      </div>
      <div class="p-field">
        <div class="p-label"><span>API Key</span><em>只在本机</em></div>
        <input data-f="apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </div>
      <div class="p-flags">
        <label class="check"><input data-f="remember" type="checkbox" /> 记住 Key</label>
        <label class="check"><input data-f="stream" type="checkbox" /> 流式</label>
      </div>
      <div class="p-note">勾选“记住 Key”才写入本机 localStorage；不勾选只保存在内存。</div>
      <div class="p-csp" data-el="csp" title=""></div>
      <div class="p-actions">
        <button class="btn ghost" data-act="test">测试</button>
        <button class="btn primary" data-act="start">开始 AI</button>
        <button class="btn danger" data-act="stop">停止</button>
      </div>
      <div class="p-foot">F8 开始 / 停止 · F10 思考窗</div>
    </div>
    <div class="pl-resize" data-resize="panel" title="拖动缩放"></div>`;
  doc.body.appendChild(panel);

  const thought = el(doc, 'div');
  thought.id = THOUGHT_ID;
  thought.setAttribute('role', 'region');
  thought.setAttribute('aria-label', 'AI 思考与决策日志');
  thought.innerHTML = `
    <div class="t-head" data-drag="thought">
      <div class="t-brand">
        <span class="status-dot" data-el="tDot"></span>
        <span class="t-title">AI 思考</span>
        <span class="t-meta" data-el="tMeta">待机</span>
      </div>
      <div class="t-actions">
        <button class="icon-btn" data-act="clear" title="清空决策日志" aria-label="清空决策日志">清</button>
        <button class="icon-btn" data-act="hide" title="隐藏思考窗（F10）" aria-label="隐藏思考窗">×</button>
      </div>
    </div>
    <div class="t-body">
      <div class="plan-card" data-el="planCard">
        <button class="section-head plan-head" data-act="togglePlan" aria-expanded="false">
          <span class="plan-title">本关计划</span>
          <span class="plan-brief" data-el="planBrief">未记录</span>
          <span class="chev" data-el="planChev">▸</span>
        </button>
        <div class="plan" data-el="plan">暂无计划</div>
        <span class="plan-at" data-el="planAt">未记录</span>
      </div>
      <div class="state-strip" data-el="state"><span class="state-empty">等待状态…</span></div>
      <div class="think-wrap" data-el="thinkWrap">
        <button class="think-head" data-act="toggleThink" aria-expanded="true">
          <span class="think-label">推理原文</span>
          <span class="think-hint" data-el="thinkHint">滚动</span>
          <span class="chev" data-el="chev">▾</span>
        </button>
        <div class="think-body empty" data-el="live">等待模型思考…</div>
      </div>
      <div class="log-head"><span>决策日志</span><span class="log-count" data-el="logCount">0</span></div>
      <div class="log" data-el="log" aria-live="polite"><div class="empty" data-el="empty">等待 AI 开始决策…</div></div>
    </div>
    <div class="pl-resize" data-resize="thought" title="拖动缩放"></div>`;
  doc.body.appendChild(thought);

  const $ = (sel, root = panel) => root.querySelector(sel);
  const statusEl = $('[data-el="status"]');
  const dotEl = $('[data-el="dot"]');
  const miniDotEl = $('[data-el="miniDot"]');
  const planEl = $('[data-el="plan"]', thought);
  const planAtEl = $('[data-el="planAt"]', thought);
  const planCard = $('[data-el="planCard"]', thought);
  const planBriefEl = $('[data-el="planBrief"]', thought);
  const stateEl = $('[data-el="state"]', thought);
  const liveEl = $('[data-el="live"]', thought);
  const logEl = $('[data-el="log"]', thought);
  const emptyEl = $('[data-el="empty"]', thought);
  const logCountEl = $('[data-el="logCount"]', thought);
  const tDotEl = $('[data-el="tDot"]', thought);
  const tMetaEl = $('[data-el="tMeta"]', thought);
  const cspEl = $('[data-el="csp"]');
  const thinkWrap = $('[data-el="thinkWrap"]', thought);
  const thinkHint = $('[data-el="thinkHint"]', thought);

  if (cspEl) {
    cspEl.classList.toggle('warn', csp.metaCount > 0);
    cspEl.textContent = csp.metaCount
      ? `CSP：检测到 ${csp.metaCount} 条 meta，建议用启动器`
      : 'CSP：未检测到 meta，响应头需启动器';
    cspEl.title = csp.note;
  }

  // 配置
  const fields = {
    provider: $('[data-f="provider"]'),
    baseUrl: $('[data-f="baseUrl"]'),
    model: $('[data-f="model"]'),
    apiKey: $('[data-f="apiKey"]'),
    remember: $('[data-f="remember"]'),
    stream: $('[data-f="stream"]'),
  };
  const providerHintEl = $('[data-el="providerHint"]');
  const modelHintEl = $('[data-el="modelHint"]');
  const modelListEl = doc.getElementById('pvzllm-model-hints');

  const presetOf = (id) => PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[0];

  // 旧配置没有 provider 字段，按 baseUrl 推断，避免升级后显示错的服务商
  function guessProvider(baseUrl) {
    const s = String(baseUrl || '');
    if (/opencode\.ai/i.test(s)) return 'opencode-go';
    if (/deepseek\.com/i.test(s)) return 'deepseek';
    return s ? 'custom' : 'deepseek';
  }

  function applyPreset(id, { fill = true } = {}) {
    const p = presetOf(id);
    if (fill) {
      if (p.baseUrl) fields.baseUrl.value = p.baseUrl;
      if (p.model) fields.model.value = p.model;
    }
    if (providerHintEl) {
      providerHintEl.textContent = p.id === 'custom' ? '手动' : '预设';
      providerHintEl.title = p.hint || '';
    }
    if (modelHintEl) {
      modelHintEl.textContent = p.id === 'opencode-go' ? 'OpenCode Go' : p.id === 'deepseek' ? 'DeepSeek' : '自定义';
    }
    if (modelListEl) {
      modelListEl.innerHTML = '';
      for (const m of p.models || []) {
        const o = doc.createElement('option');
        o.value = m;
        modelListEl.appendChild(o);
      }
    }
  }

  fields.baseUrl.value = cfg.baseUrl || DEFAULT_BASE_URL;
  fields.model.value = cfg.model || DEFAULT_MODEL;
  fields.apiKey.value = cfg.apiKey || '';
  fields.remember.checked = !!cfg.remember;
  fields.stream.checked = cfg.stream !== false;
  fields.provider.value = cfg.provider || guessProvider(fields.baseUrl.value);
  applyPreset(fields.provider.value, { fill: false });

  // 迁移：0.1.9 存的是 OpenCode Go 直连地址，浏览器用不了，自动纠正到本地代理
  if (fields.provider.value === 'opencode-go' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(fields.baseUrl.value)) {
    fields.baseUrl.value = presetOf('opencode-go').baseUrl;
  }

  function persist() {
    const next = {
      provider: fields.provider.value,
      baseUrl: fields.baseUrl.value.trim(),
      model: fields.model.value.trim(),
      remember: fields.remember.checked,
      stream: fields.stream.checked,
      apiKey: fields.remember.checked ? fields.apiKey.value.trim() : '',
    };
    saveCfg(next);
    agent.setConfig({
      baseUrl: next.baseUrl,
      model: next.model,
      apiKey: fields.apiKey.value.trim(),
      stream: next.stream,
    });
  }
  for (const [key, f] of Object.entries(fields)) {
    if (key === 'provider') continue;
    f.addEventListener('change', persist);
  }
  // 切换服务商时套用预设的 Base/模型，之后仍可手动改
  fields.provider.addEventListener('change', () => {
    applyPreset(fields.provider.value, { fill: true });
    persist();
  });
  persist();

  // 状态 / 标题
  function setStatus(text, kind) {
    statusEl.textContent = text;
    const suffix = kind === 'on' ? ' on' : kind === 'err' ? ' err' : kind === 'pending' ? ' pending' : '';
    dotEl.className = 'status-dot' + suffix;
    tDotEl.className = 'status-dot' + suffix;
    if (miniDotEl) miniDotEl.className = 'mini-dot' + suffix;
    tMetaEl.textContent = kind === 'on' ? '运行中' : kind === 'err' ? '异常' : kind === 'pending' ? '等待' : '待机';
  }

  function setLive(text) {
    const s = String(text == null ? '' : text).trim();
    liveEl.textContent = s || '等待模型思考…';
    liveEl.classList.toggle('empty', !s);
    thinkHint.textContent = s ? '滚动' : '等待';
    if (s) liveEl.scrollTop = liveEl.scrollHeight;
  }

  function toggleThink() {
    thinkWrap.classList.toggle('collapsed');
    const collapsed = thinkWrap.classList.contains('collapsed');
    const head = thinkWrap.querySelector('.think-head');
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function togglePlan() {
    planCard.classList.toggle('open');
    const open = planCard.classList.contains('open');
    const head = planCard.querySelector('.plan-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderState(s) {
    if (!s || s.ok === false) {
      stateEl.innerHTML = '';
      stateEl.appendChild(el(doc, 'span', 'state-empty', `状态不可用：${(s && (s.code || s.reason)) || '未知'}`));
      return;
    }
    const bits = [];
    const wave = s.level && s.level.wave;
    const waves = s.level && s.level.waves;
    bits.push(['阶段', phaseCN[s.phase] || s.phase || '—', s.phase === 'lost' ? 'bad' : s.phase === 'won' ? 'hot' : '']);
    bits.push(['阳光', s.sun == null ? '—' : s.sun, '']);
    bits.push(['能量豆', s.plantFood == null ? '—' : s.plantFood, '']);
    bits.push(['波次', `${wave || 0}/${waves || '?'}`, '']);
    bits.push(['植物', (s.plants || []).length, '']);
    if (s.paused) bits.push(['暂停', '是', 'bad']);
    const urgent = (s.tasks || []).filter((t) => t.urgent && !t.completed && !t.failed).length;
    const failed = (s.tasks || []).filter((t) => t.failed).length;
    if (urgent) bits.push(['任务紧急', urgent, 'hot']);
    if (failed) bits.push(['任务失败', failed, 'bad']);
    stateEl.innerHTML = bits.map(([k, v, cls]) => `<span class="chip ${cls || ''}"><span>${esc(k)}</span><b>${esc(v)}</b></span>`).join('');
  }

  function renderPlan(plan, savedAt) {
    planEl.textContent = formatPlan(plan);
    const brief = plan && (plan.style || plan.goal || plan.summary) ? String(plan.style || plan.goal || plan.summary) : (plan ? '已记录' : '未记录');
    if (planBriefEl) planBriefEl.textContent = brief;
    if (savedAt) {
      const d = new Date(savedAt);
      planAtEl.textContent = Number.isNaN(d.getTime()) ? '已记录' : d.toLocaleTimeString('zh-CN', { hour12: false });
      planCard.title = `计划记录于 ${planAtEl.textContent}`;
    } else {
      planAtEl.textContent = plan ? '已记录' : '未记录';
      planCard.title = plan ? '计划已记录' : '';
    }
  }

  const ICON = { call: '›', ok: '✓', fail: '!', pending: '…', plan: '◇', sys: '·', user: '›', think: '…' };
  let logCount = 0;

  function append(kind, text) {
    if (!text) return;
    if (emptyEl && emptyEl.parentElement === logEl) emptyEl.remove();
    const row = el(doc, 'div', 'entry');
    row.dataset.kind = kind || 'sys';
    row.style.setProperty('text-align', 'left', 'important');
    row.appendChild(el(doc, 'span', 'ico', ICON[kind] || '·'));
    const textEl = el(doc, 'span', 'text', String(text));
    textEl.style.setProperty('text-align', 'left', 'important');
    row.appendChild(textEl);
    logEl.appendChild(row);
    while (logEl.children.length > 320) logEl.removeChild(logEl.firstChild);
    logCount++;
    logCountEl.textContent = String(logCount);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() {
    logEl.textContent = '';
    logEl.appendChild(el(doc, 'div', 'empty', '等待 AI 开始决策…'));
    logCount = 0;
    logCountEl.textContent = '0';
  }

  function cspHint(reason) {
    const s = String(reason || '');
    if (!/Failed to fetch|Content Security Policy|connect-src|net::ERR|CORS/i.test(s)) return;
    append('fail', '这通常是 WebView2 CSP 拦截了模型请求。模组在页面内无法可靠解除 CSP；请用 PvZAI_Launcher.exe 启动游戏，或改用 MCP 模式。');
  }

  function resultText(name, result) {
    let text = '';
    try { text = formatToolResult(name, result); } catch { text = result && result.ok === false ? `失败：${result.reason || result.code || '未知'}` : '完成'; }
    if (!text) return '完成';
    text = String(text).replace(/^[✅❌⏳⌛]\s*/, '');
    const lines = String(text).split('\n');
    if (lines.length > 14) return lines.slice(0, 14).join('\n') + `\n…（还有 ${lines.length - 14} 行）`;
    return text;
  }

  function onAgentEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'run_start':
        setStatus('运行中', 'on');
        append('sys', '开始：由 LLM 自己读事实、定计划、选卡和操作。');
        break;
      case 'request':
        setLive('思考中…');
        tMetaEl.textContent = '思考中';
        break;
      case 'thinking':
        setLive(ev.text ? ev.text.slice(-1400) : '思考中…');
        break;
      case 'thinking_final':
        // 推理只在顶部“推理原文”区显示；决策日志不重复。
        setLive(ev.text || '');
        break;
      case 'assistant_delta':
        // 可见输出等 assistant 事件一次性落到决策日志。
        break;
      case 'assistant':
        if (ev.text && /[\u4e00-\u9fa5]/.test(ev.text)) append('sys', `说明：${ev.text}`);
        break;
      case 'tool_call':
        append('call', formatToolCall(ev.name, ev.args));
        tMetaEl.textContent = '执行中';
        break;
      case 'tool_result': {
        const hasPending = !!(ev.result && Array.isArray(ev.result.results) && ev.result.results.some((x) => x && x.pending));
        append(hasPending ? 'pending' : (ev.ok ? 'ok' : 'fail'), resultText(ev.name, ev.result));
        if (ev.name === 'pvz_state' && ev.result && ev.result.ok) {
          renderState(ev.result);
          if (ev.result.plan) renderPlan(ev.result.plan, ev.result.planSavedAt);
        }
        tMetaEl.textContent = hasPending ? '等待落地' : '观察中';
        break;
      }
      case 'plan':
        renderPlan(ev.plan, ev.savedAt);
        append('plan', '本关计划已更新');
        break;
      case 'state':
        if (ev.state) renderState(ev.state);
        if (ev.state && ev.state.plan) renderPlan(ev.state.plan, ev.state.planSavedAt);
        break;
      case 'state_phase':
        setStatus(`阶段：${phaseCN[ev.phase] || ev.phase}`, ev.phase === 'lost' ? 'err' : (ev.phase === 'won' || ev.phase === 'running' ? 'on' : 'pending'));
        break;
      case 'game_over':
        setStatus(ev.phase === 'won' ? '本关胜利' : '本关失败', ev.phase === 'lost' ? 'err' : 'on');
        tMetaEl.textContent = ev.phase === 'won' ? '已胜利' : '已失败';
        append('sys', `本关结束：${ev.phase === 'won' ? '胜利' : '失败'}`);
        break;
      case 'error':
        setStatus(`${ev.code || '错误'}：${String(ev.reason || '').slice(0, 60)}`, 'err');
        append('fail', `错误 ${ev.code || ''}：${ev.reason || ''}`);
        cspHint(ev.reason);
        break;
      case 'stopped':
        setStatus('已停止', '');
        tMetaEl.textContent = '已停止';
        append('sys', `停止：${ev.reason || '手动'}`);
        break;
      case 'run_end':
        setStatus(`结束 · 工具 ${ev.stats ? ev.stats.toolCalls : 0} 次`, ev.error ? 'err' : '');
        tMetaEl.textContent = '已结束';
        append('sys', `运行结束。工具调用 ${ev.stats ? ev.stats.toolCalls : 0} 次；tokens 入 ${ev.stats ? ev.stats.promptTokens : 0} / 出 ${ev.stats ? ev.stats.completionTokens : 0}`);
        break;
      case 'log':
        append('sys', ev.text || '');
        break;
      case 'user':
        append('user', `玩家：${ev.text}`);
        break;
      default:
        break;
    }
  }

  agent.setEventHandler(onAgentEvent);

  async function startAI() {
    persist();
    setStatus('启动中…', 'pending');
    append('sys', '启动 LLM 客户端…');
    const r = await agent.start();
    if (!r.ok) {
      setStatus(`${r.code || '启动失败'}：${r.reason || ''}`, 'err');
      append('fail', `启动失败：${r.reason || r.code || ''}`);
    }
  }

  function stopAI() {
    agent.stop('手动停止');
    setStatus('已停止', '');
  }

  async function test() {
    persist();
    setStatus('测试连接…', 'pending');
    const r = await agent.testConnection();
    if (r.ok) {
      setStatus(`连接 OK（${r.latencyMs}ms）`, 'on');
      append('ok', `连接成功：${r.model}，${r.latencyMs}ms`);
    } else {
      setStatus(`连接失败：${r.code || ''}`, 'err');
      append('fail', `连接失败 ${r.code || ''}：${r.reason || ''}`);
      cspHint(r.reason);
    }
  }

  panel.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'start') startAI();
    else if (act === 'stop') stopAI();
    else if (act === 'test') test();
    else if (act === 'think') thought.classList.toggle('pl-hidden');
    else if (act === 'min') panel.classList.toggle('pl-min');
  });
  thought.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'hide') thought.classList.add('pl-hidden');
    else if (act === 'clear') clearLog();
    else if (act === 'toggleThink') toggleThink();
    else if (act === 'togglePlan') togglePlan();
  });

  // 拖动 + 缩放
  const savedGeom = loadGeom();
  const geomState = { panel: savedGeom.panel || null, thought: savedGeom.thought || null };

  function viewport() {
    return { w: Math.max(320, A.innerWidth || 1280), h: Math.max(240, A.innerHeight || 720) };
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function readGeom(node) {
    const r = node.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function saveAllGeom() {
    if (!panel.classList.contains('pl-min') && panel.offsetWidth) geomState.panel = readGeom(panel);
    if (!thought.classList.contains('pl-hidden') && thought.offsetWidth) geomState.thought = readGeom(thought);
    saveGeom(geomState);
  }
  function applyGeom(node, g, minW, minH) {
    if (!g) return;
    const vp = viewport();
    if (Number.isFinite(g.width)) node.style.width = `${clamp(g.width, minW, vp.w - 16)}px`;
    if (Number.isFinite(g.height)) node.style.height = `${clamp(g.height, minH, vp.h - 16)}px`;
    if (Number.isFinite(g.left) && Number.isFinite(g.top)) {
      node.style.left = `${clamp(g.left, 0, vp.w - 80)}px`;
      node.style.top = `${clamp(g.top, 0, vp.h - 40)}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
  }
  function resetGeom(node, kind) {
    node.style.left = '';
    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.width = '';
    node.style.height = '';
    geomState[kind] = null;
    saveGeom(geomState);
  }
  function makeDraggable(node, handle, kind) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
      const r = node.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      node.classList.add('pl-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 3 || Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      const vp = viewport();
      node.style.left = `${clamp(drag.left + (e.clientX - drag.x), 0, vp.w - 80)}px`;
      node.style.top = `${clamp(drag.top + (e.clientY - drag.y), 0, vp.h - 40)}px`;
    });
    const end = () => {
      if (!drag) return;
      const wasMini = kind === 'panel' && node.classList.contains('pl-min');
      const moved = drag.moved;
      drag = null;
      node.classList.remove('pl-resizing');
      if (wasMini && !moved) {
        node.classList.remove('pl-min');
        const vp = viewport();
        const r = node.getBoundingClientRect();
        if (r.right > vp.w - 8) node.style.left = `${Math.max(8, vp.w - r.width - 8)}px`;
        if (r.bottom > vp.h - 8) node.style.top = `${Math.max(8, vp.h - r.height - 8)}px`;
      }
      saveAllGeom();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      resetGeom(node, kind);
    });
  }
  function makeResizable(node, kind, minW, minH) {
    const handle = node.querySelector('.pl-resize');
    if (!handle) return;
    let resize = null;
    handle.addEventListener('pointerdown', (e) => {
      const r = node.getBoundingClientRect();
      resize = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      node.style.width = `${r.width}px`;
      node.style.height = `${r.height}px`;
      node.classList.add('pl-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resize) return;
      const vp = viewport();
      const w = clamp(resize.w + (e.clientX - resize.x), minW, vp.w - 16);
      const h = clamp(resize.h + (e.clientY - resize.y), minH, vp.h - 16);
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
    });
    const end = () => {
      if (!resize) return;
      resize = null;
      node.classList.remove('pl-resizing');
      saveAllGeom();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetGeom(node, kind);
    });
  }

  applyGeom(panel, geomState.panel, 260, 120);
  applyGeom(thought, geomState.thought, 300, 260);
  makeDraggable(panel, $('.p-head', panel), 'panel');
  makeDraggable(thought, $('.t-head', thought), 'thought');
  makeResizable(panel, 'panel', 260, 120);
  makeResizable(thought, 'thought', 300, 260);

  A.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      if (agent.isRunning()) stopAI(); else startAI();
    }
    if (e.key === 'F10') {
      e.preventDefault();
      thought.classList.toggle('pl-hidden');
    }
  });

  // 初始
  setLive('');
  renderPlan(null, null);
  try {
    const s = bridge.snapshot();
    if (s && s.ok) renderState(s);
  } catch { /* ignore */ }

  function report() {
    return {
      version: agent.version,
      running: agent.isRunning(),
      phase: agent.getPhase(),
      stats: agent.getStats(),
      plan: agent.getPlan(),
      state: stateEl.textContent,
      logLines: logCount,
      csp: cspInfo(),
      lastError: statusEl.textContent && dotEl.className.indexOf('err') >= 0 ? statusEl.textContent : null,
    };
  }

  function destroy() {
    try { panel.remove(); } catch { /* ignore */ }
    try { thought.remove(); } catch { /* ignore */ }
    try { style.remove(); } catch { /* ignore */ }
  }

  return { panel, thought, report, destroy, setStatus, append, startAI, stopAI, test, cspInfo };
}


// ── in-game/setup.js ──
/**
 * 游戏内入口：bridge + 工具 router + LLM 客户端 + 浮窗。
 */

const AGENT_VERSION = '0.1.10';

function setupInGame(ctx) {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const bridge = createBridge(ctx);
  const router = createToolRouter({ bridge, version: AGENT_VERSION });
  const agent = createLlmAgent({ router, version: AGENT_VERSION, cfg: { stream: true } });
  let ui = null;
  try { ui = createInGameUI({ agent, bridge }); } catch (e) {
    try { console.error('[pvz-llm-agent] UI 初始化失败', e); } catch { /* ignore */ }
  }

  const api = {
    version: AGENT_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    bridge,
    router,
    agent,
    ui,
    health() {
      let h = null;
      try { h = bridge.health(); } catch (e) { h = { ok: false, reason: String(e && e.message || e) }; }
      return {
        ...h,
        agentVersion: AGENT_VERSION,
        tools: router.names,
        running: agent.isRunning(),
        plan: agent.getPlan(),
        phase: agent.getPhase(),
        csp: ui && ui.cspInfo ? ui.cspInfo() : null,
        ui: ui ? ui.report() : null,
      };
    },
    dispose() {
      try { agent.stop('dispose'); } catch { /* ignore */ }
      try { if (ui) ui.destroy(); } catch { /* ignore */ }
      try { bridge.dispose(); } catch { /* ignore */ }
      try { delete A.PvzLlmAgent; } catch { /* ignore */ }
      try { delete A.PvzLlm; } catch { /* ignore */ }
      return { ok: true };
    },
  };
  try { A.PvzLlmAgent = api; } catch { /* ignore */ }
  try { if (ctx && ctx.ui && ctx.ui.toast) ctx.ui.toast('PvZ LLM Agent 已加载 v' + AGENT_VERSION, 'success'); } catch { /* ignore */ }
  return api;
}


export default { setup: setupInGame };
