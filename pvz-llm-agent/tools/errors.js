/**
 * 结构化错误码。工具只返回真实 code；"下一步怎么办"由 LLM 自己决定。
 * retryable 只描述"同一个调用稍后是否可能成功"，不是建议。
 */

export const ERROR_CODES = {
  // 场景 / 生命周期
  NO_SCENE: { text: '不在游戏场景内（或棋盘还没加载）', retryable: true },
  NOT_IN_LEVEL: { text: '当前不在关卡里', retryable: true },
  ALREADY_STARTED: { text: '战斗已经开始，不能再选卡', retryable: false },
  PREP_NOT_READY: { text: '选卡/开局界面还没准备好', retryable: true },
  NO_SEED_SELECTION: { text: '当前不在选卡界面', retryable: true },
  NO_SLOTS: { text: '本关没有可用卡槽', retryable: false },

  // 选卡
  BAD_DECK: { text: '卡组不合法（重复、超槽位或数量不对）', retryable: false },
  CARD_NOT_AVAILABLE: { text: '指定的卡不在本关卡池或未解锁', retryable: false },
  DECK_NOT_FULL: { text: '卡组没选满；工具不会自动补卡', retryable: false },
  DECK_CLEAR_FAILED: { text: '旧卡组没能清空', retryable: true },
  CARD_SELECT_FAILED: { text: '卡组已满但有指定卡没选中', retryable: true },
  CARD_NOT_IN_DECK: { text: '这张卡不在当前卡槽里', retryable: false },

  // 动作
  BAD_ACTION: { text: '动作对象不合法', retryable: false },
  BAD_POSITION: { text: 'lane/column 不是数字', retryable: false },
  NO_CARD: { text: '没有这张卡（index 越界）', retryable: false },
  COOLDOWN: { text: '卡牌冷却中', retryable: true },
  SUN: { text: '阳光不足', retryable: true },
  OCCUPIED: { text: '格子已有植物', retryable: false },
  CELL_BLOCKED: { text: '该格不能种植（地形/障碍/滑轨）', retryable: false },
  PLANT_NOT_SETTLED: { text: '种植发起失败（尚未进入异步落地）', retryable: true },
  SHOVEL_FAILED: { text: '铲除没有生效', retryable: true },
  EMPTY: { text: '该格没有植物', retryable: false },
  NO_FOOD: { text: '没有能量豆', retryable: true },
  NO_PLANT: { text: '该格没有植物', retryable: false },
  NOT_FOODABLE: { text: '该植物不能使用能量豆', retryable: false },
  FOOD_NO_TARGET: { text: '这株的能量豆范围内没有僵尸（空放）；确实要浪费请传 force=true', retryable: true },
  FOOD_FAILED: { text: '能量豆释放失败', retryable: true },
  // 点击类植物（椰子加农炮/冬青骑士/香蕉火箭炮…）
  NOT_ACTIVATABLE: { text: '这株是自动攻击，不需要 activate', retryable: false },
  NOT_READY: { text: '这株现在点不动（休息/射击中/阳光不够/没长成）', retryable: true },
  NO_TARGET: { text: '点击类卡需要目标格（targetLane/targetColumn）', retryable: false },
  ACTIVATE_UNSUPPORTED: { text: '这个版本找不到可用的触发入口（看返回的 tried/api）', retryable: false },
  ACTIVATE_FAILED: { text: '触发点击类植物时抛异常', retryable: true },
  NO_CELL: { text: '该格不存在', retryable: false },
  PAUSED: { text: '游戏暂停中；先 pvz_resume', retryable: true },
  UNKNOWN_ACTION: { text: '未知动作类型', retryable: false },
  ACT_THREW: { text: '执行动作时抛异常', retryable: false },
  NO_ACTIONS: { text: 'actions 为空', retryable: false },

  // 矿车 / 任务
  NO_CART: { text: '没有这辆矿车', retryable: false },
  CART_BLOCKED: { text: '矿车不能向该方向移动', retryable: false },
  NO_OBJECTIVE: { text: '当前没有关卡目标弹窗', retryable: true },
  CONTINUE_NOT_FOUND: { text: '找不到“继续”按钮', retryable: true },
  DISMISS_FAILED: { text: '关闭任务弹窗失败', retryable: true },
  START_FAILED: { text: '开局调用失败', retryable: true },

  // 等待
  BAD_CONDITION: { text: '无法识别的等待条件', retryable: false },
  TIMEOUT: { text: '等待超时（条件未满足）', retryable: true },

  // 知识 / 计划
  BAD_QUERY: { text: 'knowledge 需要 type 或 query', retryable: false },
  KNOWLEDGE_NOT_FOUND: { text: '没有找到该图鉴条目', retryable: false },
  BAD_PLAN: { text: 'plan 必须是对象', retryable: false },

  // 传输 / 桥
  MOD_NOT_LOADED: { text: '游戏内模组没加载（window.PvzLlm 不存在）', retryable: true },
  CDP_DISCONNECTED: { text: '与游戏的调试连接断开', retryable: true },
  CDP_NO_PAGE: { text: '没有找到游戏调试页面', retryable: true },
  BRIDGE_ERROR: { text: '游戏页面执行异常', retryable: true },
  BAD_RESPONSE: { text: '游戏页面返回了无法解析的结果', retryable: true },
  UNKNOWN_TOOL: { text: '未知工具名', retryable: false },

  // LLM 客户端
  BAD_CONFIG: { text: 'API Base / 模型 / Key 不完整', retryable: true },
  BAD_TOOL_ARGS: { text: '模型返回的工具参数不是合法 JSON', retryable: false },
  TOOL_FAILED: { text: '工具执行时抛异常', retryable: true },
  LLM_HTTP: { text: '模型接口返回 HTTP 错误', retryable: true },
  LLM_REQUEST_FAILED: { text: '模型请求失败（网络/CSP/鉴权）', retryable: true },
  NO_TOOL_CALL: { text: '模型连续没有调用工具；按需求停住，不本地接管', retryable: true },
  STEP_LIMIT: { text: '单轮步数上限；已停住，不本地接管', retryable: true },
  STOPPED: { text: '已停止', retryable: true },
};

export function errorInfo(code) {
  return ERROR_CODES[code] || { text: code || 'UNKNOWN', retryable: false };
}

/** 工具回包里统一带上 code/reason/retryable，方便 LLM 复述。 */
export function normalizeError(code, extra = {}, reason) {
  const info = errorInfo(code);
  return {
    ok: false,
    code,
    reason: reason || info.text,
    retryable: extra.retryable != null ? !!extra.retryable : !!info.retryable,
    ...extra,
  };
}
