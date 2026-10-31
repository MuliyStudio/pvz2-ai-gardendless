import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsReader, resetAssetCache } from '../bridge/stats.js';
import { buildForecast, nextWaves } from '../bridge/forecast.js';
import { createLevelMemory } from '../bridge/level-memory.js';

function fakeCc(zombies = []) {
  const asset = (name, objects) => ({ name, json: { objects } });
  const list = [
    asset('PlantProps', []),
    asset('PlantAlmanac', []),
    asset('PlantTypes', []),
    asset('ZombieProps', zombies),
    asset('ZombieAlmanac', []),
    asset('ZombieTypes', []),
    asset('ArmorProps', []),
    asset('LawnProps', []),
  ];
  return { assetManager: { assets: new Map(list.map((a) => [a.name, a])) } };
}

const Z = (alias, extra = {}) => ({
  aliases: [alias],
  objclass: alias,
  objdata: { Toughness: 190, WalkSPS: 0.2, WavePointCost: 100, Weight: 1000, ...extra },
});

function levelJson({ waves, dynamic, stage = 'WestStage' }) {
  return {
    version: 1,
    objects: [
      { objclass: 'LevelDefinition', objdata: { LevelNumber: 13, StageModule: 'RTID(' + stage + '@LevelModules)', Modules: [] } },
      { objclass: 'WaveManagerProperties', aliases: ['WaveManagerProps'], objdata: { WaveCount: waves.length, FlagWaveInterval: 2, WaveSpendingPoints: 100, WaveSpendingPointIncrement: 50 } },
      { objclass: 'WaveManagerModuleProperties', aliases: ['NewWaves'], objdata: { WaveManagerProps: 'RTID(WaveManagerProps@CurrentLevel)', DynamicZombies: dynamic } },
      { objclass: 'SeedBankProperties', aliases: ['SeedBank'], objdata: { SelectionMethod: 'chooser', CardDecks: { Recommended: [{ Leader: 1, Name: { en: 'Preset A', zh: '预设A' }, Plants: ['sunflower', 'peashooter'] }] } } },
      ...waves.map((w, i) => ({
        objclass: 'SpawnZombiesJitteredWaveActionProps',
        aliases: ['Wave' + (i + 1)],
        objdata: { Zombies: w.map((z) => ({ Type: 'RTID(' + z.type + '@ZombieTypes)', ...(z.row ? { Row: z.row } : {}) })) },
      })),
    ],
  };
}

function fakeLvl(json, { difficulty = 3 } = {}) {
  const deep = JSON.parse(JSON.stringify(json));
  const lvl = {
    difficulty,
    Level: { name: 'west13', json },
    currentLevelObjects: deep.objects,
    waveManagerProps: { WaveCount: 3 },
  };
  // 引擎行为：动态规则在关卡初始化时把结果并进波次
  const rule = json.objects.find((o) => o.objclass === 'WaveManagerModuleProperties').objdata.DynamicZombies[difficulty];
  if (rule && rule.ZombiePool) {
    const w = lvl.currentLevelObjects.find((o) => (o.aliases || [])[0] === 'Wave3');
    w.objdata.Zombies.push({ Type: 'RTID(prospector@ZombieTypes)' });
  }
  return lvl;
}

test('levelScriptOf：解析静态波、动态规则、预设卡组与关卡资源名', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc([Z('cowboy'), Z('prospector', { WavePointCost: 200 })]));
  const json = levelJson({
    waves: [[{ type: 'cowboy', row: 1 }], [{ type: 'cowboy' }, { type: 'cowboy' }], [{ type: 'cowboy' }]],
    dynamic: [{}, {}, {}, { StartingWave: 2, StartingPoints: 100, PointIncrementPerWave: 0, ZombiePool: ['RTID(cowboy@ZombieTypes)', 'RTID(prospector@ZombieTypes)'] }],
  });
  const lvl = fakeLvl(json, { difficulty: 3 });
  const script = stats.levelScriptOf(lvl);
  assert.ok(script);
  assert.equal(script.assetName, 'west13');
  assert.equal(script.waveCount, 3);
  assert.equal(script.waves.length, 3);
  assert.equal(script.waves[0].zombies.cowboy, 1);
  assert.equal(script.waves[1].total, 2);
  // 第三波被动态规则追加了 1 只 prospector
  assert.equal(script.waves[2].zombies.prospector, 1);
  assert.equal(script.waves[2].dynamicExtra.prospector, 1);
  assert.equal(script.dynamic.active, true);
  assert.equal(script.dynamic.rule.startingWave, 2);
  assert.deepEqual(script.dynamic.rule.pool, ['cowboy', 'prospector']);
  assert.equal(script.seedBank.presets.length, 1);
  assert.equal(script.seedBank.presets[0].name, '预设A');
  assert.equal(script.waves[0].rowsHint[0].lane, 0);
});

test('forecast：已生成的动态波给出确切追加数量，并标出随机行/固定行', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc([Z('cowboy'), Z('prospector', { WavePointCost: 200 })]));
  const json = levelJson({
    waves: [[{ type: 'cowboy', row: 1 }], [{ type: 'cowboy' }, { type: 'cowboy' }], [{ type: 'cowboy' }]],
    dynamic: [{}, {}, {}, { StartingWave: 2, StartingPoints: 100, PointIncrementPerWave: 0, ZombiePool: ['RTID(cowboy@ZombieTypes)', 'RTID(prospector@ZombieTypes)'] }],
  });
  const lvl = fakeLvl(json, { difficulty: 3 });
  const script = stats.levelScriptOf(lvl);
  const fc = buildForecast(script, stats);
  assert.equal(fc.ok, true);
  assert.equal(fc.dynamic.mode, 'generated');
  assert.equal(fc.waves[0].zombies.cowboy.lanes[0], 0, 'Row:1 → lane 0');
  assert.equal(fc.waves[1].zombies.cowboy.lanes, null, '没写 Row = 随机行');
  assert.equal(fc.waves[2].zombies.prospector.dynamicCount, 1);
  assert.equal(fc.waves[2].dynamicCount, 1);
  assert.equal(fc.waves[1].flag, true, 'FlagWaveInterval=2 → 第2波是旗帜波');
  assert.ok(fc.totals.ehp > 0);
  const next = nextWaves(fc, 1, 2);
  assert.deepEqual(next.map((w) => w.wave), [1, 2]);
});

test('forecast：动态波还没生成时，用点数预算给出模拟期望（可复现）', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc([
    Z('cowboy', { WavePointCost: 100, Weight: 3000 }),
    Z('poncho', { WavePointCost: 200, Weight: 1000 }),
  ]));
  const json = levelJson({
    waves: [[{ type: 'cowboy' }], [{ type: 'cowboy' }], [{ type: 'cowboy' }]],
    dynamic: [{}, {}, {}, { StartingWave: 0, StartingPoints: 300, PointIncrementPerWave: 100, ZombiePool: ['RTID(cowboy@ZombieTypes)', 'RTID(poncho@ZombieTypes)'] }],
  });
  // 不模拟引擎追加：模拟"关卡还没生成"的情况
  const lvl = { difficulty: 3, Level: { name: 'west13', json }, currentLevelObjects: JSON.parse(JSON.stringify(json.objects)) };
  const script = stats.levelScriptOf(lvl);
  const a = buildForecast(script, stats);
  const b = buildForecast(script, stats);
  assert.equal(a.dynamic.mode, 'estimated');
  assert.equal(b.waves[0].estimate.pNone, a.waves[0].estimate.pNone, '同样的输入 → 同样的期望（可复现）');
  const est = a.waves[0].estimate.zombies;
  assert.ok(est.cowboy && est.cowboy.p > 0.5, '便宜且权重高的 cowboy 更常出现');
  assert.equal(a.dynamic.budgets[1], 300, '预算 = StartingPoints + increment×(wave-1-StartingWave)');
  assert.equal(a.dynamic.budgets[2], 1000, '旗帜波预算 ×2.5');
});

test('stats：报纸血量计入 EHP（不按本体血量误判）', () => {
  resetAssetCache();
  const stats = createStatsReader(() => fakeCc([Z('reporter', { NewspaperHealth: 300 })]));
  const st = stats.zombieStatsOf('reporter');
  assert.equal(st.hp, 190);
  assert.equal(st.newspaperHp, 300);
  assert.equal(st.ehp, 490, 'EHP = 本体 + 报纸');
  assert.ok(st.tags.includes('newspaper'), JSON.stringify(st.tags));
});

test('level-memory：按关卡归档、读回、写心得、限制条数', () => {
  const store = new Map();
  const prev = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  try {
    const mem = createLevelMemory();
    assert.equal(mem.persistent, true);
    const key = mem.keyOf({ level: { name: '狂野西部 13', source: { asset: 'cowboy13', world: 'west' } } });
    assert.equal(key, 'cowboy13');
    for (let i = 0; i < 7; i++) {
      mem.put(key, { result: i === 0 ? 'lost' : 'won', wave: i + 1, waveCount: 20, deck: ['sunflower'], facts: { plantsLost: i } });
    }
    const entry = mem.get(key);
    assert.equal(entry.runs.length, 5, '每关只留最近 5 条');
    assert.equal(entry.runs[0].wave, 7, '最新在前');
    mem.setNote(key, '这关用西瓜更稳');
    assert.equal(mem.get(key).note, '这关用西瓜更稳');
    mem.addLessons(key, ['第 3 波铁桶走第 2 行，提前在 c6 放坚果', '保护格前 c7 放短手']);
    mem.addLessons(key, ['第 3 波铁桶走第 2 行，提前在 c6 放坚果', '别在花后面两格放菜问']);
    const lessons = mem.get(key).lessons;
    assert.equal(lessons.length, 3, '经验去重');
    assert.deepEqual(lessons.slice(0, 2), ['第 3 波铁桶走第 2 行，提前在 c6 放坚果', '别在花后面两格放菜问'], '新一批经验在前，批内保序');
    assert.ok(lessons.includes('保护格前 c7 放短手'), '旧经验保留');
    assert.ok(mem.exportAll().includes('cowboy13'));
    assert.equal(mem.list().length, 1);
    // 只读回的 JSON 里也要有
    assert.ok(JSON.parse(store.get('pvzllm.levelMemory.v1')).levels.cowboy13);
  } finally {
    globalThis.window = prev;
  }
});
