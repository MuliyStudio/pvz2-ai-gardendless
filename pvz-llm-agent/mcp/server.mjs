#!/usr/bin/env node
/**
 * MCP stdio server：Claude / Cursor / OpenCode 等外部客户端入口。
 *
 * 环境变量：
 *   PVZ_CDP_PORT   调试端口，默认 9222
 *   PVZ_GLOBAL     游戏里暴露的桥对象，默认 PvzLlm
 *
 * 注意：不在 stdout 打日志（MCP 用 stdout 传协议），日志一律 stderr。
 */
import { createCdpBridge } from './cdp.js';
import { createToolRouter } from '../tools/router.js';
import { createMcpServer } from './protocol.js';

const VERSION = '0.1.12';
const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const GLOBAL = process.env.PVZ_GLOBAL || 'PvzLlm';

const log = (...args) => { try { console.error('[pvz-mcp]', ...args); } catch { /* ignore */ } };

const bridge = createCdpBridge({ port: PORT, globalName: GLOBAL });
const router = createToolRouter({ bridge, version: VERSION });
const server = createMcpServer({ router, version: VERSION, name: 'pvz-llm-agent' });

log(`v${VERSION} listening on stdio; CDP 127.0.0.1:${PORT}; global window.${GLOBAL}`);
log('tools:', router.names.join(', '));
server.runStdio();

process.on('exit', () => { try { bridge.close(); } catch { /* ignore */ } });
