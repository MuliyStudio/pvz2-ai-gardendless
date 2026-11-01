# 工具契约（v0.4.16）

> 运行时权威定义在 `tools/definitions.js`；错误码在 `tools/errors.js`。
> 本文是给接入方（MCP 客户端 / 游戏内客户端开发）看的字段与语义说明。

## 0. 边界

- **LLM 是唯一决策者。** 工具不生成推荐卡组、不修正卡组、不自动补卡、不本地选卡。
- 工具只做：给事实、执行动作、返回真实结果、记录计划；`plan.queue` 是模型显式授权的本地执行队列，只处理冷却/阳光/占格/cond，不改变任务顺序和卡选择。
- `pvz_set_plan` 保存计划；如果计划带 `queue`，本地执行器按 tick 执行队列中第一条满足 cond 的任务。队列执行完会停；`queue:[]` 清空；不带 `queue` 的更新不影响现有队列。
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

准备模式 `state.prep.mode`：

| mode | 流程 |
| --- | --- |
| `normal` | 正常选卡：briefing → plan → choose_deck → start_level |
| `forced_deck` | “使用给定植物通关”，没有选卡页：briefing → plan（给定卡对策/counters）→ start_level；没 plan 返回 `NEED_PLAN` |
| `preplant` | “提前布阵”：briefing（开局就带整关波次）→ plan → 自选卡组（有选卡页时）→ 布阵 → start_level；没 plan 返回 `NEED_PLAN` |
| `conveyor` | 传送带：不能选卡；`state.cards` / `state.conveyor.cards` 是当前带上的卡，index 每轮会变，不扣阳光/不吃冷却；用最新 index 或 `plant` codename 实时种植 |

`state.prep.mustPlanBeforeStart=true` 时，`pvz_start_level`（以及 `pvz_act {type:"start_level"}`）会先检查是否已保存带 `text` 的计划。

## 2. 工具清单

### `pvz_briefing`

参数：无。

返回：

```json
{
  "ok": true,
  "version": "0.4.16",
  "phase": "preparing",
  "scene": "inGameScene",
  "objective": { "screenName": "...", "missions": ["..."], "active": false, "canContinue": true },
  "missionHints": ["..."],
  "levelContext": {
    "world": { "key": "pirate", "name": "海盗港湾", "mechanics": ["..."] },
    "terrain": { "lanes": 5, "columns": 9, "map": ["..."], "obstacleTypes": ["tomb"], "blockedCells": 3, "protectCells": [] },
    "waves": [{ "wave": 1, "flag": false, "total": 1, "ehp": 190, "zombies": { "tutorial": 1 }, "lanes": { "tutorial": [0] } }],
    "zombies": [{ "type": "tutorial", "name": "普通僵尸", "ehp": 190, "speed": 0.185, "eatDps": 100, "tags": [], "counters": [] }],
    "cards": [{ "type": "sunflower", "cost": 50, "cd": 5, "hp": 300, "dps": null, "targets": null, "pierceCount": null, "multiDps": null, "reach": null, "armTimeSec": 0, "kind": "none", "capabilities": ["economy"] }],
    "deck": { "slots": 8, "current": ["sunflower"], "capabilities": { "economy": ["sunflower"] }, "gaps": [] },
    "history": { "key": "pirate1", "note": "...", "lessons": ["..."], "lastResult": "lost" },
    "facts": { "totalWaveEhp": 1900, "tags": ["rolling"], "requiredCapabilities": ["anti_rolling"] }
  },
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
      "burst": null,
      "damageType": "normal",
      "armorState": "no",
      "plantFood": { "kind": "sun_burst", "area": "self", "radius": null, "total": null, "durationSec": null, "confidence": "high" },
      "activation": "auto",
      "aim": null,
      "brief": "提供额外阳光", "introduction": "...", "special": [], "weaknesses": [],
      "usage": { "activation": "auto", "area": "single", "needs": [], "manual": false, "onlyTomb": false, "onlyIce": false, "contact": false, "charges": null, "restSec": null, "fireCost": null }
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
- `coverageGaps` 是**整关能力审计**：`{ tags, required, present, missing[], byType[] }`。`tags` 汇总所有波次出现过的僵尸 tag；`missing[]` 每项是 `{ capability, name, text, tags, candidates }`，`candidates` 是卡池里能满足该能力的卡（事实，不是推荐）。能力映射：`group→multi_target`、`rolling→anti_rolling`、`flying→anti_air`、`armored→high_dps/true_damage`（任一）、`newspaper→burst/pierce`、`crush/gargantuar→control/burst`、`steal→protect_key`、`lane_switch→multi_lane`。
- `deck.capabilities` 是卡组能力索引（`capability → [cards]`）；`deck.coverageGaps` 是同一份审计。`deck.counterGaps` 是逐僵尸类型的旧读法（保留兼容）。
- `levelContext` 是整关一次性索引（世界/地形摘要、逐波类型与固定行、全部僵尸 tag、卡池能力、卡组缺口、历史），详细数值仍在 `waves` / `zombies` / `cards`。
- `cards[].stepDamage` = 地刺类（伤害只作用于走过这一格的僵尸，必须种在墙前）；`cards[].poison` = 毒伤 `{dps,duration,stacks,total,slow}`；`cards[].attack.ignoresArmor` = 直接弹道真伤；`cards[].effectiveDps` = 单体 dps + 毒伤 dps。`state.cards[]` 也带 `stepDamage/ignoresArmor/effectiveDps`。
- `cards[].burst` = 单发结算伤害 `{ dmg, area, basis }`：樱桃/辣椒/椰子炮这类 `attack=null` 的卡不再"没有伤害值"。
- `cards[].damageType` = `normal|poison|true|drain`（`drain` = 吸血型直扣本体，例如吸血牛肝菌）；`cards[].armorState` = `yes|no|unknown`（`unknown` = 没有字段能证明，别当 `false` 用）。
- `cards[].plantFood` = 能量豆事实 `{ kind, area, radius, total, durationSec, confidence }`。`kind`：`self_aoe_multi / self_aoe_dot / barrage / lob_barrage / control / execute / heal / self_armor / freeze / stun / summon / sun_burst / buff / taunt / nuke`；`area`：`self / self_aoe / self_tile / row / multi_row / full / target / aura`。没有专属效果时为 `null`。
- `cards[].activation` / `cards[].aim` 常驻（lean 也带）：`activation=click|click_sun|auto|on_tomb|on_ice|contact`，`aim=self|lane|free_cell|swap|move`。点击类卡必须用 `pvz_act.activate` 才会开火。

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

### `pvz_forecast`

参数：`{ "next": 3 }`（可选，只看接下来 N 波，1–20）。

返回逐波预测：`source`（关卡资源名，如 `cowboy13`）、`waveCount`、`waves[]`、`totals`、`dynamic`、`notes`。

```json
{
  "ok": true,
  "source": "cowboy13",
  "waveCount": 20,
  "waves": [
    {
      "wave": 7,
      "flag": false,
      "total": 4,
      "ehp": 760,
      "zombies": {
        "poncho_plate": { "count": 1, "ehp": 380, "ehpTotal": 380, "lanes": [2], "dynamicCount": null },
        "cowboy": { "count": 3, "ehp": 190, "ehpTotal": 570, "lanes": null, "dynamicCount": null }
      },
      "firstWaveTypes": [],
      "extraFood": 1,
      "dynamicBudget": 0
    }
  ],
  "dynamic": {
    "active": false,
    "mode": "none | generated | estimated",
    "difficulty": 3,
    "rule": null,
    "budgets": null
  }
}
```

- `lanes` 有值 = 关卡写死的行（0–4）；`lanes: null` = 生成时随机行。
- `dynamic.mode=generated`：本局动态僵尸已在波次表里，`dynamicCount` 是随机追加的确切数量。
- `dynamic.mode=estimated`：动态部分还没生成，`waves[].estimate = { samples, pNone, zombies: { type: { p, expected } } }` 是模拟期望（`p` = 出现概率），不是本局结果。
- 动态预算算法与引擎一致：`StartingPoints + PointIncrementPerWave × (波次-1-StartingWave)`，旗帜波 `×2.5`。

`pvz_briefing.forecast` 是同一份完整预测；`pvz_state.forecast` 是接下来 3 波的薄片。

### `pvz_level_memory`

参数：`{}`（当前关卡）/ `{ "key": "cowboy13" }` / `{ "all": true, "limit": 30 }` / `{ "note": "这关用西瓜更稳" }`。

返回：

```json
{
  "ok": true,
  "key": "cowboy13",
  "entry": {
    "key": "cowboy13",
    "name": "狂野西部 - 第 13 天",
    "note": "自己写的心得",
    "runs": [
      {
        "at": "2026-10-30T08:00:00.000Z",
        "result": "won | lost | restart | left",
        "wave": 20, "waveCount": 20, "durationSec": 412,
        "deck": ["sunflower", "..."],
        "plan": { "...": "当时的 pvz_set_plan" },
        "facts": { "maxWave": 20, "plantsLost": 6, "mowersLost": 0, "sunPeak": 975, "everRunning": true }
      }
    ]
  }
}
```

- 存储：页面 `localStorage`（`pvzllm.levelMemory.v1`），游戏内 agent 与外部 MCP 客户端共享；每关只留最近 5 条。
- 写入：关卡结束（`won` / `lost`）、中途重开（`restart`）、退回菜单（`left`）时由事件采样器自动追加，不需要 LLM 手动写。
- `pvz_briefing.history` 是同一份数据里当前关卡的最近几条。

### `pvz_state`

参数：无。

返回 `snapshot()`：

```json
{
  "ok": true,
  "version": "0.4.16",
  "scene": "inGameScene",
  "phase": "running",
  "paused": false,
  "sun": 175,
  "plantFood": 1,
  "plantFoodUsable": 6,
  "level": { "name": "...", "wave": 3, "waves": 8, "nextWaveIn": 12, "gameStarted": true, "source": {...}, "world": {...} },
  "cards": [{ "index": 0, "type": "sunflower", "name": "向日葵", "cost": 50, "cd": 0, "cdReady": true, "affordable": true, "sunShort": 0, "ready": true, "cooling": false }],
  "deck": ["sunflower", "..."],
  "seedSelection": { "slots": 8, "current": ["..."], "gameStartable": false, "availableCount": 42, "available": [{ "type": "...", "name": "...", "cost": 50, "chosen": true }] },
  "plants": [{ "lane": 0, "column": 0, "type": "sunflower", "name": "向日葵", "hp": 300, "maxHp": 300, "atk": null, "effectiveDps": null, "stepDamage": false, "placementTags": [], "shot": {...}, "family": "Sun", "foodable": true }],
  "zombies": [{ "lane": 2, "column": 6.4, "type": "dark_armor2", "name": "铁桶农夫", "hp": 190, "maxHp": 650, "armorHp": null, "armorMax": 460, "ehp": null, "ehpMax": 650, "tags": ["armored"], "nextPhase": { "atHp": 152, "atHpPct": 0.8, "effect": "throw_imp", "spawn": "imp" }, "speed": 0.2, "etaToHouse": 32 }],
  "board": [{ "lane": 0, "cells": ["sunflower", null], "terrain": ["L", "L"], "zombies": [] }],
  "lanes": [{ "lane": 0, "zombies": 0, "nearestZombie": null, "shooters": 0, "walls": 0, "sunProducers": 1, "plants": 1, "dps": 0, "dpsEffective": 0, "dpsBlocked": 0, "dpsStep": 0, "wallHp": 0, "ehp": 0, "ehpExact": true, "mower": true }],
  "terrain": { "lanes": 5, "columns": 9, "map": ["..."], "legend": {...} },
  "blockedCells": [], "plantable": [], "obstacles": [], "mechanicFacts": [], "mechanics": [],
  "levelScript": { "waveCount": 8, "flagInterval": 4, "isAtNight": false },
  "zombieStats": { "tutorial": { "hp": 190, "ehp": 190, "speed": 0.185, "eatDps": 100, "tags": [] } },
  "carts": [{ "id": 0, "lane": 2, "column": 0, "railLanes": [1, 2, 3], "plants": [], "canUp": true, "canDown": true }],
  "tasks": [{ "key": "...", "tip": "...", "count": "3/10", "mode": 5, "modeName": "kill_count_request", "value": 3, "total": 10, "completed": false, "failed": false, "urgent": false, "hint": "..." }],
  "objective": { ... },
  "missionHints": ["..."],
  "limits": { "plantLimit": 18, "plantsPlanted": 6, "plantsLeft": 12, "slots": 8 },
  "plantLimit": 18,
  "startingSun": 150,
  "collect": { "total": 12, "kinds": { "sun": 12 } },
  "brief": {
    "leadSec": 4.2,
    "totalDps": 130,
    "sunRate": 1.04,
    "wave": { "now": 3, "total": 8, "etaSec": 6.1, "basis": "health", "flag": false },
    "pressure": [{ "lane": 2, "gap": 260.4, "lossIn": 14.2, "actBy": 10, "front": { "column": 6.2, "type": "cowboy", "ehp": 190 } }],
    "safeLanes": [0, 1, 4],
    "aimOptions": [{ "card": "cherry_bomb", "scope": "box", "lane": 2, "column": 5, "hits": 3, "dmg": 1800, "total": 5400, "kills": 2, "overkill": 1200 }]
  },
  "instantAim": [{ "card": "cherry_bomb", "lane": 2, "frontColumn": 6.2, "from": 4, "to": 5, "late": false }],
  "latency": { "leadSec": 4.2, "modelMs": 3100, "toolMs": 600, "settleMs": 450, "modelSamples": 12, "source": "measured" },
  "plan": { "...": "LLM 自己写的计划" },
  "planSavedAt": "2026-10-29T..."
}
```

说明：

- `pvz_state` 是**精简版**：`cards[]` 不带每张卡的完整数值（在图鉴和 `pvz_briefing.cards` 里），`levelScript` 只给 `waveCount / flagInterval / isAtNight`；完整波次表只在 `pvz_briefing` 返回。这样每回合 prompt 小 40%–60%，直接决定模型响应速度。
- `cards[].cdReady` 是冷却好了，`affordable` 是买得起，`sunShort` 还差多少阳光（买得起是 0）；`ready` 只有两者都满足才是 true。
- `zombies[].armorHp` 是护甲当前血量（引擎读不到时是 `null`）；`ehp = hp + armorHp`，`ehpMax = hp + armorMax` 是上界。别只看 `hp`。
- `lanes[].ehp` 是本行在场上僵尸的剩余 EHP 合计；`ehpExact=false` 表示其中有读不到护甲的血量，只是上界。
- `lanes[].dps` 是本行植物 `attack.dps` 的名义之和；`dpsEffective` 才是**实际可用**输出：排除被墓碑挡住的直线弹道、只作用于本格的地刺、以及射程外的目标；多目标植物按当前真能同时打到的只数算（不是固定按 `targets` 上限）。`dpsBlocked`/`dpsStep` 分别是被挡和地刺的名义 DPS，方便对照。`wallHp` 是坚果类当前血量之和。
- `lanes[].incomingPerSec` = Σ(僵尸剩余 EHP / 到房子秒数)，是本行每秒涌进来的威胁；`gap = incomingPerSec − dpsEffective`，`gapRaw` 用名义 `dps` 做对照。`gap>0` 就是压不住。`lossIn` 是最近僵尸到房子的秒数，`actBy = lossIn − brief.leadSec`，`actBy<0` 表示现在下指令已经来不及。
- `brief` 只汇总事实：`leadSec` 是「模型往返 + 工具 + 落地」的总延迟；`pressure` 是 `gap>0` 的前 3 行（按 gap 降序）；`safeLanes` 是 gap≤0 的行；`wave.etaSec` 是下一波预计到达秒数，`basis=health` 表示按血量提前进波、`timer` 表示按倒计时。`activeLanes/idleLanes/residual` 区分有僵尸的行/空行/残敌；`wave.done=true` 只表示波次计数到底，不代表关卡结束，残敌仍在时不要按旧计划给空行补墙/输出。
- `cards[].etaSun` 按当前产阳光速度算出还差几秒够钱（`sunRate` 是全场每秒产阳光），`etaReady = max(etaSun, cd)`。
- `instantAim[]` 是一次性卡的可投窗口：`from`–`to` 是列区间（已按延迟和引信反推），`late=true` 表示已来不及。
- `brief.aimOptions[]` 是范围/一次性卡的落点事实：每条只算“以某个已有僵尸所在格为中心”时 `hits/dmg/total/kills/overkill`。`scope` 是 `single/tile/box/lane/lanes3/radius/1x3/all`：`single` 只打一只（同格多只取快照顺序第一只），`tile` 打本格全部，`box` 是 3x3/5x5，`radius` 是圆形半径。**不排序、不标 best、不选卡**；空格的落点仍由模型判断。lean state 只带前 12 条（按卡→行→列固定顺序），其余看 `aimOptionsMore` 或 `pvz_state full=true`。
- `state.stateVersion` 是粗粒度局面版本（只在**关卡/准备模式/传送带模式**变化时变，不含 phase/wave）；`plan.queue[].stateVersion` 用它，换关/换模式后的旧任务会返回 `STALE_ACTION` 并丢弃。开局前写的任务不会因为 preparing→running 被判 stale。
- `state.decisions[]` 是本地算好的微决策，每条 `{id, kind, question, action, facts, stateVersion, expiresInSec}`；用 `pvz_decide {id, choice}` 回答，yes 才执行。
- `state.threatGaps[]` 是本地算的覆盖缺口，`kind` 为 `wall/output/rescue/mine/protect/capability`，带 `lane`、`etaSec`、`deficit`、`requiredCapability`、`tags`、`candidates`、`reason`；只表示“当前 plan/queue 没有覆盖”，不替模型选卡。有缺口时先补 queue/counters。
- `latency` 是模型/工具耗时的 EMA；外部 MCP 客户端测不到模型耗时时 `source=default`，`leadSec` 用保守默认值（7.1s）。
- `plants[].foodable` 表示这株植物现在能不能吃能量豆：已落地、`foodable` 为真且不在释放中才是 `true`；花盆/睡莲/一次性卡不是目标。刚种下的植物要等落地后才会变 `true`。`plantFoodUsable` 是场上 `foodable=true` 的总株数。
- `plants[].food` = 这株能量豆的现场事实 `{ kind, area, radius, total, totalPerTarget, maxTotal, sunTotal, sunValue, count, projectileDamage, targetsPerHit, hitsPerTarget, targets, whiff, cells? }`：`targets` 是范围内当前僵尸数（本地算好的），`whiff=true` 表示现在给豆一定浪费。弹幕型（Pea/Cabbage/Boomerang）的 `count` 是发数，`projectileDamage` 是单发伤害，`targetsPerHit`/`hitsPerTarget` 是每发目标数和同一目标命中次数，`totalPerTarget`/`maxTotal` 是由这些字段算出的单目标伤害/多目标上限；召唤/处决/阳光型的 `count` 是效果数量，阳光型另有 `sunValue/sunTotal`。`pvz_knowledge` 的完整 `plantFood.rawFields` 会保留尚未归类的 `*Plantfood*` 字段，方便游戏更新后排查。`brief.plantFoodPlan` 把 `foodable` 的株按 `targets`×`total` 排好序（最多 6 条）。
- `plants[].activation` / `aim`：`click` 表示必须用 `activate` 才会开火；`brief.activatePlan` 给 `{ lane, column, aim, frontZombie, targets, shouldAct, api, charges, restSec }`，`api` 是这个版本里真实存在的方法名（`null` = 找不到，`activate` 会返回 `ACTIVATE_UNSUPPORTED`）。
- `plants[].family` 是图鉴家族（`Sun` / `Peashooter` / `Defence` …）；`lanes[].sunProducers` 是本行 `family=Sun` 的株数，用来判断经济够不够。
- `zombies[].speed` 是每秒走几格，`etaToHouse` 是到房子的秒数（读不到速度时为 `null`）。从读状态到动作落地通常有 3–5 秒，落点要按这个提前量算，别种在僵尸当前列。`zombies[].eatDps/eating` 是啃食速度和是否正在啃；`plants[].underAttack/eatDps/holdSec` 是植物正在被几只啃、还能撑几秒。
- `zombies[].nextPhase` / `phases` 是血量阈值触发的阶段（`throw_imp` 巨人扔小鬼、`enrage` 狂暴、`drop_arm` 掉手、`spawn_chickens` 放鸡、`spawn_weasel` 放黄鼠狼）：`nextPhase.atHp` 是还没触发的下一档血量，`spawn` 是生成物。
- `plants[].layers` 只在同一格有多层时出现（main / vine / tile / pot / lilypad），`cellHp` 是这些层的当前血量合计；南瓜套/藤蔓/睡莲不再被 `list[0]` 吞掉。单层仍用 `hp`，不重复占字段。
- `cards[].placementTags` / `pvz_briefing.cards[].placement` 是 `PlantFeatures.TAGS` 的原文（`amphibious` / `fly` / `vine` / `lilypad` …），只说明放置类别，不替模型判断该种哪。
- `lanes[].dpsOnFront` 只统计僵尸左侧能打到它的输出；`frontPlant/contactInSec/holdSec/killWindowSec/killBeforeWindow/projectedHouseSec` 是前方阻挡物、接触倒计时、被啃完前的时间窗、能否在窗口内击杀、以及沿路所有植物被啃后预计还能拖多久。`state.brief.rescuePlan[]` 给出最紧急行的 `emptyColumns/replaceCandidates/outputCards/instantCards/food`，用于贴脸时直接 replace 输出，而不是反复试墙。
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
{ "ok": true, "plan": {...}, "savedAt": "...", "audit": { "ok": false, "warnings": [ ... ] }, "warnings": [ ... ] }
```

传 `plan: null` 清空。计划本身只保存；若带 `queue`，本地执行器按 `queueTickMs`（默认 450ms）执行模型授权的任务。

保存后会按本关事实审计（`auditPlan`，纯函数），warning 不阻止保存，只要求模型重写：

| warning code | 触发条件 |
|---|---|
| `PLAN_TEXT_ONLY` | 计划只有 `text`，没有 lanes/counters/phases/triggers/emergency/queue |
| `PLAN_MISSING_COUNTER` | 整关 `coverageGaps.missing` 里的能力，计划 `counters` 没有对应项（`tag`/`capability`/`card` 任一命中即可） |
| `PLAN_DECK_MISMATCH` | 计划 `deck` 和实际卡组不一致（带 `missing` / `extra`） |
| `PLAN_BAD_LANE` | `lanes[].lane` 不在 0–4 |
| `PLAN_NO_TEXT` / `PLAN_SCHEMA` | 缺 `text` / schema 不是 `pvz-plan/v1` |

计划结构（`pvz-plan/v1`）：

```json
{
  "schema": "pvz-plan/v1",
  "text": "给玩家看的中文摘要",
  "goal": "胜利条件",
  "deck": ["..."],
  "lanes": [{ "lane": 0, "role": "", "econ": [], "wall": 4, "output": [], "reserve": [], "notes": "" }],
  "counters": [{ "tag": "rolling", "capability": "anti_rolling", "card": "spikeweed", "lane": "all", "column": "c5-c7", "timing": "" }],
  "phases": [{ "id": "early", "untilWave": 3, "actions": [] }],
  "triggers": [{ "when": "airRaid.count>0", "action": "plant blover", "priority": 100 }],
  "emergency": [{ "when": "zombie on c3", "action": "squash/cherry" }],
  "thresholds": {},
  "queueTickMs": 450,
  "queue": [
    { "id": "q-wall", "type": "plant", "plant": "wallnut", "lane": "danger", "column": "ahead", "cond": { "zombieInLane": true, "cellEmpty": true }, "priority": 100, "validForSec": 8, "stateVersion": "a1b2c3", "onFail": "retry", "tag": "最危险行先墙" },
    { "id": "q-output", "type": "plant", "plant": "cabbagepult", "lane": 0, "column": 3, "cond": { "minSun": 100 }, "priority": 10, "validForSec": 20, "onFail": "skip", "tag": "空闲时补输出" }
  ]
}
```

`queue` 规则：

- 每拍只执行第一条 `cond` 满足的任务；遇到 `COOLDOWN` / `SUN` / 占格 / 墙太晚，跳过并继续试下一条。
- `lane` 支持 `0-4`、`danger`（当前最危险行）、`protect`（未守保护行）。
- `column` 支持 `0-8`、`ahead`（最前僵尸左侧一格）、`safe`（地雷 latestSafeColumn）、`back`（c0）。
- `cond` 支持 `minSun`、`minPlantFood`、`waveGte`、`waveLte`、`zombieInLane`、`zombieColumnLt`、`noWall`、`noShooter`、`cellEmpty`、`allowIdleLane`。场上存在残敌时，空行的 plant/replace 任务默认跳过；确实要预布防空行才写 `allowIdleLane:true`。
- 任务执行完会从队列移除；`repeat:true` 保留并节流。`queue:[]` 清空；不带 `queue` 的计划更新不会影响现有队列。
- 任务可选字段：`id`（幂等，同一 id 成功过不会二次执行）、`priority`（只按模型写的值排序，同值保持原顺序）、`validForSec` / `deadline`（过期丢弃，`TASK_EXPIRED`）、`stateVersion`（和当前 `state.stateVersion` 不一致时丢弃，`STALE_ACTION`）、`onFail: retry|skip`（失败后重试或直接丢弃）。
- 队列状态 `stats` 里分别有 `expired / stale / skipped / done / failures`，方便看是过期、旧局面还是执行失败。

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
    { "type": "activate", "lane": 2, "column": 3 },
    { "type": "activate", "lane": 2, "column": 5, "targetLane": 1, "targetColumn": 7 },
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
- **一次 `pvz_act` 就是一轮**：不同卡种到不同格、补阳光、给豆、移车、收豆可以放在同一批；批量里种植不再逐株等 1.5 秒落地，全部发完后统一等一次。只有同卡连种（冷却）、同格先铲后种（用 `replace`）、刚种下就要给豆需要分轮。
- `card` 是 `pvz_state.cards[].index`；`plant` 是 codename。两者二选一。
- `cells`（只对 plant/replace）：同一张卡一次种到多格（最多 8 格）。工具按真实冷却自动等 `retryAfter` 重试（最多 3 次/格，整批最多阻塞 25 秒）；遇到 `SUN`/`OCCUPIED`/`CARD_NOT_IN_DECK` 就停手，后面的格子不再硬试。
- 部分失败不抛异常。
- `activate`（点击类植物）：只对 `state.plants[].activation=click` 的卡有效（椰子加农炮/冬青骑士/香蕉火箭炮/槲寄冰仙子/寒冰菇/镜面坚果…）。优先调用游戏自己的 `specialPlantOnMouseDown()`（所有点击卡都有，不需要鼠标事件）；`aim=free_cell|swap` 时再调 `trigger(目标格)` 打出这一发，因此必须同时给 `targetLane/targetColumn`。`aim=lane` 打本行；`aim=self` 只点自己。返回 `via`（`specialPlantOnMouseDown` / `specialPlantOnMouseDown+trigger` / 回退方法名）与 `verified:false`（游戏没有统一回执）。点不动返回 `NOT_READY` + `liveState`（`sleepCD`/`shooting`/`fooding`/`shootCD`/`growthStage`）。`state.brief.activatePlan[]` 已把 `lane/column/aim/frontZombie/shouldAct/api/live` 算好。
- `plant_food` 会先做空放校验：这株的能量豆只对某范围生效（例如菜问是自身周围 3x3），范围内没有僵尸时返回 `FOOD_NO_TARGET`（带 `plantFood`、`nearestZombie`），**不扣豆**；确实要浪费才传 `force:true`。判断依据是 `state.plants[].food`（kind/area/radius/total/targets，以及弹幕型的 count/projectileDamage/targetsPerHit/hitsPerTarget/totalPerTarget/maxTotal）或 `state.brief.plantFoodPlan`。
- 种植/换植返回 `pending:true, settled:false` 表示“已发起但还没落地”；批量动作会在返回前统一等一次，仍没落地的下一拍用 `pvz_state` 确认，不要立刻重种。
- 种植/换植结果里的 `timing` 是执行那一刻本行最近的僵尸列：`{ nearestZombieColumn, targetColumn, late, suggestedColumn }`。`late=true` 表示目标格在僵尸身后（或同格），这一发大概率来不及，下一轮用 `suggestedColumn`（或往左 1–2 格）。
- **批量预检**（执行前纯计算，只跳过不可能成功的动作）：
  - `BATCH_COOLDOWN`：同一批里同一张卡出现 ≥2 次且该卡基础冷却 >3.5s。返回 `maxSuccess`（本轮最多成功几个）、`retryAfter`、`duplicateOf`；5–8s 的第二张会带 `defer=true` 由执行层排队等一次，20s 墙仍然拒绝，多出来的动作请拆到下一轮或换卡。
  - `BATCH_CONFLICT`：同一格先种后铲 / 重复种 / 换植后再动同一格。返回 `conflictWith`（前面那个动作的下标）。先铲后种同一格是合法连招。
  - `OUTPUT_IN_FRONT_OF_WALL`：同一批里先种墙、再把输出种到墙右侧（单动作校验看不到前一个动作）。返回 `wallColumn` / `behindCells`。
  - `WALL_TOO_LATE`：墙种在僵尸背后；`suggestedColumns` 只给僵尸左侧空位，`replaceCells` 给左侧可 replace 的植物，`blockable=false` 表示这行已没有可挡位置，不要继续试墙。

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

单动作错误码：`NO_CARD`、`COOLDOWN`、`SUN`、`OCCUPIED`、`CELL_BLOCKED`、`PLANT_NOT_SETTLED`、`SHOVEL_FAILED`、`EMPTY`、`NO_FOOD`、`NO_PLANT`、`NOT_FOODABLE`、`FOOD_NO_TARGET`、`FOOD_FAILED`、`NOT_ACTIVATABLE`、`NO_TARGET`、`ACTIVATE_UNSUPPORTED`、`PAUSED`、`NO_CART`、`CART_BLOCKED`、`CARD_NOT_IN_DECK`、`BAD_POSITION`、`UNKNOWN_ACTION`。

### `pvz_decide`

对本地算好的微决策回答 yes/no/other：

```json
{ "id": "aim:cherry_bomb:2:5", "choice": "yes", "reason": "命中 3 只、杀 2 只" }
```

- `id` 必须来自 `state.decisions[].id`；每条决策自带 `action` 与 `facts`（能量豆 `targets/total`、范围卡 `hits/total/kills`）。
- `yes` 才执行该条 `action`；`no` 只跳过；`other` 不执行，改用 `pvz_act`。
- 决策带 `stateVersion` 和 `expiresInSec`；过期或局面版本变化返回 `STALE_DECISION`，不会执行旧动作。
- 只用于能量豆/范围卡落点/点击卡这类高频微决策，不用于选卡和整关计划。

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

参数：`{ "lane": 0, "column": 0, "force": false }`

返回：`{ "ok": true, "lane": 0, "column": 0, "type": "sunflower", "foodLeft": 0, "detail": "能量豆 @ 0,0" }`；错误 `NO_FOOD / NO_PLANT / NOT_FOODABLE / FOOD_NO_TARGET / FOOD_FAILED`。只接受格子里 `foodable=true` 的植物；花盆/睡莲/刚种下未落地会返回真实 code。

`FOOD_NO_TARGET`：这株的能量豆只对某范围生效（`plantFood.area`），而现在范围内没有僵尸（`nearestZombie` 给最近的一只，`cellsAway` 是列差）。这是"几何上一定浪费"的拦截，不会扣豆；`force:true` 可以强制使用。`self` 型（治疗/加甲/产阳光/召唤）不会触发这个拦截。

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
  "version": "0.4.16",
  "serverVersion": "0.4.16",
  "namespace": "pvz-llm-agent",
  "scene": "inGameScene",
  "phase": "preparing",
  "api": ["snapshot", "..."],
  "missing": [],
  "features": { "briefing": true, "knowledge": true, "events": true, "plan": true, "deck": true, "carts": true, "terrain": true, "localStrategy": false, "autoDeck": false, "queue": true },
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
| `BATCH_COOLDOWN` | 同一批里同卡重复且基础冷却 >3.5s；带 `maxSuccess/retryAfter/defer` | 是 |
| `BATCH_CONFLICT` | 同一格先种后铲/重复种；带 `conflictWith` | 否 |
| `OUTPUT_IN_FRONT_OF_WALL` | 输出种在本行墙右侧；带 `wallColumn/behindCells` | 否 |
| `SPIKE_BEHIND_WALL` | 地刺/地刺王种在墙后（僵尸被墙挡住踩不到）；带 `suggestedColumns` | 否 |
| `WALL_TOO_LATE` | 墙种在该行最前僵尸背后；带 `suggestedColumns/replaceCells/blockable` | 否 |
| `PROTECT_TOO_FAR` / `PROTECT_CELL_BLOCKED` | 短手够不到保护格 / 直接种在保护格上；带 `guardCells` | 否 |
| `MINE_TOO_LATE` | 出土类卡来不及；带 `latestSafeColumn/suggestedColumns/etaSec` | 否 |
| `NO_AIR_TARGET` | 三叶草没有空中目标 | 是 |
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
| `FOOD_NO_TARGET` | 能量豆范围内没有僵尸（空放，不扣豆） | 是 |
| `FOOD_FAILED` | 能量豆失败 | 是 |
| `NOT_ACTIVATABLE` | 这株本来就自动攻击，不需要 activate | 否 |
| `NOT_READY` | 这株现在点不动（休息/射击中/阳光不够/没长成），带 `liveState` | 是 |
| `NO_TARGET` | 点击类卡缺目标格（targetLane/targetColumn） | 否 |
| `ACTIVATE_UNSUPPORTED` | 这个版本找不到点击触发入口（看 tried/api） | 否 |
| `ACTIVATE_FAILED` | 触发点击类植物时抛异常 | 是 |
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
