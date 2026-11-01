/**
 * crosscheck：纯函数的数据交叉校验 + 植物×僵尸配对事实。
 *
 * 目标不是“推荐打法”，而是让同一份事实有第二个来源可以对照：
 *  - 解析后的 stats（dps/multiDps/ehp/armor…） vs 原始 PlantProps/ZombieProps；
 *  - 植物字段 vs 僵尸字段（护甲、免疫、射程/遮挡、出土时间）；
 *  - 所有函数只返回事实和 issues，不决定种什么。
 *
 * 运行时由 bridge/stats.js 调用，结果挂在 stats.checks；
 * 快照再把 deck/当前僵尸的 issues 和配对数汇总进 brief.dataChecks / brief.matchups。
 */

const cxNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const r1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);

function issue(list, field, expected, actual, note) {
  if (expected == null || actual == null) return;
  const e = Number(expected);
  const a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a)) return;
  const tol = Math.max(Math.abs(e) * 0.06, 0.11);
  if (Math.abs(e - a) <= tol) return;
  list.push({ field, expected: r3(e), actual: r3(a), note: note || null });
}

/** 值本身是求和/原始字段，应该精确一致（只留浮点误差）。 */
function exact(list, field, expected, actual, note) {
  if (expected == null || actual == null) return;
  const e = Number(expected);
  const a = Number(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a)) return;
  if (Math.abs(e - a) <= 0.011) return;
  list.push({ field, expected: r3(e), actual: r3(a), note: note || null });
}

/**
 * 校验解析后的植物 stats 和原始 objdata 是否自洽。
 * 只比较“两边都有值”的字段；缺字段不报错（不同版本 JSON 字段不全）。
 */
export function checkPlantStats(st, d) {
  const issues = [];
  if (!st || !d) return { ok: true, issues };
  exact(issues, 'cost', cxNum(d.SunCost), st.cost, 'SunCost vs stats.cost');
  exact(issues, 'cooldown', cxNum(d.Cooldown), st.cd, 'Cooldown vs stats.cd');
  exact(issues, 'hp', cxNum(d.Toughness), st.hp, 'Toughness vs stats.hp');
  const arm = cxNum(d.ChargeTime) != null ? cxNum(d.ChargeTime)
    : (cxNum(d.ArmTime) != null ? cxNum(d.ArmTime) : cxNum(d.ExplodeDelay));
  if (arm != null && st.armTimeSec != null) exact(issues, 'armTimeSec', arm, st.armTimeSec, 'ChargeTime vs stats.armTimeSec');
  if (st.attack) {
    const dmg = cxNum(st.attack.dmg);
    const iv = cxNum(st.attack.interval);
    if (dmg != null && iv != null && iv > 0) {
      const dps = dmg / iv;
      issue(issues, 'attack.dps', dps, st.attack.dps, 'dmg/interval vs stats.attack.dps');
      const targets = cxNum(st.attack.targets) || 1;
      const hits = cxNum(st.attack.hitsPerTarget) || 1;
      issue(issues, 'attack.multiDps', dps * targets * hits, st.attack.multiDps,
        'dmg/interval × targets × hitsPerTarget vs stats.attack.multiDps');
    }
  }
  if (st.burst) {
    const rawDmg = cxNum(d.Damage) != null ? cxNum(d.Damage)
      : (cxNum(d.AttackDamage) != null ? cxNum(d.AttackDamage) : cxNum(d.StabDamage));
    if (rawDmg != null) exact(issues, 'burst.dmg', rawDmg, st.burst.dmg, 'raw Damage vs stats.burst.dmg');
    if (st.burst.area && /本格|Tile|3x3|3×3|1x3|1×3|全屏|三行|整行|本行/i.test(String(st.burst.area))
      && st.burst.areaTargets !== 'all_in_area') {
      issues.push({
        field: 'burst.areaTargets', expected: 'all_in_area', actual: st.burst.areaTargets || null,
        note: `area=${st.burst.area} 是范围结算，targets 不应被当成只能打一只`,
      });
    }
  }
  if (st.sun && st.sun.stages && st.sun.stages.length) {
    const iv = cxNum(st.sun.interval);
    const stage = cxNum(st.sun.stages[st.sun.stages.length - 1]);
    if (iv != null && iv > 0 && stage != null && st.sun.perSecDay) {
      const per = st.sun.perSecDay[st.sun.perSecDay.length - 1];
      issue(issues, 'sun.perSecDay', stage / iv, per, 'SunValue/interval vs stats.sun.perSecDay');
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 校验解析后的僵尸 stats 和原始 objdata 是否自洽。 */
export function checkZombieStats(z, d) {
  const issues = [];
  if (!z || !d) return { ok: true, issues };
  exact(issues, 'hp', cxNum(d.Toughness), z.hp, 'Toughness vs stats.hp');
  exact(issues, 'speed', cxNum(d.WalkSPS), z.speed, 'WalkSPS vs stats.speed');
  exact(issues, 'eatDps', cxNum(d.EatDPS), z.eatDps, 'EatDPS vs stats.eatDps');
  if (Array.isArray(z.armorDetail) && z.armorDetail.length) {
    const sum = z.armorDetail.reduce((s, a) => s + (cxNum(a.hp) || 0), 0);
    exact(issues, 'armorHp', sum, z.armorHp, 'armorDetail.hp 之和 vs stats.armorHp');
  }
  if (z.hp != null && z.armorHp != null && z.ehp != null) {
    exact(issues, 'ehp', z.hp + z.armorHp + (cxNum(z.newspaperHp) || 0), z.ehp,
      'hp + armorHp + newspaperHp vs stats.ehp');
  }
  if (Array.isArray(z.behaviorUnknown) && z.behaviorUnknown.length) {
    issues.push({
      field: 'behaviorUnknown', expected: 0, actual: z.behaviorUnknown.length,
      note: `未识别的免疫/行为字段：${z.behaviorUnknown.slice(0, 4).join('/')}`,
    });
  }
  return { ok: issues.length === 0, issues };
}

const IMMUNITY_IDS = {
  Cold: ['ice', 'freeze', 'cold', 'frozen'],
  Slow: ['slow', 'ice', 'freeze'],
  Fire: ['fire', 'burn'],
  Poison: ['poison', 'toxic'],
  Electricity: ['electric', 'lightning', 'shock'],
  Shadow: ['shadow', 'magic', 'curse'],
  Magic: ['magic', 'shadow'],
};

/**
 * 一对植物×僵尸的可执行事实：
 * - 单体/多目标 TTK、是否被护甲拖慢、是否被免疫/直线遮挡。
 * 不判断“该不该种”，只把字段交叉后的结果摊开。
 */
export function matchup(plantSt, zombieSt, ctx = {}) {
  if (!plantSt || !zombieSt) return null;
  const z = zombieSt;
  const ehp = cxNum(z.ehp) != null ? cxNum(z.ehp) : cxNum(z.hp);
  const atk = plantSt.attack || null;
  const burst = plantSt.burst || null;
  const dps = atk ? cxNum(atk.dps) : null;
  const multi = atk ? (cxNum(atk.multiDps) || dps) : null;
  const oneShot = burst ? cxNum(burst.dmg) : null;
  const ttk = dps != null && dps > 0 && ehp != null ? r1(ehp / dps) : null;
  const multiTtk = multi != null && multi > 0 && ehp != null ? r1(ehp / multi) : null;
  const burstTtk = oneShot != null && oneShot >= ehp ? 0 : null;
  const ignoresArmor = !!(plantSt.ignoresArmor || (atk && (atk.ignoresArmor || atk.trueDamage)));
  const armorHp = cxNum(z.armorHp) || 0;
  const family = String(plantSt.family || '');
  const ids = IMMUNITY_IDS[family] || (plantSt.damageType === 'true' ? ['armor'] : []);
  const immunity = (Array.isArray(z.immunities) ? z.immunities : []).find((im) => {
    const text = `${im && im.id || ''} ${im && im.text || ''} ${im && im.key || ''}`.toLowerCase();
    return ids.some((k) => text.includes(k));
  }) || null;
  const blocked = ctx.blocked === true || ctx.straightBlocked === true && !(plantSt.shot && plantSt.shot.overObstacle);
  const canDamage = (dps != null && dps > 0) || (oneShot != null && oneShot > 0);
  const verdict = !canDamage ? 'no_damage'
    : immunity ? 'immune'
      : blocked ? 'blocked'
        : (burstTtk === 0 || (ttk != null && ttk <= (ctx.budgetSec || 999))) ? 'good' : 'ok';
  const notes = [];
  if (immunity) notes.push(`免疫：${immunity.text || immunity.id}`);
  if (blocked) notes.push('直线弹道被遮挡');
  if (armorHp > 0 && !ignoresArmor) notes.push(`需先破甲 ${armorHp}`);
  if (multi != null && dps != null && multi > dps * 1.2) notes.push(`多目标 ${multi} dps`);
  return {
    plant: plantSt.type,
    zombie: z.type,
    ehp,
    dps,
    multiDps: multi,
    burstDmg: oneShot,
    singleTtk: ttk,
    multiTtk,
    burstKill: burstTtk === 0,
    ignoresArmor,
    armorHp: armorHp || null,
    immune: immunity ? { id: immunity.id || null, text: immunity.text || null } : null,
    blocked: !!blocked,
    verdict,
    notes,
  };
}

/**
 * 批量配对：plantTypes × zombieTypes。默认只取 deck 和当前场上僵尸，
 * 避免 200×300 的笛卡尔积；调用方可以传全量。
 */
export function buildMatchups(plantTypes, zombieTypes, plantStatsOf, zombieStatsOf, ctx = {}) {
  const out = [];
  for (const pt of [...new Set(plantTypes || [])]) {
    const ps = plantStatsOf ? plantStatsOf(pt) : null;
    if (!ps) continue;
    for (const zt of [...new Set(zombieTypes || [])]) {
      const zs = zombieStatsOf ? zombieStatsOf(zt) : null;
      if (!zs) continue;
      const m = matchup(ps, zs, ctx);
      if (m) out.push(m);
    }
  }
  return out;
}
