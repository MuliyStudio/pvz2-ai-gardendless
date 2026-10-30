# 更新日志

本文件记录 AI 草坪指挥官（PvZ2 Gardendless / GP-Next 模组 + MCP Server）的主要变更。更早的发布说明可在 [GitHub Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases) 查看。

---

## v0.4.6

**修「选了不用 / 不给能量豆 / 贴脸不决策」（模组 0.1.16）**

- 0.1.15 首次通关（第 13 波、23 株、剩 3 车），但复盘日志发现：磁力菇/樱桃炸弹"选了不用"、4 个能量豆只用 1 个、僵尸贴脸时有一轮被 12 秒的冷却等待卡死。
- 根因三条：① 同一批里「先种再给豆」植物没落地 → `NO_PLANT`；② `foodable` 为 undefined 时被误判不可给豆；③ 长冷却（wallnut 20s）在工具里干等，把整轮晾住。
- 修复：plant_food 等落地再读、`foodable` 只在显式 false 时拒绝；冷却只在 ≤3.5s 时等，长的直接返回让模型换卡；选卡与计划不一致时返回 `warning`；历史完整结果 4 → 2 份。
- 发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.16.zip`，54 项测试通过。

---

## v0.4.5

**修 OpenCode Go 模型名 + 再砍单轮耗时（模组 0.1.15）**

- OpenCode Go 只认 `deepseek-flash` / `deepseek-v4-pro`，预设里写的 `deepseek-v4.1-flash` 会被上游直接拒绝（`invalid_request_error`）。预设、候选、README、安装说明全部改过来。
- `pvz_state` 再瘦身：去掉每回合重复的 `zombieStats`，波次 EHP 改用僵尸自带的 `ehp/ehpMax`；加一条「推理 ≤2 句、不复述数值」的提示词规则。
- 发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.15.zip`，离线 53 项测试通过。

---

## v0.4.4

**旁观第二局后的吞吐修复（模组 0.1.14）**

- 0.1.13 实测：单次 state 16.6 KB → 8.75 KB，60 秒 14 条决策（~4.3 s/条），但仍在第 9 波丢光推车。
- 新瓶颈是"每回合落地几株"：模型一轮里同卡种两次，第二枪直接吃 `COOLDOWN` 白扔动作。现在 `pvz_act` 会自己等该卡冷却再重试（≤6 s × 2 次，整批 20 s）。
- 一局实测消耗：31 次工具调用、输入 464,748 / 输出 23,905 token。
- 发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.14.zip`。

---

## v0.4.3

**旁观模组自己打之后的性能修复（模组 0.1.13）**

- 实测：45 秒只做了 8 条决策日志，其中 26 秒完全静默；阳光涨到 1275 而场上只有 7 株植物，5 辆推车全丢。瓶颈是每轮 prompt 太大（8 份完整 state ≈ 30k+ token），不是工具出错。
- `pvz_state` 改精简版（cards 不带数值、levelScript 只留摘要），单次 16.6 KB → 9.7 KB；`pvz_briefing` 仍拿完整波次表。
- agent 历史压缩：保留 4 份完整结果、旧结果留状态摘要；消息上限 60 → 40。单轮 prompt 预计 ~120 KB → ~40 KB。
- 新增 `tools/pvz-watch.mjs` / `tools/pvz-pace.mjs` 两个只读旁观脚本（采样卡壳、丢车、决策节奏）。
- 发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.13.zip`。

---

## v0.4.2

**按实战暴露的问题重做事实层（模组 0.1.12）**

- 我用 CDP 远程操控模组打完一局（输在第 13 波），按实际踩到的坑改了 7 处：卡片状态三态、僵尸护甲 EHP、`OCCUPIED` 说人话、选卡数据瘦身、`pvz_restart`、`plant.cells` 批量种植、`briefing.deck.coverage` 结构计数。
- 具体细节见 [`pvz-llm-agent/CHANGELOG.md`](pvz-llm-agent/CHANGELOG.md) 的 0.1.12；工具数从 15 变 16，发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.12.zip`。
- 离线测试 52 项全通过。

---

## v0.4.1

**修「本关最多 18 株」幽灵上限（模组 0.1.11）**

- 引擎在 `inGameScene` 上常驻一个未激活的 `LevelObjectiveScreen` 模板：`screenName` 是 `<LEVEL OBJECTIVE NAME>`，`mission0` 是默认文案 `Never have more than 18 plants`。之前只是不拿它算 `plantLimit`，`objective.missions` 还是原样进了 `pvz_state` / `pvz_briefing`，模型读到就写进计划（“全程自控植物数≤17，绝不碰到18上限”），导致本关明明没上限却不敢种。
- 现在 `readObjective` 扫全场景所有 `LevelObjectiveScreen`，优先取「正在显示 + 已本地化」的那个；模板连 `missions` 都返回空数组。
- `plantLimit` 结构化优先（`LevelTaskCount.plantCountLimit` → 已本地化任务文案），并新增 `limits.plantLimitSource`；`pvz_briefing.notes` 和 system prompt 都写死“`plantLimit` 为 null 就是没有上限，不要自己推断”。
- 新增 3 条回归测试，离线 45 项全通过；发布包重建为 `PvZAI-LLM-Agent-Bundle-v0.1.11.zip`。

---

## v0.4.0

**换掉整套实现：LLM 是唯一决策者**

- 新实现 `pvz-llm-agent/` 取代旧 `pvz-ai-agent-mod/`（旧目录保留但冻结，不再更新）。模组 `uuid` 变为 `pvzllm.agent`、名字变为 **PvZ LLM Agent**，和旧模组不能同时启用。
- 代码里删掉所有“替模型做决定”的东西：`autoDeck`、`suggestDeck`、`setStrategy`、本地任务队列、卡组修正、LLM 不可用时的本地接管、`strategy.md`。15 个工具只做四件事：给事实、执行动作、返回真实结果、记录计划。
- 工具集重做：`pvz_briefing / knowledge / state / events / set_plan / choose_deck / start_level / act / wait_until / collect / plant_food / move_cart / resume / dismiss_objective / health`。`pvz_act` 一次最多 6 个动作，`replace` 先铲后种；`pvz_state` 带 `changesSinceLast`，模型不用自己 diff 被吃掉的植物。
- 选卡修复：`addCardByPlantTypeFromSeedbank` 是异步的，旧代码等第一张就继续，最后 `GameStartable()` 为 false。现在逐张轮询 `cards.CFs.length` 确认 +1，再读 `actualDeck`；校验失败不改卡组，**绝不自动补卡**。
- 游戏内浮窗重做（**PVZ · AI 指挥**）：服务商预设（DeepSeek 官方 / OpenCode Go 本地代理 / 自定义）、记住 Key、流式、测试连接、F8 开始/停止、F10 思考窗；浮窗可拖动/缩放/双击复位，CSP 自检结果直接显示在面板上。
- 思考窗拆成“本关计划 / 状态胶囊 / 推理原文 / 决策日志”，只记录动作、真实 `code/reason` 和计划，不重复推理原文，不显示本地建议。
- OpenCode Go 修复：它的 `chat/completions` 不返回 CORS 头，WebView2 直连必然 `Failed to fetch`。启动器内置 `127.0.0.1:8787` 本地代理（补 CORS、透传 SSE、Key 只走请求头不落盘），也可以用 `scripts/local-proxy.mjs` 手动起。
- MCP Server 换成 `pvz-llm-agent/mcp/server.mjs`（stdio + CDP，零第三方依赖，Node 22+），工具定义与游戏内共用同一份 router，行为一致。
- 发布包重做：`python tools/build_bundle.py` 一条命令产出 `dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip`，内含模组 ZIP、重新编译的 `PvZAI_Launcher.exe`、MCP Server、`配置MCP.bat`、`安装说明.txt`、`MCP工具契约.md`、`README.md`。
- `配置MCP.bat` 同时支持源码仓和发布包两种布局：检测到 `mcp/server.mjs` 就用它并把配置项命名为 `pvz-llm-agent`，否则仍旧走 `PvZ-MCP/pvz-mcp-server.mjs`（`pvz-gardendless`）。

> 逐版本细节（0.1.1 → 0.1.10）见 [`pvz-llm-agent/CHANGELOG.md`](pvz-llm-agent/CHANGELOG.md)。

---

## v0.3.17

**把 MCP 那套数据同步给内置 AI（同一份事实，不再两套脑子）**

- 内置 AI 的提示词（`stateForPrompt`）以前只给卡片的 `cost/cd/ready`，现在补齐：`cards[].stats{hp,family,attack,splash,sun}` + `cards[].shot`、`plants[].shot/blockedAt`、`obstacles`、`plantable`、`mechanicFacts`、`lanePolicy`、`cooldownMods`；正文另加三行（本关机制 / 障碍与挡弹道 / 可种列 / 来路随机）。
  之前“模组读到了但没用上”，就是因为这些字段只在 snapshot 里，没进提示词。
- `autoDeck` 不再写死名字顺序（以前第一项是 sunflower，所以夜晚关卡也先选向日葵）：改为按 `max(输出, 血量/40, 产阳光×10) / 造价` 打分挑卡，经济卡用 `bestSunProducer`（昼夜取对应 `ProduceInterval`）。
- `DECK_CLEAR_FAILED` 不再导致“退回旧硬编码卡组”：`spliceAllCards` 留下的那 1 张会再尝试删除，删不掉就带着它继续补卡并返回 `clearIncomplete`，不会再走 `autoDeck()` 的旧路径。
- 选卡顺序保持“先计划后选卡”：`makePlan` 产出的 `plan.deck` 优先，只有计划里没有 deck 时才用数据打分兜底。

---

## v0.3.16

**只允许一个大脑：MCP 接管时自动停掉内置 AI**

- 新增 `pvz_stop`：停止 F8 那套内置 AI 循环。
- 外部接管：MCP 调用 `plant / shovel / replacePlant / plantFood / execute / setQueue` 时，若内置循环正在跑，自动 `stop('外部接管')` 并记一条日志，避免两个控制器同时下指令（本次就是内置 AI 在跑：自己选了含向日葵的卡组、反复换卡、撞 18 株上限）。
- `autoDeck`（内置 AI 的兜底选卡）不再写死“先选向日葵”：改为按“成熟期每秒阳光 / 造价”挑产阳光卡，昼夜取对应 `ProduceInterval`（本关夜间 → 阳光菇）。
- 顺带：`pvz_state.blockedCells` 含占格障碍、`state.plantable` 给可种列、队列失败退避（0.3.15 内容）在本版一并生效。

---

## v0.3.15

**修两个“会把自己卡死”的坑**

- 队列执行器失败不再阻塞整队：`COOLDOWN` 按 `retryAfter` 给该任务退避（≤8s），其它失败退避 3s 并累计 3 次后标记 failed；失败后**继续检查后续任务**，不再“一张卡在冷却 → 整队原地打转”。这正是这次丢推车的原因：循环卡在一个必然失败的种植上 ~20 秒，别行没人管。
- `state.blockedCells` 现在合并“占格但不能种”的障碍（墓碑/霉斑等，`blocksPlanting=true`），不必靠撞一次 `CELL_BLOCKED` 才学到；同时新增 `state.plantable[{lane, columns[]}]`，直接给出每行可种的空列。
- 本次实战：流式回路（读 25ms/次）打到第 15 波 win，17/18 株，仅丢 1 辆推车（L1，正是上面那个“失败自锁”窗口里漏掉的）。

---

## v0.3.14

**把执行搬进游戏：队列执行器（解决 Agent 反应慢）**

- 新增 `pvz_set_queue {tasks, tickMs?}` / `pvz_queue` / `pvz_clear_queue`：Agent 只出「任务队列」，由模组在游戏内按节拍（默认 500ms）自动执行，每拍最多一个动作；卡在冷却/阳光不够时自动等下一拍，不占用往返。
- 任务支持条件：`cellEmpty`（默认开）、`noWall`、`noShooter`、`zombieInLane`、`zombieColumnLt`、`minSun`；目标支持 `lane:"danger"`（最近僵尸行）与 `column:"ahead"`（僵尸前一格），用于“墙/一次性卡赶在僵尸前面”。
- 关卡结束（won/lost）自动停队列；内置 AI（F8）运行时队列让位，避免抢动作。
- 意义：MCP 往返 + 模型思考是秒级，僵尸是实时的；把落子交给游戏内执行器后，延迟从“几秒”降到“≤ tickMs”，我只需要在波次之间改队列。

---

## v0.3.13

**不再把“还没落地”误报成种植失败**

- 0.3.11/0.3.12 的落地复核会把“植物节点延迟生成”误判成 `PLANT_NOT_SETTLED` / `SHOVEL_FAILED`，让上层以为动作失败（实际已扣阳光并种下）。
- 现在复核只做两件事：多等几帧（最多 8 次）、把结果写成 `settled: true/false`，**不改写 `ok`**。动作是否成功仍以游戏返回为准。

---

## v0.3.12

**波次行号是预览，不是来路**

- `levelScript.waves[].rows` 改名 `rowsHint` 并加 `rowsAreHint: true`：脚本里的 `Row` 是预览布局，实际生成用 `SpawnZombiesJitteredWave*` 抖动/随机，不能当“这波从哪几行来”的预测。
- 新增 `levelScript.lanePolicy{spawnLanes, random, note}`：来自引擎的 `onlyLanesForRandomSpawn`（本关是 `[0,1,2,3,4]`，即五行都可能来）。
- 提示词里的波次行（`withRows` 分支）同步标注为“预览”，避免再被当成实际走向。

---

## v0.3.11

**修 async 接口在 MCP 链路上的两个断点**

- `callMod` 的包装是同步 IIFE，遇到 `execute()` 改成 async 后拿到的是 Promise，序列化成了 `{}`，`pvz_act` 直接报 `steps.every is not a function`。包装改成 async 并 `await`，异步 API 才能正确返回。
- 单动作 `pvz_plant / pvz_shovel / pvz_replacePlant` 现在也走“等落地 + 复核”（与 `execute` 一致），刚种下立刻读 `state.plants` 不再滞后。
- `pvz_choose_deck` 失败（例如 `DECK_CLEAR_FAILED` 只剩 1 张）不再抛工具错误，返回 `{ok:false, code, remaining}`，可直接用 `replace:false` 补齐剩余卡。

---

## v0.3.10

**修复 0.3.9 加载失败（Unexpected token ':'）**

- 0.3.9 里一行注释和 `const INSTANT_FACTS = {` 被合并到同一行，注释把声明吃掉了，GP-Next 以“函数体”方式解析时报 `Unexpected token ':'`。
- 根因是校验方式不对：`node --check` 会把文件当 ESM 解析，绕过函数体上下文的语法检查。新增 `tools/check_mod.js`：把 `export default` 换成 `return` 后用 `vm.Script` 的函数体上下文校验；`tools/build_zip.py` 打包前强制先跑它，失败直接中止。

---

## v0.3.9

**工具层的四个坑 + 机制×特性的数据桥**

- `pvz_act` 部分失败不再算工具错误：返回 `{ok:false, steps:[...]}`，每步带真实 `code/reason`，调用方可继续补动作。
- `pvz_wait_until` 支持复合条件：`"sun>=150 && card_ready:peanut"`、`"zombie_in_lane:3 || tasks_ready"`（一条里只用一种连接符）。
- 种植/铲除/替换后自动等场景落地并复核：本批后续动作与下一回合读到的 `plants` 不再是旧局面；复核失败返回 `PLANT_NOT_SETTLED` / `SHOVEL_FAILED`。
- 新增**弹道与遮挡**：`plants[].shot{kind,overObstacle,blockedByStraightBlocker}`、`plants[].blockedAt`、`state.obstacles[]{blocksPlanting,blocksStraightShot,hp,removeBy}`。墓碑挡直线弹道，高抛(投手)/近战/范围/一次性不受影响；未验证的字段给 `null` 而不是 false。
- 新增**一次性卡范围**：`pvz_knowledge().instant{area,lanes,columns}`（樱桃 3×3、辣椒整行、土豆雷/冰冻生菜接触单体、噬碑藤仅墓碑格）。
- 新增 `state.mechanicFacts[{id,text}]`：只列本关真正生效的机制（无天空阳光/冷却修正/墓碑生成/招魂/潮汐/轨交/传送门/罐子/天空/濒危/传送带），按机制 id 而不是世界名。

---

## v0.3.8

**MCP 的思考也能进浮窗**

- 新增 `pvz_think {text, stage?, actions?}`：外部 Agent 每个回合可以把判断写进游戏内“思考浮窗”，顶部显示阶段名，历史里标 🛰 MCP（紫色），动作只是预览、不执行；浮窗被关掉时会自动打开。
- `pvz_health` 版本校验从“字符串必须相等”改成“模组 >= Server 即可”，避免模组更新后误报不可用。
- 新增 `tools/cdp_eval_on.mjs`：在指定 CDP 页面执行表达式，用于调试模组而不动游戏文件。
- **删掉模组层的硬拦截**：`SAME_CARD_IN_BATCH` / `SAME_BATCH_CONFLICT` / `SHOVEL_TOO_SOON` / `SHOVEL_REPEAT` / `SHOVEL_RATE_LIMIT` / `SHOVEL_IN_COMBAT` 全部移除。种子冷却本来就由游戏判（同卡批内第二次会返回 `COOLDOWN`），铲除频率也不再限速；只保留两条会直接判负的保护（`loss_limit left<=1`、濒危植物）。`shovelCandidates` 不再过滤“刚种下/刚铲过”的格子，改为标注 `ageSec` / `shoveledRecently`，由模型自己决定。

---

## v0.3.7

**数值给全，判断留给模型（不再写死世界规则）**

- 植物数值补上**阳光经济**：`SunValue / SunValueList / ProduceInterval / ProduceInterval_AtNight / ProduceCountdownStart`，并直接算好 `perSecDay / perSecNight / paybackSec`（分阶段产出按阶段给数组）。白天/夜晚不用靠世界名猜：`state.cards[].stats.sun`、`seedSelection.available[].stats.sun`、`pvz_knowledge` 都能直接读到。
- 僵尸数值补上**有效血量**：读 `ArmorProps` 拿到每层护甲血量，输出 `armorDetail / armorHp / ehp`（例：石质路障僵尸 190+370=560）。判断“一条线够不够输出”从看血量改成看 EHP。
- 关卡模块透出：`levelScript.modules` 原样列出 `currentLevelObjects` 里非波次模块（冷却修正、掉阳光、推车、墓碑/招魂生成器、关卡限制…），并汇总 `cooldownMods / sunDropper`。
- 场地事实：`levelScript.lawn = { stage, isAtNight, mower, gravestone, gravestoneHp, graveBuster }`，来自 `LawnProps` + `TombstoneProps`；`pvz_briefing` 同时带上 `lawn / sunDropper / cooldownMods / levelModules`。
- `pvz_knowledge` 现在一并返回数值（`stats`），不必再去 `pvz_state` 的卡片里翻。
- 原则：不新增“该种什么”的规则文本。模组只给原始数值和可直接验算的派生量（阳光/秒、EHP 与护甲、冷却修正），打法由模型自己算。
- `strategy.md` 精简：35 条规则 → 13 条，删掉固定列窗口（c0-c2 / c1-c4 / c3-c7）、每行株数、前期经济数量等一次性规则，只保留“怎么读数据 + 硬机制（阶段/冷却/铲除限制/传送带/矿车/濒危植物/地刺必须在坚果前）”；`FALLBACK_STRATEGY` 与提示词里的位置参考同步改成“按 stats 自己算”。

---

## v0.3.6

**不再“种了又铲”，思考浮窗更好看**

- 修复 AI 来回折腾：同一格刚种下的植物 20 秒内不进铲除/换卡候选，12 秒内直接拒绝铲除（`SHOVEL_TOO_SOON`）；同一格 25 秒内只能动一次铲子（`SHOVEL_REPEAT`）；30 秒内最多主动铲/换 4 格（`SHOVEL_RATE_LIMIT`）；僵尸已经贴到格子附近时拒绝铲除（`SHOVEL_IN_COMBAT`），避免铲完来不及补。
- “自动铲换弱卡”兜底改为**只做同格升级 replace**，不再自动 shovel 掉模型刚种下的坚果/地刺；并增加新鲜度、阳光余量和僵尸距离判断。
- 同一批动作里同一张卡只能种一次；模型若“先种后铲”同一格，后一个铲除会被拦下（`SAME_CARD_IN_BATCH` / `SAME_BATCH_CONFLICT`）。
- 去掉提示词里“⚡ 优先处理”的强制口吻，改为“可选优化”；角色位置窗口/本地策略与 strategy.md 对齐（阳光 c0-c1、射击 c1-c4、坚果 c3-c7、地刺放前排）。
- 统一坐标写法：状态和开局计划都要求用 `lane X, column Y`（0 起），避免“第 2、3 列”这种 0 起/1 起混用导致的错种。
- 提示词新增“本回合可用 / 冷却中 / 阳光不足”清单，减少同一个回合连续撞冷却的无效动作。
- 思考浮窗：窗口加高（最高 940px，占满左侧可视高度）、加宽到 440px；所有文本强制换行，修复右侧空白和横向滚动；拖动/切换分辨率后自动夹回可视区。
- 思考历史改为彩色列表：回合号、时间、判断文本、每个动作的成功/失败结果分色显示；保留最近 30 回合，支持滚动回看；只有内容变化时才重绘，不再每 300ms 刷新导致滚动位置跳动。
- 修复“提前布阵 / Last Stand”关卡：识别 `state.preset`，布阵阶段允许正常种植；阵法摆好后自动/按指令点击“开始！”（`start_level` → `LastStandStartButton` / `levelController.readySetPlant`），不再等游戏自动开或卡在选卡界面。
- 布阵兜底：模型只输出 `wait` 但还有钱有卡时，自动用本地策略补种；种子栏读不到/卡组为空时不会误判开局。
- 修复思考窗被长文本挤压：思考、动作、计划、位置图各自限制高度并独立滚动，历史列表固定拿剩余空间；600px 高的游戏窗口下也能看到“本关临时策略”输入框。
- 主浮窗和思考窗支持**边/角拖动缩放**：鼠标放到窗口边缘会变成缩放光标，拖动即可放大缩小；标题栏双击恢复默认大小和位置；大小写入本地配置，下次启动保留。
- `changed.md` 更名为 `CHANGELOG.md`。

---

## v0.3.5

**默认策略归文件，浮窗只管本关**

- 默认策略统一放到模组目录的 `strategy.md`，不再由浮窗编辑或写入 localStorage。
- 主浮窗“默认策略（strategy.md）”只显示加载状态，并提供“重新读取 strategy.md”按钮。
- 思考浮窗输入框改为 **本关临时策略**：
  - 只保存在内存，不写 `strategy.md`、不写 localStorage；
  - 只对当前关卡生效，换关自动清空；
  - 发送后与实时关卡状态一起进入下一次模型请求，并**立即触发一次决策**；
  - 点“清除”立即重新决策（不带该提示）。
- 优先级：`本关临时策略` > `strategy.md` > 脚本内置默认。
- 修复跨关时临时策略残留：按关卡 key 自动清理。

---

## v0.3.4

**策略文件化**

- 默认策略从脚本中搬到模组包根目录的 `strategy.md`，通过 `ctx.files.own()` 读取；`#` 开头的行作为注释忽略。
- 支持 `strategy.md` / `strategy.txt` / `config/strategy.md` / `scripts/strategy.md`。
- 文件缺失、为空或旧版 GP-Next 不支持 `ctx.files` 时，回退到脚本内置默认。
- `tools/build_zip.py` 打包时包含 `strategy.md`；安装目录同步该文件。

---

## v0.3.3

**浮窗修复**

- 修复 v0.3.2 因缺少 `el.strategy` 引用导致的初始化异常：面板能显示，但收起、开始/停止、胶囊等按钮全部失效。
- 新增安全绑定辅助，单个控件缺失不再中断整个浮窗的事件绑定。
- 对策略、思考输入、位置图等新控件增加空值保护。

---

## v0.3.2

**策略拆分 / 落点修正 / 开局侦察**

- 系统提示拆成“固定规则 + 决策原则”，为后续策略编辑打基础。
- 思考浮窗增加玩家提示输入（v0.3.5 改为本关临时策略）。
- 地刺落点修正：必须在前排 c4–c7，且必须在坚果前面；违反返回 `POSITION` 并给前排 `alts`。
- `shovelCandidates.misplaced` 同步修正（阳光 c≥4、坚果 c≤2、地刺 c<4 或在坚果后）。
- 开局计划推迟到选卡阶段，拿到可用卡列表后再制定；同时注入任务、世界机制、预计僵尸。
- 世界识别与常识兜底（`state.world`），预计僵尸来源标注 `level-data` / `world-knowledge`。
- 卡组保底：至少 1 个阳光生产者 + 2 个输出，并按卡槽上限截断。

---

## v0.3.1

**位置信息直接进思考**

- 每回合提示词新增 5×9 文字位置图（c0→c8、每格植物、每行僵尸位置/血量）。
- 新增“空位建议”：直接给出某行可种的 `c` 下标。
- `snapshot().board` 提供结构化棋盘，MCP 侧同样可用。
- 新增 `POSITION` 错误与 `alts`（可改种格子）；`OCCUPIED` / `TERRAIN` / `CELL_BLOCKED` / `LANE_LIMIT` 失败也带 `alts`。
- 拦截明显浪费的落点：阳光 c≥5、坚果 c≤1、地刺 c<4、普通射手 c≥7（窗口有空位时）。
- 思考浮窗新增可折叠的“位置图（模型看到的）”。

---

## v0.3.0

**思考浮窗 / 自动换卡 / 提速**

- 新增独立思考浮窗（F10 开关）：阶段与耗时、`thought`、动作结果、作战计划、最近回合思考。
- 决策请求支持 SSE 流式输出，边生成边显示；失败自动退回普通请求。
- 新增“自动铲换弱卡”兜底：6 秒最多 1 格，保留阳光余量。
- 放宽 `shovelCandidates`：输出位已满、坚果/向日葵升级、位置错误、残血等。
- 决策间隔默认 2200ms → 1600ms；动作成功后 0.9s 重新决策。
- 场景组件、预计僵尸、地形、地图机制、特殊地块加入短缓存，降低状态刷新开销。
- 新增失败复盘日志（任务、植物数、最近损失、卡组、计划）。

---

## v0.2.9

**铲除重种 + 开局对策**

- 新增 `replace` 动作：先预检卡片，再铲除并立即种上，用于同格升级。
- `snapshot().shovelCandidates[]`：`over_limit` / `upgrade` / `misplaced` / `low_hp`，附带 `hpPercent`、`better`、`betterCard`。
- `loss_limit` 任务 `left<=1` 时拒绝主动铲除（`SHOVEL_BLOCKED`）。
- `shovel` 支持 `expect` 参数，防止铲错株（`PLANT_MISMATCH`）。
- 开局计划：任务、地形机制、预计僵尸（关卡 RTID + 图鉴）、可选卡组 → `plan`（goal/threats/counters/deck/buildOrder/shovelPolicy/dangerLanes）。
- 预计僵尸 `levelPreview`、任务要点 `missionHints`、卡牌定位与僵尸应对要点。
- MCP 新增 `pvz_briefing`、`pvz_set_plan`；`pvz_choose_deck` 不足卡槽自动补满。

---

## v0.2.8

**传送带关卡**

- `snapshot().conveyor`：`cards[]` / `plantList[]` / `slots[]` / `vertical`。
- 传送带关卡中 `plant` 的 `card` 表示 `conveyor.cards` 下标；不扣阳光、不吃种子冷却。
- 传送带开局：`choose_deck` 返回“无需选卡”，`start_level` 直接开战。
- `wait_until` 新增 `conveyor_ready`；`card_ready` 同时识别种子卡和传送带卡。

---

## v0.2.7

**通用地图机制探测**

- `snapshot().mechanics`：`features` / `tide` / `dinosaurs[]` / `portals[]` / `hazards[]` / `tiles[]` / `unmappedTiles[]`。
- 不按地图硬编码，按场景组件类名识别；支持潮汐、墓碑、金瓷砖、濒危植物、气功洞、巫师羊、恐龙、传送门、矿车轨道等。
- 砸罐 / 天空 / 保龄球等不支持关卡标 `supported:false`，种植返回 `UNSUPPORTED_LEVEL`。

---

## v0.2.6

**矿车 / 全任务语义 / 逐行火力**

- `snapshot().carts[]`（编号、位置、车上植物、可移动方向）+ `move_cart`。
- 7 种关卡任务统一语义：`semantics` / `left` / `hint` / `urgent`。
- `snapshot().lanes[]`：每排 `shooters` / `nearestZombie` / `needsShooter` / `danger` / `mower` / `cart`。
- 暂停识别与 `resume`。
- 僵尸机制标签：`crush` / `jump_over` / `backline` / `flying` / `spawner` / `armored` / `support` / `lane_switch`。
- 植物损失追踪 `recentLosses[]`（排除自己铲除和矿车移动）。
- `pvz_health` 健康检查。

---

## v0.2.5

**地形 / 任务计时 / 批量动作**

- `snapshot().terrain.map` 5×9 地形矩阵（L 陆地 / P 木板 / W 水 / S 天空 / R 轨道）与 `blockedCells`。
- 结构化错误码：`TERRAIN` / `COOLDOWN` / `SUN` / `OCCUPIED` / `LANE_LIMIT` / `LEVEL_LIMIT` 等；`COOLDOWN` 带 `retryAfter`。
- `timed_kill` 滑动窗口语义：`windowActive` / `timeLeft` / `urgent` / `hint`。
- `execute(actions)` 批量动作；`waitUntil(cond, timeout)` 条件等待。
- `autoDeckWith(plants, true)` 清空并重选卡组。

---

## v0.2.4

**关卡任务识别**

- 读取每关任务（`LevelTaskCount`）：任务文本、进度、完成/失败状态。
- 开局“关卡目标”说明界面识别与自动“继续”。
- 任务进入提示词，AI 围绕任务调整打法。

---

## v0.2.3

**铲子修复**

- 铲除支持地刺、土豆雷、睡莲等 tile 植物。
- 允许在弱植物/重复植物场景下先铲后种。

---

## v0.2.2

**DeepSeek tool calls + MCP + 每行上限**

- 支持 OpenAI 兼容工具调用；失败自动退回 JSON 文本。
- MCP Server：`pvz_state` / `pvz_plant` / `pvz_act` / `pvz_wait_until` 等。
- 每行软上限（坚果/弹簧豆/冰冻生菜/阳光生产者/射手/地刺）。
- 自动收阳光、自动选卡开局。

---

> 更早版本（v0.1.x 及以前）请查看 [Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases) 或提交历史。
