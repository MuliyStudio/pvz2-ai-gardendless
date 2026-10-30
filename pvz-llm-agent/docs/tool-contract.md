# 工具契约（v0.1.12）

> 运行时权威定义在 `tools/definitions.js`；错误码在 `tools/errors.js`。
> 本文是给接入方（MCP 客户端 / 游戏内客户端开发）看的字段与语义说明。

## 0. 边界

- **LLM 是唯一决策者。** 工具不生成推荐卡组、不修正卡组、不自动补卡、不跑本地策略队列。
- 工具只做：给事实、执行动作、返回真实结果、记录计划。
- `pvz_set_plan` 只保存，不解析成执行队列，不影响任何动作。
- 失败时返回真实 `code`，由 LLM 自己决定重试/换方案。

## 1. 坐标与生命周期

- `lane`：0–4，从上到下。
- `column`：0–8，从左（房子）到右（僵尸出生点）。
- `phase`：`menu | worldmap | objective | preparing | running | won | lost | other`
- 标准流程：

```text
objective   → pvz_dismiss_objective
preparing   → pvz_briefing → pvz_set_plan → pvz_choose_deck → pvz_start_level
running     → pvz_state / pvz_events → pvz_act → pvz_wait_until → 重复
won / lost  → 停止
```

## 2. 工具清单

### `pvz_briefing`

参数：无。

返回：

```json
{
  "ok": true,
  "version": "0.1.12",
  "phase": "preparing",
  "scene": "inGameScene",
  "objective": { "screenName": "...", "missions": ["..."], "active": false, "canContinue": true },
  "missionHints": ["..."],
  "level": {
    "name": "Pirate Seas - Day 1",
    "wave": 0,
    "waves": 8,
    "nextWaveIn": 20,
    "source": { "world": null, "levelId": null, "custom": false, "description": null, "scene": "inGameScene" },
    "world": { "key": "pirate", "name": "海盗港湾" }
  },
  "world": { "key": "pirate", "name": "海盗港湾", "mechanics": ["..."], "zombies": ["..."] },
  "terrain": {
    "lanes": 5,
    "columns": 9,
    "map": ["LLLLLWWWW", "..."],
    "squareTypes": [[0, 0, 0, 0, 0, 2, 2, 2, 2], ["..."]],
    "legend": { "L": "land", "W": "water", "P": "plank", "S": "sky", "R": "rail", "?": "unknown" },
    "blockedCells": [{ "lane": 0, "column": 3, "reason": "tomb" }],
    "plantable": [{ "lane": 0, "columns": [0, 1, 2] }],
    "obstacles": [{ "lane": 0, "column": 3, "type": "tomb", "name": "墓碑", "blocksPlanting": true, "blocksStraightShot": true, "removeBy": "gravebuster" }]
  },
  "waves": [
    {
      "wave": 1,
      "flag": false,
      "total": 1,
      "ehp": 190,
      "zombies": { "tutorial": { "count": 1, "ehpEach": 190, "ehp": 190 } },
      "rowsHint": [{ "type": "tutorial", "lane": 0 }],
      "extraFood": null
    }
  ],
  "zombies": [
    {
      "type": "tutorial",
      "name": "普通僵尸",
      "hp": 190, "armorHp": null, "ehp": 190,
      "speed": 0.185, "eatDps": 100,
      "tags": [], "brief": "...", "introduction": "...", "special": [], "weaknesses": []
    }
  ],
  "cards": [
    {
      "type": "sunflower", "name": "向日葵",
      "cost": 50, "cd": 5, "hp": 300, "family": "Sun", "range": null,
      "attack": null,
      "sun": { "stages": [25], "interval": 24, "intervalNight": 24, "perSecDay": [1.042], "perSecNight": [1.042], "paybackSec": 48 },
      "splash": null,
      "shot": { "kind": "none", "overObstacle": false, "blockedByStraightBlocker": false },
      "brief": "提供额外阳光", "introduction": "...", "special": [], "weaknesses": [],
      "usage": { "activation": "auto", "area": "single", "needs": [], "manual": false, "onlyTomb": false, "onlyIce": false, "contact": false }
    }
  ],
  "deck": { "slots": 8, "current": ["sunflower"], "gameStartable": false },
  "startingSun": 150,
  "plantLimit": 18,
  "constraints": [{ "id": "plant_limit", "text": "本关植物上限：18 株", "source": "objective" }],
  "mechanics": [{ "id": "water", "text": "存在水面/天空格：普通植物不能直接种在这些格子上", "source": "terrain" }],
  "plan": null,
  "planSavedAt": null,
  "facts": { "sun": 150, "plantFood": 1, "plantsOnLawn": 0, "zombiesOnLawn": 0, "totalWaveEhp": 380, "missionText": [] },
  "notes": ["..."]
}
```

- 不返回 `suggestedDeck`、`recommend`、`strategy` 等字段。
- 世界/关卡来源读不到时返回 `null`。

### `pvz_knowledge`

参数：

```json
{ "type": "sunshroom", "kind": "plant|zombie|level" }
{ "query": "海盗 水 僵尸", "kind": "zombie" }
```

返回二选一：

```json
{ "ok": true, "kind": "plant", "entry": { "...同 briefing.cards[0]..." } }
{ "ok": true, "query": "...", "matches": [{ "kind": "zombie", "type": "pirate", "name": "海盗僵尸", "brief": "..." }] }
```

错误：`BAD_QUERY`、`KNOWLEDGE_NOT_FOUND`（带 `matches`）。

### `pvz_state`

参数：无。

返回 `snapshot()`：

```json
{
  "ok": true,
  "version": "0.1.12",
  "scene": "inGameScene",
  "phase": "running",
  "paused": false,
  "sun": 175,
  "plantFood": 1,
  "level": { "name": "...", "wave": 3, "waves": 8, "nextWaveIn": 12, "gameStarted": true, "source": {...}, "world": {...} },
  "cards": [{ "index": 0, "type": "sunflower", "name": "向日葵", "cost": 50, "cd": 0, "cdReady": true, "affordable": true, "sunShort": 0, "ready": true, "cooling": false, "stats": {...} }],
  "deck": ["sunflower", "..."],
  "seedSelection": { "slots": 8, "current": ["..."], "gameStartable": false, "availableCount": 42, "available": [{ "type": "...", "name": "...", "cost": 50, "chosen": true }] },
  "plants": [{ "lane": 0, "column": 0, "type": "sunflower", "name": "向日葵", "hp": 300, "maxHp": 300, "atk": null, "shot": {...} }],
  "zombies": [{ "lane": 2, "column": 6.4, "type": "dark_armor2", "name": "铁桶农夫", "hp": 190, "maxHp": 650, "armorHp": null, "armorMax": 460, "ehp": null, "ehpMax": 650, "tags": ["armored"] }],
  "board": [{ "lane": 0, "cells": ["sunflower", null], "terrain": ["L", "L"], "zombies": [] }],
  "lanes": [{ "lane": 0, "zombies": 0, "nearestZombie": null, "shooters": 0, "walls": 0, "plants": 1, "dps": 0, "wallHp": 0, "ehp": 0, "ehpExact": true, "mower": true }],
  "terrain": { "lanes": 5, "columns": 9, "map": ["..."], "legend": {...} },
  "blockedCells": [], "plantable": [], "obstacles": [], "mechanicFacts": [], "mechanics": [],
  "levelScript": { "waveCount": 8, "flagInterval": 4, "waves": [...], "lanePolicy": {...}, "lawn": {...}, "modules": [] },
  "zombieStats": { "tutorial": { "hp": 190, "ehp": 190, "speed": 0.185, "eatDps": 100, "tags": [] } },
  "carts": [{ "id": 0, "lane": 2, "column": 0, "railLanes": [1, 2, 3], "plants": [], "canUp": true, "canDown": true }],
  "tasks": [{ "key": "...", "tip": "...", "count": "3/10", "mode": 5, "modeName": "kill_count_request", "value": 3, "total": 10, "completed": false, "failed": false, "urgent": false, "hint": "..." }],
  "objective": { ... },
  "missionHints": ["..."],
  "limits": { "plantLimit": 18, "plantsPlanted": 6, "plantsLeft": 12, "slots": 8 },
  "plantLimit": 18,
  "startingSun": 150,
  "collect": { "total": 12, "kinds": { "sun": 12 } },
  "plan": { "...": "LLM 自己写的计划" },
  "planSavedAt": "2026-10-29T..."
}
```

说明：

- `cards[].cdReady` 是冷却好了，`affordable` 是买得起，`sunShort` 还差多少阳光（买得起是 0）；`ready` 只有两者都满足才是 true。
- `zombies[].armorHp` 是护甲当前血量（引擎读不到时是 `null`）；`ehp = hp + armorHp`，`ehpMax = hp + armorMax` 是上界。别只看 `hp`。
- `lanes[].ehp` 是本行在场上僵尸的剩余 EHP 合计；`ehpExact=false` 表示其中有读不到护甲的血量，只是上界。
- `lanes[].dps` 是本行植物 `attack.dps` 之和；`wallHp` 是坚果类当前血量之和。都是可验算的事实，不是“够不够”的结论。
- `plantable` 已排除：已有植物、障碍格、水面 `W`、天空 `S`；特殊卡（睡莲等）仍需按图鉴判断。

### `pvz_events`

参数：`{ "limit": 1..200 }`（可选）。

返回数组：

```json
[
  { "t": "wave_started", "wave": 3, "types": ["tutorial"], "ehpTotal": 380, "detail": "第3波 tutorial", "at": "..." },
  { "t": "lane_threat", "lane": 1, "nearestCol": 2.4, "count": 2, "walls": 0, "shooters": 1, "detail": "...", "at": "..." },
  { "t": "mower_lost", "lane": 0, "detail": "...", "at": "..." },
  { "t": "plant_lost", "lane": 0, "detail": "sunflower @c1", "at": "..." },
  { "t": "card_ready", "types": ["wallnut"], "detail": "wallnut", "at": "..." },
  { "t": "zombie_new", "types": ["pirate_captain"], "detail": "...", "at": "..." },
  { "t": "task_urgent", "detail": "...", "at": "..." },
  { "t": "task_done", "detail": "...", "at": "..." },
  { "t": "task_failed", "detail": "...", "at": "..." },
  { "t": "level_won", "detail": "关卡胜利", "at": "..." },
  { "t": "level_lost", "detail": "关卡失败", "at": "..." }
]
```

去抖：同 `t + lane + detail` 2.5 秒内合并；队列上限 200。

### `pvz_set_plan`

参数：

```json
{ "plan": { "style": "双经济+三输出", "deck": ["sunflower"], "lanes": [{"lane": 0, "role": "输出"}], "thresholds": {"sun": 150}, "contingency": "..." } }
```

返回：

```json
{ "ok": true, "plan": {...}, "savedAt": "..." }
```

传 `plan: null` 清空。只保存，不执行。

### `pvz_choose_deck`

参数：

```json
{ "cards": ["sunflower", "wallnut", "..."], "replace": true }
```

校验顺序：

1. `cards` 为空 → `BAD_DECK`
2. 重复 → `BAD_DECK` + `duplicates`
3. 不在本关卡池 → `CARD_NOT_AVAILABLE` + `cards` + `available`
4. `replace=false` 时与当前卡组合并后：
   - 超过槽位 → `BAD_DECK` + `count/slots`
   - 少于槽位 → `DECK_NOT_FULL` + `have/missing`（**不改卡组**）
5. 合法 → 清空（可选）→ 逐张加卡，每张轮询 `cards.CFs.length` → 最终读 `actualDeck`

返回：

```json
{
  "ok": true,
  "slots": 8,
  "requested": ["sunflower"],
  "applied": ["sunflower"],
  "already": [],
  "skipped": [{ "type": "wallnut", "reason": "rejected" }],
  "missing": [],
  "actualDeck": ["sunflower", "..."],
  "full": true,
  "cleared": true,
  "detail": "选卡完成（8/8）"
}
```

失败时 `ok:false`，带 `code`：

- `DECK_NOT_FULL`：`actualDeck / have / missingCount / applied / skipped`
- `CARD_SELECT_FAILED`：卡组满但有指定卡没选中
- `DECK_CLEAR_FAILED`：旧卡清不掉，带 `clearIncomplete`
- `CARD_NOT_AVAILABLE` / `BAD_DECK` / `NO_SLOTS` / `PREP_NOT_READY`

**不会自动补卡。**

### `pvz_start_level`

参数：

```json
{ "dismiss_objective": true, "timeout": 8 }
```

行为：如果 `objective.active` 且 `dismiss_objective`，先关闭弹窗；调用 `letsRock()`；轮询 `phase` 到 `running/won/lost`。

返回：

```json
{ "ok": true, "started": true, "phase": "running", "elapsed": 4.2, "detail": "已开局" }
```

失败：

- `DECK_NOT_FULL`：卡组没满
- `START_FAILED`：`started` 可能为 true；带 `phase`、`waited`

### `pvz_act`

参数：

```json
{
  "actions": [
    { "type": "plant", "card": 0, "lane": 0, "column": 1 },
    { "type": "plant", "plant": "sunflower", "lane": 1, "column": 0 },
    { "type": "plant", "plant": "sunflower", "cells": [{ "lane": 0, "column": 0 }, { "lane": 1, "column": 0 }, { "lane": 2, "column": 0 }] },
    { "type": "replace", "plant": "wallnut", "lane": 2, "column": 4 },
    { "type": "shovel", "lane": 0, "column": 2 },
    { "type": "plant_food", "lane": 1, "column": 0 },
    { "type": "move_cart", "cart": 0, "direction": "up" },
    { "type": "resume" },
    { "type": "restart" },
    { "type": "wait", "seconds": 1.5 },
    { "type": "dismiss_objective" },
    { "type": "collect" }
  ]
}
```

- 1–6 个，按顺序执行；`wait` 在客户端实际等待（0–15s）。
- `card` 是 `pvz_state.cards[].index`；`plant` 是 codename。两者二选一。
- `cells`（只对 plant/replace）：同一张卡一次种到多格（最多 8 格）。工具按真实冷却自动等 `retryAfter` 重试（最多 3 次/格，整批最多阻塞 25 秒）；遇到 `SUN`/`OCCUPIED`/`CARD_NOT_IN_DECK` 就停手，后面的格子不再硬试。
- 部分失败不抛异常。
- 种植/换植返回 `pending:true, settled:false` 表示“已发起但还没落地”；下一拍用 `pvz_state` 确认，不要立刻重种。

`cells` 的部分返回：

```json
{
  "index": 0, "action": "plant", "type": "plant", "ok": false,
  "cells": [
    { "lane": 0, "column": 0, "retries": 0, "ok": true, "settled": true, "type": "sunflower" },
    { "lane": 1, "column": 0, "retries": 1, "ok": true, "settled": true, "type": "sunflower" },
    { "lane": 2, "column": 0, "ok": false, "code": "SUN", "reason": "阳光不足：需要 25，现有 10", "need": 25, "have": 10 }
  ],
  "okCount": 2, "failCount": 1,
  "planted": [{ "lane": 0, "column": 0 }, { "lane": 1, "column": 0 }]
}
```

返回：

```json
{
  "ok": false,
  "okCount": 1,
  "failCount": 1,
  "results": [
    { "index": 0, "action": "plant", "type": "sunflower", "ok": true, "lane": 0, "column": 1, "card": 0, "settled": true, "detail": "种下 sunflower @ 0,1" },
    { "index": 1, "action": "plant", "type": "sunflower", "ok": false, "code": "COOLDOWN", "reason": "sunflower 冷却中 2.0s", "retryAfter": 2 }
  ]
}
```

单动作错误码：`NO_CARD`、`COOLDOWN`、`SUN`、`OCCUPIED`、`CELL_BLOCKED`、`PLANT_NOT_SETTLED`、`SHOVEL_FAILED`、`EMPTY`、`NO_FOOD`、`NO_PLANT`、`NOT_FOODABLE`、`PAUSED`、`NO_CART`、`CART_BLOCKED`、`CARD_NOT_IN_DECK`、`BAD_POSITION`、`UNKNOWN_ACTION`。

### `pvz_wait_until`

参数：

```json
{ "until": "sun>=150 && card_ready:sunflower", "timeout": 15 }
```

支持：

- `sun>=N` / `sun<=N` / `sun>N` / `sun<N`
- `plantfood>=N`
- `card_ready:<type|index>`
- `zombie_in_lane:<lane>` / `no_zombie_in_lane:<lane>`
- `zombie_near:<column>` / `no_zombie`
- `phase:<phase>`
- `plants>=N` / `plants_in_lane:<lane>>=N` / `wave>=N`
- `tasks_ready`
- 复合：`a && b` 或 `a || b`（同一条只用一种）

成功：

```json
{ "ok": true, "satisfied": true, "condition": "...", "elapsed": 3.2, "match": {...}, "state": { "compact": "..." } }
```

超时：

```json
{ "ok": false, "code": "TIMEOUT", "satisfied": false, "condition": "...", "elapsed": 15, "state": { "compact": "..." } }
```

非法条件：`BAD_CONDITION`。

### `pvz_collect`

返回：

```json
{ "ok": true, "count": 3, "kinds": { "sun": 2, "plantFood": 1 } }
```

### `pvz_plant_food`

参数：`{ "lane": 0, "column": 0 }`

返回：`{ "ok": true, "lane": 0, "column": 0, "type": "sunflower", "detail": "能量豆 @ 0,0" }`；错误 `NO_FOOD / NO_PLANT / NOT_FOODABLE / FOOD_FAILED`。

### `pvz_move_cart`

参数：`{ "cart": 0, "direction": "up" }`

返回：`{ "ok": true, "cart": 0, "direction": "up", "from": {...}, "to": {...}, "plants": [] }`；错误 `NO_CART / CART_BLOCKED`。

### `pvz_resume`

返回：`{ "ok": true, "paused": false, "detail": "继续游戏" }`

### `pvz_restart`

重开本关：直接走游戏自己的重开流程（`PauseScreen.restart`），不需要先进暂停菜单，也不会去点 UI。

参数：无。

返回：

```json
{ "ok": true, "restarted": true, "from": "lost", "phase": "preparing", "detail": "本关已重开（回到选卡阶段）" }
```

- 8 秒内没回到 `preparing` 返回 `RESTART_TIMEOUT`（不是崩溃，用 `pvz_state` 看 phase）。
- 找不到重开入口返回 `RESTART_UNSUPPORTED`。

### `pvz_dismiss_objective`

返回：`{ "ok": true, "detail": "已关闭任务说明" }`；没有弹窗时也返回 ok；失败 `DISMISS_FAILED / CONTINUE_NOT_FOUND`。

### `pvz_health`

返回：

```json
{
  "ok": true,
  "version": "0.1.12",
  "serverVersion": "0.1.12",
  "namespace": "pvz-llm-agent",
  "scene": "inGameScene",
  "phase": "preparing",
  "api": ["snapshot", "..."],
  "missing": [],
  "features": { "briefing": true, "knowledge": true, "events": true, "plan": true, "deck": true, "carts": true, "terrain": true, "localStrategy": false, "autoDeck": false, "queue": false },
  "tools": ["pvz_briefing", "..."],
  "expectedTools": 15,
  "eventStatus": { "ok": true, "interval": 100, "pending": 0, "dropped": 0, "debounceMs": 2500 },
  "counts": { "cards": 8, "plants": 0, "zombies": 0, "waves": 8 }
}
```

## 3. 错误码表

| code | 含义 | retryable |
|---|---|---|
| `NO_SCENE` | 不在游戏场景/棋盘未加载 | 是 |
| `ALREADY_STARTED` | 已开战，不能选卡 | 否 |
| `PREP_NOT_READY` | 选卡/开局界面未就绪 | 是 |
| `NO_SEED_SELECTION` | 不在选卡界面 | 是 |
| `NO_SLOTS` | 本关没有卡槽 | 否 |
| `BAD_DECK` | 重复/超槽位/数量不对 | 否 |
| `CARD_NOT_AVAILABLE` | 卡不在本关卡池 | 否 |
| `DECK_NOT_FULL` | 卡组没满；不自动补 | 否 |
| `DECK_CLEAR_FAILED` | 旧卡清不掉 | 是 |
| `CARD_SELECT_FAILED` | 有指定卡没选中 | 是 |
| `CARD_NOT_IN_DECK` | 卡不在当前卡槽 | 否 |
| `BAD_ACTION` | 动作对象不合法 | 否 |
| `BAD_POSITION` | lane/column 不是数字 | 否 |
| `NO_CARD` | 卡下标越界 | 否 |
| `COOLDOWN` | 卡牌冷却 | 是 |
| `SUN` | 阳光不足 | 是 |
| `OCCUPIED` | 格子已有植物 | 否 |
| `CELL_BLOCKED` | 地形/障碍/滑轨不能种 | 否 |
| `PLANT_NOT_SETTLED` | 已发起但本次未落地 | 是 |
| `SHOVEL_FAILED` | 铲除未生效 | 是 |
| `EMPTY` | 该格没植物 | 否 |
| `NO_FOOD` | 没能量豆 | 是 |
| `NO_PLANT` | 该格没植物 | 否 |
| `NOT_FOODABLE` | 该植物不能喂 | 否 |
| `FOOD_FAILED` | 能量豆失败 | 是 |
| `NO_CELL` | 格不存在 | 否 |
| `PAUSED` | 暂停中 | 是 |
| `UNKNOWN_ACTION` | 未知动作 | 否 |
| `ACT_THREW` | 动作抛异常 | 否 |
| `NO_ACTIONS` | actions 为空 | 否 |
| `NO_CART` / `CART_BLOCKED` | 矿车不存在/不能移动 | 否 |
| `NO_OBJECTIVE` / `CONTINUE_NOT_FOUND` / `DISMISS_FAILED` | 任务弹窗问题 | 是 |
| `START_FAILED` | 开局失败/超时 | 是 |
| `RESTART_UNSUPPORTED` / `RESTART_FAILED` / `RESTART_TIMEOUT` | 重开不可用 / 重开失败 / 8 秒内没回到选卡 | 是 |
| `BAD_CONDITION` | 等待条件非法 | 否 |
| `TIMEOUT` | 等待超时 | 是 |
| `BAD_QUERY` / `KNOWLEDGE_NOT_FOUND` | 图鉴查询问题 | 否 |
| `BAD_PLAN` | plan 不是对象 | 否 |
| `MOD_NOT_LOADED` | `window.PvzLlm` 不存在 | 是 |
| `CDP_DISCONNECTED` / `CDP_NO_PAGE` | 调试连接问题 | 是 |
| `BRIDGE_ERROR` | 页面执行异常 | 是 |
| `BAD_RESPONSE` | 页面返回无法解析 | 是 |
| `UNKNOWN_TOOL` | 工具名不存在 | 否 |

## 4. MCP 返回约定

- `tools/call` 成功：`content:[{type:'text', text: JSON}]`，`isError:false`，并带 `structuredContent`（对象）。
- 工具返回 `ok:false`：`isError:true`，但内容仍是结构化结果（含 `code/reason/retryable`），不是协议错误。
- 协议错误（未知方法/参数）才用 JSON-RPC `error`。
