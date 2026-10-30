# knowledge/

植物/僵尸/关卡事实。只存**数值与图鉴原文**，不存"推荐卡组/打法"。

- `worlds.js`：世界机制事实（水面、矿车、恐龙、传送门、墓碑等）。运行时以 `snapshot.mechanicFacts` / `levelScript` / 实际地形为准。
- `data/plants.json`、`data/zombies.json`：由 `scripts/build-knowledge.mjs` 从 `../game code/CODE` 生成，供测试、文档和离线查询使用。
- 游戏内 `pvz_knowledge` 读游戏资源（PlantProps / PlantAlmanac / ZombieProps / ZombieAlmanac / ArmorProps / Features）；资源里没有的名称会回退到 codename。静态包不打包进模组，避免增大入口文件。

重新生成：

```bash
node scripts/build-knowledge.mjs
```

字段：

- 植物：`type/name/cost/cd/hp/family/range/attack{dmg,interval,dps}/sun{stages,interval,intervalNight,perSecDay,perSecNight}/brief/introduction/special/weaknesses`
- 僵尸：`type/name/hp/armorDetail/armorHp/ehp/speed/eatDps/tags/brief/introduction/special/weaknesses`

`ehp = hp + armorHp`；`dps = dmg / interval`。都是可验算的事实，不含结论。
