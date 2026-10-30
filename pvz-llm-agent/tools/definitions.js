/**
 * 工具契约（MCP / 游戏内 LLM 客户端共用）。
 *
 * 原则：
 *  - 只给事实、执行动作、返回真实结果、记录 LLM 的计划；
 *  - 没有"推荐卡组 / 自动补卡 / 本地策略队列"这类工具；
 *  - 参数名、错误码与 docs/tool-contract.md 保持一致。
 */

const ACTION_TYPES = ['plant', 'replace', 'shovel', 'plant_food', 'move_cart', 'resume', 'wait', 'restart', 'dismiss_objective', 'collect'];

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
      '在 objective / preparing 阶段读取本关全部事实：任务原文、世界与机制、地形/障碍/可种格、波次与每波僵尸/总 EHP、僵尸图鉴与数值、全部可用卡（费用/冷却/血量/DPS/产阳光/射程/弹道/用法）、卡槽数与当前卡组、植物上限、起始阳光。' +
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
      '读取当前实时状态：phase、暂停、阳光/能量豆、波次与倒计时、任务、卡槽（cd/cdReady/affordable/sunShort/ready）、植物、僵尸（hp/maxHp/armorHp/ehp/ehpMax）、5×9 棋盘、每行事实（僵尸数/最近列/推车/输出株数/墙血/dps 合计/剩余 ehp）、地形图、可种格、障碍、机制清单、矿车、当前计划。' +
      'changesSinceLast 是工具算好的「自上次调用 pvz_state 以来的变化」：plantsLost（哪格哪株消失）、plantsAdded、mowerLost（哪行丢车）、waveDelta、sunDelta、zombieDelta、plantsLeft；没有变化时 none=true。' +
      '坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
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
      '记录你自己制定的计划（风格、卡组、每行职责、关键阈值、应急方案）。工具只保存并在 pvz_state.plan 里回显，不执行、不修正、不参与任何本地决策。传 null 清空。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: { anyOf: [{ type: 'object' }, { type: 'null' }], description: '任意 JSON 对象；建议含 style/deck/lanes/thresholds/contingency。传 null 清空。' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'pvz_choose_deck',
    title: '选卡（只校验 + 执行）',
    description:
      '在选卡阶段按你给的卡组逐张选卡。工具只校验和执行：卡不在卡池返回 CARD_NOT_AVAILABLE + available；重复/超槽位返回 BAD_DECK；数量不足返回 DECK_NOT_FULL + 还差几张；合法才执行。' +
      '逐张加卡并等待 UI 同步，最后返回 actualDeck/applied/skipped/missing。绝不自动补卡，绝不替换你指定的卡。replace=true 会先清空当前卡组。',
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
      '关闭任务说明弹窗（如还在）并开始战斗。若卡组未满返回 DECK_NOT_FULL。默认等待最多 8 秒确认 phase 进入 running；返回 started/phase/elapsed。',
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
      '执行 1–6 个精确动作：plant（种植）、replace（同格换植）、shovel（铲除）、plant_food（能量豆）、move_cart（矿车）、resume（继续）、wait（等待）、restart（重开本关）、dismiss_objective、collect。' +
      'plant/replace 传 cells 可以把同一张卡一次种到多个格子（工具按冷却自动等待重试）。' +
      '同一张卡在一批动作里出现两次时，工具也会自动等它的冷却（单次≤6 秒、最多重试 2 次）再执行。' +
      '每个动作返回真实 ok/code/reason/retryAfter（如 COOLDOWN/SUN/OCCUPIED/CELL_BLOCKED）。部分失败不会抛异常；按每个 result 自己决定下一步。',
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
    description: '给指定格子的植物释放能量豆。返回 NO_FOOD / NO_PLANT / NOT_FOODABLE 等真实 code。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: { type: 'integer', minimum: 0 },
        column: { type: 'integer', minimum: 0 },
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
  pvz_briefing: ['ok', 'phase', 'objective', 'missionHints', 'level', 'world', 'terrain', 'waves', 'zombies', 'cards', 'deck', 'startingSun', 'plantLimit', 'constraints', 'mechanics', 'facts', 'notes'],
  pvz_knowledge: ['ok', 'kind', 'entry | matches'],
  pvz_state: ['ok', 'phase', 'paused', 'sun', 'plantFood', 'level', 'objective', 'tasks', 'cards', 'deck', 'seedSelection', 'plants', 'zombies', 'board', 'lanes', 'terrain', 'blockedCells', 'plantable', 'obstacles', 'mechanics', 'carts', 'limits', 'plan', 'changesSinceLast'],
  pvz_events: ['array of {t, at, lane?, detail?, ...}'],
  pvz_set_plan: ['ok', 'plan', 'savedAt'],
  pvz_choose_deck: ['ok', 'slots', 'requested', 'applied', 'skipped', 'missing', 'actualDeck', 'full'],
  pvz_start_level: ['ok', 'started', 'phase', 'elapsed', 'detail'],
  pvz_act: ['ok', 'results[]', 'okCount', 'failCount'],
  pvz_wait_until: ['ok', 'satisfied', 'condition', 'elapsed', 'state'],
  pvz_collect: ['ok', 'count', 'kinds'],
  pvz_plant_food: ['ok', 'lane', 'column', 'type'],
  pvz_move_cart: ['ok', 'cart', 'direction', 'from', 'to', 'plants'],
  pvz_resume: ['ok', 'paused'],
  pvz_dismiss_objective: ['ok', 'detail', 'tasks'],
  pvz_health: ['ok', 'version', 'api', 'missing', 'features', 'counts', 'eventStatus'],
};
