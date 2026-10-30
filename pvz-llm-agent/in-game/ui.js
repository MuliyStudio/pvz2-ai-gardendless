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

const CFG_KEY = 'pvzllm.ui.cfg.v1';
const GEOM_KEY = 'pvzllm.ui.geom.v2';
const CSS_ID = 'pvzllm-style';
const PANEL_ID = 'pvzllm-panel';
const THOUGHT_ID = 'pvzllm-thought';
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

function cspInfo() {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const doc = A.document;
  const metas = doc ? [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.getAttribute('http-equiv') || '')) : [];
  const policies = metas.map((m) => m.getAttribute('content') || '').filter(Boolean);
  return {
    metaCount: metas.length,
    policies,
    hasTauri: !!(A.__TAURI__ || A.__TAURI_INTERNALS__),
    origin: A.location ? A.location.origin : null,
    note: metas.length
      ? '检测到 meta CSP。删除 meta 标签不保证解除已生效的策略；可靠方案是用 PvZAI_Launcher.exe 启动。'
      : '未检测到 meta CSP。如果是 WebView2 响应头 CSP，页面脚本无法修改；可靠方案是用 PvZAI_Launcher.exe 启动。',
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

#${PANEL_ID} {position:fixed;right:16px;top:64px;z-index:2147483000;width:340px;min-width:260px;min-height:120px;background:linear-gradient(180deg,rgba(25,40,28,.98),rgba(11,18,13,.98));border:1px solid var(--line2);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(12px)}
#${PANEL_ID}.pl-min {width:50px !important;height:50px !important;min-width:50px;min-height:50px;border-radius:50%;box-shadow:0 10px 26px rgba(0,0,0,.55)}
#${PANEL_ID}.pl-min .p-body,#${PANEL_ID}.pl-min .pl-resize {display:none}
#${PANEL_ID}.pl-min .p-head {height:50px;padding:0;justify-content:center;border-bottom:0;background:linear-gradient(180deg,rgba(48,92,58,.72),rgba(18,30,21,.5));cursor:pointer}
#${PANEL_ID}.pl-min .p-brand,#${PANEL_ID}.pl-min .p-head-actions {display:none}
#${PANEL_ID}.pl-min .p-mini {display:flex}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {display:flex;align-items:center;gap:8px;padding:0 12px;height:46px;background:linear-gradient(180deg,rgba(45,88,55,.55),rgba(18,30,21,.2));border-bottom:1px solid var(--line);cursor:move;user-select:none;touch-action:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .t-head {height:44px;padding:0 10px 0 12px;background:linear-gradient(180deg,rgba(44,83,54,.42),rgba(17,28,20,.2))}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-brand {display:flex;align-items:center;gap:9px;min-width:0}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mini {display:none;align-items:center;gap:4px;font-size:10.5px;font-weight:700;color:var(--sun);letter-spacing:.04em}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mini b {font-weight:700}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot {width:6px;height:6px;border-radius:50%;background:var(--dim);box-shadow:0 0 0 2px rgba(151,196,160,.12)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.on {background:var(--green)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.err {background:var(--danger)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .mini-dot.pending {background:var(--pending)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-mark {width:10px;height:10px;flex:none;border-radius:50%;background:var(--sun);box-shadow:0 0 0 3px rgba(242,201,100,.14),0 0 14px rgba(242,201,100,.35)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-title {font-size:12.5px;font-weight:700;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-sub {font-size:9.5px;color:var(--dim);margin-top:1px;white-space:nowrap}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-head-actions,:is(#${PANEL_ID},#${THOUGHT_ID}) .t-actions {display:flex;align-items:center;gap:3px;margin-left:auto;flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn {width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);font-size:12px;line-height:1;display:grid;place-items:center;cursor:pointer}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:hover {background:rgba(255,255,255,.07);border-color:var(--line);color:var(--text)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .icon-btn:focus-visible {outline:2px solid var(--sun);outline-offset:1px}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-body {padding:11px 12px 12px;display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto}
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
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp {display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--dim);cursor:help;line-height:1.4}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp::before {content:'';width:5px;height:5px;flex:none;border-radius:50%;background:#6d8974}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn {color:#c8b47b}
:is(#${PANEL_ID},#${THOUGHT_ID}) .p-csp.warn::before {background:var(--pending)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .p-actions {display:grid;grid-template-columns:1fr 1.45fr 1fr;gap:6px;margin-top:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn {height:33px;padding:0 8px;border:1px solid var(--line2);border-radius:8px;background:transparent;color:var(--text);font-size:11.5px;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s,filter .12s,transform .08s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:hover {background:rgba(255,255,255,.06)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:active {transform:translateY(1px)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn:focus-visible {outline:2px solid var(--sun);outline-offset:2px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary {background:linear-gradient(180deg,var(--sun),var(--sun2));border-color:rgba(0,0,0,.16);color:#1b2417;box-shadow:0 4px 16px rgba(242,201,100,.16)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .btn.primary:hover {filter:brightness(1.06)}
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
:is(#${PANEL_ID},#${THOUGHT_ID}) .chev {margin-left:auto;color:#627d69;transition:transform .15s}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .think-body {display:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-wrap.collapsed .chev {transform:rotate(-90deg)}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body {max-height:120px;overflow:auto;padding:0 9px 8px;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.55;color:#b7cdbc;text-align:left}
:is(#${PANEL_ID},#${THOUGHT_ID}) .think-body.empty {color:var(--dim)}

:is(#${PANEL_ID},#${THOUGHT_ID}) .log-head {display:flex;justify-content:space-between;align-items:center;gap:8px;padding:2px 2px 4px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.08em;color:var(--dim);flex:none}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log-count {font-variant-numeric:tabular-nums;letter-spacing:0;color:#627d69;font-size:9.5px}
:is(#${PANEL_ID},#${THOUGHT_ID}) .log {display:flex;flex-direction:column;flex:1;min-height:120px;overflow:auto}
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
      <span class="p-mini" aria-hidden="true"><span class="mini-dot" data-el="miniDot"></span><b>AI</b></span>
      <div class="p-head-actions">
        <button class="icon-btn" data-act="think" title="显示/隐藏思考窗（F10）" aria-label="显示或隐藏思考窗">思</button>
        <button class="icon-btn" data-act="min" title="收起/展开面板" aria-label="收起或展开面板">—</button>
      </div>
    </div>
    <div class="p-body">
      <div class="p-status"><span class="status-dot" data-el="dot"></span><span data-el="status">待机</span></div>
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
        <div class="p-label"><span>API Key</span><em>只在本机</em></div>
        <input data-f="apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </div>
      <div class="p-flags">
        <label class="check"><input data-f="remember" type="checkbox" /> 记住 Key</label>
        <label class="check"><input data-f="stream" type="checkbox" /> 流式</label>
      </div>
      <div class="p-note">勾选“记住 Key”才写入本机 localStorage；不勾选只保存在内存。</div>
      <div class="p-csp" data-el="csp" title=""></div>
      <div class="p-actions">
        <button class="btn ghost" data-act="test">测试</button>
        <button class="btn primary" data-act="start">开始 AI</button>
        <button class="btn danger" data-act="stop">停止</button>
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
        <button class="icon-btn" data-act="clear" title="清空决策日志" aria-label="清空决策日志">清</button>
        <button class="icon-btn" data-act="hide" title="隐藏思考窗（F10）" aria-label="隐藏思考窗">×</button>
      </div>
    </div>
    <div class="t-body">
      <div class="plan-card" data-el="planCard">
        <button class="section-head plan-head" data-act="togglePlan" aria-expanded="false">
          <span class="plan-title">本关计划</span>
          <span class="plan-brief" data-el="planBrief">未记录</span>
          <span class="chev" data-el="planChev">▸</span>
        </button>
        <div class="plan" data-el="plan">暂无计划</div>
        <span class="plan-at" data-el="planAt">未记录</span>
      </div>
      <div class="state-strip" data-el="state"><span class="state-empty">等待状态…</span></div>
      <div class="think-wrap" data-el="thinkWrap">
        <button class="think-head" data-act="toggleThink" aria-expanded="true">
          <span class="think-label">推理原文</span>
          <span class="think-hint" data-el="thinkHint">滚动</span>
          <span class="chev" data-el="chev">▾</span>
        </button>
        <div class="think-body empty" data-el="live">等待模型思考…</div>
      </div>
      <div class="log-head"><span>决策日志</span><span class="log-count" data-el="logCount">0</span></div>
      <div class="log" data-el="log" aria-live="polite"><div class="empty" data-el="empty">等待 AI 开始决策…</div></div>
    </div>
    <div class="pl-resize" data-resize="thought" title="拖动缩放"></div>`;
  doc.body.appendChild(thought);

  const $ = (sel, root = panel) => root.querySelector(sel);
  const statusEl = $('[data-el="status"]');
  const dotEl = $('[data-el="dot"]');
  const miniDotEl = $('[data-el="miniDot"]');
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
  const thinkWrap = $('[data-el="thinkWrap"]', thought);
  const thinkHint = $('[data-el="thinkHint"]', thought);

  if (cspEl) {
    cspEl.classList.toggle('warn', csp.metaCount > 0);
    cspEl.textContent = csp.metaCount
      ? `CSP：检测到 ${csp.metaCount} 条 meta，建议用启动器`
      : 'CSP：未检测到 meta，响应头需启动器';
    cspEl.title = csp.note;
  }

  // 配置
  const fields = {
    provider: $('[data-f="provider"]'),
    baseUrl: $('[data-f="baseUrl"]'),
    model: $('[data-f="model"]'),
    apiKey: $('[data-f="apiKey"]'),
    remember: $('[data-f="remember"]'),
    stream: $('[data-f="stream"]'),
  };
  const providerHintEl = $('[data-el="providerHint"]');
  const modelHintEl = $('[data-el="modelHint"]');
  const modelListEl = doc.getElementById('pvzllm-model-hints');

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

  // 迁移：0.1.9 存的是 OpenCode Go 直连地址，浏览器用不了，自动纠正到本地代理
  if (fields.provider.value === 'opencode-go' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(fields.baseUrl.value)) {
    fields.baseUrl.value = presetOf('opencode-go').baseUrl;
  }

  function persist() {
    const next = {
      provider: fields.provider.value,
      baseUrl: fields.baseUrl.value.trim(),
      model: fields.model.value.trim(),
      remember: fields.remember.checked,
      stream: fields.stream.checked,
      apiKey: fields.remember.checked ? fields.apiKey.value.trim() : '',
    };
    saveCfg(next);
    agent.setConfig({
      baseUrl: next.baseUrl,
      model: next.model,
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
    if (miniDotEl) miniDotEl.className = 'mini-dot' + suffix;
    tMetaEl.textContent = kind === 'on' ? '运行中' : kind === 'err' ? '异常' : kind === 'pending' ? '等待' : '待机';
  }

  function setLive(text) {
    const s = String(text == null ? '' : text).trim();
    liveEl.textContent = s || '等待模型思考…';
    liveEl.classList.toggle('empty', !s);
    thinkHint.textContent = s ? '滚动' : '等待';
    if (s) liveEl.scrollTop = liveEl.scrollHeight;
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
    switch (ev.type) {
      case 'run_start':
        setStatus('运行中', 'on');
        append('sys', '开始：由 LLM 自己读事实、定计划、选卡和操作。');
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
      case 'state':
        if (ev.state) renderState(ev.state);
        if (ev.state && ev.state.plan) renderPlan(ev.state.plan, ev.state.planSavedAt);
        break;
      case 'state_phase':
        setStatus(`阶段：${phaseCN[ev.phase] || ev.phase}`, ev.phase === 'lost' ? 'err' : (ev.phase === 'won' || ev.phase === 'running' ? 'on' : 'pending'));
        break;
      case 'game_over':
        setStatus(ev.phase === 'won' ? '本关胜利' : '本关失败', ev.phase === 'lost' ? 'err' : 'on');
        tMetaEl.textContent = ev.phase === 'won' ? '已胜利' : '已失败';
        append('sys', `本关结束：${ev.phase === 'won' ? '胜利' : '失败'}`);
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

  panel.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'start') startAI();
    else if (act === 'stop') stopAI();
    else if (act === 'test') test();
    else if (act === 'think') thought.classList.toggle('pl-hidden');
    else if (act === 'min') panel.classList.toggle('pl-min');
  });
  thought.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'hide') thought.classList.add('pl-hidden');
    else if (act === 'clear') clearLog();
    else if (act === 'toggleThink') toggleThink();
    else if (act === 'togglePlan') togglePlan();
  });

  // 拖动 + 缩放
  const savedGeom = loadGeom();
  const geomState = { panel: savedGeom.panel || null, thought: savedGeom.thought || null };

  function viewport() {
    return { w: Math.max(320, A.innerWidth || 1280), h: Math.max(240, A.innerHeight || 720) };
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function readGeom(node) {
    const r = node.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function saveAllGeom() {
    if (!panel.classList.contains('pl-min') && panel.offsetWidth) geomState.panel = readGeom(panel);
    if (!thought.classList.contains('pl-hidden') && thought.offsetWidth) geomState.thought = readGeom(thought);
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
      const wasMini = kind === 'panel' && node.classList.contains('pl-min');
      const moved = drag.moved;
      drag = null;
      node.classList.remove('pl-resizing');
      if (wasMini && !moved) {
        node.classList.remove('pl-min');
        const vp = viewport();
        const r = node.getBoundingClientRect();
        if (r.right > vp.w - 8) node.style.left = `${Math.max(8, vp.w - r.width - 8)}px`;
        if (r.bottom > vp.h - 8) node.style.top = `${Math.max(8, vp.h - r.height - 8)}px`;
      }
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

  A.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      if (agent.isRunning()) stopAI(); else startAI();
    }
    if (e.key === 'F10') {
      e.preventDefault();
      thought.classList.toggle('pl-hidden');
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
      lastError: statusEl.textContent && dotEl.className.indexOf('err') >= 0 ? statusEl.textContent : null,
    };
  }

  function destroy() {
    try { panel.remove(); } catch { /* ignore */ }
    try { thought.remove(); } catch { /* ignore */ }
    try { style.remove(); } catch { /* ignore */ }
  }

  return { panel, thought, report, destroy, setStatus, append, startAI, stopAI, test, cspInfo };
}
