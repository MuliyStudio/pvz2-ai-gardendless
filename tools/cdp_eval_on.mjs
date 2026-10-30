// 在指定 URL 片段匹配的 CDP 页面里执行表达式
// 用法: node tools/cdp_eval_on.mjs <urlSubstring> <expr-file.js>
import fs from 'node:fs';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const [needle, file] = process.argv.slice(2);
if (!needle || !file) { console.error('usage: node tools/cdp_eval_on.mjs <urlSubstring> <expr-file.js>'); process.exit(1); }

const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const page = (pages || []).find((t) => t.type === 'page' && (needle.startsWith('=')
  ? String(t.url || '') === needle.slice(1)
  : String(t.url || '').includes(needle)));
if (!page) { console.error('no page matching ' + needle); console.log(JSON.stringify((pages || []).map((p) => p.url))); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id); pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = seq++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 60000);
});

await send('Runtime.enable');
const expression = `(async () => { try { const v = await (${fs.readFileSync(file, 'utf8')}); return JSON.stringify({ ok: true, value: v }, (k, x) => (typeof x === 'function' ? '[fn]' : x), 2); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.stack) || e) }); } })()`;
const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) console.error(JSON.stringify(r.exceptionDetails, null, 2));
console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
ws.close();
process.exit(0);
