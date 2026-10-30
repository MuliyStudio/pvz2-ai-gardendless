// 旁观者：只读采样游戏内模组，记录卡壳点与异常。不做任何操作。
// 用法: node tools/pvz-watch.mjs --seconds 180 --interval 2000
import fs from 'node:fs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const SECONDS = getArg('--seconds', 120);
const INTERVAL = getArg('--interval', 2000);
const OUT = args.includes('--json') ? null : (args.find((a) => a.startsWith('--out=')) || '').slice(6) || null;

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const page = (pages || []).find((p) => p.type === 'page' && /tauri\.localhost\/?$/i.test(p.url || ''))
  || (pages || []).find((p) => p.type === 'page' && !/cloud\.html/i.test(p.url || ''));
if (!page) { console.error('no page'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (!m.id || !pending.has(m.id)) return;
  const q = pending.get(m.id); pending.delete(m.id);
  m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = seq++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 15000);
});

const SAMPLE = `(() => {
  const L = window.PvzLlm;
  if (!L) return { error: 'no bridge' };
  const s = L.snapshot();
  const q = (sel) => document.querySelector(sel);
  const status = q('#pvzllm-panel [data-el="status"]');
  const logEl = q('#pvzllm-thought [data-el="log"]');
  const logCount = q('#pvzllm-thought [data-el="logCount"]');
  const live = q('#pvzllm-thought [data-el="live"]');
  const plan = q('#pvzllm-thought [data-el="plan"]');
  const planBrief = q('#pvzllm-thought [data-el="planBrief"]');
  const lines = logEl ? String(logEl.innerText || '').split('\\n').filter(Boolean) : [];
  return {
    version: L.version,
    phase: s.phase, paused: s.paused,
    wave: s.level && s.level.wave, waves: s.level && s.level.waves, next: s.level && s.level.nextWaveIn,
    sun: s.sun, food: s.plantFood,
    plants: (s.plants || []).map((p) => ({ l: p.lane, c: p.column, t: p.type, hp: p.hp })),
    zombies: (s.zombies || []).map((z) => ({ l: z.lane, c: z.column, t: z.type, hp: z.hp, ehp: z.ehp, ehpMax: z.ehpMax, armorHp: z.armorHp })),
    lanes: (s.lanes || []).map((l) => ({ l: l.lane, z: l.zombies, near: l.nearestZombie, d: l.dps, wall: l.wallHp, mower: l.mower, ehp: l.ehp })),
    cards: (s.cards || []).map((c) => ({ t: c.type, cost: c.cost, cdReady: c.cdReady, affordable: c.affordable, sunShort: c.sunShort })),
    limits: s.limits,
    plan: s.plan || null,
    planBrief: planBrief ? String(planBrief.innerText || '').slice(0, 160) : null,
    status: status ? String(status.textContent || '') : null,
    logCount: logCount ? String(logCount.textContent || '') : null,
    live: live ? String(live.innerText || '').slice(-300) : null,
    logTail: lines.slice(-6),
    logAll: lines.slice(-30),
  };
})()`;

function evalExpr(expression) {
  return send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      const v = r.result.value;
      return typeof v === 'string' ? JSON.parse(v) : v;
    });
}

const samples = [];
const anomalies = [];
const started = Date.now();
let last = null;
let stallSince = null;
let lastLogCount = -1;
let lastLogKey = '';
let repeatCount = 0;

while (Date.now() - started < SECONDS * 1000) {
  let cur;
  try {
    cur = await evalExpr(SAMPLE);
  } catch (e) {
    anomalies.push({ at: Math.round((Date.now() - started) / 1000), kind: 'eval_error', detail: String(e.message).slice(0, 200) });
    await new Promise((r) => setTimeout(r, INTERVAL));
    continue;
  }
  const sec = Math.round((Date.now() - started) / 1000);
  cur.at = sec;

  if (cur.error) { anomalies.push({ at: sec, kind: 'no_bridge', detail: cur.error }); await new Promise((r) => setTimeout(r, INTERVAL)); continue; }

  // 状态快照只存关键字段，避免日志爆炸
  samples.push({
    at: sec, phase: cur.phase, wave: cur.wave, sun: cur.sun, food: cur.food,
    plants: cur.plants.length, zombies: cur.zombies.length,
    lanes: cur.lanes.map((l) => `${l.l} z${l.z} p${l.d} m${l.mower ? 1 : 0}`).join('|'),
    status: cur.status,
  });

  if (last) {
    if (last.phase !== cur.phase) anomalies.push({ at: sec, kind: 'phase', detail: `${last.phase} -> ${cur.phase}` });
    for (let i = 0; i < cur.lanes.length; i++) {
      const a = last.lanes[i] || {};
      const b = cur.lanes[i] || {};
      if (a.mower === true && b.mower === false) anomalies.push({ at: sec, kind: 'mower_lost', detail: `lane ${i}` });
      if (b.z > 0 && b.near != null && b.near <= 1.2 && (a.near == null || a.near > 1.2)) {
        anomalies.push({ at: sec, kind: 'zombie_at_house', detail: `lane ${i} col ${b.near}` });
      }
      if (a.z > 0 && b.z === 0 && a.near != null && a.near <= 0.5) {
        anomalies.push({ at: sec, kind: 'lane_cleared_at_house', detail: `lane ${i}` });
      }
    }
    const lost = last.plants.filter((p) => !cur.plants.some((q) => q.l === p.l && q.c === p.c));
    if (lost.length) anomalies.push({ at: sec, kind: 'plants_lost', detail: lost.map((p) => `${p.l}:${p.c} ${p.t}`).join(', ') });

    // 卡壳：有钱、有可种的卡，但 20 秒没新增植物
    const plantCount = cur.plants.length;
    if (last.plants.length !== plantCount) stallSince = null;
    const readyCheap = cur.cards.some((c) => c.cdReady && c.affordable);
    if (stallSince == null && readyCheap && cur.sun >= 100 && cur.phase === 'running' && cur.zombies.length <= 2) stallSince = sec;
    if (stallSince != null && sec - stallSince >= 20) {
      anomalies.push({ at: sec, kind: 'stall', detail: `${sec - stallSince}s 没有新植物（sun ${cur.sun}，可种卡 ${cur.cards.filter((c) => c.cdReady && c.affordable).map((c) => c.t).join('/')}）` });
      stallSince = sec;
    }
  }

  // 决策日志重复 = 卡在同一个错误上
  const lc = Number(cur.logCount || 0);
  if (lc > 0 && lc === lastLogCount) {
    const key = (cur.logTail || []).join('|');
    if (key && key === lastLogKey) repeatCount += 1; else { repeatCount = 0; lastLogKey = key; }
    if (repeatCount === 6) anomalies.push({ at: sec, kind: 'log_frozen', detail: `${repeatCount * INTERVAL / 1000}s 决策日志没变化：${(cur.logTail || []).slice(-2).join(' / ').slice(0, 200)}` });
  } else {
    repeatCount = 0;
    lastLogKey = '';
    lastLogCount = lc;
  }

  // 报错行
  const errLine = (cur.logTail || []).find((l) => /❌|\bSUN\b|\bCOOLDOWN\b|\bOCCUPIED\b|\bCELL_BLOCKED\b|\bTIMEOUT\b|\bFAILED\b|失败/.test(l));
  if (errLine && (!last || !(last.logTail || []).includes(errLine))) {
    anomalies.push({ at: sec, kind: 'log_error', detail: errLine.slice(0, 200) });
  }

  last = cur;
  await new Promise((r) => setTimeout(r, INTERVAL));
}

const final = last || {};
const report = {
  seconds: SECONDS,
  version: final.version,
  finalPhase: final.phase,
  wave: final.wave,
  sun: final.sun,
  plants: (final.plants || []).length,
  zombies: (final.zombies || []).length,
  planBrief: final.planBrief,
  plan: final.plan,
  status: final.status,
  anomalies,
  tail: samples.slice(-12),
  logTail: (final.logAll || []).slice(-14),
};
const text = JSON.stringify(report, null, 2);
if (OUT) fs.writeFileSync(OUT, text, 'utf8');
console.log(text);
ws.close();
process.exit(0);
