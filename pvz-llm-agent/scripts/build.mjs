#!/usr/bin/env node
/**
 * 打包游戏内模组：把 bridge + tools + in-game 拼成一个 GP-Next 可加载的单文件。
 *
 * GP-Next 会把 export default 当函数体执行；这里保留 `export default { setup: setupInGame }`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MODULES = [
  // tags 必须排在 worlds 前面：worlds 在模块初始化时就会读 TAG_CAPABILITIES 给 TAG_COUNTERS.needs 赋值。
  'knowledge/tags.js',
  'knowledge/plant-rules.js',
  'knowledge/zombie-rules.js',
  'knowledge/worlds.js',
  'bridge/stats.js',
  'bridge/forecast.js',
  'bridge/mechanics.js',
  'bridge/level-memory.js',
  'bridge/latency.js',
  'bridge/snapshot.js',
  'bridge/actions.js',
  'bridge/briefing.js',
  'bridge/plan.js',
  'bridge/events.js',
  'bridge/api.js',
  'tools/definitions.js',
  'tools/errors.js',
  'tools/wait.js',
  'tools/format.js',
  'tools/router.js',
  'in-game/prompt.js',
  'in-game/agent.js',
  'in-game/pet-sprites.js',
  'in-game/ui.js',
  'in-game/setup.js',
];

function stripModule(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*import\s/.test(line))
    .map((line) => line.replace(/^export\s+(?=(?:const|let|function|class|async))/, ''))
    .join('\n')
    .replace(/^export\s+default.*$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
}

const body = MODULES.map((f) => `// ── ${f} ──\n` + stripModule(read(f))).join('\n\n');

// 安全检查：模块里 import 的相对路径必须都在 MODULES 里，否则打包出来的 bundle 会在运行时
// 报 "xxx is not defined"（0.1.23 就因为漏了 bridge/latency.js 踩过一次）。
const missing = [];
for (const m of MODULES) {
  const src = read(m);
  for (const hit of src.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(m), hit[1]));
    if (!MODULES.includes(rel)) missing.push(`${m} -> ${rel}`);
  }
}
if (missing.length) {
  console.error('[build] 这些相对 import 没有加进 MODULES：\n  ' + missing.join('\n  '));
  process.exit(1);
}

// 重复声明检查：所有模块会被拼进同一个函数体，同名的顶层 const/function 会直接
// 报 "Identifier 'x' has already been declared"（装到游戏里才炸，很难定位）。
// 这里在打包阶段就拦下来，并指出是哪两个文件。
const declared = new Map();
const dupes = [];
for (const m of MODULES) {
  for (const line of read(m).split(/\r?\n/)) {
    const hit = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!hit) continue;
    const name = hit[1];
    if (declared.has(name) && declared.get(name) !== m) dupes.push(`${name}: ${declared.get(name)} 与 ${m}`);
    else declared.set(name, m);
  }
}
if (dupes.length) {
  console.error('[build] 顶层标识符重名（bundle 是同一作用域，会直接报 already declared）：\n  ' + dupes.join('\n  '));
  process.exit(1);
}

// import 名称检查：路径存在但导出的名字写错时，Node ESM 会报错，
// 但 bundle 只是 strip 掉 import 行，调用时才会 undefined。这里提前拦。
const exportsOf = new Map();
for (const m of MODULES) {
  const names = new Set();
  for (const line of read(m).split(/\r?\n/)) {
    let h = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (h) names.add(h[1]);
    h = /^export\s*\{([^}]*)\}/.exec(line);
    if (h) {
      for (const part of h[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) names.add(n);
      }
    }
  }
  exportsOf.set(m, names);
}
const badImports = [];
for (const m of MODULES) {
  for (const line of read(m).split(/\r?\n/)) {
    const h = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/.exec(line);
    if (!h) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(m), h[2]));
    const names = exportsOf.get(target);
    if (!names) continue;
    for (const part of h[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !names.has(name)) badImports.push(`${m} -> ${target}#${name}`);
    }
  }
}
if (badImports.length) {
  console.error('[build] import 的名字在目标模块里不存在（bundle 里会变成 undefined）：\n  ' + badImports.join('\n  '));
  process.exit(1);
}

const out = `// 由 scripts/build.mjs 生成，请勿直接编辑。
// 源文件：bridge + tools + in-game
'use strict';
${body}

export default { setup: setupInGame };
`;

const target = path.join(root, 'pack', 'scripts', 'main.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out, 'utf8');
console.log(`bundle -> ${path.relative(root, target)} (${out.length} bytes, ${MODULES.length} modules)`);

const checker = path.join(root, '..', 'tools', 'check_mod.js');
if (fs.existsSync(checker)) {
  try {
    const res = execFileSync(process.execPath, [checker, target], { encoding: 'utf8' });
    console.log(res.trim());
  } catch (e) {
    console.error('函数体语法校验失败：\n' + String(e.stdout || e.message));
    process.exit(1);
  }
} else {
  console.warn('未找到 ../tools/check_mod.js，跳过 GP-Next 函数体校验');
}
