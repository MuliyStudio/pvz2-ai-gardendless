/**
 * 僵尸规则表：把 300+ 个 ZombieProps 字段里「会被机制影响」的那些翻译成结构化事实。
 *
 * 和 tags.js 的分工：
 *   - tags.js 给「这只僵尸有什么威胁」（滚动/飞行/巨人…），带能力需求；
 *   - 本文件给「这只僵尸怕什么/不怕什么、会召唤什么、是不是 Boss」。
 *
 * 只按字段名关键字归类；新僵尸只要字段名落在已知族里就自动带上，
 * 完全不认识的字段会以 raw key 的形式显示在 unknownFields 里（不吞掉）。
 */

const TEXT = {
  swallow: '不能被吞食',
  chomper: '不能被大嘴花吞',
  drag: '不能被拖拽/拉走',
  knockback: '不能被击退/推动',
  transform: '不能被变形（羊）',
  shrink: '不能被缩小',
  hypno: '不能被魅惑',
  garlic: '不吃大蒜',
  grab: '不能被抓起/带走',
  parrot: '不能被鹦鹉偷走',
  freeze: '免疫冰冻',
  chill: '免疫减速',
  lightning: '免疫电击',
  iceblock: '免疫冰块',
  sound: '免疫声波/音箱',
  mower: '不会被小推车正常清除',
  enlighten: '不能被点化',
  toss: '不能被抛掷/弹飞',
  gum: '不能被口香糖粘住',
  spore: '免疫孢子',
  attract: '不受吸引类（红薯）影响',
  detect: '不会被某些探针侦测到',
  fire: '免疫火焰',
  poison: '免疫毒',
  target: '不会被单体索敌类选中',
  zomboss: '不受僵尸博士机制影响',
  eat: '啃食相关特殊规则',
};

const IMMUNITY_RULES = [
  [/Swallow|Chomper|Chomped|Eaten/i, 'swallow'],
  [/Drag|TangleKelp|Pull/i, 'drag'],
  [/Knockback|KnockedBack|Citron|PushedBySlider|Tossed|Flicked|Flick|PowerToss|FanStorm|Carried/i, 'toss'],
  [/WitchHazel|Transform|Sheep/i, 'transform'],
  [/Shrink/i, 'shrink'],
  [/Hypno/i, 'hypno'],
  [/Garlic/i, 'garlic'],
  [/Ptero|Grabbed|Grab/i, 'grab'],
  [/Parrot/i, 'parrot'],
  [/Freeze/i, 'freeze'],
  [/Chill/i, 'chill'],
  [/Lightning|Bolt/i, 'lightning'],
  [/Iceblock|IceBlock/i, 'iceblock'],
  [/BoomBox|Speaker|Sound/i, 'sound'],
  [/Mow/i, 'mower'],
  [/Enlighten|SolarSage/i, 'enlighten'],
  [/Gummed|Gumnut/i, 'gum'],
  [/Spore/i, 'spore'],
  [/SweetPotato|Attract/i, 'attract'],
  [/Detect/i, 'detect'],
  [/HomingThistle|SnapPea|ThymeWarp/i, 'target'],
  [/Zomboss/i, 'zomboss'],
  [/Fire/i, 'fire'],
  [/Poison/i, 'poison'],
];

/** 以 Immune/Cannot/IgnoredBy 开头但和「这只僵尸怕什么」无关的字段：只影响刷怪/关卡生成。 */
const IMMUNITY_IGNORE_RE = /^(CannotCarryPlantfoodsInWaves)$/;

const IMMUNITY_KEY_RE = /^(Immune|Immunity|Cannot[A-Z]|IgnoredBy|DoesNotDamage|NotAffected)/;

/** 这些字段名虽然以 Type 结尾，但不是「召唤/发射物」，跳过。 */
const TYPE_SKIP_RE = /^(ProjectileProps|ZombieSort|JamStyle|BodyType|ArmorType|AttackType|EffectType|RideType|DeathType|WalkType|SkinType|SoundType)/;

/**
 * 从 ZombieProps 提取结构化行为。
 * 返回 { immunities, spawns, flags, boss, unknownImmuneKeys }
 */
export function zombieBehaviorFacts(props, ctx = {}) {
  const d = props || {};
  const immunities = [];
  const seen = new Set();
  const unknownImmuneKeys = [];
  for (const [key, value] of Object.entries(d)) {
    if (!IMMUNITY_KEY_RE.test(key)) continue;
    if (IMMUNITY_IGNORE_RE.test(key)) continue;
    // 免疫类字段常常是 true/false；false 就是「不免疫」，不算事实
    if (value === false || value === 0 || value == null) continue;
    const rule = IMMUNITY_RULES.find(([re]) => re.test(key));
    if (!rule) { unknownImmuneKeys.push(key); continue; }
    const id = rule[1];
    if (seen.has(id)) continue;
    seen.add(id);
    immunities.push({ id, text: TEXT[id] || id, key });
  }

  const spawns = [];
  const flags = {};
  for (const [key, value] of Object.entries(d)) {
    if (typeof value !== 'string' || !value) continue;
    if (TYPE_SKIP_RE.test(key)) continue;
    // 召唤/发射物：XxxType / XxxTypes（单个字符串）
    if (/^(Imp|Teammate|Summon|Spawn|Barrel|Missile|Bolt|BigBolt|Meteor|Projectile|Zombie|Plant|Child|Mini)Type(s)?$/.test(key)) {
      spawns.push({ key, type: value });
    }
  }

  // 少量“有就说明”的布尔/数值标志（字段名本身就是语义）
  for (const key of ['SpeedUpWhenEatPlants', 'LivesInDeepWater', 'CannotChangeLaneByPowerToss', 'ChillInsteadOfFreeze', 'IgnoresMower', 'CanFly']) {
    if (d[key] === true) flags[key] = true;
  }
  if (Number.isFinite(Number(d.FoeEatDamageReflectPct)) && Number(d.FoeEatDamageReflectPct) > 0) {
    flags.reflectEatPct = Number(d.FoeEatDamageReflectPct);
  }
  if (Number.isFinite(Number(d.TeamMemberCount)) && Number(d.TeamMemberCount) > 0) {
    flags.teamSize = Number(d.TeamMemberCount);
  }

  // Boss 只认真正带阶段的机制僵尸：ZombossLaneSummon 只是关卡机制，不算 Boss。
  const boss = (Array.isArray(d.ZombossStages) && d.ZombossStages.length > 0)
    || Number(d.ZombossMechLevel) > 0
    || /^zomboss/i.test(String(ctx.type || ''));

  return {
    immunities,
    spawns,
    flags,
    boss,
    unknownImmuneKeys: unknownImmuneKeys.slice(0, 6),
  };
}

/**
 * 一行话总结（给 prompt / 图鉴用），例如：
 * 「免疫冰冻/减速；会放小鬼；Boss」
 */
export function zombieBehaviorLine(facts) {
  if (!facts) return null;
  const bits = [];
  if (facts.boss) bits.push('Boss');
  if (facts.immunities.length) bits.push(facts.immunities.map((x) => x.text).join('/'));
  if (facts.spawns.length) bits.push(`会生成 ${facts.spawns.map((s) => s.type).join('/')}`);
  if (facts.flags && facts.flags.reflectEatPct) bits.push(`啃它会被反伤 ${facts.flags.reflectEatPct}%`);
  if (facts.flags && facts.flags.teamSize) bits.push(`成组 ${facts.flags.teamSize} 只`);
  return bits.length ? bits.join('；') : null;
}
