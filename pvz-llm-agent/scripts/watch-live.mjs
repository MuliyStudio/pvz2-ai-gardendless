#!/usr/bin/env node
/**
 * 真机监视：连上正在跑的游戏，逐拍打印「模型这一轮到底看到了什么」。
 *
 * 目的不是替 LLM 决策，而是验证数据链路：
 *   - cards 里有没有 burst / damageType / plantFood / activation
 *   - plants[] 的 food 有没有 targets / whiff
 *   - plant_food 有没有被 FOOD_NO_TARGET 拦下
 *   - activate 有没有被真的调用、via 是哪个方法
 *
 * 用法：
 *   node scripts/watch-live.mjs                  # 只看，不操作（默认 10 分钟）
 *   node scripts/watch-live.mjs --seconds 1800
 *   node scripts/watch-live.mjs --check          # 只做一次字段体检后退出
 *   node scripts/watch-live.mjs --start          # 顺手点浮窗的“开始 AI”
 *   node scripts/watch-live.mjs --out report.json
 */
import fs from 'node:fs';
import { createCdpBridge } from '../mcp/cdp.js';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const SECONDS = Math.max(5, Math.min(7200, Number(argOf('--seconds', 600)) || 600));
const INTERVAL = Math.max(0.5, Math.min(10, Number(argOf('--interval', 2)) || 2));
const OUT = argOf('--out', 'live-watch-report.json');
const CHECK_ONLY = args.includes('--check');
const START = args.includes('--start');
const AUTO = args.includes('--auto');
const PROBE_ACTIVATE = args.includes('--probe-activate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridge = createCdpBridge({ port: Number(process.env.PVZ_CDP_PORT || 9222) });
const report = { at: new Date().toISOString(), seconds: SECONDS, samples: [], actions: [], codes: {}, errors: [], ok: false };

/** 页面里跑：拿一份和模型看到的一样的状态，外加模型侧的动作记录。 */
const READ = `(() => {
  const P = window.PvzLlm;
  const A = window.PvzLlmAgent;
  if (!P) return { ok: false, code: 'MOD_NOT_LOADED' };
  const s = P.snapshot();
  const out = {
    ok: true,
    version: P.version,
    agentVersion: A && A.version,
    running: A && A.agent && A.agent.isRunning ? !!A.agent.isRunning() : null,
    phase: s.phase,
    paused: s.paused,
    wave: s.level && s.level.wave,
    waves: s.level && s.level.waves,
    sun: s.sun,
    food: s.plantFood,
    usable: s.plantFoodUsable,
    useful: s.plantFoodUseful,
    plants: (s.plants || []).length,
    zombies: (s.zombies || []).length,
    deck: s.deck || [],
    prepMode: s.prep && s.prep.mode,
    poolClick: (s.seedSelection && Array.isArray(s.seedSelection.available)
      ? s.seedSelection.available.filter((c) => c.activation && c.activation !== 'auto')
        .map((c) => ({ type: c.type, activation: c.activation, foodKind: c.foodKind, burstDmg: c.burstDmg }))
      : null),
    cards: (s.cards || []).map((c) => ({
      type: c.type,
      activation: c.activation,
      burst: c.burstDmg,
      food: c.foodKind,
      atkDps: c.dps,
      armorState: c.armorState,
      damageType: c.damageType,
    })),
    foodPlan: s.brief && s.brief.plantFoodPlan ? s.brief.plantFoodPlan : null,
    activatePlan: s.brief && s.brief.activatePlan ? s.brief.activatePlan : null,
    plantFoods: (s.plants || []).filter((p) => p.food).map((p) => ({
      lane: p.lane, column: p.column, type: p.type,
      kind: p.food.kind, area: p.food.area, total: p.food.total,
      targets: p.food.targets, whiff: p.food.whiff, foodable: p.foodable,
    })),
    clickPlants: (s.plants || []).filter((p) => p.activation && p.activation !== 'auto').map((p) => ({
      lane: p.lane, column: p.column, type: p.type, aim: p.aim,
    })),
    lanes: (s.lanes || []).map((l) => ({ lane: l.lane, z: l.zombies, dps: l.dps, gap: l.gap })),
    tasks: (s.tasks || []).map((t) => ({ tip: t.tip, hint: t.hint, urgent: t.urgent, failed: t.failed })),
  };
  // 模型侧动作：从 messages 里取 pvz_act 的 actions + 返回 code
  const msgs = A && A.agent && A.agent.getMessages ? A.agent.getMessages() : [];
  out.toolCount = msgs.filter((m) => m.role === 'tool').length;
  out.lastActs = [];
  for (let i = msgs.length - 1; i >= 0 && out.lastActs.length < 8; i--) {
    const m = msgs[i];
    if (m.role !== 'tool' || m.name !== 'pvz_act') continue;
    let v = null;
    try { v = JSON.parse(m.content); } catch { /* ignore */ }
    const prev = msgs[i - 1];
    const calls = prev && prev.tool_calls ? prev.tool_calls : [];
    const call = calls.find((c) => c.function && c.function.name === 'pvz_act');
    let sent = [];
    try { sent = call ? (JSON.parse(call.function.arguments).actions || []) : []; } catch { sent = []; }
    out.lastActs.push({
      sent: sent.map((a) => ({ type: a.type, lane: a.lane, column: a.column, plant: a.plant, targetLane: a.targetLane, targetColumn: a.targetColumn, force: a.force })),
      results: ((v && v.results) || []).map((r) => ({ type: r.action || r.type, ok: r.ok, code: r.code, via: r.via, targets: r.plantFood && r.plantFood.kind })),
    });
    break;
  }
  return out;
})()`;

function pad(v, n) { return String(v == null ? '-' : v).padEnd(n).slice(0, n); }
function line(s) {
  const laneTxt = (s.lanes || []).map((l) => `L${l.lane + 1}:z${l.z}/dps${l.dps}/g${l.gap}`).join(' ');
  return `[${new Date().toLocaleTimeString()}] ${pad(s.phase, 10)} wave ${s.wave}/${s.waves} | 阳光 ${s.sun} 豆 ${s.food}(用${s.useful}/${s.usable}) | 植物 ${s.plants} 僵尸 ${s.zombies} | ${laneTxt}`;
}

try {
  const mod = await bridge.evaluate(`(() => ({ bridge: !!window.PvzLlm, agent: !!window.PvzLlmAgent }))()`);
  if (!mod || !mod.bridge) throw new Error('window.PvzLlm 不存在：模组没加载或没启用');

  const first = await bridge.evaluate(READ);
  console.log('版本 bridge=' + first.version + ' agent=' + first.agentVersion + ' | running=' + first.running + ' | phase=' + first.phase);
  console.log('卡片字段体检：');
  for (const c of first.cards.slice(0, 12)) {
    console.log(`  ${pad(c.type, 22)} activation=${pad(c.activation || 'auto', 10)} burst=${pad(c.burst, 6)} food=${pad(c.food, 14)} dmgType=${pad(c.damageType, 8)} armor=${pad(c.armorState, 8)} dps=${c.atkDps}`);
  }
  const cardsWithFood = first.cards.filter((c) => c.food).length;
  const clickCards = first.cards.filter((c) => c.activation && c.activation !== 'auto');
  console.log(`  带能量豆字段 ${cardsWithFood}/${first.cards.length}；点击卡 ${clickCards.length}：${clickCards.map((c) => c.type).join(', ') || '无'}`);
  report.first = first;

  if (args.includes('--dump')) {
    fs.writeFileSync('live-watch-dump.json', JSON.stringify(first, null, 1));
    console.log('\n状态快照 -> live-watch-dump.json');
    console.log('场上植物 food：', JSON.stringify(first.plantFoods));
    console.log('点击植物：', JSON.stringify(first.clickPlants));
    console.log('豆计划：', JSON.stringify(first.foodPlan));
    console.log('点击计划：', JSON.stringify(first.activatePlan));
    console.log('最近动作：', JSON.stringify(first.lastActs));
  }

  if (CHECK_ONLY) {
    report.ok = true;
    console.log('\n--check：字段体检完成');
  } else if (START) {
    const r = await bridge.evaluate(`(() => { const A = window.PvzLlmAgent; if (!A || !A.ui || typeof A.ui.startAI !== 'function') return { ok: false }; A.ui.startAI(); return { ok: true }; })()`);
    console.log('start:', JSON.stringify(r));
    await sleep(1500);
  }

  const startedAt = Date.now();
  let lastToolCount = first.toolCount || 0;
  let last = first;
  let autoStarted = false;
  let waitNote = 0;
  let lastDeckTxt = '';
  const probed = new Set();
  let lastPrintedAt = 0;
  last.phaseWave = '';
  while (!CHECK_ONLY && Date.now() - startedAt < SECONDS * 1000) {
    let s = null;
    try { s = await bridge.evaluate(READ); } catch (e) { report.errors.push(String(e && e.message || e)); await sleep(INTERVAL * 1000); continue; }
    if (!s || !s.ok) { report.errors.push(s && s.code || 'NO_STATE'); await sleep(INTERVAL * 1000); continue; }

    // --auto：等玩家进关卡后自动点“开始 AI”（只点一次）
    if (AUTO && !autoStarted && s.running === false && (s.phase === 'preparing' || s.phase === 'running')) {
      const r = await bridge.evaluate(`(() => { const A = window.PvzLlmAgent; if (!A || !A.ui || typeof A.ui.startAI !== 'function') return { ok:false }; A.ui.startAI(); return { ok:true }; })()`);
      if (r && r.ok) {
        autoStarted = true;
        console.log('▶ 已在 ' + s.phase + ' 阶段启动 AI');
      }
    }
    if (AUTO && !autoStarted && (s.phase === 'menu' || s.phase === 'worldmap')) {
      waitNote += 1;
      if (waitNote % 15 === 1) console.log('… 等待进入关卡（现在在 ' + s.phase + '）');
    }

    // 选卡阶段：把卡池里的点击卡、AI 最终选中的卡组打出来
    if (s.poolClick) {
      console.log('    卡池点击卡: ' + (s.poolClick.map((c) => `${c.type}(${c.activation}${c.burstDmg ? ',burst' + c.burstDmg : ''})`).join(' ') || '无'));
      report.poolClick = s.poolClick;
    }
    const deckTxt = (s.deck || []).join(',');
    if (deckTxt && deckTxt !== lastDeckTxt) {
      const clickInDeck = (s.poolClick || []).filter((c) => (s.deck || []).includes(c.type)).map((c) => c.type);
      console.log(`    当前卡组(${s.phase}): ${deckTxt}${clickInDeck.length ? '  ← 含点击卡 ' + clickInDeck.join('/') : ''}`);
      lastDeckTxt = deckTxt;
    }

    // 安静模式：只在阶段/波次变化、有动作、或每 30 秒心跳时打印一行
    const now = Date.now();
    const phaseWave = `${s.phase}:${s.wave}`;
    const changed = phaseWave !== last.phaseWave;
    if (changed || now - lastPrintedAt >= 30000) {
      console.log(line(s));
      lastPrintedAt = now;
      last.phaseWave = phaseWave;
    }

    // --probe-activate：一旦场上有点击植物，就替模型点一次，验证真入口
    // （只在 shouldAct=true 时点，避免纯浪费；同一株同一波只点一次）
    if (PROBE_ACTIVATE && Array.isArray(s.activatePlan)) {
      for (const c of s.activatePlan) {
        const key = `${c.lane}:${c.column}:${s.wave}`;
        if (probed.has(key)) continue;
        if (!c.shouldAct || c.aim === 'free_cell' || c.aim === 'swap') continue;
        probed.add(key);
        const r = await bridge.evaluate(`(async () => { const P = window.PvzLlm; try { return await P.act({ type: 'activate', lane: ${c.lane}, column: ${c.column} }); } catch (e) { return { ok: false, code: 'THREW', reason: String(e && e.message || e) }; } })()`);
        console.log(`  🖱 probe activate ${c.type}@${c.lane},${c.column} → ${JSON.stringify(r)}`);
        report.probes = report.probes || [];
        report.probes.push({ at: new Date().toISOString(), plan: c, result: r });
      }
    }

    // 新增动作
    if (s.lastActs && s.lastActs.length) {
      const latest = s.lastActs[0];
      const newTool = (s.toolCount || 0) > lastToolCount;
      if (newTool) {
        for (let i = 0; i < latest.sent.length; i++) {
          const a = latest.sent[i];
          const r = latest.results[i] || {};
          const mark = r.ok === true ? '✅' : r.ok === false ? '❌' : '·';
          const extra = r.code ? ` (${r.code}${r.via ? ' via ' + r.via : ''})` : (r.via ? ` via ${r.via}` : '');
          console.log(`    ${mark} ${a.type}${a.plant ? ' ' + a.plant : ''} @ ${a.lane},${a.column}${a.targetLane != null ? ' → ' + a.targetLane + ',' + a.targetColumn : ''}${extra}`);
          report.actions.push({ t: new Date().toISOString(), action: a, result: r });
          if (r.code) report.codes[r.code] = (report.codes[r.code] || 0) + 1;
        }
      }
    }

    // 能量豆计划 / 点击计划有变化时打一行
    const planTxt = (s.foodPlan || []).slice(0, 3).map((p) => `${p.type}@${p.lane},${p.column}(targets=${p.targets},total=${p.total})`).join(' ');
    const prevPlanTxt = (last.foodPlan || []).slice(0, 3).map((p) => `${p.type}@${p.lane},${p.column}(targets=${p.targets},total=${p.total})`).join(' ');
    if (planTxt && planTxt !== prevPlanTxt) console.log('    豆计划: ' + planTxt);
    const clickTxt = (s.activatePlan || []).map((c) => `${c.type}@${c.lane},${c.column}(aim=${c.aim},front=${c.frontZombie},api=${c.api || 'null'})`).join(' ');
    const prevClickTxt = (last.activatePlan || []).map((c) => `${c.type}@${c.lane},${c.column}(aim=${c.aim},front=${c.frontZombie},api=${c.api || 'null'})`).join(' ');
    if (clickTxt && clickTxt !== prevClickTxt) console.log('    点击计划: ' + clickTxt);

    lastToolCount = s.toolCount || lastToolCount;
    last = s;
    report.samples.push({ t: Math.round((Date.now() - startedAt) / 100) / 10, phase: s.phase, wave: s.wave, sun: s.sun, food: s.food, useful: s.useful, usable: s.usable, plants: s.plants, zombies: s.zombies, gaps: (s.lanes || []).map((l) => l.gap) });
    await sleep(INTERVAL * 1000);
  }
  report.ok = true;
} catch (e) {
  report.errors.push(String(e && e.message || e));
  console.error('监视失败：' + String(e && e.message || e));
} finally {
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); console.log('\n报告 -> ' + OUT); } catch { /* ignore */ }
  bridge.close();
}
