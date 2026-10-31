#!/usr/bin/env node
/**
 * replay：把 live-play.mjs 生成的报告按轮次回放成时间线（只读，不连游戏）。
 *
 * 用法：
 *   node scripts/replay.mjs                       # 默认读 live-play-report.json
 *   node scripts/replay.mjs other-report.json
 *
 * 输出：每轮 state（阶段/波次/阳光/植物/僵尸/工具数）、计划变化、模型/工具耗时、guard code。
 * 用来回答“这一局第几轮慢、哪一步开始掉线、计划什么时候改的”。
 */
import fs from 'node:fs';

const file = process.argv[2] || 'live-play-report.json';
let report;
try {
  report = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`读不了报告 ${file}：${String(e && e.message || e)}`);
  process.exit(1);
}

const rows = [];
let lastPlan = '';
let lastCodes = '';
let lastStep = 0;

for (const s of report.samples || []) {
  const planText = s.plan ? String(s.plan.text || s.plan.style || s.plan.goal || '') : '';
  if (planText && planText !== lastPlan) {
    rows.push({ t: s.t, kind: 'plan', text: planText });
    lastPlan = planText;
  }
  for (const tm of s.timings || []) {
    if (!Number.isFinite(Number(tm.step)) || Number(tm.step) <= lastStep) continue;
    lastStep = Number(tm.step);
    rows.push({ t: s.t, kind: 'timing', text: `轮 ${tm.step}：模型 ${tm.modelMs}ms · 工具 ${tm.toolMs}ms` });
  }
  rows.push({
    t: s.t,
    kind: 'state',
    text: `${s.phase || '?'} 波${s.wave == null ? '?' : s.wave} 阳光${s.sun == null ? '?' : s.sun} 植物${s.plants == null ? '?' : s.plants} 僵尸${s.zombies == null ? '?' : s.zombies} 工具${s.toolCalls == null ? 0 : s.toolCalls}`,
  });
  const codes = s.guardCodes
    ? Object.entries(s.guardCodes).map(([k, v]) => `${k}×${v}`).join(' ')
    : '';
  if (codes && codes !== lastCodes) {
    rows.push({ t: s.t, kind: 'guard', text: codes });
    lastCodes = codes;
  }
}

const ICON = { state: '·', plan: '◇', timing: '⏱', guard: '!' };
for (const r of rows) {
  console.log(`[${String(r.t).padStart(6)}s] ${ICON[r.kind] || '·'} ${r.text}`);
}

const summary = {
  file,
  samples: (report.samples || []).length,
  phases: report.phases || [...new Set((report.samples || []).map((s) => s.phase).filter(Boolean))],
  ok: report.ok,
  errors: report.errors || [],
  guardCodes: report.codes || null,
  cellBlocked: report.cellBlocked || null,
  rounds: lastStep,
};
console.log('\n' + JSON.stringify(summary, null, 2));
