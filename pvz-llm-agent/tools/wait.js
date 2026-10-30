/**
 * wait：把条件字符串解析成对 snapshot 的判断。
 * 纯函数，离线可测；不做任何"该等到什么时候"的建议。
 */

export function checkCondition(state, cond) {
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

export const CONDITION_HELP = [
  'sun>=N', 'sun<=N', 'sun>N', 'sun<N',
  'plantfood>=N', 'card_ready:<type|index>',
  'zombie_in_lane:<lane>', 'no_zombie_in_lane:<lane>', 'zombie_near:<column>', 'no_zombie',
  'phase:<objective|preparing|running|won|lost>',
  'plants>=N', 'plants_in_lane:<lane>>=N', 'wave>=N', 'tasks_ready',
  '复合：a && b，或 a || b（一条里只用一种）',
];
