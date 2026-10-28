# PvZ2 Gardendless · AI 草坪指挥官

让大模型或外部 Agent 读取《植物大战僵尸2 花园无尽》的战场，自己决定种什么、种哪一格，并自动打完一关。

项目包含三种东西：

1. **GP-Next 模组**：读取植物/僵尸/关卡/阳光/卡槽，执行原生种植、收阳光、能量豆、铲除。
2. **内置 DeepSeek 模式**：游戏内浮窗填 Key，直接由模型决策。
3. **MCP Server**：Claude Desktop / Cursor / Cline / OpenCode 通过工具调用操控游戏，无需在游戏里填 Key。

> 非官方社区项目，与 EA / PopCap / PvZ2 Gardendless 作者无关。仅用于单机体验，请勿用于联机或排行榜。

![thumbnail](pvz-ai-agent-mod/thumbnail.png)

## 下载

从 [Releases](https://github.com/MuliyStudio/pvz2-ai-gardendless/releases/latest) 下载：

- `PvZAI-AI-Agent-Bundle.zip`：模组 + 启动器 + MCP Server + 安装说明（推荐）
- `pvz-ai-agent.zip`：只有 GP-Next 模组，适合已经会装模组的人

## 快速开始（内置 DeepSeek 模式）

1. 完全退出游戏。
2. 解压发布包，双击 `PvZAI_Launcher.exe`。
   - 自动把模组装进 GP-Next 的 `packs` 目录；
   - 带调试端口启动游戏；
   - 解除当前游戏页面的 CSP（内置 DeepSeek 需要）。
3. 等黑窗口出现 `✅ CSP 已绕过`，保持窗口打开（可最小化）。
4. 游戏里按 **F9** → **实验室 → JS Modding** 打开；**模组 → 保存并重载**，勾选 **AI 草坪指挥官**，应用/重启。
5. 进关卡，右上角浮窗填：
   - Base URL：`https://api.deepseek.com/v1`
   - 模型：`deepseek-flash`
   - API Key
   - 测试连接 → 开始操控（或按 **F8**；左下角思考浮窗 **F10** 开关）

没有 Key 可以先勾选 **本地策略（不调用模型）** 测试自动收阳光/种植。

> 不要直接双击游戏 EXE 使用内置 AI，否则 CSP 会拦截模型请求；请用启动器。

## MCP 模式（推荐给 Claude / Cursor / Cline / OpenCode）

MCP Server 通过本地 CDP 和游戏通信，**不需要解除 CSP，也不需要 API Key**。

1. 用 `PvZAI_Launcher.exe` 启动游戏（开 9222 调试端口并加载模组）。
2. 双击 `配置MCP.bat`。它会自动把 MCP Server 合并进已安装客户端的配置（先备份，不覆盖其它 MCP Server）。
3. 重启 MCP 客户端。
4. 让 Agent 先调用 `pvz_rules`，然后循环：

```text
pvz_briefing → 写计划（pvz_set_plan）→ pvz_choose_deck → pvz_start_level
pvz_state → 决策 → pvz_plant / pvz_act{type:"replace"} / pvz_shovel → pvz_state
```

工具：

| 工具 | 作用 |
| --- | --- |
| `pvz_briefing` | 开局一页简报：任务/目标原文 + 预计僵尸（图鉴/标签/应对）+ 地形/机制 + 可选卡组（图鉴）+ 推荐卡组 |
| `pvz_set_plan` | 记录本关作战计划（goal/threats/counters/deck/buildOrder/shovelPolicy），之后 `state.plan` 一直带着 |
| `pvz_state` | 地形（terrain.map / blockedCells）、阳光/能量豆、卡槽费用冷却、植物、僵尸、波次、**关卡任务与倒计时** + 图鉴 + 可铲候选 |
| `pvz_knowledge` | 查询任意植物/僵尸的图鉴机制 |
| `pvz_plant` | 种卡（原生扣阳光、冷却、每行上限；失败带 code） |
| `pvz_act` | 一次执行最多 6 个动作（支持 `replace` 先铲后种），返回每步结构化结果 |
| `pvz_wait_until` | 等到 `sun>=200` / `card_ready:xxx` / `zombie_in_lane:3` / `tasks_ready` 等条件 |
| `pvz_collect` | 立即收取掉落物 |
| `pvz_plant_food` | 使用能量豆 |
| `pvz_shovel` | 铲除植物（腾位/清重复/清位置错误；不返还阳光） |
| `pvz_move_cart` | 移动西部矿车（可移动植物平台），植物跟着换行 |
| `pvz_resume` | 游戏暂停时继续 |
| `pvz_health` | 检查模组/Server 版本、关键能力、缺失工具 |
| `pvz_choose_deck` | 选卡；`replace:true` 可换掉游戏预填卡组，不足卡槽会自动补满 |
| `pvz_start_level` | 开始战斗（自动关闭关卡目标说明） |
| `pvz_dismiss_objective` | 关闭开局的关卡目标说明，返回本关任务 |
| `pvz_wait` | 等待 |
| `pvz_rules` | 规则与策略 |

### 关卡任务与 v0.2.5

每关都有任务，例如 `在 30 秒内击杀 20 个僵尸`。`pvz_state` 的 `state.tasks` 会给出：

```json
{ "tip": "在 30 秒内击杀 20 个僵尸", "count": "20/20", "value": 20, "total": 20,
  "modeName": "timed_kill", "timeSemantics": "sliding_window",
  "timeLeft": 4.4, "windowActive": true, "urgent": true,
  "hint": "滑动窗口还剩 4.4 秒，当前 16/20，需再杀 4 个",
  "completed": false, "failed": false }
```

`timed_kill` 是“最近 N 秒内击杀”的滑动窗口，不是整关倒计时；`urgent` 时优先能量豆/一次性植物。

v0.2.5 实测（海盗港湾 17）：任务在 wave 12 以 **20/20** 完成，当时 `timeLeft=4.4s`、
`urgent=true`，用三线射手能量豆完成收尾；整局 MCP 调用 **55 次**（含 state / act / wait_until），
最终 `phase=won`、进度 100%。地形矩阵实测：

```text
LLLLLWWWW
LLLLLWWWW
LLLLLWWWW
LLLLLPPPP
LLLLLPPPP
```

### v0.2.6 · 矿车 / 全任务语义 / 逐行火力

- **矿车**：`snapshot().carts[]` 给出编号、当前行/列、可移动方向、车上植物；`pvz_move_cart {cart,direction}` 把车移到上下行，植物跟着走。地形用 `R` 标轨道，`blockedCells` 里 `reason:"rail"` 表示车不在该格。
- **全任务语义**：7 种 mode 都有 `semantics / left / hint / urgent`。例如「失去不超过 2 株植物」会给出 `left=2`、`hint="还可损失 2 株…再丢就失败"`，不再把进度条误报成 100%。
- **逐行火力**：`snapshot().lanes[]` 直接给出每排 `shooters / nearestZombie / needsShooter / danger / mower / cart`；`needsShooter=true` 就是“这排有僵尸但没射手”。
- **暂停**：`state.paused` / `state.ui`，动作返回 `code:"PAUSED"`；`pvz_resume` 继续。
- **僵尸机制标签**：`zombies[].tags`（`crush / jump_over / backline / flying / spawner / armored / support / lane_switch`）。奏琴僵尸会碾压植物并让牛仔换行；炸矿僵尸跳到最左侧；牧鸡僵尸放鸡；机械牛投小鬼。
- **损失追踪**：`recentLosses[]` 记录刚刚消失的植物（排除自己铲除和矿车移动）。
- **健康检查**：`pvz_health` 返回模组/Server 版本、`compatible`、`missingTools`、关键能力。

### v0.2.7 · 通用机制探测（其他地图）

- **`snapshot().mechanics`**：进关时扫描场景组件，不按地图硬编码。
  - `features`：`water / tide / rail / tomb / gold / endangered / slider / mold / dinosaur / portal / hazard / conveyor / vase / sky`
  - `tide`：潮水线 `pos`、`moving`、水覆盖列数
  - `dinosaurs[]`：`kind / lane / column / action`
  - `portals[]`、`hazards[]`（气功洞、巫师羊）
  - `tiles[]`：rail / tomb / mold / ice / vase / gold / endangered / slider
  - `unmappedTiles[]`：发现但还不认识的地块类名
- **不支持关卡**：砸罐 / 天空 / 保龄球会标 `supported:false`，种植返回 `UNSUPPORTED_LEVEL`。
- **实测**：
  - 巨浪沙滩 15：`water + tide`，`tide.pos=3`，濒危植物 5 个
  - 黑暗时代 2：7 个墓碑
  - 遗落古城 15：金瓷砖 + 濒危植物
  - 侏罗纪 10：`stego/ptero/raptor` 三条恐龙

### v0.2.8 · 传送带关卡

- `snapshot().conveyor`：`cards[]`（当前带上的卡）、`plantList[]`、`slots[]`、`vertical`
- `pvz_plant` 的 `card` 在传送带关卡里表示 `conveyor.cards` 的下标；不扣阳光、不吃种子冷却
- 传送带开局：`pvz_choose_deck` 返回「无需选卡」，`pvz_start_level` 直接开战
- `pvz_wait_until` 新增 `conveyor_ready`；`card_ready` 同时识别种子卡和传送带卡
- 实测：遥远未来 8，传送带出现 citron/wallnut/laser_bean，`pvz_plant card=0` 成功种下 citron

### v0.2.9 · 铲除重种 + 开局对策

- **replace 动作**：`pvz_act {type:"replace",card,lane,column}` / 模组 `replacePlant()` 一步“铲掉→种上”，先预检卡是否可用，避免铲了没钱种。
- **可铲候选**：`snapshot().shovelCandidates[]` 给出 `reason`（over_limit / upgrade / misplaced / low_hp）、`hpPercent`、`better / betterCard`，让 Agent 知道“哪株该换、换成什么”。
- **铲除保护**：`loss_limit` 任务 `left<=1` 时拒绝主动铲（`SHOVEL_BLOCKED`）；`expect` 参数防止铲错株（`PLANT_MISMATCH`）；铲完清掉损失追踪与 15 秒不可种缓存。
- **开局计划**：进入关卡目标/选卡阶段（或中途接管第一回合）先读任务、地形机制、预计僵尸（从关卡数据扒 RTID + 图鉴）、可选卡组，产出 `plan`（goal / threats / counters / deck / buildOrder / shovelPolicy / dangerLanes）；选卡按计划 `deck` 自动选，战斗每回合带着计划打。
- **预计僵尸**：`snapshot().levelPreview = { zombies[], plants[] }`，来自关卡配置里的 RTID，配合 `zombieKnowledge` 使用。
- **任务要点**：`objective.hints` / `snapshot().missionHints` 把目标原文解析成可执行要点（不能损失、倒计时、击杀数、植物上限、阳光目标、防守）。
- **图鉴理解加强**：卡牌行加“定位”（阳光/坚果/输出/一次性/地雷…），僵尸标签给出 `ZOMBIE_COUNTER_TIPS` 一句话对策；plantRole 新增 aoe / mine / support。
- **MCP**：新增 `pvz_briefing`（开局一页简报）与 `pvz_set_plan`（记录计划），`pvz_choose_deck` 不足卡槽自动补满。

### v0.3.0 · 思考浮窗 / 自动换卡 / 提速

- **思考浮窗**：游戏里多一张左下角悬浮卡片（F10 开关），实时显示 AI 当前阶段与耗时、`thought`、动作执行结果、作战计划和最近回合思考；可拖动、不影响主浮窗收起。
- **流式输出**：决策请求改成 SSE 流式（可用勾选项关闭），模型边生成边显示，服务端不支持时自动退回普通请求。
- **铲除真正会触发**：放宽候选条件——输出位已满（4 射手或 c1-c4 无空位）、坚果/向日葵升级、位置明显错误、残血；僵尸贴脸的格子不再建议换。新增“自动铲换弱卡”兜底（6 秒最多 1 格，保留阳光余量）。
- **卡组保底**：作战计划卡组至少补 1 个阳光生产者 + 2 个输出，并按卡槽上限截断，避免选出一套打不动的卡。
- **提速**：决策间隔 2200ms → 1600ms；动作成功后 0.9s 重新决策；场景组件/预计僵尸/地形/机制/地块短缓存，状态浮窗刷新不再重复全量扫描。

### v0.3.1 · 位置信息直接进思考

- **位置图**：每回合提示词里画出 5×9 文字棋盘（`c0…c8` + 每格植物 + 每行僵尸位置/血量），模型不用再从数组里自己拼空间关系。
- **空位建议**：模组直接算好“哪行缺输出/坚果、哪些 `c` 是空的”，并在提示词里给出 `输出 c1/c2/c3` 这种可直接使用的落点。
- **失败带落点**：`POSITION` / `OCCUPIED` / `TERRAIN` / `CELL_BLOCKED` / `LANE_LIMIT` 失败都会带 `alts`（可改种格子），下一回合模型直接照着改。
- **拦截明显浪费**：阳光生产者 c≥5、坚果 c≤1、地刺 c≤1、普通射手 c≥7 会被拒绝（窗口有空位时），避免“种了等于白送”。
- **`snapshot().board`**：结构化 5×9 棋盘（`cells[column]` + 每行僵尸），MCP 侧同样受益。

### v0.3.2 · 策略可编辑 / 玩家指示 / 开局侦察

- **策略提示词可编辑**：主浮窗新增“策略提示词”编辑框，系统提示拆成“固定规则 + 决策原则”，改完下一回合生效，可一键恢复默认。
- **思考窗输入框**：给 AI 发一句提示（如“地刺放最前面”“这关别种坚果”），会进入后续每回合提示词，优先级高于默认策略，可随时清除。
- **地刺落点修正**：地刺必须在 c4-c7 且在坚果前面，否则 `POSITION` 拒绝并给前排 `alts`；`misplaced` 候选同步修正。
- **开局侦察更完整**：计划推迟到选卡阶段、拿到可用卡列表后再制定；同时注入任务、世界机制、预计僵尸（关卡数据优先，读不到用世界常识兜底），卡组保底 1 阳光 + 2 输出。

### v0.3.4 · 策略文件化

- 默认策略从脚本里搬到模组包根目录的 **`strategy.md`**，用 `ctx.files.own().readText()` 读取；`#` 行是注释。
- 直接编辑 `strategy.md` → 浮窗点“重新读取文件”生效；游戏内浮窗保存的策略会覆盖它，点“恢复默认”读回文件。
- ZIP 打包与安装目录都已包含 `strategy.md`；旧版 GP-Next 没有 `ctx.files` 时自动回退到脚本内置默认。

### v0.3.5 · 本关临时策略

- 浮窗里的输入框改成 **本关临时策略**：只保存在内存，换关自动清空，不写 `strategy.md`、不存 localStorage。
- 发送后与实时关卡状态一起进入下一次模型请求，并**立即触发一次决策**，不用等决策间隔。
- 主浮窗的“策略提示词”编辑框移除，改为显示 `strategy.md` 加载状态 + “重新读取”按钮；默认策略只在文件里改。


详见 [PvZ-MCP/README.md](PvZ-MCP/README.md)。

## 它怎么理解植物/僵尸

不写死技能表，直接读游戏内 almanac：

- `ctx.plants.getFeature(id)`：名称、TAGS、资源
- `ctx.plants.getAlmanac(id)`：短介绍、详细说明、Special、SUNCOST/RECHARGE/DAMAGE/RANGE 等
- `ctx.zombies.getAlmanac(id)`：短介绍、Special、TOUGHNESS/SPEED 等
- `snapshot()`：场上实际血量、位置、卡槽冷却

当前卡牌和场上僵尸的图鉴会自动进入内置 prompt；MCP 的 `pvz_state` / `pvz_knowledge` / `pvz_briefing` 也返回同样数据。
每类僵尸还会根据 codename 打上机制标签（crush / flying / armored / spawner / rolling…），并配一句应对要点，方便模型在没有完整图鉴时也能选对克制卡。

## 避免乱种

提示词和代码双层约束：

- 同一行最多 1 个坚果墙（血量低于 25% 才允许补新的）
- 同一行最多 1 个弹簧豆 / 1 个冰冻生菜
- 同一行最多 2 个阳光生产者 / 4 个射手 / 2 个地刺
- 目标格已有植物时拒绝
- 失败原因会进入下一回合的“上一回合结果”，模型会看到并调整

种错/太弱/重复也不会卡死：`shovelCandidates` 会给出可铲候选；只腾位用 `shovel`，同格换强卡用 `replace`（先铲后种，一步完成）。铲除不返还阳光，`loss_limit` 只剩 1 株时会被代码拒绝。

## 目录结构

```text
pvz-ai-agent-mod/       GP-Next 模组源码（pack.json / strategy.md / scripts/main.js）
PvZ-MCP/                MCP Server（无第三方依赖）
tools/                  打包、启动器、MCP 配置安装脚本
配置MCP.bat             一键写 MCP 配置
启动游戏-AI修复.bat      Node 版启动器（源码用户）
```

## 自行构建

### 模组 ZIP

```bash
python tools/build_zip.py
# 生成 pvz-ai-agent.zip（pack.json 在 ZIP 根目录）
```

### 发布包

```bash
python tools/pack_distribution.py
# 生成 PvZAI-AI草坪指挥官-发布包.zip
```

### 独立启动器（C# / .NET Framework 4.8）

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:exe /platform:anycpu /optimize+ /codepage:65001 `
  /out:"PvZAI-发布包\PvZAI_Launcher.exe" `
  /r:System.dll /r:System.Core.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll tools\PvZAI_Launcher.cs
```

## 已知限制

- 支持 PvZ2 Gardendless **0.16.x** + GP-Next **1.5.x**；内部字段随游戏更新可能变化。
- 标准种子卡槽关卡支持最好；传送带、保龄球、砸罐子、天空关、特殊小游戏可能无法种植。
- 图鉴是静态机制说明，不是完整物理模拟器。
- 内置模式需要 CSP 绕过启动器；MCP 模式不需要。
- 内置模式和 MCP 模式不要同时控制（会抢操作）；自动收阳光/能量豆共享。

## License

MIT。游戏本体、素材和 PvZ2 Gardendless 版权归其作者/权利方所有；本仓库不包含游戏资源。
