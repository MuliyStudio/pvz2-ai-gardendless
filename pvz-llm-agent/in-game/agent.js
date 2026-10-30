/**
 * 游戏内 OpenAI 兼容 LLM 客户端。
 *
 * 唯一决策者是模型：这里只负责
 *   - 发 messages / tools
 *   - 执行模型返回的 tool_calls（经 router）
 *   - 把真实结果回填给模型
 *   - 把推理 / 工具 / 结果 / 计划推给思考窗
 *
 * 没有任何本地决策、卡组修正或策略队列。
 */
import { openAiTools } from '../tools/definitions.js';
import { SYSTEM_PROMPT, initialUserMessage, continueMessage, phaseNudge } from './prompt.js';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeBaseUrl(base) {
  const s = String(base || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/chat\/completions$/i.test(s)) return s;
  return `${s}/chat/completions`;
}

export function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { __parseError: s.slice(0, 500) }; }
}

function makeError(code, message, extra = {}) {
  const e = new Error(message || code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export const DEFAULT_LLM = Object.freeze({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

/**
 * 预置服务商。只填 baseUrl / model，不碰决策逻辑。
 * OpenCode Go 走 OpenAI 兼容的 chat/completions，DeepSeek V4.1 Flash 正在这一组里。
 */
export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '按量计费，key 形如 sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go（本地代理）',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'deepseek-v4.1-flash',
    hint: '先运行 node scripts/local-proxy.mjs。opencode.ai 的 chat 接口不带 CORS 头，浏览器不能直连，必须经本地代理。Key 在 opencode.ai/console 取。',
    models: [
      'deepseek-v4.1-flash',
      'glm-5.3-flash',
      'kimi-k2.7-code',
      'mimo-v2.6-flash',
      'qwen3.8-flash',
      'minimax-m3.1-flash',
      'longcat-2.0',
      'glm-5.2',
    ],
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    hint: '任意 OpenAI 兼容端点，手动填 Base 和模型名',
    models: [],
  },
]);

// OpenCode Go 建议带稳定的会话 ID，用于路由与 prompt 缓存；同一页面生命周期内保持不变。
let openCodeSession = '';
function getOpenCodeSession() {
  if (!openCodeSession) {
    openCodeSession = `pvzllm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return openCodeSession;
}

export function createLlmAgent({ fetchImpl, router, cfg = {}, onEvent = () => {}, sleep = sleepDefault, version = '0.1.10' }) {
  const config = {
    baseUrl: DEFAULT_LLM.baseUrl,
    model: DEFAULT_LLM.model,
    apiKey: '',
    temperature: 0.3,
    stream: true,
    maxSteps: 80,
    loopDelayMs: 350,
    ...cfg,
  };
  let messages = [];
  let running = false;
  let stopRequested = false;
  let controller = null;
  let stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 };
  let lastPlan = null;
  let lastPhase = null;
  let everRunning = false;
  let lastError = null;

  const fetchAny = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  let eventHandler = onEvent;

  function emit(ev) {
    try { eventHandler(ev); } catch { /* UI must not break the agent */ }
  }

  function setEventHandler(fn) {
    eventHandler = typeof fn === 'function' ? fn : () => {};
    return { ok: true };
  }

  function setConfig(patch) {
    Object.assign(config, patch || {});
    return getConfig();
  }

  function getConfig() {
    return {
      ...config,
      apiKey: config.apiKey ? `${String(config.apiKey).slice(0, 3)}***${String(config.apiKey).slice(-2)}` : '',
      hasKey: !!config.apiKey,
    };
  }

  function ensureConfig() {
    if (!config.baseUrl) throw makeError('BAD_CONFIG', '缺少 API Base（OpenAI 兼容）');
    if (!config.model) throw makeError('BAD_CONFIG', '缺少模型名');
    if (!config.apiKey) throw makeError('BAD_CONFIG', '缺少 API Key');
    if (!fetchAny) throw makeError('BAD_CONFIG', '当前环境没有 fetch');
  }

  function headers() {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
    // OpenCode Go 要求稳定会话 ID；直连和本地代理两种形式都带上（Authorization 已触发预检，不多一次）
    const s = String(config.baseUrl || '');
    if (/opencode\.ai/i.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1/i.test(s)) {
      h['x-opencode-session'] = getOpenCodeSession();
    }
    return h;
  }

  async function testConnection() {
    ensureConfig();
    const started = Date.now();
    const url = normalizeBaseUrl(config.baseUrl);
    try {
      const res = await fetchAny(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: 'Reply with OK only.' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 8,
          stream: false,
          temperature: 0,
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, code: 'LLM_HTTP', status: res.status, reason: text.slice(0, 500), latencyMs: Date.now() - started };
      let data = null;
      try { data = JSON.parse(text); } catch { /* ignore */ }
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? (data.choices[0].message.content || '') : '';
      return { ok: true, latencyMs: Date.now() - started, model: config.model, content: String(content).slice(0, 120) };
    } catch (e) {
      return { ok: false, code: 'LLM_REQUEST_FAILED', reason: String(e && e.message || e), latencyMs: Date.now() - started };
    }
  }

  function addUsage(usage) {
    if (!usage) return;
    stats.promptTokens += Number(usage.prompt_tokens || 0);
    stats.completionTokens += Number(usage.completion_tokens || 0);
  }

  async function callModel({ stream }) {
    ensureConfig();
    const url = normalizeBaseUrl(config.baseUrl);
    const body = {
      model: config.model,
      messages,
      tools: openAiTools(),
      tool_choice: 'auto',
      temperature: Number(config.temperature) || 0,
      stream: !!stream,
    };
    controller = new AbortController();
    let res;
    try {
      res = await fetchAny(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw makeError('STOPPED', '已停止');
      throw makeError('LLM_REQUEST_FAILED', String(e && e.message || e));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw makeError('LLM_HTTP', `模型接口 ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
    }
    stats.requests++;

    if (stream) {
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw makeError('LLM_STREAM_UNSUPPORTED', '响应没有可读流');
      }
      const out = { content: '', reasoning: '', toolCalls: [], usage: null, finishReason: null };
      const calls = new Map();
      const handleChunk = (data) => {
        if (!data) return;
        if (data.error) throw makeError('LLM_HTTP', data.error.message || JSON.stringify(data.error));
        if (data.usage) out.usage = data.usage;
        const ch = data.choices && data.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (d.reasoning_content) {
          out.reasoning += d.reasoning_content;
          emit({ type: 'thinking', delta: d.reasoning_content, text: out.reasoning });
        } else if (d.reasoning) {
          out.reasoning += d.reasoning;
          emit({ type: 'thinking', delta: d.reasoning, text: out.reasoning });
        }
        if (d.content) {
          out.content += d.content;
          emit({ type: 'assistant_delta', delta: d.content, text: out.content });
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = Number.isFinite(tc.index) ? tc.index : 0;
            const cur = calls.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name += tc.function.name;
            if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
        if (ch.finish_reason) out.finishReason = ch.finish_reason;
      };
      await readSse(res.body, handleChunk);
      out.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
        id: c.id || `call_${i + 1}`,
        name: c.name,
        args: parseToolArgs(c.args),
        rawArgs: c.args,
      }));
      addUsage(out.usage);
      return out;
    }

    const data = await res.json().catch((e) => { throw makeError('BAD_RESPONSE', '模型返回不是 JSON：' + String(e && e.message || e)); });
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw makeError('BAD_RESPONSE', '模型返回缺少 choices[0].message');
    const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
      id: tc.id || `call_${i + 1}`,
      name: tc.function && tc.function.name,
      args: parseToolArgs(tc.function && tc.function.arguments),
      rawArgs: (tc.function && tc.function.arguments) || '',
    }));
    addUsage(data.usage);
    return {
      content: msg.content || '',
      reasoning: msg.reasoning_content || msg.reasoning || '',
      toolCalls,
      usage: data.usage || null,
      finishReason: data.choices[0].finish_reason || null,
    };
  }

  async function readSse(body, onChunk) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return;
          try { onChunk(JSON.parse(data)); } catch (e) { if (e && e.code) throw e; }
        }
      }
      const tail = buf.trim();
      if (tail.startsWith('data:')) {
        const data = tail.slice(5).trim();
        if (data && data !== '[DONE]') { try { onChunk(JSON.parse(data)); } catch { /* ignore */ } }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async function callWithFallback() {
    try {
      return await callModel({ stream: !!config.stream });
    } catch (e) {
      if (stopRequested || (e && e.name === 'AbortError')) throw e;
      if (config.stream && e && e.code && e.code !== 'STOPPED' && !(e.status >= 400 && e.status < 500)) {
        emit({ type: 'log', text: '流式失败，改用非流式重试：' + (e.message || e.code) });
        return await callModel({ stream: false });
      }
      throw e;
    }
  }

  function trimMessages() {
    const MAX = 60;
    if (messages.length > MAX) {
      const system = messages[0];
      let rest = messages.slice(1);
      // 从后往前保留，但不要从 tool 消息开始丢出孤立 tool 结果
      rest = rest.slice(rest.length - (MAX - 1));
      while (rest.length && rest[0].role === 'tool') rest.shift();
      messages = [system, ...rest];
    }
    compactOldToolResults();
  }

  function compactOldToolResults() {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    // 最近 8 条工具结果保留原文；更早的大结果压成一句，避免整局 prompt 越滚越大。
    for (let i = 0; i < toolMsgs.length - 8; i++) {
      const m = toolMsgs[i];
      if (m.content && m.content.length > 1500) {
        m.content = JSON.stringify({ ok: true, omitted: true, note: '旧工具结果已省略；需要时重新调用 pvz_state / pvz_knowledge' });
      }
    }
  }

  function notePhase(phase) {
    if (!phase) return;
    lastPhase = phase;
    if (phase === 'running') everRunning = true;
    // 关卡结束：胜负，或真正打过 running 后回到主菜单/世界地图。
    // 不能只靠 won/lost —— 有的关卡先回地图再结算，AI 会一直空转调工具。
    const ended = phase === 'won' || phase === 'lost'
      || (everRunning && (phase === 'menu' || phase === 'worldmap'));
    if (ended && !stopRequested) {
      emit({ type: 'game_over', phase });
      stopRequested = true;
    }
  }

  async function executeToolCall(tc, index) {
    if (!tc.name) {
      const bad = { ok: false, code: 'BAD_TOOL_ARGS', reason: '模型返回了空的工具名' };
      emit({ type: 'tool_result', name: '(空)', result: bad });
      messages.push({ role: 'tool', tool_call_id: tc.id || `call_${index + 1}`, content: JSON.stringify(bad) });
      return bad;
    }
    emit({ type: 'tool_call', name: tc.name, args: tc.args, id: tc.id });
    stats.toolCalls++;
    let result;
    if (tc.args && tc.args.__parseError) {
      result = { ok: false, code: 'BAD_TOOL_ARGS', reason: '工具参数不是合法 JSON', raw: tc.args.__parseError };
    } else {
      try {
        result = await router.call(tc.name, tc.args || {});
      } catch (e) {
        result = { ok: false, code: 'TOOL_FAILED', reason: String(e && e.message || e) };
      }
    }
    emit({ type: 'tool_result', name: tc.name, result, ok: !(result && result.ok === false) });
    if (tc.name === 'pvz_set_plan' && result && result.ok) {
      lastPlan = result.plan;
      emit({ type: 'plan', plan: result.plan, savedAt: result.savedAt });
    }
    if (result && result.plan && tc.name === 'pvz_state') {
      lastPlan = result.plan;
      emit({ type: 'plan', plan: result.plan, savedAt: result.planSavedAt });
    }
    if (tc.name === 'pvz_state' && result && result.ok) {
      emit({ type: 'state', state: result });
      notePhase(result.phase);
    }
    if (tc.name === 'pvz_start_level' && result && result.phase) {
      notePhase(result.phase);
      emit({ type: 'state_phase', phase: result.phase });
    }
    if (result && result.phase) {
      notePhase(result.phase);
    }
    messages.push({
      role: 'tool',
      tool_call_id: tc.id || `call_${index + 1}`,
      name: tc.name,
      content: JSON.stringify(result),
    });
    return result;
  }

  async function runLoop() {
    let steps = 0;
    let idleNudges = 0;
    lastError = null;
    emit({ type: 'run_start', version, model: config.model });
    while (running && !stopRequested) {
      steps++;
      if (steps > Number(config.maxSteps || 80)) {
        emit({ type: 'error', code: 'STEP_LIMIT', reason: `连续 ${steps - 1} 步没有结束；已停止（不会本地接管）` });
        break;
      }
      let reply;
      try {
        emit({ type: 'request', step: steps, messageCount: messages.length });
        reply = await callWithFallback();
      } catch (e) {
        if (e && (e.code === 'STOPPED' || e.name === 'AbortError')) break;
        lastError = e;
        emit({ type: 'error', code: e.code || 'LLM_FAILED', reason: e.message || String(e) });
        break;
      }
      if (!running || stopRequested) break;

      if (reply.reasoning) emit({ type: 'thinking_final', text: reply.reasoning });
      if (reply.content) emit({ type: 'assistant', text: reply.content });

      if (reply.toolCalls && reply.toolCalls.length) {
        idleNudges = 0;
        messages.push({
          role: 'assistant',
          content: reply.content || '',
          tool_calls: reply.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.rawArgs === 'string' ? tc.rawArgs : JSON.stringify(tc.args || {}) },
          })),
        });
        for (let i = 0; i < reply.toolCalls.length; i++) {
          if (!running || stopRequested) break;
          await executeToolCall(reply.toolCalls[i], i);
        }
        trimMessages();
        await sleep(Number(config.loopDelayMs) || 0);
        continue;
      }

      // 模型没调用工具：最多提醒 3 次；再不行就停，不本地接管。
      messages.push({ role: 'assistant', content: reply.content || '' });
      idleNudges++;
      if (idleNudges >= 3) {
        emit({
          type: 'error',
          code: 'NO_TOOL_CALL',
          reason: '模型连续 3 次没有调用任何工具；按需求停住，不启动本地决策',
        });
        break;
      }
      messages.push({ role: 'user', content: continueMessage(phaseNudge(lastPhase || 'unknown')) });
      await sleep(700);
    }
    running = false;
    emit({
      type: 'run_end',
      phase: lastPhase,
      stats: { ...stats },
      plan: lastPlan,
      error: lastError ? { code: lastError.code, reason: lastError.message } : null,
    });
  }

  async function start(instruction) {
    if (running) return { ok: false, code: 'ALREADY_RUNNING', reason: '已经在运行' };
    try { ensureConfig(); } catch (e) {
      emit({ type: 'error', code: e.code || 'BAD_CONFIG', reason: e.message });
      return { ok: false, code: e.code || 'BAD_CONFIG', reason: e.message };
    }
    running = true;
    stopRequested = false;
    stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0 };
    lastPhase = null;
    everRunning = false;
    lastError = null;
    controller = null;
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: instruction ? `${initialUserMessage()}\n玩家补充：${instruction}` : initialUserMessage() },
    ];
    const done = runLoop().catch((e) => {
      lastError = e;
      emit({ type: 'error', code: e.code || 'AGENT_FAILED', reason: String(e && e.message || e) });
      running = false;
    });
    return { ok: true, done };
  }

  function stop(reason) {
    if (!running) return { ok: true, running: false };
    stopRequested = true;
    running = false;
    try { if (controller) controller.abort(); } catch { /* ignore */ }
    emit({ type: 'stopped', reason: reason || '手动停止' });
    return { ok: true, running: false };
  }

  function sendInstruction(text) {
    const s = String(text || '').trim();
    if (!s) return { ok: false, code: 'EMPTY', reason: '指令为空' };
    if (!running) return start(s);
    messages.push({ role: 'user', content: `玩家指示：${s}\n按指示调整，但不要违反关卡事实和工具返回。` });
    emit({ type: 'user', text: s });
    return { ok: true, running: true };
  }

  return {
    start, stop, sendInstruction, testConnection,
    setConfig, getConfig, setEventHandler,
    isRunning: () => running,
    getMessages: () => messages.slice(),
    getStats: () => ({ ...stats }),
    getPlan: () => lastPlan,
    getPhase: () => lastPhase,
    version,
  };
}
