# Changelog

## 0.1.13 — 2026-10-30

**砍 prompt 体积：单轮决策从 20–30 秒降下来**

旁观模组自己打（F8）实测：45 秒里决策日志只增加 8 条，有 26 秒完全没动静；同时阳光堆到 1275、植物只有 7 株、推车全丢。定位到瓶颈不是工具层，而是**每轮 prompt 太大**：

- `pvz_state.cards[]` 每回合重复带每张卡的完整数值（实测 4.0 KB / 次）；`levelScript` 每回合重发完整波次表（2.9 KB）；`zombieStats`、`board` 也逐轮重复。单次 state 16.6 KB。
- 内嵌 agent 保留最近 8 份完整工具结果 → 单轮 prompt ≈ 8 × 15 KB ≈ 30k+ token，DeepSeek 光读就要十几秒。

改动：

- `pvz_state` 改精简版：`cards[]` 去掉 `stats`（完整数值只在 `pvz_briefing.cards`），`levelScript` 只留 `waveCount / flagInterval / isAtNight`；`pvz_briefing` 通过 `snapshot({full:true})` 拿完整波次表。实测单次 state 16.6 KB → 约 9.7 KB。
- agent 历史压缩：最近完整工具结果 8 → 4 份，压缩阈值 1500 → 800 字符；旧结果不再只写「已省略」，而是留一句状态摘要（phase / 阳光 / 波次 / 植物 / 僵尸）或失败 code，历史仍可读。
- `MAX` 消息数 60 → 40。
- system prompt 增加一条：每轮尽量把动作做完（≤6 个，铺同卡用 `cells`），不要每轮只种一株。
- 预期单轮 prompt 从 ~120 KB 降到 ~40 KB；离线 52 项测试仍全通过。

## 0.1.12 — 2026-10-30

**按实战暴露的问题重做事实层（远程驱动打了一整局后修的 7 条）**

- `cards[]` 拆开语义：新增 `cdReady`（冷却好了）/ `sunShort`（还差多少阳光）；`affordable` 保持；`ready` 仍表示两者都满足。之前 `ready=false` 时模型分不清是冷却没好还是没钱（实测西瓜 cd=0 但 ready=false，因为阳光只有 250）。
- 僵尸补护甲：新增 `armorHp`（当前护甲，读不到为 null）/ `armorMax` / `ehp = hp + armorHp` / `ehpMax = hp + armorMax`；`lanes[]` 新增 `ehp`（本行在场上僵尸剩余 EHP 合计）与 `ehpExact`。之前 state 只有本体血量，铁桶农夫看起来只有 190 血。
- `OCCUPIED` 的 `reason` 现在写清「哪格被什么占住，可用 replace」；仍带 `plants` 数组和 `hint`。
- `state.seedSelection.available` 去掉每张卡的完整 `stats`（选卡阶段单次 state 从数万字符降到原来的几分之一），完整数值只在 `pvz_briefing.cards`；新增 `availableCount`。
- 新增 `pvz_restart`：走 `PauseScreen.restart` 重开本关，回到选卡阶段；失败返回 `RESTART_UNSUPPORTED` / `RESTART_FAILED` / `RESTART_TIMEOUT`。
- `pvz_act` 的 `plant` / `replace` 支持 `cells`：同一张卡一次种到多格（≤8），工具按真实冷却自动等 `retryAfter` 重试，遇 `SUN` / `OCCUPIED` / `CARD_NOT_IN_DECK` 就停手，整批最多阻塞 25 秒。
- `pvz_briefing.deck` 新增 `coverage`（economy / shooter / lobber / wall / instant / control / support 的**张数**），只数结构，不给建议。
- system prompt 增加三条硬规则：卡槽看 `cdReady/affordable/sunShort`；僵尸看 `ehp/ehpMax`；铺同卡用 `cells`、重开用 `pvz_restart`。
- 新增 8 条离线测试（卡片三态、护甲 EHP、seedSelection 瘦身、cells 冷却重试/停手、restart），共 52 项全通过。

## 0.1.11 — 2026-10-30

**修掉「本关最多 18 株」这类幽灵上限**

- 根因：引擎在 `inGameScene` 上常驻一个**未激活**的 `LevelObjectiveScreen` 模板，`screenName` 是占位符 `<LEVEL OBJECTIVE NAME>`，`mission0` 是默认英文文案 `Never have more than 18 plants`。0.1.8 只是不再拿它算 `plantLimit`，但 `objective.missions` 原样进了 `pvz_state` / `pvz_briefing`，模型读到就把「全程自控植物数≤17，绝不碰到18上限」写进本关计划。
- `readObjective` 现在扫场景里所有 `LevelObjectiveScreen`，优先取「正在显示 + 已本地化」的那个；不信任的模板**连 `missions` 都返回空数组**，模型没有可误读的文本。
- `plantLimit` 改为结构化优先：先看 `LevelTaskCount.plantCountLimit`，再看已本地化任务文案；新增 `limits.plantLimitSource`（`task` / `objective` / `null`）。
- `pvz_briefing.notes` 明确写「`plantLimit` 为 null 就是本关没有上限，不要从任务原文、图鉴或以往关卡推断」；模板关卡再多一句「tasks 为空就按普通关卡打」。
- 游戏内 system prompt 增加硬规则：关卡规则只看 `plantLimit` / `limits`，不要自己加「最多 18 株」之类的限制。
- 新增 3 条回归测试：模板 missions 不进 state/briefing、同场景模板不抢真实任务、结构化任务字段优先于文案；45 项离线测试全通过。

## 0.1.10 — 2026-10-30

- 修复 OpenCode Go 无法使用：`opencode.ai` 的 `chat/completions` 不返回任何 CORS 头（只有 `/models` 是 `ACAO:*`），WebView2 里带 `Authorization` 会先发预检、预检 404，最终报 `Failed to fetch`。这是浏览器跨域限制，改配置解决不了。
- 新增 `scripts/local-proxy.mjs`：本机 8787 端口转发到 OpenCode Go，补 CORS 头并透传流式响应；API Key 只从请求头透传，不落盘。
- `PvZAI_Launcher.exe` 内置同一套代理：启动游戏时自动监听 `127.0.0.1:8787`，玩家不用再单独开脚本（端口被占会提示并跳过，不影响 DeepSeek）。
- 「服务商」里的 OpenCode Go 改为指向 `http://127.0.0.1:8787/v1`，并在提示里写明必须先启动代理。
- `x-opencode-session` 对直连和本地代理两种地址都会带上。
- 实测：页面内经代理请求可达（假 key 返回上游 401，链路正常），直连仍 `Failed to fetch`。
- 新增发布包构建：`python tools/build_bundle.py` 一条命令产出 `dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip`，里面同时有模组 ZIP、`PvZAI_Launcher.exe`、MCP Server（`mcp/` + `tools/`）、`配置MCP.bat` 和中文安装说明。
- `tools/install_mcp_config.mjs` 支持发布包布局：`mcp/server.mjs` 存在时自动用它，并把客户端配置项命名为 `pvz-llm-agent`（源码仓里仍按 `PvZ-MCP/pvz-mcp-server.mjs` / `pvz-gardendless` 工作）。

## 0.1.9 — 2026-10-30

- 浮窗新增「服务商」下拉：DeepSeek 官方 / OpenCode Go / 自定义。切换时自动填 API Base 和模型，模型名仍可手改，并提供常用模型候选（datalist）。
- 接入 OpenCode Go：`https://opencode.ai/inference/go/openai/v1` + `deepseek-v4.1-flash`（OpenAI 兼容 chat/completions）。
- OpenCode Go 请求自动带 `x-opencode-session`（按官方要求用于路由与 prompt 缓存），其他服务商不带。
- 旧配置没有 provider 字段时按 baseUrl 自动推断，升级后不会显示错的服务商。
- `live-play.mjs`：agent 自己停止（LLM 报错/额度不足/手动停）时立即结束采样，不再对着空转界面等超时。
- 新增测试：预设结构、OpenCode Go 端点拼接、会话头只在 Go 出现（43 项通过）。

## 0.1.8 — 2026-10-30

- 修复 18 株上限误判：`LevelObjectiveScreen` 未初始化时 `screenName` 是占位符 `<LEVEL OBJECTIVE NAME>`、`mission0` 是引擎默认英文文案 `Never have more than 18 plants`。之前无条件采信，把它当成了本关真实任务。现在 `readObjective` 输出 `trusted` 字段，只有 `screenName` 已本地化时才采信 `objective.missions`；模板文案不再进入 `missionHints` / `plantLimit`。
- `missionHints` 对 objective 与 task 的重复文案去重。
- 关卡结束自动停止：`notePhase` 记录是否真正进入过 `running`，一旦胜负或回到主菜单/世界地图就置 `stopRequested`，不再依赖「最后调用的工具恰好返回 phase」。`live-play.mjs` 同步：打过 running 后 phase 离开 running 即停止采样，不空转结算界面。
- 新增 `scripts/bypass-csp.mjs`：不依赖启动器也能解除 WebView2 CSP（等价于启动器的 `Page.setBypassCSP` + reload）。
- 新增 `scripts/csp-check.mjs`：开跑前探测 CSP 是否放行，避免盲目 reload 丢掉进度。退出码 0=放行，1=被拦。
- `live-play.mjs` 新增 `--bypass-csp`：先解 CSP 再观察，省掉手动两步。
- 新增测试：占位符 objective 不被采信、本地化 objective 仍能解析上限（41 项通过）。

## 0.1.7 — 2026-10-30

- `pvz_state` 新增 `changesSinceLast`：由工具直接算出「自上次读取 pvz_state 以来的变化」——`plantsLost`（哪格哪株消失）、`plantsAdded`、`mowerLost`、`waveDelta`、`sunDelta`、`zombieDelta`、`plantsLeft`；无变化时 `none=true`。跨 phase 不报 diff，避免上一局数据串进来。
- 修复「植物被吃后不补种」的根因：历史工具结果会被 `compactOldToolResults` 压掉，模型无法自己 diff；现在变化由工具保管，不依赖模型记忆。
- 每轮提示词 `continueMessage` 从「必要时 pvz_events」改为「先取增量再读状态」，与 system prompt 的标准循环对齐；system prompt 明确要求看 `changesSinceLast`。
- 决策日志删除左侧时间列，只保留状态图标 + 正文，让动作和错误从左边缘直接开始。
- 新增测试：`router: pvz_state.changesSinceLast 报出植物新增与损失`（39 项通过）。

## 0.1.6 — 2026-10-30

- 决策日志删除左侧时间列，只保留状态图标 + 正文，让动作和错误从左边缘直接开始。

## 0.1.5 — 2026-10-29

- 主面板收起后变成 50px 圆形悬浮图标（状态点 + AI），点击展开、拖动移动；不再保留 206px 宽的长条。
- 决策日志强制左对齐，避免被游戏页面全局居中样式影响。
- 思考窗正文可滚动，决策日志保留最小高度 120px；计划/推理展开或窗口较矮时仍能滚动到日志。

## 0.1.4 — 2026-10-29

- 思考窗正文恢复可滚动：`.t-body` 允许滚动，决策日志保留最小高度 120px；窗口较矮或计划/推理展开时，仍可滚动到决策日志。

## 0.1.3 — 2026-10-29

- 决策日志强制左对齐：根容器、条目和正文都显式设置 `text-align:left`，并给每条正文加内联样式，避免被游戏页面全局居中样式影响。

## 0.1.2 — 2026-10-29

- 模型默认 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`。
- 浮窗与思考窗支持拖动、右下角缩放、双击标题栏复位，位置/大小写入 localStorage。
- 思考窗 UI 重构：PvZ 深绿工具面板 + 暖阳光强调色；清屏/隐藏改为深色图标按钮；计划可折叠；状态胶囊；推理区可折叠；决策日志按时间/图标/结果分色，去掉了白底默认按钮和拥挤排版。
- 思考窗去重：推理原文只在上方滚动框显示；下方“决策日志”只记录动作、真实结果、计划，模型说明只有中文才进日志。
- 种植落地改为 `pending:true`（⏳）而不是红色 `PLANT_NOT_SETTLED`；换植前等待旧植物真正移除；切卡后等待种子栏同步。
- CSP 自检：界面显示是否检测到 meta CSP；`Failed to fetch` 时提示用启动器或 MCP。模组本身不能可靠解除 WebView2 CSP。
- 新增 `scripts/live-play.mjs`：观察一整局（支持 `--start` 点浮窗开始），不替 LLM 决策。
- 战斗中 `pvz_state` 不再重复携带 30KB 完整可选卡池；旧的工具结果自动压缩，降低 token 消耗。
- 计划面板支持 `deck/layout/contingency` 的对象格式。
- 离线测试：38 项通过。

## 0.1.0 — 2026-10-29

首个符合新需求基线的实现。

- 新建 `pvz-llm-agent/`：bridge / tools / mcp / in-game / knowledge / tests。
- LLM 是唯一决策者；删除本地卡组、自动补卡、策略队列、本地接管。
- 15 个工具契约：briefing / knowledge / state / events / set_plan / choose_deck / start_level / act / wait_until / collect / plant_food / move_cart / resume / dismiss_objective / health。
- 修复选卡：逐张加卡并轮询 `cards.CFs.length`，最终校验 `actualDeck`；不足返回 `DECK_NOT_FULL`，不自动补。
- `pvz_briefing` 输出任务、世界、地形、波次/总 EHP、僵尸数值、全部卡池、槽位、植物上限、起始阳光；不含推荐卡组。
- `pvz_events` 增量事件（波次/丢车/植物损失/行威胁/任务/胜负）。
- 游戏内浮窗 + 思考窗；MCP stdio server（CDP）。
