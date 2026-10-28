import fs from 'node:fs';
const PORT = 9222;
const out = process.argv[2] || 'shot.png';
const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const list = (pages || []).filter((t) => t.type === 'page');
const page = list.find((t) => /^https?:\/\/tauri\.localhost\/?$/i.test(t.url || '')) || list[0];
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = seq++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 20000); });
await send('Page.enable');
const r = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
console.log(out + ' ' + fs.statSync(out).size + ' bytes');
ws.close(); process.exit(0);
