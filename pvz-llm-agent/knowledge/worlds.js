/**
 * 世界事实：只列"这个世界有什么机制"，不写"该怎么打"。
 * 运行时以 snapshot.mechanicFacts / levelScript / 实际地形为准。
 */

export const WORLD_FACTS = [
  {
    key: 'egypt', re: /埃及|egypt/i, name: '神秘埃及',
    mechanics: ['墓碑占格并阻挡直线弹道', '法老、太阳神、探险家等特殊僵尸'],
    zombies: ['mummy', 'mummy_armor1', 'mummy_armor2', 'explorer', 'tomb_raiser', 'pharaoh', 'egypt_gargantuar'],
  },
  {
    key: 'pirate', re: /海盗|pirate/i, name: '海盗港湾',
    mechanics: ['海面/木板地形：普通植物不能种在水面', '海鸥可飞越地面阻挡', '滚桶会碾压植物', '船长鹦鹉会偷走植物'],
    zombies: ['pirate', 'swashbuckler', 'seagull', 'barrelroller', 'pirate_captain', 'pirate_gargantuar'],
  },
  {
    key: 'west', re: /西部|牛仔|cowboy|west/i, name: '狂野西部',
    mechanics: ['矿车轨道：矿车可载植物上下移动', '钢琴会碾压并换行', '淘金者可跳到后排', '养鸡人释放鸡群'],
    zombies: ['cowboy', 'prospector', 'piano', 'poncho', 'chicken_farmer', 'west_bull', 'cowboy_gargantuar'],
  },
  {
    key: 'future', re: /未来|future/i, name: '遥远未来',
    mechanics: ['机甲护甲', '喷气背包可飞越', '迪斯科会换行', '部分僵尸带护盾'],
    zombies: ['future', 'jetpack', 'protector', 'mech_cone', 'football_mech', 'disco_mech', 'future_gargantuar'],
  },
  {
    key: 'dark', re: /黑暗|dark/i, name: '黑暗时代',
    mechanics: ['夜间关卡（无天空阳光）', '墓碑占格', '巫师可变羊', '小丑会反弹', '国王会给僵尸加护甲'],
    zombies: ['dark', 'dark_juggler', 'dark_wizard', 'dark_king', 'dark_gargantuar'],
  },
  {
    key: 'beach', re: /沙滩|海滩|beach/i, name: '巨浪沙滩',
    mechanics: ['潮汐会改变水线位置', '章鱼会封住植物', '渔夫会拉走植物', '冲浪/潜水僵尸'],
    zombies: ['beach', 'beach_snorkel', 'beach_surfer', 'beach_octopus', 'beach_fisherman', 'beach_gargantuar'],
  },
  {
    key: 'iceage', re: /冰河|冰川|iceage/i, name: '冰河世界',
    mechanics: ['冰块占格', '猎人投冰', '渡渡鸟可跳越', '黄鼠狼会放出小怪'],
    zombies: ['iceage', 'iceage_hunter', 'iceage_dodo', 'iceage_troglobite', 'iceage_weaselhoarder', 'iceage_gargantuar'],
  },
  {
    key: 'lostcity', re: /失落|古城|lostcity/i, name: '遗落古城',
    mechanics: ['金瓷砖', '濒危植物格', '飞行员会绕后', '挖掘者会挖走植物'],
    zombies: ['lostcity', 'lostcity_lostpilot', 'lostcity_excavator', 'lostcity_jane', 'lostcity_bug', 'lostcity_crystalskull', 'lostcity_gargantuar'],
  },
  {
    key: 'kongfu', re: /功夫|kongfu|kungfu/i, name: '功夫世界',
    mechanics: ['气功洞会推拉植物和僵尸', '武僧/方丈等特殊僵尸'],
    zombies: ['kongfu', 'monk', 'abbot'],
  },
  {
    key: 'jurassic', re: /侏罗纪|jurassic|dino/i, name: '侏罗纪沼泽',
    mechanics: ['恐龙会干扰阵型：剑龙击退、翼龙抓走、迅猛龙召唤等'],
    zombies: ['dino', 'dino_armor1', 'dino_armor2', 'dino_bully', 'dino_imp', 'dino_gargantuar'],
  },
  {
    key: 'sky', re: /天空|sky/i, name: '天空之城',
    mechanics: ['天空格：需要能种在空中的植物或花盆', '飞行僵尸'],
    zombies: ['sky', 'sky_flag', 'sky_imp', 'sky_twin', 'sky_gargantuar'],
  },
  {
    key: 'modern', re: /现代|modern/i, name: '现代年华',
    mechanics: ['多个时代的僵尸混编', '机制随关卡轮换'],
    zombies: [],
  },
];

export function worldFactOf(text) {
  const s = String(text || '');
  for (const w of WORLD_FACTS) if (w.re.test(s)) return w;
  return null;
}
