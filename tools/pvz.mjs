// 用 CDP 直接驱动游戏内的 window.PvzLlm（新模组桥），给人工/Agent 调试用。
// 用法:
//   node tools/pvz.mjs state
//   node tools/pvz.mjs briefing
//   node tools/pvz.mjs events
//   node tools/pvz.mjs call <tool> '<jsonArgs>'
//   node tools/pvz.mjs eval '<js 表达式>'
import fs from 'node:fs';

const PORT = Number(process.env.PVZ_CDP_PORT || 9222);
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--out='));
const [cmd, ...rest] = argv;
if (!cmd) {
  console.error('usage: node tools/pvz.mjs <state|briefing|events|call|eval> [...]');
  process.exit(1);
}

async function page() {
  const pages = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => []);
  const list = (pages || []).filter((p) => p.type === 'page' && !/cloud\.html/i.test(p.url || ''));
  const hit = list.find((p) => /tauri\.localhost\/?$/i.test(p.url || '')) || list[0];
  if (!hit) throw new Error('没有找到游戏页面');
  return hit;
}

const p = await page();
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (!m.id || !pending.has(m.id)) return;
  const q = pending.get(m.id); pending.delete(m.id);
  m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = seq++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')); } }, 60000);
});

const snippets = {
  state: `(() => {
    const L = window.PvzLlm;
    if (!L) return { error: 'window.PvzLlm 不存在（模组没加载）' };
    const s = L.snapshot();
    const ui = document.querySelector('#pvzllm-panel [data-el="status"]');
    return {
      panelStatus: ui ? ui.textContent : null,
      version: L.version, phase: s.phase, scene: s.scene, paused: s.paused,
      sun: s.sun, plantFood: s.plantFood,
      wave: s.level && s.level.wave, waves: s.level && s.level.waves, nextWaveIn: s.level && s.level.nextWaveIn,
      world: s.level && s.level.world && s.level.world.name,
      objective: s.objective, tasks: (s.tasks || []).map((t) => ({ tip: t.tip, count: t.count, hint: t.hint })),
      missionHints: s.missionHints, plantLimit: s.plantLimit, limits: s.limits,
      deck: s.deck,
      seed: s.seedSelection ? { slots: s.seedSelection.slots, gameStartable: s.seedSelection.gameStartable, current: s.seedSelection.current } : null,
      cards: (s.cards || []).map((c) => ({ i: c.index, t: c.type, cost: c.cost, cd: Math.round((c.cd || 0) * 10) / 10, ready: c.ready })),
      plants: (s.plants || []).map((x) => x.lane + ':' + x.column + ' ' + x.type + (x.health != null ? ' hp' + Math.round(x.health) : '')),
      zombies: (s.zombies || []).map((z) => z.lane + ':' + z.column + ' ' + z.type + ' hp' + Math.round(z.hp || 0)),
      lanes: (s.lanes || []).map((l) => l.lane + ' z' + l.zombies + ' p' + l.plants + ' dps' + Math.round(l.dps) + (l.mower ? ' mower' : '')),
      carts: s.carts, mechanics: (s.mechanics || []).map((m) => m.text),
      plan: s.plan, changes: s.changesSinceLast,
    };
  })()`,
  briefing: `(() => {
    const L = window.PvzLlm;
    if (!L) return { error: 'window.PvzLlm 不存在（模组没加载）' };
    const b = L.briefing();
    return {
      version: b.version, phase: b.phase, level: b.level, objective: b.objective,
      missionHints: b.missionHints, plantLimit: b.plantLimit,
      constraints: (b.constraints || []).map((c) => c.text),
      deck: b.deck,
      cards: (b.cards || []).map((c) => ({ t: c.type, name: c.name, cost: c.cost, cd: c.cd, dmg: c.stats && c.stats.attack && c.stats.attack.dmg, sun: c.stats && c.stats.sun && c.stats.sun.perSecNight, hp: c.stats && c.stats.hp, family: c.stats && c.stats.family })),
      waves: (b.waves || []).map((w) => ({ n: w.n, total: w.total, ehp: w.ehp })),
      zombies: (b.zombies || []).map((z) => ({ t: z.type, name: z.name && z.name.zh, ehp: z.ehp, tags: z.tags })),
      terrain: b.terrain && { lanes: b.terrain.lanes, columns: b.terrain.columns, map: b.terrain.map, blocked: b.terrain.blockedCells },
      mechanics: (b.mechanics || []).map((m) => m.text), notes: b.notes, startingSun: b.startingSun,
    };
  })()`,
  tick: `(() => {
    const L = window.PvzLlm;
    if (!L) return { error: 'no bridge' };
    const s = L.snapshot();
    return {
      sun: s.sun, food: s.plantFood,
      wave: s.level && s.level.wave, waves: s.level && s.level.waves, next: s.level && s.level.nextWaveIn,
      phase: s.phase,
      plants: (s.plants || []).length,
      ready: (s.cards || []).filter((c) => c.ready).map((c) => c.type + '@' + c.cost),
      cds: (s.cards || []).filter((c) => !c.ready).map((c) => c.type + ' ' + Math.round((c.cd || 0) * 10) / 10 + 's'),
      zombies: (s.zombies || []).map((z) => z.lane + ':' + z.column + ' ' + z.type + ' ' + Math.round(z.hp || 0)),
      lanes: (s.lanes || []).map((l) => l.lane + ' z' + l.zombies + ' p' + l.plants + ' dps' + Math.round(l.dps) + (l.wallHp ? ' wall' + Math.round(l.wallHp) : '') + (l.mower ? ' mower' : ' MOWER-LOST')),
      changes: s.changesSinceLast,
      csp: null,
    };
  })()`,
  events: `(() => { const L = window.PvzLlm; return L ? L.pollEvents(60) : { error: 'no bridge' }; })()`,
};

let expression;
if (cmd === 'eval') {
  const raw = rest.join(' ');
  const code = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  expression = `(async () => { try { const v = await (${code}); return JSON.stringify({ ok: true, value: v }); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.stack) || e) }); } })()`;
} else if (cmd === 'call') {
  const tool = rest[0];
  const raw = rest[1] || '{}';
  const args = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  JSON.parse(args);
  expression = `(async () => {
    const L = window.PvzLlm;
    if (!L) return JSON.stringify({ ok: false, error: 'no bridge' });
    const t = ${JSON.stringify(tool)};
    const a = ${args};
    const map = {
      pvz_state: () => L.snapshot(), pvz_briefing: () => L.briefing(),
      pvz_knowledge: () => L.knowledge(a), pvz_events: () => L.pollEvents(a && a.limit || 100),
      pvz_set_plan: () => L.setPlan(a.plan), pvz_get_plan: () => L.getPlan(),
      pvz_choose_deck: () => L.chooseDeck(a.cards || [], a.replace !== false),
      pvz_start_level: () => L.startLevel(), pvz_dismiss_objective: () => L.dismissObjective(),
      pvz_act: async () => {
        const gap = Number(a.gap) || 0;
        const out = [];
        for (const x of (a.actions || []).slice(0, 6)) {
          if (gap && out.length) await new Promise((r) => setTimeout(r, gap));
          out.push(await L.act(x));
        }
        return out;
      },
      pvz_plant: () => L.act({ ...a, type: 'plant' }),
      pvz_shovel: () => L.act({ ...a, type: 'shovel' }),
      pvz_collect: () => L.collect(), pvz_resume: () => L.resume(),
      pvz_restart: () => L.restartLevel(),
      pvz_health: () => L.health(),
    };
    if (!map[t]) return JSON.stringify({ ok: false, code: 'UNKNOWN_TOOL', reason: '没有这个工具：' + t });
    return JSON.stringify({ ok: true, value: await map[t]() });
  })()`;
} else if (cmd === 'sleep') {
  await new Promise((r) => setTimeout(r, Number(rest[0]) || 1000));
  console.log('slept ' + (Number(rest[0]) || 1000) + 'ms');
  ws.close();
  process.exit(0);
} else {
  const body = snippets[cmd];
  if (!body) { console.error('未知命令：' + cmd); process.exit(1); }
  expression = `(() => { try { return JSON.stringify({ ok: true, value: ${body} }); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.stack) || e) }); } })()`;
}

const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) {
  console.error(JSON.stringify(r.exceptionDetails, null, 2));
  process.exit(1);
}
const out = r.result.value;
let text;
try {
  const parsed = JSON.parse(out);
  text = JSON.stringify(parsed.ok === false ? parsed : parsed.value, null, 2);
} catch {
  text = out;
}
const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
if (outArg) { fs.writeFileSync(outArg, text, 'utf8'); console.log('written ' + outArg); } else { console.log(text); }
ws.close();
process.exit(0);
