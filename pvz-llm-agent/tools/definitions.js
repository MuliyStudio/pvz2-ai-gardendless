/**
 * 工具契约（MCP / 游戏内 LLM 客户端共用）。
 *
 * 原则：
 *  - 只给事实、执行动作、返回真实结果、记录 LLM 的计划；
 *  - 没有"推荐卡组 / 自动补卡 / 本地策略队列"这类工具；
 *  - 参数名、错误码与 docs/tool-contract.md 保持一致。
 */

const ACTION_TYPES = ['plant', 'replace', 'shovel', 'plant_food', 'activate', 'move_cart', 'resume', 'wait', 'restart', 'dismiss_objective', 'collect'];

const actionSchema = {
  type: 'object',
  description: '一个精确动作。一次 pvz_act 最多 6 个，按数组顺序执行。',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    card: { type: 'integer', minimum: 0, description: '当前卡槽下标（pvz_state.cards[].index）。与 plant 二选一。' },
    plant: { type: 'string', description: '植物 codename（如 sunflower）。与 card 二选一，适合不想记下标时。' },
    lane: { type: 'integer', minimum: 0, description: '行号，0 在最上面。' },
    column: { type: 'integer', minimum: 0, description: '列号，0 在最左边（房子一侧）。' },
    targetLane: { type: 'integer', minimum: 0, description: '点击类卡（activate）的目标行，例如香蕉火箭炮/冬青骑士选中一格时使用。' },
    targetColumn: { type: 'integer', minimum: 0, description: '点击类卡（activate）的目标列。aim=free_cell 时必须给 targetLane/targetColumn。' },
    force: { type: 'boolean', description: 'plant_food 专用：即使范围内没有僵尸也强制给豆（默认会返回 FOOD_NO_TARGET）。' },
    cells: {
      type: 'array', minItems: 1, maxItems: 8,
      description: '批量落点（只对 plant/replace 有效）：一次把同一张卡种到多个格子。工具会按卡的冷却自动等 retryAfter 再重试，最多阻塞 25 秒。给了 cells 就不要再给 lane/column。',
      items: {
        type: 'object', additionalProperties: false, required: ['lane', 'column'],
        properties: { lane: { type: 'integer', minimum: 0 }, column: { type: 'integer', minimum: 0 } },
      },
    },
    cart: { type: 'integer', minimum: 0, description: '矿车 id（pvz_state.carts[].id）。' },
    direction: { type: 'string', enum: ['up', 'down'], description: '矿车移动方向。' },
    seconds: { type: 'number', minimum: 0, maximum: 15, description: 'wait 动作的秒数。' },
  },
};

export const TOOLS = [
  {
    name: 'pvz_briefing',
    title: '开局简报（全量事实）',
    description:
      '在 objective / preparing 阶段读取本关全部事实：任务原文、世界与机制、地形/障碍/可种格、波次与每波僵尸/总 EHP/固定行、僵尸图鉴与数值、全部可用卡（费用/冷却/血量/DPS/产阳光/射程/弹道/用法）、卡槽数与当前卡组、植物上限、起始阳光。' +
      'levelContext 是整关一次性索引：世界/地形摘要、逐波类型与固定行、全部僵尸 tag、卡池能力、卡组缺口、历史。coverageGaps/deck.capabilities 按能力（multi_target/anti_air/anti_rolling/high_dps/control…）汇总整关所有波次，missing[].candidates 是卡池里能满足该能力的卡。' +
      '不返回推荐卡组，也不返回本地打法。选卡前调用一次，把返回内容当作唯一事实来源。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_knowledge',
    title: '图鉴 / 数值查询',
    description:
      '查询植物、僵尸或本关的事实：图鉴简介、特殊能力/弱点、hp/护甲/EHP/速度/啃食 DPS、费用/冷却/DPS/产阳光/射程/弹道/用法（自动、点击、只能墓碑、只能冰块、被啃食）。' +
      '给 type 拿完整条目；给 query 做关键词搜索（中文/英文/codename）；kind 可选 plant/zombie/level。只给事实，不给结论。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', description: 'codename，例如 sunflower、pirate_armor1。' },
        query: { type: 'string', description: '关键词，例如 “海盗 水 僵尸”。' },
        kind: { type: 'string', enum: ['plant', 'zombie', 'level'], description: '限定查询类别。' },
      },
    },
  },
  {
    name: 'pvz_state',
    title: '实时状态',
    description:
      '读取当前实时状态：phase、暂停、阳光/能量豆、plantFoodUsable、波次与倒计时、任务、卡槽（cd/cdReady/affordable/sunShort/ready）、植物（family/foodable）、僵尸（hp/armorHp/ehp/etaToHouse）、每行事实（僵尸数/最近列/推车/output/dps/剩余 ehp/sunProducers）、地形图、可种格、障碍、机制、矿车、当前计划、protectCells、brief、prep。默认返回精简版（去掉棋盘/地形/可种位等简报已给过的字段）；需要全量时传 full=true。' +
      'pvz_act 的返回里已经带 state（同一份精简状态），动作后直接用那份，不必每轮再调 pvz_state；紧接着重复调用会返回 duplicate 提示而不是整份状态。changesSinceLast 是自上次模型读取以来的变化（plantsLost/plantsAdded/mowerLost/waveDelta/sunDelta/zombieDelta），没有变化时 none=true。' +
      '坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        full: { type: 'boolean', description: 'true=返回完整快照（含 board/terrain/plantable/obstacles 等）。默认 false 更省 token。' },
        force: { type: 'boolean', description: 'true=即使上一轮 pvz_act 刚给过 state，也强制重新读取。' },
      },
    },
  },
  {
    name: 'pvz_events',
    title: '增量事件',
    description:
      '取走自上次调用以来的事件：波次开始、行威胁、丢车、植物损失、卡牌就绪、新僵尸类型、任务紧急/完成/失败、胜负。同 lane/同类事件 2.5 秒内合并。没有事件时返回空数组。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少条，默认 200。' },
      },
    },
  },
  {
    name: 'pvz_set_plan',
    title: '记录整关计划',
    description:
      '记录你自己制定的整关计划。工具只保存，不执行、不修正，不做任何本地决策。' +
      'plan 用结构化对象：text（给玩家看的中文摘要）+ goal + deck + lanes[]（lane/role/econ[]/wall/output[]/reserve[]/notes）+ counters[]（tag/threat/card/lane/column/timing）+ phases[]（id/untilWave/actions[]）+ triggers[]（when/action/priority）+ emergency[]/thresholds/contingency。' +
      '快模型执行时读 lanes/counters/phases/triggers，玩家看 text；不要把整份计划只写成一段文本。传 null 清空。' +
      '保存后会按本关事实审计并返回 audit.warnings：缺能力却没写 counters（PLAN_MISSING_COUNTER）、计划卡组和实际卡组不一致（PLAN_DECK_MISMATCH）、只有一段文本（PLAN_TEXT_ONLY）等。warning 不阻止保存，但要按它重写计划。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: {
          anyOf: [{ type: 'object' }, { type: 'null' }],
          description: '结构化计划。示例：{"text":"给玩家看的一句话","goal":"16波全清","deck":["..."],"lanes":[{"lane":0,"role":"经济+墙","econ":[0],"wall":4,"output":[2]}],"counters":[{"tag":"rolling","card":"spikeweed","lane":"all","column":"c5-c7"}],"phases":[{"id":"early","untilWave":4,"actions":["c0 阳光菇×5"]}],"triggers":[{"when":"airRaid.count>0","action":"plant blover","priority":100}],"emergency":[{"when":"zombie on c3","action":"squash/cherry"}]}',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'pvz_choose_deck',
    title: '选卡（只校验 + 执行）',
    description:
      '在选卡阶段按你给的卡组逐张选卡。工具只校验和执行：卡不在卡池返回 CARD_NOT_AVAILABLE + available；重复/超槽位返回 BAD_DECK；数量不足返回 DECK_NOT_FULL + 还差几张；合法才执行。' +
      '逐张加卡并等待 UI 同步，最后返回 actualDeck/applied/skipped/missing。绝不自动补卡，绝不替换你指定的卡。replace=true 会先清空当前卡组。' +
      '传送带关返回 conveyor=true；卡组由系统给定/锁定时返回 forced=true + deckLocked=true 的 actualDeck，不要继续尝试换卡，直接 pvz_start_level。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cards: { type: 'array', minItems: 1, items: { type: 'string' }, description: '植物 codename 列表，数量必须等于卡槽数（replace=false 时含已选卡）。' },
        replace: { type: 'boolean', default: true, description: 'true=清空现有卡组后重新选；false=在现有卡组上追加。' },
      },
      required: ['cards'],
    },
  },
  {
    name: 'pvz_start_level',
    title: '开局',
    description:
      '关闭任务说明弹窗（如还在）并开始战斗。若卡组未满返回 DECK_NOT_FULL。默认等待最多 8 秒确认 phase 进入 running；返回 started/phase/elapsed。提前布阵关（state.prep.mode=preplant）在阵型摆好后调用它开打。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dismiss_objective: { type: 'boolean', default: true, description: '开局前是否关闭任务说明弹窗。' },
        timeout: { type: 'number', minimum: 1, maximum: 20, default: 8, description: '等待进入 running 的秒数。' },
      },
    },
  },
  {
    name: 'pvz_act',
    title: '执行精确动作',
    description:
      '执行 1–6 个精确动作，一次调用就是一轮：不同卡种到不同格、补阳光、给豆、移车、收豆可以放在同一批，工具会连续执行，不会为每株植物各等一次落地。' +
      '动作类型：plant（种植）、replace（同格换植 = 先铲后种，换强卡/换定位/救急都行）、shovel（只铲不种，种错了、要腾格、要牺牲后排经济都行）、plant_food（给 state.plants[].foodable=true 的已落地植物能量豆）、activate（点击类植物：椰子加农炮/冬青骑士/香蕉火箭炮等，aim=free_cell 时同时传 targetLane/targetColumn）、move_cart（矿车）、resume（继续）、wait（等待）、restart（重开本关）、dismiss_objective、collect。' +
      '能量豆会先做空放校验：这株的能量豆只对某范围生效（例如菜问是自身周围 3x3）且范围内没有僵尸时返回 FOOD_NO_TARGET（带 nearestZombie 与本株 plantFood），确实要浪费再传 force=true。' +
      '点击类卡用 activate 触发；state.activatePlan 已经给出行/列/aim/frontZombie/shouldAct/api，直接照它点即可。' +
      '只有「同一张卡连种（冷却）」「同一格先铲后种（用 replace）」「刚种下就要给豆（等落地）」需要分轮；其他动作不要每个都单独发一次 pvz_act。' +
      '同一批动作按数组顺序执行，所以「先 shovel 第 N 格、再 plant 同一格」是合法连招。' +
      'plant/replace 传 cells 可以把同一张卡一次种到多个格子（工具按冷却自动等待重试）。' +
      '同一张卡在一批动作里出现两次时：冷却 ≤3.5 秒工具会自动等它再试（最多 2 次）；更长的冷却直接返回 COOLDOWN，让你换一张卡，不把这一轮晾住。' +
      '每个动作返回真实 ok/code/reason/retryAfter（如 COOLDOWN/SUN/OCCUPIED/CELL_BLOCKED）。部分失败不会抛异常；按每个 result 自己决定下一步。' +
      '批量预检：同一批里同卡重复且基础冷却 >3.5s 时，多出来的动作直接返回 BATCH_COOLDOWN（maxSuccess=本轮最多能成功几个）；同一格先种后铲/重复种返回 BATCH_CONFLICT（conflictWith=前面的动作）；同一批先种墙再把输出种到墙右侧返回 OUTPUT_IN_FRONT_OF_WALL。先铲后种同一格是合法连招。' +
      '地刺/地刺王（stepDamage）必须种在墙前（墙右侧）：种在墙后僵尸被墙挡住、踩不到地刺，会返回 SPIKE_BEHIND_WALL + 墙前可种位。' +
      '返回里还有 state（动作执行后的精简状态，含 changesSinceLast/events）：下一轮直接用它判断，不要再调 pvz_state 空转。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: { type: 'array', minItems: 1, maxItems: 6, items: actionSchema },
      },
      required: ['actions'],
    },
  },
  {
    name: 'pvz_wait_until',
    title: '条件等待',
    description:
      '轮询实时状态，直到条件满足或超时（1–60 秒）。支持：sun>=N / sun<=N / plantfood>=N / card_ready:<type|index> / zombie_in_lane:<lane> / no_zombie_in_lane:<lane> / zombie_near:<column> / phase:<phase> / plants>=N / tasks_ready。' +
      '复合条件用 && 或 ||（一条里只用一种）。超时返回 TIMEOUT + 最后状态，不是错误崩溃。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        until: { type: 'string', description: '条件表达式，例如 sun>=150 && card_ready:sunflower。' },
        timeout: { type: 'number', minimum: 1, maximum: 60, default: 15, description: '超时秒数。' },
      },
      required: ['until'],
    },
  },
  {
    name: 'pvz_collect',
    title: '收掉落物',
    description: '立即收取场上所有可点击掉落物（阳光/能量豆/金币/钻石）。正常会自动收，此工具用于兜底。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_plant_food',
    title: '能量豆',
    description:
      '给指定格子里 foodable=true 的植物释放能量豆（叶绿素）。同一格的花盆/睡莲/一次性卡不能吃豆；刚种下未落地的植物也会失败。' +
      '先看 state.plants[].food（kind/area/radius/total/targets）或 state.brief.plantFoodPlan：范围内没有僵尸会直接返回 FOOD_NO_TARGET（附 nearestZombie），避免把豆喂给够不到僵尸的菜问这类卡；确实要浪费再传 force=true。' +
      '返回 NO_FOOD / NO_PLANT / NOT_FOODABLE / FOOD_NO_TARGET / FOOD_FAILED 等真实 code，成功时 foodLeft 是剩余豆数。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: { type: 'integer', minimum: 0 },
        column: { type: 'integer', minimum: 0 },
        force: { type: 'boolean', description: '范围内没有僵尸也强制使用（默认拦截）。' },
      },
      required: ['lane', 'column'],
    },
  },
  {
    name: 'pvz_move_cart',
    title: '移动矿车',
    description: '把矿车向上或向下移动到相邻轨道；植物会随车移动。返回 from/to 与车上植物。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cart: { type: 'integer', minimum: 0, description: '矿车 id。' },
        direction: { type: 'string', enum: ['up', 'down'] },
      },
      required: ['cart', 'direction'],
    },
  },
  {
    name: 'pvz_resume',
    title: '继续游戏',
    description: '如果游戏处于暂停状态则继续；未暂停时无副作用。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_restart',
    title: '重开本关',
    description:
      '重开当前关卡（回到选卡/任务阶段，阳光、植物、推车、波次全部重置）。不需要先进暂停菜单，工具直接走游戏自己的重开流程。' +
      '返回 restarted/from/phase；8 秒内没回到 preparing 会返回 RESTART_TIMEOUT（不是崩溃，用 pvz_state 看 phase）。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_dismiss_objective',
    title: '关闭任务说明',
    description: '关闭开局的关卡目标说明弹窗，返回本关任务文本。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'pvz_forecast',
    title: '波次预测（本关逐波）',
    description:
      '返回本关逐波预测（工具已经替你算好，不用自己推）：每波的僵尸类型/数量/EHP、哪些僵尸行是写死的（lanes）哪些是随机行、旗帜波、能量豆；动态波额外给点数预算、按权重抽的池子，以及本局的生成结果（dynamic.mode=generated，dynamicCount=这一波随机追加的数量）或还没生成时的模拟期望（estimated，p=出现概率）。' +
      '起始波数、下一波倒计时见返回的 wave 与 state。传 next 只看接下来 N 波。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        next: { type: 'integer', minimum: 1, maximum: 20, description: '只看接下来的前 N 波，默认全部。' },
      },
    },
  },
  {
    name: 'pvz_level_memory',
    title: '关卡总结（读 / 写心得）',
    description:
      '读取本关（或用 key 指定某一关）以前的结果记录：胜负、打到第几波、耗时、用过的卡组、当时的计划、植物/推车损失、以及你写过的心得。开局前读一次，打完再看一次。' +
      '传 note 会把「当前关卡的心得」写入/覆盖（例如哪套卡组有效、哪个波次缺输出）；传 lessons（字符串数组）会追加可执行经验（每关最多 8 条、自动去重）。失败后系统会自动复盘一次并写入 lessons；结束时系统还会自动追加一条本局结果（胜负、波次、卡组、计划）。传 all=true 列出所有关卡。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '关卡 id（默认当前关，如 cowboy13）。' },
        note: { type: 'string', description: '写/覆盖当前关卡的心得。' },
        lessons: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 6,
          description: '追加可执行经验，一条一句、尽量具体（例如“第 3 波铁桶走第 2 行，提前在 c6 放坚果”）。',
        },
        replaceLessons: { type: 'boolean', description: 'true=用这次传入的 lessons 替换旧经验（自动复盘用，避免旧错误结论一直保留）。' },
        all: { type: 'boolean', description: 'true=列出所有有记录的关卡。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'all=true 时最多返回多少关。' },
      },
    },
  },
  {
    name: 'pvz_health',
    title: '健康检查',
    description: '返回模组/工具版本、已注册工具、桥接能力、当前场景与 phase、事件队列状态。用于确认版本匹配。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/** OpenAI 兼容 tool calling 的 tools 字段。 */
export function openAiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** 文档/测试用的返回结构摘要（不是运行时校验器）。 */
export const RETURN_SHAPES = {
  pvz_briefing: ['ok', 'phase', 'objective', 'missionHints', 'levelContext', 'level', 'world', 'terrain', 'waves', 'zombies', 'cards', 'deck', 'coverageGaps', 'deckCapabilities', 'startingSun', 'plantLimit', 'constraints', 'mechanics', 'facts', 'notes'],
  pvz_knowledge: ['ok', 'kind', 'entry | matches'],
  pvz_state: ['ok', 'phase', 'paused', 'sun', 'plantFood', 'plantFoodUsable', 'level', 'objective', 'tasks', 'cards', 'deck', 'seedSelection', 'plants', 'zombies', 'board', 'lanes', 'terrain', 'blockedCells', 'plantable', 'obstacles', 'mechanics', 'carts', 'limits', 'plan', 'changesSinceLast'],
  pvz_events: ['array of {t, at, lane?, detail?, ...}'],
  pvz_set_plan: ['ok', 'plan', 'savedAt', 'audit', 'warnings'],
  pvz_choose_deck: ['ok', 'slots', 'requested', 'applied', 'skipped', 'missing', 'actualDeck', 'full'],
  pvz_start_level: ['ok', 'started', 'phase', 'elapsed', 'detail'],
  pvz_act: ['ok', 'results[]', 'okCount', 'failCount'],
  pvz_wait_until: ['ok', 'satisfied', 'condition', 'elapsed', 'state'],
  pvz_collect: ['ok', 'count', 'kinds'],
  pvz_plant_food: ['ok', 'lane', 'column', 'type', 'foodLeft'],
  pvz_move_cart: ['ok', 'cart', 'direction', 'from', 'to', 'plants'],
  pvz_resume: ['ok', 'paused'],
  pvz_dismiss_objective: ['ok', 'detail', 'tasks'],
  pvz_level_memory: ['ok', 'key', 'entry | entries', 'lessons'],
  pvz_forecast: ['ok', 'source', 'waveCount', 'waves', 'totals', 'dynamic', 'notes'],
  pvz_health: ['ok', 'version', 'api', 'missing', 'features', 'counts', 'eventStatus'],
};
