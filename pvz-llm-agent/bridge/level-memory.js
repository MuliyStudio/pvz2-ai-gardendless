/**
 * level-memory：按关卡存"这一关以前打成什么样"。
 *
 * 只记录发生过的事实（结果、波次、卡组、计划、损失、备注），不写建议。
 * 存储用页面 localStorage（游戏内 agent 和外部 MCP 客户端共享同一个页面），失败就退回内存。
 */

const STORE_KEY = 'pvzllm.levelMemory.v1';
const MAX_RUNS = 5;
const MAX_LEVELS = 200;
const MAX_LESSONS = 8;

function safeStorage() {
  try {
    const w = typeof window !== 'undefined' ? window : null;
    const s = w && w.localStorage;
    if (!s) return null;
    const probe = '__pvzllm_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function emptyStore() {
  return { v: 1, levels: {} };
}

export function createLevelMemory() {
  const storage = safeStorage();
  let mem = null;

  function load() {
    if (mem) return mem;
    if (!storage) { mem = emptyStore(); return mem; }
    try {
      const raw = storage.getItem(STORE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      mem = parsed && parsed.levels && typeof parsed.levels === 'object' ? parsed : emptyStore();
    } catch {
      mem = emptyStore();
    }
    return mem;
  }

  function save() {
    if (!storage || !mem) return false;
    try {
      storage.setItem(STORE_KEY, JSON.stringify(mem));
      return true;
    } catch {
      return false;
    }
  }

  /** 关卡稳定 id：优先用资源名（cowboy13），否则用世界+名字 */
  function keyOf(state) {
    if (!state || !state.level) return null;
    const src = state.level.source || {};
    if (src.asset) return String(src.asset);
    const parts = [src.world || (state.world && state.world.key) || '', src.levelId || '', state.level.name || '']
      .filter(Boolean);
    return parts.length ? parts.join('|') : null;
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    if (!Array.isArray(entry.lessons)) entry.lessons = [];
    return entry;
  }

  function get(key) {
    if (!key) return null;
    const db = load();
    return normalizeEntry(db.levels[key] || null);
  }

  function cleanLessons(list) {
    return (Array.isArray(list) ? list : [])
      .map((s) => String(s == null ? '' : s).trim())
      .filter(Boolean)
      .map((s) => s.slice(0, 200));
  }

  function put(key, record) {
    if (!key || !record) return null;
    const db = load();
    const entry = normalizeEntry(db.levels[key] || { key, runs: [], lessons: [], note: null, firstAt: null, lastAt: null });
    const run = {
      at: record.at || new Date().toISOString(),
      result: record.result || 'unknown',
      wave: record.wave != null ? record.wave : null,
      waveCount: record.waveCount != null ? record.waveCount : null,
      durationSec: record.durationSec != null ? record.durationSec : null,
      deck: Array.isArray(record.deck) ? record.deck.slice(0, 12) : [],
      plan: record.plan || null,
      facts: record.facts || null,
      note: record.note || null,
      review: record.review || null,
    };
    entry.runs = [run, ...(entry.runs || [])].slice(0, MAX_RUNS);
    entry.name = record.name || entry.name || null;
    entry.lastAt = run.at;
    entry.firstAt = entry.firstAt || run.at;
    if (record.note) entry.note = record.note;
    const incoming = cleanLessons(record.lessons);
    if (incoming.length) entry.lessons = mergeLessons(entry.lessons, incoming);
    db.levels[key] = entry;
    const keys = Object.keys(db.levels);
    if (keys.length > MAX_LEVELS) {
      const drop = keys
        .filter((k) => k !== key)
        .sort((a, b) => String(db.levels[a].lastAt || '').localeCompare(String(db.levels[b].lastAt || '')))
        .slice(0, keys.length - MAX_LEVELS);
      for (const k of drop) delete db.levels[k];
    }
    save();
    return entry;
  }

  // 新经验在前，去重（同一句不要重复占位），每关最多留 8 条。
  function mergeLessons(existing, incoming) {
    const out = [];
    for (const s of [...cleanLessons(incoming), ...cleanLessons(existing)]) {
      if (!out.includes(s)) out.push(s);
      if (out.length >= MAX_LESSONS) break;
    }
    return out;
  }

  /** 自动复盘 / LLM 写下的可执行经验（这一关隔离，跨局保留） */
  function addLessons(key, lessons) {
    if (!key) return null;
    const db = load();
    const entry = normalizeEntry(db.levels[key] || { key, runs: [], lessons: [], firstAt: null, lastAt: null });
    const next = mergeLessons(entry.lessons, lessons);
    if (!next.length) return entry;
    entry.lessons = next;
    entry.lastAt = entry.lastAt || new Date().toISOString();
    db.levels[key] = entry;
    save();
    return entry;
  }

  /** 用最新一次确定性复盘替换旧经验（避免上一版错误归因一直留着） */
  function setLessons(key, lessons) {
    if (!key) return null;
    const db = load();
    const entry = normalizeEntry(db.levels[key] || { key, runs: [], lessons: [], firstAt: null, lastAt: null });
    entry.lessons = cleanLessons(lessons).slice(0, MAX_LESSONS);
    entry.lastAt = entry.lastAt || new Date().toISOString();
    db.levels[key] = entry;
    save();
    return entry;
  }

  /** LLM 自己写的关卡心得（覆盖） */
  function setNote(key, note) {
    if (!key) return null;
    const db = load();
    const entry = normalizeEntry(db.levels[key] || { key, runs: [], lessons: [], firstAt: null, lastAt: null });
    entry.note = note == null ? null : String(note);
    db.levels[key] = entry;
    save();
    return entry;
  }

  /** 导出/导入整个本机记忆库（换机、清缓存前备份用） */
  function exportAll() {
    return JSON.stringify(load(), null, 2);
  }

  function importAll(json) {
    let parsed = null;
    try { parsed = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { ok: false, code: 'BAD_JSON' }; }
    if (!parsed || !parsed.levels || typeof parsed.levels !== 'object') return { ok: false, code: 'BAD_SHAPE' };
    const db = load();
    for (const [k, v] of Object.entries(parsed.levels)) {
      if (!v || typeof v !== 'object') continue;
      const entry = normalizeEntry(db.levels[k] || { key: k, runs: [], lessons: [], firstAt: null, lastAt: null });
      entry.runs = Array.isArray(v.runs) ? [...(v.runs || []), ...(entry.runs || [])].slice(0, MAX_RUNS) : entry.runs;
      entry.lessons = mergeLessons(entry.lessons, v.lessons || []);
      if (v.note != null) entry.note = String(v.note);
      entry.name = v.name || entry.name || null;
      entry.lastAt = v.lastAt || entry.lastAt || null;
      entry.firstAt = entry.firstAt || v.firstAt || null;
      db.levels[k] = entry;
    }
    save();
    return { ok: true, levels: Object.keys(db.levels).length };
  }

  function list(limit = 30) {
    const db = load();
    return Object.values(db.levels)
      .map(normalizeEntry)
      .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
  }

  function clear(key) {
    const db = load();
    if (key) delete db.levels[key];
    else db.levels = {};
    save();
    return { ok: true };
  }

  return {
    persistent: !!storage,
    keyOf, get, put, setNote, addLessons, setLessons, list, clear, exportAll, importAll,
    raw: () => load(),
  };
}
