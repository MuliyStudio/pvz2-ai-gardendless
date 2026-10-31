/**
 * 僵尸 tag 规则表：所有机制标签只在这里定义一次。
 * 运行时 stats 和构建脚本 build-mechanics 共用，避免“这里补一个、那里补一个”。
 *
 * TAG_CAPABILITIES 是 tag → 能力需求（机制需要什么，不是“种哪张卡”）。
 * 卡组能力由 bridge/mechanics.js 从卡牌数值 + TAG_COUNTERS 的卡名事实推导，
 * 这样新增僵尸/植物只需要补规则或数据，不用改 snapshot/agent。
 */
export const TAG_RULES = [
  { tag: 'rolling', props: (d) => !!d.BarrelType, text: /滚桶|滚木|滚筒|barrel\s*roll|rolling/i },
  { tag: 'flying', props: (d) => !!d.FlyingSpeed, text: /飞行|空中|荡索|飞越|jetpack|balloon|seagull|pelican|swashbuckler/i },
  { tag: 'steal', props: (d) => !!d.ParrotCooldown || !!d.StealPlant, text: /偷|steal/i },
  { tag: 'crush', props: (d) => !!d.SmashDamage, text: /锤|砸|碾压|crush|smash/i },
  { tag: 'gargantuar', props: (d) => d.ZombieSort === 'Gargantuar', text: /巨人|gargantuar/i },
  { tag: 'armored', props: (d) => Array.isArray(d.StartingArmors) && d.StartingArmors.length > 0, text: /护甲|铁桶|头盔|armor|bucket|helmet/i },
  { tag: 'amphibious', props: (d) => !!d.LivesInDeepWater, text: /水|swim|amphibious/i },
  { tag: 'carries_imp', props: (d) => !!d.ImpType, text: /小鬼|imp/i },
  { tag: 'newspaper', props: (d) => !!d.NewspaperHealth, text: /报纸|杂志|周刊|newspaper/i },
  { tag: 'group', props: () => false, text: /组队|三名|成群|群体|group/i },
  { tag: 'lane_switch', props: () => false, text: /跳舞|换行|换道|钢琴|lane\s*switch|disco|piano/i },
  { tag: 'rush', props: (d) => !!d.SpeedUpWhenEatPlants, text: /加速|冲刺|rush/i },
  { tag: 'hypnotizable', props: (d) => !!d.HypnotizeByPlantFood, text: /魅惑|hypno/i },
  // 特殊机制：只声明“会发生什么/需要什么能力”，不写具体卡。
  { tag: 'polymorph', props: () => false, text: /变羊|变成羊|polymorph|sheep/i },
  { tag: 'pull_plant', props: () => false, text: /拉走植物|钩走|渔夫|fisherman|pull\s*plant/i },
  { tag: 'seal_plant', props: () => false, text: /封住植物|封植物|章鱼|octopus|seal\s*plant/i },
  { tag: 'jump_over', props: () => false, text: /跳越|跳过植物|jump\s*over|dodo|渡渡鸟/i },
  { tag: 'spawn_minion', props: () => false, text: /放出小怪|放小怪|召唤|黄鼠狼|weasel|spawn/i },
  { tag: 'bypass', props: () => false, text: /绕后|绕到后面|prospector|淘金者|underground/i },
  { tag: 'steal_sun', props: () => false, text: /偷阳光|偷走阳光|太阳神|ra\s*zombie|sun\s*steal/i },
];

/**
 * tag → 需要的能力 id。
 * 只描述机制需求：group 要能同时打多只、flying 要能对空、rolling 要能破滚动……
 * 具体哪张卡满足，由卡牌数值和 TAG_COUNTERS.plants 的事实共同决定。
 */
export const TAG_CAPABILITIES = {
  rolling: ['anti_rolling'],
  flying: ['anti_air'],
  carries_imp: ['anti_air', 'burst'],
  group: ['multi_target'],
  armored: ['high_dps', 'true_damage'],
  newspaper: ['burst', 'pierce'],
  crush: ['control', 'burst'],
  gargantuar: ['high_dps', 'control'],
  steal: ['protect_key'],
  lane_switch: ['multi_lane'],
  rush: ['control'],
  amphibious: ['amphibious'],
  hypnotizable: [],
  // 特殊机制：机制需要的能力，不写“种哪张卡”
  polymorph: ['burst'],
  pull_plant: ['protect_key'],
  seal_plant: ['protect_key', 'burst'],
  jump_over: ['anti_air'],
  spawn_minion: ['multi_target'],
  bypass: ['multi_lane'],
  steal_sun: ['protect_key'],
};

/** 一组 tag 需要的全部能力（去重、保序）。 */
export function capabilitiesOfTags(tags) {
  const out = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    for (const cap of TAG_CAPABILITIES[tag] || []) {
      if (!out.includes(cap)) out.push(cap);
    }
  }
  return out;
}

export function zombieTagsFrom(props, almanacText = '') {
  const d = props || {};
  const text = String(almanacText || '');
  const tags = [];
  for (const r of TAG_RULES) {
    let hit = false;
    try { hit = !!(r.props && r.props(d)); } catch { hit = false; }
    if (!hit && r.text) hit = r.text.test(text);
    if (hit) tags.push(r.tag);
  }
  return [...new Set(tags)];
}
