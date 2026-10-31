import { openAiTools } from '../tools/definitions.js';
import { SYSTEM_PROMPT, initialUserMessage, continueMessage, phaseNudge } from './prompt.js';

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

// 上游 5xx / 429 / 网络错误：值得等一会儿重试，不该直接把这一局打断。
function isTransientError(e) {
  if (!e) return false;
  if (e.code === 'LLM_REQUEST_FAILED' || e.code === 'LLM_STREAM_UNSUPPORTED') return true;
  const s = Number(e.status);
  if (s === 408 || s === 429) return true;
  if (s >= 500 && s <= 599) return true;
  return /service.?unavailable|too many requests|overloaded|timeout/i.test(String(e.message || ''));
}

function retryAfterMs(e) {
  const fromHeader = Number(e && e.retryAfterMs);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.min(60000, fromHeader);
  const m = /retry in ([\d.]+)s/i.exec(String(e && e.message || ''));
  if (m) return Math.min(60000, Number(m[1]) * 1000);
  return 0;
}

export const DEFAULT_LLM = Object.freeze({
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
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
    model: 'deepseek-flash',
    hint: '按量计费，key 形如 sk-...',
    models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go（本地代理）',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'deepseek-flash',
    hint: '先运行 node scripts/local-proxy.mjs。opencode.ai 的 chat 接口不带 CORS 头，浏览器不能直连，必须经本地代理。Key 在 opencode.ai/console 取。注意：这组只认 deepseek-flash / deepseek-v4-pro，写别的名字上游会直接报 invalid_request_error。',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
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

export function createLlmAgent({ fetchImpl, router, cfg = {}, onEvent = () => {}, sleep = sleepDefault, version = '0.4.14', latency = null }) {
  const config = {
    baseUrl: DEFAULT_LLM.baseUrl,
    model: DEFAULT_LLM.model,
    // 双层模型（可选）：击杀/操作阶段用更快的 chat 模型，开局/复盘仍用主模型（推理模型）。
    // 空字符串 = 关闭，全程只用 model。
    fastModel: '',
    // 每隔 N 步强制用主模型想一次（0 = 不强制）；局内遇到紧急任务也会自动升级到主模型。
    escalateEvery: 0,
    // 后台参谋：用主模型在后台分析下一步风险，和快模型的执行并行，不阻塞操作。
    // advisorEvery=每 N 步触发一次；0 = 关闭。
    advisor: true,
    advisorEvery: 4,
    // 本关结束后自动复盘：'imperfect'（默认：失败/丢车/掉植物/保护格死都总结）| 'lost' | 'always' | 'off'
    autoReview: 'imperfect',
    apiKey: '',
    temperature: 0.3,
    stream: true,
    maxSteps: 80,
    loopDelayMs: 200,
    ...cfg,
  };
  let messages = [];
  let running = false;
  let stopRequested = false;
  let controller = null;
  let stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, modelSwitches: 0, modelMs: 0, toolMs: 0 };
  let lastPlan = null;
  let lastPlanAt = null;
  let lastPhase = null;
  let everRunning = false;
  let lastError = null;
  let lastState = null;
  let forceStrongRounds = 0;
  let usedModel = '';
  let runStartedAt = 0;
  let recentActions = [];
  let advisorBusy = false;
  let advisorNote = null;
  let advisorLastWave = null;
  let pendingInstructions = [];
  let incidentLessons = [];
  let lostMowerLanes = new Set();

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

  function fastModelOn() {
    const f = String(config.fastModel || '').trim();
    return f && f !== config.model ? f : '';
  }

  // 开局/选卡/复盘用主模型（想清楚），进入 running 后默认换快模型；
  // 每 escalateEvery 步、以及局内出现紧急任务/多行压力时，临时升级回主模型。
  function pickModel(phase, steps) {
    const fast = fastModelOn();
    if (!fast || phase !== 'running') return config.model;
    if (forceStrongRounds > 0) return config.model;
    const every = Number(config.escalateEvery) || 0;
    if (every > 0 && steps > 1 && steps % every === 0) {
      forceStrongRounds = Math.max(forceStrongRounds, 2);
      return config.model;
    }
    return fast;
  }

  function noteModel(model, reason) {
    if (!model || model === usedModel) return;
    const from = usedModel;
    usedModel = model;
    if (!from) return; // 启动模型由 run_start 播报，不额外刷一条“切换”
    stats.modelSwitches++;
    emit({ type: 'model', model, from, reason: reason || null });
    emit({ type: 'log', text: `模型切换：${from} → ${model}${reason ? `（${reason}）` : ''}` });
  }

  async function callModel({ stream, model, msgs, maxTokens, noTools, background = false, timeoutMs = 0 }) {
    ensureConfig();
    const startedAt = Date.now();
    const url = normalizeBaseUrl(config.baseUrl);
    const body = {
      model: model || config.model,
      messages: msgs || messages,
      temperature: Number(config.temperature) || 0,
      stream: !!stream,
    };
    if (!noTools) {
      body.tools = openAiTools();
      body.tool_choice = 'auto';
    }
    if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens);
    const ac = new AbortController();
    if (!background) controller = ac;
    let abortTimer = null;
    if (Number(timeoutMs) > 0) {
      abortTimer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, Number(timeoutMs));
    }
    let res;
    try {
      res = await fetchAny(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      if (abortTimer) clearTimeout(abortTimer);
      if (e && e.name === 'AbortError') throw makeError('STOPPED', '已停止');
      throw makeError('LLM_REQUEST_FAILED', String(e && e.message || e));
    }
    if (!res.ok) {
      if (abortTimer) clearTimeout(abortTimer);
      const text = await res.text().catch(() => '');
      const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      throw makeError('LLM_HTTP', `模型接口 ${res.status}: ${text.slice(0, 500)}`, {
        status: res.status,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
      });
    }
    stats.requests++;
    const done = (v) => {
      if (abortTimer) clearTimeout(abortTimer);
      if (latency && !background) { try { latency.recordModel(Date.now() - startedAt); } catch { /* ignore */ } }
      return v;
    };

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
      return done(out);
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
    return done({
      content: msg.content || '',
      reasoning: msg.reasoning_content || msg.reasoning || '',
      toolCalls,
      usage: data.usage || null,
      finishReason: data.choices[0].finish_reason || null,
    });
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

  async function callWithFallback(model) {
    const backoff = [1500, 4000, 9000];
    let lastErr = null;
    let triedNonStream = false;
    for (let attempt = 0; attempt < backoff.length; attempt++) {
      if (stopRequested) throw makeError('STOPPED', '已停止');
      const stream = attempt === 0 && !triedNonStream ? !!config.stream : false;
      try {
        return await callModel({ stream, model });
      } catch (e) {
        if (e && (e.name === 'AbortError' || e.code === 'STOPPED')) throw e;
        lastErr = e;
        // 流式不支持 / 流式被截断：先降级成非流式重试一次
        if (attempt === 0 && config.stream && !triedNonStream && e && e.code !== 'LLM_HTTP') {
          triedNonStream = true;
          emit({ type: 'log', text: '流式失败，改用非流式重试：' + (e.message || e.code) });
          continue;
        }
        triedNonStream = true;
        if (!isTransientError(e)) throw e;
        const wait = retryAfterMs(e) || backoff[attempt];
        const label = e.status ? `HTTP ${e.status}` : (e.code || '网络错误');
        emit({ type: 'log', text: `模型接口 ${label}（上游过载/超时），${Math.round(wait / 1000)}s 后第 ${attempt + 2}/${backoff.length} 次尝试` });
        await sleep(wait);
      }
    }
    const err = makeError(
      'LLM_UNAVAILABLE',
      `${lastErr && lastErr.message || lastErr}`,
      { status: lastErr && lastErr.status, retryable: true, retryAfterSec: 15 },
    );
    throw err;
  }

  function trimMessages() {
    // 只做“整段丢弃”，不改写旧消息：每轮原地压缩工具结果会让 prompt 前缀每轮都变，
    // 上游的上下文缓存全部失效。保留最近的完整轮次，前缀保持字节稳定才能命中缓存。
    const MAX = 20;
    if (messages.length > MAX) {
      const system = messages[0];
      let rest = messages.slice(1).slice(-(MAX - 1));
      // 不能从孤立的 tool 结果开始；也不能从带 tool_calls 的 assistant 开始（它的 tool 结果已被丢掉）。
      while (rest.length) {
        const head = rest[0];
        if (head.role === 'tool') { rest.shift(); continue; }
        if (head.role === 'assistant' && Array.isArray(head.tool_calls) && head.tool_calls.length) { rest.shift(); continue; }
        break;
      }
      messages = [system, ...rest];
    }
  }

  // 开局后把 briefing 的正文压成一句话：任务在 state.tasks、波次在 forecast、卡组在 state.deck，
  // 留着 4k token 的简报正文只会拖慢每一轮。
  function archiveBriefing() {
    let hit = 0;
    for (const m of messages) {
      if (m.role !== 'tool' || m.name !== 'pvz_briefing') continue;
      if (!m.content || m.content.length < 300) continue;
      m.content = JSON.stringify({
        ok: true,
        archived: true,
        note: '开局简报已归档。任务看 pvz_state.tasks，波次看 pvz_state.forecast / pvz_forecast，卡牌数值用 pvz_knowledge，限制看 pvz_state.limits。',
      });
      hit += 1;
    }
    return hit;
  }

  function notePhase(phase) {
    if (!phase) return;
    const wasRunning = everRunning;
    lastPhase = phase;
    if (phase === 'running') everRunning = true;
    if (phase === 'running' && !wasRunning) archiveBriefing();
    // 关卡结束：胜负，或真正打过 running 后回到主菜单/世界地图。
    // 不能只靠 won/lost —— 有的关卡先回地图再结算，AI 会一直空转调工具。
    const ended = phase === 'won' || phase === 'lost'
      || (everRunning && (phase === 'menu' || phase === 'worldmap'));
    if (ended && !stopRequested) {
      emit({ type: 'game_over', phase });
      stopRequested = true;
    }
  }

  function noteMowerLoss(state) {
    const lost = state && state.changesSinceLast && state.changesSinceLast.mowerLost;
    if (!Array.isArray(lost) || !lost.length) return;
    const fresh = lost.filter((lane) => !lostMowerLanes.has(Number(lane)));
    if (!fresh.length) return;
    for (const lane of fresh) lostMowerLanes.add(Number(lane));
    const wave = state.level && state.level.wave;
    const laneText = fresh.map((l) => `第${Number(l) + 1}行`).join('/');
    // 只记录事实，供关卡结束后的复盘合并；不在中途写记忆/不提前总结。
    const lesson = `第${wave || '?'}波 ${laneText} 丢了推车：该行防线已被打穿；下局提前 1–2 波补墙/输出，别等僵尸压到房子。`;
    incidentLessons = [...new Set([lesson, ...incidentLessons])].slice(0, 4);
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
      const warns = (result.audit && result.audit.warnings) || result.warnings || [];
      if (warns.length) {
        emit({ type: 'plan_audit', warnings: warns });
        emit({ type: 'log', text: `计划审计：${warns.length} 条提示（计划已保存，但需要按事实重写）：${warns.map((w) => w.reason).join('；').slice(0, 260)}` });
      }
    }
    if (result && result.plan && tc.name === 'pvz_state') {
      lastPlan = result.plan;
      // 计划没变就不重复播报，避免每回合刷一条「计划已更新」
      if (result.planSavedAt && result.planSavedAt !== lastPlanAt) {
        lastPlanAt = result.planSavedAt;
        emit({ type: 'plan', plan: result.plan, savedAt: result.planSavedAt });
      }
    }
    if (tc.name === 'pvz_state' && result && result.ok) {
      lastState = result;
      // 紧急任务 / 多行同时漏压：接下来 2 轮改用主模型想，避免快模型在关键局面犯傻。
      let urgent = 0;
      try {
        urgent += (result.tasks || []).filter((t) => t && (t.urgent || t.timeLeft != null && Number(t.timeLeft) <= 10)).length;
        urgent += ((result.brief && result.brief.pressure) || []).length >= 2 ? 1 : 0;
        if (result.brief && result.brief.protect && result.brief.protect.dead > 0) urgent += 2;
      } catch { urgent = 0; }
      if (urgent > 0) forceStrongRounds = Math.max(forceStrongRounds, 2);
      emit({ type: 'state', state: result });
      notePhase(result.phase);
      noteMowerLoss(result);
    }
    if (tc.name === 'pvz_act' && result && result.state && result.state.ok !== false) {
      // pvz_act 已经带回动作后的状态：模型和本地都直接用它，不再额外多一轮 pvz_state。
      lastState = result.state;
      let urgent = 0;
      try {
        urgent += (result.state.tasks || []).filter((t) => t && (t.urgent || t.timeLeft != null && Number(t.timeLeft) <= 10)).length;
        urgent += ((result.state.brief && result.state.brief.pressure) || []).length >= 2 ? 1 : 0;
        if (result.state.brief && result.state.brief.protect && result.state.brief.protect.dead > 0) urgent += 2;
      } catch { urgent = 0; }
      if (urgent > 0) forceStrongRounds = Math.max(forceStrongRounds, 2);
      emit({ type: 'state', state: result.state });
      notePhase(result.state.phase);
      noteMowerLoss(result.state);
    }
    if (tc.name === 'pvz_start_level' && result && result.phase) {
      notePhase(result.phase);
      emit({ type: 'state_phase', phase: result.phase });
    }
    if (result && result.phase) {
      notePhase(result.phase);
    }
    // 只记“操作类”工具，复盘时能看出最后几轮到底下了什么指令、哪些失败。
    if (['pvz_act', 'pvz_plant_food', 'pvz_move_cart', 'pvz_choose_deck', 'pvz_start_level', 'pvz_shovel'].includes(tc.name)) {
      const acts = Array.isArray(result && result.results)
        ? result.results.slice(0, 8).map((r) => ({ action: r.action || r.type || null, ok: !!r.ok, code: r.code || null, lane: r.lane, column: r.column, type: r.type || null }))
        : null;
      recentActions.push({
        name: tc.name,
        args: tc.args || null,
        ok: !(result && result.ok === false),
        code: (result && result.code) || null,
        results: acts,
      });
      if (recentActions.length > 14) recentActions.shift();
    }
    // 后台参谋的结论附在下一份状态/动作结果里，既有上下文、又不需要额外一轮。
    if (advisorNote && advisorNote.text && (tc.name === 'pvz_state' || tc.name === 'pvz_act') && result && typeof result === 'object') {
      result = { ...result, advisor: { note: advisorNote.text } };
      advisorNote = null;
    }
    messages.push({
      role: 'tool',
      tool_call_id: tc.id || `call_${index + 1}`,
      name: tc.name,
      content: JSON.stringify(result),
    });
    return result;
  }

  function stateDigest(s) {
    if (!s || !s.ok) return null;
    const pick = (list, n) => (list || []).slice(0, n);
    return {
      phase: s.phase,
      level: s.level ? { name: s.level.name || null, wave: s.level.wave, waves: s.level.waves } : null,
      sun: s.sun,
      deck: s.deck || null,
      plants: pick((s.plants || []).map((p) => ({ type: p.type, lane: p.lane, column: p.column })), 40),
      zombies: pick((s.zombies || []).map((z) => ({ type: z.type, lane: z.lane, column: z.column, ehp: z.ehp })), 25),
      protectCells: s.protectCells || null,
      tasks: (s.tasks || []).map((t) => ({ tip: t.tip, failed: !!t.failed, completed: !!t.completed })),
      lanes: (s.lanes || []).map((l) => ({ lane: l.lane, gap: l.gap, front: l.front, plants: l.plants, sunProducers: l.sunProducers })),
      changesSinceLast: s.changesSinceLast || null,
    };
  }

  // 跨模型切换时必须重建上下文：思考模型要求历史 assistant 消息回传 reasoning_content，
  // 而上一个模型的推理不适合（也不一定允许）带给下一个模型。交给新模型的只有：
  // 系统提示 + 当前计划 + 最近局面 + 玩家中途指令。新模型先 pvz_state 再继续。
  function buildHandoff(nextModel, reason) {
    const system = messages[0] && messages[0].role === 'system' ? messages[0].content : SYSTEM_PROMPT;
    const digest = stateDigest(lastState);
    const planText = lastPlan ? JSON.stringify(lastPlan).slice(0, 1200) : '（还没有记录 pvz_set_plan；先读状态再补计划）';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userNote = lastUser && !/^开始本关/.test(String(lastUser.content || ''))
      ? String(lastUser.content).slice(0, 300)
      : null;
    const lines = [
      `模型已从上一个模型切换为 ${nextModel}（${reason || '切换'}）。这是同一局，不要重开、不要改已经选好的卡组。`,
      `本关计划：${planText}`,
      digest ? `最近一次读到的状态：${JSON.stringify(digest)}` : '还没有读到过战场状态。',
      advisorNote && advisorNote.text ? `后台参谋：${advisorNote.text}` : null,
      userNote ? `玩家中途指示：${userNote}` : null,
      '先调一次 pvz_state 确认当前局面（阳光/冷却/僵尸/保护格），再按计划执行；本轮 1–6 个动作尽量放进同一个 pvz_act。',
    ].filter(Boolean);
    return [
      { role: 'system', content: system },
      { role: 'user', content: lines.join('\n') },
    ];
  }

  function isPerfectRun(run) {
    const r = (run && run.review) || null;
    if (!r) return false;
    // 植物损失是正常战术代价：只要没丢车、保护格全活、任务没失败，就算完美通关。
    if ((r.mowersLost || 0) > 0) return false;
    if (r.flowers && (r.flowers.dead || 0) > 0) return false;
    if ((r.tasks || []).some((t) => t && t.failed)) return false;
    return true;
  }

  function shouldAutoReview(result, run) {
    const mode = String(config.autoReview || 'imperfect').toLowerCase();
    if (mode === 'off' || mode === 'false' || mode === '0' || mode === 'never') return false;
    if (result === 'lost') return true;
    if (result === 'won') {
      if (mode === 'always') return true;
      if (mode === 'imperfect') return !isPerfectRun(run);
      return false;
    }
    if (result === 'left' || result === 'restart') {
      if (mode !== 'imperfect' && mode !== 'always') return false;
      return !isPerfectRun(run);
    }
    return false;
  }

  function isRunFromThisRun(run) {
    if (!run) return false;
    const at = Date.parse(run.at || '');
    if (!Number.isFinite(at)) return true;
    return !runStartedAt || at >= runStartedAt - 8000;
  }

  // 关卡结束不一定会停在 won/lost 画面：有的关卡直接回地图/主菜单，
  // 这时 agent 只看到 phase=menu。去这一关的记忆里取刚写下的那一条，避免漏掉复盘。
  async function resolveRunOutcome(phase) {
    const known = phase === 'won' || phase === 'lost' ? phase : null;
    const key = (lastState && lastState.levelKey) || null;
    if (!key || typeof router.call !== 'function') return known ? { result: known, run: null, key } : null;
    const tries = known ? 6 : 14;
    for (let i = 0; i < tries; i++) {
      try {
        const m = await router.call('pvz_level_memory', { key, limit: 1 });
        const run = m && m.entry && m.entry.runs && m.entry.runs[0];
        if (run && (run.result === 'won' || run.result === 'lost') && isRunFromThisRun(run)) {
          return { result: run.result, run, key };
        }
      } catch { /* ignore */ }
      await sleep(known ? 250 : 350);
    }
    return known ? { result: known, run: null, key } : null;
  }

  const FLYING_RE = /swashbuckler|cannon|imp|balloon|jetpack|prospector|dodo|seagull|pelican|flying/i;

  // 后台参谋：主模型在后台看状态、提前想下一波；快模型继续执行，不阻塞。
  // 结果不直接执行，只作为一条“advisor”附在下一份工具结果里供决策参考。
  async function runAdvisor(reason) {
    if (advisorBusy || !running || !lastState) return;
    if (config.advisor === false || Number(config.advisorEvery) === 0) return;
    if (!fastModelOn()) return;
    advisorBusy = true;
    try {
      const digest = stateDigest(lastState);
      const planText = lastPlan ? JSON.stringify(lastPlan).slice(0, 700) : '（还没有记录计划）';
      const msgs = [
        { role: 'system', content: '你是后台参谋。只输出一句中文提醒（≤60字），不要动作、不要 JSON、不要复述计划。' },
        {
          role: 'user',
          content: [
            `当前计划：${planText}`,
            `当前状态：${JSON.stringify(digest)}`,
            `当前阳光：${lastState && lastState.sun != null ? lastState.sun : '未知'}；卡组：${(lastState && lastState.deck || []).join('/') || '未知'}`,
            `保护格未布防行：${lastState && lastState.brief && lastState.brief.protect && Array.isArray(lastState.brief.protect.unguardedLanes) ? lastState.brief.protect.unguardedLanes.join('/') : '无或无保护任务'}`,
            `触发原因：${reason}`,
            '请指出接下来 1 波最容易被忽略的威胁，并给一条具体应对（卡/行/列/波次）。如果建议的卡当前买不起，给一个买得起的替代；只输出这一句。',
          ].join('\n'),
        },
      ];
      const reply = await callModel({ stream: false, model: config.model, msgs, maxTokens: 500, noTools: true, background: true, timeoutMs: 15000 });
      const text = String(reply && reply.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (text) {
        advisorNote = { text, at: Date.now() };
        emit({ type: 'advisor', text, at: advisorNote.at });
        emit({ type: 'log', text: `后台参谋：${text}` });
      }
    } catch (e) {
      emit({ type: 'log', text: `后台参谋失败（不影响操作）：${String(e && e.message || e).slice(0, 120)}` });
    } finally {
      advisorBusy = false;
    }
  }



  // 复盘只用真实事实，不让模型自由归因（它会把“小鬼炮/第7波”编到明明是荡索落花的局上）。
  // 依据：哪几行的花死了、最后站在那些行的是什么僵尸、植物损失是否为 0。
  function deterministicReview(result, run) {
    const review = (run && run.review) || {};
    const level = (lastState && lastState.level) || {};
    const wave = review.wave != null ? review.wave : (level.wave != null ? level.wave : null);
    const waveCount = review.waveCount != null ? review.waveCount : (level.waves != null ? level.waves : null);
    const flowers = review.flowers || null;
    const deadCells = flowers && Array.isArray(flowers.cells) ? flowers.cells : [];
    const deadLanes = [...new Set(deadCells.map((c) => Number(c.lane)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
    const lastZ = Array.isArray(review.lastZombies) ? review.lastZombies : [];
    const inDeadLanes = lastZ.filter((z) => deadLanes.includes(Number(z.lane)));
    const flyers = inDeadLanes.filter((z) => (Array.isArray(z.tags) && z.tags.includes('flying')) || FLYING_RE.test(String(z.type)));
    const flyerNames = [...new Set(flyers.map((z) => z.name || z.type).filter(Boolean))];
    const dead = flowers ? (flowers.dead || 0) : 0;
    const total = flowers ? (flowers.total || 0) : 0;
    const plantsLost = review.plantsLost || 0;
    const mowersLost = review.mowersLost || 0;
    const lessons = [];
    let note;

    if (result === 'won') {
      const tasksFailed = (review.tasks || []).some((t) => t && t.failed);
      const imperfect = (mowersLost || 0) > 0 || (dead || 0) > 0 || tasksFailed;
      note = `第 ${wave || '?'}${waveCount ? `/${waveCount}` : ''} 波过关` + (imperfect
        ? `（推车 ${mowersLost}${dead ? `，保护格 ${dead}/${total} 死亡` : ''}${tasksFailed ? '，任务失败' : ''}）`
        : '，完美通关');
      if (mowersLost > 0) lessons.push(`本局丢了 ${mowersLost} 个推车：下局在丢车行提前 1–2 波补墙/输出，别等僵尸压到房子。`);
      if (dead > 0) lessons.push(`保护格死了 ${dead}/${total}：下局按 unguardedLanes 提前布防，飞行波前留三叶草/近战。`);
      if (tasksFailed) lessons.push('本局有关卡任务失败：下局把 tasks 的 tip/hint/timeLeft 当硬约束，先保任务再铺输出。');
      if (!imperfect) lessons.push('本局完美通关：没有丢车、保护格全活、任务全完成（植物损失是正常战术代价）；下局沿用这套卡组和布防节奏。');
      return { note: note.slice(0, 200), lessons: lessons.slice(0, 4) };
    }

    if (result === 'left' || result === 'restart') {
      note = `第 ${wave || '?'}${waveCount ? `/${waveCount}` : ''} 波${result === 'restart' ? '重开' : '离开'}（${plantsLost} 株植物损失，${mowersLost} 个推车）`;
      if (mowersLost > 0) lessons.push(`离开前已丢 ${mowersLost} 个推车：这些行防线已被打穿，下局优先补墙/输出。`);
      if (plantsLost > 0) lessons.push(`离开前已损失 ${plantsLost} 株植物：下局别在同一个缺口继续堆经济。`);
      if (!lessons.length) lessons.push('本局没有完美通关；下局先读这条记录再决定卡组。');
      return { note: note.slice(0, 200), lessons: lessons.slice(0, 4) };
    }

    note = `第 ${wave || '?'}${waveCount ? `/${waveCount}` : ''} 波失败`;
    if (dead > 0) {
      note += `，保护植物 ${dead}/${total} 死亡${deadLanes.length ? `（第 ${deadLanes.map((l) => l + 1).join('/')} 行）` : ''}`;
      if (dead >= total && total > 1) note += '（关卡判负时会把所有保护格同时标记 dead）';
      if (plantsLost === 0) {
        const who = flyerNames.length ? `${flyerNames.join('、')} ` : '';
        lessons.push(`植物损失为 0，花不是被啃穿的：${who}越过防线直接落到花上。下局在这几行花旁边（c2 或 c4，射程 1 格内）放菜问/近战，并带三叶草等对空；只堆 c4 墙无效。`);
      } else {
        lessons.push(`花所在行被啃穿（植物损失 ${plantsLost}，推车 ${mowersLost}）：下局在这些行提前 1–2 波补墙+输出，别把短手放在花后方。`);
      }
      if (deadLanes.length) {
        lessons.push(`第 ${deadLanes.map((l) => l + 1).join('/')} 行重点：花旁必须有能打到 c${(deadCells[0] && deadCells[0].column) || 3} 的植物；飞行单位入场时先用三叶草/秒杀，别等落地。`);
      }
    } else {
      lessons.push('本局失败但没有保护植物死亡：看 pressure 行，先补该行输出/墙。');
    }
    if (Array.isArray(review.pressure) && review.pressure.length) {
      const lanes = review.pressure.map((p) => `第${p.lane + 1}行(gap ${p.gap})`).join('、');
      lessons.push(`压力最大的是 ${lanes}：下局提前 1–2 波在这些行补输出/墙。`);
    }
    if (mowersLost > 0) lessons.push(`丢了 ${mowersLost} 个推车，说明有行被打穿；下局优先保这些行的墙。`);
    if (!lessons.length) lessons.push('本局失败；下局先读这条记录，换一套针对本关波次的卡组。');
    return { note: note.slice(0, 200), lessons: lessons.slice(0, 4) };
  }

  function failureMeta(run) {
    const review = (run && run.review) || {};
    const flowers = review.flowers || null;
    const deadCells = flowers && Array.isArray(flowers.cells) ? flowers.cells : [];
    const deadLanes = [...new Set(deadCells.map((c) => Number(c.lane)).filter((n) => Number.isFinite(n)))];
    const lastZ = Array.isArray(review.lastZombies) ? review.lastZombies : [];
    const zIn = lastZ.filter((z) => deadLanes.includes(Number(z.lane)));
    const flyers = zIn.filter((z) => (Array.isArray(z.tags) && z.tags.includes('flying')) || FLYING_RE.test(String(z.type)));
    return {
      wave: review.wave != null ? review.wave : null,
      deadLanes,
      lastZ,
      zIn,
      flyers,
      plantsLost: review.plantsLost || 0,
      airdrop: deadLanes.length > 0 && !(review.plantsLost || 0),
    };
  }

  function compactFailureSnapshot(src) {
    if (!src) return null;
    return {
      level: src.level || null,
      sun: src.sun != null ? src.sun : null,
      plantFood: src.plantFood != null ? src.plantFood : null,
      limits: src.limits || null,
      prep: src.prep || null,
      tasks: src.tasks || null,
      objective: src.objective || null,
      missionHints: src.missionHints || null,
      protectCells: src.protectCells || null,
      plants: (src.plants || []).slice(0, 40).map((p) => ({
        type: p.type, name: p.name || null, lane: p.lane, column: p.column,
        hp: p.hp, maxHp: p.maxHp, family: p.family || null, dps: (p.atk && p.atk.dps) || p.dps || null,
      })),
      zombies: (src.zombies || []).slice(0, 30).map((z) => ({
        type: z.type, name: z.name || null, lane: z.lane, column: z.column,
        hp: z.hp, ehp: z.ehp, tags: z.tags || [], speed: z.speed, etaToHouse: z.etaToHouse,
      })),
      lanes: src.lanes || null,
      brief: src.brief || null,
      changesSinceLast: src.changesSinceLast || null,
      recentEvents: src.recentEvents || src.events || null,
    };
  }

  // 模型可以提建议，但“原因”必须和快照对得上：原因里提到的僵尸必须在失败现场；
  // 保护格全灭且植物损失为 0 时，必须归因为越过防线（airdrop），否则整段作废走事实兜底。
  function modelCauseValid(cause, meta, snap) {
    if (!cause || typeof cause !== 'object') return false;
    const lanes = (cause.lanes || []).map(Number).filter((n) => Number.isFinite(n));
    const ztypes = (cause.zombies || []).map(String);
    const present = new Map(((snap && snap.zombies) || []).map((z) => [String(z.type), z]));
    if (ztypes.some((t) => !present.has(t))) return false;
    if (meta.deadLanes.length && !lanes.some((l) => meta.deadLanes.includes(l))) return false;
    if (meta.airdrop) {
      if (String(cause.kind || '') !== 'airdrop') return false;
      const hasFlyer = ztypes.some((t) => {
        const z = present.get(t);
        return z && ((Array.isArray(z.tags) && z.tags.includes('flying')) || FLYING_RE.test(t));
      });
      if (!hasFlyer) return false;
    }
    return true;
  }

  // note/lessons 只能引用真实存在的行/列：lane 1-5、column c0-c8。
  function lessonRefsValid(text) {
    const s = String(text || '');
    for (const m of s.matchAll(/第\s*(\d+)\s*行/g)) {
      const n = Number(m[1]);
      if (n < 1 || n > 5) return false;
    }
    for (const m of s.matchAll(/(?:^|[^a-z])c\s*(\d+)/gi)) {
      const n = Number(m[1]);
      if (n < 0 || n > 8) return false;
    }
    return true;
  }

  function waveMatches(text, wave) {
    const m = /第\s*(\d+)\s*波/.exec(String(text || ''));
    return !m || !wave || Number(m[1]) === Number(wave);
  }

  // 复盘的 note/lesson 不能和 review 的硬数字冲突。
  function factsConsistent(text, meta) {
    const s = String(text || '');
    const lost = Number(meta.plantsLost) || 0;
    if (lost > 0 && /没有植物损失|无植物损失|植物损失\s*0(?!\d)/.test(s)) return false;
    if (lost === 0 && /植物损失\s*[1-9]/.test(s)) return false;
    return true;
  }

  // 赛后复盘：把“失败那一波的现场快照 + 最近动作”喂给模型；模型只负责分析，
  // 原因必须能被快照验证，验证不过就退回确定性事实诊断。
  async function runAutoReview(phase) {
    const outcome = await resolveRunOutcome(phase);
    if (!outcome || !shouldAutoReview(outcome.result, outcome.run)) return null;
    const result = outcome.result;
    const run = outcome.run || null;
    const key = outcome.key || (lastState && lastState.levelKey) || (run && run.key) || null;
    if (!run && !lastState) return null;
    const diag = deterministicReview(result, run);
    const meta = failureMeta(run);
    const rawSnap = (run && run.review && run.review.snapshot) || stateDigest(lastState);
    const snap = compactFailureSnapshot(rawSnap) || (run && run.review) || null;
    let note = diag.note;
    let lessons = diag.lessons.slice();

    if (snap) {
      const resultText = result === 'won' ? '胜利' : result === 'lost' ? '失败' : (result === 'restart' ? '中途重开' : '中途离开');
      const reviewMessages = [
        {
          role: 'system',
          content: '你是《植物大战僵尸2 花园无尽》的赛后复盘助手。只根据给出的对局快照和最近动作分析，不编造。原因必须引用快照里真实存在的僵尸 codename、lane（0-4）和 column（0-8）。只输出 JSON。',
        },
        {
          role: 'user',
          content: [
            `对局快照（最后一刻，结果：${resultText}）：${JSON.stringify(snap)}`,
            `最近动作：${JSON.stringify(recentActions.slice(-10))}`,
            `系统事实诊断：${JSON.stringify({ note: diag.note, deadLanes: meta.deadLanes, lastZombiesInDeadLanes: meta.zIn.map((z) => ({ type: z.type, name: z.name, lane: z.lane, column: z.column, tags: z.tags })) })}`,
            '',
            '要求：',
            '- cause.zombies 只能写快照 zombies 里出现过的 codename；不能把原因归给快照里没有的僵尸。',
            '- 有保护格死亡且 plantsLost=0 时，kind 必须是 airdrop，并指明是哪种飞行/跳跃单位落到了哪一行。',
            '- lessons 最多 4 条，每条 ≤60 字，具体到行/列/卡/波次；不要写“要更小心”。',
            '输出 {"note":"一句话总结（≤80字）","cause":{"kind":"airdrop|breakthrough|economy|objective|unknown","lanes":[0],"zombies":["codename"],"evidence":"快照里的依据"},"lessons":["..."]}',
          ].join('\n'),
        },
      ];
      let timer = null;
      try {
        timer = setTimeout(() => { try { if (controller) controller.abort(); } catch { /* ignore */ } }, 20000);
        const reply = await callModel({ stream: false, model: fastModelOn() || config.model, msgs: reviewMessages, maxTokens: 900, noTools: true });
        const text = String(reply && reply.content || '').trim();
        if (text) {
          const jsonText = (() => {
            const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
            if (fenced) return fenced[1].trim();
            const a = text.indexOf('{');
            const b = text.lastIndexOf('}');
            return a >= 0 && b > a ? text.slice(a, b + 1) : text;
          })();
          let parsed = null;
          try { parsed = JSON.parse(jsonText); } catch { parsed = null; }
          if (parsed && modelCauseValid(parsed.cause, meta, snap)) {
            const modelLessons = Array.isArray(parsed.lessons)
              ? parsed.lessons.map((x) => String(x).trim())
                .filter((x) => x && waveMatches(x, meta.wave) && factsConsistent(x, meta) && lessonRefsValid(x))
                .slice(0, 3)
              : [];
            if (parsed.note && waveMatches(parsed.note, meta.wave) && factsConsistent(parsed.note, meta) && lessonRefsValid(parsed.note)) note = String(parsed.note).slice(0, 200);
            if (modelLessons.length) {
              const seed = meta.deadLanes.length ? [diag.lessons[0]] : [];
              lessons = [...seed, ...modelLessons.filter((x) => !diag.lessons.includes(x))].filter(Boolean).slice(0, 4);
            }
          } else if (parsed) {
            emit({ type: 'log', text: '复盘模型的归因和失败快照对不上（提到了现场不存在的僵尸/行），已改用事实诊断。' });
          }
        }
      } catch (e) {
        emit({ type: 'log', text: `复盘模型失败，改用事实诊断：${String(e && e.message || e).slice(0, 160)}` });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (incidentLessons.length) {
      lessons = [...new Set([...incidentLessons, ...lessons])].slice(0, 5);
    }
    if (!note && !lessons.length) return null;
    try {
      const saved = await router.call('pvz_level_memory', {
        ...(key ? { key } : {}),
        ...(note ? { note } : {}),
        ...(lessons.length ? { lessons, replaceLessons: true } : {}),
      });
      const out = { ok: !!(saved && saved.ok !== false), note, lessons, key: (saved && saved.key) || key, result };
      emit({ type: 'review', ...out });
      emit({
        type: 'log',
        text: `赛后复盘：${out.ok ? '已写入本关经验' : '写入失败'}${lessons.length ? `（${lessons.length} 条）` : ''}${note ? `：${note}` : ''}`,
      });
      return out;
    } catch (e) {
      emit({ type: 'log', text: `赛后复盘写入失败（不影响本局）：${String(e && e.message || e).slice(0, 160)}` });
      return null;
    }
  }

  async function runLoop() {
    let steps = 0;
    let idleNudges = 0;
    let consecutiveFailures = 0;
    lastError = null;
    emit({ type: 'run_start', version, model: config.model, fastModel: fastModelOn() || null, autoReview: config.autoReview });
    while (running && !stopRequested) {
      steps++;
      if (steps > Number(config.maxSteps || 80)) {
        emit({ type: 'error', code: 'STEP_LIMIT', reason: `连续 ${steps - 1} 步没有结束；已停止（不会本地接管）` });
        break;
      }
      // 玩家指令可能在工具执行中途到达；不能直接插到 assistant(tool_calls) 和 tool 之间，
      // 否则下一轮会变成“tool 没有对应的 tool_calls”400。统一在安全点入队。
      if (pendingInstructions.length) {
        for (const s of pendingInstructions.splice(0)) {
          messages.push({ role: 'user', content: `玩家指示：${s}\n按指示调整，但不要违反关卡事实和工具返回。` });
        }
      }
      let reply;
      let modelMs = 0;
      try {
        const phaseNow = lastPhase || 'preparing';
        const modelNow = pickModel(phaseNow, steps);
        const reason = phaseNow === 'running'
          ? (forceStrongRounds > 0 ? '关键局面/定期升级' : '战斗快模型')
          : '开局/选卡';
        // 切模型 = 换人接手：不把上一个模型的 assistant 历史带过去，
        // 只交接系统提示、计划、最近状态和玩家指示。顺带避开 reasoning_content 校验。
        if (usedModel && modelNow !== usedModel) {
          messages = buildHandoff(modelNow, reason);
          emit({ type: 'log', text: `已重建上下文（${usedModel} → ${modelNow}），只交接计划和最近状态` });
        }
        noteModel(modelNow, reason);
        forceStrongRounds = Math.max(0, forceStrongRounds - 1);
        // 参谋如果在下一轮开始前才回来，直接挂到最后一条工具结果上（只改尾部，不破坏缓存）。
        if (advisorNote && advisorNote.text) {
          const last = messages[messages.length - 1];
          if (last && last.role === 'tool' && typeof last.content === 'string') {
            try {
              const o = JSON.parse(last.content);
              if (o && typeof o === 'object') {
                o.advisor = { note: advisorNote.text };
                last.content = JSON.stringify(o);
                advisorNote = null;
              }
            } catch { /* 非 JSON 就留到下一份结果 */ }
          }
        }
        emit({ type: 'request', step: steps, messageCount: messages.length });
        const modelStartedAt = Date.now();
        reply = await callWithFallback(modelNow);
        modelMs = Date.now() - modelStartedAt;
        stats.modelMs += modelMs;
      } catch (e) {
        if (e && (e.code === 'STOPPED' || e.name === 'AbortError')) break;
        lastError = e;
        // 上游 5xx/429 属于"等一会儿就好"，自动等一轮再连，不把整局打断
        if (e && e.retryable && !stopRequested && consecutiveFailures < 3) {
          consecutiveFailures += 1;
          const wait = Math.max(5, Math.min(60, Number(e.retryAfterSec) || 15));
          emit({
            type: 'log',
            text: `模型接口仍不可用（${e.status ? `HTTP ${e.status}` : (e.code || '网络错误')}），${wait}s 后自动重连（${consecutiveFailures}/3）；期间不会本地接管`,
          });
          await sleep(wait * 1000);
          continue;
        }
        emit({
          type: 'error',
          code: e.code || 'LLM_FAILED',
          reason: String(e.message || e).slice(0, 300),
          hint: e && e.retryable ? '上游持续过载：稍后点“继续”即可从当前局面接着打（已完成的动作不会重做）' : undefined,
        });
        break;
      }
      consecutiveFailures = 0;
      if (!running || stopRequested) break;

      if (reply.reasoning) emit({ type: 'thinking_final', text: reply.reasoning });
      if (reply.content) emit({ type: 'assistant', text: reply.content });

      if (reply.toolCalls && reply.toolCalls.length) {
        idleNudges = 0;
        messages.push({
          role: 'assistant',
          content: reply.content || '',
          // DeepSeek 思考模式要求把本轮 reasoning_content 原样回传；不传会在下一轮 400。
          ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
          tool_calls: reply.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.rawArgs === 'string' ? tc.rawArgs : JSON.stringify(tc.args || {}) },
          })),
        });
        // 后台参谋与工具执行并行：先发出去，等动作落地时结果通常已经回来，附在本次工具结果里。
        const waveNow = lastState && lastState.level ? lastState.level.wave : null;
        const waveChanged = waveNow != null && advisorLastWave != null && waveNow !== advisorLastWave;
        if (waveNow != null) advisorLastWave = waveNow;
        const advisorEvery = Number(config.advisorEvery) || 0;
        if (config.advisor !== false && fastModelOn() && lastPhase === 'running' && !advisorBusy
          && (waveChanged || (advisorEvery > 0 && steps % advisorEvery === 0))) {
          void runAdvisor(waveChanged ? `换波：第 ${waveNow} 波` : '定期');
        }
        const toolStartedAt = Date.now();
        for (let i = 0; i < reply.toolCalls.length; i++) {
          if (!running || stopRequested) break;
          await executeToolCall(reply.toolCalls[i], i);
        }
        const toolMs = Date.now() - toolStartedAt;
        stats.toolMs += toolMs;
        if (config.timingLog !== false) {
          emit({ type: 'log', text: `轮 ${steps} 耗时：模型 ${modelMs}ms · 工具 ${toolMs}ms · ${reply.toolCalls.length} 个调用` });
        }
        trimMessages();
        await sleep(Number(config.loopDelayMs) || 0);
        continue;
      }

      // 模型没调用工具：最多提醒 3 次；再不行就停，不本地接管。
      messages.push({
        role: 'assistant',
        content: reply.content || '',
        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
      });
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
    await runAutoReview(lastPhase);
    emit({
      type: 'run_end',
      phase: lastPhase,
      stats: {
        ...stats,
        avgPromptTokens: stats.requests ? Math.round(stats.promptTokens / stats.requests) : 0,
        avgCompletionTokens: stats.requests ? Math.round(stats.completionTokens / stats.requests) : 0,
      },
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
    stats = { requests: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, modelSwitches: 0, modelMs: 0, toolMs: 0 };
    lastPhase = null;
    everRunning = false;
    lastError = null;
    lastState = null;
    forceStrongRounds = 0;
    usedModel = '';
    runStartedAt = Date.now();
    recentActions = [];
    advisorBusy = false;
    advisorNote = null;
    advisorLastWave = null;
    pendingInstructions = [];
    incidentLessons = [];
    lostMowerLanes = new Set();
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
    // 不能直接 push：如果模型正在执行 assistant(tool_calls)，会插在 tool 消息前导致 400。
    pendingInstructions.push(s);
    emit({ type: 'user', text: s });
    return { ok: true, running: true, queued: true };
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

