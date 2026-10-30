# pvz-llm-agent 需求基线

> 版本：2026-10-29  
> 状态：需求已确认，等待新会话实现  
> 当前实现状态：旧 `pvz-agent` 最新为 0.3.1，已构建但**不符合本需求、未验收**；新项目从 `pvz-llm-agent/` 重新开始。  
> 旧 `pvz-agent`：冻结，不再作为决策层；只允许复用 `bridge` 的读状态/执行动作/事件能力。

---

## 1. 一句话目标

做一个**方便 LLM 思考和决策的 agent 工具**：

- LLM 负责查资料、制定策略、选卡、实时决策。
- 代码只负责提供事实、执行动作、返回真实结果。
- 不允许代码自己写一套本地 agent 替 LLM 做决定。

---

## 2. 核心原则（必须遵守）

1. **LLM 是唯一决策者。**
2. 工具层只做四件事：
   - 给事实：关卡、任务、地图、世界机制、波次、僵尸、卡池、图鉴
   - 执行动作：选卡、开局、种植、铲除、换卡、能量豆、矿车
   - 返回真实结果：成功/失败 code、冷却、阳光、占用、上限
   - 记录 LLM 的计划：`set_plan` 只存下来，不参与本地决策
3. **工具层不做：**
   - 不生成“建议卡组”
   - 不修正 LLM 的卡组
   - 不自动补卡
   - 不跑本地策略队列
   - LLM 不可用就停，不本地接管
4. **两个入口，共用同一套工具：**
   - 外部 MCP：Claude / Cursor / OpenCode 等
   - 游戏内 LLM 客户端：浮窗填 Key，用 OpenAI 兼容的 tool calling
5. 游戏内思考窗只展示 LLM 的推理/工具调用/计划/执行结果，**不展示本地建议**，不打印整段原始 JSON。

---

## 3. 已确认的用户决策

| 问题 | 决定 |
|---|---|
| 主决策者 | 外部 MCP + 游戏内 LLM 客户端，两者共用同一套工具 |
| LLM 不可用/返回非法结果 | 停住并返回错误，让 LLM 重选；不自动本地接管 |
| 代码组织 | 新建 `pvz-llm-agent/` 干净目录 |
| 选卡 | 选卡阶段把所有数据给 LLM；LLM 查图鉴/资料后自己决定卡组，再调选卡工具 |
| 本地卡池建议/卡组修正 | 删除，不再出现 |
| 本地策略队列 | 不作为默认决策路径；LLM 不可用时不启动 |

---

## 4. 新目录结构

```text
pvz-llm-agent/
  bridge/          只读状态 / 执行动作 / 事件，不含策略
  tools/           工具定义 + handlers（MCP 和游戏内共用）
  mcp/             MCP stdio server
  in-game/         游戏内 LLM 客户端 + slim pack
  knowledge/       植物/僵尸/关卡事实
  tests/
```

### 复用与删除

**复用：**

- `snapshot()`：结构化状态
- `act()` / `actAll()`：执行动作
- `events()`：增量事件
- `knowledge`：植物/僵尸/关卡事实
- 图鉴/护甲/地形/墓碑解析

**不进入新决策链：**

- `core/bind` 的行绑定/优先级
- `core/queue` 的本地任务队列
- `core/deck` 的自动卡组
- `strategist` 的本地 S0/S1 策略
- `setStrategy / autoDeck / suggestDeck / alignStrategy`
- 任何“模型选错了我来改”的逻辑

---

## 5. 开局/选卡流程

### 5.1 选卡前：把数据全部给 LLM

`pvz_briefing` 在 `objective / preparing` 阶段必须返回：

- 关卡任务/目标原文
- 世界地图/关卡来源/自定义关卡说明（字段不存在就返回 `null`）
- 世界机制：海盗地图有水、水面/甲板/天空行、潮汐、矿车、恐龙、传送门、墓碑、特殊格等
- 本关波次、每波僵尸类型/数量、总 EHP、旗波
- 僵尸数值：hp、护甲、ehp、速度、啃食 dps、标签、图鉴简介、克制提示
- 地形/障碍：每行每格 squareType、水面/甲板/天空/陆地、墓碑/霉斑/冰块/滑轨等
- 可种格 `plantable`、不可种格 `blockedCells`
- 当前卡槽/槽位数/植物上限/起始阳光
- 全部可用卡：费用、冷却、血量、DPS、产阳光（白天/夜晚）、射程、弹道、图鉴简介、特殊说明、用法（自动/点击/点击耗阳光/只能墓碑/只能冰块/被啃食）
- 当前已选卡组（如果有）

**不返回“推荐卡组”，不返回“本地建议”。**

### 5.2 LLM 自己查资料

LLM 可以调：

```text
pvz_knowledge({ type: "sunshroom" })
pvz_knowledge({ type: "pirate_armor1" })
pvz_knowledge({ query: "海盗 水 僵尸" })
```

返回图鉴、数值、克制、用法、交互说明。工具只给事实，不给结论。

### 5.3 LLM 制定策略

LLM 自己决定：

- 风格
- 卡组
- 每行职责
- 关键阈值
- 应急方案

调 `pvz_set_plan` 记录计划（只存，不执行）。

### 5.4 LLM 选卡

```text
pvz_choose_deck({ cards: ["sunflower", "wallnut", ...], replace: true })
```

工具只做校验和执行：

- 卡不在卡池 → `CARD_NOT_AVAILABLE` + 可用卡列表
- 重复/超槽位 → `BAD_DECK`
- 不足槽位 → `DECK_NOT_FULL` + 还差几张
- 合法 → 逐张选卡、等待 UI 同步、返回真实 deck

**绝不自动补卡，绝不替换 LLM 的卡。**

### 5.5 开局与实时循环

```text
pvz_start_level
→ pvz_state / pvz_events
→ LLM 决策
→ pvz_act({ actions: [...] })
→ pvz_wait_until
→ 重复
```

实时动作由 LLM 决定；工具只执行并返回真实结果。

---

## 6. 工具契约（MVP）

| 工具 | 作用 |
|---|---|
| `pvz_briefing` | 开局/选卡全量事实：任务、世界、地形、波次、僵尸、卡池 |
| `pvz_knowledge` | 植物/僵尸/关卡图鉴查询 |
| `pvz_state` | 实时状态：阳光、卡槽、植物、僵尸、波次、任务、棋盘 |
| `pvz_events` | 增量事件：波次、丢车、植物损失、新威胁、任务紧急 |
| `pvz_set_plan` | 记录 LLM 的整关计划（只存不用） |
| `pvz_choose_deck` | LLM 指定卡组；只校验+执行，不补卡 |
| `pvz_start_level` | 开局 |
| `pvz_act` | 精确动作：plant / replace / shovel / plant_food / move_cart / resume / wait |
| `pvz_wait_until` | 等阳光/冷却/僵尸进某行/任务完成 |
| `pvz_collect` | 收阳光/能量豆/金币 |
| `pvz_plant_food` | 能量豆 |
| `pvz_move_cart` | 矿车 |
| `pvz_resume` | 暂停恢复 |
| `pvz_dismiss_objective` | 关闭任务说明弹窗 |
| `pvz_health` | 版本/能力检查 |

> 工具参数和返回结构在实现前先单独写 `tools/definitions`，由用户确认后再写 handler。

---

## 7. 选卡 bug（必须修）

当前 `chooseDeck` 实测出现：

```text
选卡未满（1/8）
DECK_INCOMPLETE
```

原因：加卡是异步的，工具/本地逻辑只等到第一张 `sunflower` 就继续了。

新实现要求：

1. 逐张加卡，每张后等待 UI 同步/轮询 `cards.CFs.length`
2. 最终校验 `actualDeck.length`
3. 不足槽位返回 `DECK_NOT_FULL`，不要自动补
4. 不把 `DECK_INCOMPLETE` 用本地补卡掩盖
5. 选卡结果必须返回 `applied / skipped / missing / actualDeck`

---

## 8. 思考窗/UI 要求

游戏内 LLM 客户端显示：

- LLM 的推理/thinking（如果有 `reasoning_content`）
- LLM 调用了哪个工具、参数是什么
- 工具返回的真实结果（成功/失败 code）
- 当前计划（风格/卡组/每行职责/阈值）
- 实时状态摘要
- 失败原因和下一步建议（由 LLM 给出，不是本地规则）

**不显示：**

- “本地卡池建议”
- “卡组修正”
- 整段原始 JSON
- 本地策略队列日志

---

## 9. 验收标准（新基线）

只有满足以下条件才算“能正常用”：

1. 用 `PvZAI_Launcher.exe` 启动，填真实 LLM Key
2. LLM 自己选卡，工具不自动补卡/不修正卡组
3. 选卡一次成功（8/8）或明确返回 `DECK_NOT_FULL`
4. 标准关卡从选卡打到胜利/至少第 10 波，不需要手动干预
5. 不出现“阳光堆着不用、只种经济不种输出”
6. 同一行不反复撞 `CELL_BLOCKED`
7. LLM 的实时 `act` 能改变战局（不是本地队列在跑）
8. 思考窗可读，无原始 JSON/本地建议
9. 无控制台报错
10. 提供 `acceptance-report.json` 或完整工具调用日志

> 旧 `tools/acceptance.mjs` 可以改造成新架构的验收工具，但必须先去掉本地决策指标。

---

## 10. 已知环境限制

- 游戏内 LLM 模式需要启动器解除 WebView2 CSP；否则 `Failed to fetch`
- Tauri `plugin:http|fetch` 当前被 ACL 拒绝，不能依赖
- MCP 模式不需要 CSP，但需要启动器开调试端口
- 不要同时启用旧 `AI 草坪指挥官` 和新 agent，会抢操作

---

## 11. 新会话启动指令

新会话先读本文件，然后：

1. 不要直接写代码；先确认 `pvz_briefing` / `pvz_choose_deck` / `pvz_act` 的字段和错误码
2. 不要复用旧 `core/queue`、`core/deck`、`strategist`
3. 不要安装插件、不要改 `%APPDATA%`
4. 先建 `pvz-llm-agent/` 目录和 `tools/definitions`
5. 先做只读工具和 `chooseDeck` 修复，再做动作工具
6. 每完成一层，先写测试再继续

---

## 12. 未决问题

1. `pvz_briefing` 是否要把世界地图/关卡来源/自定义关卡说明的**原始文本**全部带上？默认：能读到就带，读不到返回 `null`。
2. 游戏内 LLM 客户端是否必须支持不支持 tool calling 的模型？默认：MVP 只支持 OpenAI 兼容 tool calling。
3. MCP 是否需要同时支持 stdio 和 HTTP？默认：MVP 先 stdio。
4. 旧 `pvz-agent` 是否保留供回溯？默认：保留但冻结，不作为新入口。
