# PvZ LLM Agent — 下一阶段计划

> 目标：不再按关卡/僵尸逐个打补丁。所有单位、机制、时序尽量由数据与通用规则计算，LLM 只负责理解、制定计划和选择动作。

## 当前基线

- 版本标识：`0.1.24`
- 测试：89 项通过
- Bundle：22 个模块
- 主要文件：
  - `bridge/mechanics.js`：纯计算层
  - `bridge/stats.js`：植物/僵尸/护甲数据读取
  - `knowledge/tags.js`：僵尸 tag 唯一规则表
  - `knowledge/worlds.js`：世界/tag 克制事实
  - `bridge/snapshot.js` / `bridge/briefing.js`：事实与简报
  - `bridge/actions.js` / `tools/router.js`：动作执行与校验
  - `in-game/agent.js`：模型编排、后台参谋、复盘
  - `in-game/prompt.js`：系统提示词
  - `bridge/plan.js`：结构化计划
  - `bridge/level-memory.js`：关卡记忆
  - `scripts/build-mechanics.mjs`：从游戏 JSON 生成 mechanics 数据
- 打包：
  ```bash
  cd pvz-llm-agent
  npm test
  npm run mechanics
  npm run pack
  ```

## 核心原则

1. **不压缩工具定义**：工具名、参数含义、返回 code 保持完整。
2. **计算在本地**：速度、ETA、EHP/DPS、出土时间、群体 DPS、墙支撑时间、克制覆盖全部由 `mechanics/stats` 算。
3. **LLM 只做决策**：选目标、定计划、选动作；不再心算数值。
4. **规则数据化**：新增僵尸/植物只加数据/规则，不在 `agent.js` 或 `snapshot.js` 写关卡 if。
5. **复盘只在关卡结束**：中途只记录事实，不写记忆。

---

## P0 — 正确性

### P0-1 LevelContext：开局给 LLM 完整关卡上下文

**问题**
- `pvz_briefing` 已有大量字段，但世界推断、单位能力、逐波威胁仍不完整，模型容易从零散字段自行推断。

**改动**
- 文件：`bridge/briefing.js`、`bridge/snapshot.js`、`in-game/prompt.js`
- 新增/明确 `levelContext`：
  - 世界、世界机制
  - 地形、障碍、墓碑逐行
  - 全部波次：类型、数量、EHP、固定行/随机行、flag
  - 全部僵尸：tags、counters、特殊字段
  - 卡池：数值、attack、reach、armTime、pierce/targets/multiDps
  - 历史/经验
- `levelFacts` 用资源名推断世界（如 `egypt1`），不再只看 `levelName/source.world`。

**验收**
- 任意关卡开局 `briefing.world` 不为空（能推断时）。
- 模型能在一次 briefing 中看到本关所有波次类型和卡池能力。

### P0-2 通用能力与克制审计

**问题**
- `TAG_COUNTERS` 仍偏向“tag → 卡名”，特殊机制容易漏。
- `coverageGaps` 只在当前/下一波生效，没有覆盖整关所有 wave。

**改动**
- 文件：`knowledge/tags.js`、`knowledge/worlds.js`、`bridge/mechanics.js`、`bridge/snapshot.js`
- 把 tag 映射为能力需求：
  - `group → multi_target`
  - `flying → anti_air`
  - `rolling → anti_rolling`
  - `armored / newspaper → high_dps / burst`
  - `crush / gargantuar → control / burst`
- 从卡牌 `attack.targets/pierceCount/multiDps/dps/armTime/reach` 推导卡组能力。
- `briefing` 输出整关 `coverageGaps`：
  - 本关所有 wave 的 tags 汇总
  - 卡组缺哪些能力
  - 建议补的卡（只给能力匹配事实，不写固定卡组）

**验收**
- 骆驼牌/旗帜波自动提示 `multi_target` 缺口。
- 滚桶关自动提示 `anti_rolling` 缺口。
- 新增僵尸不需要改关卡代码。

### P0-3 结构化计划与计划审计

**改动**
- 文件：`bridge/plan.js`、`tools/definitions.js`、`in-game/prompt.js`
- 计划 schema 固定 `pvz-plan/v1`：
  ```json
  {
    "schema": "pvz-plan/v1",
    "text": "给玩家看的中文摘要",
    "goal": "胜利条件",
    "deck": ["..."],
    "lanes": [{ "lane": 0, "role": "", "econ": [], "wall": 4, "output": [], "reserve": [], "notes": "" }],
    "counters": [{ "tag": "rolling", "card": "spikeweed", "lane": "all", "column": "c5-c7", "timing": "" }],
    "phases": [{ "id": "early", "untilWave": 3, "actions": [] }],
    "triggers": [{ "when": "airRaid.count>0", "action": "plant blover", "priority": 100 }],
    "emergency": [{ "when": "zombie on c3", "action": "squash/cherry" }],
    "thresholds": {}
  }
  ```
- `text` 给玩家；`lanes/counters/phases/triggers` 给快模型。
- 开局审计：
  - `coverageGaps` 非空、计划里没有对应 counter → warning，要求重写。
  - 计划卡组与实际 `actualDeck` 不一致 → warning。

**验收**
- 计划不再只是一段“卷心菜主力”的文本。
- 快模型能按 lane/counter/trigger 直接执行。

### P0-4 复盘与记忆

**规则**
- 只在关卡结束触发总结。
- 失败：必总结。
- 胜利但不完美（丢车/掉植物/保护格死亡/任务失败）：总结。
- 中途离开/重开且有损失：总结。
- 完美通关：不写。
- 丢车中途只记录事实，不写记忆。

**改动**
- 文件：`in-game/agent.js`、`bridge/events.js`、`bridge/level-memory.js`
- 复盘内容与 `plantsLost/mowersLost/flowers` 等硬数字校验。
- 记忆写入 `localStorage` 的 `pvzllm.levelMemory.v1`，按关卡 key 隔离。
- 复盘 note/lessons 只能引用快照里真实存在的僵尸/行/列。

**验收**
- 中途丢车日志不出现“丢车总结”。
- 关卡结束一定写入 note + lessons。
- 下一局 `briefing.history.lessons` 能读回。

### P0-5 并发安全

**问题**
- 玩家中途发指令如果直接插入 messages，会破坏 `assistant(tool_calls) -> tool` 顺序，导致 400。

**改动**
- `sendInstruction` 入队，只在安全点（本轮工具结果全部回填后）加入。
- 检查所有中途插入 user 消息的路径。

**验收**
- 工具执行中发指令、切模型、stop/resume 不再 400。

---

## P1 — 决策质量

### P1-1 计算层补全

已有：

- `laneMath`：killSec / etaSec / canKillBeforeHouse
- `minePlan`：地雷 latestSafeColumn / tooLate
- `airRaid`：空中窗口
- `instantAim`：一次性卡可投列
- `wallPlan`：墙血/支撑秒数/冷却/risk
- `counterMatrix` / `coverageGaps`
- `tomb`：墓碑逐行

待补：

- 多僵尸叠加啃墙：`wallSurviveSec` 按总 eatDps 计算
- 多行缺墙：`wallRebuildPlan`（墙冷却 vs 风险排序）
- 输出/墙位置：已有 `OUTPUT_IN_FRONT_OF_WALL`，补充批量预检
- 群体 DPS：`lanes.dpsGroup` 已在用，补测试
- `newspaperHp` / 护甲已计入 EHP，补回归测试

**验收**
- 模型不再自己算速度、EHP/DPS、出土、群体 DPS。

### P1-2 特殊机制声明化

用 `knowledge/tags.js` 的规则表覆盖：

- 巫师变羊、钢琴家换行、渔夫拉植物、章鱼封植物
- 渡渡鸟跳越、黄鼠狼放小怪、淘金者绕后
- 太阳神偷阳光、滚筒、飞行、报纸、成组

规则只描述“机制/需要什么能力”，不写“种哪张卡”。

**验收**
- 新单位只加规则，不改 `snapshot/agent`。

### P1-3 动作级校验

已有：

- `PROTECT_TOO_FAR`
- `PROTECT_CELL_BLOCKED`
- `WALL_TOO_LATE`
- `OUTPUT_IN_FRONT_OF_WALL`
- `MINE_TOO_LATE`
- `NO_AIR_TARGET`

待补：

- `BATCH_COOLDOWN`：同一批动作里同卡多次、冷却 >3.5s，提前返回“本轮最多成功几个”。
- `BATCH_CONFLICT`：同一格先种后铲/重复种等。

**验收**
- 不会一轮连发 3 个 20s 冷却的墙。
- 失败后模型能按返回改轮次/换卡。

---

## P2 — 成本与体验

### P2-1 Token / 延迟

- 不动工具定义。
- 可做：
  - `briefing.cards` 去掉 `weaknesses/usage` 等长字段（`pvz_knowledge` 保留全量）
  - `history` 只留最近 1–2 局 + lessons
  - 旧工具结果整段丢弃，不逐轮改写（保持缓存）
  - 每轮日志保留 `模型 ms / 工具 ms`
- 验收：单关 prompt token 下降，工具调用次数不增加。

### P2-2 UI / 记忆

- 思考窗显示 `[后台参谋]`
- 决策日志复制
- 记忆导出/导入
- 结构化 plan 按 lanes/counters/triggers 展示
- 关卡结束显示本局 note/lessons

### P2-3 测试与观测

- 扩展 `tests/mechanics.test.mjs`：
  - 群体 DPS
  - 墙支撑时间
  - 出土窗口
  - coverageGaps
- 增加回放/监测脚本：
  - 每轮 state、plan、动作、模型/工具耗时、guard code
- 每次改完：
  ```bash
  npm test
  npm run mechanics
  npm run pack
  ```

---

## 建议执行顺序

1. P0-1 LevelContext
2. P0-2 通用能力/克制审计
3. P0-3 计划审计
4. P0-4 复盘与记忆
5. P0-5 并发安全
6. P1-1 ~ P1-3
7. P2 成本与体验

## 已知风险

- 游戏 JSON 字段并不完全统一，部分机制只有图鉴文案；规则表要允许“文本关键词 → 能力”的兜底。
- `world` 推断依赖资源名（如 `egypt1`），自定义关卡可能没有；推断不到时明确返回 null，不猜。
- 群体/穿透/多行要分清：`PierceCount` 是同目标穿透，三线射手是多行不是同一行多目标。
- 复盘 LLM 仍可能编造，必须用 `plantsLost/mowersLost/lastZombies` 做硬校验。
- 不要为了降 token 删减工具定义或参数语义。

## 完成情况（0.1.26）

| 项 | 状态 | 实现 / 测试 |
|---|---|---|
| P0-1 LevelContext | 完成 | `bridge/briefing.js#levelContext`、`levelFacts` 资源名推断世界；`tests/bridge.test.mjs` |
| P0-2 能力/克制审计 | 完成 | `knowledge/tags.js#TAG_CAPABILITIES`、`knowledge/worlds.js#CAPABILITY_FACTS/TAG_COUNTERS.needs`、`bridge/mechanics.js#cardCapabilities/deckCapabilities/coverageAudit`；整关 tag 汇总在 `snapshot.brief.coverageGaps` / `briefing.coverageGaps`；`tests/mechanics.test.mjs`、`tests/bridge.test.mjs` |
| P0-3 计划审计 | 完成 | `bridge/plan.js#auditPlan`、`tools/router.js#pvz_set_plan`、`briefing.planAudit`、`plan_audit` 事件；`tests/plan.test.mjs` |
| P0-4 复盘与记忆 | 完成 | 结束才写 note+lessons、中途丢车只记录、note/lesson 行列校验；`tests/agent.test.mjs`、`tests/bridge.test.mjs`（history 读回） |
| P0-5 并发安全 | 完成 | `sendInstruction` 安全点入队；`tests/agent.test.mjs` |
| P1-1 计算层补全 | 完成 | `wallSurvive`（总 eatDps）、`wallRebuildPlan`、`batchPreflight`（墙前输出）；`tests/mechanics.test.mjs`、`tests/forecast.test.mjs`（报纸 EHP） |
| P1-2 特殊机制声明化 | 完成 | `knowledge/tags.js` 新增变羊/拉植物/封植物/跳越/召唤/绕后/偷阳光等规则；`snapshot.mechanicFacts` 直接读 `TAG_COUNTERS` |
| P1-3 动作级校验 | 完成 | `BATCH_COOLDOWN` / `BATCH_CONFLICT` / 同批墙前输出；`tests/router.test.mjs` |
| P2-1 Token/延迟 | 完成 | `briefing.cards` 去掉 `weaknesses/usage`；history 2 局；整段丢弃旧工具结果；每轮模型/工具耗时日志 |
| P2-2 UI/记忆 | 完成 | `[后台参谋]`、日志复制、记忆导出/导入、结构化计划展示、关卡结束 note/lessons |
| P2-3 测试与观测 | 完成 | `tests/mechanics.test.mjs` 扩展；`scripts/live-play.mjs` 采样 plan/timings/guardCodes；新增 `scripts/replay.mjs`（`npm run replay`） |

## 0.1.27 追加（玩家反馈）

| 问题 | 修复 |
|---|---|
| 地刺被种在墙后 | `stats.stepDamage`（图鉴 `AREA=本格` / 不会被啃食）识别地刺类；`actions.js` 不再把它当普通输出，新增 `SPIKE_BEHIND_WALL`（墙后→墙前可种位）；`batchPreflight` 同步拦截同批“先墙后地刺”。 |
| 黏毒豌豆等真伤/毒伤没被选择 | `stats` 读取 `ProjectileProps/ProjectileTypes`：`poison{dps,duration,stacks,total,slow}`、`attack.ignoresArmor`、`effectiveDps`；`cardCapabilities` 增加 `true_damage`；`armored` 缺口改为 `high_dps` 或 `true_damage` 任一即可。 |
| 丢植物被算作不完美 | `isPerfectRun` 不再看 `plantsLost`：只有丢车、保护格死亡、任务失败才算不完美；胜利只损失植物不写复盘。 |
