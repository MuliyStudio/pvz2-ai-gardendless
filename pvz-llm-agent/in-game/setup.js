/**
 * 游戏内入口：bridge + 工具 router + LLM 客户端 + 浮窗。
 */
import { createBridge, BRIDGE_VERSION } from '../bridge/api.js';
import { createToolRouter } from '../tools/router.js';
import { createLlmAgent } from './agent.js';
import { createInGameUI } from './ui.js';

const AGENT_VERSION = '0.1.10';

export function setupInGame(ctx) {
  const A = typeof window !== 'undefined' ? window : globalThis;
  const bridge = createBridge(ctx);
  const router = createToolRouter({ bridge, version: AGENT_VERSION });
  const agent = createLlmAgent({ router, version: AGENT_VERSION, cfg: { stream: true } });
  let ui = null;
  try { ui = createInGameUI({ agent, bridge }); } catch (e) {
    try { console.error('[pvz-llm-agent] UI 初始化失败', e); } catch { /* ignore */ }
  }

  const api = {
    version: AGENT_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    bridge,
    router,
    agent,
    ui,
    health() {
      let h = null;
      try { h = bridge.health(); } catch (e) { h = { ok: false, reason: String(e && e.message || e) }; }
      return {
        ...h,
        agentVersion: AGENT_VERSION,
        tools: router.names,
        running: agent.isRunning(),
        plan: agent.getPlan(),
        phase: agent.getPhase(),
        csp: ui && ui.cspInfo ? ui.cspInfo() : null,
        ui: ui ? ui.report() : null,
      };
    },
    dispose() {
      try { agent.stop('dispose'); } catch { /* ignore */ }
      try { if (ui) ui.destroy(); } catch { /* ignore */ }
      try { bridge.dispose(); } catch { /* ignore */ }
      try { delete A.PvzLlmAgent; } catch { /* ignore */ }
      try { delete A.PvzLlm; } catch { /* ignore */ }
      return { ok: true };
    },
  };
  try { A.PvzLlmAgent = api; } catch { /* ignore */ }
  try { if (ctx && ctx.ui && ctx.ui.toast) ctx.ui.toast('PvZ LLM Agent 已加载 v' + AGENT_VERSION, 'success'); } catch { /* ignore */ }
  return api;
}
