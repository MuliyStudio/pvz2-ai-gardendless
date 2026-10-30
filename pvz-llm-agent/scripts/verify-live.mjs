#!/usr/bin/env node
/**
 * 真机契约检查：确认 window.PvzLlm 已加载、API / snapshot / briefing / knowledge 字段齐全，
 * 且没有本地策略、自动卡组、队列等被禁止的入口。
 *
 * 用法：用启动器（9222 调试端口）打开游戏，然后 node scripts/verify-live.mjs
 */
import fs from 'node:fs';
import { createCdpBridge } from '../mcp/cdp.js';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const OUT = process.env.PVZ_VERIFY_OUT || 'verify-report.json';

const bridge = createCdpBridge({ port: PORT });
const expression = `(async () => {
  const A = window.PvzLlm;
  if (!A) return { ok: false, code: 'MOD_NOT_LOADED', reason: 'window.PvzLlm 不存在：模组没启用/没重启' };
  const need = ['snapshot','briefing','knowledge','act','actAll','events','pollEvents','setPlan','getPlan','chooseDeck','deckStatus','startLevel','dismissObjective','collect','moveCart','resume','health'];
  const banned = ['setStrategy','updateStrategy','autoDeck','suggestDeck','setQueue','clearQueue','queueStatus'];
  const api = need.filter((k) => typeof A[k] === 'function');
  const presentBanned = banned.filter((k) => typeof A[k] === 'function');
  const s = A.snapshot ? A.snapshot() : null;
  const b = A.briefing ? A.briefing() : null;
  const h = A.health ? A.health() : null;
  const k = A.knowledge ? A.knowledge({ type: 'sunflower' }) : null;
  const d = A.deckStatus ? A.deckStatus() : null;
  const briefKeys = b && b.ok ? Object.keys(b) : [];
  const needBrief = ['objective','missionHints','level','world','terrain','waves','zombies','cards','deck','startingSun','plantLimit','constraints','mechanics'];
  const missingBrief = b && b.ok ? needBrief.filter((x) => !(x in b)) : needBrief;
  const badBriefKeys = briefKeys.filter((x) => /suggest|recommend|autodeck|strategy/i.test(x));
  return {
    ok: !!s,
    version: A.version,
    api,
    missing: need.filter((x) => !api.includes(x)),
    presentBanned,
    health: h,
    snapshot: s ? {
      ok: s.ok, phase: s.phase, scene: s.scene, sun: s.sun, plantFood: s.plantFood,
      laneCount: (s.lanes || []).length, cards: (s.cards || []).length,
      plants: (s.plants || []).length, zombies: (s.zombies || []).length,
      tasks: (s.tasks || []).length,
      objective: s.objective ? { active: s.objective.active, missions: s.objective.missions } : null,
      levelScript: !!s.levelScript,
      terrain: !!(s.terrain && Array.isArray(s.terrain.map)),
      blockedCells: Array.isArray(s.blockedCells),
      plantable: Array.isArray(s.plantable),
      carts: Array.isArray(s.carts),
      zombieStats: !!s.zombieStats && Object.keys(s.zombieStats).length >= 0,
      plan: !!s.plan,
    } : null,
    briefing: b ? { ok: b.ok, keys: briefKeys, missing: missingBrief, badKeys: badBriefKeys, cards: (b.cards || []).length, waves: (b.waves || []).length, zombies: (b.zombies || []).length, slots: b.deck && b.deck.slots, plantLimit: b.plantLimit } : null,
    knowledge: k ? { ok: k.ok, kind: k.kind, type: k.entry && k.entry.type, name: k.entry && k.entry.name, cost: k.entry && k.entry.cost } : null,
    deckStatus: d ? { ok: d.ok, phase: d.phase, slots: d.slots, current: d.current, available: (d.available || []).length, gameStartable: d.gameStartable } : null,
    eventStatus: A.eventStatus ? A.eventStatus() : null,
  };
})()`;

let report;
try {
  report = await bridge.evaluate(expression);
} catch (e) {
  console.error('检查失败：' + (e.message || e));
  console.error('请确认：用 PvZAI_Launcher.exe 启动游戏、GP-Next 已启用 “PvZ LLM Agent”、并重启游戏。');
  process.exit(1);
}

const fails = [];
const warns = [];
if (!report || !report.ok) fails.push(report && report.reason || '模组未加载');
if (report && report.missing && report.missing.length) fails.push('缺少 API：' + report.missing.join(', '));
if (report && report.presentBanned && report.presentBanned.length) fails.push('存在被禁止的本地决策 API：' + report.presentBanned.join(', '));
if (report && report.briefing && report.briefing.ok && report.briefing.missing.length) fails.push('briefing 缺字段：' + report.briefing.missing.join(', '));
if (report && report.briefing && report.briefing.badKeys.length) fails.push('briefing 出现推荐/策略字段：' + report.briefing.badKeys.join(', '));
if (report && !report.knowledge) warns.push('knowledge 没返回（可能不在关卡内，或资源未缓存）');
if (report && report.briefing && report.briefing.ok && report.briefing.cards === 0) warns.push('briefing.cards 为空（可能不在选卡/关卡内）');

const out = { at: new Date().toISOString(), port: PORT, report, fails, warns, ok: fails.length === 0 };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
bridge.close();
process.exitCode = out.ok ? 0 : 1;
