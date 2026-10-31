/**
 * stats：从游戏资源里读"事实"。
 *
 * 这里只有数据：植物数值、僵尸数值、护甲、昼夜、关卡脚本、图鉴文本。
 * 不判断"该不该选/该种哪里"，也不产生任何建议。
 */
import { zombieTagsFrom } from '../knowledge/tags.js';
import { zombieBehaviorFacts, zombieBehaviorLine } from '../knowledge/zombie-rules.js';
import { damageModel, plantFoodFacts, usageFactsOf } from '../knowledge/plant-rules.js';

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
  // 地刺类：伤害来自“僵尸走过这一格”，不是弹道；不能按直线/近战判断落点。
  if (st.stepDamage) return { kind: 'ground', overObstacle: true, blockedByStraightBlocker: false };
  // 光环/吸血/领域型：不发射弹道，也不该被墓碑当成“挡住弹道”。
  if (st.damageType === 'drain' || (st.attack && st.attack.basis === 'dps' && !st.hasProjectile)) {
    return { kind: 'aura', overObstacle: true, blockedByStraightBlocker: false };
  }
  // 点击瞄准型（冬青骑士/香蕉火箭炮…）：弹道由玩家指定落点，不是自动直线射手
  if (st.usage && st.usage.manual && st.usage.aim === 'free_cell') {
    return { kind: 'aimed', overObstacle: true, blockedByStraightBlocker: false };
  }
  const fam = String(st.family || '');
  const rng = String(st.range || '');
  let kind = SHOT_BY_FAMILY[fam] || null;
  if (fam === 'Fire') kind = 'area';
  if (/抛物|抛掷|投掷|高抛/.test(rng)) kind = 'lob';
  else if (/接近|近战/.test(rng) && fam !== 'Fire') kind = 'melee';
  else if (fam === 'Explosive') kind = 'instant';
  if ((kind === 'none' || !kind) && st.attack && st.attack.dps) kind = 'straight';
  // 有攻击但没有弹道 = 近身/领域攻击，不是直线弹道（冬青骑士这类）
  if (kind === 'straight' && st.hasProjectile === false) kind = 'melee';
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


/** 把图鉴文本里的"用法"抽成结构化事实（规则表在 knowledge/plant-rules.js）。 */
export function usageFacts(st) {
  if (!st) return usageFactsOf({});
  const text = [st.brief, st.introduction, ...((st.special) || [])].filter(Boolean).join(' ');
  return usageFactsOf({ text, family: st.family, range: st.range, props: st.props });
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
      // 弹道数据：毒伤/真伤（SupressArmorProtection）只在这里，植物属性里没有。
      'ProjectileProps', 'ProjectileTypes',
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

/**
 * 弹道数据：ProjectileProps/ProjectileTypes → alias→objdata。
 * 植物的 PeaType/SporeType/CabbageType 等直接引用这些 alias；毒伤与真伤只在这里。
 */
let projCacheBag = null;
let projCacheMap = null;
function projectileMap(bag) {
  if (!bag) return new Map();
  if (projCacheBag === bag && projCacheMap) return projCacheMap;
  const map = new Map();
  for (const o of (bag.ProjectileProps && bag.ProjectileProps.objects) || []) {
    const alias = (o.aliases || [])[0];
    if (alias) map.set(alias, o.objdata || {});
  }
  for (const o of (bag.ProjectileTypes && bag.ProjectileTypes.objects) || []) {
    const alias = (o.aliases || [])[0];
    if (!alias || map.has(alias)) continue;
    const props = o.objdata && o.objdata.Props;
    const m = typeof props === 'string' ? /RTID\(([^@()]+)@/.exec(props) : null;
    const data = m ? map.get(m[1]) : null;
    if (data) map.set(alias, data);
  }
  projCacheBag = bag;
  projCacheMap = map;
  return map;
}

function projectilesOf(bag, d) {
  const map = projectileMap(bag);
  const out = [];
  const seen = new Set();
  const take = (v) => {
    if (typeof v !== 'string' || seen.has(v)) return;
    const data = map.get(v);
    if (!data) return;
    seen.add(v);
    out.push(data);
  };
  for (const [k, v] of Object.entries(d || {})) {
    // 植物食用的强化弹道（PeaTypePlantfood 等）不是普通攻击，别把它的毒伤/伤害算进 dps。
    if (/plantfood/i.test(k)) continue;
    if (Array.isArray(v)) for (const x of v) take(x);
    else take(v);
  }
  return out;
}

/**
 * 毒伤事实：PoisonStacked / Poison / PoisonDPS 三种写法都存在。
 * 返回每层 dps、持续时间、层数、总伤害；不做“该不该带”的判断。
 */
function poisonFacts(d, projectiles) {
  const cands = [];
  const take = (src) => {
    if (!src || typeof src !== 'object') return;
    const stacked = src.PoisonStacked;
    if (stacked) cands.push({ dps: numOf(stacked.DPS), duration: numOf(stacked.Duration), stacks: numOf(stacked.Stacks) || 1 });
    const poison = src.Poison;
    if (poison) cands.push({ dps: numOf(poison.DPS), duration: numOf(poison.Duration), stacks: numOf(poison.Stacks) || 1 });
    if (numOf(src.PoisonDPS) > 0) {
      cands.push({ dps: numOf(src.PoisonDPS), duration: numOf(src.PoisonDuration), stacks: numOf(src.PoisonStacks) || 1 });
    }
  };
  take(d);
  for (const p of projectiles || []) take(p);
  const valid = cands.filter((c) => Number(c.dps) > 0);
  if (!valid.length) return null;
  const dps = Math.max(...valid.map((c) => Number(c.dps)));
  const duration = Math.max(...valid.map((c) => Number(c.duration) || 0));
  const stacks = Math.max(...valid.map((c) => Number(c.stacks) || 1));
  const slowSrc = [d, ...(projectiles || [])]
    .map((s) => s && s.ZombieSpeedStacked)
    .find((s) => s && numOf(s.SpeedMult) != null) || null;
  return {
    dps: Math.round(dps * 10) / 10,
    duration,
    stacks,
    total: Math.round(dps * duration * stacks * 10) / 10,
    slow: slowSrc ? { speedMult: numOf(slowSrc.SpeedMult), duration: numOf(slowSrc.Duration) } : null,
  };
}

// 把图鉴里的“接触/接近/前后/N 格”转成可算的列差（格）。远程/整行返回 null。
function reachOf(family, range) {
  const rng = String(range || '');
  if (/接触/.test(rng)) return 0;
  if (/接近|前后|3x3/.test(rng)) return 1;
  const m = /(\d+)\s*格/.exec(rng);
  if (m) return Math.max(0, Math.min(6, Number(m[1])));
  if (String(family) === 'Melee') return 1;
  return null;
}

// 自动收集图鉴/属性里所有标量字段：新植物/新僵尸不用改代码就能把原始数值带给模型。
function scalarProps(d) {
  const out = {};
  if (!d || typeof d !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; n++; }
    else if (typeof v === 'string') { out[k] = v.slice(0, 160); n++; }
    if (n >= 48) break;
  }
  return out;
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
    // 弹道里的毒伤/真伤：植物属性本身不写，只在 PeaType/SporeType 指向的 ProjectileProps 里。
    const projectiles = projectilesOf(b, d);
    const poison = poisonFacts(d, projectiles);
    // 直接弹道的真伤（SupressArmorProtection）与毒伤是两件事：
    // 毒伤持续伤害打本体；普通豌豆本身仍先打护甲。
    const projectileTrue = projectiles.some((p) => p.SupressArmorProtection === true);
    const alm = almanacFacts(b, 'plant', type);
    const el = alm.elements.find((e) => e.type === 'RANGE');
    const range = (el && el.sort) || null;
    const areaEl = alm.elements.find((e) => e.type === 'AREA');
    const area = (areaEl && areaEl.sort) || null;
    const dmgAlm = (() => {
      const de = alm.elements.find((e) => e.type === 'DAMAGE');
      return de && Number.isFinite(Number(de.value)) ? Number(de.value) : null;
    })();
    const pfAlm = (() => {
      const pf = alm.elements.find((e) => e.type === 'PLANTFOOD');
      return (pf && pf.sort) ? String(pf.sort) : null;
    })();
    const fullText = [alm.brief, alm.introduction, ...(alm.special || []).map((x) => x.text || '')]
      .filter(Boolean).join(' ');

    // 伤害模型：字段族规则表（knowledge/plant-rules.js）。
    // 没有间隔的伤害归到 burst，不再让「樱桃炸弹没有伤害值」发生。
    const dm = damageModel(d, {
      family: d.Family, text: fullText, poison, projectileTrue,
      hasProjectile: projectiles.length > 0, almanacDmg: dmgAlm,
    });

    // 土豆雷/地雷类：出土/启动时间。不是瞬爆，必须提前埋。
    const armTimeSec = numOf(d.ChargeTime) != null ? numOf(d.ChargeTime)
      : (numOf(d.ArmTime) != null ? numOf(d.ArmTime) : (numOf(d.ExplodeDelay) || 0));
    const sunValue = numOf(d.SunValue);
    const list = Array.isArray(d.SunValueList) ? d.SunValueList.map(numOf).filter((v) => v > 0) : null;
    const prodDay = numOf(d.ProduceInterval);
    const prodNight = numOf(d.ProduceInterval_AtNight) != null ? numOf(d.ProduceInterval_AtNight) : prodDay;
    const stages = list && list.length ? list : (sunValue ? [sunValue] : []);
    const rate = (vals, iv) => (iv > 0 && vals.length ? vals.map((v) => Math.round((v / iv) * 1000) / 1000) : null);
    const cost = numOf(d.SunCost);
    const atkText = [alm.brief, ...(alm.special || []).map((x) => x.text || '')].join(' ');
    // 地刺类：伤害只作用于“走过这一格”的僵尸（图鉴 AREA=本格 / 不会被啃食）。
    const notEaten = /不会被僵尸啃|can't be eaten/i.test(atkText);
    const stepDamage = !!((dm.attack || dm.burst) && (notEaten || (area && /本格|Tile/i.test(String(area)))));
    const pierceCount = numOf(d.PierceCount);
    const targets = pierceCount != null
      ? Math.max(1, pierceCount)
      : (/多重打击|三个目标|3\s*个目标/.test(`${range || ''} ${atkText}`) ? 3 : 1);
    const hitsPerTarget = targets > 1 && /各两次|两次|twice/i.test(atkText) ? 2 : 1;
    const unitDps = dm.attack ? Number(dm.attack.dps) || 0 : 0;
    const attack = dm.attack ? {
      ...dm.attack,
      pierceCount: pierceCount != null ? pierceCount : null,
      targets,
      hitsPerTarget,
      multiDps: Math.round(unitDps * targets * hitsPerTarget * 10) / 10,
      // 攻击本身是否吃护甲：drain/true 才算；毒伤是“弹道打护甲 + 毒打本体”。
      ignoresArmor: dm.damageType === 'drain' || dm.damageType === 'true',
      trueDamage: dm.damageType === 'drain' || dm.damageType === 'true',
      damageType: ['drain', 'true'].includes(dm.damageType) ? dm.damageType : 'normal',
    } : null;
    const burst = dm.burst ? {
      ...dm.burst,
      area: area || null,
      targets,
    } : null;
    const names = featureName(b, 'plant', type);
    const poisonDps = poison ? Number(poison.dps) || 0 : 0;
    const effectiveDps = Math.round((unitDps + poisonDps) * 10) / 10;
    const st = {
      type,
      name: (names && names.zh) || type,
      nameEn: (names && names.en) || null,
      cost,
      cd: numOf(d.Cooldown),
      hp: numOf(d.Toughness),
      hpMax: numOf(d.MaxToughness) || numOf(d.Toughness),
      family: d.Family || null,
      range,
      reach: reachOf(d.Family || null, range),
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special.map((x) => `${x.name || '特点'}：${x.text}`),
      weaknesses: alm.weaknesses,
      attack,
      burst,
      effectiveDps: effectiveDps > 0 ? effectiveDps : null,
      area,
      stepDamage,
      poison,
      hasProjectile: projectiles.length > 0,
      // 伤害与护甲：type 给模型看语义，armorState=unknown 表示“没证据，别当成 false”
      damageType: dm.damageType,
      ignoresArmor: dm.ignoresArmor,
      trueDamage: dm.ignoresArmor,
      armorState: dm.armorState,
      armorNote: dm.armorState === 'unknown' ? '没有字段能证明它是否无视护甲，按普通伤害处理' : undefined,
      damageFields: dm.fields,
      armTimeSec: armTimeSec || 0,
      splash: numOf(d.SplashDamage) || null,
      // 能量豆：结构化（kind/area/radius/total…）。没有专属效果才是 null。
      plantFood: plantFoodFacts(d, {
        family: d.Family, almanacArea: area, almanacRange: range, almanacPlantFood: pfAlm,
      }),
      sun: stages.length ? {
        stages, interval: prodDay, intervalNight: prodNight,
        perSecDay: rate(stages, prodDay), perSecNight: rate(stages, prodNight),
        paybackSec: cost && rate(stages, prodNight) ? Math.round(cost / rate(stages, prodNight)[stages.length - 1]) : null,
      } : null,
    };
    st.usage = usageFactsOf({ text: fullText, family: d.Family, range, props: d });
    st.shot = shotOf(st);
    st.props = scalarProps(d);
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
    const newspaperHp = numOf(d.NewspaperHealth) || 0;
    const shieldHp = armorHp + newspaperHp;
    const hp = numOf(d.Toughness);
    const alm = almanacFacts(b, 'zombie', type);
    const almText = [alm.introduction, ...alm.special.map((x) => x.text)].filter(Boolean).join(' ');
    const names = featureName(b, 'zombie', type);
    // 免疫/召唤/Boss 这类“怕什么、会放什么”的事实：按字段名归类，新僵尸自动带上
    const behavior = zombieBehaviorFacts(d, { type });
    return {
      type,
      name: (names && names.zh) || type,
      nameEn: (names && names.en) || null,
      hp,
      armorDetail: armorDetail.length ? armorDetail : null,
      armorHp: armorHp || null,
      newspaperHp: newspaperHp || null,
      ehp: hp != null ? hp + shieldHp : null,
      speed: numOf(d.WalkSPS),
      eatDps: numOf(d.EatDPS),
      // 动态波用：WavePointCost = 这只占多少点数；Weight = 被抽中的权重
      wavePointCost: numOf(d.WavePointCost),
      weight: numOf(d.Weight),
      tags: zombieTagsFrom(d, almText),
      brief: alm.brief,
      introduction: alm.introduction,
      special: alm.special.map((x) => `${x.name || '特点'}：${x.text}`),
      weaknesses: alm.weaknesses,
      props: scalarProps(d),
      // 「怕什么 / 会放什么 / 是不是 Boss」——按字段族自动提取，新僵尸不用改代码
      immunities: behavior.immunities,
      spawns: behavior.spawns,
      flags: behavior.flags,
      boss: behavior.boss,
      behaviorText: zombieBehaviorLine(behavior),
      behaviorUnknown: behavior.unknownImmuneKeys,
      behaviors: {
        gazes: d.GazeDPS != null ? numOf(d.GazeDPS) : null,
        smashDamage: d.SmashDamage != null ? numOf(d.SmashDamage) : null,
        flyingSpeed: d.FlyingSpeed != null ? numOf(d.FlyingSpeed) : null,
        barrelType: d.BarrelType || null,
        impType: d.ImpType || null,
        newspaperHp: newspaperHp || null,
        enragedSpeedScale: numOf(d.EnragedSpeedScale),
        enragedDamageScale: numOf(d.EnragedDamageScale),
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

  // RTID(foo@ZombieTypes) → foo
  const codenameOfRTID = (v) => String(v == null ? '' : v).replace(/^RTID\(([^@()]+)@.*\)$/, '$1').trim() || null;

  /**
   * 把一个 wave 对象的 Zombies 数组折成 { counts, rowsHint }。
   * Row 有值 = 这一只固定在某行（Row 1-5 → lane 0-4）；没有 Row = 生成时随机行。
   */
  function foldWaveZombies(list) {
    const counts = {};
    const rowsHint = [];
    const detail = [];
    for (const z of Array.isArray(list) ? list : []) {
      const t = codenameOfRTID(z && z.Type);
      if (!t) continue;
      counts[t] = (counts[t] || 0) + 1;
      const row = numOf(z && z.Row);
      const lane = row == null ? null : row - 1;
      if (lane != null) rowsHint.push({ type: t, lane });
      detail.push({ type: t, lane, col: numOf(z && z.Column) });
    }
    return { counts, rowsHint, detail };
  }

  function seedBankPresets(objs) {
    const out = [];
    for (const o of objs) {
      const cls = String((o && o.objclass) || '');
      if (cls !== 'SeedBankProperties' && cls !== 'ConveyorSeedBankProperties') continue;
      const decks = (o.objdata && o.objdata.CardDecks) || null;
      if (!decks || typeof decks !== 'object') continue;
      for (const [tier, list] of Object.entries(decks)) {
        if (!Array.isArray(list)) continue;
        for (const d of list) {
          if (!d || !Array.isArray(d.Plants)) continue;
          out.push({
            tier, leader: numOf(d.Leader),
            name: textOf(d.Name) || null,
            plants: d.Plants.map((p) => String(p)),
          });
        }
      }
    }
    return out;
  }

  function levelScriptOf(lvl) {
    const objs = lvl && Array.isArray(lvl.currentLevelObjects) ? lvl.currentLevelObjects : [];
    if (!objs.length) return null;
    if (levelCache.has(objs)) return levelCache.get(objs);
    const waves = new Map();
    const modules = [];
    let waveCount = null;
    let flagInterval = null;
    const manager = {
      firstWaveSecs: null, hugeWaveDelay: null,
      minNextHealth: null, maxNextHealth: null,
      spendingPoints: null, spendingIncrement: null,
    };
    let dynamicRules = null;
    for (const o of objs) {
      const cls = String((o && o.objclass) || '');
      const alias = (o && o.aliases && o.aliases[0]) || '';
      const data = (o && o.objdata) || {};
      if (cls && !/^Wave/.test(cls)) modules.push({ cls, alias });
      if (cls === 'WaveManagerProperties') {
        waveCount = numOf(data.WaveCount);
        flagInterval = numOf(data.FlagWaveInterval);
        manager.firstWaveSecs = numOf(data.ZombieCountdownFirstWaveSecs);
        manager.hugeWaveDelay = numOf(data.ZombieCountdownHugeWaveDelay);
        manager.minNextHealth = numOf(data.MinNextWaveHealthPercentage);
        manager.maxNextHealth = numOf(data.MaxNextWaveHealthPercentage);
        manager.spendingPoints = numOf(data.WaveSpendingPoints);
        manager.spendingIncrement = numOf(data.WaveSpendingPointIncrement);
        continue;
      }
      if (cls === 'WaveManagerModuleProperties') {
        if (Array.isArray(data.DynamicZombies)) dynamicRules = data.DynamicZombies;
        continue;
      }
      // 静态波 "Wave7"；动态生成出来的整波是 "Wave7DynamicZombies"
      const m = /^Wave(\d+)(DynamicZombies)?$/.exec(alias);
      if (!m || !Array.isArray(data.Zombies)) continue;
      const n = Number(m[1]);
      const cur = waves.get(n) || {
        n, zombies: {}, total: 0, rowsHint: [], rowsAreHint: true,
        extraFood: null, dynamicExtra: {}, dynamicZombies: {},
      };
      const folded = foldWaveZombies(data.Zombies);
      for (const [t, c] of Object.entries(folded.counts)) {
        cur.zombies[t] = (cur.zombies[t] || 0) + c;
        cur.total += c;
      }
      cur.rowsHint.push(...folded.rowsHint);
      if (m[2]) {
        // 这一整波都是动态生成出来的
        for (const [t, c] of Object.entries(folded.counts)) cur.dynamicZombies[t] = (cur.dynamicZombies[t] || 0) + c;
      }
      cur.extraFood = numOf(data.AdditionalPlantfood) || numOf(data.ExtraPlantFood) || cur.extraFood;
      waves.set(n, cur);
    }
    const waveList = [...waves.values()].sort((a, b) => a.n - b.n);

    // 关卡原始 JSON（动态波是在副本上追加的）：用来分出「本局额外生成」的部分。
    let staticWaves = null;
    let assetName = null;
    try {
      const src = lvl && lvl.Level && lvl.Level.json;
      if (src && Array.isArray(src.objects)) {
        assetName = (lvl.Level.name || lvl.Level._name || null);
        staticWaves = {};
        for (const o of src.objects) {
          const alias = (o && o.aliases && o.aliases[0]) || '';
          const m = /^Wave(\d+)$/.exec(alias);
          if (!m || !Array.isArray(o.objdata && o.objdata.Zombies)) continue;
          const folded = foldWaveZombies(o.objdata.Zombies);
          staticWaves[Number(m[1])] = folded.counts;
        }
      }
    } catch { /* ignore */ }

    const difficulty = numOf(lvl && lvl.difficulty);
    const ruleIndex = difficulty == null ? null : difficulty;
    const dynamicRule = (dynamicRules && ruleIndex != null && dynamicRules[ruleIndex]) || null;
    const hasDynamicRule = !!(dynamicRule && dynamicRule.ZombiePool);

    // 每波把静态/动态分开：dynamicExtra = 本局实际多出来的那几只（不是概率）
    if (staticWaves) {
      for (const w of waveList) {
        const base = staticWaves[w.n] || {};
        const extra = {};
        for (const [t, c] of Object.entries(w.zombies)) {
          const d = c - (base[t] || 0);
          if (d > 0) extra[t] = d;
        }
        w.dynamicExtra = extra;
      }
    }

    const lanes = lvl && Array.isArray(lvl.onlyLanesForRandomSpawn) ? lvl.onlyLanesForRandomSpawn.map(Number) : null;
    const def = objs.find((o) => o && o.objclass === 'LevelDefinition');
    const sm = def && def.objdata ? def.objdata.StageModule : null;
    const mm = typeof sm === 'string' ? /RTID\(([^@()]+)@/.exec(sm) : null;
    const lawn = lawnFacts(mm ? mm[1] : null);
    const value = {
      assetName,
      waveCount: waveCount || waveList.length,
      flagInterval,
      waves: waveList,
      lanePolicy: lanes ? { spawnLanes: lanes, random: lanes.length > 1 } : null,
      lawn,
      modules,
      manager,
      dynamic: {
        rules: Array.isArray(dynamicRules) ? dynamicRules.length : 0,
        difficulty,
        ruleIndex,
        active: hasDynamicRule,
        rule: hasDynamicRule ? {
          startingWave: numOf(dynamicRule.StartingWave),
          startingPoints: numOf(dynamicRule.StartingPoints),
          pointIncrement: numOf(dynamicRule.PointIncrementPerWave),
          pool: (dynamicRule.ZombiePool || []).map(codenameOfRTID).filter(Boolean),
        } : null,
        suppressedWaves: (lvl && Array.isArray(lvl.SuppressedDynamicZombieWaves) ? lvl.SuppressedDynamicZombieWaves.map(Number) : []),
      },
      seedBank: { presets: seedBankPresets(objs) },
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
