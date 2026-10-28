# PvZ AI Gardendless · v0.2.8 改进记录：传送带关卡

> v0.2.7 把传送带标成 `supported:false`，因为只做了探测、没接操作。
> 本版接上 `Conveyor.chooseCard()` + `UIInGame.tryChangingIndex(8)` + `PlaceUIPlant()`，
> 并在「遥远未来 第 8 天」实测种下传送带卡。

---

## 1. 传送带的真实接口

| 项 | 字段/方法 |
| --- | --- |
| 当前卡 | `Conveyor.getCards()` |
| 卡槽 | `lane1slots / lane2slots / laneVertslots`（`slot.card`） |
| 选卡 | `Conveyor.chooseCard(cf, slot)` → `UIInGame.currentFreeCF=cf`、`index=8` |
| 种植 | `cell.putPlantAvailable(...)` + `cell.PlaceUIPlant()` |
| 关卡配置 | 关卡 JSON 的 `RTID(ConveyorBelt@CurrentLevel)`；`Conveyor.plantList` |

传送带卡**不扣阳光、不吃种子冷却**，所以不能走 `Cards.CFs` 那条路。

---

## 2. 实现

- `snapshot().conveyor`：
  ```json
  {
    "enabled": true,
    "vertical": false,
    "cards": [{ "index": 0, "type": "citron", "name": "citron", "ready": true }],
    "plantList": ["blover", "citron", "laser_bean", "snapdragon", "wallnut"],
    "slots": ["citron", null, null]
  }
  ```
- `plant()`：没有 `Cards.CFs` 且 `Conveyor.plantList/getCards` 非空时，走 `plantConveyor()`。
  - `card` = `conveyor.cards` 下标
  - 复用地形/占位/每行上限检查
  - `chooseCard(cf, slot)` → 校验 `ui.currentFreeCF` → `PlaceUIPlant()`
- `pvz_start_level`：传送带关直接 `lvl.letsRock()`；它会在隐藏种子栏 UI 时抛一个非致命异常，但战斗已经启动，因此返回 `ok:true` + `warning`，由 `wait_until phase:running` 确认。
- `pvz_choose_deck`：传送带关返回「无需选卡」。
- `pvz_wait_until`：新增 `conveyor_ready`；`card_ready` 同时查种子卡和传送带卡。
- `mechanics.supported`：传送带不再标 false；砸罐/天空/保龄球仍不支持。

---

## 3. 实测（遥远未来 8）

```text
phase=objective → supported=true, features=[conveyor]
pvz_choose_deck → { ok:true, conveyor:true, detail:"传送带关卡无需选卡" }
pvz_start_level → { ok:true, detail:"开始战斗（传送带）", warning:"...node" }
pvz_wait_until phase:running → 4.2s
pvz_wait_until conveyor_ready → cards=[citron]
pvz_plant {card:0, lane:2, column:2} → "传送带种下 citron @ 2,2"
plants = ["2,2:citron:300"]
```

传送带卡会随带子变化（后续快照出现 wallnut / laser_bean），Agent 每次用最新的 `conveyor.cards` 下标即可。

---

## 4. 找到传送带关的方法

关卡 JSON 里有 `RTID(ConveyorBelt@CurrentLevel)`。已找到：

```text
future8 / future16 / future25
iceage3 / iceage5 / iceage8 / iceage10 / iceage16 / iceage18 / iceage21 / iceage25
```

调试时可以用 `KeyListener.goToLevel(['future8'], [], false, false)` 直接跳关，绕过世界地图解锁。

---

## 5. 未做

- 传送带竖直模式（`vertical`）只读取，未实测；
- 内置本地策略（`localBrain`）还没针对传送带写决策；
- 砸罐/保龄球/天空仍不支持。
