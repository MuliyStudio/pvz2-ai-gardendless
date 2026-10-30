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
  'knowledge/worlds.js',
  'bridge/stats.js',
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
