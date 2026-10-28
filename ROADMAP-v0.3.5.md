# PvZ AI Gardendless · v0.3.5：默认策略归文件，浮窗只管本关

> 澄清后的行为：
> - `strategy.md` = 全局默认策略，只在文件里改；
> - 浮窗输入框 = **本关临时策略**，只在当前关卡有效，发送后立即参与一次思考并立刻决策；
> - 两者互不覆盖，浮窗不再改默认策略、不写 localStorage。

---

## 1. 为什么改

v0.3.2 的浮窗编辑框直接编辑/覆盖默认策略，并保存到 localStorage；v0.3.4 又把它和 `strategy.md` 绑在一起。实际使用中这会让“临时针对这一关的要求”变成永久默认，和预期不符。

现在分成两层：

| 层 | 来源 | 作用范围 | 是否持久化 |
| --- | --- | --- | --- |
| 默认策略 | `strategy.md`（缺失时用脚本内置） | 所有关卡 | 文件本身 |
| 本关临时策略 | 思考浮窗输入框 | **仅当前关卡** | 只存内存，换关清空 |

优先级：临时策略 > 默认策略。

## 2. 默认策略 `strategy.md`

- 包根目录 `strategy.md`，`#` 开头为注释，不发给模型。
- 主浮窗 → **默认策略（strategy.md）**：显示加载状态 + “重新读取 strategy.md”按钮，不再提供全局编辑框。
- 读取使用 `ctx.files.own().readText()`；失败/缺失回退到 `DEFAULT_STRATEGY`。
- 修改文件后点“重新读取”即可生效，不用重启。

## 3. 本关临时策略

- 位置：🧠 AI 思考卡片底部。
- 发送方式：回车（Shift+回车换行）或“发送并思考”。
- 内容会拼进下一次模型请求（与 `state.board`、任务、僵尸、阳光等实时信息一起），并**立即触发一次决策**：

```js
levelHint = '这关地刺放 c6，先补双发';
run.lastKey = '';
if (run.ticking) run.forceTick = true; else schedule(0);
```

- 进入新关卡时按 `levelKeyOf(snapshot)` 自动清空（`syncLevelHint`）。
- 点“清除”立即取消，并触发一次不带该提示的决策。
- 不写 `strategy.md`，不写 `localStorage`。

## 4. 立即决策的实现细节

`tick()` 增加 `run.ticking` 守卫和 `finally`：

```js
if (run.ticking) return;
run.ticking = true;
try { ... } finally {
  run.ticking = false;
  if (run.active && run.forceTick) { run.forceTick = false; schedule(120); }
}
```

- 如果发送时没有正在进行的 tick：`schedule(0)` 立即开始。
- 如果模型正在思考：不打断当前请求，等它结束的 `finally` 立刻再跑一轮，带上新提示。
- `run.lastKey = ''` 让 `decisionKey` 去重失效，确保不会因为“状态没变”跳过。

## 5. 自检

- `node --check` 通过。
- 浏览器 mock（`tools/ui_smoke.html`）验证：
  - `strategy.md` 读取成功，状态显示“已加载 strategy.md”；
  - 主浮窗不再有全局编辑框；
  - 输入临时策略后提示行显示、`PvzAI.prompt(snapshot)` 包含该内容；
  - 点“清除”后提示行清空、prompt 不再包含；
  - “重新读取”可以重新加载文件。
- 立即决策依赖真实 `run`/游戏状态，未实机验证；逻辑上 `schedule(0)` / `forceTick` 已覆盖。

## 6. 注意

- 本关临时策略不会跨关保留；如果下一关还要同样的要求，需要重新输入（或写进 `strategy.md`）。
- 如果 AI 没有在运行，发送只会记录，等点“开始操控”后生效。
- 旧版本保存在 localStorage 的 `strategyPrompt/playerHint` 不再读取，可以忽略。
