#!/usr/bin/env node
/**
 * 验收采样：只读，不改游戏、不操作。
 *
 * 用法：
 *   1. 用 PvZAI_Launcher.exe 启动游戏（9222）
 *   2. 游戏内浮窗填 Key，点“开始 AI”，让它打一局
 *   3. 另开终端：node scripts/acceptance.mjs --seconds 90
 *
 * 检查项（按需求文档第 9 节）：
 *   - API 完整，且没有 setStrategy / autoDeck / suggestDeck / queue
 *   - briefing 字段齐全，无推荐/策略字段
 *   - 选卡一次成功（actualDeck == slots）或明确返回 DECK_NOT_FULL
 *   - 阳光堆积（sunPeak>500 且 shooterPeak<5 且 wavePeak>=5）
 *   - 同一格反复 CELL_BLOCKED
 *   - 思考窗是否泄漏原始 JSON
 *   - 页面异常
 */
import fs from 'node:fs';
import { createCdpBridge } from '../mcp/cdp.js';
import { createToolRouter } from '../tools/router.js';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const SECONDS = Math.max(5, Math.min(600, Number(argOf('--seconds', 90)) || 90));
const INTERVAL = Math.max(0.5, Math.min(5, Number(argOf('--interval', 1)) || 1));
const OUT = argOf('--out', 'acceptance-report.json');
const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = createCdpBridge({ port: PORT });
const router = createToolRouter({ bridge, version: '0.1.10' });

const report = {
  at: new Date().toISOString(),
  port: PORT,
  seconds: SECONDS,
  checks: [],
  samples: [],
  errors: [],
  fail: [],
  warn: [],
  ok: false,
};

function check(name, ok, detail, level = 'fail') {
  report.checks.push({ name, ok: !!ok, detail: detail || null });
  if (!ok) (level === 'warn' ? report.warn : report.fail).push(detail ? `${name}: ${detail}` : name);
}

try {
  const health = await router.call('pvz_health', {});
  report.health = health;
  check('模组已加载', health && health.ok !== false, health && (health.reason || health.code));
  check('无本地决策 API', !!(health && health.features
    && health.features.localStrategy === false
    && health.features.autoDeck === false
    && health.features.queue === false),
  health && health.features ? JSON.stringify(health.features) : null);
  check('工具清单完整', health && Array.isArray(health.tools) && health.tools.length === 15, health && health.tools && health.tools.length);

  const base = await bridge.evaluate(`(() => {
    window.__pvzacc = window.__pvzacc || { errors: [], installed: false };
    if (!window.__pvzacc.installed) {
      window.__pvzacc.installed = true;
      window.addEventListener('error', (e) => window.__pvzacc.errors.push(String(e.message || e.error || e)));
      window.addEventListener('unhandledrejection', (e) => window.__pvzacc.errors.push('unhandledrejection: ' + String(e.reason && (e.reason.message || e.reason) || e.reason)));
    }
    return true;
  })()`);
  check('页面错误收集器', base === true, null, 'warn');

  const brief = await router.call('pvz_briefing', {});
  report.briefing = brief && brief.ok ? {
    ok: brief.ok, cards: (brief.cards || []).length, waves: (brief.waves || []).length,
    zombies: (brief.zombies || []).length, slots: brief.deck && brief.deck.slots,
    plantLimit: brief.plantLimit,
    keys: Object.keys(brief),
  } : brief;
  if (brief && brief.ok) {
    const need = ['objective', 'missionHints', 'level', 'world', 'terrain', 'waves', 'zombies', 'cards', 'deck', 'startingSun', 'plantLimit', 'constraints', 'mechanics'];
    const missing = need.filter((k) => !(k in brief));
    check('briefing 字段齐全', missing.length === 0, missing.join(', '));
    const bad = Object.keys(brief).filter((k) => /suggest|recommend|autodeck|strategy/i.test(k));
    check('briefing 无推荐卡组/策略字段', bad.length === 0, bad.join(', '));
  } else {
    check('briefing 可读', false, brief && (brief.reason || brief.code), 'warn');
  }

  const started = Date.now();
  let lastLogAt = 0;
  while (Date.now() - started < SECONDS * 1000) {
    let state = null;
    let eventStatus = null;
    try {
      state = await router.call('pvz_state', {});
      eventStatus = await bridge.call('eventStatus');
    } catch (e) {
      report.errors.push(String(e && e.message || e));
    }
    const shooters = state && state.lanes ? state.lanes.reduce((s, l) => s + (l.shooters || 0), 0) : 0;
    const sample = {
      t: Math.round((Date.now() - started) / 100) / 10,
      phase: state && state.phase,
      sun: state && state.sun,
      wave: state && state.level && state.level.wave,
      plants: state && (state.plants || []).length,
      shooters,
      zombies: state && (state.zombies || []).length,
      deck: state && (state.deck || []).length,
      slots: state && state.limits && state.limits.slots,
      tasks: state && (state.tasks || []).map((x) => ({ tip: x.tip, urgent: x.urgent, completed: x.completed, failed: x.failed })),
      eventsPending: eventStatus && eventStatus.pending,
    };
    report.samples.push(sample);
    if (sample.phase === 'won' || sample.phase === 'lost') break;
    await sleep(INTERVAL * 1000);
  }

  const sunPeak = Math.max(0, ...report.samples.map((s) => Number(s.sun) || 0));
  const shooterPeak = Math.max(0, ...report.samples.map((s) => s.shooters || 0));
  const wavePeak = Math.max(0, ...report.samples.map((s) => s.wave || 0));
  const phaseSeen = [...new Set(report.samples.map((s) => s.phase).filter(Boolean))];
  report.summary = { sunPeak, shooterPeak, wavePeak, phaseSeen, samples: report.samples.length };

  check('观察到关卡运行', phaseSeen.some((p) => ['running', 'won', 'lost'].includes(p)), phaseSeen.join(', '), 'warn');
  check('阳光堆积检查', !(sunPeak > 500 && shooterPeak < 5 && wavePeak >= 5), `sunPeak=${sunPeak} shooterPeak=${shooterPeak} wavePeak=${wavePeak}`);

  const agentInfo = await bridge.evaluate(`(() => {
    const A = window.PvzLlmAgent;
    if (!A) return { ok: false, reason: 'PvzLlmAgent 不存在' };
    const msgs = A.agent && A.agent.getMessages ? A.agent.getMessages() : [];
    const tools = msgs.filter((m) => m.role === 'tool').map((m) => {
      let v = null;
      try { v = JSON.parse(m.content); } catch { /* ignore */ }
      return { name: m.name, v };
    });
    const cellBlocked = [];
    const actCodes = {};
    const deckResults = [];
    for (const t of tools) {
      if (t.name === 'pvz_choose_deck' && t.v) deckResults.push({ ok: t.v.ok, code: t.v.code, actual: (t.v.actualDeck || []).length, slots: t.v.slots, missing: t.v.missing });
      if (t.name === 'pvz_act' && t.v && Array.isArray(t.v.results)) {
        for (const r of t.v.results) {
          if (r.code) actCodes[r.code] = (actCodes[r.code] || 0) + 1;
          if (r.code === 'CELL_BLOCKED') cellBlocked.push((r.lane == null ? '?' : r.lane) + ':' + (r.column == null ? '?' : r.column));
        }
      }
    }
    const thought = document.querySelector('#pvzllm-thought [data-el="log"]');
    const text = thought ? thought.innerText || thought.textContent || '' : '';
    return {
      ok: true,
      running: A.agent && A.agent.isRunning ? A.agent.isRunning() : null,
      phase: A.agent && A.agent.getPhase ? A.agent.getPhase() : null,
      stats: A.agent && A.agent.getStats ? A.agent.getStats() : null,
      plan: A.agent && A.agent.getPlan ? A.agent.getPlan() : null,
      deckResults, actCodes, cellBlocked,
      thoughtText: text.slice(0, 20000),
      ui: A.ui && A.ui.report ? A.ui.report() : null,
    };
  })()`);
  report.agent = {
    running: agentInfo && agentInfo.running,
    phase: agentInfo && agentInfo.phase,
    stats: agentInfo && agentInfo.stats,
    plan: agentInfo && agentInfo.plan,
    deckResults: agentInfo && agentInfo.deckResults,
    actCodes: agentInfo && agentInfo.actCodes,
    cellBlocked: agentInfo && agentInfo.cellBlocked,
    ui: agentInfo && agentInfo.ui,
  };

  if (agentInfo && agentInfo.ok) {
    const decks = agentInfo.deckResults || [];
    if (decks.length) {
      const good = decks.some((d) => (d.ok && d.actual === d.slots) || (!d.ok && d.code === 'DECK_NOT_FULL'));
      check('选卡一次成功或明确 DECK_NOT_FULL', good, JSON.stringify(decks));
    } else {
      check('观察到选卡', false, '没有 pvz_choose_deck 调用记录', 'warn');
    }

    const blocked = agentInfo.cellBlocked || [];
    const counts = new Map();
    for (const k of blocked) counts.set(k, (counts.get(k) || 0) + 1);
    const repeated = [...counts.entries()].filter(([, v]) => v >= 3);
    check('同一格不反复 CELL_BLOCKED', repeated.length === 0, repeated.map(([k, v]) => `${k}×${v}`).join(', '));

    const text = String(agentInfo.thoughtText || '');
    const rawJson = /\{\s*"[a-zA-Z_]+"\s*:/.test(text) || /"code"\s*:/.test(text) || /"actualDeck"\s*:/.test(text);
    check('思考窗无整段原始 JSON', !rawJson, rawJson ? '检测到 JSON 片段' : null);

    const stats = agentInfo.stats || {};
    check('LLM 实际调用了工具', (stats.toolCalls || 0) > 0, `toolCalls=${stats.toolCalls || 0}`, 'warn');
    const csp = agentInfo.ui && agentInfo.ui.csp;
    if (csp) check('CSP 自检', (csp.metaCount || 0) === 0, csp.note, 'warn');
  } else {
    check('游戏内 LLM 客户端可用', false, agentInfo && agentInfo.reason, 'warn');
  }

  const pageErrors = await bridge.evaluate('window.__pvzacc ? window.__pvzacc.errors.slice(-50) : []');
  report.pageErrors = Array.isArray(pageErrors) ? pageErrors : [];
  check('页面无异常', report.pageErrors.length === 0, report.pageErrors.slice(0, 3).join(' | '));

  report.ok = report.fail.length === 0;
} catch (e) {
  report.errors.push(String(e && e.message || e));
  report.fail.push('验收执行失败：' + String(e && e.message || e));
  report.ok = false;
} finally {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: report.ok,
    fail: report.fail,
    warn: report.warn,
    summary: report.summary,
    checks: report.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`),
    out: OUT,
  }, null, 2));
  try { bridge.close(); } catch { /* ignore */ }
  process.exitCode = report.ok ? 0 : 1;
}
