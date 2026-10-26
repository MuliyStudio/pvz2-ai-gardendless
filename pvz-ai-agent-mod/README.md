# AI 草坪指挥官 · GP-Next 模组

让大模型读取《植物大战僵尸2 花园无尽》的战场，自己决定种什么、种哪一格，并自动打完一关。

这是一个 **GP-Next JavaScript 模组**，不是网页脚本。安装后会在游戏里出现一个可拖拽的浮窗：填写大模型 Key → 点“开始操控” → AI 接管当前关卡。

> 仅用于单机体验。请勿用于联机、排行榜或任何会影响他人的场景。游戏更新后内部接口可能变化。

![thumbnail](thumbnail.png)

## 功能

- **实时读状态**：阳光、卡槽费用/冷却、5×9 格子、植物血量、僵尸位置/血量、波次、关卡进度。
- **浮窗操作**：API Base URL、模型名、API Key、开始/停止、测试连接、日志、状态。
- **两种模式**：
  - 大模型模式：OpenAI 兼容接口，优先工具调用（tool calls），不支持时自动退回 JSON 文本。
  - 本地策略：不调用模型，用内置规则自动打，适合验证安装或离线使用。
- **自动收阳光**：走游戏自己的 `sun.collect()`，不是直接改数值。
- **自动选卡开局**：在选卡页自动选一套卡并点“一起摇滚吧”。
- **每行阵容约束**：同一行最多 1 个坚果墙、1 个弹簧豆、1 个冰冻生菜、2 个阳光生产者、4 个射手、2 个地刺；模型乱种会被代码拒绝，并在提示词里看到“该行已有坚果，禁止再种”。
- **铲子**：支持普通植物和地刺/土豆雷/睡莲等 tile 植物；可以铲掉重复坚果、低血量植物或低效植物，腾位种更强的卡。
- **关卡任务识别**：读取每关任务（如“在 30 秒内击杀 20 个僵尸”），包括当前进度 `0/20`、完成/失败状态；任务会进入提示词，AI 围绕任务调整打法；开局的“关卡目标”说明界面会自动点“继续”。
- **v0.2.5 地形矩阵**：`snapshot().terrain.map` 直接给出 5×9 地形（L 陆地 / P 木板 / W 水 / S 天空），`blockedCells` 标出不可种植格；种水格不再靠试错。
- **v0.2.5 结构化错误**：种植/铲除/能量豆失败返回 `code`（`TERRAIN` / `COOLDOWN` / `SUN` / `OCCUPIED` / `LANE_LIMIT` / `LEVEL_LIMIT`…），`COOLDOWN` 带 `retryAfter`。
- **v0.2.5 任务计时**：`timed_kill` 使用滑动窗口语义，给出 `windowActive` / `timeLeft` / `urgent` / `hint`，内置 AI 会在 `urgent` 时优先输出与能量豆。
- **v0.2.5 批量动作 / 条件等待**：`window.PvzAI.execute(actions)` 一次执行最多 6 个动作；`waitUntil("sun>=200", 20000)` 内部 200ms 轮询。
- **v0.2.5 换卡组**：`autoDeckWith(plants, true)` 会先 `Cards.spliceAllCards()` 清空游戏预填卡组，再逐张选入，返回 `deck / applied / skipped`。
- **v0.2.6 矿车**：`snapshot().carts[]` + `moveCart(id, "up"|"down")`；矿车是可移动植物平台，植物跟着换行。地形用 `R` 标轨道。
- **v0.2.6 全任务语义**：7 种关卡任务都有 `semantics / left / hint / urgent`（植物损失、植物上限、阳光预算、限时击杀等）。
- **v0.2.6 逐行火力**：`snapshot().lanes[]` 给出每排 `shooters / nearestZombie / needsShooter / danger / mower / cart`。
- **v0.2.6 暂停识别**：`paused` / `ui`，动作失败返回 `PAUSED`；`resume()` 继续。
- **v0.2.6 僵尸标签**：`zombies[].tags`（crush / jump_over / backline / flying / spawner / armored / lane_switch）。
- **v0.2.6 损失追踪**：`recentLosses[]` 记录刚消失的植物。
- **原生种植**：走 `UIInGame.tryChangingIndex()` + `LnC.PlaceUIPlant()`，会正常扣阳光、进冷却、受关卡植物上限/地形限制。
- **支持动作**：种植、铲除、喂植物能量、等待、选卡、关闭任务说明、开局。
- **F8 热键**：随时开始/停止；按 F9 可打开 GP-Next 官方侧栏作为兜底。

## 适用版本

| 项目 | 版本 |
| --- | --- |
| 游戏 | PvZ2 Gardendless 桌面版 **0.16.x**（开发验证：0.16.1 同源构建） |
| GP-Next | **1.5.2 – 1.5.x**（开发验证：1.5.5 文档/社区模组接口） |
| 平台 | Windows / WebView2 |
| 不支持 | 网页版 `play.pvzge.com`（网页版没有 GP-Next，需要另做注入方案） |

### 验证说明

- 核心游戏接口已在 **0.16.1 网页构建（与桌面版同源代码）** 中联调通过：状态读取、阳光结算、卡槽冷却、原生种植扣阳光、收阳光、卡槽 UI 守卫。
- 大模型闭环已用本地 mock 接口验证：请求 → JSON 解析 → 动作执行 → 日志/回合/token 统计。
- 桌面 GP-Next 的 `pack.json` 与 `ctx.unsafe.engine` 用法按官方 API 文档和 1.5.x 社区 JS 模组编写；实际导入加载需要你在桌面客户端里做一次最终验证。
- 如果导入时提示 `gpNextVersion` 不匹配，通常只是警告、不阻止加载；也可以自行调整 `pack.json` 里的版本范围。

## 安装

1. 启动游戏，按 **F9** 打开 GP-Next 侧栏。
2. 进入 **实验室 → JS Modding**，阅读风险说明并打开。
3. 进入 **模组 → 导入 ZIP**，选择 `pvz-ai-agent.zip`。
4. 勾选“AI 草坪指挥官”，保存选择并按提示**应用 / 重启**。
5. 进入任意关卡。右下角出现浮窗即安装成功；如果没有，按 F9 在模组详情里使用官方控制面板。

> 首次导入含脚本的模组时，GP-Next 会要求确认信任。更新版本后如果脚本内容变化，需要重新确认。

## 使用

1. 进入关卡（选卡页面或战斗中都行）。
2. 在浮窗里填写：
   - **API Base URL**：必须包含 `/v1`，例如 `https://api.deepseek.com/v1`
   - **模型名**：例如 `deepseek-chat`
   - **API Key**：只保存在本机（默认不记住；勾选“记住”后写入 localStorage 明文）
3. 点 **测试连接**，确认模型可用。
4. 点 **开始操控**，或按 **F8**。
5. 浮窗会收起为右下角胶囊，显示阳光/波次；点胶囊可展开看日志。
6. 再按 **F8** 停止。关卡胜利/失败会自动停止。

浮窗默认在右上角，可拖拽标题栏移动。如果它挡住“一起摇滚吧”或暂停按钮，拖到别处，或点标题栏的 **—** 收起；右下角的小胶囊点一下可以重新展开。

### 模型配置示例

| 服务 | Base URL | 模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | 任选（如 `deepseek/deepseek-chat`） |
| OpenAI 兼容中转 | 你的中转地址（含 `/v1`） | 按中转说明 |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | 已拉取的模型名 |

- **OpenAI 官方 `api.openai.com` 通常被浏览器 CORS 拦截**，桌面 WebView2 同理；请换中转或 DeepSeek/OpenRouter。
- 本地 Ollama / LM Studio 可以不填 Key，Base URL 用 `http://127.0.0.1:11434/v1` 这类本地地址。
- Ollama 需要设置环境变量 `OLLAMA_ORIGINS=*` 并重启 Ollama。
- 优先使用工具调用（DeepSeek / OpenAI 兼容的 tool calls）；模型不支持时自动退回 JSON 文本模式，再不行退回本地策略。
- 对 DeepSeek 默认发送 `thinking: {"type":"disabled"}`：`deepseek-flash` 默认开启思考，会把 `max_tokens` 花在 `reasoning_content` 上，导致 JSON 被截断。关掉后工具调用/JSON 都稳定。

## 工作原理

模组通过 GP-Next 的 `ctx.unsafe.engine.getCc()` 获取游戏自己的 Cocos 引擎，再按组件类名读取/调用：

| 能力 | 游戏内来源 |
| --- | --- |
| 阳光 | `SunCount.CurrentValue` |
| 卡槽/费用/冷却 | `Cards.CFs`、`Cards.cardsUIUpper[i].CD` |
| 种植 | `UIInGame.tryChangingIndex()` + `LnC.PlaceUIPlant()` |
| 铲除 | `LnC.removePlant()`（遍历 plantInSquare / tilePlantInSquare / vineInSquare 等所有容器） |
| 关卡任务 | `LevelTaskCount`（`tip` / `count.string` / `mode` / `startingObjdata` / `objdata` / `completed` / `failed`） |
| 地形 | `LnC.squareType`（0=solid 1=sky 2=water 3=sea 4=deck） |
| 目标说明界面 | `LevelObjectiveScreen.continue()` |
| 收阳光 | `sun.collect()`（回退 `specialGoToUI()`） |
| 植物能量 | `plant.food()` + `PlantFoodCount.plantFoodDec()` |
| 棋盘 | `Square.getLnC(row, col)` |
| 僵尸 | `Square.getLane(i).zombiePool()` |
| 选卡开局 | `Cards.addCardByPlantTypeFromSeedbank()` / `Cards.spliceAllCards()` + `levelController.letsRock()` |
| 波次/胜负 | `levelController.currentWave / waveManagerProps / gameWon / gameLost` |

对外 API（MCP 通过 `window.PvzAI` 调用）：`snapshot` / `plant` / `shovel` / `plantFood` /
`autoDeck` / `autoDeckWith(plants, replace)` / `startLevel` / `dismissObjective` /
`execute(actions)` / `waitUntil(cond, timeoutMs)` / `terrain(lane, column)`。

大模型每回合收到一份紧凑 JSON + 一行行战场摘要，输出：

```json
{ "thought": "第 2 行有僵尸，补一个豌豆射手", "actions": [
  { "type": "plant", "card": 0, "lane": 2, "column": 1 }
] }
```

模组会校验动作，再调用游戏原生方法执行。执行失败会写日志并自动换格/等待，不会无限重试同一格。

## 关卡任务

每关开局的“关卡目标”说明界面和进场后的任务条都会被读取：

- `snapshot().phase = "objective"`：停在开局的目标说明界面，AI 会自动点“继续”，也可以手动调用 `PvzAI.dismissObjective()`。
- `snapshot().tasks`：本关任务列表，例如
  `[{ tip: "在 30 秒内击杀 20 个僵尸", count: "20/20", value: 20, total: 20, percent: 100,
      mode: 6, modeName: "timed_kill", timeSemantics: "sliding_window",
      windowActive: false, timeLeft: null, urgent: false, completed: true, failed: false }]`。
- `timed_kill` 不是“整关倒计时”，而是**最近 30 秒内击杀 ≥ 20** 的滑动窗口：
  每次击杀 30 秒后计数减 1。`timeLeft` 表示最老一次击杀还剩几秒过期，
  `urgent` 在窗口快过期或进度 ≥75% 时为 true；内置 AI 会优先能量豆/一次性植物。
- `snapshot().terrain`：`{ lanes, columns, map: ["LLLLLWWWW", ...], legend }`；
  海盗港湾 17 实测：0–2 行第 5–8 列海面，3–4 行第 5–8 列木板。
- `snapshot().blockedCells`：`[{ lane, column, terrain: "W", reason: "water" }]`，
  含游戏地形与 15 秒学习缓存。
- 任务文本会写进提示词第一屏（`本关任务（必须完成）：… 0/20`），任务进度变化也会触发重新决策。
- 如果任务带 `plantCountLimit` 这类限制，本地策略会据此停止超量种植。

## 限制

- **只支持标准种子卡槽关卡**。传送带关、保龄球、砸罐子、天空关、特殊小游戏可能无法种植（没有 `Cards.CFs` 或没有 `LnC.PlaceUIPlant`），此时 AI 会停在等待。
- **依赖 0.16.x 的内部字段**。游戏大版本更新后可能失效；届时需要重新适配组件名/字段。
- **不是“无敌挂”**。种植会扣阳光、进冷却、受关卡植物上限和地形限制；AI 也可能打输。
- **浮窗可能被指针锁定挡住**。游戏中鼠标被锁定时，先按 Esc 解锁，或用 F8 热键。
- **API Key 安全**：默认只在内存中；勾选“记住”后会以明文存入本机 `localStorage`。不要使用主账号 Key，不要把游戏目录/存档分享给别人。
- **会产生模型费用**。默认决策间隔 2.2 秒，心跳 9 秒；可在浮窗里把间隔调大（800–15000ms）。
- **单机向**。请勿用于联机或排行榜。

## 桌面版 CSP 拦截（重要）

桌面客户端默认限制了 `connect-src`，普通 `fetch` 会被 CSP 直接拦截，日志表现为：

```text
连接失败：Failed to fetch
CSP 阻止：connect-src https://api.deepseek.com/...
```

这是客户端安全策略，不是 Key 或模型的问题。模组会先尝试 Tauri 的 Rust 侧 HTTP；如果你的客户端没有开放 `http` 插件，就需要用启动器：

- **发布包用户**：直接双击 `PvZAI_Launcher.exe`。它会自动安装模组、启动游戏并解除 CSP，不需要 Node。
- **源码 / Node 用户**：双击同目录的 `启动游戏-AI修复.bat`。

Node 版启动器的步骤：

1. 先完全关闭游戏。
2. 双击 `启动游戏-AI修复.bat`（需要 Node.js；脚本会自动找桌面上的 `pvzge*.exe`）。
3. 它会用 WebView2 调试端口启动游戏，并在页面加载时关闭 CSP，然后重载一次回到主菜单。
4. **保持这个黑色窗口打开**（可以最小化），再进入关卡使用 AI。

启动器只做两件事：启动游戏 + `Page.setBypassCSP(true)`，不改游戏文件、不改存档。直接双击游戏 EXE 启动时 CSP 仍然存在，所以每次要用 AI 时请用这个启动器。

## 常见问题

**浮窗没出现？**
按 F9 → 模组 → AI 草坪指挥官 → 官方控制面板。如果官方面板也没有，检查 JS Modding 是否打开、模组是否启用并应用。

**一直显示“等待游戏”？**
确认已经进入关卡（`inGameScene`）。主菜单、世界地图、奖励页会待机。

**提示“格子不可种植”？**
该格已有植物、地形不允许、关卡有植物数量上限，或该格被暂时标记为不可用。AI 会记录 15 秒并换格。

**提示 401 / 403？**
Key 错误、Base URL 少了 `/v1`、或模型名不对。

**提示 CORS / `TypeError: Failed to fetch`？**
换支持浏览器直连的中转 Base URL；DeepSeek 和 OpenRouter 一般可直接用。

**日志出现 CSP / `Refused to connect`？**
用同目录的 `启动游戏-AI修复.bat` 启动游戏（见上一节“桌面版 CSP 拦截”）。如果仍然失败，把“复制日志”的内容发我。

**AI 一直不种？**
看日志里的卡槽状态：可能阳光不够或全部在冷却；也可能是本地策略模式没有识别到卡名。可以先用“导出状态”把快照发出来。

**关卡胜利后还在运行？**
正常会自动停止；如果停在奖励页，按 F8 手动停止。

## 文件结构

```text
pvz-ai-agent-mod/
├── pack.json          # GP-Next 清单
├── thumbnail.png      # 模组封面
├── scripts/
│   └── main.js        # 入口：浮窗 + 状态读取 + 动作 + 模型调用
└── README.md
```

打包时 `pack.json` 必须在 ZIP 根目录：

```text
pvz-ai-agent.zip
├── pack.json
├── thumbnail.png
├── scripts/main.js
└── README.md
```

## 适配 / 二次开发

- 入口是 ES module：`export default { setup(ctx) { ... return cleanup } }`。
- 引擎：`ctx.unsafe?.engine?.getCc()`；如果不可用，回退 `window.cc`。
- 浮窗：Shadow DOM + `position:fixed`，默认挂到游戏主页面；如果模组运行在同源 iframe，会尝试挂到 `window.parent.document`。
- 官方兜底面板：`ctx.controls.definePanel()`。
- 关键兼容点：`Cards`、`UIInGame`、`LnC.PlaceUIPlant`、`SunCount`、`Droppings`、`levelController`、`Square`。升级游戏后优先检查这些。
- 想加“自动过关/自动收集金币/自动喂能量”等动作，可以在 `executeActions()` 里加分支，并复用 `findComps()`。

## 免责声明

这是非官方社区模组，与 PvZ2 Gardendless 作者无关。使用前请自行评估风险；因使用本模组造成的存档、账号或模型费用问题由使用者自行承担。
