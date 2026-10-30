#!/usr/bin/env node
/**
 * 解除 WebView2 的 CSP 限制（等价于 PvZAI_Launcher.exe 里那一步）。
 *
 * 为什么需要：模组本身无法修改 WebView2 的响应头 CSP，被拦时 LLM 请求会报
 * `Failed to fetch`。启动器会在连接后发 Page.setBypassCSP 再 reload，这里做同样的事。
 *
 * 注意：setBypassCSP 对已加载文档不生效，必须 reload；reload 会回到主菜单。
 * 开跑前如果不确定 CSP 是否放行，先用 csp-check.mjs 探一下，避免白丢进度。
 *
 * 用法：node scripts/bypass-csp.mjs
 */
const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

function pickPage(pages) {
  const list = (pages || []).filter((p) => p && p.type === 'page' && !/devtools/i.test(p.url || ''));
  const score = (p) => {
    const url = String(p.url || '');
    if (/cloud\.html/i.test(url)) return 3;
    if (/^https?:\/\/tauri\.localhost\/?$/i.test(url)) return 0;
    if (/tauri\.localhost/i.test(url)) return 1;
    return 2;
  };
  list.sort((a, b) => score(a) - score(b));
  return list[0] || null;
}

const pages = await listPages();
console.log('PAGES:');
for (const p of pages) console.log(`  [${p.type}] ${p.url}  id=${p.id}`);

const page = pickPage(pages);
if (!page) {
  console.error('没有可用页面：请先启动游戏并确认 9222 端口已开');
  process.exit(1);
}
console.log('PICK:', page.url, page.id);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timeout`));
      }
    }, 15000);
  });
}

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});

await send('Runtime.enable', {});
const before = await send('Runtime.evaluate', {
  expression: `(() => ({
    hasBridge: !!window.PvzLlm,
    origin: location.origin,
    metaCsp: [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map(m => m.content),
  }))()`,
  returnByValue: true,
});
console.log('BEFORE:', JSON.stringify(before.result.value));

console.log('Page.setBypassCSP enabled=true ...');
await send('Page.enable', {});
await send('Page.setBypassCSP', { enabled: true });

console.log('Page.reload ...');
try { await send('Page.reload', { ignoreCache: true }); } catch (e) { console.log('reload 返回: ' + e.message); }

ws.close();
console.log('等待页面重载 ...');
await sleep(9000);
console.log('DONE（页面已重载，会回到主菜单）');
