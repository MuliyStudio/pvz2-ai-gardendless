# PvZ AI Gardendless · v0.2.6 改进记录

> 起因：v0.2.5 实测「狂野西部 第 15 天（失去不超过 2 株植物）」时，Agent 不知道矿车是可移动植物平台、
> 不知道 `plant_lose_limit` 的剩余额度、在游戏暂停时反复空放种植，且逐行火力缺口只能靠人工发现。
> 本版把这些机制固化进模组与 MCP，换 Agent 也能读到。

---

## 1. 官方机制（来自 pvzge.com 图鉴）

| 实体 | 机制 | 对 AI 的影响 |
| --- | --- | --- |
| 矿车（西部） | 可沿同一轨道列上下移动的植物平台，植物跟着车走 | 某行缺火力时移车，而不是重复买植物 |
| 奏琴僵尸 piano | **钢琴碾压植物**；音乐让牛仔僵尸换行 | 地刺会被压掉；不能按固定行布防 |
| 炸矿僵尸 prospector | 跳过**所有**植物，落到最左侧 | 后排向日葵/射手并不安全 |
| 牧鸡僵尸 chicken_farmer | 受伤后释放一群僵尸鸡 | 需要地刺/闪电芦苇等群体伤害 |
| 机械牛 west_bull | 低空投出小鬼，越过大部分防线 | 高坚果才能挡 |
| 地刺 spikeweed | **不会被啃食**，但会被滚动目标摧毁 | 安全输出，但不要放在钢琴/滚桶行 |

---

## 2. 本版改动

### P0

1. **矿车建模**
   - `snapshot().carts[]`：`id / lane / column / railLanes / plants / canUp / canDown`
   - `snapshot().terrain.map` 用 `R` 标轨道；`blockedCells` 里 `reason:"rail"` 表示车不在该格
   - `api.moveCart(id, "up"|"down")`；MCP `pvz_move_cart`；`pvz_act {type:"move_cart"}`
   - 移动限制来自游戏 `cart.canMoveToLnC()`：目标有车/墓碑、植物生成中、有地刺等会拒绝，返回 `CART_BLOCKED`
2. **7 种任务语义**
   - `tasks[].semantics`：`count_limit / loss_limit / sun_budget / sun_produce / countdown / kill_count / sliding_window`
   - `left / hint / urgent`；`plant_lose_limit` 不再把进度条误报成 100%
3. **暂停/锁定**
   - `state.paused`、`state.ui`；种植/铲除/能量豆/移车返回 `PAUSED`
   - `api.resume()`；MCP `pvz_resume`
4. **逐行火力**
   - `state.lanes[]`：`label / shooters / sun / walls / spikes / zombies / nearestZombie / needsShooter / danger / mower / cart`
   - 提示词直接写“有僵尸但无射手 → 优先补射手或移矿车”

### P1

5. **僵尸机制标签**：`zombies[].tags`（curated + 实测）
6. **损失追踪**：`recentLosses[]`（排除自己铲除、矿车移动）
7. **特殊地块**：`specialTiles[]`（rail / tomb / mold / vase / ice）
8. **版本握手**：`pvz_health`（modVersion / serverVersion / compatible / missingTools / installPath / features）

---

## 3. 实测记录（狂野西部 15）

- 地形：`LRLLLLLLL / LRLLLLLLL / RRLLLLLLL / RLLLLLLLL / RLLLLLLLL`
- 矿车：`#0 railLanes=[0,1,2]`，`#1 railLanes=[2,3,4]`；开局后 `canUp/canDown=true`
- `pvz_move_cart {cart:0,direction:"down"}` → `1,1` → `2,1`，植物跟随，`recentLosses=[]`，任务 `left` 不变
- `pvz_wait_until cart_ready:0` 立即命中
- 暂停：`pvz_plant` → `code:"PAUSED"`；`pvz_resume` → `paused:false`
- 任务：`semantics:"loss_limit"`，`left:2`，`hint:"还可损失 2 株（上限 2），再丢就失败"`，`percent:0`
- `pvz_health`：`compatible:true`，`missingTools:[]`，features 全 true

---

## 4. 已知未做

- `pvz_state` 仍内联完整卡牌/僵尸图鉴（P1-4 detail 分级）
- 双控制器租约（P1-6）
- 事件流 `pvz_watch`（P2）
