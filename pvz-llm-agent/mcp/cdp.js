/**
 * CDP 传输：Node 侧通过 WebView2 调试端口调用游戏里的 window.PvzLlm。
 * 只做协议转换，不含业务。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BridgeTransportError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.code = code;
    this.extra = extra;
  }
}

export function createCdpBridge({ port = 9222, globalName = 'PvzLlm', timeoutMs = 20000 } = {}) {
  let ws = null;
  let pageId = null;
  let seq = 1;
  const pending = new Map();
  let enabled = false;

  async function getPages() {
    for (let i = 0; i < 15; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
        const list = await r.json();
        if (Array.isArray(list) && list.length) return list;
      } catch { /* retry */ }
      await sleep(600);
    }
    return [];
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

  async function connect() {
    const pages = await getPages();
    const page = pickPage(pages);
    if (!page) throw new BridgeTransportError('CDP_NO_PAGE', `没有找到游戏调试页面（端口 ${port}）。请用启动器打开游戏。`);
    if (ws && ws.readyState === 1 && pageId === page.id) return;
    try { if (ws) ws.close(); } catch { /* ignore */ }
    if (typeof WebSocket === 'undefined') {
      throw new BridgeTransportError('CDP_DISCONNECTED', '当前 Node 没有 WebSocket；请使用 Node 22+。');
    }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.id || !pending.has(msg.id)) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new BridgeTransportError('BRIDGE_ERROR', JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => {
      ws = null;
      pageId = null;
      enabled = false;
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new BridgeTransportError('CDP_DISCONNECTED', 'CDP 连接已断开'));
      }
      pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeTransportError('CDP_DISCONNECTED', 'CDP WebSocket 连接超时')), 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new BridgeTransportError('CDP_DISCONNECTED', 'CDP WebSocket 连接失败')); }, { once: true });
    });
    pageId = page.id;
    if (!enabled) {
      await send('Runtime.enable', {});
      enabled = true;
    }
  }

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) { reject(new BridgeTransportError('CDP_DISCONNECTED', 'CDP 未连接')); return; }
      const id = seq++;
      const entry = { resolve, reject, timer: null };
      pending.set(id, entry);
      ws.send(JSON.stringify({ id, method, params }));
      entry.timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new BridgeTransportError('CDP_DISCONNECTED', `${method} 超时`));
        }
      }, timeoutMs);
    });
  }

  async function evaluate(expression) {
    await connect();
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || '页面执行异常';
      throw new BridgeTransportError('BRIDGE_ERROR', String(msg));
    }
    return r.result ? r.result.value : undefined;
  }

  async function call(method, args = []) {
    const expr = `(async () => {
      const P = window[${JSON.stringify(globalName)}];
      if (!P) return { __bridgeError: 'MOD_NOT_LOADED' };
      if (typeof P[${JSON.stringify(method)}] !== 'function') return { __bridgeError: 'BRIDGE_ERROR', message: '缺少方法 ${method}' };
      try {
        const v = await P[${JSON.stringify(method)}](...${JSON.stringify(args)});
        return { __ok: true, value: v };
      } catch (e) {
        return { __bridgeError: 'BRIDGE_ERROR', message: String(e && e.message || e) };
      }
    })()`;
    const raw = await evaluate(expr);
    if (!raw || typeof raw !== 'object') throw new BridgeTransportError('BAD_RESPONSE', '游戏页面返回了无法解析的结果');
    if (raw.__bridgeError) {
      throw new BridgeTransportError(raw.__bridgeError, raw.message || raw.__bridgeError);
    }
    return raw.value;
  }

  async function health() {
    try {
      const raw = await call('health');
      return raw;
    } catch (e) {
      return { ok: false, code: e.code || 'CDP_DISCONNECTED', reason: e.message };
    }
  }

  function close() {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    ws = null;
    pageId = null;
  }

  return {
    call, evaluate, health, close,
    get port() { return port; },
    // 直接映射，router 只依赖这些方法
    snapshot: () => call('snapshot'),
    briefing: () => call('briefing'),
    knowledge: (a) => call('knowledge', [a]),
    act: (a) => call('act', [a]),
    actAll: (list) => call('actAll', [list]),
    events: (limit) => call('events', [limit]),
    pollEvents: (limit) => call('pollEvents', [limit]),
    setPlan: (p) => call('setPlan', [p]),
    getPlan: () => call('getPlan'),
    chooseDeck: (cards, replace) => call('chooseDeck', [cards, replace]),
    deckStatus: () => call('deckStatus'),
    startLevel: () => call('startLevel'),
    dismissObjective: () => call('dismissObjective'),
    collect: () => call('collect'),
    moveCart: (cart, dir) => call('moveCart', [cart, dir]),
    resume: () => call('resume'),
    forecast: () => call('forecast'),
    getLevelMemory: (k) => call('getLevelMemory', [k]),
    listLevelMemory: (l) => call('listLevelMemory', [l]),
    setLevelNote: (n) => call('setLevelNote', [n]),
  };
}
