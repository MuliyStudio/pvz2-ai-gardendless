/**
 * 植物规则表：把「游戏资源的字段名」翻译成「模型能用来决策的语义」。
 *
 * 设计原则：
 *  1. 只写规则，不写具体卡名。新增植物只要字段落在已知字段族里就自动适配；
 *     完全没见过的字段会落到 unknown（并带原始字段名），不会静默变成 null。
 *  2. 所有推算都标 confidence：high=有显式数值字段，medium=按家族/图鉴推断，
 *     low=只有图鉴文案。低置信度只用于展示，不用于拦截动作。
 *  3. 这里只有事实与分类，不做“该不该选/该不该给豆”的判断。
 */

const prNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const prFirst = (props, keys) => {
  for (const k of keys) {
    const v = prNum(props && props[k]);
    if (v != null) return { key: k, value: v };
  }
  return null;
};
/** 与 prFirst 相同，但只接受 > 0：伤害/间隔为 0 等于没写。 */
const prFirstPos = (props, keys) => {
  for (const k of keys) {
    const v = prNum(props && props[k]);
    if (v != null && v > 0) return { key: k, value: v };
  }
  return null;
};
const prHasKey = (props, re) => Object.keys(props || {}).some((k) => re.test(k));

// ─────────────────────────────────────────────────────────────
// 伤害值 / 间隔：字段族
// ─────────────────────────────────────────────────────────────

/** 每一下的伤害（不是每秒）。顺序 = 优先级。 */
export const DAMAGE_HIT_FIELDS = [
  'Damage', 'AttackDamage', 'NormalAttackDamage', 'ShadowAttackDamage',
  'StabDamage', 'DamagePerHit', 'HeadDamage', 'SlapDamage', 'TongueSlapDamage',
  'SmashDamage', 'ExplodeDamage', 'ExplosionDamage', 'FlameDamage', 'ArmorDamage',
  'DeathRayDamage', 'GhostDamage', 'ButterDamage', 'ZombieDamage', 'DamageHeavy',
];

/** 本身就是「每秒伤害」的字段。 */
export const DAMAGE_DPS_FIELDS = ['DPS', 'AttackDPS', 'FireDPS'];

/** 攻击间隔（秒）。 */
export const ATTACK_INTERVAL_FIELDS = [
  'AttackInterval', 'ShootInterval', 'ThrowInterval', 'StabInterval',
  'DamageInterval', 'DirectDamageInterval', 'NormalAttackInterval',
  'ShadowAttackInterval', 'PeaInterval', 'ProjectileInterval', 'ShootIntervalSemi',
];

/** 持续时间（秒）：DPS 型 / 领域型伤害的有效时长。 */
export const ATTACK_DURATION_FIELDS = ['AttackDuration', 'ShootDuration', 'DamageDuration'];

/**
 * 伤害模型。返回：
 *   attack  = 持续输出（有 dps，供 lanes/brief 直接求和）
 *   burst   = 单次结算伤害（一次性卡/点击发射卡，不参与 dps 求和）
 *   damageType / ignoresArmor / armorState = 伤害与护甲的关系
 */
export function damageModel(props, ctx = {}) {
  const d = props || {};
  // 图鉴 DAMAGE 是最后兜底：很多卡属性里不写伤害，只写 PeaType 或只写图鉴。
  const almanacDmg = prNum(ctx.almanacDmg);
  const hit = prFirstPos(d, DAMAGE_HIT_FIELDS)
    || (almanacDmg != null && almanacDmg > 0 ? { key: 'almanac.DAMAGE', value: almanacDmg } : null);
  const dpsField = prFirstPos(d, DAMAGE_DPS_FIELDS);
  const intervalField = prFirstPos(d, ATTACK_INTERVAL_FIELDS);
  const durationField = prFirstPos(d, ATTACK_DURATION_FIELDS);
  const interval = intervalField ? intervalField.value : null;
  const duration = durationField ? durationField.value : null;

  let attack = null;
  let burst = null;
  let basis = null;

  if (hit && interval > 0) {
    const dps = Math.round((hit.value / interval) * 10) / 10;
    attack = {
      dmg: hit.value, interval, dps,
      durationSec: duration, basis: 'dmg/interval',
    };
    basis = 'dmg/interval';
  } else if (dpsField) {
    const dps = dpsField.value;
    attack = {
      dmg: duration && dps ? Math.round(dps * duration) : null,
      interval: null, dps,
      durationSec: duration,
      // dps × 持续秒数 = 这一轮能打出的总量；没有 duration 时按 1 秒计
      totalDamage: Math.round(dps * (duration || 1)),
      basis: 'dps',
    };
    basis = 'dps';
  } else if (hit && duration && duration > 0) {
    // 只有伤害 + 时长（没有间隔）：当作一次性结算
    burst = { dmg: hit.value, durationSec: duration, basis: 'dmg/duration' };
    basis = 'dmg/duration';
  } else if (hit) {
    // 有伤害但没有间隔 = 单次结算（樱桃/辣椒/椰子炮/大嘴这类）。
    // 宁可给一个「单发伤害」，也不要让模型看到 null。
    burst = { dmg: hit.value, basis: 'single' };
    basis = 'single';
  }

  // ── 伤害与护甲的关系 ──
  const text = String(ctx.text || '');
  const poison = ctx.poison || null;
  const projectileTrue = !!ctx.projectileTrue;
  const explicitTrue = prHasKey(d, /^(SupressArmorProtection|SuppressArmorProtection|IgnoresArmor|TrueDamage|IgnoreArmor)$/);
  const explicitTrueOn = explicitTrue && Object.entries(d)
    .some(([k, v]) => /^(SupressArmorProtection|SuppressArmorProtection|IgnoresArmor|TrueDamage|IgnoreArmor)$/.test(k) && v === true);
  // 吸血/吸能型：家族 Poison + DPS 字段，或图鉴写明“吸取血量/吸血”
  const drain = /吸取.{0,6}(血量|生命|血)|吸血|抽取.{0,4}血量|drain(s)?\s+(hp|health)/i.test(text)
    || (String(ctx.family || '') === 'Poison' && !!dpsField);

  let damageType = 'normal';
  if (drain) damageType = 'drain';
  else if (poison) damageType = 'poison';
  else if (projectileTrue || explicitTrueOn) damageType = 'true';

  const ignoresArmor = damageType === 'drain' || damageType === 'true' || !!poison;
  // armorState：yes=确定无视护甲，no=确定要打护甲，unknown=没有足够证据（新卡/新字段别乱猜）
  const knownMechanism = !!ctx.hasProjectile
    || /Melee|Sharp|Explosive|Fire|Poison|Peashooter|Lobber|Magic|Cold|Slow|Defence|Electricity|Shadow|Sun|Nope/i.test(String(ctx.family || ''));
  const armorState = ignoresArmor ? 'yes'
    : (attack || burst) ? (knownMechanism ? 'no' : 'unknown')
      : 'none';

  return {
    attack, burst, damageType, ignoresArmor, armorState,
    damageBasis: basis,
    fields: {
      hit: hit ? hit.key : null,
      dps: dpsField ? dpsField.key : null,
      interval: intervalField ? intervalField.key : null,
      duration: durationField ? durationField.key : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 能量豆（plant food）：字段族 → 效果类别 + 范围
// ─────────────────────────────────────────────────────────────

/** 出现任意一个就算「这株有专属能量豆效果」。 */
export const PLANTFOOD_ANY_RE = /plantfood/i;

const PF_NUM = {
  dmgPerHit: ['DamagePlantfood', 'PlantfoodDamage', 'PlantfoodDamagePerHit', 'DamagePerHitPlantfood', 'StabDamagePlantfood', 'ButterDamagePlantfood'],
  hits: ['PlantfoodHitCount', 'ShootCountPlantfood', 'ShootCount', 'PlantFoodPeaCount', 'PlantfoodPeaCount'],
  dps: ['PlantfoodDPS', 'PlantFoodDPS', 'DPSPlantfood', 'PlantfoodSideDPS', 'PlantFoodSplashDPS', 'PFDPS', 'PlantfoodRayDamage'],
  duration: ['PlantfoodDuration', 'PlantfoodTime', 'PlantFoodDurationSeconds', 'PFDuration', 'AttackDurationPlantfood', 'PlantfoodLastingTime'],
  chance: ['ChanceToPlantfood'],
  heal: ['HealthPlantfoodHeal', 'HealHPSPlantfood', 'HealthPerHeal'],
  armor: ['ToughnessPlantfooded'],
};

const PF_RULES = [
  { kind: 'freeze', re: /^(PlantfoodFreezeDuration|FreezeDurationPlantfood|FreezeTime|PlantfoodChillDuration|ChillDurationPlantfood|Mint3x3Freezing)$/, area: 'row' },
  { kind: 'stun', re: /^(PlantfoodStunDuration|StunDurationPlantfood|StunDurationPF|ChiliStunDuration|PlantfoodSmashTime|SmashTime|DetectDistancePlantfood|DisgustDurationPlantfood)$/, area: 'row' },
  { kind: 'control', re: /^(PlantfoodKnockbackSPS|PlantfoodDragSPS|PlantfoodPullSPS|PlantfoodPushSPS|PlantfoodKnockBackDistance|PlantfoodTossChance|PlantfoodPullDuration|PlantfoodPushDuration|PlantfoodKnockbackSPS|PlantfoodFlickCount|PlantfoodAttractWidth|MaxDraggedZombieCountPlantfood|PlantfoodAbsorbDuration)$/, area: 'row' },
  { kind: 'execute', re: /^(KillCountPlantfood|PlantfoodSwallowCount|ZombieCountPerSwallow|PlantfoodDamageReceiveMult|KillCountPerAttack|PlantFoodLightningBoltDamage|PlantfoodThrowDamage)$/, area: 'target' },
  { kind: 'heal', re: /^(HealHPSPlantfood|HealthPlantfoodHeal|HealthPerHeal|HealInterval)$/, area: 'self' },
  { kind: 'self_armor', re: /^(ToughnessPlantfooded|ArmorToughness|ExtraHealingTime)$/, area: 'self' },
  { kind: 'sun_burst', re: /^(PlantfoodSunValuePerZombie|SunValuePerZombiePF|SunProducePerZombiePF|PlantfoodEnlightenCount|EnlightenSunValue)$/, area: 'self' },
  { kind: 'summon', re: /^(PlantfoodChildrenCount|SummonTypePlantfood|PlantfoodSummonCount|PlantfoodSwarm|PlantfoodCallingType)$/, area: 'self' },
  { kind: 'self_aoe_dot', re: /^(PlantfoodDPS|PlantFoodDPS|DPSPlantfood|PlantfoodSideDPS|PlantFoodSplashDPS|PFDPS|PlantfoodRayDamage|PlantfoodGumProjectileCount|PlantfoodDamageMult|PlantFoodCloudSpeed)$/, area: 'self_aoe' },
  { kind: 'self_aoe_multi', re: /^(DamagePlantfood|PlantfoodDamage|PlantfoodDamagePerHit|DamagePerHitPlantfood|StabDamagePlantfood|ButterDamagePlantfood|PlantfoodDamageNear|PlantfoodDamageFar|PlantDamagePlantfood|ZombieDamagePlantfood)$/, area: 'self_aoe' },
  { kind: 'barrage', re: /^(PeaTypePlantfood|PeaTypePlantfood0|PeaTypesPlantfood|PeaCountPerShotPlantfood|PlantfoodPeaCount|PeaCountPlantfood|PlantfoodShootTime|PeaSpeedPlantfood|PlantfoodPeaCountBack|BowlingPlantfood|PlantfoodLightningCount)$/, area: 'row' },
  { kind: 'lob_barrage', re: /^(CabbageTypePlantfood|PlantfoodProjectilesToFire|SporeTypePlantfood|ShroomTypePlantfood|BoomerangType|PlantfoodBoomerangCount|HollyProjectileTypePlantfood|TornadoTypePlantfood|PlantfoodSporeCount)$/, area: 'row' },
  { kind: 'buff', re: /^(PlantfoodDurationExtendPerProducer|PerfumeDurationPlantfood|AttackDurationPlantfood|PlantfoodLastingTime|WarmingRadiusPlantfood|PlantfoodDuration|PlantfoodTime|PlantFoodDurationSeconds|PFDuration|PlantfoodDistance|TileButterDurationPlantfood|PlantfoodFireCount|PlantfoodMaxSpike)$/, area: 'aura' },
];

/** 图鉴 AREA 文案 → 范围类别。 */
export function areaFromText(areaText, rangeText) {
  const a = String(areaText || '');
  const r = String(rangeText || '');
  if (/全屏|全场|所有僵尸/.test(a + r)) return { area: 'full', radius: null };
  if (/3x3|3×3|周围|身边/.test(a + r)) return { area: 'self_aoe', radius: 1 };
  if (/本格|这一格/.test(a)) return { area: 'self_tile', radius: 0 };
  if (/整行|本行|直线/.test(a + r)) return { area: 'row', radius: null };
  if (/多行|三行|三线/.test(a + r)) return { area: 'multi_row', radius: null };
  if (/接近|前后|接触/.test(r)) return { area: 'self_aoe', radius: 1 };
  return { area: null, radius: null };
}

/**
 * 能量豆事实。没有专属效果时返回 null（花盆/睡莲/纯墙）。
 * kind/area/radius/total 都是决策要用的；unknown 只代表“没看懂字段”，不代表没效果。
 */
export function kindFromAlmanac(text) {
  const s = String(text || '');
  if (!s) return null;
  if (/盔甲|armor/i.test(s)) return 'self_armor';
  if (/分身|duplicat/i.test(s)) return 'summon';
  if (/吸引子弹|projectile/i.test(s)) return 'taunt';
  if (/隐形|hidding|hidden/i.test(s)) return 'buff';
  if (/范围扩大|range expand/i.test(s)) return 'buff';
  if (/治疗|回血|heal/i.test(s)) return 'heal';
  if (/全屏|full-screen|full screen/i.test(s)) return 'nuke';
  if (/冻结|freeze/i.test(s)) return 'freeze';
  if (/眩晕|stun/i.test(s)) return 'stun';
  if (/阳光|sun/i.test(s)) return 'sun_burst';
  if (/连射|弹幕|barrage/i.test(s)) return 'barrage';
  return null;
}

export function plantFoodFacts(props, ctx = {}) {
  const d = props || {};
  const hasPF = prHasKey(d, PLANTFOOD_ANY_RE);
  const almPf = ctx.almanacPlantFood || null;
  if (!hasPF && !almPf) return null;

  let rule = null;
  let matchedKey = null;
  for (const r of PF_RULES) {
    const k = Object.keys(d).find((key) => r.re.test(key) && d[key] != null);
    if (k) { rule = r; matchedKey = k; break; }
  }

  // 没有命中数值规则时，用家族/图鉴文案兜底（仍然算「知道这是能量豆效果」）。
  const family = String(ctx.family || '');
  let kind = rule ? rule.kind : null;
  let confidence = rule ? 'high' : 'low';
  if (kind === 'buff' && family === 'Sun') kind = 'sun_burst';
  if (!kind) {
    const almKind = kindFromAlmanac(almPf);
    if (almKind) { kind = almKind; confidence = 'medium'; }
    else if (family === 'Sun') { kind = 'sun_burst'; confidence = 'medium'; }
    else if (family === 'Defence') { kind = 'self_armor'; confidence = 'medium'; }
    else if (family === 'Cold' || family === 'Slow') { kind = 'freeze'; confidence = 'medium'; }
    else { kind = 'unknown'; confidence = 'low'; }
  }
  // 图鉴写了能量豆短语时优先采用（它描述的是这个效果本身）
  const almKind = kindFromAlmanac(almPf);
  if (almKind && almKind !== kind && confidence !== 'high') { kind = almKind; confidence = 'medium'; }
  if (kind === 'nuke' && !area) { area = 'full'; radius = null; }

  // 范围：显式字段 > 图鉴 AREA/RANGE > 家族
  // 注意：图鉴 AREA 常常描述的是「这一个效果的爆炸范围」，不等于能量豆的范围
  // （例如椰子炮 AREA=3x3 是炮弹爆炸，它的能量豆是本行连射），所以只让「全屏」优先覆盖。
  let area = rule ? rule.area : null;
  let radius = area === 'self_aoe' ? 1 : (area === 'self_tile' ? 0 : null);
  const fromText = areaFromText(ctx.almanacArea, ctx.almanacRange);
  if (fromText.area === 'full') {
    area = 'full';
    radius = null;
  } else if (!rule && fromText.area) {
    area = fromText.area;
    radius = fromText.radius;
    if (confidence === 'high') confidence = 'medium';
  } else if (!area) {
    if (family === 'Peashooter' || family === 'Lobber' || family === 'Magic') area = 'row';
    else if (family === 'Melee' || family === 'Sharp') { area = 'self_aoe'; radius = 1; }
    else area = 'self';
    confidence = confidence === 'high' ? 'medium' : confidence;
  }

  const dmgPerHit = prFirst(d, PF_NUM.dmgPerHit);
  const hits = prFirst(d, PF_NUM.hits);
  const dps = prFirst(d, PF_NUM.dps);
  const duration = prFirst(d, PF_NUM.duration);
  const chance = prFirst(d, PF_NUM.chance);
  const heal = prFirst(d, PF_NUM.heal);
  const armor = prFirst(d, PF_NUM.armor);

  let total = null;
  if (dmgPerHit && hits) total = dmgPerHit.value * hits.value;
  else if (dmgPerHit && duration && kind === 'self_aoe_dot') total = dmgPerHit.value * duration.value;
  else if (dps && duration) total = Math.round(dps.value * duration.value);
  else if (dps) total = dps.value;
  else if (dmgPerHit) total = dmgPerHit.value;

  return {
    kind, area,
    radius,
    total: total != null ? Math.round(total) : null,
    dmgPerHit: dmgPerHit ? dmgPerHit.value : null,
    hits: hits ? hits.value : null,
    dps: dps ? dps.value : null,
    durationSec: duration ? duration.value : null,
    heal: heal ? heal.value : null,
    armorHp: armor ? armor.value : null,
    chance: chance ? chance.value : null,
    almanac: almPf || null,
    fields: [matchedKey].filter(Boolean),
    confidence,
  };
}

/** 这一发能量豆「值不值」：只做几何判断，不做策略。 */
export function plantFoodTargets(food, plant, zombies) {
  if (!food) return null;
  const list = Array.isArray(zombies) ? zombies : [];
  const lane = Number(plant && plant.lane);
  const column = Number(plant && plant.column);
  if (!Number.isFinite(lane) || !Number.isFinite(column)) return null;
  const inRange = (z) => {
    const zl = Number(z.lane), zc = Number(z.column);
    if (!Number.isFinite(zl) || !Number.isFinite(zc)) return false;
    switch (food.area) {
      case 'full': return true;
      case 'row': return zl === lane && zc >= column;
      case 'target': return zl === lane && zc >= column;
      case 'multi_row': return zc >= column;
      case 'self_tile': return zl === lane && Math.abs(zc - column) < 0.75;
      case 'self_aoe': {
        const r = food.radius == null ? 1 : Number(food.radius);
        return Math.abs(zl - lane) <= r && Math.abs(zc - column) <= r + 0.75;
      }
      case 'self': return false;
      case 'aura': return Math.abs(zl - lane) <= 1 && zc >= column - 1;
      default: return false;
    }
  };
  const targets = list.filter(inRange);
  return { count: targets.length, cells: targets.map((z) => ({ lane: z.lane, column: z.column })) };
}

// ─────────────────────────────────────────────────────────────
// 激活方式（自动 / 点击 / 只能种墓碑 / 被啃食触发）
// ─────────────────────────────────────────────────────────────

const AIM_RULES = [
  [/换位|交换位置|互换位置|swap/i, 'swap'],
  [/在不承载植物的情况下.{0,6}移动|推动.{0,4}植物|move again/i, 'move'],
  [/点击.{0,8}(任意一格|目标格子|选择一格|瞄准)|再点击|选择一格发射|tap to aim/i, 'free_cell'],
  [/沿.{0,2}本行|本行发射|整行发射/i, 'lane'],
];

const ACTIVATION_RULES = [
  [/点击消耗阳光|消耗阳光(发射|攻击)|花费阳光.{0,4}发射|点击.{0,6}花费阳光|tap to spend/i, 'click_sun'],
  [/点击后|点击发射|点击向前|点击喷火|点击冻结|点击攻击|点击触发|点击释放|点击瞄准|再点击|点击.{0,10}(发射|喷火|冻结|攻击|移动)|tap to (fire|shoot|activate)|press to/i, 'click'],
  [/必须种植在墓碑|种植在墓碑上|only on (a )?tomb/i, 'on_tomb'],
  [/种植在冰块上|融化这?块?冰块|only on ice/i, 'on_ice'],
  [/被啃食|吃掉后|被吃掉后|吃下后|when eaten/i, 'contact'],
  // 兜底：任何「点击/轻触」描述都算手动激活（宁可多认，也不要让点击卡变成只能种不能用）。
  [/点击|轻触|tap to/i, 'click'],
];

const AREA_RULES = [
  [/3x3|3×3|周围|身边/, 'aoe3x3'],
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

/**
 * 用法事实：activation / aim / area / needs。
 * text 传图鉴 brief + introduction + special 拼起来的文本（缺字段就自然落 auto）。
 * 注意：函数名带 Of 后缀，避免和 bridge/stats.js 的兼容导出重名（bundle 是同一作用域）。
 */
export function usageFactsOf(ctx = {}) {
  const text = String(ctx.text || '');
  const props = ctx.props || {};
  let activation = (ACTIVATION_RULES.find(([re]) => re.test(text)) || [null, 'auto'])[1];
  // floawerPot 这类「点击移动」的卡文案里没有“发射/冻结”等动作词，靠兜底规则命中；
  // 但“被啃食/吃掉后”也可能提到点击，优先保留已识别的特殊激活方式。
  if (activation === 'click' && /被啃食|吃掉后|被吃掉后|吃下后/.test(text) && !/点击/.test(text)) activation = 'contact';
  const manual = activation === 'click' || activation === 'click_sun';
  let aim = null;
  if (manual) {
    aim = (AIM_RULES.find(([re]) => re.test(text)) || [null, 'self'])[1];
    // 家族兜底：投手/直线型点击卡默认打本行
    if (aim === 'self' && /Lobber|Peashooter/i.test(String(ctx.family || ''))) aim = 'lane';
  }
  let area = (AREA_RULES.find(([re]) => re.test(text)) || [null, 'single'])[1];
  // 近战家族按“身边”描述，不按“身前”当成整行
  if (area === 'lane' && /Melee|Sharp/i.test(String(ctx.family || ''))) area = 'nearby';
  const needs = NEED_RULES.filter(([re]) => re.test(text)).map(([, n]) => n);

  // 点击卡的可点次数：由字段直接给（没有就 null，不猜）
  const charges = prFirst(props, ['MaxProjectileCount', 'MaxProjectiles', 'MaxShots', 'MaxSpike', 'MaxKills', 'ReloadClips', 'MaxClips']);
  const restSec = prFirst(props, ['RestTime', 'ReloadInterval', 'RechargeTime', 'ReloadingTime', 'AmmoRefreshTime', 'AttackCooldownBetween']);
  const fireCost = prFirst(props, ['ShootSunCost']);

  return {
    activation,
    aim,
    area,
    needs,
    manual,
    onlyTomb: activation === 'on_tomb',
    onlyIce: activation === 'on_ice',
    contact: activation === 'contact',
    charges: charges ? charges.value : null,
    restSec: restSec ? restSec.value : null,
    fireCost: fireCost ? fireCost.value : null,
  };
}

/** 一次性/瞬发卡（种下立刻结算）：用于把「没有 interval 但有伤害」的卡归到 burst。 */
export function isInstantCard(family, text) {
  return /Explosive/i.test(String(family || '')) || /一次性|立刻|instant/i.test(String(text || ''));
}
