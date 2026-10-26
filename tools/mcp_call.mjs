import { spawn } from 'node:child_process';
import fs from 'node:fs';

// 用一份全新的 MCP Server 进程执行一串调用，避免当前 OpenCode 会话仍是旧工具表。
// 用法：node tools/mcp_call.mjs calls.json
const callsFile = process.argv[2];
if (!callsFile) { console.error('usage: node tools/mcp_call.mjs <calls.json>'); process.exit(1); }
const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));

const child = spawn(process.execPath, ['PvZ-MCP/pvz-mcp-server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
child.stderr.on('data', () => {});
let seq = 1;
function rpc(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(method + ' timeout')); } }, 40000);
  });
}
const textOf = (r) => {
  const c = r.result && r.result.content && r.result.content[0];
  return c ? c.text : JSON.stringify(r);
};
const short = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v.slice(0, 300); }
};

await rpc('initialize', { protocolVersion: '2024-11-05' });
const out = [];
for (const c of calls) {
  if (c.sleep) { await new Promise((r) => setTimeout(r, c.sleep * 1000)); out.push({ sleep: c.sleep }); continue; }
  const r = await rpc('tools/call', { name: c.name, arguments: c.args || {} });
  const raw = textOf(r);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw.slice(0, 800); }
  out.push({ call: c.name, ok: !(r.result && r.result.isError), result: parsed });
}
console.log(JSON.stringify(out.slice(-30), null, 1));
child.kill();
process.exit(0);
