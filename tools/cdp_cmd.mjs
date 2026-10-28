// 通过 CDP 控制游戏窗口：按键 / 点击 / 截图。
// 用法：
//   node tools/cdp_cmd.mjs key F9
//   node tools/cdp_cmd.mjs click 400 300
//   node tools/cdp_cmd.mjs shot out.png
import fs from 'node:fs';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const [cmd, ...args] = process.argv.slice(2);

const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
const list = (pages || []).filter((t) => t.type === 'page');
const page = list.find((t) => /^https?:\/\/tauri\.localhost\/?$/i.test(t.url || ''))
  || list.find((t) => /tauri\.localhost/i.test(t.url || ''))
  || list[0];
if (!page) { console.error('no page'); process.exit(1); }

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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 30000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');

if (cmd === 'key') {
  const map = {
    F8: { code: 'F8', windowsVirtualKeyCode: 119 },
    F9: { code: 'F9', windowsVirtualKeyCode: 120 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
  };
  const k = map[args[0]] || { code: args[0], windowsVirtualKeyCode: 0 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: args[0], code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
  await sleep(60);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: args[0], code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode });
  console.log('key', args[0]);
} else if (cmd === 'click') {
  const x = Number(args[0]), y = Number(args[1]);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('click', x, y);
} else if (cmd === 'shot') {
  const out = args[0] || 'shot.png';
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(out + ' ' + fs.statSync(out).size + ' bytes');
} else if (cmd === 'size') {
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})', returnByValue: true });
  console.log(r.result.value);
} else {
  console.error('usage: key|click|shot|size');
  process.exit(1);
}
ws.close();
process.exit(0);
