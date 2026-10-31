# knowledge/

植物/僵尸/关卡事实。只存**数值与图鉴原文**，不存"推荐卡组/打法"。

- `worlds.js`：世界机制事实（水面、矿车、恐龙、传送门、墓碑等），以及 `TAG_COUNTERS`（tag→机制说明/能处理的卡/`needs` 能力）与 `CAPABILITY_FACTS`（能力说明）。运行时以 `snapshot.mechanicFacts` / `levelScript` / 实际地形为准。
- `tags.js`：僵尸 tag 唯一规则表（`TAG_RULES`）与 tag→能力需求（`TAG_CAPABILITIES`）。新增僵尸/机制只加规则；`bridge/mechanics.js` 从卡牌数值 + `TAG_COUNTERS.plants` 推导卡组能力，`coverageGaps` 按整关 tag 汇总缺口。
- `plant-rules.js`：植物字段族规则——伤害值/攻击间隔/DPS/持续时间的别名表、`damageType`（normal/poison/true/drain）、能量豆字段族→效果类别与范围、点击类激活方式与 `aim`。**新增植物只要字段落在已知族里就自动适配**；完全没见过的能量豆字段会得到 `kind=unknown` 而不是 `null`（`npm run plants` 可以核对覆盖率）。
- `zombie-rules.js`：僵尸「怕什么 / 会放什么 / 是不是 Boss」——`Immune* / CannotBe* / IgnoredBy*` 字段族归类成 `immunities[]`，`*Type(s)` 归成 `spawns[]`，`ZombossStages` 才算 Boss。未归类字段会进 `behaviorUnknown`，不静默丢弃。
- `data/plants.json`、`data/zombies.json`：由 `scripts/build-knowledge.mjs` 从 `../game code/CODE` 生成，供测试、文档和离线查询使用。
- `data/mechanics.json`：由 `scripts/build-mechanics.mjs` 从游戏 JSON 生成的核对数据（字段/护甲/出土时间/tag），运行时仍以游戏资源为准。
- 游戏内 `pvz_knowledge` 读游戏资源（PlantProps / PlantAlmanac / ZombieProps / ZombieAlmanac / ArmorProps / Features）；资源里没有的名称会回退到 codename。静态包不打包进模组，避免增大入口文件。

重新生成：

```bash
node scripts/build-knowledge.mjs
```

字段：

- 植物：`type/name/cost/cd/hp/family/range/attack{dmg,interval,dps}/sun{stages,interval,intervalNight,perSecDay,perSecNight}/brief/introduction/special/weaknesses`
- 僵尸：`type/name/hp/armorDetail/armorHp/ehp/speed/eatDps/tags/brief/introduction/special/weaknesses`

`ehp = hp + armorHp`；`dps = dmg / interval`。都是可验算的事实，不含结论。
