/**
 * 测试用最小假游戏：只实现 bridge 会读/调用的字段。
 * 不是游戏模拟器，只保证契约字段存在、动作返回真实 code。
 */

class SquareClass {
  constructor() {
    this.__classname__ = 'Square';
    this.cells = [];
  }
}
SquareClass.LaneCount = 5;
SquareClass.ColumnCount = 9;
SquareClass.SquareWidth = 80;
SquareClass.Square00 = { worldPosition: { x: 0, y: 0 } };
SquareClass.getLnC = function getLnC(lane, column) {
  return SquareClass._grid && SquareClass._grid[lane] && SquareClass._grid[lane][column] || null;
};
SquareClass.getLane = function getLane(lane) {
  return SquareClass._lanes && SquareClass._lanes[lane] || null;
};

function cell(lane, column) {
  const plants = [];
  const makePlant = (type) => {
    const p = {
      Plant_Type: type, health: 300, toughness: 300, isAlive: () => true,
      foodable: true, fooding: false, foodCalls: 0,
      food() { this.foodCalls += 1; this.fooding = true; },
    };
    // 点击类植物：给一个真实的触发方法，方便测 activate
    if (type === 'coconutcannon') {
      p.fireCalls = 0;
      p.fire = function fire(target) { this.fireCalls += 1; this.lastTarget = target || null; };
      // 真机上所有点击卡都实现了这个入口（不需要鼠标事件）
      p.activateCalls = 0;
      p.specialPlantOnMouseDown = function specialPlantOnMouseDown() { this.activateCalls += 1; return true; };
    }
    if (type === 'hollyknight') {
      p.activateCalls = 0;
      p.triggerCalls = 0;
      p.specialPlantOnMouseDown = function specialPlantOnMouseDown() { this.activateCalls += 1; return true; };
      p.trigger = function trigger(lnc) { this.triggerCalls += 1; this.lastTarget = lnc || null; };
    }
    return p;
  };
  return {
    lane, column, squareType: 0, plantInSquare: plants,
    putPlantAvailable: () => true,
    PlaceUIPlant() { plants.push(makePlant('peashooter')); },
    removePlant() { plants.length = 0; },
    addPlant(type) { const p = makePlant(type); plants.push(p); return p; },
  };
}

export function createFakeGame({ slots = 3, objective = false, asyncAddMs = 40, noBoard = false, task = null, zombies = null, conveyor = false, forcedDeck = false, preplant = false } = {}) {
  const grid = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) row.push(cell(r, c));
    grid.push(row);
  }
  SquareClass._grid = grid;
  SquareClass._lanes = Array.from({ length: 5 }, () => ({ zombiePool: () => [], hypnoZombiePool: () => [], mower: {} }));
  if (Array.isArray(zombies)) {
    for (const z of zombies) {
      const obj = {
        Zombie_Type: `RTID(${z.type}@ZombieProps)`,
        health: z.health,
        totalHealth: () => (z.total != null ? z.total : z.health),
        worldPositionX: (z.column || 0) * SquareClass.SquareWidth,
        isAlive: () => true,
      };
      if (z.armorHp != null) obj.armorHp = z.armorHp;
      SquareClass._lanes[z.lane].zombiePool = () => [obj];
    }
  }

  const available = ['sunflower', 'peashooter', 'wallnut', 'cherry_bomb'];
  const cards = {
    __classname__: 'Cards',
    CFs: [],
    maxSlotCount: slots,
    gameStarted: false,
    seedChooser: {
      CFs: available.map((type) => ({
        Type: type,
        SUNCOST: type === 'sunflower' || type === 'wallnut' ? 50 : type === 'peashooter' ? 100 : 150,
        ca: {},
      })),
    },
    cardsUIUpper: [],
    GameStartable() { return this.CFs.length >= this.maxSlotCount; },
    addCardByPlantTypeFromSeedbank(type) {
      // 关键：异步加卡，复现“只等到第一张就继续”的 bug
      setTimeout(() => {
        this.CFs.push({ Type: type, SUNCOST: 100, ID: type });
      }, asyncAddMs);
    },
    spliceAllCards() { this.CFs.length = 0; },
    removeCard() { this.CFs.pop(); },
  };
  if (conveyor) cards.conveyor = true;
  if (forcedDeck) {
    cards.CFs = available.slice(0, slots).map((type) => ({ Type: type, SUNCOST: 50, ID: type, ca: { locked: true } }));
    cards.seedChooser.CFs = [];
  }

  const levelController = {
    __classname__: 'levelController',
    gameStarted: false,
    lastStandPrepareStarted: !!preplant,
    currentWave: 0,
    NextWaveCountdown: 20,
    waveManagerProps: { WaveCount: 2 },
    currentLevelObjects: [
      { objclass: 'LevelDefinition', aliases: ['level'], objdata: { StageModule: 'RTID(FrontLawnStage@LawnProps)' } },
      { objclass: 'WaveManagerProperties', aliases: ['waves'], objdata: { WaveCount: 2, FlagWaveInterval: 2 } },
      { objclass: 'Wave1', aliases: ['Wave1'], objdata: { Zombies: [{ Type: 'RTID(tutorial@ZombieProps)', Row: 1 }] } },
      { objclass: 'Wave2', aliases: ['Wave2'], objdata: { Zombies: [{ Type: 'RTID(tutorial@ZombieProps)', Row: 2 }] } },
    ],
    letsRock() { this.gameStarted = true; cards.gameStarted = true; return true; },
    startReadySet() { this.gameStarted = true; cards.gameStarted = true; return true; },
  };

  const ui = { __classname__: 'UIInGame', paused: false, index: 0, tryChangingIndex(i) { this.index = i; } };
  const sun = { __classname__: 'SunCount', CurrentValue: 150 };
  const food = { __classname__: 'PlantFoodCount', plantFoodNum: 1, maxCount: 5, plantFoodDec() { this.plantFoodNum = Math.max(0, this.plantFoodNum - 1); } };

  const scene = {
    name: 'inGameScene',
    _components: (noBoard ? [] : [new SquareClass()]).concat([cards, levelController, ui, sun, food]),
    children: [],
  };

  // 暂停菜单组件：模组用它的 restart() 重开本关。
  const pauseScreen = {
    __classname__: 'PauseScreen',
    restarts: 0,
    restart() {
      this.restarts += 1;
      levelController.gameStarted = false;
      levelController.gameWon = false;
      levelController.gameLost = false;
      levelController.currentWave = 0;
      cards.gameStarted = false;
      cards.CFs.length = 0;
      sun.CurrentValue = 100;
      for (const row of grid) for (const c of row) c.plantInSquare.length = 0;
    },
  };
  scene._components.push(pauseScreen);
  if (objective) {
    scene._components.push({
      __classname__: 'LevelObjectiveScreen',
      screenName: { string: 'Level Objectives' },
      mission0: { string: 'Never have more than 18 plants' },
      node: { activeInHierarchy: true, active: true, children: [], _components: [] },
      faded: false,
      continue() { this.faded = true; this.node.activeInHierarchy = false; },
    });
  }
  if (task) {
    scene._components.push({
      __classname__: 'LevelTaskCount',
      tip: task.tip || '任务',
      count: { string: task.count || '' },
      mode: task.mode,
      completed: !!task.completed,
      failed: !!task.failed,
      startingObjdata: task.startingObjdata || {},
      objdata: task.objdata || {},
      ...task.extra,
    });
  }

  const assets = [
    {
      name: 'PlantFeatures',
      json: {
        PLANTS: [
          { CODENAME: 'sunflower', NAME: { zh: '向日葵', en: 'Sunflower' } },
          { CODENAME: 'peashooter', NAME: { zh: '豌豆射手', en: 'Peashooter' } },
          { CODENAME: 'wallnut', NAME: { zh: '坚果墙', en: 'Wall-nut' } },
          { CODENAME: 'cherry_bomb', NAME: { zh: '樱桃炸弹', en: 'Cherry Bomb' } },
          { CODENAME: 'spikeweed', NAME: { zh: '地刺', en: 'Spikeweed' } },
          { CODENAME: 'coconutcannon', NAME: { zh: '椰子加农炮', en: 'Coconut Cannon' } },
          { CODENAME: 'bonkchoy', NAME: { zh: '菜问', en: 'Bonk Choy' } },
          { CODENAME: 'hollyknight', NAME: { zh: '冬青骑士', en: 'Holly Knight' } },
          { CODENAME: 'cabbagepult', NAME: { zh: '卷心菜投手', en: 'Cabbage-pult' } },
        ],
      },
    },
    {
      name: 'ZombieFeatures',
      json: {
        ZOMBIES: [
          { CODENAME: 'tutorial', NAME: { zh: '普通僵尸', en: 'Basic Zombie' } },
          { CODENAME: 'dark_armor2', NAME: { zh: '铁桶农夫', en: 'Buckethead' } },
        ],
      },
    },
    {
      name: 'PlantProps',
      json: {
        objects: [
          { aliases: ['sunflower'], objdata: { SunCost: 50, Cooldown: 5, Toughness: 300, Family: 'Sun', ProduceInterval: 24, SunValue: 25 } },
          { aliases: ['peashooter'], objdata: { SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Peashooter', Damage: 20, AttackInterval: 1.5 } },
          { aliases: ['wallnut'], objdata: { SunCost: 50, Cooldown: 20, Toughness: 4000, Family: 'Defence' } },
          { aliases: ['cherry_bomb'], objdata: { SunCost: 150, Cooldown: 35, Toughness: 300, Family: 'Explosive' } },
          { aliases: ['spikeweed'], objdata: { SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Sharp', Damage: 10, AttackInterval: 0.5 } },
          { aliases: ['coconutcannon'], objdata: { SunCost: 400, Cooldown: 5, Toughness: 300, Family: 'Lobber', PeaType: 'coconut', PeaTypePlantfood: 'coconut_pf', RestTime: 15, AlwaysShoots: false } },
          { aliases: ['bonkchoy'], objdata: { SunCost: 150, Cooldown: 5, Toughness: 300, Family: 'Melee', Damage: 15, DamageHeavy: 30, DamagePlantfood: 60, PlantfoodHitCount: 25, AttackInterval: 0.3 } },
          { aliases: ['hollyknight'], objdata: { SunCost: 150, Cooldown: 15, Toughness: 2500, Family: 'Defence', AttackDamage: 20, AttackInterval: 1, MaxProjectileCount: 3 } },
          { aliases: ['cabbagepult'], objdata: { SunCost: 100, Cooldown: 5, Toughness: 300, Family: 'Lobber', ThrowInterval: 3, CabbageType: 'cabbage', CabbageTypePlantfood: 'cabbage_pf', PlantfoodProjectilesToFire: 6 } },
        ],
      },
    },
    {
      name: 'PlantAlmanac',
      json: {
        objects: [
          { aliases: ['sunflower'], objdata: { BriefIntroduction: { zh: '提供额外阳光' }, Introduction: { zh: '向日葵提供阳光' }, Special: [], Elements: [{ TYPE: 'RANGE', SORT: { zh: '直线' } }] } },
          { aliases: ['peashooter'], objdata: { BriefIntroduction: { zh: '发射豌豆' }, Introduction: { zh: '豌豆射手' }, Special: [], Elements: [{ TYPE: 'DAMAGE', VALUE: 20 }, { TYPE: 'RANGE', SORT: { zh: '直线' } }] } },
          { aliases: ['wallnut'], objdata: { BriefIntroduction: { zh: '阻挡僵尸' }, Introduction: { zh: '坚果墙' }, Special: [], Elements: [] } },
          { aliases: ['cherry_bomb'], objdata: { BriefIntroduction: { zh: '3x3 爆炸' }, Introduction: { zh: '樱桃炸弹' }, Special: [], Elements: [] } },
          {
            aliases: ['spikeweed'],
            objdata: {
              BriefIntroduction: { zh: '对走过的僵尸造成伤害' },
              Introduction: { zh: '地刺' },
              Special: [{ NAME: { zh: '特点' }, DESCRIPTION: { zh: '不会被僵尸啃食' } }],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 10 }, { TYPE: 'AREA', SORT: { zh: '本格' } }],
            },
          },
          {
            aliases: ['coconutcannon'],
            objdata: {
              BriefIntroduction: { zh: '点击发射一颗爆炸性椰子炮弹' },
              Introduction: { zh: '椰子加农炮沿着本行发射，炸裂时造成范围性伤害。' },
              Special: [{ NAME: { zh: '用途' }, DESCRIPTION: { zh: '点击发射' } }],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 900 }, { TYPE: 'AREA', SORT: { zh: '3x3 范围' } }],
            },
          },
          {
            aliases: ['bonkchoy'],
            objdata: {
              BriefIntroduction: { zh: '快速击打身前或身后的敌人' },
              Introduction: { zh: '菜问快速击打身前或身后的敌人。' },
              Special: [{ NAME: { zh: '特点' }, DESCRIPTION: { zh: '能击打身前和身后的敌人' } }],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 15 }, { TYPE: 'RANGE', SORT: { zh: '接近' } }],
            },
          },
          {
            aliases: ['hollyknight'],
            objdata: {
              BriefIntroduction: { zh: '伤害身边的僵尸，点击发射障碍' },
              Introduction: { zh: '冬青骑士对身边的僵尸造成伤害，还能发射三株带刺的障碍来击退并伤害僵尸。' },
              Special: [{ NAME: { zh: '用途' }, DESCRIPTION: { zh: '点击瞄准，再点击目标格子发射' } }],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 20 }],
            },
          },
          {
            aliases: ['cabbagepult'],
            objdata: {
              BriefIntroduction: { zh: '投掷卷心菜' },
              Introduction: { zh: '卷心菜投手把卷心菜抛向僵尸。' },
              Special: [],
              Elements: [{ TYPE: 'DAMAGE', VALUE: 40 }],
            },
          },
        ],
      },
    },
    {
      name: 'ZombieProps',
      json: {
        objects: [
          { aliases: ['tutorial'], objdata: { Toughness: 190, WalkSPS: 0.185, EatDPS: 100 } },
          { aliases: ['dark_armor2'], objdata: { Toughness: 190, StartingArmors: ['dark_bucket'], WalkSPS: 0.2, EatDPS: 100 } },
        ],
      },
    },
    {
      name: 'ZombieAlmanac',
      json: { objects: [{ aliases: ['tutorial'], objdata: { BriefIntroduction: { zh: '普通僵尸' }, Introduction: { zh: '普通僵尸' }, Special: [] } }] },
    },
    { name: 'ArmorProps', json: { objects: [{ aliases: ['dark_bucket'], objdata: { Toughness: 460, isMetal: true } }] } },
    { name: 'LawnProps', json: { objects: [{ aliases: ['FrontLawnStage'], objdata: { IsAtNight: false } }] } },
    { name: 'TombstoneProps', json: { objects: [] } },
  ];
  const assetManager = { assets: { forEach(fn) { assets.forEach(fn); } } };
  const cc = { director: { getScene: () => scene }, assetManager };
  const ctx = { unsafe: { engine: { getCc: () => cc } } };

  return { ctx, scene, cards, levelController, ui, sun, food, grid, available, SquareClass, pauseScreen };
}
