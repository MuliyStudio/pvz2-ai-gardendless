// 校验模组入口能被 GP-Next 的方式解析：
//   GP-Next 会把 `export default` 换成 `return` 再塞进函数体执行，
//   所以必须用 new Function / vm.Script 的函数体上下文校验，不能只用 `node --check`
//   （后者会把文件当 ESM，可能放过“注释把下一行代码吃掉”这类错误）。
// 用法: node tools/check_mod.js [main.js路径]
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = process.argv[2] || path.join(root, 'pvz-llm-agent', 'pack', 'scripts', 'main.js');

let src = fs.readFileSync(file, 'utf8');
if (!src.includes('export default')) {
  console.error(`[check_mod] ${file} 里没有 export default，GP-Next 可能加载不了`);
  process.exit(1);
}
src = src.replace('export default', 'return');
try {
  // eslint-disable-next-line no-new
  new vm.Script('(function(){' + src + '\n})', { filename: 'mod.js' });
  console.log('[check_mod] OK (function-body)');
} catch (e) {
  console.error('[check_mod] FAILED');
  console.error(String(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e));
  process.exit(1);
}
