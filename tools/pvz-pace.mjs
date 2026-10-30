// 只读采样：决策节奏（日志条数 / 流式推理长度 / 状态），输出纯文本便于直接看。
// 用法: node tools/pvz-pace.mjs --seconds 45 --interval 1500
import fs from 'node:fs';

const args = process.argv.slice(2);
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const SECONDS = num('--seconds', 45);
const INTERVAL = num('--interval', 1500);
const OUT = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || 'pace.txt';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const page = (pages || []).find((p) => p.type === 'page' && /tauri\.localhost\/?$/i.test(p.url || ''));
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 15000);
});

const SAMPLE = `(() => {
  const L = window.PvzLlm;
  if (!L) return { error: 'no bridge' };
  const s = L.snapshot();
  const q = (sel) => document.querySelector(sel);
  const logEl = q('#pvzllm-thought [data-el="log"]');
  const liveEl = q('#pvzllm-thought [data-el="live"]');
  const countEl = q('#pvzllm-thought [data-el="logCount"]');
  const statusEl = q('#pvzllm-panel [data-el="status"]');
  const lines = logEl ? String(logEl.innerText || '').split('\\n').filter(Boolean) : [];
  return {
    phase: s.phase, wave: s.level && s.level.wave, sun: s.sun,
    plants: (s.plants || []).length, zombies: (s.zombies || []).length,
    mowers: (s.lanes || []).filter((l) => l.mower).length,
    logCount: countEl ? Number(countEl.textContent || 0) : lines.length,
    lines,
    liveLen: liveEl ? String(liveEl.innerText || '').length : 0,
    status: statusEl ? String(statusEl.textContent || '') : null,
    running: true,
  };
})()`;

const rows = [];
const started = Date.now();
while (Date.now() - started < SECONDS * 1000) {
  const r = await send('Runtime.evaluate', { expression: SAMPLE, awaitPromise: true, returnByValue: true });
  const v = r.result && r.result.value;
  if (v && !v.error) {
    rows.push({ t: Math.round((Date.now() - started) / 1000), ...v });
  }
  await new Promise((r2) => setTimeout(r2, INTERVAL));
}

const lines = [];
const last = rows[rows.length - 1] || {};
lines.push(`采样 ${SECONDS}s / ${INTERVAL}ms，共 ${rows.length} 个点；模组版本 ${last.version || '?'}`);
lines.push(`决策日志条数：${rows[0] ? rows[0].logCount : '?'} -> ${last.logCount}（${SECONDS} 秒内新增 ${(last.logCount || 0) - (rows[0] ? rows[0].logCount : 0)} 条）`);
const deltas = [];
for (let i = 1; i < rows.length; i++) {
  if (rows[i].logCount !== rows[i - 1].logCount) deltas.push(`${rows[i].t}s (+${rows[i].logCount - rows[i - 1].logCount})`);
}
lines.push(`日志新增时刻：${deltas.join('  ') || '无'}`);
lines.push(`阳光：${rows[0] ? rows[0].sun : '?'} -> ${last.sun}；植物 ${rows[0] ? rows[0].plants : '?'} -> ${last.plants}；僵尸 ${last.zombies}；推车剩 ${last.mowers}/5；波次 ${last.wave}`);
lines.push('');
lines.push('逐点：');
for (const r of rows) lines.push(`${String(r.t).padStart(3)}s  w${r.wave} sun${r.sun} p${r.plants} z${r.zombies} mower${r.mowers} log${r.logCount} live${r.liveLen}  ${r.status || ''}`);
lines.push('');
lines.push('最近的决策日志：');
for (const l of (last.lines || []).slice(-16)) lines.push('  ' + l);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
ws.close();
process.exit(0);
