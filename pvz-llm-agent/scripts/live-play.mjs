#!/usr/bin/env node
/**
 * 观察一局：连接已安装的新模组，读取真实状态/事件/LLM 统计，直到胜利/失败或超时。
 * 不替 LLM 决策，也不操作卡组；只用于真机测试。
 *
 * 用法：
 *   node scripts/live-play.mjs                 # 你先在浮窗点“开始 AI”
 *   node scripts/live-play.mjs --start         # 由脚本点击浮窗的“开始 AI”按钮
 *   node scripts/live-play.mjs --bypass-csp    # 先解 CSP（会 reload 回主菜单）
 *   node scripts/live-play.mjs --seconds 600
 *
 * 退出码：0=正常结束/观察完成；1=模组未加载或严重错误。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCdpBridge } from '../mcp/cdp.js';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const SECONDS = Math.max(10, Math.min(1800, Number(argOf('--seconds', 600)) || 600));
const INTERVAL = Math.max(0.5, Math.min(10, Number(argOf('--interval', 2)) || 2));
const OUT = argOf('--out', 'live-play-report.json');
const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const START = args.includes('--start');
const BYPASS_CSP = args.includes('--bypass-csp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = createCdpBridge({ port: PORT });
const report = { at: new Date().toISOString(), seconds: SECONDS, start: START, samples: [], errors: [], ok: false };

// 从决策日志里抽出每轮的模型/工具耗时（agent 每轮都会写一条“轮 N 耗时：模型 Xms · 工具 Yms”）。
function parseTimings(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/轮\s*(\d+)\s*耗时：模型\s*(\d+)ms\s*·\s*工具\s*(\d+)ms/g)) {
    out.push({ step: Number(m[1]), modelMs: Number(m[2]), toolMs: Number(m[3]) });
  }
  return out;
}

if (BYPASS_CSP) {
  console.log('[live-play] 先解除 CSP 并重载页面（会回到主菜单）...');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./bypass-csp.mjs', import.meta.url))], { stdio: 'inherit' });
  } catch (e) {
    console.error('[live-play] CSP 绕过失败：' + (e && e.message || e));
  }
  await sleep(3000);
}

const readAgent = `(() => {
  const A = window.PvzLlmAgent;
  if (!A) return { ok: false, reason: 'PvzLlmAgent 不存在（UI/客户端没加载）' };
  const ui = A.ui && A.ui.report ? A.ui.report() : null;
  const msgs = A.agent && A.agent.getMessages ? A.agent.getMessages() : [];
  const tools = msgs.filter((m) => m.role === 'tool').map((m) => {
    let v = null;
    try { v = JSON.parse(m.content); } catch { /* ignore */ }
    return { name: m.name, v };
  });
  const codes = {};
  const cellBlocked = [];
  for (const t of tools) {
    if (t.name === 'pvz_act' && t.v && Array.isArray(t.v.results)) {
      for (const r of t.v.results) {
        if (r.code) codes[r.code] = (codes[r.code] || 0) + 1;
        if (r.code === 'CELL_BLOCKED') cellBlocked.push((r.lane == null ? '?' : r.lane) + ':' + (r.column == null ? '?' : r.column));
      }
    }
  }
  const log = document.querySelector('#pvzllm-thought [data-el="log"]');
  const text = log ? (log.innerText || log.textContent || '') : '';
  return {
    ok: true,
    running: A.agent && A.agent.isRunning ? A.agent.isRunning() : null,
    phase: A.agent && A.agent.getPhase ? A.agent.getPhase() : null,
    stats: A.agent && A.agent.getStats ? A.agent.getStats() : null,
    plan: A.agent && A.agent.getPlan ? A.agent.getPlan() : null,
    ui,
    codes,
    cellBlocked,
    logText: text.slice(-4000),
  };
})()`;

try {
  let mod = null;
  try { mod = await bridge.evaluate(`(() => ({ bridge: !!window.PvzLlm, agent: !!window.PvzLlmAgent }))()`); } catch { /* ignore */ }
  report.mod = mod;
  if (!mod || !mod.bridge) throw new Error('window.PvzLlm 不存在：先启用 PvZ LLM Agent 并重启游戏');
  if (!mod.agent) report.errors.push('window.PvzLlmAgent 不存在：桥接加载了，但 UI/客户端没有初始化');

  const health = await bridge.call('health');
  report.health = health;

  if (START) {
    const started = await bridge.evaluate(`(() => {
      const A = window.PvzLlmAgent;
      if (!A || !A.ui || typeof A.ui.startAI !== 'function') return { ok: false, reason: '没有浮窗启动入口' };
      A.ui.startAI();
      return { ok: true };
    })()`);
    report.startResult = started;
    if (!started.ok) report.errors.push(started.reason);
    await sleep(1500);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < SECONDS * 1000) {
    let state = null;
    let eventStatus = null;
    let agent = null;
    try {
      state = await bridge.call('snapshot');
      eventStatus = await bridge.call('eventStatus');
      agent = await bridge.evaluate(readAgent);
    } catch (e) {
      report.errors.push(String(e && e.message || e));
    }
    const sample = {
      t: Math.round((Date.now() - startedAt) / 100) / 10,
      phase: state && state.phase,
      wave: state && state.level && state.level.wave,
      sun: state && state.sun,
      plants: state && (state.plants || []).length,
      zombies: state && (state.zombies || []).length,
      deck: state && (state.deck || []).length,
      tasks: state && (state.tasks || []).map((x) => ({ tip: x.tip, hint: x.hint, urgent: x.urgent, failed: x.failed })),
      eventsPending: eventStatus && eventStatus.pending,
      running: agent && agent.running,
      toolCalls: agent && agent.stats && agent.stats.toolCalls,
      plan: agent && agent.plan ? agent.plan : null,
      timings: parseTimings(agent && agent.logText).slice(-3),
      guardCodes: agent && agent.codes ? agent.codes : null,
      errors: agent && agent.ui && agent.ui.lastError ? [agent.ui.lastError] : [],
    };
    report.samples.push(sample);
    console.log(`[${sample.t}s] ${sample.phase} 波${sample.wave} 阳光${sample.sun} 植物${sample.plants} 僵尸${sample.zombies} 工具${sample.toolCalls || 0} 事件队列${sample.eventsPending || 0}${sample.errors.length ? ' 错误:' + sample.errors.join('|') : ''}`);
    if (agent && agent.plan) report.plan = agent.plan;
    if (agent && agent.codes) report.codes = agent.codes;
    if (agent && agent.cellBlocked) report.cellBlocked = agent.cellBlocked;
    if (agent && agent.ui) report.ui = agent.ui;
    if (sample.phase === 'running') report.sawRunning = true;
    if (agent && agent.running === true) report.sawAgentRunning = true;
    if (sample.phase === 'won' || sample.phase === 'lost') break;
    // 打过再回到菜单/地图也算结束，否则会对着结算界面空转
    if (report.sawRunning && sample.phase && sample.phase !== 'running') {
      console.log(`[${sample.t}s] 关卡已结束（${sample.phase}），停止采样`);
      break;
    }
    // agent 自己停了（LLM 报错/额度不足/被手动停），别再空转
    if (report.sawAgentRunning && agent && agent.running === false) {
      const why = (agent.ui && agent.ui.lastError) || '未知原因';
      console.log(`[${sample.t}s] agent 已停止（${why}），停止采样`);
      break;
    }
    await sleep(INTERVAL * 1000);
  }

  const phases = [...new Set(report.samples.map((s) => s.phase).filter(Boolean))];
  report.phases = phases;
  report.ok = !report.errors.length && phases.some((p) => ['running', 'won', 'lost'].includes(p));
} catch (e) {
  report.errors.push(String(e && e.message || e));
  report.ok = false;
} finally {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: report.ok, samples: report.samples.length, phases: report.phases, errors: report.errors, codes: report.codes, cellBlocked: report.cellBlocked, out: OUT }, null, 2));
  try { bridge.close(); } catch { /* ignore */ }
  process.exitCode = report.ok ? 0 : 1;
}
