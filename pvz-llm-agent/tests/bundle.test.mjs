/**
 * 打包产物冒烟测试：直接执行 pack/scripts/main.js（不是源模块）。
 *
 * 为什么要有：0.1.23 曾经漏把 bridge/latency.js 加进 build 的 MODULES，
 * check_mod 只查语法，游戏里一加载就报 "createLatencyStore is not defined"。
 * 这里在 vm 里跑一遍 bundle + setupInGame，能在打包前抓到这类缺失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createFakeGame } from './helpers/fake-game.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'pack', 'scripts', 'main.js');

test('bundle：整包能加载并完成 setupInGame（不缺模块/不缺顶层函数）', () => {
  const src = fs.readFileSync(bundlePath, 'utf8').replace(/^export default .*$/m, '');
  const game = createFakeGame({ slots: 3 });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Number, String, Object, Array, Error, Map, Set, WeakMap,
    require: undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = undefined;
  vm.createContext(sandbox);
  const entry = vm.runInContext(`(function () {\n${src}\n; return setupInGame;\n})()`, sandbox, { filename: 'bundle.js' });
  assert.equal(typeof entry, 'function', 'bundle 要暴露 setupInGame');

  const api = entry(game.ctx);
  assert.ok(api && api.bridge, 'setupInGame 要返回 bridge');
  assert.equal(typeof api.bridge.snapshot, 'function');
  assert.equal(typeof api.bridge.forecast, 'function', '新功能要在 bundle 里（漏模块会在这里暴露）');
  assert.equal(typeof api.bridge.latency.recordModel, 'function');
  const s = api.bridge.snapshot();
  assert.equal(s.ok, true, JSON.stringify(s).slice(0, 300));
  const b = api.bridge.briefing();
  assert.equal(b.ok, true, JSON.stringify(b).slice(0, 300));
  assert.ok(b.forecast && b.forecast.waves.length > 0, 'briefing 要带逐波预测');
  try { api.dispose(); } catch { /* ignore */ }
});
