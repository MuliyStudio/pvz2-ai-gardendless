import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../mcp/protocol.js';
import { TOOLS } from '../tools/definitions.js';

function serverWith(result) {
  return createMcpServer({
    router: { call: async (name, args) => (typeof result === 'function' ? result(name, args) : result) },
    version: '0.1.10',
  });
}

test('MCP initialize / tools/list / tools/call', async () => {
  const server = serverWith({ ok: true, echo: true });
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(init.result.serverInfo.name, 'pvz-llm-agent');
  assert.equal(init.result.serverInfo.version, '0.1.10');
  assert.ok(init.result.capabilities.tools);

  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);

  const call = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pvz_state', arguments: {} } });
  assert.equal(call.result.isError, false);
  assert.ok(call.result.content[0].text.includes('"echo": true'));
  assert.equal(call.result.structuredContent.ok, true);
});

test('MCP 工具失败时 isError=true，并保留 code', async () => {
  const server = serverWith({ ok: false, code: 'DECK_NOT_FULL', reason: '差 2 张' });
  const call = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pvz_choose_deck', arguments: { cards: ['a'] } } });
  assert.equal(call.result.isError, true);
  assert.ok(call.result.content[0].text.includes('DECK_NOT_FULL'));
});

test('MCP 未知方法返回 -32601，通知不返回响应', async () => {
  const server = serverWith({ ok: true });
  const bad = await server.handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
  assert.equal(bad.error.code, -32601);
  const note = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note, null);
});

test('MCP ping / resources / prompts', async () => {
  const server = serverWith({ ok: true });
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 6, method: 'ping' })).result, {});
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).result.resources, []);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 8, method: 'prompts/list' })).result.prompts, []);
});
