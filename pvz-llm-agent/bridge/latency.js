/**
 * latency：把"模型往返要多久"变成一个可用的数，供每一轮做提前量。
 *
 * 三个数：
 *  - modelMs：模型从收到请求到返回 tool_calls 的时间（游戏内 agent 实测）
 *  - toolMs：一次工具调用（读状态/执行动作）的耗时
 *  - settleMs：动作发起后到真正落地（种植/铲除）的经验值
 *
 * 外部 MCP 客户端测不到模型耗时，用保守默认值；leadSec 就是"现在下指令，多久后才会生效"。
 */

const EMA = 0.4;
const DEFAULT_MODEL_MS = 6000;
const DEFAULT_TOOL_MS = 600;
const DEFAULT_SETTLE_MS = 450;

const round1 = (v) => Math.round(v * 10) / 10;

export function createLatencyStore(opts) {
  const o = opts || {};
  let modelMs = Number.isFinite(Number(o.modelMs)) ? Number(o.modelMs) : null;
  let toolMs = Number.isFinite(Number(o.toolMs)) ? Number(o.toolMs) : null;
  let settleMs = Number.isFinite(Number(o.settleMs)) ? Number(o.settleMs) : DEFAULT_SETTLE_MS;
  let modelSamples = 0;
  let toolSamples = 0;
  let updatedAt = null;

  function blend(prev, next, fallback) {
    if (!Number.isFinite(next) || next <= 0) return prev;
    if (prev == null) return next;
    // 抖动很大：用 EMA 平滑，但大幅变慢时立刻跟上一部分（取较大权重）
    const w = next > prev * 1.5 ? 0.6 : EMA;
    return prev * (1 - w) + next * w;
  }

  function recordModel(ms) {
    modelMs = blend(modelMs, Number(ms), DEFAULT_MODEL_MS);
    modelSamples += 1;
    updatedAt = new Date().toISOString();
    return modelMs;
  }

  function recordTool(ms) {
    toolMs = blend(toolMs, Number(ms), DEFAULT_TOOL_MS);
    toolSamples += 1;
    updatedAt = new Date().toISOString();
    return toolMs;
  }

  /** 到动作真正生效的总延迟（秒） */
  function leadSec() {
    const m = modelMs == null ? DEFAULT_MODEL_MS : modelMs;
    const t = toolMs == null ? DEFAULT_TOOL_MS : toolMs;
    return round1((m + t + settleMs) / 1000);
  }

  function state() {
    return {
      leadSec: leadSec(),
      modelMs: modelMs == null ? null : Math.round(modelMs),
      toolMs: toolMs == null ? null : Math.round(toolMs),
      settleMs,
      modelSamples,
      toolSamples,
      source: modelSamples ? 'measured' : 'default',
      updatedAt,
    };
  }

  function reset() {
    modelMs = null;
    toolMs = null;
    modelSamples = 0;
    toolSamples = 0;
    updatedAt = null;
  }

  function setSettle(ms) {
    if (Number.isFinite(Number(ms)) && Number(ms) >= 0) settleMs = Number(ms);
    return settleMs;
  }

  return { recordModel, recordTool, leadSec, state, reset, setSettle };
}
