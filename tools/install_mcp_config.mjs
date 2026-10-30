#!/usr/bin/env node
/**
 * 一键把 PvZ MCP Server 写入常见 MCP 客户端配置。
 *
 * 用法：
 *   node tools/install_mcp_config.mjs --dry-run
 *   node tools/install_mcp_config.mjs --all
 *   node tools/install_mcp_config.mjs --target=claude
 *   node tools/install_mcp_config.mjs --target=cursor
 *   node tools/install_mcp_config.mjs --target=cursor-project
 *   node tools/install_mcp_config.mjs --target=claude-code
 *   node tools/install_mcp_config.mjs --target=cline
 *
 * 特性：
 *  - 只合并 mcpServers.pvz-gardendless，不覆盖其它 MCP Server；
 *  - 写之前自动备份 .bak-时间戳；
 *  - 现有 JSON 解析失败时拒绝写入，避免弄坏配置；
 *  - Windows 下 Claude Desktop 配置在 %APPDATA%\Claude\claude_desktop_config.json。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PORT = process.env.PVZ_CDP_PORT || '9222';

// 两种目录结构都支持：
//   发布包：<根>/mcp/server.mjs + <根>/tools/*.js（本脚本在 tools/ 里）
//   源码仓：<根>/PvZ-MCP/pvz-mcp-server.mjs
const CANDIDATES = [
  path.join(ROOT, 'mcp', 'server.mjs'),
  path.join(ROOT, 'PvZ-MCP', 'pvz-mcp-server.mjs'),
];
const SERVER = CANDIDATES.find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || CANDIDATES[0];
const NAME = path.basename(path.dirname(SERVER)) === 'mcp' ? 'pvz-llm-agent' : 'pvz-gardendless';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const targetArg = args.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : null;

function home(...p) { return path.join(os.homedir(), ...p); }
function appData(...p) { return path.join(process.env.APPDATA || home('AppData', 'Roaming'), ...p); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const ENTRY = {
  command: NODE,
  args: [SERVER],
  env: { PVZ_CDP_PORT: PORT },
};

const TARGETS = {
  claude: {
    label: 'Claude Desktop',
    path: appData('Claude', 'claude_desktop_config.json'),
    installDir: appData('Claude'),
  },
  cursor: {
    label: 'Cursor（全局）',
    path: home('.cursor', 'mcp.json'),
    installDir: home('.cursor'),
  },
  'cursor-project': {
    label: 'Cursor（当前项目）',
    path: path.join(ROOT, '.cursor', 'mcp.json'),
    installDir: path.join(ROOT, '.cursor'),
  },
  'claude-code': {
    label: 'Claude Code（当前项目 .mcp.json）',
    path: path.join(ROOT, '.mcp.json'),
    installDir: ROOT,
  },
  opencode: {
    label: 'OpenCode',
    path: home('.config', 'opencode', 'opencode.jsonc'),
    altPath: home('.config', 'opencode', 'opencode.json'),
    installDir: home('.config', 'opencode'),
    kind: 'opencode',
  },
  cline: {
    label: 'Cline（VS Code 扩展）',
    path: appData('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    installDir: appData('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings'),
  },
};

function readJson(file) {
  if (!exists(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function backup(file) {
  if (!exists(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = file + '.bak-' + stamp;
  fs.copyFileSync(file, bak);
  return bak;
}

function writeTarget(key) {
  const t = TARGETS[key];
  if (!t) throw new Error('未知目标：' + key);
  if (!exists(path.dirname(t.path)) && !exists(t.installDir)) {
    return { key, label: t.label, skipped: true, reason: '客户端目录不存在' };
  }
  if (!exists(SERVER)) {
    return { key, label: t.label, skipped: true, reason: '找不到 MCP Server：' + SERVER };
  }
  const file = (!exists(t.path) && t.altPath && exists(t.altPath)) ? t.altPath : t.path;
  let config;
  try {
    config = readJson(file);
  } catch (e) {
    return { key, label: t.label, skipped: true, reason: '现有配置不是合法 JSON，已拒绝写入：' + e.message + '（请手动合并，或把配置发我）' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (t.kind === 'opencode') {
    if (!config.mcp || typeof config.mcp !== 'object') config.mcp = {};
    config.mcp[NAME] = {
      type: 'local',
      command: [NODE, SERVER],
      enabled: true,
    };
  } else {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
    config.mcpServers[NAME] = ENTRY;
  }
  const text = JSON.stringify(config, null, 2) + '\n';
  if (dryRun) return { key, label: t.label, path: file, dryRun: true, preview: text };
  const bak = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return { key, label: t.label, path: file, backup: bak };
}

function main() {
  console.log('MCP Server：' + SERVER);
  console.log('Node：' + NODE);
  console.log('模式：' + (dryRun ? 'dry-run（不写入）' : '写入'));
  console.log('');

  if (!exists(SERVER)) {
    console.error('❌ 找不到 MCP Server，请确认目录结构完整（mcp/server.mjs 或 PvZ-MCP/pvz-mcp-server.mjs）。');
    process.exit(1);
  }

  const keys = target ? [target] : (all ? Object.keys(TARGETS) : ['opencode', 'claude', 'cursor', 'cursor-project']);
  for (const key of keys) {
    try {
      const r = writeTarget(key);
      if (r.skipped) {
        console.log('⏭  ' + r.label + '：跳过（' + r.reason + '）');
      } else if (r.dryRun) {
        console.log('📝 ' + r.label + '：将写入 ' + r.path);
        console.log(r.preview);
      } else {
        console.log('✅ ' + r.label + '：已写入 ' + r.path);
        if (r.backup) console.log('   备份：' + r.backup);
      }
    } catch (e) {
      console.log('❌ ' + (TARGETS[key] ? TARGETS[key].label : key) + '：' + (e && e.message ? e.message : e));
    }
  }

  console.log('');
  console.log('下一步：');
  console.log('  1. 完全退出并重启对应的 MCP 客户端（OpenCode / Claude Desktop / Cursor / Cline）。');
  console.log('  2. 用 PvZAI_Launcher.exe 启动游戏（会开 9222 调试端口，并自动装好模组）。');
  console.log('  3. 进关卡，让 Agent 先调用 pvz_health，再 pvz_briefing → pvz_set_plan → pvz_choose_deck → pvz_start_level。');
  console.log('');
  if (dryRun) console.log('这是 dry-run，没有修改任何文件。去掉 --dry-run 才会写入。');
}

main();
