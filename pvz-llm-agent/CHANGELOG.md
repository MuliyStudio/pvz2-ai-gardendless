# Changelog

## 0.4.13 — 2026-10-31

> 从本版起，模组版本号与 GitHub release 统一为 **0.4.13**（上一版模组 0.1.28）。

**配置页 / 思考窗可缩成大肥鱼桌宠，界面按钮改图标**

- **配置页缩小 → 关闭配置页和思考窗，只留桌宠**；点桌宠展开 **AI 思考窗**，思考窗右上角新增**齿轮按钮**打开配置页。配置页只是 `display:none` 隐藏，不会被销毁。
- **思考窗**：缩小 → 桌宠；`×` → 直接关闭，不生成桌宠（配置页也关着时保留桌宠作为入口）。
- 能量豆策略改为“默认攒着、只在值得时用”：满豆、3 只以上集群、Boss/巨人/铁桶/滚筒、某行即将失守、关键植物被啃；普通波次 1 只普通僵尸不再喂豆。
- 桌宠有 6 组动作：待机 / 思考（桌前写字）/ 成功 / 失败 / 等待 / 悬停；精灵图 7×6 内联在 `in-game/pet-sprites.js`，不依赖外部文件。
- 气泡打字机：`thinking` 增量逐字显示，`tool_call` 显示人话动作，`tool_result` 显示真实结果首行；超长自动滚动，非思考 10 秒后淡出。
- 桌宠可拖动并记住位置；单击桌宠/气泡恢复对应窗口。
- 界面按钮改为 **Lucide 图标**（ISC License）：缩小 / 思考窗 / 清空 / 关闭 / 测试 / 开始 / 停止 / 导出 / 导入 / 复制 / 折叠箭头全部图标化，悬停有中文 tooltip。
- **显示/隐藏思考窗移到配置页主按钮区**，和测试/开始/停止并列；配置页标题栏只保留“缩小为桌宠”。
- 配置页默认模型改为 `deepseek-flash`，战斗快模型默认 `deepseek-chat`。
- 素材来自 `gmskywalker/deepseek-fat-fish-codex-pet`（社区二创，个人使用，非商用）；重新生成用 `npm run pet:sprites`。

## 0.1.28 — 2026-10-31

**数据完整性：伤害语义 / 能量豆 / 点击类卡（新植物与僵尸自动适配）**

- **伤害模型改为字段族驱动**（`knowledge/plant-rules.js`）：`Damage / AttackDamage / StabDamage / DamagePerHit / HeadDamage / DPS / AttackDPS / FireDPS…` × `AttackInterval / ShootInterval / ThrowInterval / AttackDuration…`。真实数据里能算出攻击的卡从 **69 → 81**；`attack=null` 的单发卡不再"没有伤害值"，改给 `burst.dmg`（**44 张**，樱桃 1800、辣椒 1800、椰子炮 900、大嘴豌豆 400）。测试配额：图鉴写了 DAMAGE 但没伤害值的卡 **0 张**。
- **真伤/吸血语义显式化**：`damageType = normal | poison | true | drain`，`armorState = yes | no | unknown`。吸血牛肝菌（`DPS 40 + AttackDuration 6 + 吸取血量`）现在会被识别成 `drain`：`attack.dps=40 / ignoresArmor=true / shot.kind=aura`，`hpMax=6000`（以前是 `attack:null` + `ignoresArmor:false`，属于反向误导）。`armorState=unknown` 只在真的没证据时出现，不再拿 `false` 冒充"确定吃护甲"。
- **能量豆结构化**：`plantFood = { kind, area, radius, total, durationSec, confidence }`。真实卡池 **157 张**有专属效果（以前只有 2 张能读到 `PlantfoodDamage`），`kind=unknown` **0 张**。菜问 = `self_aoe_multi / 半径 1 / 1500 伤害`，吸血牛肝菌 = `self_aoe_dot / 400`。
- **给豆前先算空放**：`state.plants[].food` 带现场 `targets / whiff / cells`，`brief.plantFoodPlan` 按 `targets × total` 排好序。范围内没僵尸时 `plant_food` 直接返回 **`FOOD_NO_TARGET`**（带 `nearestZombie.cellsAway` 与本株范围，**不扣豆**），`force=true` 可强制。治好了"菜问周围没僵尸被喂豆"。
- **点击类卡可用**：新增 `pvz_act.activate`（`{ type:"activate", lane, column, targetLane?, targetColumn? }`）。真机探明游戏入口是每株点击植物都实现的 `specialPlantOnMouseDown()`（不需要鼠标事件）；狙击类（冬青骑士/香蕉火箭炮/整人竹/槲寄冰仙子）在这里进入瞄准，再由 `trigger(目标格)` 打出那一发，所以 `aim=free_cell|swap` 必须带 `targetLane/targetColumn`。调用顺序：`specialPlantOnMouseDown` → `onMouseDown(伪造左键)` → 常见方法名兜底；点不动返回 `NOT_READY + liveState`（`sleepCD/shooting/fooding/shootCD/growthStage`），找不到入口返回 `ACTIVATE_UNSUPPORTED + tried`，不假装成功。`state.plants[].activation/aim`、`brief.activatePlan[]`（含 `frontZombie / shouldAct / api / live / charges / restSec`）常驻。
- **选卡被人工接管时也不丢信息**：`state.cards[]` 与 `seedSelection.available[]` 现在每回合都带 `activation / burstDmg / damageType / armorState / foodKind`——玩家自己选卡、模型没读到开局简报时，仍然知道「这张是点击卡、这张单发 900、这张豆是近身型」。
- 识别口径从"文案写点击发射"放宽到"任意点击描述"，13 张点击卡全部识别（补上槲寄冰仙子、逃脱树根、飞天花盆），并区分 `aim = self | lane | free_cell | swap | move`。
- **新植物 / 新僵尸自动适配**：所有规则都是"字段族 / 文案特征"，不写卡名。`npm run plants`（`scripts/plant-data-report.mjs`，加 `--missing` / `--zombies` 看细节）随时核对覆盖率；`tests/data-coverage.test.mjs` 用真实资源跑配额（伤害值 0 缺失、能量豆 0 unknown、点击卡 100% 识别、僵尸免疫字段 0 未归类），出现没被识别的新字段直接红。
- 配套：`pvz_briefing.cards[]` 新增 `burst / damageType / armorState / activation / aim / plantFood`（lean 也带 `activation/aim`，`plantFood` 在 lean 只留 4 个数）；`state.cards[]` 同步；提示词把"图鉴 special 里有叶绿素效果"的错误指引换成 `plantFood.kind/area/radius/targets`，并新增点击卡必须写进 `plan.triggers` 的要求。
- **僵尸侧同步补全**：`zombies[].immunities / spawns / boss / behaviorText` 从 27 个 `Immune*/CannotBe*/IgnoredBy*` 字段和 `*Type(s)` 召唤字段自动归类（143 只僵尸有免疫事实、81 只有召唤、35 只 Boss），未归类字段进 `behaviorUnknown` 而不是被丢掉。提示词加了"免疫冰冻的别靠控制、会召唤的要带多目标、Boss 留爆发"的判断依据。
- 测试 137 项通过（新增 `tests/plant-data.test.mjs`、`tests/activation.test.mjs`、`tests/data-coverage.test.mjs`，扩展 `tests/plantfood.test.mjs`）。
- 真机验证（0.1.28，第 16 波关卡）：AI 自己选出 `coconutcannon` 并在 wave 17 主动 `activate @ 3,7 → via specialPlantOnMouseDown`；额外探针第一次 `ok:true/via specialPlantOnMouseDown`，第二次正确返回 `NOT_READY`（`sleepCD=0.087`）；给豆两次被 `FOOD_NO_TARGET` 拦下（菜问那种范围外空放）。
- **修复 0.1.28 加载报错 `Identifier 'usageFacts' has already been declared`**：`knowledge/plant-rules.js` 与 `bridge/stats.js` 各有一个 `usageFacts`，bundle 拼在同一作用域时重复声明。规则表里的改名为 `usageFactsOf`，`stats.js` 保留对外兼容的 `usageFacts`。`scripts/build.mjs` 新增两道打包期校验：**顶层标识符重名**和**import 名字是否真的存在**（以前路径对、名字错要到调用时才 undefined）。

## 0.1.27 — 2026-10-31

**地刺落点 / 真伤毒伤数据 / 完美通关口径**

- **地刺不再种在墙后**：地刺/地刺王这类“僵尸走过这一格才受伤”的卡（`stepDamage`，从图鉴 `AREA=本格` / “不会被僵尸啃食”识别）必须种在墙**前**（墙右侧）。种在墙后会被新校验拦下并返回 `SPIKE_BEHIND_WALL` + 墙前可种位；批量预检也会在“同一批先种墙、再把地刺种到墙后”时提前拦截。同时把地刺从普通“输出”规则里排除，避免它被 `OUTPUT_IN_FRONT_OF_WALL` 误推到墙后。
- **真伤/毒伤数据进入事实层**：`stats` 现在会读 `ProjectileProps/ProjectileTypes`（植物 `PeaType/SporeType` 等指向的弹道），把毒伤（`PoisonStacked/Poison/PoisonDPS` → `poison{dps,duration,stacks,total,slow}`）和真伤（`SupressArmorProtection`）带到 `pvz_briefing.cards` / `levelContext.cards` / `pvz_knowledge`。`attack.ignoresArmor/trueDamage` 与 `poison` 会让卡组获得 `true_damage` 能力；`armored` 缺口现在由 `high_dps` **或** `true_damage` 任一覆盖（例如黏毒豌豆不再被判定为“缺高 DPS”）。
- **完美通关口径调整**：植物损失属于正常战术代价，不再算“不完美”。只有丢车、保护格死亡、关卡任务失败才触发胜利后的复盘；胜利且只损失植物时不写复盘、不显示“植物损失”负面结论。
- 文档/工具契约同步：`SPIKE_BEHIND_WALL`、`true_damage`、`stepDamage` 字段与能力映射；测试 117 项通过。

## 0.1.26 — 2026-10-31

**LevelContext / 能力审计 / 计划审计 / 批量预检**

- **`pvz_briefing.levelContext`**：整关一次性索引——世界与机制、地形/障碍摘要、全部波次的类型与固定行、全部僵尸 tag/克制、卡池数值与能力、卡组缺口、历史。开局读一次即可，不必再逐个查僵尸/卡。`levelFacts` 继续用资源名（`egypt1`/`west13`）推断世界，推断不到返回 `null`。
- **能力审计（不再按 tag→卡名硬编码）**：`knowledge/tags.js` 新增 `TAG_CAPABILITIES`（`group→multi_target`、`rolling→anti_rolling`、`flying→anti_air`、`armored→high_dps`、`newspaper→burst/pierce`、`crush/gargantuar→control/burst`、`steal→protect_key`、`lane_switch→multi_lane`…），`knowledge/worlds.js` 新增 `CAPABILITY_FACTS` 并把 `needs` 挂到 `TAG_COUNTERS`。`bridge/mechanics.js` 从卡牌 `attack.targets/pierceCount/dps/multiDps/splash/reach/armTime` 加克制事实推导卡组能力。
- **整关 `coverageGaps`**：`bridge/mechanics.js#coverageAudit` 汇总**所有波次**的 tag（不再只看当前/下一波），给出缺哪些能力、哪些 tag 需要它、卡池里哪些卡能满足（`candidates`，只给事实）。`snapshot.brief.coverageGaps`、`briefing.coverageGaps`、`deck.capabilities` 同源；`deck.counterGaps` 保留为逐僵尸旧读法。骆驼牌/旗帜波会提示 `multi_target`，滚桶关会提示 `anti_rolling`。
- **计划审计**：`bridge/plan.js#auditPlan` 在 `pvz_set_plan` 保存后立刻按本关事实检查：只有一段文本（`PLAN_TEXT_ONLY`）、缺能力却没写 counters（`PLAN_MISSING_COUNTER`）、计划卡组和实际卡组不一致（`PLAN_DECK_MISMATCH`）、lane 越界（`PLAN_BAD_LANE`）。warning 不阻止保存，但会回给模型并显示在思考窗；`pvz_briefing.planAudit` 与 `plan_audit` 约束在下一轮继续提醒。
- **批量预检（P1-3）**：`bridge/mechanics.js#batchPreflight` 在执行前检查一批动作——同卡重复且基础冷却 >3.5s → `BATCH_COOLDOWN`（带 `maxSuccess`，不会一轮连发 3 个 20s 墙）；同一格先种后铲/重复种 → `BATCH_CONFLICT`（`conflictWith`）；同批先种墙再把输出种到墙右侧 → `OUTPUT_IN_FRONT_OF_WALL`。先铲后种仍是合法连招。
- **墙的支撑时间按总啃食 DPS**：`wallSurvive` 用该行所有僵尸的 `eatDps` 之和计算 `wallSurviveSec`（多只叠加不再按最前一只估算）；`brief.wallRebuildPlan` 给多行缺墙时的补墙顺序、`startInSec`、`feasible`。
- **特殊机制声明化**：`knowledge/tags.js` 补齐变羊、渔夫拉植物、章鱼封植物、渡渡鸟跳越、黄鼠狼放小怪、淘金者绕后、太阳神偷阳光、换行/加速等 tag 规则与能力需求；`snapshot.mechanicFacts` 的文案改为直接读 `TAG_COUNTERS`，新增单位只加规则，不改 `snapshot/agent`。
- **复盘更严格**：note/lessons 只能引用真实存在的行（1–5）与列（c0–c8），越界直接丢弃；复盘仍只在关卡结束触发，丢车中途只记录事实。
- **成本与观测**：`briefing.cards` 不再带 `weaknesses/usage`（完整条目仍走 `pvz_knowledge`）；`state.cards[]` 增加 `baseCd/family/dps/reach`（批量预检用，字段很小）；`scripts/live-play.mjs` 采样增加 `plan/timings/guardCodes`，新增 `npm run replay` 把报告回放成时间线（state、计划变化、模型/工具耗时、guard code）。
- 测试 110 项通过（新增能力审计、计划审计、批量预检、墙总 DPS、报纸 EHP、LevelContext、history 读回、复盘写入时机）。

## 0.1.25 — 2026-10-30

**保护格几何约束 / 双层模型 / 失败经验自动复盘**

- **保护格不再靠模型猜距离**：`state.protectCells` 增加 `frontColumn`；`state.brief.protect` 给出每个保护格的 `guardColumns`（同行 c±1）；`pvz_briefing.constraints` 增加一条明确的硬约束。`state.brief.protect.cells` 与 `pvz_briefing.protect` 都可直接读。同时把 `endangered / protect_plant` 地块（花园无尽“保护濒危植物”）合并进 `protectCells`，不再只认 `flowerLine`。
- **短手落点硬校验**：种植/换植时，如果目标格与同行保护格的列差超过该卡射程（接触/接近/前后/3x3/N 格），返回 `PROTECT_TOO_FAR` 并附 `guardCells`，不再先种下去再发现“够不到”。远程/整行/抛物不受影响。
- **双层模型**：浮窗新增“战斗快模型”（`fastModel`）。开局/选卡/复盘用主模型，进入 `running` 后自动切快模型；`escalateEvery`（默认 6 步）与紧急任务/多行压力/保护格死亡会自动临时升级回主模型。全部可留空关闭。
- **失败经验自动复盘**：本关失败（`autoReview: 'lost'`，可改 `always`/`off`）后自动用主模型复盘一次，把 `note` + `lessons` 写进这一关的记忆。`lessons` 每关最多 8 条、自动去重，下次开局通过 `pvz_briefing.history.lessons` 直接读到。
- **记忆可备份**：`bridge/api.js` 新增 `addLevelLessons / exportLevelMemory / importLevelMemory`；`pvz_level_memory` 支持 `lessons` 和指定 `key` 写入。仍是按关卡隔离的 `localStorage`。
- **修复切模型 400（`reasoning_content`）**：DeepSeek 思考模式要求历史 assistant 消息回传 `reasoning_content`。现在同模型内会把推理原样回传；跨模型切换时不再搬运旧上下文，而是重建“系统提示 + 当前计划 + 最近状态 + 玩家指示”的交接消息，既避开校验，也让快模型从计划开始执行。周期升级改为连续 2 轮主模型，减少来回切换。
- **准备模式结构化（`state.prep`）**：`mode=normal | preplant | conveyor | forced_deck`，附 `canStart / deckLocked / lockedCount / availableCount / gameStarted`。提前布阵关不再只靠 `phase=running` 猜；传送带关明确不能选卡；给定/锁定卡组时 `pvz_choose_deck` 原样返回 `actualDeck`，不再撞 `CARD_NOT_AVAILABLE / DECK_CLEAR_FAILED`。prompt 与 briefing 按 mode 分支。
- **省 token：每轮少一次模型往返**：`pvz_act` 返回里直接带动作后的精简 `state`（含 `changesSinceLast`/`events`），prompt 改成“下一轮用这份 state，不再调 `pvz_state`”。只有刚进战斗、换波或需要完整地形时才读状态。
- **省 token：状态瘦身**：`pvz_state` 默认去掉 `board/terrain/plantable/obstacles/levelScript/zombieStats` 等简报已给过的字段；要全量传 `full=true`。单份状态约小 30–50%。
- **省 token：保住 prompt 缓存**：不再每轮改写旧工具结果（那会让上游缓存每轮失效），改成整段丢弃；消息窗口 28→24。
- **省 token：简报去重**：同一关 30 秒内第二次 `pvz_briefing` 只返回一句“和上一条相同”，不再重复几千 token。
- **决策日志可复制**：思考窗“决策日志”标题右侧新增“复制”按钮，整段复制当前日志（带时间戳）；Clipboard API 不可用时自动退回 `textarea + execCommand`，按钮会短暂显示“已复制/复制失败”。
- **赛后复盘改为“失败现场快照 + 可验证归因”**：`review.snapshot` 记录失败那一波的完整现场（关卡/波次/阳光/任务/保护格/植物/僵尸/每行压力/最近事件）；自动复盘把这份快照和最近 10 个操作喂给模型，并要求 `cause.zombies` 只能引用现场存在的僵尸、必须命中死亡保护格所在行。模型归因和快照对不上时，自动退回事实诊断（例如“保护格全灭但植物损失为 0 = 被越过防线落花”）。复盘结果用 `replaceLessons` 覆盖旧经验，避免错误的旧结论一直保留。
- **后台参谋并行**：快模型执行时，主模型在后台用“当前计划 + 最近状态”想下一波风险，结果作为 `advisor.note` 附在下一份状态/动作结果里，不阻塞操作；`escalateEvery` 默认改为 0（不再每 6 步强制切慢模型），只在紧急任务/多行压力时升级。
- **三叶草时机写死**：`pvz_knowledge`/`pvz_briefing` 的 blover 条目带 `timing`，prompt 明确“flying 只代表会飞，落地后三叶草无效”；保护关的飞行约束也提示落地后改用地刺/菜问/樱桃。
- **延迟再降**：消息窗口 24→20，`loopDelayMs` 350→200。
- **克制关系进入结构化事实**：新增 `TAG_COUNTERS`（rolling→地刺可扎破、墙无效；flying→三叶草只在空中有效；carries_imp/crush/armored 等）。`pvz_briefing.threatCounters`、`zombies[].counters`、`state.brief.incoming[].counters`、`state.zombies[].counters` 都会带出来；`deck.counterGaps` 直接标出“卡组里一个对应卡都没有”的机制（例如有滚桶但没地刺），prompt 要求选卡后补齐再开局。
- **后台参谋可见化与并行动作**：参谋请求在工具执行前发出，结果同时显示在“推理原文”（`[后台参谋] ...`）并作为 `advisor.note` 附在本次状态/动作结果里；前台快模型保留最终决策权，紧急情况自行处理。
- **延迟收尾（不动工具定义）**：`pvz_act` 后 2.5 秒内重复调 `pvz_state` 直接返回 `duplicate` 摘要（`force/full` 可绕过）；每轮日志输出“模型耗时 · 工具耗时 · 调用数”；单独 `pvz_wait_until` 会提示下轮把 wait 放进 `pvz_act`。工具定义/参数语义完全保留。
- **保护关布防可见化**：`state.brief.protect.cells[].groundGuarded / wall / melee` 和 `protect.unguardedLanes` 直接标出“这一行还没有墙/近战守花”；briefing 增加 `protect_unguarded` 硬约束，优先级高于继续铺经济。
- **墙落点硬校验**：墙类植物种在该行最前僵尸的右侧/同列时返回 `WALL_TOO_LATE`，附左侧可种位；避免“僵尸已到 c4.6，还把花生种到 c5”。
- **复盘数值校验**：模型 note/lesson 与 review 的 `plantsLost` 等硬数字冲突时被丢弃；保护关全灭时注明“判负会同时标记全部保护格”，避免误读成 5 行都被踩。
- **短手射程数字化**：`stats` 新增 `reach`（列差）：接触=0、接近/前后/3x3=1、N 格=N；`pvz_briefing.cards[].reach`、`pvz_knowledge.entry.reach`、`state.cards[].reach`、`state.plants[].reach` 都会带出来。prompt 明确“菜问 reach=1，花在 c3 时 c1/c5 都差 2 格打不到”；`PROTECT_TOO_FAR` 也优先用 `st.reach`（花生 4 格不按短手处理）。
- **选卡清空竞态修复**：清空后等待/再次清理 UI 异步回填的预设卡，并在加卡前删掉不在请求里的多余卡；避免 `actualDeck` 混入 spikerock/cherry_bomb、jalapeno/iceburg 被 no_slot 顶掉。`choose_deck` 在 objective 阶段会先自动关任务弹窗，不再白白浪费一轮。
- **保护格不能种**：新增 `PROTECT_CELL_BLOCKED`，任何植物直接种在保护格上都会被拒绝并给左右可种位；配合 `PROTECT_TOO_FAR`（短手够不到）和 `WALL_TOO_LATE`（墙在僵尸身后）三层落点校验。
- **玩家指令队列**：`sendInstruction` 不再直接插进 messages（会插在 assistant(tool_calls) 和 tool 之间，导致下一轮 400）。改为安全点入队，本轮工具结果全部回填后再加入。
- **空中窗口显式化**：`zombies[].airborne`、`state.brief.airRaid`（当前空中的荡索/小鬼炮、行/列）；briefing 增加 `air_raid` 约束。`blover` 在没有 `airRaid` 时种植返回 `NO_AIR_TARGET`，避免落地后才种三叶草。
- **失败/退出判定修正**：快照 `level.won/lost`；running → menu/worldmap 时用上一帧的输赢标记补判，避免“失败直接回地图”被记成 `left` 导致不复盘。UI 对 `menu/worldmap` 显示“已离开关卡”，不再一律叫失败。
- **墙与输出的位置规则**：`lanes[].wallCells/shooterCells`；新增 `OUTPUT_IN_FRONT_OF_WALL`，输出种在本行墙右侧会被拒，返回墙左侧空位或 `replaceAt`（先 replace 墙为输出，再把新墙补到右侧）。prompt 明确“墙不是永久位，dps 够时可以换掉”。
- **土豆雷出土时间**：从 `PlantProps.ChargeTime` 提取 `armTimeSec`（土豆雷 14s），进入 `cards/plants/knowledge`；新增 `MINE_TOO_LATE`，按僵尸距离算剩余时间，来不及就拒绝并建议改瞬爆卡。`COOLDOWN` 对 replace 会注明“铲除无冷却，这是新卡种子冷却”。
- **本地算好的地雷时序**：`state.brief.minePlan` 按卡/行给出 `armTimeSec / front / latestSafeColumn / safeColumns / etaAtLatest / tooLate`；`MINE_TOO_LATE` 用同一套算法拦截“贴脸埋雷”。
- **复盘策略改为不完美就记**：`autoReview` 默认 `imperfect`；胜利但有丢车/植物损失/保护格死亡也总结，离开/重开只要已有损失也总结。任何一次丢车会立刻写一条 `丢车总结` 到本关记忆，并在最终复盘里合并。
- **全量标量属性**：`stats` 自动收集 `PlantProps/ZombieProps` 的所有标量字段到 `pvz_knowledge.props`（briefing 仍精简不带，避免每轮膨胀），新增植物/僵尸不需要手写字段即可查询原始数值。
- **自动 mechanics 数据生成**：新增 `scripts/build-mechanics.mjs`（`npm run mechanics`），从 `game code/CODE/Objects/*.json` 生成 `knowledge/data/mechanics.json`：233 植物 / 378 僵尸 / 52 护甲的字段、护甲、出土时间、标签与 tag 克制。runtime 仍以游戏资源为准，生成物用于核对/扩展计算层。
- **结构化 plan**：`pvz_set_plan` 归一化为 `pvz-plan/v1`：`text` 给玩家，`lanes/counters/phases/triggers/emergency/thresholds` 给快模型；UI 按结构化字段展示。快模型通过 `state.plan` 和模型切换 handoff 读取，不再只吃一段文本。
- **`bridge/mechanics.js` 纯计算层**：`travelSec / ttkSec / canKillBeforeHouse / armWindow / counterMatrix / laneMath`，不读游戏对象、不做策略。`state.brief.laneMath` 直接给 `killSec/etaSec/canKillBeforeHouse`；`state.brief.counterMatrix` 直接给 `deckAnswers/missingTags`；`minePlan` 与守卫使用同一套时间算法。
- **复盘只在关卡结束触发**：丢车时只记录事实（供结束后合并），不再中途写记忆/刷“丢车总结”；关卡结束（失败/不完美胜利/有损失的离开或重开）才写 `note + lessons` 到本关记忆。完美通关不写。
- **墓碑逐行事实**：`lanes[].tombColumns / straightBlocked`、`brief.tomb`（哪些行有墓碑、哪些行完全无墓碑）；全局 mechanics 文本改为“只影响所在行”。briefing 增加约束，prompt 明确“无墓碑行照常用豌豆/直线，不要全关只用投手”。
- **墙的时序计算**：`state.brief.wallPlan` 给每行 `wallHp / wallSurviveSec / wallCd / risk`；prompt 明确同一张墙卡一轮只能成功 1 个（通常 20s 冷却），多行缺墙按风险排序，其余用土豆雷/瞬爆拖。
- **多目标/穿透计算**：从 `PlantProps.PierceCount` + 图鉴“目标数/两次”提取 `attack.pierceCount/targets/hitsPerTarget/multiDps`；`lanes[].dpsGroup` 是同行 ≥2 只时的有效 DPS，`laneMath` 自动用群体 DPS。回旋镖不再按单目标 7.4 DPS 评估。
- **骆驼牌/成组僵尸**：新增 `group` tag（图鉴含“组队/每组三名或以上”），`TAG_COUNTERS.group` 指向多目标卡；回旋镖的 `multiDps` 会被 `counterMatrix.deckAnswers`/`lanes.dpsGroup` 采用。修正 `ChooseToSpawnOnNonDeckRows` 被误标为 `flying`，以及 `newspaperHp` 未计入 EHP。
- **进入关卡的世界事实修正**：`levelFacts` 现在用关卡资源名（如 `egypt1`）推断世界，`briefing.world` 不再因 `world:null` 丢失世界机制；所有僵尸 tag 规则集中到 `knowledge/tags.js`，运行时与 `build-mechanics` 共用，不再两处各写一套。
- 测试 89 项通过（新增 mechanics 纯函数测试）。

## 0.1.24 — 2026-10-30

**修 0.1.23 加载失败：漏打包 latency 模块；再压一轮上下文**

- **`createLatencyStore is not defined`**：`bridge/latency.js` 忘了加进 `scripts/build.mjs` 的 `MODULES`，源模块测试全绿但 bundle 缺函数，游戏里一加载就报错。已修复。
- **两道防线**：`npm run build` 现在会校验每个相对 `import` 都出现在 `MODULES`（漏了直接失败）；新增 `tests/bundle.test.mjs`，在 vm 里真正执行 `pack/scripts/main.js` + `setupInGame`，断言 `forecast / latency / briefing` 都在。
- **每回合少一次模型往返**：`pvz_state` 自带 `events`；prompt 不再要求先 `pvz_events`；只等阳光/冷却就把 `wait` 并进同一批 `pvz_act`。
- **上下文再压**：窗口 40 → 28，只保留最近 1 条完整工具结果，进入 running 时把开局简报归档成一句话。
- **`state.brief.incoming`**：接下来两波的 `types / newTypes / total / ehp / flag`，摆荡僵尸、小鬼炮这类出场前就能提前布防。
- **`state.protectCells`**：读 `flowerLine` 的 `lIndex/cIndex/dead`，「别让僵尸踩坏鲜花」不用再猜位置。
- 计划只在 `planSavedAt` 变化时播报，不再每回合刷屏。
- 共 76 项测试全通过（含整包冒烟）。

## 0.1.23 — 2026-10-30

**提前知道波次 / 关卡记住上一局 / 选卡不再只看熟脸**

玩家提的三件事：静态波和动态波能不能先算出来、每关要不要留总结、选卡是不是根本没查图鉴。

- **波次预测（`forecast`）**：`bridge/forecast.js` 解析 `currentLevelObjects`，分清静态波与动态波。静态波给类型/数量/EHP，写死的 `Row` 变成 `lanes`（固定行），没写的是随机行。动态波按引擎同一套算式给预算（`StartingPoints + PointIncrementPerWave×(波次-1-StartingWave)`，旗帜波 ×2.5）和按 `Weight` 抽的池子；关卡初始化时引擎已经把动态僵尸并进波次，所以能看到每波**随机追加的确切数量**（`dynamicCount`），只有还没生成时才退化成 500 次模拟的期望（`estimate.p`）。
  - 新增 `pvz_forecast` 工具；`pvz_briefing.forecast` 给完整表；`pvz_state.forecast.next` 给接下来 3 波的薄片（每回合都在，体积很小）。
  - 顺带修了 `AdditionalPlantfood` 没被读出来的问题（以前读的是不存在的 `ExtraPlantFood`）。
- **关卡总结（`pvz_level_memory`）**：`bridge/level-memory.js` 用页面 `localStorage` 按关卡资源名（如 `cowboy13`）归档，每关保留最近 5 局：胜负/打到第几波/耗时/卡组/当时的计划/植物与推车损失/能量豆。事件采样器在胜负、中途重开、退回菜单时自动写入（不依赖哪个客户端在跑），`pvz_briefing.history` 开局就能读到。LLM 也可以用 `note` 写自己的结论。
- **选卡事实补齐**：选卡阶段的 `state.seedSelection.available` 现在带 `family/hp/cd/dps/sunPerSec/paybackSec/kind`，历史消息被裁剪后模型仍能按数值比卡；`briefing.deck` 新增 `poolFacts`（卡池费用区间、DPS 前 6、产阳光前 5、一次性/投手数量）和 `presets`（关卡自带的推荐/挑战卡组）。prompt 明确要求看全卡池和上一局记录，不要只反复用最熟的几张。
- **延迟测量与提前量**：`bridge/latency.js` 用 EMA 记模型往返（游戏内实测）和工具耗时，`state.latency` / `state.brief.leadSec` 给出「下指令到动作生效」的秒数。`lanes[]` 新增 `incomingPerSec`（每秒进到这行的 EHP）、`gap`（减掉本行 dps）、`lossIn`（失守倒计时）、`actBy`（最晚动手时刻，已扣 leadSec）；`brief.pressure` 按 gap 排好前 3 行，`brief.safeLanes` 是不用管的行。
- **更多提前量**：`brief.wave.etaSec` 用「血量提前进波 + 倒计时」两条规则取较小值（`basis=health|timer`）；`cards[].etaSun/etaReady` 按当前产阳光速度和冷却算出可用时间；`state.instantAim` 给一次性卡的可投列区间（已扣延迟和引信）。
- **上游 503 不再打断整局**：`callModel` 识别 429/5xx/网络错误，按 `retry-after` 或 1.5s/4s/9s 退避重试 3 次；仍失败时 runLoop 自动等 15s 再连（最多 3 轮），最后才报 `LLM_UNAVAILABLE` 并提示可从当前局面继续。之前 DeepSeek 返回 `service_unavailable_error` 会直接结束运行。
- **简报瘦身**：`pvz_briefing` 的植物/僵尸列表不再带 `introduction` 长文（`pvz_knowledge` 单查仍返回），六万 token 级的历史上下文能明显缩小。
- **一轮三往返 → 一轮一往返**（实测复盘）：`pvz_state` 现在直接带 `events` 增量，prompt 不再要求每轮先 `pvz_events`；只是等阳光/冷却就把 `wait` 放进同一批 `pvz_act`。
- **上下文再压一半**：窗口 40 → 28 条，只保留最近 1 条完整工具结果（其余压成摘要），并在进入 running 时把开局简报归档成一句话（任务看 `state.tasks`、波次看 `forecast`、卡牌用 `pvz_knowledge`）。
- **鲜花格可视**：`state.protectCells` 读出场景里的 `flowerLine`（`lIndex/cIndex/dead`），「别让僵尸踩坏鲜花」这类任务不用再猜位置。
- 修掉 `pvz_state` 每回合重复播报「计划已更新」（只在 `planSavedAt` 变化时提示）。
- 新增 2 条测试（`pvz_state` 带 events、重开清空上一局事件），共 75 项全通过。
- 新增 4 条测试（静态+动态解析、已生成/未生成两种预测、关卡记忆归档、延迟与 503 重试），共 73 项全通过。

## 0.1.22 — 2026-10-30

**一轮多动作 / 补经济 / 救急提前量**

玩家反馈三件事：一轮只发一个动作、向日葵少了不补、救急植物种在僵尸当前格来不及。前两件是提示词和状态字段的问题，第三件还缺一个"动作落地时僵尸到哪了"的事后校验。

- **同轮多动作**：`pvz_act` 一次可以带 1–6 个动作，批量种植不再逐株 `waitFor` 1.5 秒，全部发起后统一等一次落地（`router.settlePendingPlants`）。prompt 明确「不同卡种到不同格 / 补阳光 / 给豆 / 移车 / 收豆同轮发」，只有同卡连种、同格先铲后种、刚种下给豆需要分轮。
- **补经济**：`plants[].family`、`lanes[].sunProducers` 进入 state；prompt 要求阳光生产者明显不足（例如 <3 株）或某行 0 株时，下一轮优先补向日葵/双子向日葵，`changesSinceLast.plantsLost` 报出哪格空了就补回同一行。
- **救急提前量**：`zombies[].speed` / `etaToHouse` 进入 state；prompt 改成「僵尸进 c4 就准备，目标放它左边 1–2 格，别等 c2、别放它当前格或右侧」。种植结果新增 `timing: { nearestZombieColumn, targetColumn, late }`，`late=true` 时 detail 直接写明「可能在它身后，下一轮往左 1–2 格」。
- 新增 3 条测试（批量种植统一等落地、state 的 family/sunProducers/speed/etaToHouse、timing late 判定），共 65 项全通过。

## 0.1.21 — 2026-10-30

**能量豆终于真的用上了：调错接口 + 状态里看不到 foodable**

玩家反馈"LLM 还是不用能量豆"。查下来有两层原因，都不是模型不懂规则：

- **动作根本没生效**：`plant_food` 调的是 `p.doPlantFood()`，而游戏里的真实接口是 `p.food()`（旧 `pvz-ai-agent` 就是这么写的）。`doPlantFood` 不存在，代码却仍然返回 `ok:true`，也不扣豆 —— 模型以为自己给了豆，画面没反应。
- **状态里没有可喂目标**：`pvz_state.plants` 不带 `foodable`，模型只能猜哪株能吃豆；同格有花盆/睡莲时还会选中花盆。现在每株植物带 `foodable`（已落地且不在释放中才为 true），`plant_food` 只从 `plantInSquare` 里挑真正能吃豆的植物，成功时返回 `foodLeft`。
- 扣豆改用 `counter.plantFoodDec()`（与旧模组一致），不再假装成功；没有 `food()` 接口时明确返回 `FOOD_FAILED`。
- prompt 把能量豆从"可以给"改成可执行条件：plantFood>0 且有 foodable 植物时，行内僵尸≥3 / 到 c4 以内 / 波次紧迫 / 豆满 2 颗，就在本轮 `pvz_act` 里带一个 `plant_food`，不要连续多轮攒着。
- 新增 4 条测试（food() 真被调用且扣豆、同格花盆不误选、空/不可喂/没豆的真实 code、单工具与批量动作都能走通），共 62 项全通过。

## 0.1.20 — 2026-10-30

**导入 ZIP 后直接进游戏，浮窗会提醒用启动器**

单独把 `pvz-llm-agent.zip` 导入 GP-Next 时，模组能装好，但拿不到启动器提供的两样东西：内置模型模式需要的 CSP 绕过，和 MCP 模式需要的 9222 调试端口。以前只有浮窗底部一行小字，玩家很容易忽略，然后在「测试连接」时撞上 `Failed to fetch`。

- 浮窗新增「启动器」状态卡：没检测到启动器时显示为琥珀色，第一次进游戏自动展开用法（完全退出游戏 → 双击 `PvZAI_Launcher.exe` → 保持窗口打开），点「知道了」后折叠。
- 启动器 1.0.1 通过 CDP 注入 `window.__PVZAI_LAUNCHER__` 标记（`addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`）。检测到标记后状态卡变绿并显示启动器版本，不再打扰。旧 Node 版 `启动游戏-AI修复.bat` / `launch_game_csp_bypass.mjs` 也注入同一标记。
- 没检测到时每秒轮询一次（最多 20 秒），覆盖「启动器晚几秒才连上页面」的情况；`ui.report()` 和 `pvz_health` 的 `csp` 里带上启动器信息，方便排查。
- 底部 CSP 行改成直接说结论：`启动器已连接，已绕过` / `未检测到启动器`。
- 顺手修正 `AGENT_VERSION` 长期停在 0.1.10 的问题，现在与 `pack.json` 一致。

## 0.1.19 — 2026-10-30

**铲除不是"升级专用"：种错、腾格、贴脸牺牲后排经济都算正常战术**

上一版把铲除写成了"升级弱卡"，太窄。实际需要铲的场合至少三种：种错位置、格子不够要腾位、僵尸贴到后排时把阳光生产者换成一株输出（之后再补回经济）。

- system prompt 拆成三条：① 铲除是正常战术（种错/腾格/贴脸牺牲经济换输出），腾出的格子下一轮补回；② 升级只是铲除的正当理由之一；③ 同一批里「先 shovel 这一格、再 plant 同一格」是合法连招，贴脸救急别分两轮。
- `pvz_act` 工具描述同步：`replace` = 先铲后种（换强卡/换定位/救急都行），`shovel` = 只铲不种（种错/腾格/牺牲经济）。
- 新增 1 条测试锁定"同批先铲后种同一格"，共 58 项全通过。
- 顺带修掉一个会让模组加载失败的隐患：prompt 是模板字符串，上一版在正文里用了反引号包 `shovel`，直接把字符串截断（`SyntaxError: Unexpected identifier 'shovel'`）。现已去掉。

## 0.1.18 — 2026-10-30

**让"铲掉弱卡换强卡"真的会发生**

能力本来就有（`pvz_act` 的 `shovel` / `replace`，`replace` 是同格先铲后种一步完成），但上一局 51 次调用里 **0 次使用**，日志里只有一条「可用 replace 先铲后种」的提示 —— 提示词从没说过"可以升级"，模型就默认只新建。

- system prompt 增加一条明确规则：阳光富余（>300 且买得起）时，把低级输出/经济 `replace` 成更强同定位卡（向日葵→双胞向日葵、豌豆→双发/西瓜、坚果→高坚果），一步完成，不要因为怕损失就把整局停在低级卡上。
- `replace` 的安全性：如果铲掉旧植物后新卡种不上（格子不可种等），返回 `CELL_BLOCKED` 并带 `emptyAfterRemoval: true`，`reason` 写明「旧植物已铲掉，现在空着」——避免模型以为旧植物还在。
- 新增 2 条测试（replace 正常换植、replace 失败时回报空格），共 57 项全通过。

## 0.1.17 — 2026-10-30

**占用时直接给同行空位（磁力菇那次是被自己/玩家的植物挡住就放弃了）**

回看日志：模型查完图鉴后种 magnetshroom，撞上玩家手动种下的同格植物 → `OCCUPIED` → **再也没换格子，整局没种第二株**。

- `OCCUPIED` / `CELL_BLOCKED` 返回值新增 `alternatives`：同行还能种的空位（最多 3 个，按离目标列的距离排序），`reason` 里直接写「可改种 c3/c5」。
- 提示词补一条：带 `alternatives` 就直接换格子重种，不要原地重试，也不要因为一次被占就放弃这张卡。
- 新增 1 条测试（占用时给同行候选），共 55 项全通过。

## 0.1.16 — 2026-10-30

**首胜之后：修「选了不用 / 不给能量豆 / 贴脸不决策」**

0.1.15（模型改 `deepseek-flash` + 推理 ≤2 句 + state 再瘦身）实测第一次通关：第 13 波结束、23 株在场、剩 3 辆推车。复盘日志发现三处不是策略、而是工具语义的问题：

- **先种再给豆必失败**：同一批动作里「种植 melonpult @2,5；能量豆 @2,5」，植物还没落地，`plant_food` 直接 `NO_PLANT`。现在会等最多 1.2 秒让植物落地再读；仍没有就返回带 `hint` 的 `NO_PLANT`。另外 `p.foodable` 只在显式 `false` 时才拒绝（之前 `undefined` 会被误判成不可给豆）。
- **长冷却把整轮晾住**：日志里「wallnut 冷却 7.9s」让一整轮卡了 12 秒，僵尸就在这期间贴脸。现在只有 ≤3.5 秒的冷却才自动等；更长的立刻返回 `COOLDOWN` 让模型换卡（`cells` 同规则）。
- **卡组和计划不一致没人提醒**：计划写「噬碑藤逐个清」，但选卡时噬碑藤没进卡组（被 puffshroom 占位），模型照样按计划打。`pvz_choose_deck` 现在会在 `actualDeck` 与请求不一致时返回 `warning`，提示以实际卡组为准。
- agent 历史再压一档：完整工具结果 4 → **2** 份（实测单轮输入仍有 14.4k token、一局 73.5 万），压缩后旧结果保留一句状态摘要。
- prompt 补三条：能量豆给已落地植物、选卡 warning 以 actualDeck 为准、一次性/控制卡（樱桃/倭瓜/冰冻生菜）贴到 c2 就该用。
- 新增 1 条测试（长冷却不阻塞），共 54 项全通过。

## 0.1.15 — 2026-10-30

**修 OpenCode Go 模型名 + 再砍一轮单轮耗时**

- **模型名写错了**：OpenCode Go 那组只认 `deepseek-flash` 和 `deepseek-v4-pro`，预设里写的 `deepseek-v4.1-flash` 会让上游直接返回
  `invalid_request_error: the supported API model names are deepseek-flash, deepseek-v4-pro`（浮窗就是「连接失败 LLM_HTTP」）。
  预设改成 `deepseek-flash`，候选只留这两个，hint 里写清合法名字；README / 安装说明同步。
- 精简版 `pvz_state` 再去掉 `zombieStats`（完整数值只在 `pvz_briefing`）；`pvz_events` 的波次 EHP 改用每只僵尸自带的 `ehp/ehpMax`。
  实测 state 10.9 KB → 约 9.4 KB。
- system prompt 加一条「推理最多 2 句、不复述数值、直接给动作」：上一局 31 次调用输出 23,905 token（平均 770/次），生成速度已经是主要耗时，砍输出长度比砍输入更直接。
- 离线测试 53 项全通过。

## 0.1.14 — 2026-10-30

**一批动作里同一张卡不用再手动等冷却**

第二局旁观数据（0.1.13）：单次 state 降到 8.75 KB，60 秒做了 14 条决策（约 4.3 秒一条），但还是第 9 波丢光推车。原因从"每回合太慢"变成"每回合能落地的植物太少"：模型一轮里常把同一张卡种两次，第二次直接吃 `COOLDOWN`，等于白扔一个动作。

- `pvz_act`：动作返回 `COOLDOWN` 时工具自己等这张卡的 `retryAfter` 再重试（单次最多 6 秒、重试 2 次，整批最多再花 20 秒）。同一批里放 6 个动作、其中有同卡重复，现在都能真正落地。
- 工具描述写清这条行为，`cells` 与普通动作共用同一套冷却等待。
- 新增 1 条离线测试（同卡重复 + 冷却重试），共 53 项全通过。

实测参考：一局下来 31 次工具调用、输入 464,748 / 输出 23,905 token。回合制下这已是成本下限，真要跟上关卡节奏，仍需"每回合多落地几株"或更快的模型。

## 0.1.13 — 2026-10-30

**砍 prompt 体积：单轮决策从 20–30 秒降下来**

旁观模组自己打（F8）实测：45 秒里决策日志只增加 8 条，有 26 秒完全没动静；同时阳光堆到 1275、植物只有 7 株、推车全丢。定位到瓶颈不是工具层，而是**每轮 prompt 太大**：

- `pvz_state.cards[]` 每回合重复带每张卡的完整数值（实测 4.0 KB / 次）；`levelScript` 每回合重发完整波次表（2.9 KB）；`zombieStats`、`board` 也逐轮重复。单次 state 16.6 KB。
- 内嵌 agent 保留最近 8 份完整工具结果 → 单轮 prompt ≈ 8 × 15 KB ≈ 30k+ token，DeepSeek 光读就要十几秒。

改动：

- `pvz_state` 改精简版：`cards[]` 去掉 `stats`（完整数值只在 `pvz_briefing.cards`），`levelScript` 只留 `waveCount / flagInterval / isAtNight`；`pvz_briefing` 通过 `snapshot({full:true})` 拿完整波次表。实测单次 state 16.6 KB → 约 9.7 KB。
- agent 历史压缩：最近完整工具结果 8 → 4 份，压缩阈值 1500 → 800 字符；旧结果不再只写「已省略」，而是留一句状态摘要（phase / 阳光 / 波次 / 植物 / 僵尸）或失败 code，历史仍可读。
- `MAX` 消息数 60 → 40。
- system prompt 增加一条：每轮尽量把动作做完（≤6 个，铺同卡用 `cells`），不要每轮只种一株。
- 预期单轮 prompt 从 ~120 KB 降到 ~40 KB；离线 52 项测试仍全通过。

## 0.1.12 — 2026-10-30

**按实战暴露的问题重做事实层（远程驱动打了一整局后修的 7 条）**

- `cards[]` 拆开语义：新增 `cdReady`（冷却好了）/ `sunShort`（还差多少阳光）；`affordable` 保持；`ready` 仍表示两者都满足。之前 `ready=false` 时模型分不清是冷却没好还是没钱（实测西瓜 cd=0 但 ready=false，因为阳光只有 250）。
- 僵尸补护甲：新增 `armorHp`（当前护甲，读不到为 null）/ `armorMax` / `ehp = hp + armorHp` / `ehpMax = hp + armorMax`；`lanes[]` 新增 `ehp`（本行在场上僵尸剩余 EHP 合计）与 `ehpExact`。之前 state 只有本体血量，铁桶农夫看起来只有 190 血。
- `OCCUPIED` 的 `reason` 现在写清「哪格被什么占住，可用 replace」；仍带 `plants` 数组和 `hint`。
- `state.seedSelection.available` 去掉每张卡的完整 `stats`（选卡阶段单次 state 从数万字符降到原来的几分之一），完整数值只在 `pvz_briefing.cards`；新增 `availableCount`。
- 新增 `pvz_restart`：走 `PauseScreen.restart` 重开本关，回到选卡阶段；失败返回 `RESTART_UNSUPPORTED` / `RESTART_FAILED` / `RESTART_TIMEOUT`。
- `pvz_act` 的 `plant` / `replace` 支持 `cells`：同一张卡一次种到多格（≤8），工具按真实冷却自动等 `retryAfter` 重试，遇 `SUN` / `OCCUPIED` / `CARD_NOT_IN_DECK` 就停手，整批最多阻塞 25 秒。
- `pvz_briefing.deck` 新增 `coverage`（economy / shooter / lobber / wall / instant / control / support 的**张数**），只数结构，不给建议。
- system prompt 增加三条硬规则：卡槽看 `cdReady/affordable/sunShort`；僵尸看 `ehp/ehpMax`；铺同卡用 `cells`、重开用 `pvz_restart`。
- 新增 8 条离线测试（卡片三态、护甲 EHP、seedSelection 瘦身、cells 冷却重试/停手、restart），共 52 项全通过。

## 0.1.11 — 2026-10-30

**修掉「本关最多 18 株」这类幽灵上限**

- 根因：引擎在 `inGameScene` 上常驻一个**未激活**的 `LevelObjectiveScreen` 模板，`screenName` 是占位符 `<LEVEL OBJECTIVE NAME>`，`mission0` 是默认英文文案 `Never have more than 18 plants`。0.1.8 只是不再拿它算 `plantLimit`，但 `objective.missions` 原样进了 `pvz_state` / `pvz_briefing`，模型读到就把「全程自控植物数≤17，绝不碰到18上限」写进本关计划。
- `readObjective` 现在扫场景里所有 `LevelObjectiveScreen`，优先取「正在显示 + 已本地化」的那个；不信任的模板**连 `missions` 都返回空数组**，模型没有可误读的文本。
- `plantLimit` 改为结构化优先：先看 `LevelTaskCount.plantCountLimit`，再看已本地化任务文案；新增 `limits.plantLimitSource`（`task` / `objective` / `null`）。
- `pvz_briefing.notes` 明确写「`plantLimit` 为 null 就是本关没有上限，不要从任务原文、图鉴或以往关卡推断」；模板关卡再多一句「tasks 为空就按普通关卡打」。
- 游戏内 system prompt 增加硬规则：关卡规则只看 `plantLimit` / `limits`，不要自己加「最多 18 株」之类的限制。
- 新增 3 条回归测试：模板 missions 不进 state/briefing、同场景模板不抢真实任务、结构化任务字段优先于文案；45 项离线测试全通过。

## 0.1.10 — 2026-10-30

- 修复 OpenCode Go 无法使用：`opencode.ai` 的 `chat/completions` 不返回任何 CORS 头（只有 `/models` 是 `ACAO:*`），WebView2 里带 `Authorization` 会先发预检、预检 404，最终报 `Failed to fetch`。这是浏览器跨域限制，改配置解决不了。
- 新增 `scripts/local-proxy.mjs`：本机 8787 端口转发到 OpenCode Go，补 CORS 头并透传流式响应；API Key 只从请求头透传，不落盘。
- `PvZAI_Launcher.exe` 内置同一套代理：启动游戏时自动监听 `127.0.0.1:8787`，玩家不用再单独开脚本（端口被占会提示并跳过，不影响 DeepSeek）。
- 「服务商」里的 OpenCode Go 改为指向 `http://127.0.0.1:8787/v1`，并在提示里写明必须先启动代理。
- `x-opencode-session` 对直连和本地代理两种地址都会带上。
- 实测：页面内经代理请求可达（假 key 返回上游 401，链路正常），直连仍 `Failed to fetch`。
- 新增发布包构建：`python tools/build_bundle.py` 一条命令产出 `dist/PvZAI-LLM-Agent-Bundle-v<版本>.zip`，里面同时有模组 ZIP、`PvZAI_Launcher.exe`、MCP Server（`mcp/` + `tools/`）、`配置MCP.bat` 和中文安装说明。
- `tools/install_mcp_config.mjs` 支持发布包布局：`mcp/server.mjs` 存在时自动用它，并把客户端配置项命名为 `pvz-llm-agent`（源码仓里仍按 `PvZ-MCP/pvz-mcp-server.mjs` / `pvz-gardendless` 工作）。

## 0.1.9 — 2026-10-30

- 浮窗新增「服务商」下拉：DeepSeek 官方 / OpenCode Go / 自定义。切换时自动填 API Base 和模型，模型名仍可手改，并提供常用模型候选（datalist）。
- 接入 OpenCode Go：`https://opencode.ai/inference/go/openai/v1` + `deepseek-v4.1-flash`（OpenAI 兼容 chat/completions）。
- OpenCode Go 请求自动带 `x-opencode-session`（按官方要求用于路由与 prompt 缓存），其他服务商不带。
- 旧配置没有 provider 字段时按 baseUrl 自动推断，升级后不会显示错的服务商。
- `live-play.mjs`：agent 自己停止（LLM 报错/额度不足/手动停）时立即结束采样，不再对着空转界面等超时。
- 新增测试：预设结构、OpenCode Go 端点拼接、会话头只在 Go 出现（43 项通过）。

## 0.1.8 — 2026-10-30

- 修复 18 株上限误判：`LevelObjectiveScreen` 未初始化时 `screenName` 是占位符 `<LEVEL OBJECTIVE NAME>`、`mission0` 是引擎默认英文文案 `Never have more than 18 plants`。之前无条件采信，把它当成了本关真实任务。现在 `readObjective` 输出 `trusted` 字段，只有 `screenName` 已本地化时才采信 `objective.missions`；模板文案不再进入 `missionHints` / `plantLimit`。
- `missionHints` 对 objective 与 task 的重复文案去重。
- 关卡结束自动停止：`notePhase` 记录是否真正进入过 `running`，一旦胜负或回到主菜单/世界地图就置 `stopRequested`，不再依赖「最后调用的工具恰好返回 phase」。`live-play.mjs` 同步：打过 running 后 phase 离开 running 即停止采样，不空转结算界面。
- 新增 `scripts/bypass-csp.mjs`：不依赖启动器也能解除 WebView2 CSP（等价于启动器的 `Page.setBypassCSP` + reload）。
- 新增 `scripts/csp-check.mjs`：开跑前探测 CSP 是否放行，避免盲目 reload 丢掉进度。退出码 0=放行，1=被拦。
- `live-play.mjs` 新增 `--bypass-csp`：先解 CSP 再观察，省掉手动两步。
- 新增测试：占位符 objective 不被采信、本地化 objective 仍能解析上限（41 项通过）。

## 0.1.7 — 2026-10-30

- `pvz_state` 新增 `changesSinceLast`：由工具直接算出「自上次读取 pvz_state 以来的变化」——`plantsLost`（哪格哪株消失）、`plantsAdded`、`mowerLost`、`waveDelta`、`sunDelta`、`zombieDelta`、`plantsLeft`；无变化时 `none=true`。跨 phase 不报 diff，避免上一局数据串进来。
- 修复「植物被吃后不补种」的根因：历史工具结果会被 `compactOldToolResults` 压掉，模型无法自己 diff；现在变化由工具保管，不依赖模型记忆。
- 每轮提示词 `continueMessage` 从「必要时 pvz_events」改为「先取增量再读状态」，与 system prompt 的标准循环对齐；system prompt 明确要求看 `changesSinceLast`。
- 决策日志删除左侧时间列，只保留状态图标 + 正文，让动作和错误从左边缘直接开始。
- 新增测试：`router: pvz_state.changesSinceLast 报出植物新增与损失`（39 项通过）。

## 0.1.6 — 2026-10-30

- 决策日志删除左侧时间列，只保留状态图标 + 正文，让动作和错误从左边缘直接开始。

## 0.1.5 — 2026-10-29

- 主面板收起后变成 50px 圆形悬浮图标（状态点 + AI），点击展开、拖动移动；不再保留 206px 宽的长条。
- 决策日志强制左对齐，避免被游戏页面全局居中样式影响。
- 思考窗正文可滚动，决策日志保留最小高度 120px；计划/推理展开或窗口较矮时仍能滚动到日志。

## 0.1.4 — 2026-10-29

- 思考窗正文恢复可滚动：`.t-body` 允许滚动，决策日志保留最小高度 120px；窗口较矮或计划/推理展开时，仍可滚动到决策日志。

## 0.1.3 — 2026-10-29

- 决策日志强制左对齐：根容器、条目和正文都显式设置 `text-align:left`，并给每条正文加内联样式，避免被游戏页面全局居中样式影响。

## 0.1.2 — 2026-10-29

- 模型默认 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`。
- 浮窗与思考窗支持拖动、右下角缩放、双击标题栏复位，位置/大小写入 localStorage。
- 思考窗 UI 重构：PvZ 深绿工具面板 + 暖阳光强调色；清屏/隐藏改为深色图标按钮；计划可折叠；状态胶囊；推理区可折叠；决策日志按时间/图标/结果分色，去掉了白底默认按钮和拥挤排版。
- 思考窗去重：推理原文只在上方滚动框显示；下方“决策日志”只记录动作、真实结果、计划，模型说明只有中文才进日志。
- 种植落地改为 `pending:true`（⏳）而不是红色 `PLANT_NOT_SETTLED`；换植前等待旧植物真正移除；切卡后等待种子栏同步。
- CSP 自检：界面显示是否检测到 meta CSP；`Failed to fetch` 时提示用启动器或 MCP。模组本身不能可靠解除 WebView2 CSP。
- 新增 `scripts/live-play.mjs`：观察一整局（支持 `--start` 点浮窗开始），不替 LLM 决策。
- 战斗中 `pvz_state` 不再重复携带 30KB 完整可选卡池；旧的工具结果自动压缩，降低 token 消耗。
- 计划面板支持 `deck/layout/contingency` 的对象格式。
- 离线测试：38 项通过。

## 0.1.0 — 2026-10-29

首个符合新需求基线的实现。

- 新建 `pvz-llm-agent/`：bridge / tools / mcp / in-game / knowledge / tests。
- LLM 是唯一决策者；删除本地卡组、自动补卡、策略队列、本地接管。
- 15 个工具契约：briefing / knowledge / state / events / set_plan / choose_deck / start_level / act / wait_until / collect / plant_food / move_cart / resume / dismiss_objective / health。
- 修复选卡：逐张加卡并轮询 `cards.CFs.length`，最终校验 `actualDeck`；不足返回 `DECK_NOT_FULL`，不自动补。
- `pvz_briefing` 输出任务、世界、地形、波次/总 EHP、僵尸数值、全部卡池、槽位、植物上限、起始阳光；不含推荐卡组。
- `pvz_events` 增量事件（波次/丢车/植物损失/行威胁/任务/胜负）。
- 游戏内浮窗 + 思考窗；MCP stdio server（CDP）。
