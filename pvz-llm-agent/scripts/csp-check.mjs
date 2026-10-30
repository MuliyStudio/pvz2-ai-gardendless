#!/usr/bin/env node
/**
 * 探测 CSP 是否放行跨域请求，决定要不要先跑 bypass-csp.mjs。
 *
 * 用 DeepSeek 的 /models 端点：不带 key 只会返回 401，不会产生副作用。
 *   reachable:true  → CSP 放行，可以直接开跑
 *   reachable:false + "Failed to fetch" → 需要 node scripts/bypass-csp.mjs
 *
 * 退出码：0 放行；1 被拦或连不上。
 *
 * 用法：node scripts/csp-check.mjs
 */
const PORT = Number(process.env.PVZ_CDP_PORT || 9222);

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(4000) })).json();
const page = pages.filter((p) => p.type === 'page' && !/devtools/i.test(p.url))
  .sort((a, b) => String(a.url).localeCompare(String(b.url)))[0];
if (!page) { console.error('没有可用页面：请先启动游戏并确认 9222 端口已开'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = seq++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 20000);
});
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (!m.id || !pending.has(m.id)) return;
  const p = pending.get(m.id); pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
});

await send('Runtime.enable', {});
const r = await send('Runtime.evaluate', {
  expression: `(async () => {
    try {
      const res = await fetch('https://api.deepseek.com/v1/models', { method: 'GET' });
      return { reachable: true, status: res.status };
    } catch (e) {
      return { reachable: false, error: String(e && e.message || e) };
    }
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

const value = r.result && r.result.value;
console.log(JSON.stringify(value, null, 2));
ws.close();

if (value && value.reachable) {
  console.log('CSP 放行，可直接开跑。');
  process.exitCode = 0;
} else {
  console.log('CSP 拦截，先运行：node scripts/bypass-csp.mjs');
  process.exitCode = 1;
}
