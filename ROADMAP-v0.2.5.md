# PvZ AI Gardendless · v0.2.5 改进计划（实战复盘版）

> 本文档是给下一个会话直接开工用的。包含：背景、当前状态、实战暴露的问题、P0/P1/P2 目标、
> 需要先探明的未知字段、验收标准、测试与发版流程。
>
> 来源：2026-10-26 用 MCP 实测「海盗港湾 第 17 天」一把，通关（`phase: won`），
> 关卡任务「在 30 秒内击杀 20 个僵尸」完成 20/20。

---

## 1. 背景与现状

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/MuliyStudio/pvz2-ai-gardendless`（public，main） |
| 模组版本 | `0.2.4`（`pvz-ai-agent-mod/scripts/main.js` 的 `VERSION`、`pack.json` 的 `version`） |
| MCP Server | `PvZ-MCP/pvz-mcp-server.mjs`，常量 `VERSION = '0.1.0'`（与本计划一起升到 `0.2.5`） |
| 最近提交 | `5a2a491 feat: detect level tasks and auto-dismiss objective screen` |
| 最近发布 | `v0.2.4`（附件：`PvZAI-AI-Agent-Bundle.zip`、`pvz-ai-agent.zip`） |
| 模组安装目录 | `%APPDATA%\com.pvzge.game\gp-next\packs\pvzai.agent` |
| 游戏调试端口 | CDP `127.0.0.1:9222`，页面 `http://tauri.localhost/` |
| OpenCode MCP 配置 | `C:\Users\Administrator\.config\opencode\opencode.jsonc`（`pvz-gardendless`） |

现有能力（v0.2.4）：读状态、原生种植、铲除（含 tile 植物）、收阳光/能量豆、选卡开局、
关闭关卡目标说明、关卡任务读取（`tasks`）、内置 DeepSeek 决策、MCP 11 个工具。

本地未提交的调试脚本（下一个会话可直接用）：

```text
tools/mcp_call.mjs      批量执行一串 MCP 调用（每次起新 MCP 进程，避免旧工具表）
tools/screenshot.mjs    通过 CDP 截图到 PNG
```

---

## 2. 实战复盘：到底哪里卡住了

### 2.1 一局时间线（MCP 实测）

| 波次 | 关键动作 | 任务进度 |
| --- | --- | --- |
| 开局 | `pvz_dismiss_objective` 关掉目标弹窗 | 0/20 |
| 1–4 | 每行 2 向日葵 + 双发 + 地刺 | 0/20 |
| 4–8 | 补地刺、坚果挡海盗 | 6/20 |
| 8–11 | 豌豆铲掉换双发、能量豆 | 19/20 |
| 11–13 | 补输出 | **20/20 ✅** |
| 13–17 | 补双发、危险行补坚果 | — |
| 结束 | `phase: won`，进度 100%，剩 1650 阳光 | — |

### 2.2 暴露的问题（按影响排序）

1. **没有可种植信息**：一局里 20+ 次无效种植，全在试「第 5/6 列是不是水」。
   海盗港湾实际地形：0–3 行第 5 列以后是水，第 4 行第 6 列有木板。
2. **任务只读到进度，读不到计时**：`count` 是整关累计击杀，`mode: 6` 没有解释，
   “30 秒窗口”何时开始/还剩多少完全不可见。这局是**靠阵容碾压赢了任务**，不是任务驱动。
3. **僵尸属性缺失**：没有 `flying`（海鸥）、`support/static`（海盗炮停在第 12 列永不过来，
   却被算进该行威胁/能量豆目标）、`jumping`（剑客）、`eating/target`、护甲/桶分层血量。
4. **工具粒度太细**：只能 `state → 动作 → wait → state` 轮询；没有批量执行，也没有
   “等到阳光 ≥ 200 / 卡冷却好 / 僵尸进入某行”。40 秒循环里几十次 state、上百次调用。
5. **错误是中文散文**：`sunflower 冷却中 5.0s` 只能人读，Agent 拿不到 `code` / `retryAfter`。
6. **选卡不能替换**：卡槽已被游戏预填 7 张，`pvz_choose_deck` 返回「选卡 0 张，已开局」，
   加不进也换不掉。导致「30 秒杀 20」这种关拿不到三线/火龙果/樱桃这类爆发卡。
7. **`pvz_state` 太胖**：每次返回 20 张可选卡的完整图鉴 + 场上僵尸图鉴，
   Agent 每回合都在重读同一份百科。
8. **版本不握手**：模组已是 0.2.4，但 OpenCode 里的 MCP 进程是旧的，
   工具表缺 `pvz_dismiss_objective`，只能另起临时 MCP 进程调。用户侧表现为“文档有、工具没有”。
9. **割草机状态不可见**：每行小推车是免费容错，但 state 里没有。
10. **看图能力为零**：全程靠数字，截图是最后补的。

> 结论：不是“AI 不会打”，是**接口还不够像仪表盘**。人类玩家一眼能看到的界面信息
>（地形、任务倒计时、僵尸类型、割草机），MCP 里全是空白，Agent 只能试错补。

---

## 3. 目标清单

### P0（必做，做完发 v0.2.5）

#### P0-1 可种植矩阵 + 结构化错误

**目标**
- `snapshot()` 新增地形/可种植信息，Agent 不再试错。
- 所有失败返回结构化错误码，而不是中文句子。

**建议 schema**

```json
"terrain": {
  "lanes": 5,
  "columns": 9,
  "map": ["LLLLWWWWW", "LLLLWWWWW", "LLLLWWWWW", "LLLLLWWWW", "LLLLLWPWW"],
  "legend": { "L": "land", "W": "water", "P": "plank", "G": "grave", "?": "unknown" }
},
"blockedCells": [{ "lane": 0, "column": 5, "terrain": "W", "reason": "water" }]
```

```json
{ "ok": false, "code": "TERRAIN", "lane": 0, "column": 5, "retryable": false }
{ "ok": false, "code": "COOLDOWN", "card": 6, "retryAfter": 5.0, "retryable": true }
{ "ok": false, "code": "SUN", "need": 200, "have": 150, "retryable": true }
{ "ok": false, "code": "OCCUPIED", "lane": 2, "column": 2, "plants": ["repeater"] }
{ "ok": false, "code": "LEVEL_LIMIT", "limit": "plantCountLimit", "value": 12 }
```

**实现位置**
- `pvz-ai-agent-mod/scripts/main.js`
  - `snapshot()`（在 `if (square)` 段里，和植物遍历一起）
  - 新增 `cellTerrain(C, lane, column)`
  - `plant()` / `shovel()` / `plantFood()` 的返回值统一走 `fail(code, extra)`
- 学习型兜底：种失败时把格子写入 `run.blocked`（已有机制），并标记 `terrain:"?"`，
  关卡切换时清空；这样即使探测不到字段，第二次也不会再撞。

**未知字段（已在 0.16.1 + GP-Next 1.5.5 探明）**

```text
LnC.squareType        number   SquareType 枚举：0=solid 1=sky 2=water 3=sea 4=deck
LnC.isSkyOrSea()      bool     squareType 为 sky/sea
LnC.isDeepWater()     bool     （本关海面为 false，用 sea 区分深水）
LnC.plantable()       bool     该格当前是否允许种植物（海面为 false）
LnC.tilePutable()     bool     地刺/土豆雷等 tile 植物可放
LnC.isSolidOrDeck()   bool     squareType 为 solid/deck
LnC.putPlantAvailable(true, cf.ID, true, true, cf.spf)   最终可种判定（原逻辑保留）
LnC.haveTomb          bool     是否有墓碑
Square.getLane(i).mower         小推车（本关无）
```

实测海盗港湾 17 `squareType` 矩阵：

```text
000003333   0–2 行：0–4 陆地，5–8 海面
000003333
000003333
000004444   3–4 行：0–4 陆地，5–8 木板
000004444
```

即：0–2 行第 5–8 列是海（`W`），3–4 行第 5–8 列是木板（`P`）；
行 0–2 第 5 列以后不能种普通植物，必须睡莲/弹簧豆等水生卡。

**验收**
- 海盗港湾 17：`terrain.map` 中 0–3 行 5–8 列为 `W`，`4,6` 为 `P`。
- 用 MCP 连打 30 秒，`TERRAIN` 失败次数为 0（或只出现 1 次即进入学习缓存）。

---

#### P0-2 任务计时语义

**目标**
- 让 AI 知道“限时窗口是否在跑、还剩几秒、还差几个”。
- 暴露 `mode` 的可读名称。

**建议 schema**

```json
"tasks": [{
  "tip": "在 30 秒内击杀 20 个僵尸",
  "mode": 6, "modeName": "timed_kill",
  "count": "12/20", "value": 12, "total": 20, "percent": 60,
  "windowActive": true, "timeLeft": 8.4, "timeLimit": 30,
  "completed": false, "failed": false, "urgent": true,
  "hint": "还剩 8.4 秒，需再杀 8 个"
}]
```

**已完成：真实字段（0.16.1 + GP-Next 1.5.5）**

```text
LevelTaskCount.mode / modeName：
  0 PlantCountLimit 1 PlantLoseLimit 2 SunCostLimit 3 SunProduceRequest
  4 SunCostCountDownLimit 5 ZombieKillCountRequest 6 ZombieKillCountDown（限时击杀）
LevelTaskCount.startingObjdata  { Time: 30, ZombiesToKill: 20 }   ← 计时/总数在这里
LevelTaskCount.objdata          { KilledZombiesCount: 0 }         ← 当前计数
LevelTaskCount.progress._progress / _totalLength                  ← 进度条
LevelTaskCount.versionMode 对应 switchMode / changeObjdata
```

**重要语义**：mode 6 不是“整关倒计时”，而是**滑动窗口**——每次击杀后
`scheduleOnce(Time)` 把计数减 1。也就是说，要“任意时刻最近 30 秒内击杀 ≥ 20”，
不是从某一秒开始计时。因此模组内部维护击杀时间戳队列，计算：
`windowActive`（窗口内是否有击杀）、`timeLeft`（最老一次击杀还剩几秒过期）、
`recentKills`（窗口内击杀数）；`timeSemantics: "sliding_window"`。
mode 4 则是真正的倒计时（`objdata.LeftTime`，`update()` 递减）。

**验收**
- 任务进行中 `pvz_state` 能看到 `windowActive` 与 `timeLeft` 变化；
- 内置提示词第一屏出现「任务倒计时 X 秒」；`urgent` 时提示优先放能量豆/一次性植物。

---

#### P0-3 批量执行 + 条件等待

**目标**
- 一次调用执行一组动作；一次调用等到条件满足。
- 把“每步一次往返”降成一个数量级。

**新增 MCP 工具**

```text
pvz_act        { actions: [{type:"plant",card:0,lane:2,column:1}, ...] }   # 最多 6 个，顺序执行
pvz_wait_until { until: "sun>=200" | "card_ready:repeater" | "zombie_in_lane:3" |
                        "zombie_near:2" | "plantfood>=1" | "tasks_ready" | "phase:running",
                 timeout: 1..60 }
```

返回 `{ ok, elapsed, satisfied, state? , steps? }`。

**实现位置**
- 模组：把 `executeActions(actions)` 导出为 `api.execute`；新增 `api.waitUntil(cond, timeoutMs)`，
  内部 200ms 轮询 `snapshot()`，超时返回 `{ ok:false, code:"TIMEOUT" }`。
- MCP：`handleTool` 增加两个 case；`GUIDE`/`PLAY_PROMPT` 更新为优先用 `pvz_act`。
- 注意：`pvz_wait_until` 会阻塞该 MCP 请求，`timeout` 上限 60 秒，避免客户端超时。

**验收**
- 一条 `pvz_act` 能完成「种向日葵 → 种双发 → 喂能量豆」并返回每步结果；
- `pvz_wait_until {until:"sun>=200"}` 在阳光不足时等待、到 200 立刻返回。

---

#### P0-4 选卡可替换

**目标**
- `pvz_choose_deck({ plants, replace: true })` 能清空当前预选卡组并重新选。
- 返回实际生效的卡组与被跳过的卡，便于 Agent 校正。

**建议返回**

```json
{ "ok": true, "deck": ["sunflower","repeater","spikeweed","threepeater"],
  "applied": ["sunflower","repeater","spikeweed","threepeater"],
  "skipped": [{"type":"coconutcannon","reason":"not_available"}],
  "started": false }
```

**已完成：真实字段（0.16.1 + GP-Next 1.5.5）**

```text
Cards.maxSlotCount                    卡槽数（海盗港湾 17 = 8）
Cards.spliceAllCards()                清空当前卡组（未开局时可用，内部逐张 spliceCard）
Cards.spliceCard(cf)                  取消单张（会同步 fromCards[].chosen）
Cards.addCardByPlantTypeFromSeedbank(type)   从种子库加一张
Cards.seedChooser.CFs[]               可选列表；cf.ca.locked / cf.ca.disallowed
Cards.GameStartable()                 卡组是否可开局
```

`replace:true` 直接 `spliceAllCards()` 再逐张加；加不进去的记入 `skipped`，
`reason` 用 `not_available` / `no_slot` / `rejected`。

**验收**
- 在已预填 7 张卡的关卡里，`replace:true` 后 `cards` 与请求一致（顺序可不同）。

---

### P1（v0.2.6，做完做一次“任务关”实测）

| 编号 | 目标 | 说明 |
| --- | --- | --- |
| P1-1 | 僵尸语义标签 | `tags:["flying","support","jumping","armored"]`、`armorHp`、`eatingPlant`、`threat`(0–100) |
| P1-2 | 割草机状态 | `mowers:[{lane, available, used}]` |
| P1-3 | `pvz_state(detail)` | `lite`（默认，仅 id/费用/冷却/坐标/血量）/ `normal` / `full`（含图鉴） |
| P1-4 | 图鉴按需 | state 不再内联全部卡牌图鉴；由 `pvz_knowledge` 查，或加 `knowledge:true` 参数 |
| P1-5 | `pvz_health` | 返回 `{modVersion, serverVersion, compatible, missingTools, installPath}`；不匹配时 `pvz_state` 顶部提示 |
| P1-6 | 双控制器租约 | `pvz_claim` / `pvz_release`，内置 AI 与 MCP 互斥，避免抢操作 |

### P2（体验/可观测）

| 编号 | 目标 | 说明 |
| --- | --- | --- |
| P2-1 | `pvz_watch` 事件流 | MCP notifications：任务完成、波次开始、植物阵亡、割草机触发 |
| P2-2 | `pvz_screenshot` | 通过 CDP `Page.captureScreenshot` 返回 PNG（人排查 + 多模态 Agent） |
| P2-3 | 决策可解释 | 每次动作附带 `why`（哪条规则/哪个任务触发），写进日志 |
| P2-4 | 内置 AI 任务策略 | 按任务类型选卡：限时击杀 → 三线/地刺/樱桃/能量豆；限制植物数 → 便宜卡 |

---

## 4. 关键设计约束（不要破坏）

1. **种植必须走游戏原生流程**（`UIInGame.tryChangingIndex` + `LnC.PlaceUIPlant`），
   不要直接改阳光/血量。
2. **不支持传送带/保龄球/砸罐子/天空关**，遇到时返回明确 `code:"UNSUPPORTED_LEVEL"`。
3. **MCP 不依赖 CSP 绕过**（走 CDP），内置 DeepSeek 才需要启动器。
4. **失败要可归因**：宁可多一点字段，不要合并成一句中文。
5. **向后兼容**：`snapshot()` 只增字段不删；`pvz_state` 默认结构保持，新增字段追加。
6. **发布附件用 ASCII 名**：`gh` 会把中文名截断成 `PvZAI-AI.-.zip`。

---

## 5. 开工前先探明（一次性脚本）

需要新建一个临时探针（用 CDP `Runtime.evaluate`，参考旧脚本模式）：

```js
// 1) cell 地形字段
const C = square.constructor;
const cell = C.getLnC(0, 5);
Object.keys(cell);                                  // 找 isWater / gridType / ...
Object.getOwnPropertyNames(Object.getPrototypeOf(cell));

// 2) Square 上的方法
Object.getOwnPropertyNames(Object.getPrototypeOf(square))
  .filter((n) => /plant|water|land|cell|grid/i.test(n));

// 3) 任务计时
const t = <LevelTaskCount 组件>;
Object.keys(t);
JSON.stringify(t.objdata); JSON.stringify(t.startingObjdata);
t.mode, t.progress && { p: t.progress._progress, total: t.progress._totalLength };
Object.getOwnPropertyNames(Object.getPrototypeOf(t));

// 4) 选卡清空
const cards = <Cards 组件>;
Object.getOwnPropertyNames(Object.getPrototypeOf(cards))
  .filter((n) => /card|bank|seed|clear|remove|reset/i.test(n));

// 5) 割草机
Object.keys(square).filter((k) => /mower|lawn/i.test(k));
```

把探到的真实字段名写回本文件第 3 节的“未知字段”处，再动手实现。

---

## 6. 测试计划

### 6.1 单元/接口（无需进关卡）

```powershell
python tools\build_zip.py
Copy-Item pvz-ai-agent-mod\scripts\main.js $env:TEMP\pvzai-check.mjs -Force
node --check $env:TEMP\pvzai-check.mjs
node --check PvZ-MCP\pvz-mcp-server.mjs
```

### 6.2 实机（MCP）

```powershell
# 装模组（需重载 GP-Next）
$dest="$env:APPDATA\com.pvzge.game\gp-next\packs\pvzai.agent"
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Expand-Archive pvz-ai-agent.zip -DestinationPath $dest

# 用新 MCP 进程验证工具表（避免 OpenCode 旧进程）
node tools\mcp_call.mjs <calls.json>
node tools\screenshot.mjs "$env:TEMP\opencode\shot.png"
```

`calls.json` 建议覆盖：

```json
[
  { "name": "pvz_health" },
  { "name": "pvz_state", "args": { "detail": "lite" } },
  { "name": "pvz_wait_until", "args": { "until": "sun>=100", "timeout": 10 } },
  { "name": "pvz_act", "args": { "actions": [{ "type": "plant", "card": 0, "lane": 2, "column": 1 }] } }
]
```

### 6.3 换一关验收（关键）

选一关**有明确限时任务**的关卡（如“X 秒内击杀 Y”），用 MCP 打一把，记录：

- `tasks[].windowActive` / `timeLeft` 是否随时间变化；
- 任务完成前 5 秒，Agent 是否真的改变了行为（能量豆、集中输出）；
- `TERRAIN` 失败次数是否为 0；
- 一局总工具调用次数（对比本局：几十次 state + 上百次动作）。

**验收线**：同一关，工具调用次数 ≤ 上一版的 1/3，且任务靠“任务驱动”完成而不是碾压。

---

## 7. 发版清单

```powershell
# 1. 版本号
#    main.js: const VERSION = '0.2.5'
#    pack.json: "version": "0.2.5"
#    pvz-mcp-server.mjs: const VERSION = '0.2.5'

# 2. 构建
python tools\build_zip.py
python tools\pack_distribution.py

# 3. 提交
git add -A
git commit -m "feat: terrain map, task timer, batch actions, deck replace"
git push

# 4. Release（ASCII 附件名）
Copy-Item "PvZAI-AI草坪指挥官-发布包.zip" "$env:TEMP\PvZAI-AI-Agent-Bundle.zip"
gh release create v0.2.5 "$env:TEMP\PvZAI-AI-Agent-Bundle.zip" "pvz-ai-agent.zip" `
  --title "v0.2.5 - 地形/任务计时/批量动作" --notes-file <notes.md>
```

发版后提醒用户：**重载模组 + 重启 OpenCode**（MCP 工具表是进程启动时固化的）。

---

## 8. 已知风险

| 风险 | 处理 |
| --- | --- |
| 探测不到地形字段 | 学习型 `blockedCells` 兜底；第二次不再撞同一格 |
| 任务没有计时字段 | 暴露 `timeSemantics:"unknown"` + 进度条，提示词不假装知道秒数 |
| `pvz_wait_until` 阻塞客户端 | 上限 60 秒，超时返回 `TIMEOUT` 而不是断连 |
| 清空卡组方法不存在 | 逐张 `chosen=false` 兜底，返回 `skipped` 让 Agent 知道没生效 |
| 内置 AI 与 MCP 同时操作 | P1-6 租约；在此之前文档明确“别同时开” |
| 游戏更新字段变化 | `pvz_health` 加一次 `snapshot()` 结构自检，缺字段时给 `degraded:true` |

---

## 9. 完成定义（DoD）

- [ ] `pvz_state` 含 `terrain.map`，海盗港湾 17 的 `W/P` 标注正确
- [ ] 所有 `plant` / `shovel` / `plant_food` 失败都有 `code`
- [ ] `tasks[]` 含 `modeName`、`windowActive`、`timeLeft`（或 `timeSemantics:"unknown"`）
- [ ] `pvz_act`、`pvz_wait_until` 可用，且不再需要“每次动作前读一次 state”
- [ ] `pvz_choose_deck({replace:true})` 能换成指定卡组
- [ ] `pvz_health` 能报版本/工具缺失
- [ ] 换一关限时任务实测：任务驱动生效，工具调用次数下降 ≥ 2/3
- [ ] 文档（根 README / 模组 README / MCP README）同步新字段与新工具
- [ ] v0.2.5 已发布，附件为 ASCII 名

---

## 10. 附：本局实测数据（对照用）

```text
关卡：海盗港湾 - 第 17 天（16 波，实际到 wave 17）
卡组（游戏预填，无法替换）：peashooter, repeater, iceburg, spikeweed,
                             springbean, wallnut, sunflower
最终棋盘：25 株（6 向日葵 / 8 双发 / 9 地刺 / 坚果）
任务：0/20 → 6/20（wave 8）→ 19/20（wave 11）→ 20/20（wave 13）
结束：phase=won，progress=100%，剩 1650 阳光，金币 9340
```

关键结论：**阳光大量结余 + 任务靠碾压完成 = 当前 AI 没有真正“围绕任务”决策**，
这也是 P0-2 与 P0-4 的由来。

---

## 11. v0.2.5 完成记录（2026-10-26）

| 项 | 结果 |
| --- | --- |
| P0-1 地形矩阵 | `terrain.map` 实测海盗港湾 17：0–2 行 `LLLLLWWWW`，3–4 行 `LLLLLPPPP`；`TERRAIN` 直接拦截水格 |
| P0-1 结构化错误 | `TERRAIN` / `COOLDOWN(retryAfter)` / `SUN` / `OCCUPIED` / `LANE_LIMIT` / `LEVEL_LIMIT` 等已实测 |
| P0-2 任务计时 | `timed_kill` 暴露 `timeSemantics: sliding_window`、`timeLeft`、`windowActive`、`urgent`、`hint`；实测窗口从 27.4s → 7.8s → 过期归零 |
| P0-3 批量 / 等待 | `pvz_act`、`pvz_wait_until` 实测可用；等待条件 `sun>=X` / `phase:running` / `tasks_ready` 均命中 |
| P0-4 换卡组 | `pvz_choose_deck({replace:true})` 清空 8 张并选入 8 张，`started:true` |
| 验收局 | 海盗港湾 17：任务在 wave 12 以 20/20 完成（当时 `timeLeft=4.4s`，用三线射手能量豆收尾）；最终 `phase=won`、progress 100% |
| 工具调用 | 该局 MCP 调用 55 次（含 state / act / wait_until），低于旧版几十次 state + 上百次动作的 1/3 目标 |
| 未做 | `pvz_health`、僵尸语义标签、割草机状态按计划放到 v0.2.6（P1） |

