# PvZ2 Gardendless · AI 草坪指挥官

<p align="center">
  <a href="https://github.com/MuliyStudio/pvz2-ai-gardendless/releases/tag/v0.4.13">
    <img src="https://raw.githubusercontent.com/MuliyStudio/pvz2-ai-gardendless/main/docs/cover-v0.4.13.jpg" alt="PvZ2 Gardendless · AI 草坪指挥官 v0.4.13 封面" width="100%">
  </a>
</p>

> **现行实现（2026-10-30）**：新目录 [`pvz-llm-agent/`](pvz-llm-agent/README.md) 是本项目的唯一入口——LLM 是唯一决策者，代码只给事实 / 执行动作 / 返回真实结果 / 记录计划，**没有本地卡组、自动补卡、策略队列**。旧 `pvz-agent/`、`PvZ-MCP/`、`pvz-ai-agent-mod/` 保留但冻结，不再更新。

让大模型（或 Claude / Cursor / OpenCode 这类 Agent）读取《植物大战僵尸2 花园无尽》的战场，自己决定种什么、种哪一格、什么时候铲掉重种，并自动打完一关。

> 非官方社区项目，与 EA / PopCap / PvZ2 Gardendless 作者无关。仅用于单机体验，请勿用于联机或排行榜。

---

## 目录

- [它能做什么](#它能做什么)
- [两种使用方式](#两种使用方式)
- [下载](#下载)
- [安装模组](#安装模组)
- [内置模型模式（游戏里填 Key）](#内置模型模式游戏里填-key)
- [打法由谁决定](#打法由谁决定)
- [MCP 模式（Claude / Cursor / OpenCode）](#mcp-模式claude--cursor--opencode)
- [常见问题](#常见问题)
- [目录结构 / 自行构建](#目录结构--自行构建)
- [已知限制](#已知限制)
- [更新日志](#更新日志)

---

## 它能做什么

- **自动读状态**：阳光、能量豆、卡槽费用/冷却、5×9 植物与僵尸位置、波次、关卡任务、地形、矿车、传送带。
- **开局先侦察**：选卡界面读取可用植物、关卡任务、世界机制和预计僵尸，由模型自己定一整套作战计划，再自己配卡开局。
- **模型自己动手**：种卡、铲除、同格换植（`replace` 先铲后种，一步完成）、能量豆、矿车、继续、关任务弹窗，全部是模型调工具，脚本不替它做决定。
- **真实结果回传**：每次动作都返回 `ok / code / reason / retryAfter`，以及冷却、阳光、占用、上限；失败不会“自动兜底成功”。
- **计划可回看**：模型用 `pvz_set_plan` 写下的整关计划会一直带在 `state.plan` 里，思考窗也能随时展开看。
- **增量事件**：`pvz_events` 给波次、丢车、植物损失、新威胁、任务紧急、胜负，模型不用每回合全量对比。
- **思考浮窗**：推理原文、工具调用、真实结果、计划、状态摘要分开放，F10 开关。
- **大肥鱼桌宠**：配置页/思考窗点缩小图标收成桌宠，AI 思考/调工具时用打字机气泡同步播报，点桌宠恢复对应窗口；配置页不会被销毁。
- **两种驱动方式**：游戏内直接填 Key 调用模型，或通过 MCP 交给外部 Agent（不需要在游戏里填 Key）。

---

## 两种使用方式

| | 内置模型模式 | MCP 模式 |
| --- | --- | --- |
| 适合 | 想直接玩游戏、不想开别的客户端 | 用 Claude Desktop / Cursor / Cline / OpenCode 等 |
| 模型 | 游戏内浮窗填 OpenAI 兼容接口 | MCP 客户端自带的模型 |
| 需要 API Key | 需要 | 不需要（客户端负责） |
| 需要启动器 | **需要**（解除 CSP + 开调试端口） | 需要启动器开调试端口，但不需要解 CSP |
| 操作入口 | 游戏内浮窗 / F8 | MCP 工具（16 个 `pvz_*`） |

> 两种模式不要同时“开始 AI”，否则会抢操作。

---

## 下载

从 [Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases/latest) 下载：

| 文件 | 内容 | 适合 |
| --- | --- | --- |
| `PvZAI-LLM-Agent-Bundle-v0.1.29.zip` | 模组 ZIP + 启动器 + MCP Server + 配置脚本 + 安装说明 | 第一次用，推荐 |
| `pvz-llm-agent.zip` | 只有 GP-Next 模组（`pack.json` + `scripts/main.js`），**不含启动器** | 已经会装 GP-Next 模组 |

---

## 安装模组

### 方式 A：发布包（推荐）

1. **完全退出游戏**（不是最小化）。
2. 解压 `PvZAI-LLM-Agent-Bundle-v0.1.29.zip`（整个文件夹，别只拿一个 exe）。
3. 双击 `PvZAI_Launcher.exe`。
   - 自动把 `pvz-llm-agent.zip` 装进 GP-Next 并启用（写 `installed/<digest>` + `configuration-state.json`）；
   - 带 9222 调试端口启动游戏；
   - 解除当前游戏页面的 CSP（内置模型模式需要）；
   - 顺手起本地代理 `127.0.0.1:8787`（只有 OpenCode Go 用得到）。
4. 看到“✅ CSP 已绕过”后**保持窗口打开**（可以最小化）。关闭窗口会失去 CSP 绕过和代理。
5. 游戏里按 **F9** → **实验室 → JS Modding** 打开；进入 **模组**，确认 **PvZ LLM Agent** 已勾选，按提示 **应用 / 重启**。
6. 进入任意关卡，右上角出现 **PVZ · AI 指挥** 浮窗，顶部显示「启动器已连接」即安装成功。

### 方式 B：手动导入模组（已有 GP-Next）

1. 下载 `pvz-llm-agent.zip`（不要解压成散文件）。
2. 游戏里按 **F9** → **实验室 → JS Modding**，按提示确认风险并打开。
3. 进入 **模组 → 导入 ZIP**，选择 `pvz-llm-agent.zip`。
4. 勾选 **PvZ LLM Agent**，保存并 **应用 / 重启**。
5. 首次导入含脚本的模组会要求**确认信任**；更新版本后脚本内容变化，也可能需要重新确认。
6. 进关卡，右上角出现浮窗。

> 手动导入方式不会解除 CSP。内置模型模式如果报 `Failed to fetch` / `CSP 阻止`，请改用发布包启动器。模组加载后会显示琥珀色「未检测到启动器」提示卡，点开就是启动器用法。
>
> GP-Next 的模组 ZIP 只认 `pack.json` 和 `scripts/`，不会执行 EXE，所以启动器没法塞进模组包；它必须作为发布包里的独立文件存在。

### 方式 C：源码 / Node 用户

1. 构建：`cd pvz-llm-agent && npm run pack`，产物 `pvz-llm-agent.zip`。
2. 用发布包里的 `PvZAI_Launcher.exe` 启动游戏（或者手动开 9222 并解 CSP）。
3. 模组更新：重新导入 ZIP，或让启动器覆盖安装。
4. 开发用脚本见 [`pvz-llm-agent/README.md`](pvz-llm-agent/README.md)：`npm test` / `npm run build` / `npm run verify` / `npm run acceptance`。

---

## 内置模型模式（游戏里填 Key）

1. 进入关卡（选卡页或战斗中都可以）。
2. 在右上角 **PVZ · AI 指挥** 浮窗里填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 服务商 | `DeepSeek 官方` / `OpenCode Go（本地代理）` / `自定义` | 切换后自动填 API Base 和模型，模型名仍可手改 |
| API Base | `https://api.deepseek.com/v1` | 必须包含 `/v1` |
| 模型 | `deepseek-chat` / `deepseek-flash` | 支持 OpenAI 兼容且支持 tool calling 的接口 |
| API Key | `sk-...` | 默认只保存在内存；勾选“记住 Key”后明文存本机 localStorage |

3. 点 **测试**（发一条 8 token 的请求）确认模型可用。
4. 点 **开始 AI**，或按 **F8**。
5. 浮窗会按模型自己的节奏走完整套流程，底部 `F8 开始 / 停止 · F10 思考窗` 一直可见。
6. 再按 **F8** 或点 **停止** 立即中止；关卡胜负会自动停。

### 勾选项说明

| 勾选 | 作用 |
| --- | --- |
| 记住 Key | 写入本机 localStorage（明文）；不勾选只保存在内存，刷新页面即失效 |
| 流式 | 请求改为 SSE 流式，推理区边生成边显示；服务端不支持时自动退回普通请求 |

### 浮窗操作

- 底部主按钮区：**思考窗**（切换显示/隐藏，同 F10）、**测试连接**、**开始 AI**、**停止**；标题栏右侧 **缩小** 图标收成大肥鱼桌宠。**点桌宠展开 AI 思考窗，思考窗右上角齿轮打开配置页**；配置页缩小时会连同思考窗一起关掉，只留桌宠。思考窗「×」直接关闭、不生成桌宠。
- 界面按钮已图标化（Lucide，ISC），悬停有中文提示；默认模型 `deepseek-flash`、战斗快模型 `deepseek-chat`。
- 标题栏可拖动；鼠标放到窗口**边缘/角落**变缩放光标，按住拖动缩放；标题栏**双击**恢复默认大小和位置。主浮窗和思考窗都支持，大小会记住。
- 浮窗底部有一行 **CSP 自检**：检测到页面 CSP 时会提示，此时模型请求可能被拦截，需要用启动器。
- 如果挡住“一起摇滚吧”或暂停按钮，拖到别处或收起。
- 游戏鼠标被指针锁定时，先按 **Esc** 解锁，再用 **F8**。
- 失败时浮窗只显示真实的 `code / reason`，不会给本地建议。

---

## 打法由谁决定

**没有 `strategy.md`，也没有“本关临时策略”输入框。** 这一版把决策权完全交给模型，文件里不再藏一套打法：

| 以前 | 现在 |
| --- | --- |
| 改 `strategy.md` 影响种植偏好 | 模型读 `pvz_briefing` 自己写计划，用 `pvz_set_plan` 记录 |
| 自动补卡 / 自动升级弱卡 | 不补卡、不改卡；卡组由模型自己 `pvz_choose_deck` 指定 |
| 本地任务队列按规则执行 | 模型每次 `pvz_act` 最多 6 个动作，结果原样回传 |

想影响它的打法，按优先级：

1. **换模型**：tool calling 稳的模型效果差别很大（DeepSeek `deepseek-chat`、OpenCode Go `deepseek-flash` 都测过）。
2. **MCP 模式**：在你自己的 Agent 里写系统提示（比如“阳光卡只放 c0-c2”“这周目优先双发射手”），再让它调 `pvz_*` 工具，比改模组文件灵活。
3. **看计划再纠正**：思考窗的“本关计划”会显示模型自己写的 buildOrder / shovelPolicy，不对就停掉重开一局，或在 MCP 客户端里让它重写计划。

> `pvz_set_plan` 只存不用：模组不会因为计划里写了什么就自动执行，执行永远来自模型的下一个 `pvz_act`。

---

## MCP 模式（Claude / Cursor / OpenCode）

MCP Server 通过本地 CDP 与游戏通信，**不需要在游戏里填 Key，也不需要解除 CSP**。

### 配置

1. 用 `PvZAI_Launcher.exe` 启动游戏（需要它的调试端口和自动装好的模组）。
2. 双击 **`配置MCP.bat`**。它会把 MCP Server 合并进已安装客户端（OpenCode / Claude Desktop / Cursor / Cline）的配置，配置项名 `pvz-llm-agent`；会先备份，不覆盖其它 MCP Server。
   - 需要 Node.js 22+（MCP 用全局 `WebSocket` 连 CDP，无第三方依赖）。
3. 重启 MCP 客户端。
4. 让 Agent 先调用 `pvz_health`，再按下面流程走。

### 推荐流程

```text
pvz_health
  → pvz_briefing（objective：任务/世界/预计僵尸；preparing：deckOptions）
  → pvz_dismiss_objective
  → pvz_set_plan（模型自己写整关计划）
  → pvz_choose_deck → pvz_start_level
  → pvz_state / pvz_events → 决策 → pvz_act（1–6 个动作）→ pvz_wait_until
```

### 主要工具

| 工具 | 作用 |
| --- | --- |
| `pvz_briefing` | 开局全量事实：任务、世界、地形、波次、僵尸、卡池、卡槽、植物上限 |
| `pvz_knowledge` | 植物/僵尸/本关图鉴与数值，支持 `type` / `query` |
| `pvz_state` | 阳光/能量豆、卡槽、植物、僵尸、波次、任务、`board` 棋盘、`world`、`plan`、`changesSinceLast` |
| `pvz_events` | 增量事件：波次、丢车、植物损失、新威胁、任务紧急、胜负 |
| `pvz_set_plan` | 记录模型写的整关计划（只存不执行） |
| `pvz_choose_deck` | 指定卡组；只校验 + 执行，不补卡、不改卡 |
| `pvz_start_level` | 关任务弹窗 + 开局，轮询到 `running` |
| `pvz_act` | `plant / replace / shovel / plant_food / move_cart / resume / wait / dismiss_objective / collect` |
| `pvz_wait_until` | 等阳光/冷却/僵尸进某行/任务完成等条件 |
| `pvz_collect` / `pvz_plant_food` / `pvz_move_cart` / `pvz_resume` / `pvz_dismiss_objective` | 收掉落物 / 能量豆 / 矿车 / 暂停恢复 / 关任务说明 |
| `pvz_restart` | 重开本关（不用先进暂停菜单），回到选卡阶段 |
| `pvz_health` | 检查模组和 Server 版本、能力、缺失工具 |

完整参数、返回值和错误码见 **[pvz-llm-agent/docs/tool-contract.md](pvz-llm-agent/docs/tool-contract.md)**；发布包里是 `MCP工具契约.md`。

---

## 常见问题

### 浮窗没出现？

按 **F9** → 模组 → **PvZ LLM Agent** → 官方控制面板。如果官方面板也没有，检查 JS Modding 是否打开、模组是否启用并应用、是否需要重新确认信任。

### 浮窗点不动 / 收不起来 / 像卡死？

1. 确认装的是 `pvz-llm-agent.zip`（旧 `pvz-ai-agent.zip` 不要一起启用）。
2. 完全重启游戏，让 GP-Next 重新加载脚本；脚本变化后如提示信任请重新确认。
3. 仍然异常：按 F9 看模组详情里的错误信息，或把浮窗 `lastError` / 日志发出来。

### 提示 `Failed to fetch` / `CSP 阻止`？

内置模型模式必须用启动器启动游戏。直接双击游戏 EXE 不会解除 CSP。MCP 模式不需要解除 CSP，但仍需要启动器开调试端口。

### AI 一轮只发一个动作 / 向日葵少了不补 / 救急来不及？

0.1.22 修了这三类问题：

- 批量种植原来逐株等 1.5 秒落地，一轮 6 个动作能拖到 9 秒；现在全部发起后统一等一次。prompt 也明确「不同卡种到不同格、补阳光、给豆、移车、收豆可以同轮发」。
- state 新增 `plants[].family` 和 `lanes[].sunProducers`，prompt 要求经济明显不足或某行 0 株时优先补向日葵/双子向日葵，并按 `changesSinceLast.plantsLost` 补回空位。
- 新增 `zombies[].speed / etaToHouse`；种植结果带 `timing.late`。僵尸进 c4 就该准备救急，落点放在它左边 1–2 格；`late=true` 说明动作落地时它已经过去了，下一轮往左移。

### AI 不用能量豆？

0.1.22 之前有两个真实问题，不是模型"不懂机制"：

- `plant_food` 调的是 `p.doPlantFood()`，而游戏里只有 `p.food()`。调用不会报错，但什么也不会发生，还返回 `ok:true`、不扣豆。
- `pvz_state.plants` 没有 `foodable`，模型不知道哪株能吃豆；同一格有花盆/睡莲时还可能选错目标。

现在每株植物都带 `foodable`，`plant_food` 只挑已经落地、能吃豆的植物，成功返回剩余豆数 `foodLeft`。如果仍然不用，先看 `plantFood` 是不是 0（能量豆靠打僵尸掉落，自动收取），再看 prompt 里的使用条件是否被满足。

### 浮窗顶部显示「未检测到启动器」？

说明游戏不是由 `PvZAI_Launcher.exe` 启动的（或者启动器窗口已经关了）。内置模型模式的「测试」会因此失败。处理：完全退出游戏 → 双击发布包里的启动器 → 等它显示“✅ CSP 已绕过”再进关卡；浮窗状态卡会变成绿色「启动器已连接」。如果用启动器启动后仍然显示未连接，通常是没有重载页面，重启游戏一次即可。

### 401 / 403 / 模型不存在？

Key 错误、Base URL 少了 `/v1`、模型名不对，或中转不兼容。先用 **测试** 确认。

### OpenCode Go 连不上？

它需要本地代理：启动器会自动在 `127.0.0.1:8787` 起代理；不开启动器可以手动 `node pvz-llm-agent/scripts/local-proxy.mjs`。另外要在 OpenCode Console → Settings → Privacy → Regions 选 **Global**，否则 DeepSeek 会被上游拒绝。

模型名只认 **`deepseek-flash`** 和 **`deepseek-v4-pro`**。写成别的（例如 `deepseek-v4.1-flash`）上游会直接返回 `invalid_request_error: the supported API model names are deepseek-flash, deepseek-v4-pro`，浮窗里显示就是 `连接失败 LLM_HTTP`。

### AI 不种 / 一直等？

看思考窗和 `code`：可能阳光不够、所有卡在冷却、任务限制植物数量，或当前关卡类型不支持（`mechanics.supported=false`）。MCP 模式可以 `pvz_state` 看 `limits` 和 `shovelCandidates`。

### AI 说「本关最多 18 株」，但这关根本没有这个限制？

引擎会在场景里常驻一个**未初始化**的任务模板，它的默认文案就是 `Never have more than 18 plants`。0.1.11 之前这段模板文本会漏进 `pvz_state.objective.missions`，模型读到就当成本关规则。现在模板的 `missions` 一律清空，判断有没有上限只看 `plantLimit`（`null` = 无上限）。升级模组并重启游戏即可。

### 内置模式和 MCP 模式能一起用吗？

不要同时“开始”。会抢种植/铲除操作。收阳光和能量豆是共享的。

### 支持哪些关卡？

标准种子卡槽关卡支持最好，传送带关卡已支持。砸罐、保龄球、天空关和部分特殊小游戏可能无法操作。

---

## 目录结构 / 自行构建

```text
pvz-llm-agent/          GP-Next 模组 + MCP Server + 游戏内浮窗（唯一入口）
  bridge/               只读状态 / 执行动作 / 发事件 / 存计划
  tools/                16 个工具的 Schema、router、错误码、wait、格式化
  mcp/                  stdio MCP Server（CDP 传输）
  in-game/              提示词、tool calling 循环、浮窗 UI
  knowledge/            世界机制 + 从游戏数据生成的静态图鉴
  scripts/              构建、打包、真机验收、整局观察、本地代理
  pack/                 pack.json + 构建产物
dist/                   发布包构建产物（已忽略）
PvZ-MCP/                旧 MCP Server（冻结，仅存档）
tools/                  打包、启动器源码、MCP 配置、CDP 调试脚本
配置MCP.bat             一键写 MCP 配置（需要 Node 22+）
CHANGELOG.md            更新日志
```

构建模组 ZIP：

```bash
cd pvz-llm-agent
npm run pack        # -> pvz-llm-agent.zip（pack.json 在 ZIP 根目录）
```

构建完整发布包（模组 + 启动器 + MCP + 配置脚本 + 文档）：

```bash
python tools/build_bundle.py              # 全量：重建模组 + 重新编译启动器 + 打 ZIP
python tools/build_bundle.py --skip-mod   # 复用现有 pvz-llm-agent.zip
python tools/build_bundle.py --skip-exe   # 不重新编译启动器
# -> dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip
```

启动器单独编译（C# / .NET Framework 4.8，随 Windows 自带）：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /platform:anycpu /optimize+ /codepage:65001 `
  /out:"dist\PvZAI_Launcher.exe" `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll tools\PvZAI_Launcher.cs
```

> 路径里带中文时，`csc` 在源码目录原地编译可能报 `CS1567`；`build_bundle.py` 会先复制到 ASCII 临时目录再编译。

---

## 已知限制

- 适用 **PvZ2 Gardendless 0.16.x + GP-Next 1.5.x**（`gpNextVersion: >=1.5.2 <1.6.0`）；游戏大版本更新后内部字段可能变化。
- 标准种子卡槽 / 传送带关卡支持较好；砸罐、保龄球、天空关、部分特殊小游戏可能无法种植。
- 内置模型模式需要启动器解除 CSP；MCP 模式不需要解 CSP，但需要启动器开 9222。
- MVP 只支持 OpenAI 兼容且支持 tool calling 的模型；MCP 只走 stdio，HTTP 未实现。
- 图鉴来自游戏内 almanac，是机制说明，不是完整物理模拟器。
- 会产生模型费用。决策节奏由模型自己掌握，慢模型会明显拖长一局。
- 单机向，请勿用于联机或排行榜。

## 更新日志

当前版本：**模组 0.1.29 + 启动器 1.0.1**（大肥鱼桌宠 + 图标化配置页 + 数据完整性/能量豆策略）。

> v0.2.x / v0.3.x 的旧发布（`pvz-ai-agent-mod` 时代）已归档为 Pre-release，只作存档，不再更新；下载请用 [v0.4.13+](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases/latest)。

完整版本记录见 **[CHANGELOG.md](CHANGELOG.md)**；逐版本实现细节另见 **[pvz-llm-agent/CHANGELOG.md](pvz-llm-agent/CHANGELOG.md)**。

## License

MIT。游戏本体、素材和 PvZ2 Gardendless 版权归其作者/权利方所有；本仓库不包含游戏资源。
