# PvZ2 Gardendless · MCP Server

> 配置示例里的 `F:\植物大战僵尸` 是作者本机路径；换成你的解压目录即可。

把游戏变成一组 MCP 工具，让 **Claude Desktop / Cursor / Cline / 任意 MCP Agent** 直接读取战场、种植、收阳光、用能量豆。

```text
MCP 客户端 (Claude/Cursor/Cline)
        │  stdio (JSON-RPC)
        ▼
pvz-mcp-server.mjs
        │  本地 CDP (127.0.0.1:9222)
        ▼
游戏页面 window.PvzAI  ←  GP-Next 模组
        │
        ▼
《植物大战僵尸2 花园无尽》
```

## 为什么用 MCP

- **不再让游戏里的模型“猜”**：Agent 通过 `pvz_knowledge` 查询游戏内真实图鉴（冰冻生菜、弹簧豆、海盗僵尸等）。
- **不再解析模型返回的 JSON**：工具调用是结构化协议，不会出现“输出不是合法 JSON”。
- **不用在游戏里填 API Key**：MCP Server 在本机通过 CDP 和游戏通信；模型由你的 Agent 客户端提供。
- **任意 Agent**：Claude、Cursor、Cline、支持 MCP 的本地模型都可以。
- **游戏侧只做适配器**：读状态、执行动作；策略由 Agent 负责。

## 前置

1. Windows 10/11。
2. Node.js 18+（MCP 客户端需要用它启动 server）。
3. 游戏 + GP-Next 模组已安装。
4. 用 `PvZAI_Launcher.exe` 启动游戏（它会开 9222 调试端口并加载模组）。

> MCP 模式不需要解除 CSP：MCP Server 走 CDP，不经过页面网络。启动器解除 CSP 只是给“游戏内 AI 模式”用的，留着也无害。

## 配置 MCP 客户端

### Claude Desktop

编辑：

```text
%APPDATA%\Claude\claude_desktop_config.json
```

加入：

```json
{
  "mcpServers": {
    "pvz-gardendless": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["F:\\植物大战僵尸\\PvZ-MCP\\pvz-mcp-server.mjs"]
    }
  }
}
```

如果 `node` 已在 PATH，`command` 可以直接写 `"node"`。改完完全退出并重启 Claude Desktop。

### Cursor

在项目或全局 MCP 配置里加入同样的 `mcpServers` 条目（`command` + `args`）。重启 Cursor。

### Cline / 其他 MCP 客户端

添加一个 **stdio** MCP Server：

```text
command: C:\Program Files\nodejs\node.exe
args:    F:\植物大战僵尸\PvZ-MCP\pvz-mcp-server.mjs
```

## 开始玩

1. 双击 `PvZAI_Launcher.exe` 启动游戏，等 `✅ CSP 已绕过`（MCP 模式其实不需要，但启动器会顺带装模组/开端口）。
2. 进游戏，确认 GP-Next 里“AI 草坪指挥官”已启用（浮窗出现即可）。
3. 在 Agent 客户端里让它使用 `pvz_play` prompt，或直接说：

```text
你现在操控 PvZ2。先调用 pvz_rules，然后每回合：
pvz_state → 决策 → pvz_act（1–6 个动作）→ 需要时 pvz_wait_until。
阳光/能量豆会自动收。不要猜植物/僵尸技能，需要时调用 pvz_knowledge 查询。
先看 state.tasks（关卡任务）和 timeLeft/urgent；任务失败会直接判负。
phase=objective 先 pvz_dismiss_objective；phase=preparing 先 pvz_choose_deck（可 replace:true）再 pvz_start_level。
```

4. 进入关卡（选卡页也行）。Agent 会自己读状态、选卡、开局、种植。

> 每关开局会有“关卡目标”说明界面（例如“在 30 秒内击杀 20 个僵尸”）。此时 `pvz_state` 返回 `phase: "objective"` 和 `objective.missions`，调用 `pvz_dismiss_objective` 关掉即可；`pvz_start_level` 也会自动处理。

## v0.2.5 新增

- **地形**：`state.terrain.map`（每行字符串：`L` 陆地 / `P` 木板 / `W` 水 / `S` 天空 / `?` 未知）与 `state.blockedCells`。水格不会再被盲目试种。
- **结构化错误**：`pvz_plant` / `pvz_shovel` / `pvz_plant_food` 失败返回 `code`（`TERRAIN` / `COOLDOWN` / `SUN` / `OCCUPIED` / `LEVEL_LIMIT` / `ENDANGERED_PLANT` …）。`COOLDOWN` 带 `retryAfter`。位置和每行数量不再是硬限制（由 AI 自行判断）。
- **任务计时**：`tasks[].modeName`、`timeSemantics`、`windowActive`、`timeLeft`、`urgent`、`hint`。`timed_kill` 是“最近 N 秒内击杀”的滑动窗口。
- **批量动作**：`pvz_act` 一次执行最多 6 个动作。
- **条件等待**：`pvz_wait_until` 支持 `sun>=200`、`card_ready:repeater`、`zombie_in_lane:3`、`zombie_near:2`、`plantfood>=1`、`tasks_ready`、`phase:running`、`plants>=10`。
- **换卡组**：`pvz_choose_deck({replace:true})` 清空游戏预填卡组后重新选，返回 `deck / applied / skipped / started`。
- **关卡脚本**：`state.levelScript` 直接来自游戏合并后的关卡对象，含每波僵尸明细（`waves[].zombies`、`rows`、`extraFood`、`flag`）、动态增援池 `dynamic[]`、濒危配置 `protectConfig`。
- **植物数值**：`state.cards[].stats` / `state.seedSelection.available[].stats` 含 `cost / cd / hp / family / range / attack{dmg,interval,dps} / splash / chance / plantFood / brief / special`；多发卡不硬算 dps（避免双发被算成一半）。
- **濒危预警**：`state.endangered[].dps`、`ttd`（预计还能撑几秒），`state.protect` 给出 `must / alive / source`。
- **僵尸数值**：`state.zombieStats[type]` 含 `hp / speed / rush / eatDps / tier / speedTier / armor / shield / immunities / chance / behaviors`（如钢琴碾压间隔、淘金者落地眩晕与引爆倒计时、鸡农放鸡血量阈值、巨尸砸击伤害、斗篷护盾）。
- **保护花朵关**：`state.flowers[]` 给出鲜花所在 `lane/column`（来自游戏 `flowerLine` 组件）；提示词会说明“墙必须种在花格右侧”，左侧的墙会进低效候选。

## v0.2.6 新增

- **矿车**：`state.carts[]`（id / lane,column / railLanes / 车上植物 / canUp,canDown）；`pvz_move_cart {cart,direction}` 把车上下移动，植物跟着走。地形用 `R` 标轨道，`blockedCells` 里 `reason:"rail"` 表示车不在。
- **全任务语义**：`tasks[].semantics / left / hint / urgent`，覆盖植物损失、植物上限、阳光预算、限时击杀等 7 种模式。
- **逐行火力**：`state.lanes[]`（`shooters / nearestZombie / needsShooter / danger / mower / cart`）。
- **暂停**：`state.paused / state.ui`，动作返回 `PAUSED`；`pvz_resume` 继续。
- **僵尸标签**：`state.zombies[].tags`（crush / jump_over / backline / flying / spawner / armored / lane_switch）。
- **损失追踪**：`state.recentLosses[]`。
- **健康检查**：`pvz_health`。
- **条件等待**：新增 `cart_ready:<id>`。

## v0.2.7 新增

- **通用机制探测**：`state.mechanics`：
  - `features`（water/tide/rail/tomb/gold/endangered/slider/dinosaur/portal/hazard/conveyor/vase/sky）
  - `tide`（pos/moving）、`dinosaurs[]`（kind/lane/action）、`portals[]`、`hazards[]`
  - `tiles[]`、`unmappedTiles[]`
- **不支持关卡**：传送带/砸罐/天空/保龄球 → `supported:false`，种植返回 `UNSUPPORTED_LEVEL`。
- **实测**：海滩 15（潮汐 pos=3）、黑暗 2（7 墓碑）、古城 15（金瓷砖+濒危）、侏罗纪 10（stego/ptero/raptor）。

## v0.2.8 新增

- **传送带关卡**：`state.conveyor = { enabled, vertical, cards:[{index,type,name}], plantList, slots }`
- `pvz_plant` 的 `card` 在传送带关表示 `conveyor.cards` 的下标；不扣阳光、不吃种子冷却
- `pvz_choose_deck` 传送带关返回「无需选卡」；`pvz_start_level` 直接开战
- `pvz_wait_until` 新增 `conveyor_ready`；`card_ready` 同时识别传送带卡

## v0.2.9 新增

- **开局前先想对策**：先 `pvz_briefing` 读一页简报（任务/目标原文、任务要点、预计僵尸+图鉴+应对、地形/机制/矿车、可选卡组+图鉴、推荐卡组），再 `pvz_set_plan` 记录计划，最后 `pvz_choose_deck` / `pvz_start_level`。计划会一直显示在 `pvz_state.plan`。
- **预计僵尸**：`state.levelPreview.zombies[]`（来自关卡配置 RTID），`pvz_briefing.zombieKnowledge[]` 带 `brief / special / tags / counters`。
- **任务要点**：`state.missionHints[]` 把目标原文解析成可执行要点（不能损失 / 倒计时 / 击杀数 / 植物上限 / 阳光目标 / 以守为主）。
- **铲除候选**：`state.shovelCandidates[]`：`reason=over_limit|upgrade|misplaced|low_hp`，`upgrade` 带 `better / betterCard / needSun`。
- **replace 动作**：`pvz_act {type:"replace",card,lane,column}` 先铲后种，一步换更强的卡；`pvz_shovel` 新增 `expect` 防铲错。
- **铲除保护**：`loss_limit` 任务 `left<=1` 时返回 `SHOVEL_BLOCKED`。
- **选卡补满**：`pvz_choose_deck` 传入的卡组不足卡槽数时自动用常用卡补满，避免「卡组没选满」开不了局。

## v0.3.0 新增

- **铲除候选更实用**：`state.shovelCandidates[]` 现在覆盖“输出位已满/坚果升级/位置不对/残血”，贴脸的植物不再建议换；升级候选带 `betterCard`，可直接 `pvz_act {type:"replace"}`。
- **卡组保底**：计划卡组至少含 1 阳光生产者 + 2 输出，避免一套打不动的卡。
- **思考浮窗（模组侧）**：游戏内左下角实时显示阶段/thought/动作结果/计划，F10 开关；MCP 不受影响。
- **提速（模组侧）**：决策间隔默认 1600ms、动作后 0.9s 复查、场景与关卡数据短缓存。

## v0.3.1 新增

- **`state.board`**：5×9 结构化棋盘，`board[lane].cells[column]` 是植物 codename（空格为 null），`board[lane].zombies[]` 是该行僵尸的 `column/type/hp`。
- **可种落点**：`pvz_plant` 失败时结果里可能带 `alts: [{lane,column}]`（例如地形不可种、格子被占）。位置窗口只是建议，不再返回 `POSITION` 硬拒绝。
- **位置窗口**：阳光 c0-c2、普通输出 c0-c4、坚果/近战 c3-c7、地刺 c2-c6；明显越界会被拒绝并给出 `alts`。
- **推荐**：选落点前先读 `state.board` 和 `state.terrain`，不要猜；失败后按 `alts` 改种，别反复撞同一格。

## v0.3.2 新增

- **`state.world`**：`{ key, name, mechanics, tips, zombies }`，来自关卡名/ID 的世界识别（BWiki 常识兜底）。
- **预计僵尸来源**：`state.levelPreview.zombies[].source` 可能是 `level-data` 或 `world-knowledge`；后者表示关卡数据没读到，按世界常识估计。
- **地刺建议**：放 c4-c7 且在坚果前面效果最好，但代码不再拒绝越界种植。
- **开局计划时机（模组）**：等选卡界面拿到可选卡后再调用参谋，计划里的卡组/克制更贴合本关。
- **策略/指示（模组侧）**：策略提示词可编辑、思考窗可发玩家指示；MCP 侧无需改动，但 `pvz_set_plan` 仍可覆盖计划。

## v0.3.4 新增（模组侧）

- 默认策略移到模组包根目录 `strategy.md`，用文本编辑器直接改，重启游戏生效；`#` 行是注释。
- 旧版 GP-Next 没有 `ctx.files` 时只回退到一句极简兜底，策略正文仍以 `strategy.md` 为准。
- MCP 工具本身无变化；如果你用 MCP 客户端，仍通过 `pvz_set_plan` 控制策略方向。

## v0.3.5 新增（模组侧）

- 浮窗输入框改为 **本关临时策略**：只对当前关卡生效、换关自动清空、不写默认策略；发送后立即触发一次决策。
- 主浮窗不再编辑默认策略，只显示 `strategy.md` 的加载状态和“重新读取”按钮。
- MCP 工具无变化；`pvz_set_plan` 仍然是给 MCP 客户端记录整关计划用的。

## 工具

| 工具 | 作用 |
| --- | --- |
| `pvz_briefing` | 开局一页简报：任务/目标原文 + 任务要点 + 预计僵尸（图鉴/标签/应对）+ 地形/机制/矿车 + 可选卡组（图鉴）+ 推荐卡组 |
| `pvz_set_plan` | 记录本关作战计划（对象或一句话），之后出现在 `state.plan` |
| `pvz_move_cart` | 移动西部矿车（可移动植物平台） |
| `pvz_resume` | 游戏暂停时继续 |
| `pvz_health` | 模组/Server 版本与能力自检 |
| `pvz_state` | 地形、阳光/能量豆、卡槽费用与冷却、植物、僵尸、波次、**关卡任务与倒计时（tasks）**、图鉴、可铲候选、计划 |
| `pvz_knowledge` | 查询某个植物/僵尸的真实图鉴（名称、短介绍、特殊能力、属性） |
| `pvz_plant` | 种卡到指定 lane/column（原生流程：扣阳光、进冷却；失败带 code） |
| `pvz_act` | 一次执行最多 6 个动作（plant / **replace** / shovel / plant_food / wait / choose_deck / start_level / dismiss_objective） |
| `pvz_wait_until` | 等到条件满足或超时（1–60 秒） |
| `pvz_collect` | 立即收取所有掉落物（阳光/能量豆/金币） |
| `pvz_plant_food` | 给指定格子的植物用能量豆 |
| `pvz_shovel` | 铲除指定格子的植物（腾位/清重复/清位置错误）；`expect` 可限定 codename；不返还阳光 |
| `pvz_choose_deck` | 选卡阶段选卡组；`replace:true` 可清空游戏预填卡组，不足卡槽自动补满 |
| `pvz_start_level` | 开始战斗；停在关卡目标说明界面时会先自动关闭再点“一起摇滚吧” |
| `pvz_dismiss_objective` | 关闭开局的关卡目标说明界面，返回本关任务文本 |
| `pvz_wait` | 等待 0.2–15 秒（优先用 `pvz_wait_until`） |
| `pvz_rules` | 规则、坐标、地形、任务计时与策略 |

## 资源

| 资源 | 内容 |
| --- | --- |
| `pvz://guide` | 规则与策略（Markdown） |
| `pvz://state` | 当前战场 |
| `pvz://plants` | 所有植物 codename / 中文名 |
| `pvz://zombies` | 所有僵尸 codename / 中文名 |
| `pvz://plant/{id}` | 单个植物图鉴 |
| `pvz://zombie/{id}` | 单个僵尸图鉴 |

示例：`pvz://plant/iceburg`、`pvz://zombie/pirate`。

## 常见问题

**“没有检测到游戏调试端口”**
先用 `PvZAI_Launcher.exe` 启动游戏。直接双击游戏 EXE 不会开 9222。

**“AI 模组还没有加载”**
GP-Next → 模组 → 勾选“AI 草坪指挥官” → 应用/重启；进关卡后浮窗出现即可。

**工具调用一直要确认**
在客户端里允许该 MCP Server 的工具，或开启自动批准。

**Agent 种错位置**
让它先 `pvz_state` 看 `state.plants`；告诉它 `lane 0-4 / column 0-8`，一格一株。

**游戏在别的电脑**
MCP Server 必须运行在游戏同一台电脑（或安全地转发 9222）。不要把 9222 暴露到公网。

## 安全

- 9222 只绑定 `127.0.0.1`；MCP Server 也只连本机。
- MCP Server 不读取游戏存档、不修改游戏文件；只调用 `window.PvzAI` 暴露的状态/动作。
- 单机使用；不要用于联机或排行榜。
