#!/usr/bin/env node
/**
 * OpenCode Go 本地代理。
 *
 * 为什么需要：opencode.ai 的 chat/completions 不返回 CORS 头，游戏跑在 WebView2 里
 * （origin 是 http://tauri.localhost），浏览器会拦掉跨域 POST，报 Failed to fetch。
 * 这个代理在本机转发请求，并补上 CORS 头；API Key 只从请求头透传，不落盘。
 *
 * 用法：node scripts/local-proxy.mjs
 *      然后在浮窗「服务商」选 OpenCode Go（本地代理）。
 *
 * 环境变量：
 *   PVZ_PROXY_PORT      监听端口，默认 8787
 *   PVZ_PROXY_UPSTREAM  上游地址，默认 https://opencode.ai/inference/go/openai/v1
 */
import http from 'node:http';

const PORT = Number(process.env.PVZ_PROXY_PORT || 8787);
const UPSTREAM = String(process.env.PVZ_PROXY_UPSTREAM || 'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/, '');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,content-type,x-opencode-session',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // 预检：浏览器带 Authorization 时一定会先发 OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/v1/')) {
    sendJson(res, 404, { error: { message: '代理只接受 /v1/* 路径' } });
    return;
  }

  // /v1/chat/completions -> <upstream>/chat/completions
  const target = UPSTREAM + url.pathname.slice(3) + url.search;
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  headers['x-opencode-session'] = req.headers['x-opencode-session'] || 'pvzllm-proxy';

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.writeHead(upstream.status, {
      ...CORS,
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (upstream.body) {
      // 流式（SSE）逐块转发，不做缓冲
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
    }
    res.end();
  } catch (e) {
    sendJson(res, 502, { error: { message: '上游请求失败：' + String(e && e.message || e) } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] http://127.0.0.1:${PORT}/v1  ->  ${UPSTREAM}`);
  console.log('[proxy] 浮窗「服务商」选 OpenCode Go（本地代理），Key 照常填；Ctrl+C 结束。');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[proxy] 端口 ${PORT} 已被占用；换一个：PVZ_PROXY_PORT=8788 node scripts/local-proxy.mjs`);
  } else {
    console.error('[proxy] 启动失败：' + (e && e.message || e));
  }
  process.exit(1);
});
