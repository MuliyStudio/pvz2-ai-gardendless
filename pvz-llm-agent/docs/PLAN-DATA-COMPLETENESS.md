# 数据完整性补全计划（植物 / 僵尸 / 能量豆 / 点击类卡）

> 起因：玩家实测发现三件事——
> 1. 吸血牛肝菌（vamporcini）"无视护甲吸血"的机制没有出现在模型看到的事实里；
> 2. 椰子加农炮、冬青骑士这类"点击发射"的卡，模型完全没有操作手段；
> 3. 菜问（bonkchoy）在周围没有僵尸时被喂了能量豆，豆子直接浪费。
>
> 结论：三个都不是"模型判断失误"，而是**事实层缺字段 + 动作层缺能力**。
> 本文件把缺口量化、给出补全规则，并规定验收口径。

---

## 0. 现状链路（模型到底收到什么）

```
游戏资源 JSON (PlantProps/ProjectileProps/PlantAlmanac …)
        │
        ├─ bridge/stats.js    plantStatsOf()   ← 只解析固定字段名
        │
        ├─ pvz_briefing.cards[]      （lean：无 usage/props/introduction）
        ├─ state.cards[] / state.plants[]（更瘦：只带 dps/reach 等 8 个字段）
        └─ pvz_knowledge.entry       （唯一 non-lean：带 usage + props 前 48 个标量）
```

关键事实：**只有 `pvz_knowledge` 单查才带 `usage` 和 `props`**；
选卡和战斗两个高频入口（briefing / state）都不带。模型不会为了每张卡去单查 233 次。

### 实测覆盖率（用真实资源跑 `bridge/stats.js`）

| 指标 | 数字 |
|---|---|
| PlantProps 条数 | 233 |
| 能算出 `attack`（dmg + interval）的植物 | **69 / 233** |
| 图鉴写了 `DAMAGE` 但 `attack=null` 的植物 | **40** |
| 有 `*Plantfood*` 原始字段、但 `plantFood=null` 的植物 | **138** |
| 图鉴文案里写明"点击"的植物 | 13 |
| `usage.manual=true` 识别出的 | 9（漏 `missiletoe` `escaperoot` `floawerPot`） |
| 能在 `pvz_act` 里触发的点击动作 | **0** |
| ZombieProps 不同字段名 | 331 |
| 进入结构化字段（hp/armor/speed/eatDps/tags/behaviors 8 项）的 | 16 |

---

## 1. 问题一：真伤 / 吸血这类伤害语义

### 现状

`bridge/stats.js` 只认两种"绕过护甲"：

- 弹道 `SupressArmorProtection === true`（9 个弹道）
- 毒伤 `PoisonStacked / Poison / PoisonDPS`

吸血牛肝菌不在其中。它的真实数据是：

```json
{ "DPS": 40, "AttackDuration": 6, "DPSPlantfood": 40, "AttackDurationPlantfood": 10,
  "Toughness": 4000, "MaxToughness": 6000, "Family": "Poison" }
```

`stats.js` 找的是 `Damage` + `AttackInterval` → 都没命中 → `attack=null`。
模型实际收到的是：

```json
{ "type": "vamporcini", "hp": 4000, "family": "Poison", "range": "3x3 范围", "reach": 1,
  "attack": null, "effectiveDps": null, "ignoresArmor": false, "plantFood": null,
  "shot": { "kind": "straight", "blockedByStraightBlocker": true },
  "brief": "一段时间内吸收周围僵尸的血量" }
```

三处错误：
- `DPS:40`、`MaxToughness:6000` 完全丢失（`props` 只在 `pvz_knowledge` 里有）；
- `ignoresArmor:false` —— 与真实行为相反，属于**误导**，比缺失更糟；
- `shot.kind:"straight"` —— 一个 3x3 吸血植物被当成直线射手，还会被墓碑"挡弹道"。

### 同类风险（不止这一张）

| 类型 | 字段 | 现状 |
|---|---|---|
| 持续伤害型 | `DPS` + `AttackDuration` | 5 张（vamporcini 等）全丢 |
| 单发爆发型 | `Damage` 无 `AttackInterval` | 43 张，`attack=null`（樱桃 1800、辣椒 1800、椰子炮 900、大嘴 400） |
| 近身多段 | `AttackDamage` + `AttackInterval` | 部分命中（靠图鉴 DAMAGE 兜底） |
| 直扣本体 | 写在植物脚本 `fruit()`/`attack()` 里 | 无任何字段，只能靠代码语义 |

### 补法

1. **字段别名表**（纯数据，进 `knowledge/`，不进代码分支）：

   ```js
   // 伤害值
   Damage | AttackDamage | StabDamage | DamagePerHit | HeadDamage | SlapDamage |
   TongueSlapDamage | SmashDamage | ExplodeDamage | ExplosionDamage | FlameDamage |
   FireDPS | AttackDPS | ShadowAttackDamage | NormalAttackDamage | Damage0..2 | DPS
   // 间隔
   AttackInterval | ShootInterval | ThrowInterval | AttackDuration | StabInterval |
   DamageInterval | DirectDamageInterval | NormalAttackInterval | ShadowAttackInterval
   ```

2. **伤害语义三分**：`damageType: 'normal' | 'pierce' | 'true' | 'poison' | 'drain'`
   - `normal`：先扣护甲
   - `true` / `drain`：直接扣 `health`（`ignoresArmor:true`）
   - `poison`：持续伤害打本体，但首发弹道仍先打护甲
3. **爆发卡保留数字**：`attack=null` 但有 `Damage` 的，输出
   `burst:{ dmg, area }`，不再让"樱桃炸弹没有伤害值"。
4. **`ignoresArmor` 改成三态**：`true | false | null`（`null` = 未验证），禁止在不确定时给 `false`。
5. **`shot` 修正**：`family=Poison` 且 `range=3x3` 且无弹道 → `kind:'aura'`，不参与弹道遮挡判断。

---

## 2. 问题二：点击类植物没有适配

### 现状

- 识别层**有**：`stats.js#usageFacts` 用正则从图鉴文案提 `activation`，`coconutcannon/hollyknight/banana/bamboozle/glaciershroom/mirrornut/strawburst/firegourd/magnifyinggrass` 都能识别（9 张）。
- 但是：
  1. `briefing.cards` 用 `lean=true`，`usage` 被显式删掉 → **选卡时看不到**；
  2. `state.plants` 没有 `usage` / `manual` / 是否已就绪 → **战斗中也看不到**；
  3. `pvz_act` 的 `ACTION_TYPES` 里没有 `activate` / `fire` / `click` → **根本没有动作**；
  4. 漏检 `missiletoe`（"点击瞄准，再点击目标格子发射"）、`escaperoot`（"点击逃脱树根后…"）、`floawerPot`（"点击使之…移动"）。

结论：这类卡现在是"能选、能种、但不能用"，等价于花阳光买了一个白板。

### 补法

1. **识别改成规则表**（不写 if）：
   ```
   /点击发射|点击喷火|点击冻结|点击消耗阳光|点击瞄准|再点击|点击.*后|tap to/i → click
   ```
   并要求 `aim` 分类：`self`（原地触发，如寒冰菇/镜面坚果）、`lane`（本行，如椰子炮）、`free_cell`（任选一格，如香蕉/槲寄冰仙子/冬青骑士）、`swap`（逃脱树根）。
2. **运行时探测 API**（一次性，用 `scripts/` 里的 CDP 通道）：
   遍历一个临时关卡里的每种点击植物，dump `Object.getOwnPropertyNames(p)` + 原型链 + `typeof p.xxx`，找出真实触发入口（候选：`activate/fire/shoot/onTap/click/useSkill`，或直接 `node.emit('touch-end', evt)`）。
   把结论写进 `knowledge/data/activation.json`，附 `gameBuild` 指纹，游戏更新后重跑。
3. **新动作** `activate`（复用 `plant_food` 的位置语义）：
   ```json
   {"type":"activate","lane":3,"column":5}
   {"type":"activate","lane":3,"column":5,"targetLane":2,"targetColumn":7}  // free_cell/swap 类
   ```
   返回 `ACTIVATE_UNSUPPORTED / NOT_ACTIVATABLE / NOT_READY(restLeft) / NO_TARGET / ACTIVATE_FAILED`。
4. **状态字段**：`state.plants[]` 增加
   `activation:'auto'|'click'`、`aim`、`ready`、`restLeft`（椰子炮 15s）、`charges`（冬青骑士 3 发）、`fireCost`（棱镜草阳光）。
5. **提示词**：卡组里有 `activation:'click'` 的卡时，要求模型把它们写进 plan 的 triggers（"僵尸进 c5 → activate 本行椰子炮"），否则不要选。

---

## 3. 问题三：能量豆（plant food）数据与校验

### 现状

`plantFood` 只有一个数：`PlantfoodDamage || PlantfoodDamageNear` → 全卡池**仅 2 张**命中。

图鉴里 `PLANTFOOD` 元素只有 14 张，且是短语（"盔甲/分身/全屏卷心菜"），不含范围。

菜问的真实数据：

```json
{ "Damage": 15, "DamageHeavy": 30, "DamagePlantfood": 60, "PlantfoodHitCount": 25,
  "ZombieDetectorWidth": 4, "TombDetectorWidth": 3, "AttackInterval": 0.3 }
```

即：能量豆 = 自身周围 3x3 内打 25 段 × 60 = 1500 伤害。
模型看到的却是 `plantFood:null` + `brief:"快速击打身前或身后的敌人"` —— **没有任何"只能在近身生效"的信息**。
提示词第 45 条还写着"图鉴 special 里的叶绿素效果可以帮你选目标"，但 special 里根本没有叶绿素效果，属于**提示词在指引一个不存在的字段**。

### 补法：三层数据 + 一层校验

**第一层｜字段族 → 效果类别**（覆盖 138 张）

| 字段族 | kind | 默认范围 |
|---|---|---|
| `DamagePlantfood` + `PlantfoodHitCount` | `self_aoe_multi` | 自身 ±1 格 |
| `PlantfoodDPS`/`PlantFoodDPS` + `PlantfoodDuration` | `self_aoe_dot` | 自身 ±1 格 |
| `PeaTypePlantfood` + `PlantfoodPeaCount` | `barrage` | 本行（含 `PeaTypeBack` 则前后） |
| `CabbageTypePlantfood` + `PlantfoodProjectilesToFire` | `lob_barrage` | 本行/多行 |
| `PlantfoodKnockbackSPS`/`DragSPS`/`PullSPS`/`PushSPS` | `control` | 本行前段 |
| `HealHPSPlantfood`/`HealthPlantfoodHeal` | `heal` | 自身/友方 |
| `PlantfoodChildrenCount`/`SummonTypePlantfood` | `summon` | 自身格 |
| `PlantfoodSunValuePerZombie`/`PlantfoodTime` | `sun_burst` | 自身 |
| `ToughnessPlantfooded`/`ArmorToughness` | `self_armor` | 自身 |
| `StunDurationPlantfood`/`PlantfoodFreezeDuration` | `freeze` | 本行/全场 |
| `KillCountPlantfood`/`PlantfoodSmashTime` | `execute` | 目标 |

**第二层｜代码语义探测**（补第一层推不出的范围/是否全场）
用 CDP 在真机跑一次：对每张卡 dump `food.toString()`（或 `doPlantFood.toString()`），
用简单特征提取（`getZombiesInRange(` / `LaneZombies` / `AllZombies` / `radius` / `col-1..col+1`），
生成 `knowledge/data/plantfood.json`：

```json
{ "bonkchoy": { "kind":"self_aoe_multi", "radius":1, "hits":25, "dmgPerHit":60, "total":1500,
                "source":"props+code", "confidence":"high" } }
```

**第三层｜人工覆盖**：只给探测失败/语义复杂的少数卡写覆盖条目。

**第四层｜落点校验（解决玩家实际遇到的问题）**
`actions.js#plant_food` 与 `pvz_plant_food` 在执行前用同一份目录算一次"这一豆值不值"：

```json
{ "code":"FOOD_NO_TARGET", "retryable":true,
  "plantFood":{"kind":"self_aoe_multi","radius":1,"total":1500},
  "nearestZombie":{"lane":0,"column":7,"cellsAway":3},
  "hint":"这株的能量豆只对自己周围 1 格生效，最近僵尸在 3 格外；换目标或等它靠近" }
```

- `full_board` / `global` 类：永不报 `FOOD_NO_TARGET`；
- `self_aoe_*`：范围内无僵尸直接拒绝（可 `force:true` 强制）；
- `heal` / `self_armor`：不按"有无僵尸"判断，只在"植物未受伤/未挨打"时给 warning；
- 同一批动作里"先种再给豆"仍走原来的等待逻辑。

配套展示：`state.plants[].plantFood = { kind, radius, targets, whiff:true }`
（`targets` 由 snapshot 现场算，模型不用自己数格子）。

---

## 4. 其它没上传但影响决策的字段（顺带补）

| 字段 | 为什么重要 | 建议 |
|---|---|---|
| `MaxToughness` / `ToughnessPlantfooded` | 吸血/坚果类"能长到多少"，能量豆加甲 | 进 `plantFood.selfArmor` 与 `hpMax` |
| `RestTime` / `AlwaysShoots` | 椰子炮 15s 休息、是否自动开火 | 进 `activation.restSec` |
| `MaxProjectileCount` | 冬青骑士 3 发存量 | 进 `activation.charges` |
| `Lifespan` / `LifeSpan` | 一次性/限时植物 | 进 `lifespan` |
| `ChanceToPlantfood` | 概率掉豆 / 概率触发 | 进 `plantFood.chance` |
| `ImmuneToXxx` / `CannotBeXxx` | 119 个"免疫/不可被"字段 | 统一进 `immunities[]`，与僵尸 tag 对称 |
| `MintBoostedProps` / `MintDamageFactor` | 薄荷加成后的真实强度 | 进 `mint`，缺省 null |
| ZombieProps 317 个未上字段 | 只挑了 8 个进 `behaviors` | 生成 `behaviors` 规则表（`GazeDPS/WalkSPSVarience/TimeBetween/TeamMemberCount…`），不再逐条硬编码 |

---

## 5. 执行顺序（按"玩家可见收益 / 改动风险"排）

### P0-A 能量豆（用户当场踩到的坑）

| 项 | 文件 | 验收 |
|---|---|---|
| 字段族 → kind 规则表 | `knowledge/plantfood.js`（新） | 138 张里 ≥90% 有 `kind`，其余显式 `unknown` |
| `plantFood` 结构化输出 | `bridge/stats.js` | `pvz_briefing.cards[].plantFood.total` 与 `kind` 非空 |
| 现场落点计算 | `bridge/snapshot.js` | `state.plants[].plantFood.targets/whiff` |
| 给豆前校验 | `bridge/actions.js`、`tools/errors.js` | 菜问 3 格外给豆 → `FOOD_NO_TARGET` |
| 提示词改口 | `in-game/prompt.js` 第 45 条 | 删除"special 里有叶绿素效果"，改为"按 `plantFood.kind/radius` 判断" |
| 测试 | `tests/plantfood.test.mjs`（扩展现有 4 个用例） | 覆盖 `self_aoe_multi` / `barrage` / `global` / `heal` 四种 |

### P0-B 伤害字段族（一次性修 40+ 张）

| 项 | 文件 | 验收 |
|---|---|---|
| 伤害/间隔别名表 | `knowledge/damage.js`（新） | cherry/jalapeno/squash/potatomine/coconutcannon/snappea 都有数字 |
| `burst{}` 输出 | `bridge/stats.js`、`bridge/briefing.js` | 一次性卡带 `burst.dmg` |
| `damageType` 三态 | `bridge/stats.js`、`bridge/mechanics.js` | `true_damage` 不再把 `false` 当"确定不是真伤" |
| `shot.kind='aura'` | `bridge/stats.js` | vamporcini/3x3 不再被判"被墓碑挡弹道" |
| 回归 | `tests/damage.test.mjs` | 40 张必须有数字（配额断言，不逐张写） |

### P0-C 点击类卡（当前完全不可用）

| 项 | 文件 | 验收 |
|---|---|---|
| 动作 `activate` | `tools/definitions.js`、`bridge/actions.js` | 4 种错误码齐全 |
| 识别补全 + `aim` | `bridge/stats.js`、`knowledge/activation.js` | 13 张全部 `manual=true` |
| 运行时探测脚本 | `scripts/probe-activation.mjs`（新） | 产出 `knowledge/data/activation.json` |
| 状态暴露 | `bridge/snapshot.js` | `state.plants[]` 带 `activation/aim/ready/charges` |
| 选卡可见 | `bridge/briefing.js` | `cards[].activation`（`lean` 也保留，字段很短） |
| 提示词 | `in-game/prompt.js` | 点击卡必须写进 plan.triggers，否则劝退 |
| 测试 | `tests/activation.test.mjs` | 无 `activate` 动作时不得把点击卡算作输出 |

### P1 真伤/吸血语义

- 用 P0-B 的 `damageType` 承接；`vamporcini` 类先由 `DPS + AttackDuration + Family=Poison` 推 `drain`，
  再由代码探测确认"是否直扣 `health`"；确认前给 `null` 而非 `false`。
- `cardCapabilities` 增加 `self_heal` / `drain`，`armored` 缺口判定允许 `drain` 覆盖。

### P2 观测与防回归

- `npm run probe` 生成 `knowledge/data/*.json`（附加 `gameBuild` 指纹）。
- `tests/data-coverage.test.mjs`：用真实资源跑一遍，断言配额（≥95% 有 `kind`、13/13 点击识别、0 张"图鉴有 DAMAGE 但无伤害值"），配额掉了直接失败。
- `scripts/live-play.mjs` 采样增加 `plantFoodAttempts[]`（kind/whiff/实际是否生效），下次同类问题能直接定位。

---

## 7. 完成情况（0.1.28）

| 计划项 | 状态 | 实现 / 验收 |
|---|---|---|
| P0-A 能量豆结构化 | 完成 | `knowledge/plant-rules.js#plantFoodFacts`（13 类 kind / 9 种 area）、`stats.plantFood`、`snapshot.plants[].food`、`brief.plantFoodPlan`；157 张卡全部分类，`kind=unknown` 0 张 |
| P0-A 空放校验 | 完成 | `actions.plant_food` 新增 `FOOD_NO_TARGET`（不扣豆，带 `nearestZombie.cellsAway`）、`force:true` 强制；`tests/plantfood.test.mjs` 覆盖菜问近身/本行两种 |
| P0-B 伤害字段族 | 完成 | `damageModel`（17 个伤害字段 + 11 个间隔字段 + 3 个 DPS 字段 + 3 个持续时间字段）；`attack` 69→81、`burst` 44 张；"图鉴有 DAMAGE 但没伤害值" 0 张 |
| P0-B 伤害语义 | 完成 | `damageType = normal/poison/true/drain`、`armorState = yes/no/unknown`、`shot.kind = aura/aimed`；吸血牛肝菌识别为 drain 且无视护甲 |
| P0-C 点击类卡 | 完成 | `pvz_act.activate` + 10 个候选方法 + `targetLane/targetColumn`；`state.plants[].activation/aim`、`brief.activatePlan[]`；13 张点击卡全识别，`aim` 分 self/lane/free_cell/swap/move |
| P1 真伤/吸血 | 完成 | 复用 `damageType`；`cardCapabilities` 增加 drain→true_damage、burst→burst |
| 僵尸自动理解 | 完成 | `knowledge/zombie-rules.js`：`immunities[]`（143 只）/`spawns[]`（81 只）/`boss`（35 只），未归类字段 0 |
| P2 防回归 | 完成 | `npm run plants`（`--missing` / `--zombies`）、`tests/data-coverage.test.mjs` 5 项配额断言、`tests/plant-data.test.mjs`、`tests/activation.test.mjs` |

**仍然待做（未包含在本次）**

- `activate` 已改成调用游戏自己的 `specialPlantOnMouseDown()`（真机探明），不再是"猜方法名"；仍未在实机上点过一次真实对局，等下一次关卡验证 `via=specialPlantOnMouseDown(+trigger)` 和 `NOT_READY` 的 `liveState` 是否符合预期。- `plantFood.radius` 对少数卡是推断值（`self_aoe` 一律按 1 格算），没有从代码里读到真实半径；拦截只对 `area` 生效，半径偏大会漏拦不会误拦。
- 僵尸 `behaviors` 里那 8 个手挑字段可以按 `zombie-rules` 的方式继续合并，减少一处硬编码。

> 与上面计划的差异：没有新增 `knowledge/activation.js` 和 `scripts/probe-activation.mjs`——激活规则直接放进 `knowledge/plant-rules.js`，运行时用 `state.brief.activatePlan[].api` 回报真实存在的方法名，比离线 dump 更不容易过期（游戏更新后自动反映）。

## 6. 风险

- **代码探测依赖版本**：`food.toString()` 在压缩/混淆后会失真，必须有 `props` 兜底与 `unknown` 而不是猜。
- **`self_aoe` 半径**：`ZombieDetectorWidth=4` 不等于半径 1，不要直接拿它换算；只能作为"是否近身"的佐证。
- **不要为了省 token 把 `activation`/`plantFood` 又放进 lean**：这两个字段每个不足 40 字节，属于"决策必需"，必须常驻。
- **`ignoresArmor:false` 的历史缓存**：一旦改成三态，旧 `plan` 里"这卡不是真伤"的结论会失效，需要在 `pvz_briefing` 里带一句版本提示。
