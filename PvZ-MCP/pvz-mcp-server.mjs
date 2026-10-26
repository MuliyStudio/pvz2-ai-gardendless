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
const VERSION = '0.2.6';
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
1. pvz_state（看关卡任务/倒计时、地形、阳光、卡槽、植物、僵尸、波次）
2. 决策：先满足关卡任务，再补经济/输出/防御/一次性救场
3. pvz_act 一次提交 1–6 个动作（种植/铲除/能量豆/等待），比逐个调用省往返
4. 需要等条件时用 pvz_wait_until（阳光够/卡冷却好/僵尸进某行/任务完成），不要用固定 pvz_wait 空转

phase=objective：停在“关卡目标”说明界面，先 pvz_dismiss_objective。
phase=preparing：选卡（可 replace=true 换掉游戏预填卡组），然后 pvz_start_level（它会自动关闭目标说明并开局）。

地形：
- state.terrain.map 每行一个字符串：L=陆地 P=木板 W=水 S=天空 R=矿车轨道 ?=未知。
- 水格（W/S）不能种普通植物，需要睡莲/弹簧豆等水生卡；state.blockedCells 是明确不可种植的格子。
- 失败返回 code=TERRAIN 时不要重试同一格。

矿车（西部等地图）：
- state.carts 每辆给出 id / 当前 lane,column / 载着什么植物 / 可上可下。
- 矿车是可在同一轨道列上下移动的植物平台，植物会跟着车走：用 pvz_move_cart {cart,direction:"up"|"down"}。
- 某行有僵尸但没射手时，优先把载着射手的矿车移过去，而不是重复买植物；移车前确认原行不会失守。
- 轨道格只有矿车停靠时才可种植（terrain 里是 R，blockedCells 里 reason=rail 表示车不在）。

逐行信息：
- state.lanes[] 直接给出每排 shooters / nearestZombie / needsShooter / danger / mower / cart。
- needsShooter=true 表示这排有僵尸但没有射手，必须优先处理。
- 僵尸带 tags：crush（碾压植物）、jump_over（跳过植物）、backline（绕后）、flying、spawner、armored、support、lane_switch。
  典型：piano 会碾压植物并让牛仔换行；prospector 跳到最左侧；chicken_farmer 放鸡；west_bull 投小鬼。

暂停：
- state.paused=true 时种植/铲除/能量豆都会被游戏忽略；先 pvz_resume。

关卡任务与计时（state.tasks）：
- tasks[].tip 是任务文本，count 形如 "0/20" 或 "剩余 1"，completed/failed 表示状态，modeName/semantics 是可读类型。
- modeName=timed_kill：最近 N 秒内击杀的滑动窗口，看 timeLeft/windowActive/urgent。
- modeName=plant_lose_limit：left 是“还能损失几株”，left<=1 时 urgent；再丢一株就失败。
- modeName=plant_count_limit：left 是“还能种几株”。
- 任务失败通常直接判负，必须优先围绕任务打。

策略：
- 前期优先 2-3 个阳光生产者（column 0-2）。
- 攻击植物优先 column 1-4；不要把植物种在已有植物的格子。
- 某行僵尸 column<=3 时优先补防御/输出；column<=1 紧急。
- 只选择 ready=true 的卡；cd>0 或 affordable=false 不要用。
- 每回合最多 3 个动作；没有值得做的就 pvz_wait。
- 可以用 pvz_shovel 铲掉：同一行重复的坚果/弹簧豆、血量低于 30% 的危险行植物、明显低效需要腾位的植物。每次最多铲 1 个，铲完再种。
- 如果某行已有 2 个坚果/弹簧豆/冰生菜，先用 pvz_shovel 铲掉多余的一个，再补输出。
- 同一张卡不要在一批动作里连续种两次（会撞冷却）；不同卡可以。
- 动作失败带 code：PAUSED/TERRAIN/COOLDOWN/SUN/OCCUPIED/LANE_LIMIT/LEVEL_LIMIT/CART_BLOCKED…按 code 换格、等待或移车，不要重复同一个失败动作。`;

const TOOLS = [
  {
    name: 'pvz_state',
    description: '读取当前战场：地形（terrain.map / blockedCells）、关卡任务与倒计时（tasks[].timeLeft/urgent）、阳光/能量豆、卡槽费用与冷却、植物、僵尸、波次，以及当前卡牌与场上僵尸的图鉴知识。每回合先调用它。',
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
    description: '铲除指定格子的植物；支持地刺/土豆雷/睡莲等 tile 植物，可清理重复或低血量植物。',
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
    name: 'pvz_move_cart',
    description: '移动西部矿车（可移动植物平台）到同一轨道的上一行/下一行，植物会跟着车走。',
    inputSchema: {
      type: 'object',
      properties: {
        cart: { type: 'integer', minimum: 0, description: 'state.carts[].id' },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['cart', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_resume',
    description: '如果游戏处于暂停状态（state.paused=true），继续游戏；未暂停时无副作用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_health',
    description: '检查模组与 MCP Server 版本、关键能力（terrain/carts/execute/waitUntil）和安装路径，用于发现旧进程/旧模组。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_choose_deck',
    description: '在选卡阶段选择卡组。传 plants 数组；replace=true 会先清空当前卡组（游戏预填也能换掉）。返回实际 deck / applied / skipped / started。',
    inputSchema: {
      type: 'object',
      properties: {
        plants: { type: 'array', items: { type: 'string' } },
        replace: { type: 'boolean', description: '先清空当前卡组再选' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_act',
    description: '一次执行最多 6 个动作（按顺序），返回每个动作的结构化结果。省掉“每个动作一次往返”。',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['plant', 'shovel', 'plant_food', 'collect_sun', 'wait', 'choose_deck', 'start_level', 'dismiss_objective', 'move_cart', 'resume'] },
              card: { type: 'integer', minimum: 0, maximum: 9 },
              lane: { type: 'integer', minimum: 0, maximum: 4 },
              column: { type: 'integer', minimum: 0, maximum: 8 },
              plants: { type: 'array', items: { type: 'string' } },
              replace: { type: 'boolean' },
              cart: { type: 'integer', minimum: 0, description: '矿车编号（move_cart 用）' },
              direction: { type: 'string', enum: ['up', 'down'] },
            },
            required: ['type'],
          },
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_wait_until',
    description: '等到条件满足或超时（1–60 秒）。until: sun>=200 | sun<=50 | card_ready:repeater | zombie_in_lane:3 | zombie_near:2 | plantfood>=1 | cart_ready:0 | tasks_ready | phase:running | plants>=10。',
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'string', description: '条件表达式' },
        timeout: { type: 'number', minimum: 1, maximum: 60, description: '超时秒数，默认 15' },
      },
      required: ['until'],
      additionalProperties: false,
    },
  },
  {
    name: 'pvz_start_level',
    description: '开始战斗。若停在关卡目标说明界面会先自动关闭，再在选卡阶段点击“一起摇滚吧”。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pvz_dismiss_objective',
    description: '关闭开局的关卡目标说明界面（点“继续”），返回本关任务文本。',
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
1. 调用 pvz_state 读取地形、关卡任务/倒计时、卡槽费用/冷却、植物和僵尸；
2. 根据关卡任务、地形（state.terrain.map / blockedCells）、卡槽和僵尸做决策；
3. 用 pvz_act 一次提交 1–6 个动作；需要等条件时用 pvz_wait_until（sun>=200 / card_ready:xxx / zombie_in_lane:3 / tasks_ready）；
4. 如果 state.paused=true 先 pvz_resume；某排 needsShooter=true 时优先补射手，或 pvz_move_cart 把载着射手的矿车移过去；
5. 如果 phase=objective 先 pvz_dismiss_objective；如果 phase=preparing 先 pvz_choose_deck（可 replace:true 换卡）再 pvz_start_level；
6. 如果没事可做就 pvz_wait 2-4 秒，再回到第 1 步。
不要猜植物/僵尸能力；需要时先调用 pvz_knowledge 查询。任务失败会直接判负，优先保证任务完成；
timed_kill 是“最近 N 秒内击杀”的滑动窗口，看到 urgent=true 就集中输出/能量豆；plant_lose_limit 看 left，left<=1 时绝不能再丢植物。`;

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

function modResult(r) {
  if (!r.ok) return textResult(r.error, true);
  const value = r.value;
  return textResult(value, !!(value && value.ok === false));
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

async function rawState() {
  const r = await callMod('window.PvzAI.snapshot()');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function compact(state) {
  if (!state || !state.ok) return state;
  return {
    phase: state.phase,
    sun: state.sun,
    plantFood: state.plantFood,
    wave: state.level && state.level.wave,
    plants: (state.plants || []).length,
    zombies: (state.zombies || []).length,
    tasks: (state.tasks || []).map((t) => ({
      tip: t.tip, count: t.count, completed: t.completed,
      failed: t.failed, timeLeft: t.timeLeft, urgent: t.urgent,
    })),
  };
}

function checkCondition(state, cond) {
  const c = String(cond || '').trim();
  let m;
  if (!c) return { ok: false, reason: '空条件' };
  if ((m = /^sun\s*>=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) >= Number(m[1]) };
  if ((m = /^sun\s*<=\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) <= Number(m[1]) };
  if ((m = /^sun\s*>\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) > Number(m[1]) };
  if ((m = /^sun\s*<\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) return { ok: true, hit: Number(state.sun) < Number(m[1]) };
  if ((m = /^plantfood\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: Number(state.plantFood || 0) >= Number(m[1]) };
  if ((m = /^card_ready\s*:\s*(.+)$/i.exec(c))) {
    const v = m[1].trim();
    const card = (state.cards || []).find((x) => x.type === v) || (state.cards || [])[Number(v)];
    return { ok: true, hit: !!(card && card.ready) };
  }
  if ((m = /^zombie_in_lane\s*:\s*(\d+)$/i.exec(c))) {
    return { ok: true, hit: (state.zombies || []).some((z) => Number(z.lane) === Number(m[1])) };
  }
  if ((m = /^cart_ready\s*:\s*(\d+)$/i.exec(c))) {
    const cart = (state.carts || [])[Number(m[1])];
    return { ok: true, hit: !!(cart && (cart.canUp || cart.canDown)) };
  }
  if ((m = /^zombie_near\s*:\s*(-?\d+(?:\.\d+)?)$/i.exec(c))) {
    return { ok: true, hit: (state.zombies || []).some((z) => Number(z.column) <= Number(m[1])) };
  }
  if (/^tasks_ready$/i.test(c)) {
    const list = state.tasks || [];
    return { ok: true, hit: list.length > 0 && list.every((t) => t.completed || t.failed) };
  }
  if ((m = /^phase\s*:\s*(\w+)$/i.exec(c))) return { ok: true, hit: state.phase === m[1].toLowerCase() };
  if ((m = /^plants\s*>=\s*(\d+)$/i.exec(c))) return { ok: true, hit: (state.plants || []).length >= Number(m[1]) };
  return { ok: false, reason: '无法识别的条件：' + c };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilValue(cond, timeoutSec) {
  const timeout = Math.max(1, Math.min(60, Number(timeoutSec) || 15)) * 1000;
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeout) {
    let state;
    try { state = await rawState(); } catch (e) { last = { ok: false, reason: String(e.message || e) }; await sleep(300); continue; }
    last = state;
    if (!state || !state.ok) { await sleep(300); continue; }
    const r = checkCondition(state, cond);
    if (!r.ok) return { ok: false, code: 'BAD_CONDITION', condition: String(cond), message: r.reason };
    if (r.hit) {
      return {
        ok: true, satisfied: true, condition: String(cond),
        elapsed: Math.round((Date.now() - started) / 100) / 10,
        state: compact(state),
      };
    }
    await sleep(250);
  }
  return {
    ok: false, code: 'TIMEOUT', satisfied: false, retryable: true,
    condition: String(cond), elapsed: Math.round((Date.now() - started) / 100) / 10,
    state: last && last.ok ? compact(last) : null,
  };
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

async function healthValue() {
  const r = await callMod(`(() => {
    const P = window.PvzAI;
    if (!P) throw new Error('AI 模组还没有加载');
    const s = P.snapshot();
    return {
      modVersion: P.version,
      snapshotOk: !!(s && s.ok),
      scene: s && s.scene,
      phase: s && s.phase,
      features: {
        terrain: typeof P.terrain === 'function',
        carts: Array.isArray(s && s.carts),
        lanes: Array.isArray(s && s.lanes),
        taskSemantics: !(s && s.tasks && s.tasks.length) || s.tasks.every((t) => !!t.semantics),
        pausedFlag: typeof (s && s.paused) === 'boolean',
        execute: typeof P.execute === 'function',
        waitUntil: typeof P.waitUntil === 'function',
        moveCart: typeof P.moveCart === 'function',
        resume: typeof P.resume === 'function',
      },
    };
  })()`);
  if (!r.ok) throw new Error(r.error);
  const v = r.value || {};
  const expected = ['pvz_state', 'pvz_knowledge', 'pvz_plant', 'pvz_act', 'pvz_wait_until', 'pvz_move_cart', 'pvz_resume', 'pvz_health'];
  const serverTools = TOOLS.map((t) => t.name);
  const missingTools = expected.filter((n) => serverTools.indexOf(n) < 0);
  return {
    ...v,
    serverVersion: VERSION,
    compatible: v.modVersion === VERSION,
    missingTools,
    installPath: process.env.APPDATA ? `${process.env.APPDATA}\\com.pvzge.game\\gp-next\\packs\\pvzai.agent` : null,
    hint: v.modVersion === VERSION
      ? '模组与 Server 版本一致'
      : '模组与 MCP Server 版本不一致：重新安装模组并重启 MCP 客户端',
  };
}

async function handleTool(name, args) {
  switch (name) {
    case 'pvz_state':
      return textResult(await stateValue());
    case 'pvz_knowledge':
      return textResult(await knowledgeValue(args.kind, args.id));
    case 'pvz_plant': {
      const r = await callMod(`window.PvzAI.plant(${Number(args.card)}, ${Number(args.lane)}, ${Number(args.column)})`);
      return modResult(r);
    }
    case 'pvz_collect': {
      const r = await callMod('window.PvzAI.collectPickups ? window.PvzAI.collectPickups() : window.PvzAI.collectSuns()');
      return modResult(r);
    }
    case 'pvz_plant_food': {
      const r = await callMod(`window.PvzAI.plantFood(${Number(args.lane)}, ${Number(args.column)})`);
      return modResult(r);
    }
    case 'pvz_shovel': {
      const r = await callMod(`window.PvzAI.shovel(${Number(args.lane)}, ${Number(args.column)})`);
      return modResult(r);
    }
    case 'pvz_move_cart': {
      const r = await callMod(`window.PvzAI.moveCart(${Number(args.cart)}, ${JSON.stringify(String(args.direction || ''))})`);
      return modResult(r);
    }
    case 'pvz_resume': {
      const r = await callMod('window.PvzAI.resume ? window.PvzAI.resume() : { ok: false, code: "OLD_MOD", reason: "模组版本过低，请更新到 0.2.6+" }');
      return modResult(r);
    }
    case 'pvz_health':
      return textResult(await healthValue());
    case 'pvz_choose_deck': {
      const plants = Array.isArray(args.plants) ? args.plants.map(String) : [];
      const replace = !!args.replace;
      let r = null;
      for (let i = 0; i < 24; i++) {
        r = await callMod(`window.PvzAI.autoDeckWith ? window.PvzAI.autoDeckWith(${JSON.stringify(plants)}, ${replace}) : window.PvzAI.autoDeck()`);
        if (!r.ok) break;
        if (!(r.value && r.value.code === 'PREP_NOT_READY')) break;
        await sleep(500);
      }
      return modResult(r);
    }
    case 'pvz_act': {
      const actions = (Array.isArray(args.actions) ? args.actions : []).slice(0, 6);
      if (!actions.length) return textResult({ ok: false, code: 'NO_ACTIONS' }, true);
      const r = await callMod(`window.PvzAI.execute(${JSON.stringify(actions)})`);
      if (!r.ok) return textResult(r.error, true);
      const steps = r.value;
      const allOk = steps.every((s) => s.result && s.result.ok);
      return textResult({ ok: allOk, steps }, !allOk);
    }
    case 'pvz_wait_until': {
      const res = await waitUntilValue(args.until, args.timeout);
      return textResult(res, !res.ok);
    }
    case 'pvz_start_level': {
      let r = null;
      for (let i = 0; i < 24; i++) {
        r = await callMod(`(() => {
        const P = window.PvzAI;
        const s = P.snapshot();
        if (!s || !s.ok) return { ok: false, reason: s && s.reason ? s.reason : '不在关卡内' };
        const out = [];
        if (s.phase === 'objective') {
          const d = P.dismissObjective ? P.dismissObjective() : { ok: false, reason: '模组版本过低，请更新' };
          out.push({ dismiss_objective: d });
          if (!d.ok) return { ok: false, reason: d.reason || '关闭关卡目标失败', steps: out };
        }
        if (s.phase === 'running') return { ok: true, detail: '战斗已经开始', steps: out };
        const st = P.startLevel();
        out.push({ start_level: st });
        if (st.ok) return { ok: true, detail: st.detail, steps: out };
        if (s.phase === 'preparing') return { ok: false, reason: st.reason || '开局失败', code: st.code, steps: out };
        return { ok: false, reason: '当前阶段是 ' + s.phase + '，不能开局', steps: out };
      })()`);
        if (!r.ok) break;
        if (!(r.value && r.value.code === 'PREP_NOT_READY')) break;
        await sleep(500);
      }
      return modResult(r);
    }
    case 'pvz_dismiss_objective': {
      const r = await callMod(`(() => {
        const P = window.PvzAI;
        if (!P || !P.dismissObjective) return { ok: false, reason: '模组版本过低，请更新到 v0.2.4+' };
        const s = P.snapshot();
        const res = P.dismissObjective();
        return { ...res, tasks: (s && s.tasks) || [], objective: (s && s.objective) || null };
      })()`);
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
