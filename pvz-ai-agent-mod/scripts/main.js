/**
 * AI 草坪指挥官 · GP-Next 模组
 * 目标版本：PvZ2 Gardendless 0.16.x + GP-Next 1.5.x（桌面版，单机）
 *
 * 工作方式：
 *  - 通过 GP-Next 的 ctx.unsafe.engine 拿到游戏自己的 Cocos 引擎；
 *  - 只读解析当前场景里的 SunCount / Cards / LnC / Zombie / levelController；
 *  - 种植走游戏自己的“选卡 + 点格子”流程（PlaceUIPlant），会正常扣阳光、进冷却；
 *  - 大模型使用 OpenAI 兼容协议，Key 只保存在本机 localStorage（可选择不记）。
 *
 * 注意：这是单机辅助工具，请勿用于联机或排行榜；游戏更新后内部字段可能变化。
 */

const VERSION = '0.2.3';
const CFG_KEY = 'pvzai.agent.mod.cfg.v1';
const HOST_ID = 'pvzai-mod-host';
const LOG_LIMIT = 120;

const PLANT_CN = {
  sunflower: '向日葵', twinsunflower: '双子向日葵', sunshroom: '阳光菇', primalsunflower: '原始向日葵',
  peashooter: '豌豆射手', repeater: '双发射手', snowpea: '寒冰射手', threepeater: '三线射手',
  splitpea: '分裂豌豆', peapod: '豌豆荚', gatlingpea: '机枪豌豆', firepea: '火焰豌豆',
  wallnut: '坚果墙', tallnut: '高坚果', endurian: '棱镜草', 'explode-o-nut': '爆炸坚果',
  potatomine: '土豆雷', cherrybomb: '樱桃炸弹', jalapeno: '火爆辣椒', 'ice-shroom': '寒冰菇',
  iceburg: '冰冻生菜', springbean: '弹簧豆',
  chomper: '大嘴花', 'bonk-choy': '菜问', 'cabbage-pult': '卷心菜投手', 'kernel-pult': '玉米投手',
  'melon-pult': '西瓜投手', 'winter-melon': '冰西瓜', bloomerang: '回旋镖', 'lightning-reed': '闪电芦苇',
  spikeweed: '地刺', spikrock: '地刺王', lilypad: '睡莲', 'flower-pot': '花盆', imitater: '模仿者',
};

const ZOMBIE_CN = {
  mummy: '木乃伊', mummy_armor1: '路障木乃伊', mummy_armor2: '铁桶木乃伊', mummy_armor4: '铁盔木乃伊',
  mummy_flag: '旗帜木乃伊', ra: '太阳神', explorer: '探险家', tomb_raiser: '造墓者', pharaoh: '法老',
  egypt_imp: '小鬼', egypt_gargantuar: '埃及巨人',
  pirate: '海盗', swashbuckler: '剑客', seagull: '海鸥', barrelroller: '滚桶', pirate_captain: '海盗船长',
  pirate_gargantuar: '海盗巨人', cowboy: '牛仔', prospector: '淘金者', piano: '钢琴僵尸', poncho: '斗篷僵尸',
  chicken_farmer: '养鸡人', chicken: '小鸡', west_bull: '公牛', cowboy_gargantuar: '牛仔巨人',
  future: '未来僵尸', jetpack: '喷气背包', protector: '护盾僵尸', mech_cone: '机械路障',
  football_mech: '机械橄榄球', disco_mech: '机械迪斯科', future_gargantuar: '未来巨人',
  dark: '黑暗僵尸', dark_juggler: '小丑僵尸', dark_wizard: '巫师僵尸', dark_king: '黑暗国王',
  dark_gargantuar: '黑暗巨人', beach: '沙滩僵尸', beach_snorkel: '潜水僵尸', beach_surfer: '冲浪僵尸',
  beach_octopus: '章鱼僵尸', beach_fisherman: '渔夫僵尸', beach_gargantuar: '沙滩巨人',
  iceage: '冰河僵尸', iceage_hunter: '猎人僵尸', iceage_dodo: '渡渡鸟骑士', iceage_troglobite: '穴居人',
  iceage_weaselhoarder: '黄鼠狼', iceage_gargantuar: '冰河巨人', lostcity: '失落僵尸',
  lostcity_lostpilot: '飞行员僵尸', lostcity_excavator: '挖掘者', lostcity_jane: '珍妮',
  lostcity_bug: '甲虫僵尸', lostcity_relichunter: '遗物猎人', lostcity_crystalskull: '水晶骷髅',
  lostcity_gargantuar: '失落巨人', kongfu: '功夫僵尸', monk: '武僧', abbot: '方丈',
  zombossmech_egypt: '埃及僵王', zombossmech_pirate: '海盗僵王', zombossmech_cowboy: '牛仔僵王',
  zombossmech_future: '未来僵王', zombossmech_dark: '黑暗僵王', zombossmech_beach: '沙滩僵王',
  zombossmech_iceage: '冰河僵王', zombossmech_lostcity: '失落僵王',
};

function cleanCodename(v) {
  const s = String(v || '');
  const m = /^RTID\(([^@)]+)/i.exec(s);
  return m ? m[1] : s;
}

function normalizeBaseUrl(raw) {
  let b = String(raw || '').trim().replace(/\/+$/, '');
  if (!b) return b;
  if (/^https?:\/\/(api\.deepseek\.com|api\.openai\.com)$/i.test(b)) return b + '/v1';
  try {
    const u = new URL(b);
    if (u.pathname === '/' || u.pathname === '') return b + '/v1';
  } catch { /* ignore */ }
  return b;
}

function plantRole(type) {
  const t = String(type || '').toLowerCase();
  if (/sunflower|sunshroom|twinsunflower|primalsunflower|sunbean|sun-shroom/.test(t)) return 'sun';
  if (/wallnut|tallnut|tall-nut|endurian|garlic|explode-o-nut|infi-nut|primalwallnut|peanut|pumpkin/.test(t)) return 'wall';
  if (/springbean|spring-bean/.test(t)) return 'spring';
  if (/iceburg|iceberg|ice-shroom|icebloom|iceberg-lettuce/.test(t)) return 'freeze';
  if (/spikeweed|spikrock|spikerock/.test(t)) return 'spike';
  if (/pea|shot|pult|melon|cabbage|kernel|bloomerang|reed|starfruit|homingthistle|xshot|fume|laser|sniper|bonk|chomper/.test(t)) return 'shooter';
  return 'other';
}

const DEFAULT_CFG = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  persistKey: false,
  autoSun: true,
  autoDeck: true,
  localBrain: false,
  interval: 2200,
  heartbeat: 9000,
  maxTurns: 500,
  collapsed: false,
  pos: null,
};

const SYSTEM_PROMPT = `你是《植物大战僵尸2》的实时自动游玩代理。你只能输出一个 json 对象，不能输出 Markdown、解释或思考过程。

坐标：lane 0-4 从上到下；column 0-8 从左（房子）到右（僵尸出生点）。僵尸 column 越小越危险。

输出格式（严格 json）：
{"thought":"不超过30字","actions":[{"type":"plant","card":0,"lane":2,"column":1}]}

动作：
- {"type":"plant","card":<卡槽下标>,"lane":0-4,"column":0-8}
- {"type":"shovel","lane":0-4,"column":0-8}
- {"type":"plant_food","lane":0-4,"column":0-8}
- {"type":"wait"}
- {"type":"choose_deck","plants":["sunflower","peashooter"]}  仅 phase=preparing
- {"type":"start_level"}  仅 phase=preparing

游戏规则：
- 掉落的阳光、能量豆、金币会自动收取，不需要你操作。
- 种植会扣阳光并进入冷却；同一张卡冷却中不能再用；一格只能种一株（除非卡牌允许叠加）。
- 僵尸从右往左走，吃掉植物；到最左会触发小推车（每行一次）。
- 射手向右攻击；坚果挡路；冰系减速/冻结；一次性植物触发后消失；地刺不会被啃食但会被滚动物体摧毁；弹簧豆把僵尸弹回/弹进水。
- 能量豆会自动收集；需要时用 plant_food 给高输出植物释放大招。
- 卡牌图鉴和僵尸图鉴会随状态给出，按图鉴事实决策，不要猜。
- 每行最多 1 个坚果墙；该行已有坚果且血量>25% 时不要再种。
- 每行最多 1 个弹簧豆/冰冻生菜；一次性植物不要叠。
- 每行最多 4 个射手；优先补没有射手的行。
- 当前没有阳光生产者时，不要等向日葵；优先低费射手/地刺，坚果只给最危险的行。
- 种植前先看“阵容统计”和每行植物；不要重复同类型植物。

决策原则：
1. 前期优先 2-3 个阳光生产者，种在 column 0-2。
2. 攻击植物优先种在 column 1-4；不要把植物种在已有植物的格子。
3. 某行僵尸 column<=3 时优先在该行补防御或输出；column<=1 属于紧急情况。
4. 只选择 ready=true 的卡；cd>0 或 affordable=false 的卡不要用。
5. 每个回合最多 3 个动作，按顺序执行；没有值得做的就输出 wait。
6. 优先使用费用低、冷却好的卡；阳光快到上限时不必囤积。
7. 可以并且应该用 shovel：同一行重复坚果/弹簧豆、植物血量低于 30% 且本行危险、某格低效植物需要腾位。每次最多铲 1 个，铲完再种。
8. 如果某行已有 2 个坚果/弹簧豆/冰生菜，先铲掉多余的一个，再补输出。
9. 如果 phase=preparing，先 choose_deck（最多选满卡槽）再 start_level；如果已经自动选好卡，直接 start_level。`;

const PLAY_TOOL = {
  type: 'function',
  function: {
    name: 'play_actions',
    description: '提交本回合的《植物大战僵尸2》操作。最多 3 个动作。',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: '不超过 30 字的决策说明' },
        actions: {
          type: 'array',
          description: '按顺序执行的动作',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['plant', 'shovel', 'plant_food', 'wait', 'choose_deck', 'start_level'] },
              card: { type: 'integer', description: '卡槽下标（plant 用）' },
              lane: { type: 'integer', description: '0-4 行' },
              column: { type: 'integer', description: '0-8 列' },
              plants: { type: 'array', items: { type: 'string' }, description: '选卡阶段的植物 codename 列表' },
            },
            required: ['type'],
          },
        },
      },
      required: ['thought', 'actions'],
    },
  },
};

export default {
  setup(ctx) {
    const engine = ctx.unsafe && ctx.unsafe.engine;
    const getCc = () => {
      try { return (engine && engine.getCc && engine.getCc()) || window.cc || null; } catch { return window.cc || null; }
    };
    const platformVersion = (() => {
      try { return ctx.compat && ctx.compat.getPlatformVersion ? String(ctx.compat.getPlatformVersion()) : 'unknown'; } catch { return 'unknown'; }
    })();

    let cfg = loadCfg();
    let host = null, shadow = null, el = {};
    let logLines = [];
    let run = null;
    let uiTimer = null;
    let autoCollectTimer = null;
    let lastPickupLog = 0;
    let disposed = false;
    let tauriHttpLogged = false;
    let tauriHttpErrorLogged = false;
    const kb = { plants: Object.create(null), zombies: Object.create(null), plantNames: null, zombieNames: null };

    // GP-Next 可能在同源 iframe 中运行模组：优先把浮窗挂到游戏主页面。
    function getDoc() {
      try {
        if (window.parent && window.parent !== window) {
          const d = window.parent.document;
          if (d && d.body) return d;
        }
      } catch { /* cross-origin, fall through */ }
      return document;
    }
    function getWin() {
      try { if (window.parent && window.parent !== window) return window.parent; } catch { /* ignore */ }
      return window;
    }

    // ───────────────────────── 配置 ─────────────────────────

    function loadCfg() {
      try {
        const raw = localStorage.getItem(CFG_KEY);
        if (!raw) return { ...DEFAULT_CFG };
        const parsed = JSON.parse(raw);
        const out = { ...DEFAULT_CFG, ...parsed };
        if (!parsed.persistKey) out.apiKey = '';
        return out;
      } catch { return { ...DEFAULT_CFG }; }
    }

    function saveCfg() {
      try {
        const copy = { ...cfg };
        if (!cfg.persistKey) copy.apiKey = '';
        localStorage.setItem(CFG_KEY, JSON.stringify(copy));
      } catch { /* ignore */ }
    }

    // ───────────────────────── 日志 ─────────────────────────

    function mlog(message, kind = '') {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      logLines.push({ time, message: String(message), kind });
      if (logLines.length > LOG_LIMIT) logLines = logLines.slice(-LOG_LIMIT);
      renderLog();
      if (kind === 'err') showError(String(message));
      try {
        if (kind === 'err') ctx.log.error('[AI草坪] ' + message);
        else if (kind === 'warn') ctx.log.warn('[AI草坪] ' + message);
        else ctx.log.info('[AI草坪] ' + message);
      } catch { /* ignore */ }
    }

    function showError(message) {
      if (!el.errbar) return;
      el.errbar.textContent = '✖ ' + message;
      el.errbar.classList.add('show');
    }

    function clearError() {
      if (!el.errbar) return;
      el.errbar.textContent = '';
      el.errbar.classList.remove('show');
    }

    function toast(message, type = 'info') {
      try { ctx.ui.toast(message, type); } catch { /* ignore */ }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function renderLog() {
      if (!el.log) return;
      el.log.innerHTML = logLines.map((l) =>
        `<div><span class="t">${l.time}</span> <span class="${l.kind}">${escapeHtml(l.message)}</span></div>`
      ).join('');
      el.log.scrollTop = el.log.scrollHeight;
    }

    // ───────────────────────── 浮窗 ─────────────────────────

    function buildUI() {
      const doc = getDoc();
      const old = doc.getElementById(HOST_ID);
      if (old) old.remove();
      host = null;
      shadow = null;

      host = doc.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; }
          .panel {
            position: absolute; right: 16px; top: 80px; bottom: auto; width: 330px;
            pointer-events: auto;
            max-height: min(88vh, 780px); display: flex; flex-direction: column;
            border: 1px solid rgba(126,217,87,.38); border-radius: 14px;
            background: linear-gradient(180deg, rgba(18,34,24,.97), rgba(10,20,14,.97));
            box-shadow: 0 14px 40px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
            overflow: hidden; backdrop-filter: blur(8px);
            font-family: "Microsoft YaHei","PingFang SC",system-ui,sans-serif;
            color: #eaf5ea; font-size: 12px; line-height: 1.45;
          }
          .head {
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
            padding: 9px 10px 9px 12px; cursor: grab; user-select: none;
            background: linear-gradient(180deg, rgba(52,94,47,.95), rgba(28,54,32,.95));
            border-bottom: 1px solid rgba(126,217,87,.22);
          }
          .head:active { cursor: grabbing; }
          .title { font-weight: 700; font-size: 13px; letter-spacing: .3px; }
          .ver { opacity: .55; font-size: 10px; margin-left: 4px; }
          button {
            font-family: inherit; font-size: 12px; color: #eaf5ea; cursor: pointer;
            border: 1px solid rgba(126,217,87,.35); background: rgba(255,255,255,.06);
            border-radius: 8px; padding: 5px 9px; transition: background .15s,border-color .15s,transform .05s;
          }
          button:hover { background: rgba(126,217,87,.18); border-color: rgba(126,217,87,.6); }
          button:active { transform: translateY(1px); }
          button:disabled { opacity: .4; cursor: not-allowed; }
          .icon { padding: 2px 8px; line-height: 1.3; font-size: 14px; }
          .body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; overflow-x: hidden; min-height: 0; }
          .scroll-area { display: contents; }
          .status {
            flex: 0 0 auto;
            border: 1px solid rgba(126,217,87,.22); background: rgba(126,217,87,.07);
            border-radius: 9px; padding: 7px 9px; font-size: 11.5px; color: #bfe9b4; word-break: break-all;
          }
          .status b { color: #fff; font-weight: 600; }
          .errbar {
            flex: 0 0 auto;
            display: none; border: 1px solid rgba(255,120,120,.65);
            background: rgba(160,36,36,.28); color: #ffb3b3;
            border-radius: 8px; padding: 7px 9px; font-size: 11px;
            word-break: break-all; white-space: pre-wrap;
          }
          .errbar.show { display: block; }
          details { flex: 0 0 auto; border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 0 9px 9px; background: rgba(255,255,255,.025); }
          summary { cursor: pointer; padding: 8px 0 6px; font-weight: 600; color: #cfecc6; list-style: none; }
          summary::-webkit-details-marker { display: none; }
          summary::before { content: "▸ "; opacity: .7; }
          details[open] summary::before { content: "▾ "; }
          .field { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
          .field label { color: #9fc79a; font-size: 11px; }
          input[type="text"], input[type="password"], input[type="number"] {
            font-family: inherit; font-size: 12px; color: #eaf5ea; width: 100%;
            background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.12);
            border-radius: 7px; padding: 6px 8px; outline: none;
          }
          input:focus { border-color: rgba(126,217,87,.6); }
          .checks { flex: 0 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
          .check { display: flex; align-items: center; gap: 6px; color: #c8dfc3; cursor: pointer; }
          .check input { accent-color: #7ed957; }
          .btns { flex: 0 0 auto; display: flex; gap: 6px; flex-wrap: wrap; }
          .btns button { flex: 1; min-width: 86px; }
          .primary { background: linear-gradient(180deg,#6fc94c,#479a30) !important; border-color: #8fe36a !important; font-weight: 700; color: #fff !important; }
          .danger { background: rgba(200,60,60,.22) !important; border-color: rgba(255,120,120,.45) !important; }
          .log {
            flex: 0 0 110px; height: 110px; min-height: 110px;
            overflow-y: auto; overflow-x: hidden;
            white-space: pre-wrap; word-break: break-all;
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 8px; padding: 6px 8px; background: rgba(0,0,0,.3);
            font-family: Consolas,"Cascadia Mono",monospace; font-size: 10.5px;
            line-height: 1.45; color: #b9d3b3;
          }
          .log div { white-space: pre-wrap; word-break: break-all; }
          .log .t { color: #6f8f6b; }
          .log .ok { color: #9fe08a; }
          .log .warn { color: #ffd479; }
          .log .err { color: #ff9b9b; }
          .hint { color: #87a382; font-size: 10.5px; }
          .pill {
            position: absolute; right: 0; bottom: 0; display: none; align-items: center; gap: 6px;
            pointer-events: auto; padding: 9px 14px; border-radius: 999px; cursor: pointer;
            border: 1px solid rgba(126,217,87,.55);
            background: linear-gradient(180deg, rgba(52,94,47,.98), rgba(24,46,28,.98));
            box-shadow: 0 8px 24px rgba(0,0,0,.5); font-weight: 700;
            font-family: "Microsoft YaHei",system-ui,sans-serif; color: #eaf5ea; font-size: 12px;
          }
          .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #7ed957; box-shadow: 0 0 8px #7ed957; }
          .pill.idle .dot { background: #8a9a86; box-shadow: none; }
          :host(.collapsed) .panel { display: none; }
          :host(.collapsed) .pill { display: flex; }
        </style>
        <div class="panel">
          <div class="head" id="drag">
            <div><span class="title">🌻 AI 草坪指挥官</span><span class="ver">v${VERSION}</span></div>
            <button class="icon" data-act="min" title="收起">—</button>
          </div>
          <div class="body">
            <div class="status" id="status">正在等待游戏加载…</div>
            <div class="errbar" id="errbar"></div>

            <div class="btns">
              <button id="start" class="primary">开始操控</button>
              <button id="stop" class="danger" disabled>停止</button>
            </div>
            <div class="btns">
              <button id="test">测试连接</button>
              <button id="copylog">复制日志</button>
              <button id="snap">导出状态</button>
            </div>

            <div class="log" id="log"></div>

            <div class="scroll-area">
              <details open>
                <summary>模型设置</summary>
                <div class="field"><label>API Base URL（含 /v1）</label>
                  <input type="text" id="base" spellcheck="false" placeholder="https://api.deepseek.com/v1"></div>
                <div class="field"><label>模型名</label>
                  <input type="text" id="model" spellcheck="false" placeholder="deepseek-flash"></div>
                <div class="field"><label>API Key</label>
                  <input type="password" id="key" spellcheck="false" placeholder="sk-…（只保存在本机）"></div>
                <label class="check" style="margin-top:7px"><input type="checkbox" id="persist"><span>在本机记住 Key（localStorage 明文）</span></label>
                <div class="field"><label>决策间隔（毫秒）</label>
                  <input type="number" id="interval" min="800" max="15000" step="200"></div>
                <div class="hint">DeepSeek 常用：deepseek-flash / deepseek-v4-pro。OpenRouter 可直连；OpenAI 官方通常被 CORS 拦截，请用中转。想让 Claude/Cursor 直接操控：用 PvZ-MCP 的 MCP Server，不需要在这里填 Key。游戏版本：${escapeHtml(platformVersion)}</div>
              </details>

              <div class="checks">
                <label class="check"><input type="checkbox" id="autosun"><span>自动收阳光/能量豆</span></label>
                <label class="check"><input type="checkbox" id="autodeck"><span>自动选卡开局</span></label>
                <label class="check"><input type="checkbox" id="local"><span>本地策略（不调用模型）</span></label>
                <label class="check"><input type="checkbox" id="debug"><span>控制台日志</span></label>
              </div>
            </div>
          </div>
        </div>
        <button class="pill idle" id="pill"><span class="dot"></span><span id="pillText">AI 待机（F8）</span></button>
      `;
      doc.body.appendChild(host);
      mountHost();

      // 浮窗上的输入/点击不要传给游戏，避免填 Key 时触发游戏快捷键或种植物。
      for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'wheel']) {
        shadow.addEventListener(type, (e) => e.stopPropagation(), false);
      }

      el = {
        panel: shadow.querySelector('.panel'),
        status: shadow.querySelector('#status'),
        errbar: shadow.querySelector('#errbar'),
        log: shadow.querySelector('#log'),
        pill: shadow.querySelector('#pill'),
        pillText: shadow.querySelector('#pillText'),
        start: shadow.querySelector('#start'),
        stop: shadow.querySelector('#stop'),
        base: shadow.querySelector('#base'),
        model: shadow.querySelector('#model'),
        key: shadow.querySelector('#key'),
        persist: shadow.querySelector('#persist'),
        interval: shadow.querySelector('#interval'),
        autosun: shadow.querySelector('#autosun'),
        autodeck: shadow.querySelector('#autodeck'),
        local: shadow.querySelector('#local'),
        debug: shadow.querySelector('#debug'),
      };

      el.base.value = cfg.baseUrl;
      el.model.value = cfg.model;
      el.key.value = cfg.apiKey;
      el.persist.checked = cfg.persistKey;
      el.interval.value = cfg.interval;
      el.autosun.checked = cfg.autoSun;
      el.autodeck.checked = cfg.autoDeck;
      el.local.checked = cfg.localBrain;
      if (host) host.classList.toggle('collapsed', !!cfg.collapsed);
      applyPos();

      const bindText = (node, key, transform = (v) => v) => {
        node.addEventListener('input', () => { cfg[key] = transform(node.value); saveCfg(); });
      };
      bindText(el.base, 'baseUrl');
      bindText(el.model, 'model');
      bindText(el.key, 'apiKey');
      el.interval.addEventListener('change', () => {
        cfg.interval = clamp(+el.interval.value || 2200, 800, 15000);
        el.interval.value = cfg.interval;
        saveCfg();
      });
      el.persist.addEventListener('change', () => {
        cfg.persistKey = el.persist.checked;
        saveCfg();
        if (!cfg.persistKey) mlog('已关闭 Key 记忆，下次需重新填写', 'warn');
      });
      el.autosun.addEventListener('change', () => { cfg.autoSun = el.autosun.checked; saveCfg(); });
      el.autodeck.addEventListener('change', () => { cfg.autoDeck = el.autodeck.checked; saveCfg(); });
      el.local.addEventListener('change', () => { cfg.localBrain = el.local.checked; saveCfg(); });
      el.debug.addEventListener('change', () => { window.__PVZAI_DEBUG__ = el.debug.checked; });

      el.start.addEventListener('click', start);
      el.stop.addEventListener('click', () => stop('手动停止'));
      shadow.querySelector('#test').addEventListener('click', testConnection);
      shadow.querySelector('#copylog').addEventListener('click', copyLog);
      shadow.querySelector('#snap').addEventListener('click', exportSnapshot);
      el.pill.addEventListener('click', () => setCollapsed(false));
      shadow.querySelector('[data-act="min"]').addEventListener('click', () => setCollapsed(true));

      makeDraggable(shadow.querySelector('#drag'));
      renderLog();
      updateStatus();
      uiTimer = setInterval(updateStatus, 700);
    }

    function setCollapsed(v) {
      cfg.collapsed = !!v;
      saveCfg();
      if (shadow && host) host.classList.toggle('collapsed', !!v);
    }

    function mountHost() {
      if (!host) return;
      const doc = getDoc();
      const target = doc.fullscreenElement || doc.body;
      if (target && host.parentElement !== target) target.appendChild(host);
    }

    function applyPos() {
      if (!el.panel) return;
      if (cfg.pos) {
        el.panel.style.left = cfg.pos.left + 'px';
        el.panel.style.top = cfg.pos.top + 'px';
        el.panel.style.right = 'auto';
        el.panel.style.bottom = 'auto';
      }
    }

    function makeDraggable(handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        const r = el.panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const r = el.panel.getBoundingClientRect();
        const left = clamp(ox + e.clientX - sx, 0, getWin().innerWidth - r.width);
        const top = clamp(oy + e.clientY - sy, 0, getWin().innerHeight - 48);
        el.panel.style.left = left + 'px';
        el.panel.style.top = top + 'px';
        el.panel.style.right = 'auto';
        el.panel.style.bottom = 'auto';
      });
      handle.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        const r = el.panel.getBoundingClientRect();
        cfg.pos = { left: Math.round(r.left), top: Math.round(r.top) };
        saveCfg();
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      });
    }

    // ───────────────────────── 游戏桥 ─────────────────────────

    function findComps() {
      const cc = getCc();
      const scene = cc && cc.director && cc.director.getScene && cc.director.getScene();
      if (!scene) return null;
      const map = Object.create(null);
      const walk = (n) => {
        const comps = n._components || [];
        for (let i = 0; i < comps.length; i++) {
          const c = comps[i];
          const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (k && !map[k]) map[k] = c;
        }
        const children = n.children || [];
        for (let i = 0; i < children.length; i++) walk(children[i]);
      };
      walk(scene);
      return { cc, scene, map };
    }

    function snapshot() {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '尚未进入游戏场景' };
      const { scene, map } = ctxg;
      const sceneName = scene.name || '';
      const cards = map.Cards || null;
      const ui = map.UIInGame || null;
      const sunComp = map.SunCount || null;
      const droppings = map.Droppings || null;
      const lvl = map.levelController || null;
      const square = map.Square || null;

      let phase = 'other';
      if (sceneName === 'mainScene') phase = 'menu';
      else if (/worldmap/i.test(sceneName)) phase = 'worldmap';
      else if (sceneName === 'inGameScene') {
        const fighting = !!(lvl && lvl.gameStarted) || !!(cards && cards.gameStarted);
        if (lvl && lvl.gameWon) phase = 'won';
        else if (lvl && lvl.gameLost) phase = 'lost';
        else if (!fighting) phase = 'preparing';
        else phase = 'running';
      }

      const out = {
        ok: true,
        scene: sceneName,
        phase,
        sun: sunComp ? sunComp.CurrentValue : null,
        level: {
          name: (lvl && lvl.levelNameString) || '',
          wave: lvl && Number.isFinite(lvl.currentWave) ? lvl.currentWave + 1 : 0,
          waves: (lvl && lvl.waveManagerProps && lvl.waveManagerProps.WaveCount) || null,
          progress: lvl ? Math.round((lvl.levelProgressPercentage || 0) * 100) : 0,
          nextWaveIn: lvl && Number.isFinite(lvl.NextWaveCountdown) ? Math.max(0, Math.round(lvl.NextWaveCountdown)) : null,
          selectedIndex: ui ? ui.index : -1,
          gameStarted: !!(lvl && lvl.gameStarted),
          rocked: !!(lvl && lvl.letsRocked),
        },
        plantFood: map.PlantFoodCount ? map.PlantFoodCount.plantFoodNum : null,
        cards: [],
        plants: [],
        zombies: [],
        suns: [],
        seedSelection: null,
      };

      if (cards && Array.isArray(cards.CFs)) {
        const sunNow = out.sun;
        out.cards = cards.CFs.map((cf, i) => {
          const upper = cards.cardsUIUpper && cards.cardsUIUpper[i];
          const cd = upper ? Math.max(0, +upper.CD || 0) : 0;
          const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
          const affordable = (cf.ca && cf.ca.free) || (Number.isFinite(sunNow)
            ? sunNow >= cost
            : !!(cf.ca && cf.ca.affordable));
          const cooling = !!(cf.ca && cf.ca.cooling) || cd > 0;
          return {
            index: i,
            type: cf.Type || '',
            name: PLANT_CN[cf.Type] || cf.Type || '',
            cost,
            cd: Math.round(cd * 10) / 10,
            affordable,
            cooling,
            ready: affordable && !cooling,
            selected: !!(ui && ui.index === i),
          };
        });
      }

      if (square) {
        const C = square.constructor;
        const lanes = C.LaneCount || 5;
        const cols = C.ColumnCount || 9;
        out.grid = { lanes, columns: cols };

        const seen = new Set();
        for (let r = 0; r < lanes; r++) {
          for (let c = 0; c < cols; c++) {
            const cell = C.getLnC(r, c);
            if (!cell) continue;
            for (const p of cellPlantList(cell)) {
              if (!p || seen.has(p)) continue;
              seen.add(p);
              const rawType = p.Plant_Type || '';
              const type = cleanCodename(rawType);
              out.plants.push({
                lane: r, column: c,
                type,
                name: PLANT_CN[type] || type,
                hp: Math.round(p.health || 0),
                maxHp: Math.round(p.toughness || 0),
                foodable: !!p.foodable && !p.fooding,
              });
            }
          }
        }

        for (let r = 0; r < lanes; r++) {
          const lane = C.getLane(r);
          if (!lane) continue;
          let pool = [];
          try { pool = (lane.zombiePool ? lane.zombiePool() : []).concat(lane.hypnoZombiePool ? lane.hypnoZombiePool() : []); } catch { pool = []; }
          for (const z of pool) {
            if (!z) continue;
            let alive = true;
            try { alive = z.isAlive ? z.isAlive() : (z.health > 0); } catch { alive = true; }
            if (!alive) continue;
            const col = (z.worldPositionX - C.Square00.worldPosition.x) / C.SquareWidth;
            const type = cleanCodename(z.Zombie_Type || '');
            out.zombies.push({
              lane: r,
              column: Math.round(col * 10) / 10,
              gridColumn: Math.round(col),
              type,
              name: ZOMBIE_CN[type] || type,
              hp: Math.round(z.health || 0),
              maxHp: Math.round((z.totalHealth ? z.totalHealth() : z.health) || 0),
              hypnotized: !!z.hypnotized,
            });
          }
        }
        out.zombies.sort((a, b) => a.lane - b.lane || a.column - b.column);
      }

      if (droppings && Array.isArray(droppings.sunPool)) {
        for (const s of droppings.sunPool) {
          if (!s || s.collected) continue;
          let valid = true;
          try { valid = !s.node || s.node.isValid; } catch { valid = true; }
          if (!valid) continue;
          out.suns.push({ value: s.value || 0 });
        }
      }

      if (cards && cards.seedChooser && Array.isArray(cards.seedChooser.CFs)) {
        out.seedSelection = {
          slots: cards.maxSlotCount || 0,
          available: cards.seedChooser.CFs
            .filter((cf) => cf && cf.Type && !(cf.ca && cf.ca.locked) && !(cf.ca && cf.ca.disallowed))
            .map((cf) => ({
              type: cf.Type,
              name: PLANT_CN[cf.Type] || cf.Type,
              cost: Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0,
              chosen: !!(cf.ca && cf.ca.chosen),
            })),
        };
      }

      return out;
    }

    function safeSnapshot() {
      try { return snapshot(); } catch (e) { return { ok: false, reason: '读取状态失败：' + (e && e.message ? e.message : e) }; }
    }

    function isUnderNames(node, names) {
      let p = node;
      let depth = 0;
      while (p && depth++ < 12) {
        if (p.name && names.indexOf(p.name) >= 0) return true;
        const comps = p._components || [];
        for (const c of comps) {
          const k = c && (c.__classname__ || (c.constructor && c.constructor.name));
          if (k && names.indexOf(k) >= 0) return true;
        }
        p = p.parent;
      }
      return false;
    }

    function collectPickups() {
      const ctxg = findComps();
      if (!ctxg || !ctxg.scene) return { ok: false, count: 0, kinds: {} };
      const kinds = Object.create(null);
      let count = 0;
      const walk = (n) => {
        if (!n || n.active === false) return;
        const comps = n._components || [];
        for (const c of comps) {
          if (!c || c.collected !== false || c.mouseListen !== true) continue;
          if (typeof c.collect !== 'function') continue;
          if (isUnderNames(n, ['Prizes', 'CurrencyShower'])) continue;
          try { if (c.collectable && !c.collectable()) continue; } catch { /* ignore */ }
          try {
            const type = c.DroppingType || c.__classname__ || c.constructor && c.constructor.name || 'item';
            c.collect();
            kinds[type] = (kinds[type] || 0) + 1;
            count++;
          } catch { /* ignore one drop */ }
        }
        const children = n.children || [];
        for (const ch of children) walk(ch);
      };
      walk(ctxg.scene);
      return { ok: true, count, kinds };
    }

    function collectSuns() {
      return collectPickups();
    }

    function pickupLabel(kinds) {
      const names = {
        sun: '阳光', plantFood: '能量豆', plantfood: '能量豆', coin: '金币', gem: '钻石', sprout: '幼苗', ticket: '彩券',
      };
      return Object.keys(kinds || {})
        .map((k) => `${names[k] || k}×${kinds[k]}`)
        .join(' ');
    }

    function cellPlantList(cell) {
      if (!cell) return [];
      const list = [];
      const groups = [
        cell.plantInSquare,
        cell.vineInSquare,
        cell.tilePlantInSquare,
        cell.imitaterInSquare,
        cell.floawerpot ? [cell.floawerpot] : null,
        cell.lilypad ? [cell.lilypad] : null,
      ];
      for (const g of groups) {
        if (!Array.isArray(g)) continue;
        for (const p of g) {
          if (!p || list.includes(p)) continue;
          let alive = true;
          try { alive = p.isAlive ? p.isAlive() : true; } catch { alive = true; }
          if (alive) list.push(p);
        }
      }
      return list;
    }

    function lanePlantList(C, lane) {
      const list = [];
      const cols = C.ColumnCount || 9;
      for (let c = 0; c < cols; c++) {
        for (const p of cellPlantList(C.getLnC(lane, c))) {
          if (!list.includes(p)) list.push(p);
        }
      }
      return list;
    }

    function plant(cardIndex, lane, column) {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const ui = map.UIInGame, cards = map.Cards, square = map.Square;
      if (!ui || !cards || !square) return { ok: false, reason: '当前场景没有种植物界面' };

      const cf = cards.CFs && cards.CFs[cardIndex];
      if (!cf) return { ok: false, reason: `卡槽 ${cardIndex} 不存在` };
      if (Array.isArray(cards.cardsUIUpper) && cards.CFs.length > cards.cardsUIUpper.length) {
        return { ok: false, reason: '卡槽 UI 尚未初始化完成，请稍候' };
      }
      const upper = cards.cardsUIUpper && cards.cardsUIUpper[cardIndex];
      if (upper && upper.CD > 0) return { ok: false, reason: `${cf.Type} 冷却中 ${upper.CD.toFixed(1)}s` };
      const sunCounter = map.SunCount;
      const sunNow = sunCounter ? sunCounter.CurrentValue : null;
      const cost = Number.isFinite(cf.SUNCOST) ? cf.SUNCOST : 0;
      if (cf.ca && !cf.ca.affordable && Number.isFinite(sunNow) && sunNow >= cost) {
        // 卡片 UI 的状态可能慢一帧；阳光足够时同步一次，避免刚开局被误判为“阳光不足”。
        cf.ca.affordable = true;
      }
      if (cf.ca && !cf.ca.affordable && !cf.ca.free) return { ok: false, reason: `${cf.Type} 阳光不足` };

      const C = square.constructor;
      if (lane < 0 || lane >= (C.LaneCount || 5) || column < 0 || column >= (C.ColumnCount || 9)) {
        return { ok: false, reason: `格子 ${lane},${column} 超出范围` };
      }
      const cell = C.getLnC(lane, column);
      if (!cell) return { ok: false, reason: '格子不存在' };

      const role = plantRole(cf.Type);
      const lanePlants = lanePlantList(C, lane);
      const sameRole = lanePlants.filter((p) => plantRole(cleanCodename(p.Plant_Type || '')) === role);
      const posText = sameRole.map((p) => (p.plantInLnC && p.plantInLnC.cIndex != null ? 'c' + p.plantInLnC.cIndex : '?')).join(',');
      if (role === 'wall') {
        const strong = sameRole.find((p) => (p.health || 0) > Math.max(1, p.toughness || 1) * 0.25);
        if (strong) return { ok: false, reason: `该行已有坚果墙（${posText}），不要重复种` };
      } else if (role === 'spring' && sameRole.length) {
        return { ok: false, reason: `该行已有弹簧豆（${posText}），一次性植物不要叠` };
      } else if (role === 'freeze' && sameRole.length) {
        return { ok: false, reason: `该行已有冰冻生菜（${posText}），不要重复种` };
      } else if (role === 'sun' && sameRole.length >= 2) {
        return { ok: false, reason: `该行已有 2 个阳光生产者（${posText}），先补其他行` };
      } else if (role === 'shooter' && sameRole.length >= 4) {
        return { ok: false, reason: `该行已有 4 个射手（${posText}），先补其他行` };
      } else if (role === 'spike' && sameRole.length >= 2) {
        return { ok: false, reason: `该行已有 2 个地刺（${posText}），不要重复种` };
      }

      const tags = (cf.PF && cf.PF.TAGS) || [];
      const canOverlap = tags.includes('allowOverlap') || tags.includes('vine') || tags.includes('floawerPot') || tags.includes('lilypad');
      const cellPlants = cellPlantList(cell);
      if (cellPlants.length && !canOverlap) return { ok: false, reason: `格子 ${lane},${column} 已有植物` };

      if (ui.index === cardIndex && ui.currentCF !== cf) ui.tryChangingIndex(-1);
      if (ui.index !== cardIndex) ui.tryChangingIndex(cardIndex);
      if (ui.currentCF !== cf) return { ok: false, reason: `${cf.Type} 无法选中（冷却/阳光/场景限制）` };

      const canPlace = cell.putPlantAvailable
        ? cell.putPlantAvailable(true, cf.ID, true, true, cf.spf)
        : true;
      if (!canPlace) {
        if (ui.index === cardIndex) ui.tryChangingIndex(-1);
        if (run && run.blocked) run.blocked.set(`${lane}:${column}`, Date.now() + 15000);
        return { ok: false, reason: `格子 ${lane},${column} 当前不可种植（关卡限制/地形/植物上限）` };
      }

      const beforeSpawn = cell.spawningPromiseCount || 0;
      cell.PlaceUIPlant();
      if ((cell.spawningPromiseCount || 0) <= beforeSpawn) {
        if (ui.index === cardIndex) ui.tryChangingIndex(-1);
        return { ok: false, reason: `${cf.Type} 在 ${lane},${column} 种植未生效` };
      }
      return { ok: true, detail: `种下 ${PLANT_CN[cf.Type] || cf.Type} @ ${lane},${column}` };
    }

    function shovel(lane, column) {
      const ctxg = findComps();
      if (!ctxg || !ctxg.map.Square) return { ok: false, reason: '不在关卡内' };
      const C = ctxg.map.Square.constructor;
      const cell = C.getLnC(lane, column);
      if (!cell) return { ok: false, reason: '格子不存在' };
      const plants = cellPlantList(cell);
      if (!plants.length) return { ok: false, reason: `格子 ${lane},${column} 没有植物` };
      const names = plants.map((p) => cleanCodename(p.Plant_Type || '') || '植物').join(',');
      try {
        cell.removePlant();
      } catch (e) {
        // 某些版本 removePlant 可能对 tile 植物异常，下面走逐株兜底。
      }
      let remaining = cellPlantList(cell);
      if (remaining.length) {
        for (const p of remaining) {
          try { if (p.die) p.die(false); } catch { /* ignore */ }
          try { if (p.node && p.node.destroy) p.node.destroy(); } catch { /* ignore */ }
        }
        remaining = cellPlantList(cell);
      }
      if (remaining.length) {
        return { ok: false, reason: `铲除失败，仍剩：${remaining.map((p) => cleanCodename(p.Plant_Type || '')).join(',')}` };
      }
      return { ok: true, detail: `铲除 ${names} @ ${lane},${column}` };
    }

    function plantFood(lane, column) {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const C = map.Square && map.Square.constructor;
      if (!C) return { ok: false, reason: '不在关卡内' };
      const counter = map.PlantFoodCount;
      if (counter && !(counter.plantFoodNum > 0)) return { ok: false, reason: '没有植物能量' };
      const cell = C.getLnC(lane, column);
      const p = ((cell && cell.plantInSquare) || []).find((x) => x && x.foodable && !x.fooding);
      if (!p) return { ok: false, reason: '该格没有可喂能量的植物' };
      p.food();
      if (counter && counter.plantFoodDec) counter.plantFoodDec();
      return { ok: true, detail: `植物能量 → ${lane},${column}` };
    }

    function safeStartable(cards) {
      try { return !!(cards && cards.GameStartable && cards.GameStartable()); } catch { return false; }
    }

    function prepReady(cards, lvl) {
      return !!(cards && lvl && cards.shown && cards.seedChooser && cards.maxSlotCount > 0
        && lvl.viewButton && lvl.viewButton.node
        && cards.gameStartButton && cards.gameStartButton.node
        && !lvl.rocked && !lvl.gameStarted);
    }

    function tryLetsRock(lvl, cards) {
      if (!lvl || typeof lvl.letsRock !== 'function') return { ok: false, reason: '当前场景无法开局' };
      if (lvl.letsRocked) return { ok: false, reason: '已经开局' };
      if (!prepReady(cards, lvl)) return { ok: false, reason: '选卡界面还没准备好，稍等' };
      if (!safeStartable(cards)) return { ok: false, reason: '卡组还没选满' };
      try {
        lvl.letsRock();
        return { ok: true, detail: '开始战斗' };
      } catch (e) {
        return { ok: false, reason: '开局失败：' + (e && e.message ? e.message : e) };
      }
    }

    function autoDeck() {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      if (!cards || !lvl) return { ok: false, reason: '当前不是关卡准备阶段' };
      if (cards.gameStarted) return { ok: false, reason: '战斗已经开始' };

      const max = cards.maxSlotCount || 0;
      if (!max) return { ok: false, reason: '当前关卡没有可用卡槽（植物未解锁/关卡限制）' };
      if (safeStartable(cards)) return tryLetsRock(lvl, cards);
      if (!cards.seedChooser) return { ok: false, reason: '选卡界面未打开' };

      if (cards.CFs.length >= max) return { ok: true, detail: '卡组已满' };

      const avail = (cards.seedChooser.CFs || []).filter(
        (cf) => cf && cf.Type && !(cf.ca && cf.ca.locked) && !(cf.ca && cf.ca.disallowed)
      );
      const pick = [];
      const push = (type) => {
        if (pick.length >= max || pick.includes(type)) return;
        if (avail.some((c) => c.Type === type)) pick.push(type);
      };
      [
        'sunflower', 'primalsunflower', 'twinsunflower', 'sunshroom',
        'peashooter', 'repeater', 'snowpea', 'threepeater', 'cabbage-pult', 'kernel-pult',
        'wallnut', 'tallnut', 'endurian', 'potatomine', 'cherrybomb', 'jalapeno',
        'chomper', 'bonk-choy', 'bloomerang', 'lightning-reed', 'spikeweed',
      ].forEach(push);
      for (const cf of avail) { if (pick.length >= max) break; push(cf.Type); }

      let added = 0;
      for (const type of pick) {
        try {
          const before = cards.CFs.length;
          cards.addCardByPlantTypeFromSeedbank(type);
          if (cards.CFs.length > before) added++;
        } catch { /* ignore one card */ }
      }
      if (safeStartable(cards)) {
        const r = tryLetsRock(lvl, cards);
        return r.ok ? { ok: true, detail: `选卡 ${added} 张，已开局`, deck: pick } : { ok: false, reason: r.reason };
      }
      return { ok: true, detail: `选卡 ${added} 张，等待界面就绪`, deck: pick };
    }

    function autoDeckWith(plants) {
      if (!Array.isArray(plants) || !plants.length) return autoDeck();
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      if (!cards || !lvl) return { ok: false, reason: '当前不是关卡准备阶段' };
      if (cards.gameStarted) return { ok: false, reason: '战斗已经开始' };
      const avail = new Set(((cards.seedChooser && cards.seedChooser.CFs) || []).map((c) => c.Type));
      let added = 0;
      for (const type of plants) {
        if (!avail.has(type)) continue;
        try {
          const before = cards.CFs.length;
          cards.addCardByPlantTypeFromSeedbank(type);
          if (cards.CFs.length > before) added++;
        } catch { /* ignore one card */ }
      }
      if (safeStartable(cards)) {
        const r = tryLetsRock(lvl, cards);
        return r.ok ? { ok: true, detail: `选卡 ${added} 张，已开局` } : { ok: false, reason: r.reason };
      }
      return { ok: true, detail: `选卡 ${added} 张` };
    }

    function startLevel() {
      const ctxg = findComps();
      if (!ctxg) return { ok: false, reason: '不在关卡内' };
      const { map } = ctxg;
      const cards = map.Cards, lvl = map.levelController;
      return tryLetsRock(lvl, cards);
    }

    // ───────────────────────── 决策 ─────────────────────────

    function decisionKey(s) {
      const ready = s.cards.filter((c) => c.ready).map((c) => c.type).join(',');
      const zombies = s.zombies
        .map((z) => `${z.lane}:${Math.floor(z.column)}:${z.type}:${Math.ceil(z.hp / 80)}`)
        .sort().join('|');
      const plants = s.plants
        .map((p) => `${p.lane}:${p.column}:${p.type}:${Math.ceil((p.hp || 0) / 150)}`)
        .sort().join('|');
      return [s.phase, s.level.wave, ready, zombies, plants].join('#');
    }

    function localBrain(s) {
      const ready = s.cards.filter((c) => c.ready);
      const occupied = new Set(s.plants.map((p) => `${p.lane}:${p.column}`));
      const blocked = (run && run.blocked) || new Map();
      const free = (lane, col) => {
        const k = `${lane}:${col}`;
        return !occupied.has(k) && !((blocked.get(k) || 0) > Date.now());
      };
      const sunMakers = s.plants.filter((p) => /sunflower|sunshroom|twinsunflower/i.test(p.type)).length;
      const sunCard = ready.find((c) => /sunflower|sunshroom|twinsunflower|primalsunflower/i.test(c.type));
      const shooters = ready.filter((c) => /pea|shot|pult|melon|cabbage|kernel|bloomerang|reed|starfruit|fume|laser|spike|sniper/i.test(c.type));
      const walls = ready.filter((c) => /wallnut|tallnut|endurian|garlic|nut/i.test(c.type));

      const danger = s.zombies.filter((z) => z.column <= 3.5).sort((a, b) => a.column - b.column)[0];
      if (danger) {
        const actions = [];
        const wall = walls[0];
        const laneHasWall = s.plants.some((p) => p.lane === danger.lane && plantRole(p.type) === 'wall');
        if (wall && !laneHasWall) {
          for (const col of [3, 2, 1]) {
            if (free(danger.lane, col)) { actions.push({ type: 'plant', card: wall.index, lane: danger.lane, column: col }); break; }
          }
        }
        if (shooters[0]) {
          for (const col of [1, 2, 0, 3, 4]) {
            if (free(danger.lane, col)) { actions.push({ type: 'plant', card: shooters[0].index, lane: danger.lane, column: col }); break; }
          }
        }
        if (actions.length) return { thought: '最危险一路补防', actions };
      }

      if (sunMakers < 3 && sunCard) {
        for (const lane of [2, 1, 3, 0, 4]) for (const col of [0, 1, 2]) {
          if (free(lane, col)) return { thought: '补经济（向日葵）', actions: [{ type: 'plant', card: sunCard.index, lane, column: col }] };
        }
      }

      if (shooters[0]) {
        const counts = [0, 0, 0, 0, 0];
        s.plants.forEach((p) => { counts[p.lane] = (counts[p.lane] || 0) + 1; });
        const lane = counts.indexOf(Math.min(...counts));
        for (const col of [1, 2, 3, 4, 0, 5]) {
          if (free(lane, col)) return { thought: '补输出', actions: [{ type: 'plant', card: shooters[0].index, lane, column: col }] };
        }
      }

      if (walls[0] && s.zombies.length) {
        for (const z of s.zombies) {
          if (s.plants.some((p) => p.lane === z.lane && plantRole(p.type) === 'wall')) continue;
          for (const col of [4, 3, 2]) {
            if (free(z.lane, col)) return { thought: '加一道墙', actions: [{ type: 'plant', card: walls[0].index, lane: z.lane, column: col }] };
          }
        }
      }

      return { thought: '等待阳光/冷却', actions: [{ type: 'wait' }] };
    }

    function fmtKbElement(e) {
      if (!e || !e.TYPE) return '';
      if (e.VALUE != null) return `${e.TYPE}:${e.VALUE}`;
      if (e.SORT && e.SORT.zh) return `${e.TYPE}:${e.SORT.zh}`;
      if (e.PROGRESS != null) return `${e.TYPE}:${Math.round(e.PROGRESS * 100)}%`;
      return '';
    }

    function ensureKbNames() {
      if (kb.plantNames) return;
      kb.plantNames = Object.create(null);
      kb.zombieNames = Object.create(null);
      try {
        for (const e of ctx.plants.listFeatureEntries()) {
          kb.plantNames[e.id] = (e.name && e.name.zh) || e.label || e.id;
        }
      } catch { /* ignore */ }
      try {
        for (const e of ctx.zombies.listFeatureEntries()) {
          kb.zombieNames[e.id] = (e.name && e.name.zh) || e.label || e.id;
        }
      } catch { /* ignore */ }
    }

    function plantKb(type) {
      const key = String(type || '');
      if (!key) return null;
      if (kb.plants[key]) return kb.plants[key];
      ensureKbNames();
      const info = {
        name: kb.plantNames[key] || PLANT_CN[key] || key,
        brief: '',
        special: [],
        tags: [],
        elements: [],
      };
      try {
        const f = ctx.plants.getFeature(key);
        if (f && Array.isArray(f.TAGS)) info.tags = f.TAGS.slice();
      } catch { /* ignore */ }
      try {
        const a = ctx.plants.getAlmanac(key);
        const d = a && a.objdata;
        if (d) {
          info.brief = (d.BriefIntroduction && d.BriefIntroduction.zh) || (d.Introduction && d.Introduction.zh) || '';
          if (Array.isArray(d.Special)) {
            info.special = d.Special.map((s) => `${(s.NAME && s.NAME.zh) || ''}：${(s.DESCRIPTION && s.DESCRIPTION.zh) || ''}`).filter((s) => s.length > 1);
          }
          if (Array.isArray(d.Elements)) info.elements = d.Elements.map(fmtKbElement).filter(Boolean);
        }
      } catch { /* ignore */ }
      kb.plants[key] = info;
      return info;
    }

    function zombieKb(type) {
      const key = String(type || '');
      if (!key) return null;
      if (kb.zombies[key]) return kb.zombies[key];
      ensureKbNames();
      const info = {
        name: kb.zombieNames[key] || ZOMBIE_CN[key] || key,
        brief: '',
        special: [],
        elements: [],
      };
      try {
        const a = ctx.zombies.getAlmanac(key);
        const d = a && a.objdata;
        if (d) {
          info.brief = (d.BriefIntroduction && d.BriefIntroduction.zh) || (d.Introduction && d.Introduction.zh) || '';
          if (Array.isArray(d.Special)) {
            info.special = d.Special.map((s) => `${(s.NAME && s.NAME.zh) || ''}：${(s.DESCRIPTION && s.DESCRIPTION.zh) || ''}`).filter((s) => s.length > 1);
          }
          if (Array.isArray(d.Elements)) info.elements = d.Elements.map(fmtKbElement).filter(Boolean);
        }
      } catch { /* ignore */ }
      kb.zombies[key] = info;
      return info;
    }

    function stateForPrompt(s) {
      const compact = {
        phase: s.phase,
        level: s.level,
        sun: s.sun,
        plantFood: s.plantFood,
        cards: s.cards.map((c) => ({ i: c.index, type: c.type, name: c.name, cost: c.cost, cd: c.cd, ready: c.ready, affordable: c.affordable })),
        plants: s.plants.map((p) => ({ lane: p.lane, column: p.column, type: p.type, name: p.name, hp: p.hp, maxHp: p.maxHp })),
        zombies: s.zombies.map((z) => ({ lane: z.lane, column: z.column, type: z.type, name: z.name, hp: z.hp, maxHp: z.maxHp, hypnotized: z.hypnotized })),
        sunsOnGround: s.suns.length,
        lastResults: (run && run.lastResults) || [],
      };
      if (s.phase === 'preparing' && s.seedSelection) compact.seedSelection = s.seedSelection;
      if (run && run.blocked) {
        const now = Date.now();
        compact.blockedCells = [...run.blocked.entries()]
          .filter(([, until]) => until > now)
          .map(([key]) => key);
      }

      const lines = [];
      lines.push(`关卡：${s.level.name || '未知'}  阶段：${phaseText(s.phase)}  波次：${s.level.wave}/${s.level.waves || '?'}  下一波：${s.level.nextWaveIn ?? '?'}s`);
      lines.push(`阳光：${s.sun}  能量豆：${s.plantFood ?? 0}  地面掉落：${s.suns.length}`);
      if (run && run.lastResults && run.lastResults.length) {
        lines.push('上一回合结果：' + run.lastResults.join('；'));
      }
      if (s.phase === 'preparing' && s.seedSelection) {
        lines.push(`可选卡：${s.seedSelection.available.map((p) => `${p.type}(${p.cost})`).join(', ')}`);
      } else {
        lines.push('卡槽图鉴：');
        for (const c of s.cards) {
          const k = plantKb(c.type);
          const extra = k ? [k.brief, k.special.join('；')].filter(Boolean).join('；') : '';
          const tags = k && k.tags.length ? `｜${k.tags.join(',')}` : '';
          lines.push(`[${c.index}] ${c.name}(${c.type}) ${c.cost}☀ ${c.ready ? '可用' : (c.cd > 0 ? `CD${c.cd}s` : '阳光不足')}${extra ? '｜' + extra : ''}${tags}`);
        }
      }
      const ztypes = [...new Set(s.zombies.map((z) => z.type))].filter(Boolean);
      if (ztypes.length) {
        lines.push('僵尸图鉴：');
        for (const t of ztypes) {
          const k = zombieKb(t);
          if (!k) continue;
          const elems = k.elements.length ? `｜${k.elements.join(' ')}` : '';
          const extra = [k.brief, k.special.join('；')].filter(Boolean).join('；');
          lines.push(`${k.name}(${t})${elems}${extra ? '｜' + extra : ''}`);
        }
      }
      const roleCounts = { sun: 0, wall: 0, spring: 0, freeze: 0, spike: 0, shooter: 0, other: 0 };
      for (const p of s.plants) roleCounts[plantRole(p.type)] = (roleCounts[plantRole(p.type)] || 0) + 1;
      lines.push(`阵容统计：射手×${roleCounts.shooter} 坚果×${roleCounts.wall} 弹簧豆×${roleCounts.spring} 冰冻生菜×${roleCounts.freeze} 地刺×${roleCounts.spike} 阳光生产者×${roleCounts.sun}`);
      if (roleCounts.sun === 0 && !s.cards.some((c) => plantRole(c.type) === 'sun' && c.ready)) {
        lines.push('提示：当前没有阳光生产者可用，不要等向日葵；优先低费射手/地刺，坚果只给最危险的行。');
      }
      for (let r = 0; r < 5; r++) {
        const lanePlants = s.plants.filter((p) => p.lane === r);
        const ps = lanePlants.map((p) => `c${p.column}${p.name}`);
        const zs = s.zombies.filter((z) => z.lane === r).map((z) => `c${z.column}${z.name || z.type}(${z.hp})`);
        const lc = { sun: 0, wall: 0, spring: 0, freeze: 0, spike: 0, shooter: 0, other: 0 };
        lanePlants.forEach((p) => { const role = plantRole(p.type); lc[role] = (lc[role] || 0) + 1; });
        const hints = [];
        if (lc.wall > 0) hints.push('已有坚果，禁止再种坚果');
        if (lc.spring > 0) hints.push('已有弹簧豆，不要叠');
        if (lc.freeze > 0) hints.push('已有冰冻生菜，不要重复');
        if (lc.shooter === 0) hints.push('缺输出');
        if (lc.shooter >= 4) hints.push('射手已满');
        if (s.zombies.some((z) => z.lane === r && z.column <= 3)) hints.push('本行危险');
        lines.push(`第${r}行 植物[${ps.join(' ') || '空'}] 僵尸[${zs.join(' ') || '无'}]｜射手×${lc.shooter} 坚果×${lc.wall} 弹簧豆×${lc.spring} 冰冻×${lc.freeze}${hints.length ? '｜' + hints.join('；') : ''}`);
      }
      return lines.join('\n') + '\n\nJSON 快照：\n' + JSON.stringify(compact, null, 0);
    }

    function parseDecision(text) {
      let t = String(text).trim();
      t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try { return JSON.parse(t); } catch { /* continue */ }
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
      throw new Error('no json');
    }

    function tauriInvoke() {
      const win = getWin();
      const fn = (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke)
        || (win.__TAURI_INTERNALS__ && win.__TAURI_INTERNALS__.invoke);
      return typeof fn === 'function' ? fn : null;
    }

    async function tauriInvokeFetch(invoke, url, options) {
      const headers = [];
      for (const k of Object.keys(options.headers || {})) headers.push([k, String(options.headers[k])]);
      const body = options.body ? Array.from(new TextEncoder().encode(String(options.body))) : null;
      const rid = await invoke('plugin:http|fetch', {
        clientConfig: {
          method: options.method || 'GET',
          url,
          headers,
          data: body,
          maxRedirections: 5,
          connectTimeout: 30000,
        },
      });
      const sent = await invoke('plugin:http|fetch_send', { rid });
      const chunks = [];
      let done = false;
      for (let i = 0; i < 10000 && !done; i++) {
        const raw = await invoke('plugin:http|fetch_read_body', { rid: sent.rid });
        const arr = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
        if (!arr.length) break;
        // 最后 1 字节是“结束”标记；官方 JS 实现会在此时丢弃该块并关闭流。
        if (arr[arr.length - 1] === 1) { done = true; break; }
        chunks.push(arr.subarray(0, arr.length - 1));
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      const text = new TextDecoder().decode(bytes);
      const outHeaders = new Headers();
      const rh = sent.headers || [];
      if (Array.isArray(rh)) {
        for (const pair of rh) if (Array.isArray(pair) && pair.length >= 2) outHeaders.append(pair[0], String(pair[1]));
      } else if (rh && typeof rh === 'object') {
        for (const k of Object.keys(rh)) outHeaders.append(k, String(rh[k]));
      }
      return new Response(text, { status: sent.status || 200, statusText: sent.statusText || '', headers: outHeaders });
    }

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时')), ms)),
      ]);
    }

    async function safeFetch(url, options) {
      const win = getWin();
      // 1) Tauri HTTP 插件（如果 withGlobalTauri 暴露了 http）
      try {
        const t = win.__TAURI__;
        const http = t && (t.http || (t.plugin && t.plugin.http));
        if (http && typeof http.fetch === 'function') {
          if (!tauriHttpLogged) {
            tauriHttpLogged = true;
            mlog('网络：使用 Tauri HTTP 插件');
          }
          return await http.fetch(url, options);
        }
      } catch (e) {
        if (!tauriHttpErrorLogged) {
          tauriHttpErrorLogged = true;
          mlog('Tauri HTTP 插件不可用：' + (e && e.message ? e.message : e), 'warn');
        }
      }
      // 2) 直接 invoke Rust 侧的 plugin:http|fetch（不经过 WebView，绕开 CSP）
      const invoke = tauriInvoke();
      if (invoke) {
        try {
          const res = await withTimeout(tauriInvokeFetch(invoke, url, options), 60000, 'Tauri HTTP');
          if (!tauriHttpLogged) {
            tauriHttpLogged = true;
            mlog('网络：使用 Tauri invoke HTTP（Rust 侧）');
          }
          return res;
        } catch (e) {
          if (!tauriHttpErrorLogged) {
            tauriHttpErrorLogged = true;
            mlog('Tauri invoke HTTP 不可用：' + (e && e.message ? e.message : e), 'warn');
          }
        }
      }
      // 3) 浏览器 fetch（受 CSP/CORS 限制）
      return (win !== window && typeof win.fetch === 'function')
        ? await win.fetch(url, options).catch(() => fetch(url, options))
        : await fetch(url, options);
    }

    async function chatCompletion(messages, opts = {}) {
      const url = normalizeBaseUrl(cfg.baseUrl) + '/chat/completions';
      const win = getWin();
      const AC = win.AbortController || AbortController;
      const controller = new AC();
      const timeout = setTimeout(() => controller.abort(), 60000);
      run.controller = controller;
      const isDeepSeek = /deepseek/i.test(cfg.baseUrl) || /deepseek/i.test(cfg.model);
      const body = {
        model: cfg.model,
        messages,
        temperature: 0.2,
        max_tokens: 800,
        stream: false,
      };
      if (isDeepSeek && run.thinkingMode !== false) body.thinking = { type: 'disabled' };
      let useTools = !!(opts.tools && run.toolsMode !== false);
      const applyMode = () => {
        delete body.tools;
        delete body.tool_choice;
        delete body.response_format;
        if (useTools) {
          body.tools = [PLAY_TOOL];
          body.tool_choice = { type: 'function', function: { name: 'play_actions' } };
        } else if (run.jsonMode !== false) {
          body.response_format = { type: 'json_object' };
        }
      };
      applyMode();
      const makeOptions = () => ({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(String(cfg.apiKey || '').trim() ? { 'Authorization': 'Bearer ' + String(cfg.apiKey).trim() } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      try {
        let res = await safeFetch(url, makeOptions());
        let raw = await res.text();
        for (let attempt = 0; attempt < 3 && !res.ok && res.status === 400; attempt++) {
          let changed = false;
          if (body.thinking && /thinking|reasoning/i.test(raw) && !/tool_choice/i.test(raw)) {
            run.thinkingMode = false;
            delete body.thinking;
            changed = true;
            mlog('模型不支持关闭思考，已重试', 'warn');
          } else if (useTools && /tool|tool_choice|thinking/i.test(raw)) {
            run.toolsMode = false;
            useTools = false;
            changed = true;
            mlog('模型不支持工具调用，已改用 json 模式重试', 'warn');
          } else if (body.response_format && /response_format|json_object/i.test(raw) && /not supported|unsupported|invalid|不支持/i.test(raw)) {
            run.jsonMode = false;
            changed = true;
            mlog('模型不支持 json 模式，已改用普通文本重试', 'warn');
          }
          if (!changed) break;
          applyMode();
          res = await safeFetch(url, makeOptions());
          raw = await res.text();
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${raw.slice(0, 300)}`);
        let json;
        try { json = JSON.parse(raw); } catch { throw new Error('API 返回不是 JSON：' + raw.slice(0, 200)); }
        if (json.usage && Number.isFinite(json.usage.total_tokens)) run.tokens += json.usage.total_tokens;
        const choice = json.choices && json.choices[0];
        const msg = choice && choice.message;
        const toolCall = msg && msg.tool_calls && msg.tool_calls[0];
        const toolArgs = toolCall && toolCall.function ? toolCall.function.arguments : null;
        const content = (msg && msg.content) || '';
        const reasoning = (msg && msg.reasoning_content) || '';
        if (!toolArgs && !content && !reasoning) throw new Error('API 返回为空');
        if (choice && choice.finish_reason === 'length') mlog('模型输出被长度截断，本回合可能失败', 'warn');
        return { content, reasoning, toolArgs, finish: choice && choice.finish_reason };
      } finally {
        clearTimeout(timeout);
      }
    }

    function normalizeDecision(parsed, s) {
      const raw = Array.isArray(parsed && parsed.actions) ? parsed.actions : (parsed && parsed.type ? [parsed] : []);
      const actions = [];
      const toInt = (v) => {
        const n = Number(v);
        return Number.isInteger(n) ? n : NaN;
      };
      const cardIndex = (v) => {
        const n = toInt(v);
        if (Number.isInteger(n)) return n;
        if (s && Array.isArray(s.cards)) {
          const found = s.cards.find((c) => c.type === v || c.name === v);
          if (found) return found.index;
        }
        return NaN;
      };
      for (const a of raw.slice(0, 4)) {
        if (!a || typeof a !== 'object') continue;
        let type = a.type;
        if (!type && (a.card != null || a.plant != null)) type = 'plant';
        if (type === 'plant') {
          const card = cardIndex(a.card != null ? a.card : a.plant);
          const lane = toInt(a.lane != null ? a.lane : (a.row != null ? a.row : a.laneIndex));
          const column = toInt(a.column != null ? a.column : (a.col != null ? a.col : a.columnIndex));
          actions.push({ type: 'plant', card, lane, column });
        } else if (type === 'shovel' || type === 'plant_food') {
          const lane = toInt(a.lane != null ? a.lane : (a.row != null ? a.row : a.laneIndex));
          const column = toInt(a.column != null ? a.column : (a.col != null ? a.col : a.columnIndex));
          actions.push({ type, lane, column });
        } else if (type === 'choose_deck') {
          const list = a.plants || a.deck;
          actions.push({ type: 'choose_deck', plants: Array.isArray(list) ? list.map(String).slice(0, 10) : [] });
        } else if (type === 'wait' || type === 'start_level' || type === 'collect_sun') {
          actions.push({ type });
        }
      }
      return {
        thought: parsed && typeof parsed.thought === 'string' ? parsed.thought.slice(0, 120) : '',
        actions,
      };
    }

    async function llmDecide(s) {
      if (!cfg.baseUrl || !cfg.model) throw new Error('请先填写 API Base URL 和模型名');
      if (!String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) throw new Error('请先填写 API Key');

      const baseMessages = [{ role: 'system', content: SYSTEM_PROMPT }];
      if (run.history.length) baseMessages.push(...run.history);
      baseMessages.push({ role: 'user', content: stateForPrompt(s) });

      let parsed = null;
      try {
        const r = await chatCompletion(baseMessages, { tools: true });
        const raw = r.toolArgs || r.content;
        if (raw) parsed = parseDecision(raw);
      } catch (e) {
        mlog('模型请求失败：' + (e && e.message ? e.message : e), 'warn');
      }

      if (!parsed) {
        const retryMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: stateForPrompt(s) + '\n\n请只输出一个 json 对象：{"thought":"...","actions":[{"type":"plant","card":0,"lane":2,"column":1}]}。不要解释，不要 markdown。' },
        ];
        try {
          const r2 = await chatCompletion(retryMessages, { tools: false });
          if (r2.content) parsed = parseDecision(r2.content);
        } catch (e) {
          mlog('模型重试失败：' + (e && e.message ? e.message : e), 'warn');
        }
      }

      if (!parsed) {
        mlog('模型连续输出无效，本回合改用本地策略', 'warn');
        return { thought: '模型输出无效，本地策略接管本回合', actions: localBrain(s).actions, fallback: true };
      }

      const decision = normalizeDecision(parsed, s);
      if (!decision.actions.length) decision.actions = [{ type: 'wait' }];
      run.history.push({ role: 'assistant', content: JSON.stringify(decision) });
      if (run.history.length > 4) run.history = run.history.slice(-4);
      return decision;
    }

    function executeActions(actions) {
      const results = [];
      for (const a of actions.slice(0, 6)) {
        if (!a || typeof a !== 'object') continue;
        let r = null;
        try {
          switch (a.type) {
            case 'plant': r = plant(Number(a.card), Number(a.lane), Number(a.column)); break;
            case 'shovel': r = shovel(Number(a.lane), Number(a.column)); break;
            case 'plant_food': r = plantFood(Number(a.lane), Number(a.column)); break;
            case 'collect_sun': r = collectSuns(); break;
            case 'choose_deck': r = autoDeckWith(a.plants); break;
            case 'start_level': r = startLevel(); break;
            case 'wait': r = { ok: true, detail: '等待' }; break;
            default: r = { ok: false, reason: '未知动作 ' + a.type };
          }
        } catch (e) { r = { ok: false, reason: String(e && e.message ? e.message : e) }; }
        results.push({ action: a, result: r });
      }
      return results;
    }

    // ───────────────────────── 主循环 ─────────────────────────

    function start() {
      if (run && run.active) return;
      if (!cfg.localBrain && !String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) {
        mlog('请先填写 API Key，或勾选“本地策略”体验', 'warn');
        toast('请先填写 API Key，或勾选本地策略', 'warning');
        setCollapsed(false);
        el.key && el.key.focus();
        return;
      }
      clearError();
      run = { active: true, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, startedAt: Date.now(), blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true };
      el.start && (el.start.disabled = true);
      el.stop && (el.stop.disabled = false);
      setCollapsed(true);
      mlog(`开始操控${cfg.localBrain ? '（本地策略）' : `（${cfg.model}）`}`);
      toast('AI 开始接管本场战斗', 'success');
      tick();
    }

    function stop(reason) {
      if (!run) return;
      run.active = false;
      if (run.timer) clearTimeout(run.timer);
      if (run.controller) { try { run.controller.abort(); } catch { /* ignore */ } }
      if (el.start) el.start.disabled = false;
      if (el.stop) el.stop.disabled = true;
      mlog(`已停止：${reason || '完成'}`, 'warn');
      updateStatus();
    }

    function schedule(ms) {
      if (!run || !run.active) return;
      if (run.timer) clearTimeout(run.timer);
      run.timer = setTimeout(tick, ms);
    }

    async function tick() {
      if (disposed || !run || !run.active) return;
      if (run.turns >= cfg.maxTurns) { stop(`达到最大回合数 ${cfg.maxTurns}`); return; }
      let stage = 'init';

      try {
        stage = 'snapshot';
        let s = safeSnapshot();
        if (!s.ok) { mlog(s.reason || '等待游戏', 'warn'); schedule(1800); return; }

        if (run.blocked && run.blocked.size) {
          const now = Date.now();
          for (const [k, until] of run.blocked) if (until <= now) run.blocked.delete(k);
        }

        stage = 'collect';
        if (cfg.autoSun) {
          const c = collectPickups();
          if (c.count) { mlog(`自动收取：${pickupLabel(c.kinds)}`, 'ok'); s = safeSnapshot(); }
        }

        if (s.phase === 'menu' || s.phase === 'worldmap' || s.phase === 'other' || s.phase === 'loading') {
          schedule(2200);
          return;
        }

        if (s.phase === 'won' || s.phase === 'lost') {
          stop(s.phase === 'won' ? '关卡胜利 🎉' : '关卡失败');
          toast(s.phase === 'won' ? 'AI 打赢了本关 🎉' : '本关失败', s.phase === 'won' ? 'success' : 'warning');
          return;
        }

        if (s.phase === 'preparing') {
          stage = 'prep';
          const ctxg = findComps();
          const pCards = ctxg && ctxg.map.Cards;
          const pLvl = ctxg && ctxg.map.levelController;
          if (!prepReady(pCards, pLvl)) {
            if (run.lastPrepReason !== '选卡界面还没准备好') {
              mlog('等待选卡界面就绪…', 'warn');
              run.lastPrepReason = '选卡界面还没准备好';
            }
            schedule(1200);
            return;
          }
          if (cfg.autoDeck) {
            const d = autoDeck();
            if (d.ok && d.detail) mlog(d.detail, 'ok');
            else if (d.reason && d.reason !== run.lastPrepReason) { mlog(d.reason, 'warn'); run.lastPrepReason = d.reason; }
            s = safeSnapshot();
          }
          if (s.phase === 'preparing') {
            if (cfg.autoDeck) {
              const st = startLevel();
              if (st.ok) mlog(st.detail, 'ok');
            } else {
              mlog('等待手动点“一起摇滚吧”，或勾选自动选卡开局', 'warn');
            }
            schedule(1400);
            return;
          }
        }

        const key = decisionKey(s);
        const now = Date.now();
        if (key === run.lastKey && now - run.lastAt < cfg.heartbeat) { schedule(500); return; }
        run.lastKey = key;
        run.lastAt = now;
        run.turns++;

        stage = 'decide';
        const decision = cfg.localBrain ? localBrain(s) : await llmDecide(s);
        if (!run.active) return;
        if (decision.thought) mlog(`🧠 ${decision.thought}`);
        stage = 'execute';
        const results = executeActions(decision.actions);
        for (const r of results) {
          if (r.action.type === 'wait') continue;
          if (r.result && r.result.ok) mlog(`✅ ${r.result.detail || r.action.type}`, 'ok');
          else mlog(`⚠️ ${r.action.type}: ${(r.result && r.result.reason) || '失败'}`, 'warn');
        }
        const resultLines = results
          .filter((r) => r.action.type !== 'wait')
          .map((r) => (r.result && r.result.ok
            ? `${r.action.type} ${r.result.detail || ''} 成功`
            : `${r.action.type} 失败：${(r.result && r.result.reason) || ''}`));
        run.lastResults = resultLines.slice(-3);
        updateStatus();
        schedule(cfg.interval);
      } catch (e) {
        if (disposed || !run || !run.active) return;
        const msg = e && e.message ? e.message : String(e);
        mlog(`运行错误[${stage}]：` + msg, 'err');
        if (run.lastToastError !== msg) {
          run.lastToastError = msg;
          toast('AI 错误：' + msg.slice(0, 80), 'error');
        }
        schedule(2600);
      }
    }

    // ───────────────────────── 状态 / 连接测试 ─────────────────────────

    function phaseText(phase) {
      return ({ menu: '主菜单', worldmap: '世界地图', loading: '加载中', preparing: '选卡/准备', running: '战斗中', won: '已胜利', lost: '已失败', other: '其他场景' })[phase] || phase;
    }

    function statusLine() {
      const s = safeSnapshot();
      if (!s.ok) return '待机 · ' + (s.reason || '等待游戏');
      const base = `${s.level.name || s.scene || '未知'} · ${phaseText(s.phase)} · 阳光${s.sun ?? '—'} · 植物${s.plants.length} · 僵尸${s.zombies.length}`;
      if (run && run.active) return `运行中 · ${base} · 回合${run.turns} · tokens${run.tokens}`;
      return '待机 · ' + base;
    }

    function updateStatus() {
      if (!el.status) return;
      const s = safeSnapshot();
      if (!s.ok) {
        el.status.innerHTML = `待机 · ${escapeHtml(s.reason || '等待游戏')}`;
        el.pill.classList.add('idle');
        el.pillText.textContent = 'AI 待机（F8）';
        return;
      }
      if (run && run.active) {
        const danger = s.zombies.filter((z) => z.column <= 3).length;
        el.status.innerHTML =
          `<b>${escapeHtml(s.level.name || s.scene || '未知关卡')}</b> · ${phaseText(s.phase)}<br>` +
          `阳光 <b>${s.sun ?? '—'}</b> · 能量豆 <b>${s.plantFood ?? 0}</b> · 波次 <b>${s.level.wave}/${s.level.waves || '?'}</b> · 植物 <b>${s.plants.length}</b> · 僵尸 <b>${s.zombies.length}</b>` +
          (danger ? ` · <span style="color:#ff9b9b">近场 ${danger}</span>` : '') +
          `<br><span class="hint">回合 ${run.turns} · tokens ${run.tokens}</span>`;
        el.pill.classList.remove('idle');
        el.pillText.textContent = `AI ${s.sun ?? '—'}☀ ⚡${s.plantFood ?? 0} · ${s.level.wave}/${s.level.waves || '?'}波`;
      } else {
        el.status.innerHTML =
          `待机 · <b>${escapeHtml(s.level.name || s.scene || '未知场景')}</b> · ${phaseText(s.phase)}<br>` +
          `阳光 <b>${s.sun ?? '—'}</b> · 能量豆 <b>${s.plantFood ?? 0}</b> · 植物 <b>${s.plants.length}</b> · 僵尸 <b>${s.zombies.length}</b>`;
        el.pill.classList.add('idle');
        el.pillText.textContent = 'AI 待机（F8）';
      }
    }

    async function testConnection() {
      if (run && run.active) return mlog('AI 正在运行，停止后再测试连接', 'warn');
      if (!cfg.baseUrl || !cfg.model) return mlog('请先填写 Base URL 和模型名', 'warn');
      if (!String(cfg.apiKey || '').trim() && !/localhost|127\.0\.0\.1/i.test(cfg.baseUrl)) return mlog('请先填写 API Key', 'warn');
      clearError();
      mlog(`测试连接：${normalizeBaseUrl(cfg.baseUrl)} / ${cfg.model}`);
      if (!run) run = { active: false, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true };
      try {
        const r = await chatCompletion([
          { role: 'system', content: '你是一个测试助手。请只输出一个 json 对象：{"ok":"OK"}。不要解释。' },
          { role: 'user', content: 'ping' },
        ]);
        const text = r.toolArgs || r.content || r.reasoning || '';
        clearError();
        mlog('连接成功：' + text.slice(0, 80), 'ok');
        toast('模型连接成功', 'success');
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        mlog('连接失败：' + msg, 'err');
        toast('连接失败：' + msg.slice(0, 70), 'error');
        if (/Failed to fetch|TypeError|CORS|CSP|Refused/i.test(msg)) {
          mlog('这通常是 CORS/CSP 或网络问题：可换 OpenRouter/中转 Base URL，或把这段日志发给我。', 'warn');
        }
        if (/401|403|Unauthorized|invalid.*key/i.test(msg)) {
          mlog('Key 可能无效或没有该模型权限；确认 Key 没有多余空格，并确认模型名。', 'warn');
        }
        if (/400|404|model/i.test(msg)) {
          mlog('模型名/路径可能不对：DeepSeek 试 deepseek-flash 或 deepseek-v4-pro，Base URL 用 https://api.deepseek.com/v1。', 'warn');
        }
      }
    }

    async function copyLog() {
      const text = logLines.length
        ? logLines.map((l) => `[${l.time}] ${l.message}`).join('\n')
        : '(暂无日志)';
      try {
        await getWin().navigator.clipboard.writeText(text);
        mlog('日志已复制到剪贴板', 'ok');
      } catch {
        try {
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          const a = getDoc().createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'pvz-ai-log.txt';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          mlog('日志已下载为 pvz-ai-log.txt', 'ok');
        } catch (e) {
          mlog('复制日志失败：' + (e && e.message ? e.message : e), 'err');
        }
      }
    }

    async function exportSnapshot() {
      const s = safeSnapshot();
      const text = JSON.stringify(s, null, 2);
      try {
        await getWin().navigator.clipboard.writeText(text);
        mlog('状态已复制到剪贴板', 'ok');
      } catch {
        try {
          const blob = new Blob([text], { type: 'application/json' });
          const a = getDoc().createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'pvz-ai-state.json';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          mlog('状态已下载为 pvz-ai-state.json', 'ok');
        } catch (e) { mlog('导出失败：' + e, 'err'); }
      }
      try { ctx.log.info('[AI草坪] snapshot ' + text); } catch { /* ignore */ }
    }

    // ───────────────────────── 官方面板（浮窗失败时的兜底） ─────────────────────────

    function defineOfficialPanel() {
      try {
        ctx.controls.definePanel({
          title: 'AI 草坪指挥官',
          description: '浮窗被遮挡时，可在这里填写设置并开始/停止。建议优先使用右下角浮窗。',
          groups: [
            {
              title: '模型',
              items: [
                { type: 'text', key: 'baseUrl', label: 'Base URL（含 /v1）', getValue: () => cfg.baseUrl, setValue: (v) => { cfg.baseUrl = String(v || ''); saveCfg(); } },
                { type: 'text', key: 'model', label: '模型名', getValue: () => cfg.model, setValue: (v) => { cfg.model = String(v || ''); saveCfg(); } },
                { type: 'text', key: 'apiKey', label: 'API Key', getValue: () => cfg.apiKey, setValue: (v) => { cfg.apiKey = String(v || ''); saveCfg(); } },
                { type: 'toggle', key: 'localBrain', label: '本地策略（不调用模型）', getValue: () => cfg.localBrain, setValue: (v) => { cfg.localBrain = !!v; saveCfg(); } },
              ],
            },
            {
              title: '操控',
              items: [
                { type: 'toggle', key: 'autoSun', label: '自动收阳光/能量豆', getValue: () => cfg.autoSun, setValue: (v) => { cfg.autoSun = !!v; saveCfg(); } },
                { type: 'toggle', key: 'autoDeck', label: '自动选卡开局', getValue: () => cfg.autoDeck, setValue: (v) => { cfg.autoDeck = !!v; saveCfg(); } },
                { type: 'action', key: 'start', label: '开始操控', onClick: () => start() },
                { type: 'action', key: 'stop', label: '停止', onClick: () => stop('手动停止') },
                { type: 'action', key: 'test', label: '测试连接', onClick: () => testConnection() },
                { type: 'readonly', key: 'status', label: '状态', getValue: () => statusLine() },
              ],
            },
          ],
        });
      } catch (e) {
        mlog('官方面板注册失败（不影响浮窗）：' + (e && e.message ? e.message : e), 'warn');
      }
    }

    // ───────────────────────── 生命周期 ─────────────────────────

    function onKeyDown(e) {
      if (e.key !== 'F8' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (run && run.active) stop('热键停止');
      else start();
    }

    function onCspViolation(e) {
      const detail = `${e.violatedDirective || e.effectiveDirective || ''} ${e.blockedURI || ''}`.trim();
      mlog('CSP 阻止：' + (detail || '未知资源'), 'err');
    }

    function boot() {
      if (disposed) return;
      const doc = getDoc();
      const win = getWin();
      if (!doc.body) { setTimeout(boot, 300); return; }
      buildUI();
      defineOfficialPanel();
      win.addEventListener('keydown', onKeyDown, true);
      doc.addEventListener('fullscreenchange', mountHost);
      doc.addEventListener('securitypolicyviolation', onCspViolation, true);
      if (win !== window) window.addEventListener('keydown', onKeyDown, true);
      if (!autoCollectTimer) {
        autoCollectTimer = setInterval(() => {
          if (disposed || !cfg.autoSun) return;
          const ctxg = findComps();
          if (!ctxg || !ctxg.map.SunCount) return;
          const c = collectPickups();
          if (!c.count) return;
          const hasFood = !!(c.kinds.plantFood || c.kinds.plantfood);
          if (hasFood || Date.now() - lastPickupLog > 8000) {
            mlog(`自动收取：${pickupLabel(c.kinds)}`, 'ok');
            lastPickupLog = Date.now();
          }
        }, 1100);
      }
      mlog(`AI 草坪指挥官 v${VERSION} 已加载（游戏 ${platformVersion}）`);
      try {
        const tauriKeys = win.__TAURI__ ? Object.keys(win.__TAURI__).join(',') : 'none';
        mlog(`环境：origin=${win.location ? win.location.origin : '?'} · tauri=${tauriKeys} · gpNext=${typeof win.gpNext}`);
        const metas = [...doc.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.getAttribute('http-equiv') || ''));
        if (metas.length) mlog('CSP meta：' + metas.map((m) => m.content).join(' | ').slice(0, 500), 'warn');
      } catch { /* ignore */ }
      if (!getCc()) mlog('等待 Cocos 引擎初始化…', 'warn');
      toast('AI 草坪指挥官已加载：填好 Key 后点浮窗“开始操控”，或按 F8', 'success');

      const ready = setInterval(() => {
        if (disposed) { clearInterval(ready); return; }
        const cc = getCc();
        if (cc && cc.director && cc.director.getScene()) {
          clearInterval(ready);
          mlog('已连接游戏引擎，等待进入关卡');
          updateStatus();
        }
      }, 1000);

      const api = {
        version: VERSION,
        platform: platformVersion,
        snapshot: safeSnapshot,
        collectSuns, collectPickups, plant, shovel, plantFood, autoDeck, autoDeckWith, startLevel, start, stop,
        knowledge: { plant: plantKb, zombie: zombieKb },
        normalizeDecision,
        testDecision: async (s) => {
          const prev = run;
          run = { active: false, turns: 0, tokens: 0, history: [], lastKey: '', lastAt: 0, timer: null, controller: null, blocked: new Map(), lastPrepReason: '', lastToastError: '', lastResults: [], jsonMode: true, toolsMode: true, thinkingMode: true };
          try { return await llmDecide(s || safeSnapshot()); } finally { run = prev; }
        },
        rules: SYSTEM_PROMPT,
        get config() { return cfg; },
        setLocalBrain(v) { cfg.localBrain = !!v; if (el.local) el.local.checked = !!v; saveCfg(); },
        log: mlog,
        ctx,
      };
      window.PvzAI = api;
      if (win !== window) { try { win.PvzAI = api; } catch { /* ignore */ } }
      try { console.log('%c[PvZ AI] v' + VERSION + ' 已注入，控制台可用 window.PvzAI', 'color:#7ed957'); } catch { /* ignore */ }
    }

    // 启动
    const bootDoc = getDoc();
    if (bootDoc.readyState === 'loading') bootDoc.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();

    return function cleanup() {
      disposed = true;
      stop('模组已停用');
      if (uiTimer) clearInterval(uiTimer);
      if (autoCollectTimer) clearInterval(autoCollectTimer);
      const win = getWin();
      win.removeEventListener('keydown', onKeyDown, true);
      if (win !== window) window.removeEventListener('keydown', onKeyDown, true);
      try { getDoc().removeEventListener('fullscreenchange', mountHost); } catch { /* ignore */ }
      try { getDoc().removeEventListener('securitypolicyviolation', onCspViolation, true); } catch { /* ignore */ }
      if (host) host.remove();
      host = null;
      try { ctx.controls.clear(); } catch { /* ignore */ }
      try { delete window.PvzAI; } catch { window.PvzAI = undefined; }
      try { if (win !== window) delete win.PvzAI; } catch { /* ignore */ }
    };
  },
};

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
