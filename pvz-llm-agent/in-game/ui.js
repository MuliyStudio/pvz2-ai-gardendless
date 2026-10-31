/**
 * 游戏内浮窗 + 思考窗。
 *
 * 只展示：推理、工具调用、真实结果、计划、状态摘要、失败原因。
 * 不展示：本地卡池建议、卡组修正、策略队列、整段原始 JSON。
 *
 * 视觉方向：PvZ 深绿工具面板 + 暖阳光强调色；推理和决策日志分开，
 * 思考窗只保留一个滚动推理区，决策日志只记录动作/结果/计划。
 */
import { formatToolCall, formatToolResult, formatPlan } from '../tools/format.js';
import { DEFAULT_LLM, PROVIDER_PRESETS } from './agent.js';
import { PET_SHEET, PET_SHEET_META } from './pet-sprites.js';

const CFG_KEY = 'pvzllm.ui.cfg.v1';
const GEOM_KEY = 'pvzllm.ui.geom.v2';
const LAUNCH_KEY = 'pvzllm.ui.launcherGuide.v1';
const CSS_ID = 'pvzllm-style';
const PANEL_ID = 'pvzllm-panel';
const THOUGHT_ID = 'pvzllm-thought';
const PET_ID = 'pvzllm-pet';
const DEFAULT_BASE_URL = DEFAULT_LLM.baseUrl;
const DEFAULT_MODEL = DEFAULT_LLM.model;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phaseCN = { menu: '菜单', worldmap: '地图', objective: '任务说明', preparing: '准备', running: '战斗中', won: '已胜利', lost: '已失败', other: '其他' };

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 图标来自 Lucide（ISC License，https://lucide.dev），内联 path，不引外部字体/文件。
const ICONS = {
  scroll: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plug: '<path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="m2 22 3-3"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m18 3-4 4h6l-4 4"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

function icon(name, cls) {
  const body = ICONS[name] || '';
  return `<svg class="pl-ico${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function loadCfg() {
  try {
    const raw = (window.localStorage && window.localStorage.getItem(CFG_KEY)) || '';
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCfg(cfg) {
  try {
    if (window.localStorage) window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch { /* ignore */ }
}

function loadGeom() {
  try {
    const raw = (window.localStorage && window.localStorage.getItem(GEOM_KEY)) || '';
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveGeom(geom) {
  try {
    if (window.localStorage) window.localStorage.setItem(GEOM_KEY, JSON.stringify(geom || {}));
  } catch { /* ignore */ }
}

function launcherInfo() {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const mark = A.__PVZAI_LAUNCHER__;
  return {
    detected: !!mark,
    version: typeof mark === 'string' ? mark : (mark ? '?' : null),
  };
}

function loadLauncherGuideSeen() {
  try {
    return !!(window.localStorage && window.localStorage.getItem(LAUNCH_KEY) === '1');
  } catch { return false; }
}

function saveLauncherGuideSeen() {
  try {
    if (window.localStorage) window.localStorage.setItem(LAUNCH_KEY, '1');
  } catch { /* ignore */ }
}

function cspInfo() {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const doc = A.document;
  const metas = doc ? [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.getAttribute('http-equiv') || '')) : [];
  const policies = metas.map((m) => m.getAttribute('content') || '').filter(Boolean);
  const launcher = launcherInfo();
  return {
    metaCount: metas.length,
    policies,
    launcher,
    hasTauri: !!(A.__TAURI__ || A.__TAURI_INTERNALS__),
    origin: A.location ? A.location.origin : null,
    note: launcher.detected
      ? '检测到启动器标记，CSP 已由启动器绕过。'
      : (metas.length
        ? '检测到 meta CSP，且没有启动器标记。删除 meta 标签不保证解除已生效的策略；可靠方案是用 PvZAI_Launcher.exe 启动。'
        : '没有检测到启动器标记。内置模型模式需要启动器解除 WebView2 CSP；MCP 模式需要启动器打开 9222 调试端口。'),
  };
}

const CSS = `
#${PANEL_ID},#${THOUGHT_ID} {
  --bg:rgba(13,20,15,.96);--bg2:rgba(23,36,26,.98);--line:rgba(151,196,160,.18);--line2:rgba(151,196,160,.3);
  --text:#eaf5ea;--muted:#adc7b2;--dim:#79957f;--green:#93d49e;--sun:#f2c964;--sun2:#d9a93f;
  --danger:#ff9388;--pending:#f4c95d;--shadow:0 18px 50px rgba(0,0,0,.48);
  box-sizing:border-box;color:var(--text);text-align:left;
  font:12px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
}
:is(#${PANEL_ID},#${THOUGHT_ID}) * {box-sizing:border-box}
:is(#${PANEL_ID},#${THOUGHT_ID}) button {font-family:inherit}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar {width:6px;height:6px}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar-thumb {background:rgba(151,196,160,.22);border-radius:99px}
:is(#${PANEL_ID},#${THOUGHT_ID}) ::-webkit-scrollbar-track {background:transparent}

#${PANEL_ID} {position:fixed;right:16px;top:64px;z-index:2147483000;width:360px;min-width:300px;min-height:120px;max-height:calc(100vh - 80px);max-width:calc(100vw - 16px);background:linear-gradient(180deg,rgba(25,40,28,.98),rgba(11,18,13,.98));border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(12px)}
#${PANEL_ID}.pl-hidden {display:none}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {display:flex;align-items:center;gap:8px;padding:0 12px;height:46px;background:linear-gradient(180deg,rgba(45,88,55,.55),rgba(18,30,21,.2));border-bottom:1px solid var(--line);cursor:move;user-select:none;touch-action:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {height:44px;padding:0 10px 0 12px;background:linear-gradient(180deg,rgba(44,83,54,.42),rgba(17,28,20,.2))}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-brand {display:flex;align-items:center;gap:9px;min-width:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mark {width:10px;height:10px;flex:none;border-radius:50%;background:var(--sun);box-shadow:0 0 0 3px rgba(242,201,100,.14),0 0 14px rgba(242,201,100,.35)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-title {font-size:12.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-sub {font-size:9.5px;color:var(--dim);margin-top:1px;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head-actions,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-actions {display:flex;align-items:center;gap:3px;margin-left:auto;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn {width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);font-size:12px;line-height:1;display:grid;place-items:center;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:hover {background:rgba(255,255,255,.07);border-color:var(--line);color:var(--text)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:focus-visible {outline:2px solid var(--sun);outline-offset:1px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-ico {width:14px;height:14px;display:block;flex:none;pointer-events:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn .pl-ico {width:14px;height:14px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn .pl-ico {width:15px;height:15px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-body {padding:12px 13px 13px;display:flex;flex-direction:column;gap:8px;flex:1;overflow:auto}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-status {display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:rgba(255,255,255,.025);font-size:11px;color:var(--muted);min-height:29px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot {width:7px;height:7px;flex:none;border-radius:50%;background:var(--dim);box-shadow:0 0 0 3px rgba(151,196,160,.1)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.on {background:var(--green);box-shadow:0 0 0 3px rgba(147,212,158,.13)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.err {background:var(--danger);box-shadow:0 0 0 3px rgba(255,147,136,.13)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .status-dot.pending {background:var(--pending);box-shadow:0 0 0 3px rgba(244,201,93,.13)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field {display:flex;flex-direction:column;gap:4px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-label {display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px;color:var(--dim);letter-spacing:.04em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-label em {font-style:normal;color:#66806d;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input {width:100%;height:31px;padding:0 9px;background:rgba(8,15,10,.72);border:1px solid var(--line);border-radius:7px;color:var(--text);font:11.5px/1.4 inherit;outline:none;transition:border-color .12s,background .12s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input::placeholder {color:#5e7764}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input:hover {border-color:var(--line2)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field input:focus {border-color:rgba(242,201,100,.65);background:rgba(8,15,10,.94);box-shadow:0 0 0 3px rgba(242,201,100,.08)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select {width:100%;height:31px;padding:0 26px 0 9px;background:rgba(8,15,10,.72);border:1px solid var(--line);border-radius:7px;color:var(--text);font:11.5px/1.4 inherit;outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,#8aa792 50%),linear-gradient(135deg,#8aa792 50%,transparent 50%);background-position:calc(100% - 14px) 13px,calc(100% - 10px) 13px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select:hover {border-color:var(--line2)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-field select:focus {border-color:rgba(242,201,100,.65);box-shadow:0 0 0 3px rgba(242,201,100,.08)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-flags {display:flex;align-items:center;gap:14px;padding:1px 0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .check {display:flex;align-items:center;gap:5px;color:var(--muted);font-size:10.5px;cursor:pointer;user-select:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .check input {width:12px;height:12px;margin:0;accent-color:var(--sun)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-note {font-size:9.5px;color:var(--dim);line-height:1.5}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch {border:1px solid rgba(244,201,93,.34);border-radius:8px;background:rgba(244,201,93,.055);overflow:hidden;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.ok {border-color:rgba(147,212,158,.22);background:rgba(147,212,158,.05)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-head {width:100%;display:flex;align-items:center;gap:7px;padding:7px 9px;border:0;background:transparent;color:#d8c68a;font:inherit;font-size:10.5px;text-align:left;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.ok .p-launch-head {color:var(--muted);cursor:default}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-head:focus-visible {outline:2px solid var(--sun);outline-offset:-2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-dot {width:6px;height:6px;flex:none;border-radius:50%;background:var(--pending);box-shadow:0 0 0 3px rgba(244,201,93,.12)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.ok .p-launch-dot {background:var(--green);box-shadow:0 0 0 3px rgba(147,212,158,.12)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-title {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-body {display:none;padding:0 9px 9px;font-size:9.5px;line-height:1.6;color:var(--muted)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.open .p-launch-body {display:block}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.open .chev {transform:rotate(90deg)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch.ok .chev {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-body p {margin:0 0 5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-body b {color:var(--sun);font-weight:600}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-launch-body .btn {height:26px;padding:0 10px;font-size:10px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp {display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--dim);cursor:help;line-height:1.4}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp::before {content:'';width:5px;height:5px;flex:none;border-radius:50%;background:#6d8974}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn {color:#c8b47b}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn::before {background:var(--pending)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-actions {display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-actions.main {grid-template-columns:repeat(4,1fr)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-actions.two {grid-template-columns:repeat(2,1fr)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn {height:34px;padding:0 8px;border:1px solid var(--line2);border-radius:8px;background:transparent;color:var(--text);font-size:11.5px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:background .12s,border-color .12s,filter .12s,transform .08s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:hover {background:rgba(255,255,255,.06)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:focus-visible {outline:2px solid var(--sun);outline-offset:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary {background:linear-gradient(180deg,var(--sun),var(--sun2));border-color:rgba(0,0,0,.16);color:#1b2417;box-shadow:0 4px 16px rgba(242,201,100,.16)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary:hover {filter:brightness(1.06)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.think {background:linear-gradient(180deg,#3d9fdd,#1e5f99);border-color:rgba(126,196,240,.55);color:#eaf7ff;box-shadow:0 4px 16px rgba(56,132,196,.24)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.think:hover {filter:brightness(1.09)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.think:active {filter:brightness(.95)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.ghost {color:var(--muted)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.danger {color:var(--danger);border-color:rgba(255,147,136,.32)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.danger:hover {background:rgba(255,147,136,.08)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-foot {text-align:center;font-size:9px;color:var(--dim);letter-spacing:.04em;margin-top:1px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resize {position:absolute;right:0;bottom:0;width:17px;height:17px;cursor:nwse-resize;z-index:6;background:linear-gradient(135deg,transparent 42%,rgba(242,201,100,.38) 43%,rgba(242,201,100,.38) 52%,transparent 53%);opacity:.8;touch-action:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resize:hover {opacity:1}
:is(#${PANEL_ID},#${THOUGHT_ID}) .pl-resizing {user-select:none}

#${THOUGHT_ID} {position:fixed;left:14px;bottom:64px;z-index:2147482999;width:min(470px,46vw);height:min(560px,68vh);min-width:300px;min-height:260px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);background:linear-gradient(180deg,rgba(20,33,23,.98),rgba(10,17,12,.98));border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(12px)}
#${THOUGHT_ID}.pl-hidden {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-brand {display:flex;align-items:center;gap:7px;min-width:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-title {font-size:12.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-meta {font-size:9.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-body {flex:1;min-height:0;overflow:auto;padding:10px 11px 12px;display:flex;flex-direction:column;gap:8px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card {border:1px solid var(--line);border-radius:9px;background:rgba(255,255,255,.022);padding:0;flex:none;overflow:hidden}
:is(#${PANEL_ID},#${THOUGHT_ID}) .section-head {display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:10px;letter-spacing:.08em;color:var(--dim);margin-bottom:4px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .section-head span:last-child {letter-spacing:0;color:#627d69;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head {width:100%;margin:0;padding:7px 9px;border:0;background:transparent;color:var(--dim);font:inherit;cursor:pointer;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head:hover {background:rgba(255,255,255,.035)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-head:focus-visible,:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head:focus-visible {outline:2px solid var(--sun);outline-offset:-2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-title {flex:none;font-size:10px;letter-spacing:.08em;color:var(--dim)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-brief {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--muted);text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-at {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan {display:none;max-height:100px;overflow:auto;padding:0 9px 9px;white-space:pre-wrap;font-size:11px;line-height:1.55;color:#cfe4d3;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card.open .plan {display:block}
:is(#${PANEL_ID},#${THOUGHT_ID}) .plan-card.open .plan-head .chev {transform:rotate(90deg)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .state-strip {display:flex;flex-wrap:wrap;gap:4px;min-height:20px;align-items:center;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .state-empty {font-size:10.5px;color:var(--dim);padding:1px 2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip {display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:rgba(255,255,255,.018);font-size:9.5px;color:var(--muted);white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip b {font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip.hot {border-color:rgba(244,201,93,.42);color:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chip.bad {border-color:rgba(255,147,136,.36);color:var(--danger)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap {border:1px solid var(--line);border-left:2px solid rgba(242,201,100,.55);border-radius:0 9px 9px 0;background:rgba(242,201,100,.035);overflow:hidden;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head {width:100%;display:flex;align-items:center;gap:6px;padding:6px 8px;border:0;background:transparent;color:var(--dim);font-size:10px;letter-spacing:.06em;text-align:left;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-head:hover {background:rgba(255,255,255,.04)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-label {font-weight:600;color:var(--muted);letter-spacing:.03em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-hint {color:#627d69;font-size:9px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chev {margin-left:auto;color:#627d69;transition:transform .15s;display:inline-flex;align-items:center}
:is(#${PANEL_ID},#${THOUGHT_ID}) .chev .pl-ico {width:12px;height:12px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .think-body {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .chev {transform:rotate(-90deg)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body {max-height:120px;overflow:auto;padding:0 9px 8px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.55;color:#b7cdbc;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body.empty {color:var(--dim)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .log-head {display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 2px 4px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.08em;color:var(--dim);flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-count {font-variant-numeric:tabular-nums;letter-spacing:0;color:#627d69;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-tools {display:flex;align-items:center;gap:7px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-copy {appearance:none;width:24px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(151,196,160,.28);background:rgba(151,196,160,.08);color:#9fbea8;font:inherit;padding:0;border-radius:5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-copy .pl-ico {width:12px;height:12px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-copy:hover {background:rgba(151,196,160,.18);color:#e6f3e8;border-color:rgba(151,196,160,.5)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-copy:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log {display:flex;flex-direction:column;flex:1;min-height:120px;overflow:auto;user-select:text;-webkit-user-select:text;cursor:text}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log .text {user-select:text;-webkit-user-select:text}
:is(#${PANEL_ID},#${THOUGHT_ID}) .empty {padding:14px 4px;color:var(--dim);font-size:10.5px;text-align:center}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry {display:grid;grid-template-columns:13px minmax(0,1fr);gap:6px;padding:7px 2px;border-bottom:1px solid rgba(151,196,160,.075);align-items:start;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry:last-child {border-bottom:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .ico {font-size:10px;color:var(--dim);text-align:center;padding-top:1px;line-height:1.4}
:is(#${PANEL_ID},#${THOUGHT_ID}) .text {font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--muted);min-width:0;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="call"] .ico {color:var(--sun)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="call"] .text {color:#e3d5ad}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="ok"] .ico {color:var(--green)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="ok"] .text {color:#cfe4d3}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="fail"] .ico {color:var(--danger)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="fail"] .text {color:#ffd0cc}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="pending"] .ico {color:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="pending"] .text {color:#f2dfa8}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="plan"] .ico {color:#8fd8cf}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="plan"] .text {color:#b9e1dc}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="sys"] .text {color:#b6c9ba}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="user"] .ico {color:#8ecdf0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .entry[data-kind="user"] .text {color:#c8e7f5}

/* ── 悬浮桌宠（思考窗缩小后显示） ── */
#${PET_ID} {position:fixed;left:18px;bottom:64px;z-index:2147483001;width:252px;display:flex;flex-direction:column;align-items:center;gap:4px;font:11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);user-select:none;-webkit-user-select:none;touch-action:none;pointer-events:none}
#${PET_ID} * {box-sizing:border-box}
#${PET_ID}.pl-hidden {display:none !important}
#${PET_ID} .pp-bubble {position:relative;max-width:250px;min-width:96px;padding:9px 11px 10px;border:1px solid rgba(126,196,240,.36);border-radius:14px;background:linear-gradient(180deg,rgba(20,34,46,.98),rgba(10,19,27,.98));box-shadow:0 10px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);opacity:0;transform:translateY(7px) scale(.96);transition:opacity .16s ease,transform .16s ease;pointer-events:none}
#${PET_ID} .pp-bubble.on {opacity:1;transform:none;pointer-events:auto;cursor:pointer}
#${PET_ID} .pp-bubble::after {content:'';position:absolute;left:50%;bottom:-7px;width:12px;height:12px;margin-left:-6px;background:rgba(10,19,27,.98);border-right:1px solid rgba(126,196,240,.36);border-bottom:1px solid rgba(126,196,240,.36);transform:rotate(45deg)}
#${PET_ID} .pp-text {position:relative;z-index:1;display:block;max-height:128px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.55;color:#d9edfa;text-align:left}
#${PET_ID} .pp-text:empty::before {content:'…';color:#7aa7c0}
#${PET_ID} .pp-text::after {content:'';display:inline-block;width:5px;height:11px;margin-left:2px;vertical-align:-1px;background:#7fd4ff;animation:pp-caret 1s steps(1) infinite}
#${PET_ID} .pp-stage {position:relative;width:168px;height:182px;cursor:grab;filter:drop-shadow(0 14px 16px rgba(0,0,0,.5));animation:pp-float 3.4s ease-in-out infinite;pointer-events:auto}
#${PET_ID} .pp-stage:active {cursor:grabbing}
#${PET_ID} .pp-sprite {width:168px;height:182px;background-repeat:no-repeat;background-size:1176px 1092px;background-position:0 0}
#${PET_ID} .pp-shadow {position:absolute;left:50%;bottom:-6px;width:92px;height:14px;margin-left:-46px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(0,0,0,.5),rgba(0,0,0,0) 70%);z-index:-1}
#${PET_ID} .pp-badge {display:flex;align-items:center;gap:6px;padding:2px 9px 2px 7px;border:1px solid rgba(126,196,240,.24);border-radius:999px;background:rgba(8,16,23,.78);font-size:9.5px;color:#9fc7dd;pointer-events:none}
#${PET_ID} .pp-badge b {color:#8fd8ff;font-weight:700;letter-spacing:.04em}
#${PET_ID} .pp-badge .pp-hint {color:#5f8298}
#${PET_ID}.pp-dragging .pp-stage {animation:none}
@keyframes pp-float {0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes pp-caret {0%,49%{opacity:1}50%,100%{opacity:0}}
@media (prefers-reduced-motion: reduce){
  #${PET_ID} .pp-stage {animation:none}
  #${PET_ID} .pp-text::after {animation:none}
}

@media (max-width:900px){
  #${PANEL_ID}{right:8px;top:56px;width:min(320px,calc(100vw - 16px))}
  #${THOUGHT_ID}{left:8px;bottom:56px;width:min(420px,calc(100vw - 16px))}
}
@media (max-width:760px){
  #${PANEL_ID}{width:min(300px,calc(100vw - 16px))}
  #${THOUGHT_ID}{width:min(360px,calc(100vw - 16px))}
}
@media (max-width:680px){
  #${PANEL_ID}{width:min(280px,calc(100vw - 16px))}
  #${THOUGHT_ID}{width:min(330px,calc(100vw - 16px))}
}
@media (max-width:560px){
  #${PANEL_ID}{left:8px;right:8px;top:8px;width:auto;max-height:45vh;min-height:0}
  #${THOUGHT_ID}{left:8px;right:8px;bottom:8px;width:auto;height:45vh;min-height:0}
}
`;

export function createInGameUI({ agent, bridge }) {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const doc = A.document;
  if (!doc || !doc.body) return null;

  try { const old = doc.getElementById(PANEL_ID); if (old) old.remove(); } catch { /* ignore */ }
  try { const old = doc.getElementById(THOUGHT_ID); if (old) old.remove(); } catch { /* ignore */ }
  try { const old = doc.getElementById(PET_ID); if (old) old.remove(); } catch { /* ignore */ }
  try { const old = doc.getElementById(CSS_ID); if (old) old.remove(); } catch { /* ignore */ }

  const style = el(doc, 'style');
  style.id = CSS_ID;
  style.textContent = CSS;
  (doc.head || doc.body).appendChild(style);

  const cfg = loadCfg();
  const csp = cspInfo();

  const panel = el(doc, 'div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'PVZ AI 控制面板');
  panel.innerHTML = `
    <div class="p-head" data-drag="panel">
      <div class="p-brand">
        <span class="p-mark"></span>
        <div>
          <div class="p-title">PVZ · AI 指挥</div>
          <div class="p-sub">LLM 唯一决策者</div>
        </div>
      </div>
      <div class="p-head-actions">
        <button class="icon-btn" data-act="min" title="缩小为桌宠" aria-label="缩小为桌宠">${icon('minimize')}</button>
      </div>
    </div>
    <div class="p-body">
      <div class="p-status"><span class="status-dot" data-el="dot"></span><span data-el="status">待机</span></div>
      <div class="p-launch" data-el="launch">
        <button class="p-launch-head" data-act="toggleLaunch" aria-expanded="false">
          <span class="p-launch-dot"></span>
          <span class="p-launch-title" data-el="launchTitle">必须用启动器启动游戏</span>
          <span class="chev">${icon('chevronRight')}</span>
        </button>
        <div class="p-launch-body">
          <p><b>手动导入 ZIP 用不了：必须用 PvZAI_Launcher.exe 启动游戏。</b>启动器会装模组、开 9222、解 CSP、起本地代理；直接在 GP-Next 里导入 ZIP 拿不到这些，AI 连不上。</p>
          <p>用法：完全退出游戏 → 双击启动器 → 保持窗口打开 → 再进关卡。</p>
          <button class="btn ghost" data-act="ackLaunch" title="知道了" aria-label="知道了">${icon('check')}</button>
        </div>
      </div>
      <div class="p-field">
        <div class="p-label"><span>服务商</span><em data-el="providerHint">预设</em></div>
        <select data-f="provider">
          ${PROVIDER_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="p-field">
        <div class="p-label"><span>API Base</span><em>OpenAI 兼容</em></div>
        <input data-f="baseUrl" placeholder="${DEFAULT_BASE_URL}" spellcheck="false" />
      </div>
      <div class="p-field">
        <div class="p-label"><span>模型</span><em data-el="modelHint">DeepSeek</em></div>
        <input data-f="model" list="pvzllm-model-hints" placeholder="${DEFAULT_MODEL}" spellcheck="false" />
        <datalist id="pvzllm-model-hints"></datalist>
      </div>
      <div class="p-field">
        <div class="p-label"><span>战斗快模型</span><em>选填 · 双层</em></div>
        <input data-f="fastModel" placeholder="如 deepseek-chat；留空=全程用上面的模型" spellcheck="false" />
      </div>
      <div class="p-field">
        <div class="p-label"><span>API Key</span><em>只在本机</em></div>
        <input data-f="apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </div>
      <div class="p-flags">
        <label class="check"><input data-f="remember" type="checkbox" /> 记住 Key</label>
        <label class="check"><input data-f="stream" type="checkbox" /> 流式</label>
      </div>
      <div class="p-note">勾选“记住 Key”才写入本机 localStorage；不勾选只保存在内存。</div>
      <div class="p-csp" data-el="csp" title=""></div>
      <div class="p-actions main">
        <button class="btn think" data-act="think" title="显示/隐藏思考窗（F10）" aria-label="显示或隐藏思考窗">${icon('scroll')}</button>
        <button class="btn ghost" data-act="test" title="测试连接" aria-label="测试连接">${icon('plug')}</button>
        <button class="btn primary" data-act="start" title="开始 AI（F8）" aria-label="开始 AI">${icon('play')}</button>
        <button class="btn danger" data-act="stop" title="停止（F8）" aria-label="停止">${icon('stop')}</button>
      </div>
      <div class="p-actions two">
        <button class="btn ghost" data-act="exportMem" title="导出关卡记忆" aria-label="导出关卡记忆">${icon('download')}</button>
        <button class="btn ghost" data-act="importMem" title="导入关卡记忆" aria-label="导入关卡记忆">${icon('upload')}</button>
        <input data-el="importFile" type="file" accept="application/json,.json" style="display:none" />
      </div>
      <div class="p-foot">F8 开始 / 停止 · F10 思考窗</div>
    </div>
    <div class="pl-resize" data-resize="panel" title="拖动缩放"></div>`;
  doc.body.appendChild(panel);

  const thought = el(doc, 'div');
  thought.id = THOUGHT_ID;
  thought.setAttribute('role', 'region');
  thought.setAttribute('aria-label', 'AI 思考与决策日志');
  thought.innerHTML = `
    <div class="t-head" data-drag="thought">
      <div class="t-brand">
        <span class="status-dot" data-el="tDot"></span>
        <span class="t-title">AI 思考</span>
        <span class="t-meta" data-el="tMeta">待机</span>
      </div>
      <div class="t-actions">
        <button class="icon-btn" data-act="config" title="打开配置页" aria-label="打开配置页">${icon('settings')}</button>
        <button class="icon-btn" data-act="pet" title="缩小为桌宠" aria-label="缩小为桌宠">${icon('minimize')}</button>
        <button class="icon-btn" data-act="clear" title="清空决策日志" aria-label="清空决策日志">${icon('trash')}</button>
        <button class="icon-btn" data-act="hide" title="关闭思考窗（F10）" aria-label="关闭思考窗">${icon('x')}</button>
      </div>
    </div>
    <div class="t-body">
      <div class="plan-card" data-el="planCard">
        <button class="section-head plan-head" data-act="togglePlan" aria-expanded="false">
          <span class="plan-title">本关计划</span>
          <span class="plan-brief" data-el="planBrief">未记录</span>
          <span class="chev" data-el="planChev">${icon('chevronRight')}</span>
        </button>
        <div class="plan" data-el="plan">暂无计划</div>
        <span class="plan-at" data-el="planAt">未记录</span>
      </div>
      <div class="state-strip" data-el="state"><span class="state-empty">等待状态…</span></div>
      <div class="think-wrap" data-el="thinkWrap">
        <button class="think-head" data-act="toggleThink" aria-expanded="true">
          <span class="think-label">推理原文</span>
          <span class="think-hint" data-el="thinkHint">滚动</span>
          <span class="chev" data-el="chev">${icon('chevronDown')}</span>
        </button>
        <div class="think-body empty" data-el="live">等待模型思考…</div>
      </div>
      <div class="log-head">
        <span>决策日志</span>
        <span class="log-tools">
          <span class="log-count" data-el="logCount">0</span>
          <button class="log-copy" data-act="copyLog" title="复制全部决策日志" aria-label="复制全部决策日志">${icon('copy')}</button>
        </span>
      </div>
      <div class="log" data-el="log" aria-live="polite"><div class="empty" data-el="empty">等待 AI 开始决策…</div></div>
    </div>
    <div class="pl-resize" data-resize="thought" title="拖动缩放"></div>`;
  doc.body.appendChild(thought);

  const petEl = el(doc, 'div');
  petEl.id = PET_ID;
  petEl.className = 'pl-hidden';
  petEl.setAttribute('role', 'button');
  petEl.setAttribute('aria-label', '大肥鱼 AI 桌宠，点击展开思考窗');
  petEl.innerHTML = `
    <div class="pp-bubble" data-el="ppBubble"><span class="pp-text" data-el="ppText"></span></div>
    <div class="pp-stage" data-el="ppStage" title="拖动移动 · 点击展开思考窗"><div class="pp-sprite" data-el="ppSprite"></div><div class="pp-shadow" aria-hidden="true"></div></div>
    <div class="pp-badge"><b>AI</b><span data-el="ppState">待机</span><span class="pp-hint">点我展开</span></div>`;
  doc.body.appendChild(petEl);

  const $ = (sel, root = panel) => root.querySelector(sel);
  const statusEl = $('[data-el="status"]');
  const dotEl = $('[data-el="dot"]');
  const planEl = $('[data-el="plan"]', thought);
  const planAtEl = $('[data-el="planAt"]', thought);
  const planCard = $('[data-el="planCard"]', thought);
  const planBriefEl = $('[data-el="planBrief"]', thought);
  const stateEl = $('[data-el="state"]', thought);
  const liveEl = $('[data-el="live"]', thought);
  const logEl = $('[data-el="log"]', thought);
  const emptyEl = $('[data-el="empty"]', thought);
  const logCountEl = $('[data-el="logCount"]', thought);
  const tDotEl = $('[data-el="tDot"]', thought);
  const tMetaEl = $('[data-el="tMeta"]', thought);
  const cspEl = $('[data-el="csp"]');
  const launchEl = $('[data-el="launch"]');
  const launchTitleEl = $('[data-el="launchTitle"]');
  const thinkWrap = $('[data-el="thinkWrap"]', thought);
  const thinkHint = $('[data-el="thinkHint"]', thought);

  // ── 桌宠：思考窗缩小后的形态；和思考窗互斥，不共存 ──
  const petBubbleEl = $('[data-el="ppBubble"]', petEl);
  const petTextEl = $('[data-el="ppText"]', petEl);
  const petStageEl = $('[data-el="ppStage"]', petEl);
  const petSpriteEl = $('[data-el="ppSprite"]', petEl);
  const petStateEl = $('[data-el="ppState"]', petEl);
  petSpriteEl.style.backgroundImage = `url("${PET_SHEET}")`;

  const PET_DISPLAY_W = 168;
  const PET_DISPLAY_H = 182;
  const PET_LABEL = { idle: '待机', think: '思考中', success: '搞定', failed: '出错了', wait: '等待', hover: '在呢' };
  const pet = {
    visible: false,
    state: 'idle',
    frame: 0,
    loops: 0,
    timer: null,
    target: '',
    shown: 0,
    typeTimer: null,
    lastThink: '',
    thinkOpen: false,
    hideTimer: null,
    drag: null,
  };

  function petApplyFrame() {
    const meta = PET_SHEET_META.states[pet.state] || PET_SHEET_META.states.idle;
    const col = pet.frame % meta.frames;
    petSpriteEl.style.backgroundPosition = `${-col * PET_DISPLAY_W}px ${-meta.row * PET_DISPLAY_H}px`;
  }

  function petTick() {
    const meta = PET_SHEET_META.states[pet.state] || PET_SHEET_META.states.idle;
    pet.frame += 1;
    if (pet.frame >= meta.frames) {
      pet.frame = 0;
      pet.loops += 1;
      if ((pet.state === 'success' || pet.state === 'failed') && pet.loops >= 3) {
        petSetState('idle');
        return;
      }
    }
    petApplyFrame();
  }

  function petSetState(name, { force = false } = {}) {
    const key = PET_SHEET_META.states[name] ? name : 'idle';
    const meta = PET_SHEET_META.states[key];
    if (pet.state === key && !force) return;
    pet.state = key;
    pet.frame = 0;
    pet.loops = 0;
    petStateEl.textContent = PET_LABEL[key] || '待机';
    petApplyFrame();
    if (pet.hideTimer) { clearTimeout(pet.hideTimer); pet.hideTimer = null; }
    if (pet.timer) { clearInterval(pet.timer); pet.timer = null; }
    if (pet.visible) pet.timer = setInterval(petTick, meta.ms);
    if (key !== 'think') petScheduleHide(10000);
  }

  function petApplyGeom() {
    const g = geomState.pet;
    if (!g || !Number.isFinite(g.left) || !Number.isFinite(g.top)) {
      petEl.style.left = '';
      petEl.style.top = '';
      petEl.style.right = '';
      petEl.style.bottom = '';
      return;
    }
    const vp = viewport();
    const w = petEl.offsetWidth || 210;
    const h = petEl.offsetHeight || 250;
    petEl.style.left = `${clamp(g.left, 0, Math.max(0, vp.w - w))}px`;
    petEl.style.top = `${clamp(g.top, 0, Math.max(0, vp.h - h))}px`;
    petEl.style.right = 'auto';
    petEl.style.bottom = 'auto';
  }

  function savePetGeom() {
    if (!pet.visible) return;
    const r = petEl.getBoundingClientRect();
    geomState.pet = { left: Math.round(r.left), top: Math.round(r.top) };
    saveGeom(geomState);
  }

  function petClean(text) {
    return String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_>#]/g, '')
      .replace(/\r/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function petScheduleHide(ms) {
    if (pet.state === 'think') return;
    if (pet.hideTimer) clearTimeout(pet.hideTimer);
    pet.hideTimer = setTimeout(() => {
      pet.hideTimer = null;
      try { petBubbleEl.classList.remove('on'); } catch { /* ignore */ }
    }, ms);
  }

  function petSay(text, { reset = false } = {}) {
    const t = petClean(text);
    if (!t) return;
    if (reset) {
      pet.target = '';
      pet.shown = 0;
      pet.lastThink = '';
      petTextEl.textContent = '';
    }
    pet.target += t;
    if (pet.target.length > 360) {
      const cut = pet.target.length - 360;
      pet.target = pet.target.slice(cut);
      pet.shown = Math.max(0, pet.shown - cut);
      if (pet.shown === 0) petTextEl.textContent = '';
    }
    petBubbleEl.classList.add('on');
    petScheduleHide(10000);
    petStartType();
  }

  function petStartType() {
    if (!pet.visible || pet.typeTimer) return;
    pet.typeTimer = setInterval(petTypeTick, 24);
    petTypeTick();
  }

  function petTypeTick() {
    if (!pet.visible || pet.shown >= pet.target.length) {
      if (pet.typeTimer) { clearInterval(pet.typeTimer); pet.typeTimer = null; }
      return;
    }
    const backlog = pet.target.length - pet.shown;
    pet.shown = Math.min(pet.target.length, pet.shown + (backlog > 90 ? 3 : backlog > 30 ? 2 : 1));
    petTextEl.textContent = pet.target.slice(0, pet.shown);
    petTextEl.scrollTop = petTextEl.scrollHeight;
  }

  function petShow() {
    petEl.classList.remove('pl-hidden');
    pet.visible = true;
    petApplyGeom();
    petSetState(agent.isRunning() ? 'think' : 'idle', { force: true });
    pet.lastThink = '';
    pet.thinkOpen = false;
    petSay(agent.isRunning() ? '我盯着战场，边想边说。' : 'AI 待机中，点我展开 AI 思考窗。', { reset: true });
  }

  function petHide() {
    pet.visible = false;
    petEl.classList.add('pl-hidden');
    if (pet.timer) { clearInterval(pet.timer); pet.timer = null; }
    if (pet.typeTimer) { clearInterval(pet.typeTimer); pet.typeTimer = null; }
  }

  function petRestore() {
    thought.classList.remove('pl-hidden');
    petHide();
  }

  function minimizePanel() {
    panel.classList.add('pl-hidden');
    thought.classList.add('pl-hidden');
    petShow();
  }

  function minimizeThought() {
    thought.classList.add('pl-hidden');
    petShow();
  }

  function openConfig() {
    panel.classList.remove('pl-hidden');
    petHide();
  }

  function closeThought() {
    thought.classList.add('pl-hidden');
    // 配置页也关着时必须留桌宠，否则会没有任何入口
    if (panel.classList.contains('pl-hidden')) petShow();
    else petHide();
  }

  function setThoughtVisible(show) {
    thought.classList.toggle('pl-hidden', !show);
    if (show) petHide();
    else if (panel.classList.contains('pl-hidden')) petShow();
    else petHide();
  }

  function petShort(text, max) {
    const t = String(text == null ? '' : text).replace(/^[✅❌⏳⌛]\s*/, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  function petOnAgentEvent(ev) {
    if (!pet.visible) return;
    switch (ev.type) {
      case 'run_start':
        pet.thinkOpen = false;
        pet.lastThink = '';
        petSetState('think');
        petSay('开始思考…', { reset: true });
        break;
      case 'request':
        pet.thinkOpen = false;
        pet.lastThink = '';
        petSetState('think');
        break;
      case 'thinking': {
        const full = String(ev.text || '');
        if (!full) break;
        if (!pet.thinkOpen) {
          // 新一轮推理：重开气泡，避免接在上一轮的错误/工具结果后面
          pet.thinkOpen = true;
          petSay(full, { reset: true });
        } else if (full.startsWith(pet.lastThink)) {
          const delta = full.slice(pet.lastThink.length);
          if (delta.trim()) {
            petSetState('think');
            petSay(delta);
          }
        } else if (!pet.lastThink.startsWith(full)) {
          petSay(full, { reset: true });
        }
        pet.lastThink = full;
        break;
      }
      case 'thinking_final': {
        const final = String(ev.text || '');
        if (pet.thinkOpen) {
          // 流式文本通常已经显示；补齐上游最终文本多出来的尾巴（例如句号）
          if (final && pet.lastThink && final.startsWith(pet.lastThink)) {
            const rest = final.slice(pet.lastThink.length);
            if (rest.trim()) petSay(rest);
          }
        } else if (final) {
          pet.thinkOpen = true;
          petSetState('think');
          petSay(final.slice(-220), { reset: true });
        }
        pet.thinkOpen = false;
        pet.lastThink = '';
        break;
      }
      case 'tool_call': {
        pet.thinkOpen = false;
        pet.lastThink = '';
        let call = ev.name || '工具';
        try { call = formatToolCall(ev.name, ev.args); } catch { /* ignore */ }
        petSetState('think');
        petSay(`准备${call}`, { reset: true });
        break;
      }
      case 'tool_result': {
        pet.thinkOpen = false;
        pet.lastThink = '';
        const pending = !!(ev.result && Array.isArray(ev.result.results) && ev.result.results.some((x) => x && x.pending));
        let txt = '';
        try { txt = resultText(ev.name, ev.result); } catch { /* ignore */ }
        txt = petShort(String(txt || '').split('\n').filter(Boolean)[0] || (ev.ok ? '完成' : '失败'), 90);
        petSay(pending ? `还差一步：${txt}` : (ev.ok ? txt : `没成：${txt}`), { reset: true });
        petSetState(pending ? 'wait' : ev.ok ? 'think' : 'failed');
        break;
      }
      case 'game_over':
        pet.thinkOpen = false;
        pet.lastThink = '';
        if (ev.phase === 'won') {
          petSetState('success');
          petSay('赢了！草坪守住了。', { reset: true });
        } else if (ev.phase === 'lost') {
          petSetState('failed');
          petSay('这关没守住…再来一次吧。', { reset: true });
        } else {
          petSetState('wait');
          petSay('离开关卡了。', { reset: true });
        }
        break;
      case 'error':
        pet.thinkOpen = false;
        pet.lastThink = '';
        petSetState('failed');
        petSay(`出错了：${petShort(ev.code || ev.reason || '未知错误', 80)}`, { reset: true });
        break;
      case 'stopped':
        pet.thinkOpen = false;
        pet.lastThink = '';
        petSetState('wait');
        petSay(`停下来了${ev.reason ? `：${petShort(ev.reason, 60)}` : '。'}`, { reset: true });
        break;
      case 'run_end':
        pet.thinkOpen = false;
        pet.lastThink = '';
        petSetState('idle');
        break;
      default:
        break;
    }
  }

  let launcher = launcherInfo();
  let launchPoll = null;

  function paintLauncher() {
    if (!launchEl) return;
    const ok = launcher.detected;
    launchEl.classList.toggle('ok', ok);
    if (ok) launchEl.classList.remove('open');
    const head = launchEl.querySelector('.p-launch-head');
    if (head) {
      head.setAttribute('aria-expanded', launchEl.classList.contains('open') ? 'true' : 'false');
      head.title = ok
        ? '启动器已连接：CSP 已绕过，9222 调试端口可用'
        : '手动导入 ZIP 用不了；必须用 PvZAI_Launcher.exe 启动游戏';
    }
    if (launchTitleEl) {
      const ver = launcher.version && /^[0-9.]+$/.test(launcher.version) ? ` v${launcher.version}` : '';
      launchTitleEl.textContent = ok
        ? `启动器已连接${ver}`
        : '必须用启动器启动游戏 · 点开查看';
    }
  }

  function openLaunch(open) {
    if (!launchEl || launchEl.classList.contains('ok')) return;
    launchEl.classList.toggle('open', open !== false);
    if (open === false) saveLauncherGuideSeen();
    paintLauncher();
  }

  function ackLauncherGuide() {
    saveLauncherGuideSeen();
    openLaunch(false);
  }

  // 启动器通过 CDP 注入标记；导入 ZIP 后直接开游戏时不会有这个标记，提醒一次用法。
  if (!launcher.detected && !loadLauncherGuideSeen()) openLaunch(true);
  paintLauncher();
  if (!launcher.detected) {
    let tries = 0;
    launchPoll = setInterval(() => {
      tries += 1;
      const info = launcherInfo();
      if (info.detected) {
        launcher = info;
        if (launchPoll) { clearInterval(launchPoll); launchPoll = null; }
        paintLauncher();
        append('sys', '检测到启动器：CSP 已绕过，9222 可用。');
        return;
      }
      if (tries >= 20 && launchPoll) { clearInterval(launchPoll); launchPoll = null; }
    }, 1000);
  }

  if (cspEl) {
    cspEl.classList.toggle('warn', !launcher.detected);
    cspEl.textContent = launcher.detected
      ? 'CSP：启动器已连接，已绕过'
      : (csp.metaCount
        ? `CSP：检测到 ${csp.metaCount} 条 meta · 未检测到启动器`
        : 'CSP：未检测到启动器（响应头需外部解除）');
    cspEl.title = csp.note;
  }

  // 配置
  const fields = {
    provider: $('[data-f="provider"]'),
    baseUrl: $('[data-f="baseUrl"]'),
    model: $('[data-f="model"]'),
    fastModel: $('[data-f="fastModel"]'),
    apiKey: $('[data-f="apiKey"]'),
    remember: $('[data-f="remember"]'),
    stream: $('[data-f="stream"]'),
  };
  const providerHintEl = $('[data-el="providerHint"]');
  const modelHintEl = $('[data-el="modelHint"]');
  const modelListEl = doc.getElementById('pvzllm-model-hints');
  const importFileEl = $('[data-el="importFile"]');

  const presetOf = (id) => PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[0];

  // 旧配置没有 provider 字段，按 baseUrl 推断，避免升级后显示错的服务商
  function guessProvider(baseUrl) {
    const s = String(baseUrl || '');
    if (/opencode\.ai/i.test(s)) return 'opencode-go';
    if (/deepseek\.com/i.test(s)) return 'deepseek';
    return s ? 'custom' : 'deepseek';
  }

  function applyPreset(id, { fill = true } = {}) {
    const p = presetOf(id);
    if (fill) {
      if (p.baseUrl) fields.baseUrl.value = p.baseUrl;
      if (p.model) fields.model.value = p.model;
    }
    if (providerHintEl) {
      providerHintEl.textContent = p.id === 'custom' ? '手动' : '预设';
      providerHintEl.title = p.hint || '';
    }
    if (modelHintEl) {
      modelHintEl.textContent = p.id === 'opencode-go' ? 'OpenCode Go' : p.id === 'deepseek' ? 'DeepSeek' : '自定义';
    }
    if (modelListEl) {
      modelListEl.innerHTML = '';
      for (const m of p.models || []) {
        const o = doc.createElement('option');
        o.value = m;
        modelListEl.appendChild(o);
      }
    }
  }

  fields.baseUrl.value = cfg.baseUrl || DEFAULT_BASE_URL;
  fields.model.value = cfg.model || DEFAULT_MODEL;
  fields.apiKey.value = cfg.apiKey || '';
  fields.remember.checked = !!cfg.remember;
  fields.stream.checked = cfg.stream !== false;
  fields.provider.value = cfg.provider || guessProvider(fields.baseUrl.value);
  applyPreset(fields.provider.value, { fill: false });
  fields.fastModel.value = cfg.fastModel !== undefined
    ? cfg.fastModel
    : (fields.provider.value === 'deepseek' ? 'deepseek-chat' : '');

  // 迁移：0.1.9 存的是 OpenCode Go 直连地址，浏览器用不了，自动纠正到本地代理
  if (fields.provider.value === 'opencode-go' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(fields.baseUrl.value)) {
    fields.baseUrl.value = presetOf('opencode-go').baseUrl;
  }

  function persist() {
    const next = {
      provider: fields.provider.value,
      baseUrl: fields.baseUrl.value.trim(),
      model: fields.model.value.trim(),
      fastModel: fields.fastModel.value.trim(),
      remember: fields.remember.checked,
      stream: fields.stream.checked,
      apiKey: fields.remember.checked ? fields.apiKey.value.trim() : '',
    };
    saveCfg(next);
    agent.setConfig({
      baseUrl: next.baseUrl,
      model: next.model,
      fastModel: next.fastModel,
      apiKey: fields.apiKey.value.trim(),
      stream: next.stream,
    });
  }
  for (const [key, f] of Object.entries(fields)) {
    if (key === 'provider') continue;
    f.addEventListener('change', persist);
  }
  // 切换服务商时套用预设的 Base/模型，之后仍可手动改
  fields.provider.addEventListener('change', () => {
    applyPreset(fields.provider.value, { fill: true });
    persist();
  });
  persist();

  // 状态 / 标题
  function setStatus(text, kind) {
    statusEl.textContent = text;
    const suffix = kind === 'on' ? ' on' : kind === 'err' ? ' err' : kind === 'pending' ? ' pending' : '';
    dotEl.className = 'status-dot' + suffix;
    tDotEl.className = 'status-dot' + suffix;
    tMetaEl.textContent = kind === 'on' ? '运行中' : kind === 'err' ? '异常' : kind === 'pending' ? '等待' : '待机';
  }

  let advisorBanner = '';
  function setLive(text) {
    const s = String(text == null ? '' : text).trim();
    const shown = [advisorBanner, s].filter(Boolean).join('\n');
    liveEl.textContent = shown || '等待模型思考…';
    liveEl.classList.toggle('empty', !shown);
    thinkHint.textContent = shown ? '滚动' : '等待';
    if (shown) liveEl.scrollTop = liveEl.scrollHeight;
  }

  function toggleThink() {
    thinkWrap.classList.toggle('collapsed');
    const collapsed = thinkWrap.classList.contains('collapsed');
    const head = thinkWrap.querySelector('.think-head');
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function togglePlan() {
    planCard.classList.toggle('open');
    const open = planCard.classList.contains('open');
    const head = planCard.querySelector('.plan-head');
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function renderState(s) {
    if (!s || s.ok === false) {
      stateEl.innerHTML = '';
      stateEl.appendChild(el(doc, 'span', 'state-empty', `状态不可用：${(s && (s.code || s.reason)) || '未知'}`));
      return;
    }
    const bits = [];
    const wave = s.level && s.level.wave;
    const waves = s.level && s.level.waves;
    bits.push(['阶段', phaseCN[s.phase] || s.phase || '—', s.phase === 'lost' ? 'bad' : s.phase === 'won' ? 'hot' : '']);
    bits.push(['阳光', s.sun == null ? '—' : s.sun, '']);
    bits.push(['能量豆', s.plantFood == null ? '—' : s.plantFood, '']);
    bits.push(['波次', `${wave || 0}/${waves || '?'}`, '']);
    bits.push(['植物', (s.plants || []).length, '']);
    if (s.paused) bits.push(['暂停', '是', 'bad']);
    const urgent = (s.tasks || []).filter((t) => t.urgent && !t.completed && !t.failed).length;
    const failed = (s.tasks || []).filter((t) => t.failed).length;
    if (urgent) bits.push(['任务紧急', urgent, 'hot']);
    if (failed) bits.push(['任务失败', failed, 'bad']);
    stateEl.innerHTML = bits.map(([k, v, cls]) => `<span class="chip ${cls || ''}"><span>${esc(k)}</span><b>${esc(v)}</b></span>`).join('');
  }

  function renderPlan(plan, savedAt) {
    planEl.textContent = formatPlan(plan);
    const brief = plan && (plan.style || plan.goal || plan.summary) ? String(plan.style || plan.goal || plan.summary) : (plan ? '已记录' : '未记录');
    if (planBriefEl) planBriefEl.textContent = brief;
    if (savedAt) {
      const d = new Date(savedAt);
      planAtEl.textContent = Number.isNaN(d.getTime()) ? '已记录' : d.toLocaleTimeString('zh-CN', { hour12: false });
      planCard.title = `计划记录于 ${planAtEl.textContent}`;
    } else {
      planAtEl.textContent = plan ? '已记录' : '未记录';
      planCard.title = plan ? '计划已记录' : '';
    }
  }

  const ICON = { call: '›', ok: '✓', fail: '!', pending: '…', plan: '◇', sys: '·', user: '›', think: '…' };
  let logCount = 0;

  function append(kind, text) {
    if (!text) return;
    if (emptyEl && emptyEl.parentElement === logEl) emptyEl.remove();
    const row = el(doc, 'div', 'entry');
    row.dataset.kind = kind || 'sys';
    row.style.setProperty('text-align', 'left', 'important');
    row.appendChild(el(doc, 'span', 'ico', ICON[kind] || '·'));
    const textEl = el(doc, 'span', 'text', String(text));
    textEl.style.setProperty('text-align', 'left', 'important');
    row.appendChild(textEl);
    logEl.appendChild(row);
    while (logEl.children.length > 320) logEl.removeChild(logEl.firstChild);
    logCount++;
    logCountEl.textContent = String(logCount);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function clearLog() {
    logEl.textContent = '';
    logEl.appendChild(el(doc, 'div', 'empty', '等待 AI 开始决策…'));
    logCount = 0;
    logCountEl.textContent = '0';
  }

  // 决策日志整段复制：优先 Clipboard API，失败退回 textarea + execCommand（WebView2 里两者都可能受限）
  async function copyLog() {
    const rows = Array.from(logEl.querySelectorAll('.entry'));
    if (!rows.length) {
      append('sys', '决策日志是空的，没有可复制内容');
      return;
    }
    const lines = rows.map((row) => {
      const ico = (row.querySelector('.ico') || {}).textContent || '';
      const text = (row.querySelector('.text') || {}).textContent || '';
      return `${ico} ${text}`.trim();
    });
    let stamp = '';
    try { stamp = new Date().toLocaleString(); } catch { stamp = ''; }
    const payload = [`PvZ 决策日志${stamp ? ` · ${stamp}` : ''}`, ...lines].join('\n');
    let ok = false;
    try {
      const nav = A.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(payload);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      try {
        const ta = doc.createElement('textarea');
        ta.value = payload;
        ta.setAttribute('readonly', 'readonly');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        doc.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { ta.setSelectionRange(0, ta.value.length); } catch { /* ignore */ }
        ok = !!(doc.execCommand && doc.execCommand('copy'));
        ta.remove();
      } catch { ok = false; }
    }
    const btn = thought.querySelector('[data-act="copyLog"]');
    if (btn) {
      const old = btn.innerHTML;
      const oldTitle = btn.getAttribute('title') || '';
      btn.innerHTML = icon(ok ? 'check' : 'x');
      btn.setAttribute('title', ok ? '已复制' : '复制失败');
      setTimeout(() => {
        try {
          btn.innerHTML = old;
          btn.setAttribute('title', oldTitle);
        } catch { /* ignore */ }
      }, 1200);
    }
    append(ok ? 'sys' : 'fail', ok ? `已复制 ${rows.length} 条决策日志` : '复制失败：剪贴板被浏览器拒绝');
  }

  function cspHint(reason) {
    const s = String(reason || '');
    if (!/Failed to fetch|Content Security Policy|connect-src|net::ERR|CORS/i.test(s)) return;
    append('fail', '这通常是 WebView2 CSP 拦截了模型请求。模组在页面内无法可靠解除 CSP；请用 PvZAI_Launcher.exe 启动游戏，或改用 MCP 模式。');
  }

  function resultText(name, result) {
    let text = '';
    try { text = formatToolResult(name, result); } catch { text = result && result.ok === false ? `失败：${result.reason || result.code || '未知'}` : '完成'; }
    if (!text) return '完成';
    text = String(text).replace(/^[✅❌⏳⌛]\s*/, '');
    const lines = String(text).split('\n');
    if (lines.length > 14) return lines.slice(0, 14).join('\n') + `\n…（还有 ${lines.length - 14} 行）`;
    return text;
  }

  function onAgentEvent(ev) {
    if (!ev || !ev.type) return;
    petOnAgentEvent(ev);
    switch (ev.type) {
      case 'run_start':
        advisorBanner = '';
        setStatus('运行中', 'on');
        append('sys', '开始：由 LLM 自己读事实、定计划、选卡和操作。');
        break;
      case 'advisor':
        advisorBanner = `[后台参谋] ${ev.text || ''}`;
        setLive('');
        break;
      case 'request':
        setLive('思考中…');
        tMetaEl.textContent = '思考中';
        break;
      case 'thinking':
        setLive(ev.text ? ev.text.slice(-1400) : '思考中…');
        break;
      case 'thinking_final':
        // 推理只在顶部“推理原文”区显示；决策日志不重复。
        setLive(ev.text || '');
        break;
      case 'assistant_delta':
        // 可见输出等 assistant 事件一次性落到决策日志。
        break;
      case 'assistant':
        if (ev.text && /[\u4e00-\u9fa5]/.test(ev.text)) append('sys', `说明：${ev.text}`);
        break;
      case 'tool_call':
        append('call', formatToolCall(ev.name, ev.args));
        tMetaEl.textContent = '执行中';
        break;
      case 'tool_result': {
        const hasPending = !!(ev.result && Array.isArray(ev.result.results) && ev.result.results.some((x) => x && x.pending));
        append(hasPending ? 'pending' : (ev.ok ? 'ok' : 'fail'), resultText(ev.name, ev.result));
        if (ev.name === 'pvz_state' && ev.result && ev.result.ok) {
          renderState(ev.result);
          if (ev.result.plan) renderPlan(ev.result.plan, ev.result.planSavedAt);
        }
        tMetaEl.textContent = hasPending ? '等待落地' : '观察中';
        break;
      }
      case 'plan':
        renderPlan(ev.plan, ev.savedAt);
        append('plan', '本关计划已更新');
        break;
      case 'plan_audit':
        for (const w of ev.warnings || []) append('fail', `计划审计：${w.reason || w.code || '需要重写'}`);
        break;
      case 'state':
        if (ev.state) renderState(ev.state);
        if (ev.state && ev.state.plan) renderPlan(ev.state.plan, ev.state.planSavedAt);
        break;
      case 'state_phase':
        setStatus(`阶段：${phaseCN[ev.phase] || ev.phase}`, ev.phase === 'lost' ? 'err' : (ev.phase === 'won' || ev.phase === 'running' ? 'on' : 'pending'));
        break;
      case 'game_over': {
        const label = ev.phase === 'won' ? '本关胜利' : ev.phase === 'lost' ? '本关失败' : '已离开关卡';
        setStatus(label, ev.phase === 'lost' ? 'err' : 'on');
        tMetaEl.textContent = ev.phase === 'won' ? '已胜利' : ev.phase === 'lost' ? '已失败' : '已离开';
        append('sys', `本关结束：${ev.phase === 'won' ? '胜利' : ev.phase === 'lost' ? '失败' : '离开关卡'}`);
        break;
      }
      case 'review':
        if (ev.note) append('sys', `赛后复盘：${ev.note}`);
        for (const s of ev.lessons || []) append('plan', `经验：${s}`);
        break;
      case 'model':
        if (ev.model) tMetaEl.title = `当前模型：${ev.model}`;
        break;
      case 'error':
        setStatus(`${ev.code || '错误'}：${String(ev.reason || '').slice(0, 60)}`, 'err');
        append('fail', `错误 ${ev.code || ''}：${ev.reason || ''}`);
        cspHint(ev.reason);
        break;
      case 'stopped':
        setStatus('已停止', '');
        tMetaEl.textContent = '已停止';
        append('sys', `停止：${ev.reason || '手动'}`);
        break;
      case 'run_end':
        setStatus(`结束 · 工具 ${ev.stats ? ev.stats.toolCalls : 0} 次`, ev.error ? 'err' : '');
        tMetaEl.textContent = '已结束';
        append('sys', `运行结束。工具调用 ${ev.stats ? ev.stats.toolCalls : 0} 次；tokens 入 ${ev.stats ? ev.stats.promptTokens : 0} / 出 ${ev.stats ? ev.stats.completionTokens : 0}`);
        break;
      case 'log':
        append('sys', ev.text || '');
        break;
      case 'user':
        append('user', `玩家：${ev.text}`);
        break;
      default:
        break;
    }
  }

  agent.setEventHandler(onAgentEvent);

  async function startAI() {
    persist();
    setStatus('启动中…', 'pending');
    append('sys', '启动 LLM 客户端…');
    const r = await agent.start();
    if (!r.ok) {
      setStatus(`${r.code || '启动失败'}：${r.reason || ''}`, 'err');
      append('fail', `启动失败：${r.reason || r.code || ''}`);
    }
  }

  function stopAI() {
    agent.stop('手动停止');
    setStatus('已停止', '');
  }

  async function test() {
    persist();
    setStatus('测试连接…', 'pending');
    const r = await agent.testConnection();
    if (r.ok) {
      setStatus(`连接 OK（${r.latencyMs}ms）`, 'on');
      append('ok', `连接成功：${r.model}，${r.latencyMs}ms`);
    } else {
      setStatus(`连接失败：${r.code || ''}`, 'err');
      append('fail', `连接失败 ${r.code || ''}：${r.reason || ''}`);
      cspHint(r.reason);
    }
  }

  function exportMemory() {
    try {
      if (!bridge || typeof bridge.exportLevelMemory !== 'function') {
        append('fail', '当前 bridge 不支持导出记忆');
        return;
      }
      const r = bridge.exportLevelMemory();
      if (!r || r.ok === false) { append('fail', '导出失败'); return; }
      const blob = new Blob([r.json || '{}'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = 'pvz-level-memory.json';
      a.style.display = 'none';
      doc.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch { /* ignore */ } }, 1000);
      append('sys', '已导出关卡记忆（pvz-level-memory.json）');
    } catch (e) {
      append('fail', `导出记忆失败：${String(e && e.message || e)}`);
    }
  }

  async function importMemory(file) {
    if (!file) return;
    try {
      if (!bridge || typeof bridge.importLevelMemory !== 'function') {
        append('fail', '当前 bridge 不支持导入记忆');
        return;
      }
      const text = await file.text();
      const r = bridge.importLevelMemory(text);
      append(r && r.ok !== false ? 'sys' : 'fail', r && r.ok !== false
        ? `已导入关卡记忆（${r.levels || 0} 关）`
        : `导入失败：${(r && r.code) || 'BAD_JSON'}`);
    } catch (e) {
      append('fail', `导入记忆失败：${String(e && e.message || e)}`);
    }
  }

  panel.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'start') startAI();
    else if (act === 'stop') stopAI();
    else if (act === 'test') test();
    else if (act === 'think') setThoughtVisible(thought.classList.contains('pl-hidden'));
    else if (act === 'min') minimizePanel();
    else if (act === 'toggleLaunch') openLaunch(!launchEl.classList.contains('open'));
    else if (act === 'ackLaunch') ackLauncherGuide();
    else if (act === 'exportMem') exportMemory();
    else if (act === 'importMem' && importFileEl) importFileEl.click();
  });
  if (importFileEl) {
    importFileEl.addEventListener('change', () => {
      const f = importFileEl.files && importFileEl.files[0];
      importMemory(f);
      importFileEl.value = '';
    });
  }
  thought.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'hide') closeThought();
    else if (act === 'pet') minimizeThought();
    else if (act === 'config') openConfig();
    else if (act === 'clear') clearLog();
    else if (act === 'copyLog') copyLog();
    else if (act === 'toggleThink') toggleThink();
    else if (act === 'togglePlan') togglePlan();
  });

  // 拖动 + 缩放
  const savedGeom = loadGeom();
  const geomState = { panel: savedGeom.panel || null, thought: savedGeom.thought || null, pet: savedGeom.pet || null };

  function viewport() {
    return { w: Math.max(320, A.innerWidth || 1280), h: Math.max(240, A.innerHeight || 720) };
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function readGeom(node) {
    const r = node.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function saveAllGeom() {
    if (!panel.classList.contains('pl-hidden') && panel.offsetWidth) geomState.panel = readGeom(panel);
    if (!thought.classList.contains('pl-hidden') && thought.offsetWidth) geomState.thought = readGeom(thought);
    if (pet.visible && petEl.offsetWidth) {
      const r = petEl.getBoundingClientRect();
      geomState.pet = { left: Math.round(r.left), top: Math.round(r.top) };
    }
    saveGeom(geomState);
  }
  function applyGeom(node, g, minW, minH) {
    if (!g) return;
    const vp = viewport();
    if (Number.isFinite(g.width)) node.style.width = `${clamp(g.width, minW, vp.w - 16)}px`;
    if (Number.isFinite(g.height)) node.style.height = `${clamp(g.height, minH, vp.h - 16)}px`;
    if (Number.isFinite(g.left) && Number.isFinite(g.top)) {
      node.style.left = `${clamp(g.left, 0, vp.w - 80)}px`;
      node.style.top = `${clamp(g.top, 0, vp.h - 40)}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
  }
  function resetGeom(node, kind) {
    node.style.left = '';
    node.style.top = '';
    node.style.right = '';
    node.style.bottom = '';
    node.style.width = '';
    node.style.height = '';
    geomState[kind] = null;
    saveGeom(geomState);
  }
  function makeDraggable(node, handle, kind) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
      const r = node.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      node.classList.add('pl-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 3 || Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      const vp = viewport();
      node.style.left = `${clamp(drag.left + (e.clientX - drag.x), 0, vp.w - 80)}px`;
      node.style.top = `${clamp(drag.top + (e.clientY - drag.y), 0, vp.h - 40)}px`;
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      node.classList.remove('pl-resizing');
      saveAllGeom();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      resetGeom(node, kind);
    });
  }
  function makeResizable(node, kind, minW, minH) {
    const handle = node.querySelector('.pl-resize');
    if (!handle) return;
    let resize = null;
    handle.addEventListener('pointerdown', (e) => {
      const r = node.getBoundingClientRect();
      resize = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
      node.style.left = `${r.left}px`;
      node.style.top = `${r.top}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      node.style.width = `${r.width}px`;
      node.style.height = `${r.height}px`;
      node.classList.add('pl-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resize) return;
      const vp = viewport();
      const w = clamp(resize.w + (e.clientX - resize.x), minW, vp.w - 16);
      const h = clamp(resize.h + (e.clientY - resize.y), minH, vp.h - 16);
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
    });
    const end = () => {
      if (!resize) return;
      resize = null;
      node.classList.remove('pl-resizing');
      saveAllGeom();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetGeom(node, kind);
    });
  }

  applyGeom(panel, geomState.panel, 260, 120);
  applyGeom(thought, geomState.thought, 300, 260);
  makeDraggable(panel, $('.p-head', panel), 'panel');
  makeDraggable(thought, $('.t-head', thought), 'thought');
  makeResizable(panel, 'panel', 260, 120);
  makeResizable(thought, 'thought', 300, 260);

  // 桌宠拖动 / 点击展开（缩小时才显示，和思考窗互斥）
  petStageEl.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const r = petEl.getBoundingClientRect();
    pet.drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    petEl.style.left = `${r.left}px`;
    petEl.style.top = `${r.top}px`;
    petEl.style.right = 'auto';
    petEl.style.bottom = 'auto';
    petEl.classList.add('pp-dragging');
    try { petStageEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  petStageEl.addEventListener('pointermove', (e) => {
    if (!pet.drag) return;
    if (Math.abs(e.clientX - pet.drag.x) > 4 || Math.abs(e.clientY - pet.drag.y) > 4) pet.drag.moved = true;
    const vp = viewport();
    const w = petEl.offsetWidth || 210;
    const h = petEl.offsetHeight || 250;
    petEl.style.left = `${clamp(pet.drag.left + (e.clientX - pet.drag.x), 0, Math.max(0, vp.w - w))}px`;
    petEl.style.top = `${clamp(pet.drag.top + (e.clientY - pet.drag.y), 0, Math.max(0, vp.h - h))}px`;
  });
  const petDragEnd = () => {
    if (!pet.drag) return;
    const moved = pet.drag.moved;
    pet.drag = null;
    petEl.classList.remove('pp-dragging');
    if (moved) savePetGeom();
    else petRestore();
  };
  petStageEl.addEventListener('pointerup', petDragEnd);
  petStageEl.addEventListener('pointercancel', petDragEnd);
  petBubbleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    petRestore();
  });
  petStageEl.addEventListener('pointerenter', () => {
    if (!pet.drag && pet.state === 'idle') petSetState('hover');
  });
  petStageEl.addEventListener('pointerleave', () => {
    if (pet.state === 'hover') petSetState('idle');
  });

  A.addEventListener('resize', () => {
    if (!pet.visible) return;
    const vp = viewport();
    const r = petEl.getBoundingClientRect();
    const w = petEl.offsetWidth || 210;
    const h = petEl.offsetHeight || 250;
    if (r.left >= 0 && r.top >= 0 && r.right <= vp.w && r.bottom <= vp.h) return;
    // 只做视觉兜底，不写入 config：窗口短暂变小时不要把桌宠永久钉到左上角
    petEl.style.left = `${clamp(r.left, 0, Math.max(0, vp.w - w))}px`;
    petEl.style.top = `${clamp(r.top, 0, Math.max(0, vp.h - h))}px`;
    petEl.style.right = 'auto';
    petEl.style.bottom = 'auto';
  });

  petSetState('idle', { force: true });

  A.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      if (agent.isRunning()) stopAI(); else startAI();
    }
    if (e.key === 'F10') {
      e.preventDefault();
      setThoughtVisible(thought.classList.contains('pl-hidden'));
    }
  });

  // 初始
  setLive('');
  renderPlan(null, null);
  try {
    const s = bridge.snapshot();
    if (s && s.ok) renderState(s);
  } catch { /* ignore */ }

  function report() {
    return {
      version: agent.version,
      running: agent.isRunning(),
      phase: agent.getPhase(),
      stats: agent.getStats(),
      plan: agent.getPlan(),
      state: stateEl.textContent,
      logLines: logCount,
      csp: cspInfo(),
      launcher: launcherInfo(),
      pet: { visible: pet.visible, state: pet.state },
      lastError: statusEl.textContent && dotEl.className.indexOf('err') >= 0 ? statusEl.textContent : null,
    };
  }

  function destroy() {
    if (launchPoll) { clearInterval(launchPoll); launchPoll = null; }
    if (pet.timer) { clearInterval(pet.timer); pet.timer = null; }
    if (pet.typeTimer) { clearInterval(pet.typeTimer); pet.typeTimer = null; }
    if (pet.hideTimer) { clearTimeout(pet.hideTimer); pet.hideTimer = null; }
    try { panel.remove(); } catch { /* ignore */ }
    try { thought.remove(); } catch { /* ignore */ }
    try { petEl.remove(); } catch { /* ignore */ }
    try { style.remove(); } catch { /* ignore */ }
  }

  return { panel, thought, report, destroy, setStatus, append, startAI, stopAI, test, cspInfo, launcherInfo };
}
