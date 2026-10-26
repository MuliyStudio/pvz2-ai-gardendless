/**
 * PvZ2 Gardendless · CSP 修复启动器
 *
 * 作用：
 *  - 用 WebView2 远程调试端口启动游戏；
 *  - 连接 CDP，执行 Page.setBypassCSP(true)，解除页面的 connect-src 限制；
 *  - 重载一次页面，让 GP-Next 和 AI 模组在“无 CSP 拦截”的页面里重新加载。
 *
 * 用法：
 *  1. 先完全关闭游戏；
 *  2. 双击同目录的“启动游戏（AI修复）.bat”，或运行：
 *       node tools/launch_game_csp_bypass.mjs
 *  3. 看到“CSP 已绕过”后，保持这个窗口打开（可最小化），再进关卡使用 AI。
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log('[CSP修复]', ...args);
}

function findGameExe() {
  const candidates = [];
  const argPath = process.argv.slice(2).find((a) => !String(a).startsWith('--'));
  if (argPath) candidates.push(path.resolve(argPath));
  const dirs = [
    process.cwd(),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads'),
    'C:\\软件',
  ];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^pvzge.*\.exe$/i.test(name)) candidates.push(path.join(dir, name));
      }
      for (const name of fs.readdirSync(dir)) {
        const sub = path.join(dir, name);
        try {
          if (!fs.statSync(sub).isDirectory()) continue;
          for (const f of fs.readdirSync(sub)) {
            if (/^pvzge.*\.exe$/i.test(f)) candidates.push(path.join(sub, f));
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return candidates.find((p) => /\.exe$/i.test(p) && fs.existsSync(p)) || null;
}

function isGameRunning() {
  try {
    const out = execSync('tasklist', { encoding: 'latin1', windowsHide: true });
    return /pvzge.*\.exe/i.test(out);
  } catch {
    return false;
  }
}

async function cdpPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function pickPage(pages) {
  const list = (pages || []).filter((t) => t.type === 'page');
  return list.find((t) => /cocos|gardendless|pvz/i.test((t.title || '') + (t.url || '')))
    || list.find((t) => /^https?:\/\/tauri\.localhost\/?$/i.test(t.url || ''))
    || list.find((t) => /tauri\.localhost/i.test(t.url || '') && !/cloud\.html/i.test(t.url || ''))
    || list[0]
    || null;
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
  let seq = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 15000);
    });
  }
  return { ws, send, id: page.id };
}

async function ensureBypass(stateRef) {
  const pages = await cdpPages();
  const page = pickPage(pages);
  if (!page) return false;
  if (!stateRef.current || stateRef.current.id !== page.id || stateRef.current.ws.readyState !== 1) {
    try { stateRef.current?.ws?.close(); } catch { /* ignore */ }
    stateRef.current = await connect(page);
    await stateRef.current.send('Page.enable');
    log('已连接游戏页面：' + (page.title || page.url));
  }
  await stateRef.current.send('Page.setBypassCSP', { enabled: true });
  return true;
}

async function main() {
  log('查找游戏 EXE…');
  const game = findGameExe();
  if (!game) {
    log('❌ 没找到 pvzge*.exe。请把游戏 EXE 放到桌面，或运行：');
    log('   node tools/launch_game_csp_bypass.mjs "D:\\路径\\pvzge-0.16.1.exe"');
    process.exit(1);
  }
  log('游戏：' + game);

  if (process.argv.includes('--dry-run')) {
    log('dry-run：游戏进程' + (isGameRunning() ? '正在运行（需要先关闭）' : '未运行'));
    log('dry-run：调试端口页面数 = ' + (await cdpPages()).length);
    process.exit(0);
  }

  const alreadyDebug = (await cdpPages()).length > 0;
  if (!alreadyDebug) {
    if (isGameRunning()) {
      log('❌ 检测到游戏正在运行，但没有开调试端口。');
      log('   请先完全关闭游戏，再重新双击本启动器。');
      log('   （直接开游戏不会解除 CSP，必须通过本启动器启动。）');
      process.exit(1);
    }
    log('用调试端口启动游戏…');
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*`,
    };
    const child = spawn(game, [], { env, detached: true, stdio: 'ignore', cwd: path.dirname(game) });
    child.unref();
  } else {
    log('检测到已有的调试端口，复用当前游戏进程。');
  }

  log('等待游戏 WebView2 启动（最多 90 秒）…');
  let page = null;
  for (let i = 0; i < 90; i++) {
    page = pickPage(await cdpPages());
    if (page) break;
    await sleep(1000);
  }
  if (!page) {
    log('❌ 没连上游戏页面。请确认游戏已启动，且没有其它程序占用 9222 端口。');
    process.exit(1);
  }

  const state = { current: null };
  await ensureBypass(state);
  log('已开启 CSP 绕过，正在重载页面（会回到主菜单）…');
  await state.current.send('Page.reload', { ignoreCache: true });
  await sleep(6000);
  await ensureBypass(state);
  await state.current.send('Page.setBypassCSP', { enabled: true });

  log('✅ CSP 已绕过。请保持此窗口打开（可最小化）。');
  log('   现在进入关卡，打开 AI 浮窗填 Key，点“测试连接”即可。');
  log('   如果游戏之后又整页刷新，本窗口会自动重新应用。');

  // 保持连接，定期重新应用（页面重载/目标变化时自动重连）。
  setInterval(async () => {
    try {
      const ok = await ensureBypass(state);
      if (ok) await state.current.send('Page.setBypassCSP', { enabled: true });
    } catch (e) {
      log('重新应用失败：' + (e && e.message ? e.message : e));
    }
  }, 8000);
}

main().catch((e) => {
  log('❌ ' + (e && e.message ? e.message : e));
  process.exit(1);
});
