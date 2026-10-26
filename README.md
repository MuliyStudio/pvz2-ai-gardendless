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
   - 测试连接 → 开始操控（或按 **F8**）

没有 Key 可以先勾选 **本地策略（不调用模型）** 测试自动收阳光/种植。

> 不要直接双击游戏 EXE 使用内置 AI，否则 CSP 会拦截模型请求；请用启动器。

## MCP 模式（推荐给 Claude / Cursor / Cline / OpenCode）

MCP Server 通过本地 CDP 和游戏通信，**不需要解除 CSP，也不需要 API Key**。

1. 用 `PvZAI_Launcher.exe` 启动游戏（开 9222 调试端口并加载模组）。
2. 双击 `配置MCP.bat`。它会自动把 MCP Server 合并进已安装客户端的配置（先备份，不覆盖其它 MCP Server）。
3. 重启 MCP 客户端。
4. 让 Agent 先调用 `pvz_rules`，然后循环：

```text
pvz_state → 决策 → pvz_plant / pvz_plant_food / pvz_shovel → pvz_state
```

工具：

| 工具 | 作用 |
| --- | --- |
| `pvz_state` | 阳光/能量豆、卡槽费用冷却、植物、僵尸、波次 + 当前卡牌/僵尸真实图鉴 |
| `pvz_knowledge` | 查询任意植物/僵尸的图鉴机制 |
| `pvz_plant` | 种卡（原生扣阳光、冷却、每行上限） |
| `pvz_collect` | 立即收取掉落物 |
| `pvz_plant_food` | 使用能量豆 |
| `pvz_shovel` | 铲除植物 |
| `pvz_choose_deck` | 选卡 |
| `pvz_start_level` | 开始战斗 |
| `pvz_wait` | 等待 |
| `pvz_rules` | 规则与策略 |

详见 [PvZ-MCP/README.md](PvZ-MCP/README.md)。

## 它怎么理解植物/僵尸

不写死技能表，直接读游戏内 almanac：

- `ctx.plants.getFeature(id)`：名称、TAGS、资源
- `ctx.plants.getAlmanac(id)`：短介绍、详细说明、Special、SUNCOST/RECHARGE/DAMAGE/RANGE 等
- `ctx.zombies.getAlmanac(id)`：短介绍、Special、TOUGHNESS/SPEED 等
- `snapshot()`：场上实际血量、位置、卡槽冷却

当前卡牌和场上僵尸的图鉴会自动进入内置 prompt；MCP 的 `pvz_state` / `pvz_knowledge` 也返回同样数据。

## 避免乱种

提示词和代码双层约束：

- 同一行最多 1 个坚果墙（血量低于 25% 才允许补新的）
- 同一行最多 1 个弹簧豆 / 1 个冰冻生菜
- 同一行最多 2 个阳光生产者 / 4 个射手 / 2 个地刺
- 目标格已有植物时拒绝
- 失败原因会进入下一回合的“上一回合结果”，模型会看到并调整

## 目录结构

```text
pvz-ai-agent-mod/       GP-Next 模组源码（pack.json / scripts/main.js）
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
