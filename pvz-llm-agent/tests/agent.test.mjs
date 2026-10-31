import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmAgent, normalizeBaseUrl, parseToolArgs, PROVIDER_PRESETS } from '../in-game/agent.js';

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

function reply(message) {
  return { ok: true, json: async () => ({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
}

test('normalizeBaseUrl / parseToolArgs', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
  assert.equal(parseToolArgs('{bad').__parseError, '{bad');
});

test('agent 执行 tool_calls、回填结果、显示推理，并在收到停止时结束', async () => {
  const calls = [];
  const router = {
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'pvz_health') return { ok: true, version: '0.1.19', phase: 'running' };
      if (name === 'pvz_state') return { ok: true, phase: 'running', sun: 100, plantFood: 1, level: { wave: 1, waves: 2 }, cards: [], plants: [], zombies: [], tasks: [], lanes: [] };
      return { ok: true };
    },
  };
  const replies = [
    reply({ content: '', reasoning_content: '先确认模组。', tool_calls: [toolCall('c1', 'pvz_health', {})] }),
    reply({ content: '', tool_calls: [toolCall('c2', 'pvz_state', {})] }),
  ];
  let i = 0;
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const r = replies[Math.min(i++, replies.length - 1)];
    return r;
  };
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 10 },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool_result' && ev.name === 'pvz_state') agent.stop('测试停止');
    },
  });

  const started = await agent.start();
  assert.equal(started.ok, true);
  await started.done;

  assert.deepEqual(calls.map((c) => c.name), ['pvz_health', 'pvz_state']);
  assert.equal(agent.getStats().toolCalls, 2);
  assert.ok(events.some((e) => e.type === 'thinking_final' && e.text.includes('确认模组')));
  assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'pvz_health'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'pvz_state' && e.ok));
  assert.ok(events.some((e) => e.type === 'run_end'));
  assert.ok(bodies[0].tools.length === 18);
  assert.equal(bodies[0].tool_choice, 'auto');
  // 思考模型要求回传 reasoning_content，否则下一轮会 400
  const echoed = (bodies[1].messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(echoed && echoed.reasoning_content, '先确认模组。');

  const msgs = agent.getMessages();
  assert.ok(msgs.some((m) => m.role === 'tool' && m.name === 'pvz_health'));
  assert.ok(msgs.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)));
});

test('agent 对非法工具参数返回 BAD_TOOL_ARGS，不抛异常', async () => {
  const router = { call: async () => ({ ok: true }) };
  const fetchImpl = async () => reply({ content: '', tool_calls: [toolCall('c1', 'pvz_state', '{bad')] });
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 5 },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool_result') agent.stop();
    },
  });
  const r = await agent.start();
  await r.done;
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.result.code, 'BAD_TOOL_ARGS');
});

test('agent 模型连续不调用工具时停住，不本地接管', async () => {
  const router = { call: async () => ({ ok: true }) };
  const fetchImpl = async () => reply({ content: '我只是说说。' });
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 20 },
    onEvent: (ev) => events.push(ev),
  });
  const r = await agent.start();
  await r.done;
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'NO_TOOL_CALL'));
  assert.equal(agent.isRunning(), false);
});

test('agent 流式：reasoning / tool_calls 分片 / 工具执行', async () => {
  const calls = [];
  const router = {
    call: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, phase: 'running', sun: 50, cards: [], plants: [], zombies: [], tasks: [], lanes: [] };
    },
  };
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先看状态"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"pvz_state","arguments":"{"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const fetchImpl = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  });
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: true, maxSteps: 5 },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool_result') agent.stop();
    },
  });
  const r = await agent.start();
  await r.done;
  assert.deepEqual(calls, [{ name: 'pvz_state', args: {} }]);
  assert.ok(events.some((e) => e.type === 'thinking' && e.text.includes('先看状态')));
  assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'pvz_state'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.result.ok));
});

test('testConnection 返回延迟或结构化失败', async () => {
  const okAgent = createLlmAgent({
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) }),
    router: { call: async () => ({ ok: true }) },
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test' },
  });
  const ok = await okAgent.testConnection();
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'OK');

  const badAgent = createLlmAgent({
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    router: { call: async () => ({ ok: true }) },
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'bad' },
  });
  const bad = await badAgent.testConnection();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'LLM_HTTP');
  assert.equal(bad.status, 401);
});

test('双层模型：开局用主模型，进入 running 后自动切快模型，可恢复', async () => {
  const models = [];
  const replies = [
    reply({ content: '', tool_calls: [toolCall('c1', 'pvz_state', {})] }),
    reply({ content: '', tool_calls: [toolCall('c2', 'pvz_state', {})] }),
    reply({ content: '', tool_calls: [toolCall('c3', 'pvz_state', {})] }),
  ];
  let i = 0;
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    models.push(body.model);
    bodies.push(body);
    return replies[Math.min(i++, replies.length - 1)];
  };
  const router = { call: async () => ({ ok: true, phase: 'running', sun: 50, cards: [], plants: [], zombies: [], tasks: [], lanes: [] }) };
  const events = [];
  let step = 0;
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'strong', fastModel: 'fast', escalateEvery: 0, apiKey: 'sk-test', stream: false, maxSteps: 10 },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool_result' && ++step >= 3) agent.stop('测试停止');
    },
  });
  const r = await agent.start();
  await r.done;
  assert.equal(models[0], 'strong', '第一步（未知 phase）用主模型');
  assert.equal(models[1], 'fast', 'running 后用快模型');
  const handoff = (bodies[1].messages || []).find((m) => m.role === 'user' && /模型已从上一个模型切换/.test(String(m.content || '')));
  assert.ok(handoff, '切模型时重建上下文并交接计划/状态');
  assert.ok(!(bodies[1].messages || []).some((m) => m.role === 'assistant' && m.reasoning_content), '不把旧模型的推理带给新模型');
  assert.ok(events.some((e) => e.type === 'model' && e.model === 'fast'));
  assert.ok(agent.getStats().modelSwitches >= 1);
});

test('复盘：丢车中途只记录事实，关卡结束才写 note+lessons', async () => {
  const order = [];
  const now = new Date().toISOString();
  const running = {
    ok: true, phase: 'running', levelKey: 'cowboy13',
    level: { name: '狂野西部 13', wave: 5, waves: 10 },
    sun: 120, cards: [], plants: [], tasks: [], protectCells: [],
    zombies: [{ type: 'tutorial', name: '普通僵尸', lane: 1, column: 2, tags: [], ehp: 190 }],
    lanes: [{ lane: 1, gap: 25, lossIn: 3, dps: 10, mower: false }],
    changesSinceLast: { mowerLost: [1] },
  };
  const lost = { ...running, phase: 'lost', level: { name: '狂野西部 13', wave: 6, waves: 10 } };
  let stateCalls = 0;
  const router = {
    call: async (name, args) => {
      order.push({ name, args });
      if (name === 'pvz_state') {
        stateCalls += 1;
        return stateCalls === 1 ? running : lost;
      }
      if (name === 'pvz_level_memory') {
        if (args && (args.note != null || Array.isArray(args.lessons))) return { ok: true, key: 'cowboy13' };
        return { ok: true, key: 'cowboy13', entry: { runs: [{ result: 'lost', at: now }] } };
      }
      return { ok: true };
    },
  };
  const reviewJson = JSON.stringify({
    note: '第 6 波第 2 行被压穿',
    cause: { kind: 'breakthrough', lanes: [1], zombies: ['tutorial'], evidence: '第 2 行僵尸到 c2' },
    lessons: ['第 6 波前在第 2 行 c5 补墙'],
  });
  let round = 0;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tools) {
      round += 1;
      const name = 'pvz_state';
      return reply({ content: '', tool_calls: [toolCall(`c${round}`, name, {})] });
    }
    return reply({ content: reviewJson });
  };
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 10 },
    onEvent: (ev) => events.push(ev),
  });
  const started = await agent.start();
  await started.done;

  const writes = order.filter((c) => c.name === 'pvz_level_memory' && c.args && (c.args.note != null || Array.isArray(c.args.lessons)));
  assert.equal(writes.length, 1, '整局只写一次记忆：' + JSON.stringify(order.map((c) => c.name)));
  const firstState = order.findIndex((c) => c.name === 'pvz_state');
  const secondState = order.findIndex((c, i) => c.name === 'pvz_state' && i > firstState);
  const writeAt = order.findIndex((c) => c.name === 'pvz_level_memory' && c.args && c.args.note != null);
  assert.ok(writeAt > secondState, '复盘写入必须发生在关卡结束之后');
  assert.ok(writes[0].args.note, '结束时要写 note');
  assert.ok(Array.isArray(writes[0].args.lessons) && writes[0].args.lessons.length, '结束时要写 lessons');
  assert.equal(writes[0].args.replaceLessons, true);
  assert.ok(events.some((e) => e.type === 'review' && e.note), '复盘结果要推给 UI');
});

test('并发安全：玩家中途指令在安全点入队，不破坏 assistant(tool_calls)→tool 顺序', async () => {
  let enteredResolve;
  const entered = new Promise((r) => { enteredResolve = r; });
  let releaseResolve;
  const gate = new Promise((r) => { releaseResolve = r; });
  let stateCalls = 0;
  const router = {
    call: async (name) => {
      if (name === 'pvz_state') {
        stateCalls += 1;
        if (stateCalls === 1) { enteredResolve(); await gate; }
      }
      return { ok: true, phase: 'running', sun: 100, plantFood: 0, level: { wave: 1, waves: 2 }, cards: [], plants: [], zombies: [], tasks: [], lanes: [] };
    },
  };
  const bodies = [];
  let round = 0;
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    round += 1;
    return reply({ content: '', tool_calls: [toolCall(`c${round}`, 'pvz_state', {})] });
  };
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 10 },
    onEvent: (ev) => {
      if (ev.type === 'tool_result' && stateCalls >= 2) agent.stop('测试停止');
    },
  });
  const started = await agent.start();
  await entered;
  const q = agent.sendInstruction('第 2 行补墙');
  assert.equal(q.queued, true, '工具执行中只入队，不直接插入 messages');
  releaseResolve();
  await started.done;

  const msgs = bodies[1].messages;
  const aIdx = msgs.findIndex((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
  assert.ok(aIdx >= 0, JSON.stringify(msgs.map((m) => m.role)));
  assert.equal(msgs[aIdx + 1].role, 'tool', 'tool 结果必须紧跟 assistant(tool_calls)');
  const uIdx = msgs.findIndex((m) => m.role === 'user' && /玩家指示/.test(String(m.content || '')));
  assert.ok(uIdx > aIdx + 1, '玩家指令只能在工具结果之后加入');
});

test('复盘：胜利但只损失植物（没丢车/保护格/任务）算完美通关，不触发复盘', async () => {
  const order = [];
  const now = new Date().toISOString();
  const won = {
    ok: true, phase: 'won', levelKey: 'cowboy13',
    level: { name: '狂野西部 13', wave: 10, waves: 10 },
    sun: 200, cards: [], plants: [], tasks: [], protectCells: [],
    zombies: [], lanes: [],
    changesSinceLast: { plantsLost: [{ lane: 0, column: 2, type: 'sunflower' }] },
  };
  const router = {
    call: async (name, args) => {
      order.push({ name, args });
      if (name === 'pvz_state') return won;
      if (name === 'pvz_level_memory') {
        return {
          ok: true, key: 'cowboy13',
          entry: {
            runs: [{
              result: 'won', at: now,
              review: { wave: 10, waveCount: 10, plantsLost: 3, mowersLost: 0, flowers: null, tasks: [] },
            }],
          },
        };
      }
      return { ok: true };
    },
  };
  let loopRounds = 0;
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (!body.tools) {
      loopRounds += 100; // 复盘模型不该被调用
      return reply({ content: '{}' });
    }
    loopRounds += 1;
    return reply({ content: '', tool_calls: [toolCall('c1', 'pvz_state', {})] });
  };
  const events = [];
  const agent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 5 },
    onEvent: (ev) => events.push(ev),
  });
  const started = await agent.start();
  await started.done;

  const writes = order.filter((c) => c.name === 'pvz_level_memory' && c.args && (c.args.note != null || Array.isArray(c.args.lessons)));
  assert.equal(writes.length, 0, '只损失植物不算不完美，不写复盘');
  assert.equal(loopRounds, 1, '不额外调用复盘模型');
  assert.ok(!events.some((e) => e.type === 'review'));
});

test('缺少配置时不启动', async () => {
  const agent = createLlmAgent({ fetchImpl: async () => ({}), router: { call: async () => ({ ok: true }) }, cfg: {} });
  const r = await agent.start();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_CONFIG');
});

test('PROVIDER_PRESETS：OpenCode Go 指向 OpenAI 兼容端点', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.label, p.id);
    if (p.id !== 'custom') assert.ok(p.baseUrl && p.model, p.id);
  }

  const go = PROVIDER_PRESETS.find((p) => p.id === 'opencode-go');
  assert.equal(go.baseUrl, 'http://127.0.0.1:8787/v1', '浏览器不能直连，必须走本地代理');
  assert.equal(go.model, 'deepseek-flash', '上游只认 deepseek-flash / deepseek-v4-pro');
  assert.equal(normalizeBaseUrl(go.baseUrl), 'http://127.0.0.1:8787/v1/chat/completions');
  assert.ok(go.models.includes('deepseek-flash'));
  assert.ok(go.models.includes('deepseek-v4-pro'));
  assert.ok(!go.models.some((m) => /v4\.1/.test(m)), '别再把上游不认的模型名塞进候选');
  assert.ok(/local-proxy/.test(go.hint), '提示里要告诉用户先起代理');
  assert.ok(/deepseek-flash/.test(go.hint), '提示里要写清合法模型名');
});

test('OpenCode Go 请求带 x-opencode-session，DeepSeek 官方不带', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers });
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
  };
  const router = { call: async () => ({ ok: true }) };
  const go = PROVIDER_PRESETS.find((p) => p.id === 'opencode-go');

  const goAgent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: go.baseUrl, model: go.model, apiKey: 'sk-go', stream: false },
  });
  const okGo = await goAgent.testConnection();
  assert.equal(okGo.ok, true, JSON.stringify(okGo));
  assert.equal(seen[0].url, 'http://127.0.0.1:8787/v1/chat/completions');
  assert.ok(String(seen[0].headers['x-opencode-session'] || '').startsWith('pvzllm-'), JSON.stringify(seen[0].headers));

  const dsAgent = createLlmAgent({
    fetchImpl, router, sleep: async () => {},
    cfg: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-ds', stream: false },
  });
  const okDs = await dsAgent.testConnection();
  assert.equal(okDs.ok, true);
  assert.equal(seen[1].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen[1].headers['x-opencode-session'], undefined, '只有 OpenCode Go 需要该头');
});
