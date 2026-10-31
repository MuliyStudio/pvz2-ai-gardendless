/**
 * mechanics：纯计算层。
 *
 * 输入数字/事实，输出数字/结构化判断；不读游戏对象、不做策略选择。
 * 目标：LLM 不再自己算速度、EHP/DPS、到达时间、出土窗口、克制卡覆盖。
 */
import { TAG_COUNTERS, CAPABILITY_FACTS } from '../knowledge/worlds.js';
import { TAG_CAPABILITIES } from '../knowledge/tags.js';

/** 高 DPS 的判定线：只用于“这张卡能不能算高单体输出”的事实分类，不是推荐。 */
const HIGH_DPS = 40;
const HIGH_MULTI_DPS = 80;
const WALL_RE = /peanut|tallnut|wallnut|holonut|endurian/i;
const MULTI_LANE_TEXT = /三行|多行|三线|整行|全屏/;

const roundTenth = (v) => Math.round(Number(v) * 10) / 10;
const textOfPlant = (st) => [st && st.name, st && st.brief, ...((st && st.special) || [])].filter(Boolean).join(' ');

/** 走完 distance 格需要多少秒；speed 单位格/秒。 */
export function travelSec(distance, speed) {
  const d = Number(distance);
  const s = Number(speed);
  if (!Number.isFinite(d) || !Number.isFinite(s) || s <= 0) return null;
  return Math.max(0, Math.round((d / s) * 10) / 10);
}

/** 击杀需要多少秒；dps<=0 返回 null。 */
export function ttkSec(ehp, dps) {
  const e = Number(ehp);
  const d = Number(dps);
  if (!Number.isFinite(e) || !Number.isFinite(d) || d <= 0) return null;
  return Math.max(0, Math.round((e / d) * 10) / 10);
}

/** 当前输出能否在僵尸到房子前杀掉它。 */
export function canKillBeforeHouse({ ehp, dps, column, speed }) {
  const killSec = ttkSec(ehp, dps);
  const etaSec = travelSec(column, speed);
  return {
    killSec,
    etaSec,
    ok: killSec != null && etaSec != null ? killSec <= etaSec : null,
  };
}

/**
 * 地雷类卡的出土窗口。
 * 返回 latestColumn：在这一列（或更左）种，僵尸到达前来得及出土。
 */
export function armWindow({ armTimeSec, leadSec = 0, plantColumn, zombie }) {
  const arm = Number(armTimeSec) || 0;
  const lead = Number(leadSec) || 0;
  const col = Number(plantColumn);
  const zc = Number(zombie && zombie.column);
  const speed = Number(zombie && zombie.speed) || 0.18;
  const need = arm + lead + 1;
  const etaSec = Number.isFinite(zc) && Number.isFinite(col) ? travelSec(zc - col, speed) : null;
  const latestColumn = Number.isFinite(zc) ? Math.max(0, Math.floor(zc - need * speed)) : null;
  return {
    armTimeSec: arm,
    needSec: need,
    etaSec,
    latestColumn,
    feasible: etaSec != null ? etaSec >= need : null,
  };
}

/**
 * 给定僵尸类型和卡组，算出“每类威胁有哪些卡能处理、缺哪类”。
 * zombieStatsOf(type) 返回 { tags, name, ... }。
 */
export function counterMatrix({ types = [], deck = [], zombieStatsOf } = {}) {
  const out = [];
  const deckSet = new Set(deck);
  for (const type of [...new Set(types)].filter(Boolean)) {
    let st = null;
    try { st = zombieStatsOf ? zombieStatsOf(type) : null; } catch { st = null; }
    if (!st) continue;
    const tags = Array.isArray(st.tags) ? st.tags : [];
    const counters = tags
      .map((tag) => ({ tag, ...(TAG_COUNTERS[tag] || null) }))
      .filter((c) => c && c.text);
    const required = [...new Set(counters.flatMap((c) => c.plants || []))];
    const answers = required.filter((p) => deckSet.has(p));
    const missingTags = counters
      .filter((c) => Array.isArray(c.plants) && c.plants.length && !c.plants.some((p) => deckSet.has(p)))
      .map((c) => c.tag);
    out.push({
      type,
      name: st.name || type,
      tags,
      counters: counters.map((c) => ({ tag: c.tag, text: c.text, plants: c.plants || [] })),
      requiredPlants: required,
      deckAnswers: answers,
      missingTags,
    });
  }
  return out;
}

/** 每行“能不能在到房子前清掉最前僵尸”的纯计算。 */
export function laneMath({ lanes = [], zombies = [] } = {}) {
  return lanes.map((l) => {
    const zs = zombies.filter((z) => z.lane === l.lane);
    const front = zs.sort((a, b) => a.column - b.column)[0] || null;
    const dpsUsed = zs.length >= 2 && l.dpsGroup != null ? l.dpsGroup : l.dps;
    const ehp = front ? (front.ehp != null ? front.ehp : front.ehpMax) : null;
    const math = front ? canKillBeforeHouse({ ehp, dps: dpsUsed, column: front.column, speed: front.speed }) : { killSec: null, etaSec: null, ok: null };
    return {
      lane: l.lane,
      frontType: front ? front.type : null,
      frontColumn: front ? front.column : null,
      ehp,
      dps: dpsUsed,
      dpsSingle: l.dps,
      dpsGroup: l.dpsGroup,
      killSec: math.killSec,
      etaSec: math.etaSec,
      canKillBeforeHouse: math.ok,
      wallHp: l.wallHp,
      gap: l.gap,
      lossIn: l.lossIn,
    };
  });
}

/**
 * 一张卡提供哪些能力：从数值（targets/pierceCount/dps/splash/reach/armTime/射程文本）
 * 加 TAG_COUNTERS 里“这张卡能处理某机制”的事实推导。
 * 不判断强弱，也不判断该不该带。
 */
export function cardCapabilities(type, st) {
  const caps = new Set();
  if (!st) return [];
  const fam = String(st.family || '');
  const atk = st.attack || null;
  if (fam === 'Sun' || (st.sun && st.sun.stages)) caps.add('economy');
  if (fam === 'Defence' || (st.hp || 0) >= 1000) caps.add('wall');
  if (atk) {
    if ((atk.targets || 1) > 1) caps.add('multi_target');
    if ((atk.pierceCount || 1) > 1) caps.add('pierce');
    if ((atk.dps || 0) >= HIGH_DPS || (atk.multiDps || 0) >= HIGH_MULTI_DPS) caps.add('high_dps');
    if (atk.ignoresArmor || atk.trueDamage) caps.add('true_damage');
  }
  if (st.poison || st.ignoresArmor) caps.add('true_damage');
  if (fam === 'Explosive' || (st.splash || 0) > 0 || (st.shot && st.shot.kind === 'instant')) caps.add('burst');
  // 单发结算卡（樱桃/辣椒/椰子炮）：burst 伤害就是它的“一次能打多少”
  if (st.burst && Number(st.burst.dmg) > 0) caps.add('burst');
  // 吸血/吸能型：直扣本体，等价于真伤
  if (st.damageType === 'drain') caps.add('true_damage');
  if (fam === 'Cold' || fam === 'Slow') caps.add('control');
  const text = textOfPlant(st);
  if (/空中|飞行|吹走/.test(text)) caps.add('anti_air');
  if (/减速|冰冻|冻结|眩晕|定身|魅惑/.test(text)) caps.add('control');
  if (MULTI_LANE_TEXT.test([st.range, text].filter(Boolean).join(' '))) caps.add('multi_lane');
  // 机制克制事实里点名的卡，直接获得该机制需要的能力（数据驱动，不写关卡 if）。
  for (const [tag, rule] of Object.entries(TAG_COUNTERS)) {
    if (!rule || !Array.isArray(rule.plants) || !rule.plants.includes(type)) continue;
    for (const cap of TAG_CAPABILITIES[tag] || []) caps.add(cap);
  }
  return [...caps];
}

/** 卡组能力：byCard（每张卡提供什么）+ byCapability（每项能力有哪些卡）。 */
export function deckCapabilities({ deck = [], plantStatsOf } = {}) {
  const byCard = {};
  const byCapability = {};
  for (const type of [...new Set(deck)].filter(Boolean)) {
    let st = null;
    try { st = plantStatsOf ? plantStatsOf(type) : null; } catch { st = null; }
    const caps = cardCapabilities(type, st);
    byCard[type] = caps;
    for (const cap of caps) {
      if (!byCapability[cap]) byCapability[cap] = [];
      if (!byCapability[cap].includes(type)) byCapability[cap].push(type);
    }
  }
  return { byCard, byCapability };
}

/**
 * 整关能力审计：tags = 本关所有波次出现的 tag。
 * 返回缺哪些能力、哪些 tag 需要它、卡池里哪些卡能满足（只给事实）。
 */
export function coverageAudit({ tags = [], deck = [], plantStatsOf, pool = [] } = {}) {
  const tagList = [...new Set(tags)].filter(Boolean);
  // 同一个 tag 的多个能力是「任一即可」（例如 armored → high_dps 或 true_damage）。
  const groups = new Map();
  for (const tag of tagList) {
    const capsForTag = TAG_CAPABILITIES[tag] || [];
    if (!capsForTag.length) continue;
    const key = capsForTag.join('|');
    if (!groups.has(key)) groups.set(key, { caps: capsForTag.slice(), tags: [] });
    groups.get(key).tags.push(tag);
  }
  const caps = deckCapabilities({ deck, plantStatsOf });
  const safeStats = (t) => {
    try { return plantStatsOf ? plantStatsOf(t) : null; } catch { return null; }
  };
  const required = [];
  for (const g of groups.values()) {
    for (const cap of g.caps) if (!required.includes(cap)) required.push(cap);
  }
  const present = {};
  for (const cap of required) present[cap] = caps.byCapability[cap] || [];
  const missing = [];
  for (const g of groups.values()) {
    // 任一备选能力在卡组里就算覆盖；一个都没有才算缺口。
    if (g.caps.some((cap) => (present[cap] || []).length)) continue;
    const candidates = [...new Set(pool)].filter((t) => {
      const tc = cardCapabilities(t, safeStats(t));
      return g.caps.some((cap) => tc.includes(cap));
    });
    const primary = g.caps[0];
    const facts = g.caps.map((cap) => CAPABILITY_FACTS[cap]).filter(Boolean);
    missing.push({
      capability: primary,
      alternatives: g.caps.slice(),
      name: (CAPABILITY_FACTS[primary] || {}).name || primary,
      text: facts.map((f) => f.text).filter(Boolean).join('；'),
      tags: g.tags.slice(),
      candidates,
    });
  }
  return {
    tags: tagList,
    required,
    present,
    missing,
    byCard: caps.byCard,
  };
}

/**
 * 墙还能撑多久：eatDps 是该行所有僵尸的总啃食速度（不是只看最前一只）。
 * 多只叠加时，墙的支撑时间按总 DPS 算。
 */
export function wallSurvive({ wallHp, eatDps = [] } = {}) {
  const hp = Number(wallHp);
  const total = (Array.isArray(eatDps) ? eatDps : [eatDps])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .reduce((s, v) => s + v, 0);
  if (!Number.isFinite(hp) || hp <= 0) return { totalEatDps: total || null, surviveSec: null };
  if (!total) return { totalEatDps: null, surviveSec: null };
  return { totalEatDps: roundTenth(total), surviveSec: roundTenth(hp / total) };
}

/**
 * 多行缺墙时的重建顺序：按“最危险 + 墙卡冷却”排出先补哪行、大概什么时候能补上。
 * wallPlan 来自 snapshot.brief.wallPlan；leadSec 是下指令到落地的提前量。
 */
export function wallRebuildPlan({ wallPlan = [], leadSec = 0 } = {}) {
  const need = (Array.isArray(wallPlan) ? wallPlan : [])
    .filter((w) => w && w.risk && w.risk !== 'ok')
    .sort((a, b) => {
      const ra = a.risk === 'no_wall' ? 0 : 1;
      const rb = b.risk === 'no_wall' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const ea = a.frontEta == null ? Infinity : a.frontEta;
      const eb = b.frontEta == null ? Infinity : b.frontEta;
      return ea - eb;
    });
  let acc = 0;
  return need.map((w, i) => {
    const cd = Number(w.wallCd) > 0 ? Number(w.wallCd) : 0;
    const base = Number(w.wallBaseCd) > 0 ? Number(w.wallBaseCd) : (Number(w.wallCd) > 0 ? Number(w.wallCd) : 0);
    const startInSec = roundTenth(acc + cd);
    // 这面墙种下去后，墙卡重新进入基础冷却；下一面墙要在这之后。
    acc = acc + cd + base;
    const frontEta = w.frontEta == null ? null : Number(w.frontEta);
    return {
      order: i + 1,
      lane: w.lane,
      risk: w.risk,
      frontType: w.frontType || null,
      frontColumn: w.frontColumn == null ? null : w.frontColumn,
      frontEta,
      wallSurviveSec: w.wallSurviveSec == null ? null : w.wallSurviveSec,
      wallCd: w.wallCd == null ? null : w.wallCd,
      startInSec,
      feasible: frontEta == null || startInSec + Number(leadSec || 0) <= frontEta,
    };
  });
}

function isWallCard(type, meta) {
  return WALL_RE.test(String(type || '')) || String((meta && meta.family) || '') === 'Defence';
}

function isOutputCard(meta) {
  return Number(meta && meta.dps) > 0 && String((meta && meta.family) || '') !== 'Defence';
}

/**
 * 一批动作的预检（纯函数）：
 *  - BATCH_COOLDOWN：同一批里同一张卡出现 ≥2 次且该卡基础冷却 > 3.5s → 后面的动作不可能成功，
 *    提前告诉模型“本轮最多成功几个”，不把整轮晾在冷却上。
 *  - BATCH_CONFLICT：同一格先种后铲 / 重复种 / 换植后再动同一格。
 *  - OUTPUT_IN_FRONT_OF_WALL：同一批里先种墙、再把输出种到墙右侧（桥上单动作校验看不到前一个动作）。
 * 只返回问题，不执行任何动作。
 */
export function batchPreflight({ actions = [], cards = [], state = null, cooldownLimitSec = 3.5 } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const cardByIndex = new Map();
  const cardByType = new Map();
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c) continue;
    if (Number.isFinite(Number(c.index))) cardByIndex.set(Number(c.index), c);
    if (c.type) cardByType.set(String(c.type), c);
  }
  const metaOf = (a) => {
    if (!a || typeof a !== 'object') return null;
    if (a.card != null && Number.isFinite(Number(a.card))) return cardByIndex.get(Number(a.card)) || null;
    if (a.plant) return cardByType.get(String(a.plant)) || null;
    return null;
  };
  const typeOf = (a, meta) => (meta && meta.type) || (a && a.plant ? String(a.plant) : null);
  const cellsOf = (a) => {
    if (!a || typeof a !== 'object') return [];
    if (Array.isArray(a.cells) && a.cells.length) {
      return a.cells
        .map((c) => ({ lane: Number(c && c.lane), column: Number(c && c.column) }))
        .filter((c) => Number.isFinite(c.lane) && Number.isFinite(c.column));
    }
    const lane = Number(a.lane);
    const column = Number(a.column);
    return Number.isFinite(lane) && Number.isFinite(column) ? [{ lane, column }] : [];
  };
  const issues = [];
  const seenCells = new Map();
  const batchWalls = new Map();
  const occurrences = new Map();

  for (let i = 0; i < list.length; i++) {
    const a = list[i] || {};
    const type = String(a.type || '');
    if (type !== 'plant' && type !== 'replace' && type !== 'shovel') continue;
    const meta = metaOf(a);
    const plantType = typeOf(a, meta);
    const cells = cellsOf(a);

    if (type === 'shovel') {
      for (const cell of cells) {
        const key = `${cell.lane}:${cell.column}`;
        const prev = seenCells.get(key);
        if (prev) {
          issues.push({
            index: i, code: 'BATCH_CONFLICT',
            reason: prev.op === 'shovel'
              ? `同一格 c${cell.column} 在本批里已经铲过一次；重复铲除不会生效`
              : `同一格 c${cell.column} 在本批里刚种过（动作 #${prev.index + 1}）；先种后铲等于白种，铲除要放在种植之前`,
            lane: cell.lane, column: cell.column, conflictWith: prev.index,
          });
          // 铲除不会执行：格子状态保持上一步（后面的动作仍按“还种着”判断）
          continue;
        }
        seenCells.set(key, { op: 'shovel', index: i });
      }
      continue;
    }

    // 同卡出现次数照常累计；冷却问题在确认没有更具体的格子冲突后再报。
    let hadConflict = false;
    if (plantType) {
      const occ = occurrences.get(plantType) || [];
      occ.push(i);
      occurrences.set(plantType, occ);
    }

    for (const cell of cells) {
      const key = `${cell.lane}:${cell.column}`;
      const prev = seenCells.get(key);
      if (prev && (prev.op === 'plant' || prev.op === 'replace')) {
        hadConflict = true;
        issues.push({
          index: i, code: 'BATCH_CONFLICT',
          reason: `同一格 c${cell.column} 在本批里已经${prev.op === 'replace' ? '换植' : '种过'}（动作 #${prev.index + 1}）；重复种同一格会浪费阳光。换一格或下一轮再种。`,
          lane: cell.lane, column: cell.column, conflictWith: prev.index,
        });
        continue;
      }
      if (meta && meta.stepDamage) {
        const wall = batchWalls.get(cell.lane);
        if (wall && cell.column < wall.column) {
          hadConflict = true;
          const front = [];
          const row = state && Array.isArray(state.board) ? state.board[cell.lane] : null;
          if (row && Array.isArray(row.cells)) {
            for (let c = wall.column + 1; c < row.cells.length && front.length < 3; c++) {
              if (!row.cells[c]) front.push({ lane: cell.lane, column: c });
            }
          }
          issues.push({
            index: i, code: 'SPIKE_BEHIND_WALL',
            reason: `同一批里动作 #${wall.index + 1} 已在第${cell.lane + 1}行 c${wall.column} 种墙；把地刺种到墙后 c${cell.column} 僵尸会被墙挡住，踩不到地刺。改种墙前${front.length ? ` c${front.map((x) => x.column).join('/c')}` : ''}。`,
            lane: cell.lane, column: cell.column,
            wallColumn: wall.column, suggestedColumns: front.map((x) => x.column),
          });
          continue;
        }
      }
      if (isOutputCard(meta)) {
        const wall = batchWalls.get(cell.lane);
        if (wall && cell.column > wall.column) {
          hadConflict = true;
          const behind = [];
          const row = state && Array.isArray(state.board) ? state.board[cell.lane] : null;
          if (row && Array.isArray(row.cells)) {
            for (let c = wall.column - 1; c >= 0 && behind.length < 3; c--) {
              if (!row.cells[c]) behind.push({ lane: cell.lane, column: c });
            }
          }
          issues.push({
            index: i, code: 'OUTPUT_IN_FRONT_OF_WALL',
            reason: `同一批里动作 #${wall.index + 1} 已在第${cell.lane + 1}行 c${wall.column} 种墙；把输出种到 c${cell.column}（墙右侧）僵尸会先啃输出。改种墙左侧${behind.length ? ` c${behind.map((x) => x.column).join('/c')}` : ''}，或先 replace 墙再补新墙。`,
            lane: cell.lane, column: cell.column,
            wallColumn: wall.column, behindCells: behind, batchWall: wall.index,
          });
          continue;
        }
      }
      if (isWallCard(plantType, meta)) {
        const cur = batchWalls.get(cell.lane);
        if (!cur || cell.column > cur.column) batchWalls.set(cell.lane, { column: cell.column, index: i });
      }
      seenCells.set(key, { op: type, index: i });
    }

    // 同卡重复 + 长冷却：只有没有更具体的格子冲突时才报（BATCH_CONFLICT 优先）。
    if (plantType && !hadConflict) {
      const occ = occurrences.get(plantType) || [];
      const baseCd = Number(meta && meta.baseCd) || 0;
      if (occ.length >= 2 && baseCd > cooldownLimitSec) {
        issues.push({
          index: i, code: 'BATCH_COOLDOWN',
          reason: `${plantType} 基础冷却 ${baseCd}s（>${cooldownLimitSec}s）：同一批里第 ${occ.length} 次种它不可能成功。本轮最多成功 1 个，其余改下一轮或换一张卡。`,
          card: a.card != null ? Number(a.card) : null,
          type: plantType,
          cd: baseCd,
          retryAfter: baseCd,
          maxSuccess: 1,
          duplicateOf: occ[0],
        });
      }
    }
  }
  return { issues };
}

