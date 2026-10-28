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
- **v0.2.9 换卡重种**：`replace` 动作先铲后种，一步把弱卡换成强卡（豌豆→双发/西瓜、坚果→高坚果）；`snapshot().shovelCandidates[]` 直接给出可铲候选与原因（超上限 / 可升级 / 位置不对 / 残血）和更好的卡，`loss_limit` 只剩 1 株时拒绝铲除。
- **v0.2.9 开局对策**：进入关卡目标/选卡阶段先读任务、地形机制、预计僵尸（从关卡配置 RTID + 图鉴）、可选卡组，产出整关计划（goal / threats / counters / deck / buildOrder / shovelPolicy / dangerLanes），选卡按计划自动配，战斗中每回合带着计划打。
- **v0.3.0 思考浮窗**：独立悬浮卡片实时显示当前阶段与耗时（读取战场/模型思考/执行动作）、模型 `thought`、要执行的动作与结果、作战计划、最近几回合思考；支持流式输出（边生成边显示）与 F10 开关。
- **v0.3.0 自动换卡**：`shovelCandidates` 大幅放宽（同行不到 4 个射手但只要关键位置种满、坚果升级、位置错误、残血），并且默认开启“自动铲换弱卡”兜底，6 秒最多换 1 格、留足阳光余量。
- **v0.3.0 提速**：默认决策间隔 2200ms → 1600ms；动作成功后 0.9s 内就重新决策；场景组件/关卡预测/地形/机制/地块加入短缓存，状态浮窗 700ms 刷新不再重复全量扫描；提示词里的图鉴文本截断。
- **v0.3.1 位置理解**：提示词新增 5×9 文字位置图和“空位建议”（直接给出可种的 `c` 下标）；`snapshot().board` 提供结构化棋盘；失败结果带 `alts` 可改种格子；明显浪费的种法（阳光 c≥5、坚果 c≤1、地刺 c≤1、普通射手 c≥7）直接返回 `POSITION`，不再硬种。
- **v0.3.2 可编辑策略**：系统提示拆成“固定规则 + 可编辑决策原则”，浮窗里可直接改策略（恢复默认一键还原）；地刺改为必须放前排 c4-c7、且在坚果前面，否则拒绝并给 `alts`。
- **v0.3.2 玩家指示**：思考浮窗里可直接输入一句提示（回车发送），会进入后续每回合的提示词（优先遵守），可随时清除。
- **v0.3.2 开局侦察**：选卡阶段拿到“可用植物 + 预计僵尸 + 任务 + 世界机制”后再制定计划；关卡数据读不到僵尸时按世界常识兜底（`state.world`），并用 `source` 标明来源。
- **v0.3.3 浮窗修复**：补上 `el.strategy` 引用（v0.3.2 的 UI 因它报错导致按钮全部失效、收不起来），新增安全绑定辅助，单个控件缺失不再拖垮整个浮窗。
- **v0.3.4 策略文件化**：默认策略移到模组包内的 `strategy.md`，用 `ctx.files.own()` 读取；`#` 行是注释。编辑文件后点“重新读取”即可生效。
- **v0.3.5 本关临时策略**：浮窗里的输入框只作用于当前关卡，不写默认策略/不持久化；发送后和实时状态一起进入下一次思考，并立即触发一次决策；换关自动清空。
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
- **v0.2.7 通用机制探测**：`snapshot().mechanics`（features / tide / dinosaurs / portals / hazards / tiles / unmappedTiles）；不按地图硬编码，按场景组件类名识别。
- **v0.2.7 不支持关卡**：砸罐/天空/保龄球标 `supported:false`，种植返回 `UNSUPPORTED_LEVEL`。
- **v0.2.8 传送带**：`snapshot().conveyor`（cards / plantList / slots / vertical）；`plant()` 在传送带关卡把 `card` 解释为 `conveyor.cards` 下标，走 `Conveyor.chooseCard()` + `PlaceUIPlant()`，不扣阳光、不吃冷却。
- **v0.2.9 预计僵尸**：`snapshot().levelPreview = { zombies[], plants[] }`，直接扫关卡配置里的 RTID 得到本关将出现的单位。
- **v0.2.9 任务要点**：`objective.hints` / `snapshot().missionHints` 把目标原文解析成“不能损失 / 有倒计时 / 击杀数 / 植物上限 / 阳光目标 / 以守为主”。
- **v0.2.9 图鉴强化**：卡槽行标注定位（阳光/坚果/输出/一次性/地雷/辅助），僵尸标签配一句话应对要点，`plantRole` 新增 aoe / mine / support。
- **原生种植**：走 `UIInGame.tryChangingIndex()` + `LnC.PlaceUIPlant()`，会正常扣阳光、进冷却、受关卡植物上限/地形限制。
- **支持动作**：种植、**替换（replace = 铲除+种植）**、铲除、喂植物能量、等待、选卡、关闭任务说明、开局。
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

### 思考浮窗（v0.3.0）

开始操控后，左下角会出现一张 **🧠 AI 思考** 卡片（可拖动，不影响主浮窗收起）：

```text
┌ 🧠 AI 思考 ────────── 模型思考 · 2.4s ┐
│ 💭 第3排铁桶快到了，先补双发再给坚果   │
│ · 种卡#2 → 2,1                         │
│ · 换卡#1 → 3,4                         │
│ 📋 目标：坚持 60 秒｜卡组：…            │
│ 第18回合 · 补经济，先向日葵             │
└──────────────────────────────────────┘
```

- 顶部计时显示当前阶段花了多久（超过 6 秒变黄）。
- 动作先以 `·` 显示，执行后变成 ✅/⚠️ 并带失败原因。
- 计划（开局对策）一直显示在卡片里。
- **“位置图（模型看到的）”**：展开就能看到模型这一回合收到的 5×9 棋盘，方便核对它是不是看错了格子。
- **本关临时策略输入框**：输入“这关地刺放最前面”“别种坚果”等提示，回车或点“发送并思考”会把它拼进下一次模型请求并**立即触发决策**；只在本关生效，换关/点“清除”自动消失，不会修改默认策略。
- 开启“流式思考”（默认开）时，模型还没输出完就能看到 `thought` 逐步出现。
- **F10** 显示/隐藏；也可以点卡片右上角 **—**，或在主浮窗勾选“显示思考浮窗”。

勾选项说明：

| 勾选 | 作用 |
| --- | --- |
| 自动收阳光/能量豆 | 定期收取掉落物 |
| 自动选卡开局 | 选卡阶段按作战计划选卡并点“一起摇滚吧” |
| 自动铲换弱卡 | 模型没理会候选时，自动执行 1 次“明显该换”的 replace/铲除（6 秒冷却，保留阳光余量） |
| 显示思考浮窗 | F10 同款开关 |
| 流式思考（更快） | 请求改为 SSE 流式，思考窗边生成边显示；服务端不支持时自动退回普通请求 |
| 本地策略 | 不调用模型，用内置规则 |

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
| 铲除 | `LnC.removePlant()`（遍历 plantInSquare / tilePlantInSquare / vineInSquare 等所有容器）；替换 = 铲除 + 原生种植 |
| 关卡任务 | `LevelTaskCount`（`tip` / `count.string` / `mode` / `startingObjdata` / `objdata` / `completed` / `failed`） |
| 地形 | `LnC.squareType`（0=solid 1=sky 2=water 3=sea 4=deck） |
| 目标说明界面 | `LevelObjectiveScreen.continue()` |
| 收阳光 | `sun.collect()`（回退 `specialGoToUI()`） |
| 植物能量 | `plant.food()` + `PlantFoodCount.plantFoodDec()` |
| 棋盘 | `Square.getLnC(row, col)` |
| 僵尸 | `Square.getLane(i).zombiePool()` |
| 选卡开局 | `Cards.addCardByPlantTypeFromSeedbank()` / `Cards.spliceAllCards()` + `levelController.letsRock()` |
| 波次/胜负 | `levelController.currentWave / waveManagerProps / gameWon / gameLost` |

对外 API（MCP 通过 `window.PvzAI` 调用）：`snapshot` / `plant` / `shovel` / `replacePlant(card, lane, column)` /
`plantFood` / `autoDeck` / `autoDeckWith(plants, replace)` / `startLevel` / `dismissObjective` /
`execute(actions)` / `waitUntil(cond, timeoutMs)` / `terrain(lane, column)` /
`briefing()`（开局简报） / `plan()` / `setPlan(plan)` / `makePlan()`（立即重新制定） / `knowledge.plant|zombie`。

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
- `objective.hints` / `snapshot().missionHints` 会把目标原文解析成可执行要点：不能损失植物、有倒计时、要击杀 N 个、植物数量上限、阳光目标、以守为主。
- 如果任务带 `plantCountLimit` 这类限制，本地策略会据此停止超量种植。

## 开局对策（v0.2.9）

进入关卡目标说明或选卡阶段时，模组会先做一次“参谋”调用，而不是直接开打：

1. 汇总 `briefing()`：关卡目标原文 + 任务要点 + 地形/机制 + 矿车 + 预计僵尸（关卡配置里的 RTID 反查图鉴）+ 可选卡组（含图鉴）与推荐卡组。
2. 模型返回 `plan`：`goal / threats / counters / deck / buildOrder / shovelPolicy / dangerLanes / notes`。
3. 选卡阶段按 `plan.deck` 自动选卡（不足卡槽会补满，选不到的卡会跳过并回退到游戏推荐卡组）。
4. 战斗中每回合的提示词都带“本关作战计划”，模型按计划打；局势突变可以偏离。

计划也会出现在 `snapshot().plan`，MCP 侧可以用 `pvz_briefing` + `pvz_set_plan` 走同样的流程。

## 铲除与换卡

- `shovel(lane, column)`：铲掉一格；支持地刺/土豆雷/睡莲等 tile 植物，不返还阳光。
- `replacePlant(card, lane, column)`：先预检卡片（存在/可用/地形），再铲掉并立刻种上，用于同格升级。
- `snapshot().shovelCandidates[]`：`{ lane, column, type, name, hpPercent, reason, better, betterCard, needSun }`
  - `over_limit`：同行同角色超过软上限，建议铲最弱的
  - `upgrade`：该行已满员且手上有更强的同类卡，建议 `replace` 成 `better`
  - `misplaced`：阳光生产者太靠前 / 坚果在最左侧 / 地刺太靠后或在坚果后面
  - `low_hp`：血量 ≤15% 且同角色有卡可补
- 安全限制：`loss_limit` 任务 `left<=1` 时拒绝主动铲（`SHOVEL_BLOCKED`），并把 `shovelCandidates` 清空、`shovelBlocked=true`；`expect` 参数不匹配返回 `PLANT_MISMATCH`；铲除会清掉该格 15 秒不可种缓存，并避免被记成“植物损失”。

## 位置与落点（v0.3.1 / v0.3.2）

每回合提示词里现在有直接可读的坐标信息，不再只丢一堆数组：

```text
位置图（c0 在房子侧，c8 在僵尸出生侧；· 为空）：
　　　c0 c1 c2 c3 c4 c5 c6 c7 c8
第1排 向日 豌豆 ·  ·  ·  ·  坚果 ·  · ｜僵尸 c7海盗(500)
第3排 ·  ·  ·  ·  ·  ·  ·  ·  ·
空位建议（可直接用）：第2排：输出 c1/c2/c3，坚果 c5
位置窗口：阳光 c0-c2；普通输出 c0-c4；坚果/近战 c3-c7；地刺 c4-c7（必须在坚果前面）。
```

- 地刺规则：必须放前排（c4-c7）且在坚果前面；放后面或在坚果后面会被 `POSITION` 拒绝，`alts` 给出前排空位。紧急情况下（僵尸已压到 c≤3）不强行阻止补墙。
- 种错位置时返回 `code=POSITION`，并带 `alts: [{lane, column}]`；普通失败（`OCCUPIED` / `TERRAIN` / `CELL_BLOCKED` / `LANE_LIMIT`）也带 `alts`。
- 下一回合的“上一回合结果”会把这些可改种格子原样给模型，减少反复撞同一格。
- `snapshot().board` 是同一信息的结构化版本，MCP 侧直接用 `lane.cells[column]` 读格子。
- 只有“明显浪费”才拦截；该行推荐窗口都满了时仍允许种在非常规位置，避免最后一道防线被规则堵死。

## 策略文件与本关临时策略（v0.3.4 / v0.3.5）

两者是分开的：

### 默认策略 `strategy.md`（全局）

- 模组包根目录的 `strategy.md` 就是默认“决策原则”，直接用文本编辑器改；`#` 开头的行是注释，不发给模型。
- 主浮窗 → **默认策略（strategy.md）** 显示加载状态，点 **“重新读取 strategy.md”** 即可生效，不必重启。
- 安装版路径：`%APPDATA%\com.pvzge.game\gp-next\packs\pvzai.agent\strategy.md`；ZIP 版与 `pack.json` 同级。
- 文件不存在 / 为空 / 旧版 GP-Next 没有 `ctx.files` 时，自动回退到脚本内置默认。

### 本关临时策略（只影响当前关卡）

- 在 🧠 AI 思考卡片底部的输入框里写一句，例如“这关地刺放 c6，先补双发”，按回车或点 **“发送并思考”**。
- 内容只保存在内存里，**不会写入 `strategy.md`，也不会存在 localStorage**；换关自动清空，点“清除”也会清掉。
- 发送后会拼进下一次模型请求（和实时关卡状态一起），并**立即触发一次决策**，不用等下一个决策间隔。
- 之后的同一关每回合仍会带上它（作为“本关临时策略”）；如果不希望继续生效，点“清除”。

优先级：`本关临时策略`（本关每回合）> `strategy.md`（全局默认）> 脚本内置默认。

## 开局侦察（v0.3.2）

进入选卡阶段、拿到可选卡之后才制定计划，保证参谋同时看到：

- **可用植物**：`seedSelection.available`（codename / 费用 / 定位 / 图鉴简介），并保证卡组至少 1 阳光 + 2 输出；
- **预计僵尸**：关卡配置里的 RTID；读不到时用 `state.world.zombies`（世界常识）兜底，`levelPreview.source` 标明 `level-data` 还是 `world-knowledge`；
- **关卡任务**：目标说明原文 + `missionHints` + 任务进度；
- **世界特点**：`state.world = { key, name, mechanics, tips, zombies }`，例如潮汐/墓碑/矿车/恐龙/气功洞。

参考世界资料：[PvZ2 BWiki](https://wiki.biligame.com/pvzz/)。世界常识只是兜底，实际以游戏内 almanac 与 `state.mechanics` 为准。

## 限制

- **支持标准种子卡槽关卡与传送带关卡**。砸罐子、保龄球、天空关、特殊小游戏仍可能无法操作，`snapshot().mechanics.supported=false` 时 AI 会停止尝试种植。
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
├── strategy.md        # 决策原则（可编辑，可加 # 注释）
├── scripts/
│   └── main.js        # 入口：浮窗 + 状态读取 + 动作 + 模型调用
└── README.md
```

打包时 `pack.json` 必须在 ZIP 根目录：

```text
pvz-ai-agent.zip
├── pack.json
├── thumbnail.png
├── strategy.md
├── scripts/main.js
└── README.md
```

> `strategy.md` 通过 `ctx.files.own().readText('strategy.md')` 读取；如果旧版 GP-Next 没有 `ctx.files`，会自动回退到 `scripts/main.js` 内置的默认策略。

## 适配 / 二次开发

- 入口是 ES module：`export default { setup(ctx) { ... return cleanup } }`。
- 引擎：`ctx.unsafe?.engine?.getCc()`；如果不可用，回退 `window.cc`。
- 浮窗：Shadow DOM + `position:fixed`，默认挂到游戏主页面；如果模组运行在同源 iframe，会尝试挂到 `window.parent.document`。
- 官方兜底面板：`ctx.controls.definePanel()`。
- 关键兼容点：`Cards`、`UIInGame`、`LnC.PlaceUIPlant`、`SunCount`、`Droppings`、`levelController`、`Square`。升级游戏后优先检查这些。
- 想加“自动过关/自动收集金币/自动喂能量”等动作，可以在 `executeActions()` 里加分支，并复用 `findComps()`。

## 免责声明

这是非官方社区模组，与 PvZ2 Gardendless 作者无关。使用前请自行评估风险；因使用本模组造成的存档、账号或模型费用问题由使用者自行承担。
