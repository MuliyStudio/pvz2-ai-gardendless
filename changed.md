# 更新日志

本文件记录 AI 草坪指挥官（PvZ2 Gardendless / GP-Next 模组 + MCP Server）的主要变更。更早的发布说明可在 [GitHub Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases) 查看。

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
