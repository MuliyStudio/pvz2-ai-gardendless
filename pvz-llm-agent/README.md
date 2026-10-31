# pvz-llm-agent

《植物大战僵尸2 花园无尽》的 **LLM 工具层**。

**LLM 是唯一决策者。** 代码只做四件事：

1. **给事实**：关卡、任务、世界机制、地形、波次、僵尸、卡池、图鉴、实时状态、增量事件。
2. **执行动作**：选卡、开局、种植、铲除、换植、能量豆、矿车、继续、关闭任务弹窗。
3. **返回真实结果**：`ok / code / reason / retryAfter`、冷却、阳光、占用、上限。
4. **记录计划**：`pvz_set_plan` 只保存 LLM 自己写的计划，不执行、不修正。

**本目录没有：** `autoDeck`、`suggestDeck`、`setStrategy`、本地任务队列、卡组修正、LLM 不可用时的本地接管。

> 需求基线：[`../pvz-llm-agent-需求文档.md`](../pvz-llm-agent-需求文档.md)

---

## 目录

- [结构](#结构)
- [安装（游戏内）](#安装游戏内)
- [使用方式 A：游戏内浮窗](#使用方式-a游戏内浮窗)
- [使用方式 B：MCP](#使用方式-bmcp)
- [工具契约](#工具契约)
- [选卡修复](#选卡修复)
- [思考窗](#思考窗)
- [开发与测试](#开发与测试)
- [真机验收](#真机验收)
- [已知限制](#已知限制)

---

## 结构

```text
pvz-llm-agent/
  bridge/             游戏内那一层：只读状态 / 执行动作 / 发事件 / 存计划
    stats.js          植物/僵尸/护甲/关卡脚本/图鉴
    snapshot.js       snapshot()、任务、地形、棋盘、机制、矿车
    actions.js        act/actAll/chooseDeck/startLevel/moveCart/resume
    briefing.js       briefing() / knowledge()
    events.js         增量事件 + 去抖
    plan.js           setPlan/getPlan（只存）
    api.js            window.PvzLlm
  tools/
    definitions.js    16 个工具的 JSON Schema（MCP 与游戏内共用）
    errors.js         结构化错误码
    router.js         工具名 → handler
    wait.js           wait_until 条件解析
    format.js         思考窗的人话格式化
  mcp/
    cdp.js            WebView2 CDP 传输
    protocol.js       MCP stdio JSON-RPC
    server.mjs        MCP 入口
  in-game/
    prompt.js         系统提示词（不写打法）
    agent.js          OpenAI 兼容 tool calling 循环
    ui.js             浮窗 + 思考窗 + 桌宠
    pet-sprites.js    桌宠图集（由 build-pet-sprites.mjs 生成的内联 base64）
    pet/              桌宠源图与素材说明
    setup.js          游戏内入口
  knowledge/
    worlds.js         世界机制事实（不含打法）
    data/             从游戏数据生成的静态图鉴（植物/僵尸）
  scripts/
    build.mjs         打游戏内 bundle
    build-pack.mjs    打 GP-Next 可导入 zip
    build-pet-sprites.mjs 裁桌宠图集并生成内联 base64
    build-knowledge.mjs 从 game code 生成静态图鉴
    verify-live.mjs   真机契约检查
    acceptance.mjs    验收采样
    live-play.mjs     观察一整局（不替 LLM 决策）
  tests/              node --test（离线，假游戏）
  pack/               pack.json + 构建产物
```

---

## 安装（游戏内）

### 方式 A：发布包（推荐）

`dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip` 是给玩家的完整包，解压后一个文件夹里同时有：

```text
PvZAI_Launcher.exe    启动器：装模组 + 开 9222 + 解 CSP + 本地代理 8787
pvz-llm-agent.zip     模组本体（不要手动导入，必须由启动器安装/启动）
配置MCP.bat           一键写 MCP 客户端配置（需要 Node.js 22+）
mcp/ + tools/         MCP Server 与它依赖的工具模块
安装说明.txt           玩家向的中文步骤说明
MCP工具契约.md         16 个 pvz_* 工具的参数/返回值/错误码
```

双击 `PvZAI_Launcher.exe` 即可，细节见 `安装说明.txt`。

> **手动导入 ZIP 用不了：必须用 `PvZAI_Launcher.exe` 启动游戏。** 只导入 ZIP 拿不到 CSP 绕过、9222 和本地代理，AI 连不上。

自己打这个包：

```bash
python tools/build_bundle.py              # 重新构建模组 + 重新编译启动器 + 打包
python tools/build_bundle.py --skip-mod   # 复用现有 pvz-llm-agent.zip
python tools/build_bundle.py --skip-exe   # 不重新编译启动器
```

### 方式 B：只要模组 ZIP

1. 构建：

```bash
cd pvz-llm-agent
npm run pack
```

产物：`pvz-llm-agent.zip`。

2. 游戏里 `F9` → 模组 → 导入 zip → 启用 **PvZ LLM Agent** → 应用/重启。
3. 用 **`PvZAI_Launcher.exe`**（或 `启动游戏-AI修复.bat`）启动游戏：
   - 游戏内浮窗模式需要启动器解除 WebView2 CSP，否则模型请求会 `Failed to fetch`；
   - MCP 模式只需要启动器打开 9222 调试端口。
   - 浮窗顶部会显示「启动器已连接」；手动导入后直接开游戏会显示「必须用启动器启动游戏」，AI 用不了。
4. 不要在同一个游戏里同时启用旧「AI 草坪指挥官」或旧 `pvz-agent`，会抢操作。

---

## 使用方式 A：游戏内浮窗

右上角 **🌻 PvZ LLM**：

- **服务商**下拉：DeepSeek 官方 / OpenCode Go（本地代理）/ 自定义。切换后自动填 API Base 和模型，模型名仍可手改并带常用候选。
- 默认是 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-flash`，战斗快模型默认 `deepseek-chat`；也支持任意 OpenAI 兼容 `/chat/completions` 接口。
- **OpenCode Go** 需要本地代理：`opencode.ai` 的 chat 接口不返回 CORS 头，浏览器/WebView2 不能直连。用 `PvZAI_Launcher.exe` 启动游戏时会自动在 `127.0.0.1:8787` 起代理；不开启动器可手动 `node scripts/local-proxy.mjs`。模型选 `deepseek-v4.1-flash`，并且要在 OpenCode Console → Settings → Privacy → Regions 里选 **Global**，否则 DeepSeek 会被上游拒绝。
- 勾选“记住 Key”才会写入本机 `localStorage`（明文）；不勾选只存在内存。
- **测试连接**：发一条 8 token 的请求。
- **开始 AI（F8）**：由 LLM 自己 `pvz_briefing` → 自己定卡组 → `pvz_set_plan` → `pvz_choose_deck` → `pvz_start_level` → 实时循环。
- **停止**：立即中止。
- **F10**：显示/隐藏思考窗。
- 配置页底部主按钮区：**思考窗**（切换显示/隐藏，同 F10）、**测试连接**、**开始 AI**、**停止**；配置页标题栏只剩 **缩小为桌宠**。
- **点桌宠 → 展开 AI 思考窗**；思考窗右上角的**齿轮按钮** → 打开配置页。
- **配置页缩小会把思考窗一起关掉，只留桌宠**：配置页只是隐藏、不会被销毁；需要改配置时先点桌宠打开思考窗，再点齿轮。
- **思考窗**可以单独关闭（×）：只关思考窗，不生成桌宠；如果配置页也是关着的，会保留桌宠作为重新进入的入口。
- 思考窗也可以单独缩小成桌宠；桌宠可拖动并记住位置。
- 浮窗和思考窗都可拖动标题栏移动，右下角拖动缩放；双击标题栏恢复默认位置/大小。
- 界面按钮已改用 **Lucide 图标**（ISC License），鼠标悬停有中文 tooltip；配置页默认模型 `deepseek-flash`、战斗快模型 `deepseek-chat`。
- 思考窗结构：可折叠“本关计划” → 状态胶囊 → 可折叠“推理原文” → 决策日志。推理只在推理区滚动，决策日志只保留动作、结果、计划和中文说明。

UI 前后对比：`ui-before.png`（旧版游戏内截图）、`ui-after.png`（新版桌面）、`ui-after-narrow.png`（720px 窄窗口）。

浮窗不会生成任何本地建议；失败时只显示真实 `code/reason`，由 LLM 决定下一步。

---

## 使用方式 B：MCP

MCP Server 在 Node 侧，通过 CDP 调用游戏里的 `window.PvzLlm`。

### Claude Desktop / Cursor / Cline / OpenCode

```json
{
  "mcpServers": {
    "pvz-llm-agent": {
      "command": "node",
      "args": ["D:\\桌面\\植物大战僵尸\\pvz-llm-agent\\mcp\\server.mjs"]
    }
  }
}
```

环境变量：

- `PVZ_CDP_PORT`：默认 `9222`
- `PVZ_GLOBAL`：默认 `PvzLlm`

### 让 Agent 这样打

```text
你是唯一决策者。先 pvz_health，再 pvz_briefing；自己定卡组并用 pvz_set_plan 记录，
然后 pvz_choose_deck（不会自动补卡）和 pvz_start_level。
之后循环：pvz_state / pvz_events → 自己决策 → pvz_act（1–6 个动作）→ pvz_wait_until。
失败读 code，不要原样重试同一个错误。
```

MCP 与游戏内客户端共用同一套工具定义和 handler，行为一致。

---

## 工具契约

| 工具 | 作用 |
|---|---|
| `pvz_briefing` | 开局全量事实：任务、世界、地形、波次、僵尸、卡池、卡槽、上限 |
| `pvz_knowledge` | 植物/僵尸/本关图鉴与数值；支持 `type` / `query` |
| `pvz_state` | 实时状态：阳光、卡槽、植物（含 `foodable`）、僵尸、波次、任务、棋盘、地形、矿车、计划 |
| `pvz_events` | 增量事件：波次、丢车、植物损失、新威胁、任务紧急、胜负 |
| `pvz_set_plan` | 记录 LLM 的整关计划（只存不用） |
| `pvz_choose_deck` | LLM 指定卡组；只校验 + 执行，不补卡、不改卡 |
| `pvz_start_level` | 关闭任务弹窗 + 开局；轮询到 `running` |
| `pvz_act` | `plant / replace / shovel / plant_food / move_cart / resume / wait / dismiss_objective / collect` |
| `pvz_wait_until` | 等阳光/冷却/僵尸进某行/任务完成等 |
| `pvz_collect` | 收阳光/能量豆/金币 |
| `pvz_plant_food` | 给 `foodable=true` 的植物用能量豆；成功返回 `foodLeft` |
| `pvz_move_cart` | 矿车 |
| `pvz_resume` | 暂停恢复 |
| `pvz_dismiss_objective` | 关闭任务说明 |
| `pvz_restart` | 重开本关（回到选卡阶段） |
| `pvz_health` | 版本/能力检查 |

完整字段、返回结构和错误码见 [`docs/tool-contract.md`](docs/tool-contract.md)。

### 错误码（主要）

- 选卡：`BAD_DECK`、`CARD_NOT_AVAILABLE`、`DECK_NOT_FULL`、`DECK_CLEAR_FAILED`、`CARD_SELECT_FAILED`、`NO_SLOTS`、`PREP_NOT_READY`
- 动作：`COOLDOWN`、`SUN`、`OCCUPIED`、`CELL_BLOCKED`、`PLANT_NOT_SETTLED`、`NO_FOOD`、`NOT_FOODABLE`、`PAUSED`
- 等待：`BAD_CONDITION`、`TIMEOUT`
- 传输：`MOD_NOT_LOADED`、`CDP_DISCONNECTED`、`BRIDGE_ERROR`

`retryable` 只描述“同一个调用稍后是否可能成功”，不是建议。

---

## 选卡修复

旧实现的问题：`addCardByPlantTypeFromSeedbank` 是异步的，代码只等到第一张就继续，最后 `GameStartable()` 为 false，报 `DECK_INCOMPLETE`。

新实现：

1. 先校验：重复 → `BAD_DECK`；不在卡池 → `CARD_NOT_AVAILABLE` + `available`；数量不足 → `DECK_NOT_FULL` + 还差几张；超槽位 → `BAD_DECK`。**校验失败不改卡组。**
2. `replace=true` 时清空旧卡，逐张尝试删除并等待。
3. 逐张加卡，每张都轮询 `cards.CFs.length`，确认真的 +1 才继续。
4. 最终再等 UI 稳定，读 `actualDeck`。
5. 返回 `applied / skipped / missing / actualDeck / full / slots`。
6. **绝不自动补卡。**

离线测试：`tests/deck.test.mjs` 用 40ms 异步加卡的假游戏复现并验证。

---

## 思考窗

显示：

- LLM 的 `reasoning_content`（如果有，只在上方“推理原文”滚动框里显示，不重复进决策日志）
- 调用了哪个工具、参数的人话摘要
- 工具返回的真实 `ok/code/reason`
- 当前计划
- 实时状态摘要
- 失败原因

不显示：

- 本地卡池建议
- 卡组修正
- 本地策略队列
- 整段原始 JSON

> 下方“决策日志”只记录动作、真实结果和计划；模型推理原文只出现在顶部滚动框，避免同一段思考出现两次。

---

## 桌宠（配置页 / 思考窗缩小态）

配置页或思考窗标题栏点 **缩小图标** 后，窗口收成一只大肥鱼悬浮桌宠：

- **注意**：它是游戏页面内的悬浮层，跟着游戏窗口走，不会盖到浏览器/桌面其他软件上；要跨窗口需要额外的原生透明窗口进程。
- **点桌宠 → 展开 AI 思考窗**；思考窗右上角**齿轮按钮**打开配置页。
- **配置页缩小**：配置页和思考窗一起关掉，只留桌宠；配置页只是隐藏、不会被销毁。需要改配置时，先点桌宠开思考窗，再点齿轮。
- **思考窗缩小**：点桌宠恢复思考窗；思考窗 **×** 是直接关闭，不生成桌宠（配置页也关着时会保留桌宠，避免没有任何入口）。
- **状态动作**：待机呼吸 / 思考（坐在小桌前写字）/ 成功敲鼓 / 失败 / 等待（抱尾巴睡觉）/ 鼠标悬停。
- **打字机气泡**：`thinking` 增量逐字浮现；`tool_call` 显示人话动作（如“准备种植 tallnut 第4行 第3列”）；`tool_result` 显示真实结果首行；胜利/失败/错误切对应表情。气泡最多 128px 高，超出自动滚动；非思考状态 10 秒后淡出。
- **交互**：拖动移动并记住位置；单击桌宠或气泡恢复思考窗。
- **素材**：精灵图裁自 [gmskywalker/deepseek-fat-fish-codex-pet](https://github.com/gmskywalker/deepseek-fat-fish-codex-pet) 的 `spritesheet.webp`（7 列 × 6 行内联图集，源文件 `in-game/pet/fatfish-sheet.webp`）。「大肥鱼 / 鲸鱼娘」是社区二创，不是 DeepSeek 官方形象，仅供个人使用，请勿商用。
- 重新生成内联图集：`npm run pet:sprites`（`in-game/pet/fatfish-sheet.webp` → `in-game/pet-sprites.js`）。
- 界面图标：内联 [Lucide](https://lucide.dev) 图标（ISC License），不依赖外部字体或图片。

---

## 开发与测试

需要 Node.js 22+（MCP 用全局 `WebSocket` 连 CDP，无第三方依赖）。

```bash
cd pvz-llm-agent

npm test                 # 离线测试（假游戏 + mock LLM + MCP 协议）
npm run knowledge        # 从 ../game code/CODE 重新生成静态图鉴
npm run build            # 打 pack/scripts/main.js 并做 GP-Next 函数体语法校验
npm run pack             # 打 pvz-llm-agent.zip
npm run mcp              # 启动 MCP stdio server（需要游戏已启动）
npm run verify           # 真机契约检查
npm run acceptance       # 验收采样
npm run live             # 观察一局（真机，不替 LLM 决策）
npm run replay           # 把 live-play-report.json 回放成时间线
npm run mechanics        # 从游戏 JSON 重新生成 knowledge/data/mechanics.json
```

当前离线覆盖：

- 选卡异步同步 / 四种选卡错误 / 不自动补卡
- 种植、占用、冷却、阳光、格子不可种、批量部分失败
- briefing 字段齐全、无推荐字段
- knowledge 植物/僵尸/关键词/本关
- plan 只存不执行、事件增量、health 能力
- router 参数校验、wait_until 立即/超时/非法、start_level 轮询
- in-game agent 的 tool call 循环、推理事件、非法参数、无工具调用时停住
- MCP initialize / tools/list / tools/call / 错误码 / 通知
- 静态图鉴、思考窗格式化不输出原始 JSON

---

## 真机验收

1. 构建并安装 `pvz-llm-agent.zip`，重启游戏。
2. 启动器打开游戏，`node scripts/verify-live.mjs`，确认：
   - `missing` 为空
   - `presentBanned` 为空
   - `briefing.missing` 为空
3. 浮窗填真实 Key，点“开始 AI”，让它自己打一局。
   也可以用脚本点开始并观察整局：
   ```bash
   node scripts/live-play.mjs --start --seconds 600
   ```
4. 另开终端：

```bash
node scripts/acceptance.mjs --seconds 90
```

输出 `acceptance-report.json`，检查：

- 选卡一次成功（`actualDeck == slots`）或明确 `DECK_NOT_FULL`
- 阳光堆积（`sunPeak>500 && shooterPeak<5 && wavePeak>=5`）
- 同一格反复 `CELL_BLOCKED`
- 思考窗是否泄漏原始 JSON
- 页面异常

> 说明：本仓库的离线测试已通过；真机一局仍需要你在有游戏的机器上跑，因为 `Square / LevelTaskCount / putPlantAvailable` 这些字段只能在实际场景里验证。

---

## 已知限制

- **加载模组不能可靠自动修复 CSP。** CSP 是 WebView2 在页面脚本之前施加的策略；模组运行在页面里，改不了响应头。浮窗会显示 `CSP 自检`，如果检测到 meta CSP，删除标签也不保证解除已生效策略。可靠方案是 `PvZAI_Launcher.exe`（解除 CSP）或 MCP 模式（走 CDP，不经过页面网络）。
- **上游 503 / 429 不再直接结束本局。** DeepSeek 等厂商过载时会返回 `service_unavailable_error`；模组现在按 `retry-after` 或 1.5/4/9 秒退避重试 3 次，仍失败就等 15 秒自动重连（最多 3 轮），最后才报 `LLM_UNAVAILABLE`。看到这个错误时点继续即可从当前局面接着打，已执行的动作不会重做。
- 游戏内浮窗模式需要启动器解除 WebView2 CSP；否则 `Failed to fetch`。
- Tauri `plugin:http|fetch` 当前被 ACL 拒绝，不能依赖。
- MCP 模式不需要 CSP，但需要启动器开 9222。
- MVP 只支持 OpenAI 兼容且支持 tool calling 的模型。
- MCP 先进 stdio；HTTP 未实现。
- 旧 `pvz-agent` 保留但冻结，不作为新入口。
