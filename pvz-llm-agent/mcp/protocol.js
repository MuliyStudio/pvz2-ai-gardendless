/**
 * MCP stdio 协议层：JSON-RPC 一行一条。
 * 只做协议转换，工具在 router 里。
 */
import readline from 'node:readline';
import { TOOLS } from '../tools/definitions.js';

const PROTOCOL_VERSION = '2024-11-05';

export function createMcpServer({ router, version = '0.1.10', name = 'pvz-llm-agent' }) {
  const log = (...args) => { try { console.error('[pvz-llm-agent]', ...args); } catch { /* ignore */ } };

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = msg;
    const isNotification = id == null;
    const respond = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const respondError = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

    try {
      switch (method) {
        case 'initialize':
          return respond({
            protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions:
              '你是唯一的决策者。先 pvz_briefing 读事实，自己制定计划并 pvz_set_plan；选卡用 pvz_choose_deck（不会自动补卡）；' +
              '战斗循环：pvz_state / pvz_events → 自己决策 → pvz_act → pvz_wait_until。工具只执行和返回真实结果，不提供本地建议。',
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return respond({});
        case 'tools/list':
          return respond({ tools: TOOLS });
        case 'tools/call': {
          const toolName = params && params.name;
          const args = (params && params.arguments) || {};
          if (!toolName) return respondError(-32602, '缺少 tool name');
          log('call', toolName);
          const result = await router.call(toolName, args);
          const isError = !!(result && typeof result === 'object' && result.ok === false);
          const text = typeof result === 'string' ? result : (result === undefined ? 'null' : JSON.stringify(result, null, 2));
          const out = { content: [{ type: 'text', text }], isError };
          if (result && typeof result === 'object' && !Array.isArray(result)) out.structuredContent = result;
          return respond(out);
        }
        case 'resources/list':
          return respond({ resources: [] });
        case 'resources/templates/list':
          return respond({ resourceTemplates: [] });
        case 'prompts/list':
          return respond({ prompts: [] });
        case 'logging/setLevel':
          return respond({});
        default:
          return respondError(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      log('error', method, e && e.message);
      return respondError(-32603, String(e && e.message || e));
    }
  }

  function runStdio() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', async (line) => {
      const s = String(line || '').trim();
      if (!s) return;
      let msg;
      try { msg = JSON.parse(s); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        return;
      }
      if (Array.isArray(msg)) {
        const out = [];
        for (const m of msg) {
          const r = await handle(m);
          if (r) out.push(r);
        }
        if (out.length) process.stdout.write(JSON.stringify(out) + '\n');
        return;
      }
      const r = await handle(msg);
      if (r) process.stdout.write(JSON.stringify(r) + '\n');
    });
    rl.on('close', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }

  return { handle, runStdio, protocolVersion: PROTOCOL_VERSION };
}
