import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatencyStore } from '../bridge/latency.js';
import { createBridge } from '../bridge/api.js';
import { resetAssetCache } from '../bridge/stats.js';
import { createToolRouter } from '../tools/router.js';
import { createEventStreamApi } from '../bridge/events.js';
import { createLlmAgent } from '../in-game/agent.js';
import { createFakeGame } from './helpers/fake-game.mjs';

test('latency：默认 lead、实测后按 EMA 收敛、可复现', () => {
  const l = createLatencyStore();
  const s0 = l.state();
  assert.equal(s0.source, 'default');
  assert.equal(s0.leadSec, 7.1, '(6000+600+450)/1000');

  l.recordModel(2000);
  l.recordTool(200);
  const s1 = l.state();
  assert.equal(s1.source, 'measured');
  assert.equal(s1.modelMs, 2000);
  assert.equal(s1.toolMs, 200);
  assert.equal(s1.leadSec, 2.7);

  // 变慢 3 倍时立刻跟上（权重 0.6），不会慢吞吞地爬
  l.recordModel(6000);
  assert.ok(l.state().modelMs > 4000);
  l.setSettle(1000);
  assert.equal(l.state().settleMs, 1000);
});

test('state：每行给 incoming/gap/lossIn/actBy，brief 按缺口排序', () => {
  resetAssetCache();
  const game = createFakeGame({
    slots: 3,
    zombies: [
      { lane: 0, type: 'tutorial', health: 190, column: 5 },
      { lane: 3, type: 'tutorial', health: 190, column: 8 },
    ],
  });
  const bridge = createBridge(game.ctx);
  try {
    const s = bridge.snapshot();
    assert.equal(s.ok, true, JSON.stringify(s));
    const l0 = s.lanes[0];
    assert.equal(l0.zombies, 1);
    assert.ok(l0.incomingPerSec > 0, '有僵尸就有威胁率');
    assert.ok(l0.gap > 0, '没有射手时 gap 为正');
    assert.ok(l0.lossIn > 0 && l0.lossIn < 30, 'lossIn = 到房子的秒数');
    assert.ok(l0.actBy < l0.lossIn, 'actBy 已扣掉 AI 延迟');
    assert.equal(s.brief.pressure[0].lane, 0, '缺口最大的行排第一');
    assert.ok(s.brief.safeLanes.includes(1));
    assert.ok(s.brief.leadSec > 0);
    assert.ok(s.latency && s.latency.leadSec > 0);
    assert.ok(Array.isArray(s.protectCells), 'protectCells 总是数组（没有鲜花就是空数组）');
    for (const c of s.cards) {
      assert.equal(typeof c.etaReady, 'number', '卡牌带 etaReady');
      assert.ok(c.etaReady >= 0);
    }
  } finally {
    try { bridge.dispose(); } catch { /* ignore */ }
    try { delete globalThis.PvzLlm; } catch { /* ignore */ }
  }
});

test('pvz_state 直接带 events（省掉每轮多一次模型往返）', async () => {
  const router = createToolRouter({
    bridge: {
      snapshot: async () => ({ ok: true, phase: 'running', sun: 50, lanes: [], cards: [], plants: [], zombies: [] }),
      pollEvents: async () => [{ t: 'wave_started', wave: 2 }],
    },
  });
  const s = await router.call('pvz_state', {});
  assert.deepEqual(s.events, [{ t: 'wave_started', wave: 2 }]);
});

test('events：重开/换关时清空上一局的事件，不把旧波次喂给模型', () => {
  const ended = [];
  const base = { ok: true, lanes: [], plants: [], zombies: [], cards: [], tasks: [], key: 'pirate15' };
  const states = [
    { ...base, phase: 'preparing', level: { wave: 0, waves: 16 } },
    { ...base, phase: 'running', level: { wave: 1, waves: 16 } },
    { ...base, phase: 'running', level: { wave: 2, waves: 16 } },
    { ...base, phase: 'preparing', level: { wave: 0, waves: 16 } }, // 重开
    { ...base, phase: 'running', level: { wave: 1, waves: 16 } },   // 新一局
  ];
  let i = 0;
  const api = createEventStreamApi({
    snapshot: () => states[Math.min(i++, states.length - 1)],
    keyOf: (s) => s.key,
    onLevelEnd: (x) => ended.push(x),
  });
  api.sample(); // preparing
  api.sample(); // running wave1
  api.sample(); // wave2 → 波次事件入队
  assert.ok(api.status().pending > 0, '有事件入队');
  api.sample(); // 重开
  assert.equal(api.status().pending, 0, '重开后队列清空');
  assert.ok(ended.some((x) => x.result === 'restart'), '重开记一条 restart');
  api.sample(); // 新一局
  const fresh = api.events();
  assert.ok(fresh.every((e) => e.wave == null || e.wave === 1), '新一局只留本局事件（不该出现上一局的高波次）');
  api.dispose();
});

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}
function reply(message) {
  return { ok: true, json: async () => ({ choices: [{ message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
}
const ROUTER = {
  call: async () => ({ ok: true, phase: 'running', sun: 50, cards: [], plants: [], zombies: [], tasks: [], lanes: [], level: { wave: 1, waves: 2 } }),
};

test('agent：上游 503 自动重试，不打断整局', async () => {
  let n = 0;
  const events = [];
  const fetchImpl = async () => {
    n += 1;
    if (n <= 2) {
      return { ok: false, status: 503, headers: { get: () => null }, text: async () => '{"error":{"message":"Service is too busy","type":"service_unavailable_error"}}' };
    }
    return reply({ content: '', tool_calls: [toolCall('c1', 'pvz_state', {})] });
  };
  const agent = createLlmAgent({
    fetchImpl, router: ROUTER, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 5 },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'tool_result') agent.stop('测试停止');
    },
  });
  const started = await agent.start();
  await started.done;
  assert.equal(n, 3, '两次 503 后第三次成功');
  assert.ok(events.some((e) => e.type === 'log' && /(重试|尝试|重连)/.test(e.text || '')));
  assert.ok(!events.some((e) => e.type === 'error'), '瞬时错误不应变成红色错误');
});

test('agent：上游持续 503 会重连几次后给 LLM_UNAVAILABLE，而不是静默结束', async () => {
  let n = 0;
  const events = [];
  const fetchImpl = async () => {
    n += 1;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => '{"error":{"message":"Service is too busy"}}' };
  };
  const agent = createLlmAgent({
    fetchImpl, router: ROUTER, sleep: async () => {},
    cfg: { baseUrl: 'https://example.test/v1', model: 'mock', apiKey: 'sk-test', stream: false, maxSteps: 5 },
    onEvent: (ev) => events.push(ev),
  });
  const started = await agent.start();
  await started.done;
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '要有 error 事件');
  assert.equal(err.code, 'LLM_UNAVAILABLE');
  assert.ok(n >= 6, '至少重试过几轮才放弃');
});
