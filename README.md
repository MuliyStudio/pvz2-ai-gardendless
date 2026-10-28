# PvZ2 Gardendless · AI 草坪指挥官

让大模型（或 Claude / Cursor / OpenCode 这类 Agent）读取《植物大战僵尸2 花园无尽》的战场，自己决定种什么、种哪一格、什么时候铲掉重种，并自动打完一关。

> 非官方社区项目，与 EA / PopCap / PvZ2 Gardendless 作者无关。仅用于单机体验，请勿用于联机或排行榜。

![thumbnail](pvz-ai-agent-mod/thumbnail.png)

---

## 目录

- [它能做什么](#它能做什么)
- [两种使用方式](#两种使用方式)
- [下载](#下载)
- [安装模组](#安装模组)
- [内置模型模式（游戏里填 Key）](#内置模型模式游戏里填-key)
- [修改策略（重点）](#修改策略重点)
- [MCP 模式（Claude / Cursor / OpenCode）](#mcp-模式claude--cursor--opencode)
- [常见问题](#常见问题)
- [目录结构 / 自行构建](#目录结构--自行构建)
- [已知限制](#已知限制)
- [更新日志](#更新日志)

---

## 它能做什么

- **自动读状态**：阳光、卡槽费用/冷却、5×9 植物与僵尸位置、波次、关卡任务、地形、矿车、传送带。
- **开局先侦察**：选卡界面读取可用植物、关卡任务、世界机制和预计僵尸，先生成一整套作战计划，再自动配卡开局。
- **自动种植 / 铲除 / 换卡**：按照计划补经济、补输出、补防御；种错或太弱的植物会 `shovel`，同格升级用 `replace`（先铲后种，一步完成）。
- **任务优先**：限时击杀、植物损失上限、植物数量上限、阳光预算等任务会进入提示词，任务失败通常直接判负。
- **位置理解**：每回合给模型一张 5×9 文字棋盘和“空位建议”；明显浪费的落点（例如地刺种在坚果后面）直接拒绝并给出可改种格子。
- **思考浮窗**：实时显示 AI 当前阶段、耗时、`thought`、动作结果、作战计划和最近几回合思考；支持 F10 开关。
- **两种驱动方式**：游戏内直接填 Key 调用模型，或通过 MCP 交给外部 Agent（不需要在游戏里填 Key）。

---

## 两种使用方式

| | 内置模型模式 | MCP 模式 |
| --- | --- | --- |
| 适合 | 想直接玩游戏、不想开别的客户端 | 用 Claude Desktop / Cursor / Cline / OpenCode 等 |
| 模型 | 游戏内浮窗填 OpenAI 兼容接口 | MCP 客户端自带的模型 |
| 需要 API Key | 需要 | 不需要（客户端负责） |
| 需要启动器 | **需要**（解除 CSP + 开调试端口） | 需要启动器开调试端口，但不需要解 CSP |
| 操作入口 | 游戏内浮窗 / 快捷键 | MCP 工具（`pvz_*`） |

> 两种模式不要同时启动，否则会抢操作。自动收阳光 / 能量豆可以共用。

---

## 下载

从 [Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases/latest) 下载：

| 文件 | 内容 | 适合 |
| --- | --- | --- |
| `PvZAI-AI-Agent-Bundle.zip` | 模组 ZIP + 启动器 + MCP Server + 配置脚本 | 第一次用，推荐 |
| `pvz-ai-agent.zip` | 只有 GP-Next 模组（含 `strategy.md`） | 已经会装 GP-Next 模组 |

---

## 安装模组

### 方式 A：发布包（推荐）

1. **完全退出游戏**（不是最小化）。
2. 解压 `PvZAI-AI-Agent-Bundle.zip`。
3. 双击 `PvZAI_Launcher.exe`。
   - 自动把模组安装/更新到 GP-Next 的 `packs` 目录；
   - 带调试端口启动游戏；
   - 解除当前游戏页面的 CSP（内置模型模式需要）。
4. 看到黑窗口提示后**保持窗口打开**（可以最小化）。关闭窗口会失去 CSP 绕过。
5. 游戏里按 **F9** → **实验室 → JS Modding** 打开；进入 **模组**，勾选 **AI 草坪指挥官**，按提示 **应用 / 重启**。
6. 进入任意关卡，右上角出现浮窗即安装成功。

### 方式 B：手动导入模组（已有 GP-Next）

1. 下载 `pvz-ai-agent.zip`（不要解压成散文件）。
2. 游戏里按 **F9** → **实验室 → JS Modding**，按提示确认风险并打开。
3. 进入 **模组 → 导入 ZIP**，选择 `pvz-ai-agent.zip`。
4. 勾选 **AI 草坪指挥官**，保存并 **应用 / 重启**。
5. 首次导入含脚本的模组会要求**确认信任**；更新版本后脚本内容变化，也可能需要重新确认。
6. 进关卡，右上角出现浮窗。

> 手动导入方式不会解除 CSP。内置模型模式如果报 `Failed to fetch` / `CSP 阻止`，请改用发布包启动器，或使用 `启动游戏-AI修复.bat`（需要 Node.js）。

### 方式 C：源码 / Node 用户

1. 安装 Node.js 18+。
2. 双击仓库根目录的 `启动游戏-AI修复.bat`。
3. 它会启动游戏、开调试端口并解除 CSP；保持黑窗口打开。
4. 模组更新：把 `pvz-ai-agent-mod/` 下的文件同步到 `%APPDATA%\com.pvzge.game\gp-next\packs\pvzai.agent\`，或重新导入 `pvz-ai-agent.zip`。

---

## 内置模型模式（游戏里填 Key）

1. 进入关卡（选卡页或战斗中都可以）。
2. 在右上角浮窗里填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| API Base URL | `https://api.deepseek.com/v1` | 必须包含 `/v1` |
| 模型名 | `deepseek-chat` / `deepseek-flash` | 支持 OpenAI 兼容接口 |
| API Key | `sk-...` | 默认只保存在内存；勾选“记住”后明文存本机 localStorage |

3. 点 **测试连接**，确认模型可用。
4. 点 **开始操控**，或按 **F8**。
5. 浮窗会收起为右下角胶囊，显示阳光 / 波次；点胶囊可展开。
6. 左下角 **🧠 AI 思考** 浮窗（**F10** 显示/隐藏）会实时显示 AI 在想什么、执行了什么、结果如何。
7. 再按 **F8** 停止；关卡胜利/失败会自动停止。

### 勾选项说明

| 勾选 | 作用 |
| --- | --- |
| 自动收阳光/能量豆 | 定期收取掉落物 |
| 自动选卡开局 | 选卡阶段按作战计划选卡并点“一起摇滚吧” |
| 自动铲换弱卡 | 模型没理会候选时，自动执行 1 次“明显该换”的 replace/铲除（6 秒冷却，保留阳光余量） |
| 显示思考浮窗 | 与 F10 相同 |
| 流式思考（更快） | 请求改为 SSE 流式，思考窗边生成边显示；服务端不支持时自动退回普通请求 |
| 本地策略（不调用模型） | 不填 Key 也能测试自动收阳光/种植，使用内置规则 |

### 浮窗操作

- 主浮窗右上角 **—** 收起，右下角胶囊点一下展开。
- 浮窗标题栏可拖动。如果挡住“一起摇滚吧”或暂停按钮，拖到别处或收起。
- 游戏鼠标被指针锁定时，先按 **Esc** 解锁，再用 **F8**。
- 主浮窗里的 **默认策略（strategy.md）** 显示默认策略加载状态，并可以“重新读取 strategy.md”。

---

## 修改策略（重点）

策略分为**两层**，互相独立：

| 层 | 在哪改 | 生效范围 | 是否持久化 |
| --- | --- | --- | --- |
| 默认策略 | 模组目录的 `strategy.md` | 所有关卡 | 文件本身 |
| 本关临时策略 | 🧠 AI 思考浮窗底部输入框 | **仅当前关卡** | 只在内存，换关清空 |

### 1. 默认策略 `strategy.md`（所有关卡）

这是模型的“决策原则”，不是代码。用任意文本编辑器打开：

- **安装版**：`%APPDATA%\com.pvzge.game\gp-next\packs\pvzai.agent\strategy.md`
- **ZIP 版**：解压后的 `strategy.md`（与 `pack.json` 同级）
- **源码版**：`pvz-ai-agent-mod/strategy.md`

规则：

- 直接改正文即可；`#` 开头的行是注释，不会发给模型。
- 改完保存，在游戏主浮窗的 **默认策略（strategy.md）** 里点 **“重新读取 strategy.md”**，下一回合生效，不用重启游戏。
- 文件不存在、为空、或旧版 GP-Next 不支持 `ctx.files` 时，会自动使用脚本内置的默认策略。
- 建议保留 `.md` 文件名；同时支持 `strategy.txt` / `config/strategy.md` / `scripts/strategy.md`。

适合写进默认策略的内容：

```text
1. 阳光生产者永远放 c0-c2。
2. 地刺放 c5-c7，且必须在坚果前面。
3. 这周目优先用双发射手，不用豌豆射手。
4. 有巨人时把能量豆留给高坚果。
```

### 2. 本关临时策略（只影响当前关卡）

在 **🧠 AI 思考** 浮窗底部输入，例如：

```text
这关地刺放 c6，先补双发
别种坚果，多铺地刺
第 3 排压力大，优先补寒冰射手
```

- 回车（Shift+回车换行）或点 **“发送并思考”**。
- 内容会和实时关卡状态一起进入下一次模型请求，并**立即触发一次决策**，不用等下一个决策间隔。
- **只对当前关卡生效**：不写 `strategy.md`，不写 localStorage；换关自动清空，点“清除”也会清掉。
- 之后的同一关每回合仍会带上它；如果不希望继续生效，点“清除”。

优先级：

```text
本关临时策略  >  strategy.md  >  脚本内置默认
```

> 不要为了改策略去改 `scripts/main.js`。脚本里保留了一份默认策略只作为 `strategy.md` 丢失时的回退；日常改 `strategy.md` 就够了。

---

## MCP 模式（Claude / Cursor / OpenCode）

MCP Server 通过本地 CDP 与游戏通信，**不需要在游戏里填 Key，也不需要解除 CSP**。

### 配置

1. 用 `PvZAI_Launcher.exe` 启动游戏（需要它的调试端口和模组加载）。
2. 双击 **`配置MCP.bat`**。它会把 MCP Server 合并进已安装客户端（Claude Desktop / Cursor / Cline / OpenCode 等）的配置；会先备份，不覆盖其它 MCP Server。
   - 需要 Node.js 18+。
3. 重启 MCP 客户端。
4. 让 Agent 先调用 `pvz_rules`，再按下面流程走。

### 推荐流程

```text
pvz_briefing（objective 阶段：任务/世界/预计僵尸）
  → pvz_dismiss_objective
  → pvz_briefing（选卡界面：拿 deckOptions）
  → pvz_set_plan（记录整关计划）
  → pvz_choose_deck → pvz_start_level
  → pvz_state → 决策 → pvz_act{plant|replace|shovel|plant_food} → pvz_state
```

### 主要工具

| 工具 | 作用 |
| --- | --- |
| `pvz_briefing` | 开局简报：任务原文、任务要点、预计僵尸（图鉴/标签/应对）、地形/机制、可选卡组、推荐卡组、世界信息 |
| `pvz_set_plan` | 记录本关作战计划（goal/threats/counters/deck/buildOrder/shovelPolicy），之后 `state.plan` 一直带着 |
| `pvz_state` | 阳光/能量豆、卡槽费用冷却、植物、僵尸、波次、任务、`board` 棋盘、`world`、可铲候选 |
| `pvz_knowledge` | 查询植物/僵尸真实图鉴 |
| `pvz_plant` | 种卡（原生扣阳光、冷却、每行上限） |
| `pvz_act` | 一次最多 6 个动作，支持 `replace` 先铲后种 |
| `pvz_shovel` | 铲除植物；可传 `expect` 防铲错 |
| `pvz_wait_until` | 等阳光/冷却/僵尸进某行/任务完成等条件 |
| `pvz_collect` / `pvz_plant_food` / `pvz_move_cart` / `pvz_resume` | 收掉落物 / 能量豆 / 矿车 / 暂停恢复 |
| `pvz_choose_deck` / `pvz_start_level` / `pvz_dismiss_objective` | 选卡 / 开局 / 关闭任务说明 |
| `pvz_health` | 检查模组和 Server 版本、关键能力、缺失工具 |

完整参数、返回值和错误码见 **[PvZ-MCP/README.md](PvZ-MCP/README.md)**。

---

## 常见问题

### 浮窗没出现？

按 **F9** → 模组 → **AI 草坪指挥官** → 官方控制面板。如果官方面板也没有，检查 JS Modding 是否打开、模组是否启用并应用、是否需要重新确认信任。

### 浮窗点不动 / 收不起来 / 像卡死？

1. 确认版本是 **v0.3.5 或更新**（v0.3.2 有一个 UI 初始化报错会导致按钮全部失效，已在 v0.3.3 修复）。
2. 完全重启游戏，让 GP-Next 重新加载脚本；脚本变化后如提示信任请重新确认。
3. 如果仍然异常：按 F9 看模组详情里的错误信息，或把 `复制日志` 的内容发出来。

### 提示 `Failed to fetch` / `CSP 阻止`？

内置模型模式必须用启动器启动游戏（`PvZAI_Launcher.exe` 或 `启动游戏-AI修复.bat`）。直接双击游戏 EXE 不会解除 CSP。MCP 模式不需要解除 CSP，但仍需要启动器开调试端口。

### 401 / 403 / 模型不存在？

Key 错误、Base URL 少了 `/v1`、模型名不对，或中转不兼容。先用“测试连接”确认。

### AI 不种 / 一直等？

看日志和思考浮窗：可能阳光不够、所有卡在冷却、任务限制植物数量，或当前关卡类型不支持。点“导出状态”保存快照（含 `plan / board / shovelCandidates / world`）便于排查。

### 策略文件改了没生效？

- 确认改的是**安装目录**里的 `strategy.md`，不是 ZIP 里的。
- 点主浮窗 **默认策略（strategy.md）→ 重新读取 strategy.md**。
- 如果状态显示“未找到 / 不支持读取”，会使用脚本内置默认；检查 GP-Next 版本是否支持 `ctx.files`。
- 本关临时策略不会写回文件；换关后需要重新输入。

### 内置模式和 MCP 模式能一起用吗？

不要同时启动。会抢种植/铲除操作。自动收阳光和能量豆是共享的。

### 支持哪些关卡？

标准种子卡槽关卡支持最好，传送带关卡已支持。砸罐、保龄球、天空关和部分特殊小游戏可能无法操作，状态里 `mechanics.supported=false` 时会停止尝试种植。

---

## 目录结构 / 自行构建

```text
pvz-ai-agent-mod/       GP-Next 模组源码（pack.json / strategy.md / scripts/main.js）
PvZ-MCP/                MCP Server（无第三方依赖）
tools/                  打包、启动器、MCP 配置、CDP 调试脚本
配置MCP.bat             一键写 MCP 配置（需要 Node）
启动游戏-AI修复.bat      Node 版启动器（源码用户）
changed.md              更新日志
```

构建模组 ZIP：

```bash
python tools/build_zip.py
# 生成 pvz-ai-agent.zip（pack.json 在 ZIP 根目录，含 strategy.md）
```

构建发布包：

```bash
python tools/pack_distribution.py
# 打包 PvZAI-发布包/ 为 PvZAI-AI草坪指挥官-发布包.zip
```

独立启动器（C# / .NET Framework 4.8）：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /platform:anycpu /optimize+ /codepage:65001 `
  /out:"PvZAI-发布包\PvZAI_Launcher.exe" `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll tools\PvZAI_Launcher.cs
```

---

## 已知限制

- 适用 **PvZ2 Gardendless 0.16.x + GP-Next 1.5.x**；游戏大版本更新后内部字段可能变化。
- 标准种子卡槽 / 传送带关卡支持较好；砸罐、保龄球、天空关、部分特殊小游戏可能无法种植。
- 图鉴来自游戏内 almanac，是机制说明，不是完整物理模拟器。
- 内置模型模式需要启动器解除 CSP；MCP 模式不需要解 CSP。
- 会产生模型费用。决策间隔默认 1600ms，可在浮窗调整（600–15000ms）。
- 单机向，请勿用于联机或排行榜。

## 更新日志

当前版本：**v0.3.5**（默认策略文件化 + 本关临时策略 + 思考浮窗）。

完整版本记录见 **[changed.md](changed.md)**；发布包与历史版本见 [Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases)。

## License

MIT。游戏本体、素材和 PvZ2 Gardendless 版权归其作者/权利方所有；本仓库不包含游戏资源。
