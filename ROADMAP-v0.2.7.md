# PvZ AI Gardendless · v0.2.7 改进记录

> 目标：不再按地图写死机制，增加通用「机制探测层」，让任何 Agent 进关就能知道
> 当前地图有什么（潮汐/恐龙/墓碑/传送门/金瓷砖/濒危植物/矿车…），不认识的明确报 `unmapped`，
> 不支持的关卡直接 `UNSUPPORTED_LEVEL`。

---

## 1. 设计

### `snapshot().mechanics`

```json
{
  "supported": true,
  "unsupportedReason": null,
  "features": ["water", "tide", "endangered"],
  "tide": { "pos": 3, "moving": false, "waterColumns": 6 },
  "dinosaurs": [],
  "portals": [],
  "hazards": [],
  "tiles": [{ "lane": 0, "column": 2, "type": "endangered", "class": "endangeredTile" }],
  "unmappedTiles": []
}
```

- **不按世界/关卡硬编码**：按场景组件类名识别。
- `specialTiles` 同步扩展：`rail / tomb / mold / vase / ice / gold / endangered / slider`。
- `unmappedTiles` 记录看起来像机制、但还没映射的地块类名，便于后续补。
- `supported:false`：传送带 / 砸罐 / 天空 / 保龄球；`plant()` 返回 `UNSUPPORTED_LEVEL`。

### 已映射组件

| 机制 | 组件 |
| --- | --- |
| 潮汐 | `Tide`（`pos` / `moving`） |
| 恐龙 | `Ankylo/Ptero/Raptor/Stego/TyrannoDinosaur` |
| 传送门 | `Portal` |
| 墓碑 | `Tomb` / `cell.haveTomb` |
| 金瓷砖 | `goldTile` |
| 濒危植物 | `endangeredTile` |
| 滑块 | `sliderTile` |
| 矿车 | `railway` / `cart` |
| 花盆/睡莲 | `GridItem` / `LilyPad` / `PowerLily` |
| 气功洞 | `ChiHole`（Direction / LanesToAffect / Column / LifeSpan） |
| 巫师羊 | `DarkWizardSheep` |
| 传送带 | `Conveyor`（仅 `plantList`/掉落条件非空时判定） |

### 僵尸标签（补充）

`eighties_boombox` → `support/lane_switch`；`dark_wizard` → `disable/sheep`；
`kongfu_chi`/`abbot_chi`/`monk_drink` → `push`。

---

## 2. 实测（0.16.1 + GP-Next 1.5.5）

| 关卡 | 结果 |
| --- | --- |
| 狂野西部 15 | `supported:true`，`features:[rail]`，6 个轨道格；修掉了把 `Conveyor` 组件误判成传送带关的问题 |
| 巨浪沙滩 15 | `features:[water,endangered,tide]`，`tide.pos=3`，水覆盖 6 列，5 个濒危植物 |
| 黑暗时代 2 | `features:[tomb]`，7 个墓碑 |
| 遗落古城 15 | `features:[gold,endangered]`，5 个金瓷砖 + 2 个濒危植物 |
| 侏罗纪沼泽 10 | `features:[dinosaur]`，`stego@1 / ptero@2 / raptor@3` |

> 说明：传送门 `Portal` 组件已映射，但在测试的 lostcity 1–30 关卡 JSON 中没有实例；
> 传送带关没有现场样本，`supported:false` 逻辑按组件/关卡名判定，待有样本再补实测。

---

## 3. 使用与提示词

- 提示词新增：`state.mechanics` 的读法、潮汐 `pos`、恐龙 `lane/action`、`supported:false` 时停止种植。
- `pvz_health` 增加 `mechanics` 能力检查。
- 无需新增 MCP 工具：其他地图机制目前都是**读信息**，动作仍是 plant / shovel / plant_food / move_cart。

---

## 4. 未做

- 恐龙的具体动作时间线（推进/踩踏）字段还需按 `Dinosaur` 子类实际状态补；
- 传送门入口/出口配对、金瓷砖产出、滑块方向；
- 潮汐 `pos` 与水格 `plantable` 的联动说明（目前 terrain 已给 W/sea，Agent 可自行判断睡莲）；
- 传送带/砸罐/天空关的真机验证。
