#!/usr/bin/env node
/**
 * PvZ2 Gardendless · MCP Server
 *
 * 让 Claude Desktop / Cursor / Cline / 任意 MCP 客户端通过工具操控游戏。
 * 传输：MCP stdio（JSON-RPC，一行一条）
 * 游戏桥：WebView2 CDP -> window.PvzAI（GP-Next 模组暴露）
 *
 * 使用前：
 *  1. 用 PvZAI_Launcher.exe 启动游戏（会开 9222 调试端口并加载模组）
 *  2. 在 MCP 客户端里配置本文件：node pvz-mcp-server.mjs
 *
 * 环境变量：
 *  PVZ_CDP_PORT  默认 9222
 */

import readline from 'node:readline';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const VERSION = '0.1.0';
const log = (...args) => { try { console.error('[pvz-mcp]', ...args); } catch { /* ignore */ } };

let ws = null;
let wsPageId = null;
let seq = 1;
const pending = new Map();

const GUIDE = `你是《植物大战僵尸2 花园无尽》的操控者。通过 MCP 工具读取战场并下指令。

坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。僵尸 column 越小越危险。

基本规则：
- 阳光、能量豆、金币会自动收取，不需要你操作。
- 种植会扣阳光并进入冷却；同一张卡冷却中不能再用；一格只能种一株（除非卡牌允许叠加）。
- 僵尸从右往左走，吃掉植物；到最左会触发小推车（每行一次）。
- 射手向右攻击；坚果挡路；冰系减速/冻结；一次性植物触发后消失；地刺不会被啃食但会被滚动物体摧毁；弹簧豆把僵尸弹回/弹进水。
- 卡牌费用/冷却看 pvz_state 的 state.cards；卡牌和僵尸的真实技能用 pvz_knowledge 查询。
- 能量豆会自动收集；需要时用 pvz_plant_food 给高输出植物释放大招。

推荐循环：
1. pvz_state（看阳光、卡槽、植物、僵尸、波次）
2. 决策：补经济/输出/防御/一次性救场
3. pvz_plant / pvz_plant_food / pvz_shovel
4. 再 pvz_state 验证结果

策略：
- 前期优先 2-3 个阳光生产者（column 0-2）。
- 攻击植物优先 column 1-4；不要把植物种在已有植物的格子。
- 某行僵尸 column<=3 时优先补防御/输出；column<=1 紧急。
- 只选择 ready=true 的卡；cd>0 或 affordable=false 不要用。
- 每回合最多 3 个动作；没有值得做的就 pvz_wait。
- 不要 shovel，除非明显挡路或血量极低且需要腾位。`;

const TOOLS = [
  {
    name: 'pvz_state',
    description: '读取当前战场：阳光/能量豆、卡槽费用与冷却、植物、僵尸、波次、当前卡牌与场上僵尸的图鉴知识。每回合先调用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_knowledge',
    description: '查询某个植物或僵尸的真实图鉴：名称、短介绍、特殊能力、属性（来自游戏内 almanac）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['plant', 'zombie'] },
        id: { type: 'string', description: 'codename，例如 iceburg / peashooter / pirate' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_plant',
    description: '把某张卡种到指定格子。会走游戏原生流程：扣阳光、进冷却、受地形/植物上限限制。',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'integer', minimum: 0, maximum: 9, description: 'pvz_state 里的卡槽下标' },
        lane: { type: 'integer', minimum: 0, maximum: 4 },
        column: { type: 'integer', minimum: 0, maximum: 8 },
      },
      required: ['card', 'lane', 'column'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_collect',
    description: '立即收取场上所有可点击掉落物（阳光/能量豆/金币/钻石等）。通常自动收取，手动兜底用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_plant_food',
    description: '给指定格子的植物使用能量豆（叶绿素）。',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'integer', minimum: 0, maximum: 4 },
        column: { type: 'integer', minimum: 0, maximum: 8 },
      },
      required: ['lane', 'column'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_shovel',
    description: '铲除指定格子的植物。慎用。',
    inputSchema: {
      type: 'object',
      properties: {
        lane: { type: 'integer', minimum: 0, maximum: 4 },
        column: { type: 'integer', minimum: 0, maximum: 8 },
      },
      required: ['lane', 'column'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_choose_deck',
    description: '在选卡阶段选择卡组。传 plants 数组；不传则自动选。',
    inputSchema: {
      type: 'object',
      properties: { plants: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_start_level',
    description: '在选卡阶段点击“一起摇滚吧”开始战斗。选卡界面完全就绪后再调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_wait',
    description: '等待一段时间（秒），让游戏推进。',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 0.2, maximum: 15 } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_rules',
    description: '返回游戏规则、坐标约定和推荐策略。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const RESOURCES = [
  { uri: 'pvz://guide', name: '游戏规则与策略', mimeType: 'text/markdown' },
  { uri: 'pvz://state', name: '当前战场状态', mimeType: 'application/json' },
  { uri: 'pvz://plants', name: '全部植物 codename 列表', mimeType: 'application/json' },
  { uri: 'pvz://zombies', name: '全部僵尸 codename 列表', mimeType: 'application/json' },
];

const TEMPLATES = [
  { uriTemplate: 'pvz://plant/{id}', name: '植物图鉴', mimeType: 'application/json' },
  { uriTemplate: 'pvz://zombie/{id}', name: '僵尸图鉴', mimeType: 'application/json' },
];

const PROMPTS = [
  { name: 'pvz_play', description: '开始一局 PvZ2：读取战场、按波次决策、用工具操作。' },
];

const PLAY_PROMPT = `你现在要操控《植物大战僵尸2 花园无尽》。
请先调用 pvz_rules，然后循环：
1. 调用 pvz_state 读取战场；
2. 根据卡槽费用/冷却、植物和僵尸的图鉴能力做决策；
3. 用 pvz_plant / pvz_plant_food / pvz_shovel 执行，最多 3 个动作；
4. 如果没事可做就 pvz_wait 2-4 秒，再回到第 1 步。
不要猜植物/僵尸能力；需要时先调用 pvz_knowledge 查询。`;

async function getPages() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pickPage(pages) {
  const list = (pages || []).filter((t) => t.type === 'page');
  return list.find((t) => /cocos|gardendless|pvz/i.test((t.title || '') + (t.url || '')))
    || list.find((t) => /^https?:\/\/tauri\.localhost\/?$/i.test(t.url || ''))
    || list.find((t) => /tauri\.localhost/i.test(t.url || '') && !/cloud\.html/i.test(t.url || ''))
    || null;
}

async function connect() {
  const pages = await getPages();
  if (!pages) throw new Error('没有检测到游戏调试端口。请先运行 PvZAI_Launcher.exe 启动游戏。');
  const page = pickPage(pages);
  if (!page) throw new Error('没有找到游戏页面。请确认游戏已经启动。');
  if (ws && ws.readyState === 1 && wsPageId === page.id) return;
  try { if (ws) ws.close(); } catch { /* ignore */ }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
  wsPageId = page.id;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  };
  ws.onclose = () => {
    ws = null;
    wsPageId = null;
    for (const p of pending.values()) p.reject(new Error('CDP 连接已断开'));
    pending.clear();
  };
  await send('Runtime.enable', {});
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) { reject(new Error('CDP 未连接')); return; }
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(method + ' 超时'));
      }
    }, 20000);
  });
}

async function evaluate(expression) {
  await connect();
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面执行异常');
  }
  return r.result ? r.result.value : undefined;
}

async function callMod(expr) {
  const wrapped = `(() => { try { const v = (${expr}); return JSON.stringify({ ok: true, value: v }); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); } })()`;
  const raw = await evaluate(wrapped);
  try { return JSON.parse(raw); } catch { return { ok: false, error: '游戏页面返回了非 JSON：' + String(raw).slice(0, 200) }; }
}

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError: !!isError };
}

async function stateValue() {
  const r = await callMod(`(() => {
    const P = window.PvzAI;
    if (!P) throw new Error('AI 模组还没有加载；请确认 GP-Next 已启用“AI 草坪指挥官”');
    const state = P.snapshot();
    const cards = (state.cards || []).map((c) => ({ ...c, knowledge: P.knowledge && P.knowledge.plant ? P.knowledge.plant(c.type) : null }));
    const ztypes = [...new Set((state.zombies || []).map((z) => z.type))];
    const zombies = ztypes.map((t) => ({ type: t, knowledge: P.knowledge && P.knowledge.zombie ? P.knowledge.zombie(t) : null }));
    return { state, cards, zombies };
  })()`);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function knowledgeValue(kind, id) {
  if (kind !== 'plant' && kind !== 'zombie') throw new Error('kind 必须是 plant 或 zombie');
  const r = await callMod(`(() => {
    const P = window.PvzAI;
    if (!P) throw new Error('AI 模组还没有加载');
    return P.knowledge[${JSON.stringify(kind)}](${JSON.stringify(String(id))});
  })()`);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function listCodename(kind) {
  const r = await callMod(`(() => {
    const P = window.PvzAI;
    if (!P || !P.ctx) throw new Error('AI 模组还没有加载');
    const domain = P.ctx[${JSON.stringify(kind)}];
    if (!domain || !domain.listFeatureEntries) throw new Error('该版本没有 ${kind} 图鉴 API');
    return domain.listFeatureEntries().map((e) => ({ id: e.id, name: (e.name && e.name.zh) || e.label || e.id }));
  })()`);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function handleTool(name, args) {
  switch (name) {
    case 'pvz_state':
      return textResult(await stateValue());
    case 'pvz_knowledge':
      return textResult(await knowledgeValue(args.kind, args.id));
    case 'pvz_plant': {
      const r = await callMod(`window.PvzAI.plant(${Number(args.card)}, ${Number(args.lane)}, ${Number(args.column)})`);
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_collect': {
      const r = await callMod('window.PvzAI.collectPickups ? window.PvzAI.collectPickups() : window.PvzAI.collectSuns()');
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_plant_food': {
      const r = await callMod(`window.PvzAI.plantFood(${Number(args.lane)}, ${Number(args.column)})`);
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_shovel': {
      const r = await callMod(`window.PvzAI.shovel(${Number(args.lane)}, ${Number(args.column)})`);
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_choose_deck': {
      const plants = Array.isArray(args.plants) ? args.plants.map(String) : [];
      const r = await callMod(`window.PvzAI.autoDeckWith ? window.PvzAI.autoDeckWith(${JSON.stringify(plants)}) : window.PvzAI.autoDeck()`);
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_start_level': {
      const r = await callMod('window.PvzAI.startLevel()');
      return textResult(r.ok ? r.value : r.error, !r.ok);
    }
    case 'pvz_wait': {
      const seconds = Math.max(0.2, Math.min(15, Number(args.seconds) || 1));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return textResult({ waited: seconds });
    }
    case 'pvz_rules':
      return textResult(GUIDE);
    default:
      return textResult('未知工具：' + name, true);
  }
}

async function handleResource(uri) {
  if (uri === 'pvz://guide') return { uri, mimeType: 'text/markdown', text: GUIDE };
  if (uri === 'pvz://state') return { uri, mimeType: 'application/json', text: JSON.stringify(await stateValue(), null, 2) };
  if (uri === 'pvz://plants' || uri === 'pvz://zombies') {
    const kind = uri === 'pvz://plants' ? 'plants' : 'zombies';
    return { uri, mimeType: 'application/json', text: JSON.stringify(await listCodename(kind), null, 2) };
  }
  const plant = /^pvz:\/\/plant\/(.+)$/.exec(uri);
  if (plant) return { uri, mimeType: 'application/json', text: JSON.stringify(await knowledgeValue('plant', decodeURIComponent(plant[1])), null, 2) };
  const zombie = /^pvz:\/\/zombie\/(.+)$/.exec(uri);
  if (zombie) return { uri, mimeType: 'application/json', text: JSON.stringify(await knowledgeValue('zombie', decodeURIComponent(zombie[1])), null, 2) };
  throw new Error('未知资源：' + uri);
}

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'pvz-gardendless', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await handleTool(name, args);
      return ok(id, result);
    } catch (e) {
      return ok(id, textResult('工具执行失败：' + (e && e.message ? e.message : e), true));
    }
  }
  if (method === 'resources/list') return ok(id, { resources: RESOURCES });
  if (method === 'resources/templates/list') return ok(id, { resourceTemplates: TEMPLATES });
  if (method === 'resources/read') {
    try {
      const content = await handleResource(params && params.uri);
      return ok(id, { contents: [content] });
    } catch (e) {
      return err(id, -32603, e && e.message ? e.message : String(e));
    }
  }
  if (method === 'prompts/list') return ok(id, { prompts: PROMPTS });
  if (method === 'prompts/get') {
    if (params && params.name === 'pvz_play') {
      return ok(id, {
        description: '开始操控 PvZ2 Gardendless',
        messages: [{ role: 'user', content: { type: 'text', text: PLAY_PROMPT } }],
      });
    }
    return err(id, -32602, '未知 prompt');
  }
  return err(id, -32601, '未知方法：' + method);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch (e) {
    process.stdout.write(JSON.stringify(err(null, -32700, 'JSON 解析失败')) + '\n');
    return;
  }
  try {
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify(err(msg && msg.id, -32603, e && e.message ? e.message : String(e))) + '\n');
  }
});
rl.on('close', () => { try { if (ws) ws.close(); } catch { /* ignore */ } process.exit(0); });

log('server started, cdp port', PORT);
