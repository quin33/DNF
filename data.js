// ============================================================
// 地下城与勇士 · 游戏数据（替换原修仙数据）
// 等级体系：Lv.1-19（首期）；Lv.10 后无需转职也可继续升级
// 字段说明：character_class=职业（鬼剑士/格斗家/神枪手/魔法师/圣职者）；classTitle=子职业；
//           strength/agility/intelligence/luck=力量/敏捷/智力/幸运
// 探险日志由 AI 根据队伍携带的装备道具生成（见 DNF60_PLAN.md）
// ============================================================
window.TAVERN_DATA = {
  user: { nickname: '阿拉德冒险家', username: 'qingli', id: 1, balance: 50000, balance_display: '5万金币', is_admin: false },

  tavern: {
    title_kicker: 'DNF60 · FIRST CHAPTER',
    title: '地下城与勇士',
    title_badge: 'S1',
    subtitle: '集结冒险小队，潜入地下城；从每一次探险中带回战利品、伤势与新的故事。',
    beta_notice: '本玩法处于抢先体验阶段。地下城探险剧情完全由 AI 实时生成，可能出现离谱的展开、不合理的判定甚至冒险家意外阵亡。\n\n请抱着「看戏」的心态游玩——AI 的脑洞你永远猜不到，遇到离谱的情况欢迎反馈，但别太生气。\n\n本玩法由 AI 驱动，请勿开小号。',
    level: 1,
    notice: '赫顿玛尔传送阵已开启：洛兰（Lv.1-3）、幽暗密林（Lv.4-6）可进入。达到 Lv.10 后可继续挑战更高阶地下城，经验无需转职即可累积升级。',
  },

  seats: [
    { id: 1, zone: 'bar', label: '吧台 1 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 2, zone: 'bar', label: '吧台 2 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 3, zone: 'bar', label: '吧台 3 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 4, zone: 'bar', label: '吧台 4 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 21, zone: 'bar', label: '吧台 5 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 22, zone: 'bar', label: '吧台 6 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 5, zone: 'table', table_label: '赛丽亚的圆桌', table_note: '正对柜台的第一张圆桌，老板娘偶尔来收空杯，顺便讲讲地下城的旧闻。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 6, zone: 'table', table_label: '赛丽亚的圆桌', table_note: '正对柜台的第一张圆桌，老板娘偶尔来收空杯，顺便讲讲地下城的旧闻。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 7, zone: 'table', table_label: '赛丽亚的圆桌', table_note: '正对柜台的第一张圆桌，老板娘偶尔来收空杯，顺便讲讲地下城的旧闻。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 8, zone: 'table', table_label: '赛丽亚的圆桌', table_note: '正对柜台的第一张圆桌，老板娘偶尔来收空杯，顺便讲讲地下城的旧闻。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 9, zone: 'table', table_label: '决斗者圆桌', table_note: '佣兵与格斗家爱坐这一桌，一言不合就比划两招，却没几个人真敢砸店。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 10, zone: 'table', table_label: '决斗者圆桌', table_note: '佣兵与格斗家爱坐这一桌，一言不合就比划两招，却没几个人真敢砸店。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 11, zone: 'table', table_label: '决斗者圆桌', table_note: '佣兵与格斗家爱坐这一桌，一言不合就比划两招，却没几个人真敢砸店。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 12, zone: 'table', table_label: '决斗者圆桌', table_note: '佣兵与格斗家爱坐这一桌，一言不合就比划两招，却没几个人真敢砸店。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 13, zone: 'table', table_label: '天空旅人圆桌', table_note: '天界来客、机械师与神枪手常把这里当修枪台，桌角永远擦不完机油。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 14, zone: 'table', table_label: '天空旅人圆桌', table_note: '天界来客、机械师与神枪手常把这里当修枪台，桌角永远擦不完机油。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 15, zone: 'table', table_label: '天空旅人圆桌', table_note: '天界来客、机械师与神枪手常把这里当修枪台，桌角永远擦不完机油。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 16, zone: 'table', table_label: '天空旅人圆桌', table_note: '天界来客、机械师与神枪手常把这里当修枪台，桌角永远擦不完机油。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 17, zone: 'table', table_label: '窗边秘闻圆桌', table_note: '靠月光窗边的位置，常有人压低声音交换地图、藏宝处与失踪同伴的消息。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 18, zone: 'table', table_label: '窗边秘闻圆桌', table_note: '靠月光窗边的位置，常有人压低声音交换地图、藏宝处与失踪同伴的消息。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 19, zone: 'table', table_label: '窗边秘闻圆桌', table_note: '靠月光窗边的位置，常有人压低声音交换地图、藏宝处与失踪同伴的消息。', adventurer: null, drink: null, food: null, chatter: null },
    { id: 20, zone: 'table', table_label: '窗边秘闻圆桌', table_note: '靠月光窗边的位置，常有人压低声音交换地图、藏宝处与失踪同伴的消息。', adventurer: null, drink: null, food: null, chatter: null },
  ],

  chat: [
    { nickname: '赛丽亚', title: '旅馆老板', content: '新来的冒险家？先去「我的」创建你的角色，职业选好，才能放心潜入地下城。', time: '2026-08-15T10:00:17Z' },
  ],

  adventurers: [],

  my_adventurer: null,

  my_feed: [],  // 最近动态：真实道具/金币流水（由 addFeed 写入并持久化）

  activity: {
    activity: {
      id: 1, name: '决斗大会', activity_type: 'narrative_tournament', current_stage: 3,
      description: '赫顿玛尔一年一度的决斗大会：以力量、技巧、韧劲三关定魁首，胜者可得公会秘藏。',
      gameplay: { display_name: '决斗台', rules_summary: '同等级冒险家登台决斗，装备药剂皆可用，由台上裁判裁决胜负。', table_rules: ['第一关·力量：正面较劲，见招拆招。', '第二关·技巧：登台切磋，装备药剂不限，败者出局。', '第三关·韧劲：限时挑战首领，扛过者为胜。'], ranking_rule: '三关累计积分，最高者为本届魁首。', asset_boundary: '决斗台筹码仅用于本场排序，非金币资产。' },
      rules: { group_size: 8, advance_count: 2, checkin_minutes: 60, poker_starting_stack: 1000, poker_small_blind: 10, poker_big_blind: 20, poker_blind_raise_every_hands: 6 }
    },
    stages: [ { stage_number: 3, match_count: 1 }, { stage_number: 2, match_count: 2 }, { stage_number: 1, match_count: 5 } ],
    final_ranking: [],
  },

  buildings: [
    { id: 1, code: 'pill_hall', name: '药剂馆', icon: '⚗️', category: '炼金', description: '配制与出售药剂：生命药水、魔力药剂、解毒剂。', status: 'built', upgrade_level: 1 },
    { id: 2, code: 'forge', name: '铁匠铺', icon: '🔥', category: '锻造', description: '锻造与强化装备，由铁匠宗师根据材料品质决定结果。', status: 'built', upgrade_level: 1 },
    { id: 3, code: 'herb_garden', name: '异植园', icon: '🌿', category: '采集', description: '种植草药，产出炼金与锻造材料。', status: 'built', upgrade_level: 1 },
    { id: 4, code: 'mine', name: '矿脉采掘场', icon: '⛏️', category: '采掘', description: '开采矿石与晶核的矿脉，设有 8 个采集位。', status: 'built', upgrade_level: 1 },
    { id: 5, code: 'training_strength', name: '训练场·力量', icon: '💪', category: '修炼', description: '锤炼体魄，增长力量。', status: 'built', upgrade_level: 1 },
    { id: 6, code: 'training_agility', name: '训练场·敏捷', icon: '🏃', category: '修炼', description: '身法训练、敏捷切磋，提升敏捷。', status: 'built', upgrade_level: 1 },
    { id: 7, code: 'training_intelligence', name: '技能导师馆', icon: '📖', category: '修炼', description: '典藏战斗技能，领悟后录入技能栏，装备即可施展。', status: 'built', upgrade_level: 1 },
    { id: 14, code: 'taixu_realm', name: '觉醒祭坛', icon: '◎', category: '修炼', description: '观想自身战技，依职业领悟新的战斗技能。', status: 'built', upgrade_level: 1 },
    { id: 8, code: 'tea_house', name: '月光酒馆', icon: '🍺', category: '休闲', description: '阿拉德冒险家围坐饮酒的圆桌大堂，入座休憩、点单闲聊。', status: 'built', upgrade_level: 1 },
    { id: 9, code: 'market', name: '交易行', icon: '🏪', category: '交易', description: '冒险家间自由交易物品，以物易物，成交各付手续费。', status: 'built', upgrade_level: 1 },
    { id: 10, code: 'auction', name: '拍卖行', icon: '🎭', category: '交易', description: '拍卖稀有装备与图纸，密封出价，到期最高者得。', status: 'built', upgrade_level: 1 },
    { id: 11, code: 'task_board', name: '公会任务板', icon: '📜', category: '任务', description: '张贴委托的公告栏，可接取任务获取金币报酬。', status: 'built', upgrade_level: 1 },
    { id: 12, code: 'dormitory', name: '冒险家旅馆', icon: '🛏️', category: '宿舍', description: '冒险家休息之所，恢复伤势与精力。', status: 'built', upgrade_level: 1 },
    { id: 13, code: 'clinic', name: '治疗所', icon: '⚕️', category: '治疗', description: '医师诊治伤患，付费快速恢复生命。', status: 'built', upgrade_level: 1 },
    { id: 18, code: 'seria_inn', name: '赛利亚旅馆', icon: '🏨', category: '治疗', description: '赛利亚经营的旅馆，付费入住后缓慢回复生命：每分钟恢复 2%，花费 10 金币。', status: 'built', upgrade_level: 1 },
    { id: 14, code: 'memorial', name: '英雄纪念碑', icon: '🪦', category: '纪念', description: '陨落冒险家的归宿，碑文刻其生前最后的叙事。', status: 'built', upgrade_level: 1 },
    { id: 15, code: 'gambling', name: '娱乐场', icon: '🎲', category: '休闲', description: '小赌怡情，押注今日战利，须有庄家当值方可开市。', status: 'built', upgrade_level: 1 },
    { id: 16, code: 'hidden_exchange', name: '战利品珍藏馆', icon: '🏛️', category: '收藏', description: '陈列地下城带回的珍奇；可按固定组合兑换隐藏副本门票。', status: 'built', upgrade_level: 1 },
    { id: 17, code: 'mailbox', name: '公会邮箱', icon: '📮', category: '通讯', description: '公会与冒险家送来的补给和福利，会不定期投递到这里。', status: 'built', upgrade_level: 1 },
    { id: 19, code: 'kanina_grocery', name: '卡妮娜的杂货铺', icon: '🧺', category: '交易', description: '卡妮娜的小铺子，出售恢复药剂以及普通、高级武器和防具。', status: 'built', upgrade_level: 1 },
  ],

  tavern_menu: {
    drinks: [
      { key: 'pale_ale', icon: '🍺', name: '清冽麦酒', price: 2, desc: '泡沫细腻的麦酒，入口清爽，最适合大战前压压惊。' },
      { key: 'dark_ale', icon: '🍻', name: '烈性黑啤', price: 5, desc: '深色烈啤，一口下去精神一震，佣兵们靠它赶走一夜疲惫。' },
      { key: 'holy_sparkling', icon: '✨', name: '圣光气泡水', price: 8, desc: '以净化泉水调出的气泡甜饮，圣职者也常点一杯清醒清醒。' },
      { key: 'goblin_wine', icon: '🍹', name: '哥布林果酿', price: 14, desc: '哥布林用林间野果偷偷酿的甜酒，甜得不像酒，后劲却不小。' },
      { key: 'moonlight_brandy', icon: '🥃', name: '月光白兰地', price: 26, desc: '装瓶后放在月光窗边静置，琥珀色的酒液会映出月牙的光。' },
      { key: 'dragon_breath', icon: '🔥', name: '龙息火酒', price: 60, desc: '据说只兑了一滴龙息，杯口飘着淡淡火光，喝前先写好遗书。' },
      { key: 'frost_brew', icon: '❄️', name: '霜语冰酿', price: 120, desc: '从极北寒地运来的冰酿，杯壁永远挂着一层细霜。' },
      { key: 'abyss_brew', icon: '🌌', name: '无底渊酿', price: 240, desc: '柜台最深处那坛黑酒，传说每一滴都映着深渊的星空。' },
    ],
    foods: [
      { key: 'seria_bread', icon: '🍞', name: '赛丽亚的烤面包', price: 4, desc: '刚出炉的蜂蜜烤面包，麦香混着焦糖，是月光酒馆最温柔的味道。' },
      { key: 'loaran_boar', icon: '🥩', name: '洛兰野猪肉排', price: 12, desc: '整块野猪肋排炭火烤到外焦里嫩，探险归来的冒险家必点。' },
      { key: 'dark_city_soup', icon: '🍲', name: '暗黑城蘑菇浓汤', price: 14, desc: '用暗黑城附近采回的蘑菇慢熬，奶香浓郁，暖胃又提神。' },
      { key: 'ghost_skewer', icon: '🍢', name: '幽灵猎人烤串', price: 16, desc: '抹了辛香料的烤肉串，撒上药草碎，神枪手们常拿来下酒。' },
      { key: 'sky_tower_pie', icon: '🥧', name: '天空之城云莓派', price: 22, desc: '用天空之城外围的云莓烤成，果酱酸甜，馅饼皮酥得掉渣。' },
      { key: 'hendon_beef', icon: '🍛', name: '赫顿玛尔牛扒饭', price: 24, desc: '厚切牛肉煎到七分熟，淋上浓郁酱汁，配满满一碗热饭。' },
      { key: 'mechanic_combo', icon: '⚙️', name: '机械师能量套餐', price: 36, desc: '黑啤配烤肉、炸薯与能量棒，据说加装了「备用能源」的套餐。' },
      { key: 'guild_feast', icon: '🍖', name: '公会勇士盛宴', price: 60, desc: '一整桌烤物、炖锅与面包篮，四人圆桌点一份刚好能吃到扶墙。' },
    ],
  },

  materials: ['魔兽皮革', '锰矿石', '无色晶核', '破旧的装备碎片', '结晶体', '秘银', '龙鳞碎片'],

  matchmaking: {
    available_dungeons: { items: [
      { name: '洛兰', level_desc: 'Lv.1-3', rank: 0 },
      { name: '幽暗密林', level_desc: 'Lv.4-6', rank: 1 },
      { name: '雷鸣废墟', level_desc: 'Lv.7-9', rank: 2 },
      { name: '格拉卡', level_desc: 'Lv.10-12', rank: 3 },
      { name: '天空之城·龙人之塔', level_desc: 'Lv.13-15', rank: 4 },
      { name: '天空之城·黑暗玄廊', level_desc: 'Lv.16-18', rank: 5 },
      { name: '天帷巨兽·神殿外围', level_desc: 'Lv.19', rank: 6 },
    ]},
    queue_summary: { dungeon_member_counts: {}, queued_member_count: 3, queued_count: 1, random_member_count: 2 },
  },

  parties: { parties: [] },

  logs: [],

  // npcs: 角落里的相遇卡片（暂全部隐藏；需要恢复时取消注释即可）
  // npcs: {
  //   tavern: { name: '赛丽亚', breed: '旅馆老板', intro: '赛丽亚在柜台后擦着杯子，怀里抱着半本《冒险家手册》。' },
  //   adventurers: { name: '阿甘左', breed: '狂战士', intro: '一位独臂剑士靠在长凳旁，警惕地扫视着你，眼神冰冷。' },
  //   activity: { name: '米娅', breed: '魔法师', intro: '绿眼睛的魔法师从窗台边探出头，两只圆耳轮流转动。' },
  //   building: { name: '铁匠', breed: '铁匠', intro: '铁匠蒲扇般的大手在图纸上量来量去，像是在监工。' },
  //   'my-adventurers': { name: '巴顿', breed: '神枪手', intro: '一个背枪的年轻人占了窗台一角，把玩着怀表。' },
  //   party: { name: '兰蒂', breed: '牧师', intro: '白袍的牧师从桌脚旁一闪而过，换到更远的位置才重新坐下。' },
  //   logs: { name: '雪伦', breed: '格斗家', intro: '一对拳套被她搁在日志堆旁，指节上的茧清晰可见。' },
  // },
  npcs: {},

  support_vote: { is_active: false, title: '', content: '', options: [] },
  special_dungeons: [],
};
