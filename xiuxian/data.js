// ============================================================
// 问道仙坊 · 修仙游戏数据（替换原深渊酒馆数据）
// 境界体系：练气一层～十层(Lv.1-10) / 筑基前中后(Lv.11-13) /
//           金丹前中后(Lv.14-16) / 元婴前中后(Lv.17-19)
// 字段说明：character_class=当前修为境界；title=称号；
//           strength/agility/intelligence/luck=体魄/身法/神识/气运
// 探险日志由 AI 根据队伍携带的装备道具生成（见 xiuxian/ai_log_prompt.md）
// ============================================================
window.TAVERN_DATA = {
  user: { nickname: '青璃真人', username: 'qingli', id: 1, balance: 50000, balance_display: '5万灵石', is_admin: false },

  tavern: {
    title_kicker: 'XIANXIA FRONTIER · SEASON I',
    title: '问道仙坊',
    title_badge: 'S1',
    subtitle: '招募同道，组队探索灵墟；从每一次探险中带回机缘、伤势与新的故事。',
    beta_notice: '本玩法处于抢先体验阶段。灵墟探险剧情完全由 AI 实时生成，可能出现离谱的展开、不合理的判定甚至修士意外陨落。\n\n请抱着「看戏」的心态游玩——AI 的脑洞你永远猜不到，遇到离谱的情况欢迎反馈，但别太生气。\n\n本玩法由 AI 驱动，请勿开小号。',
    level: 1,
    notice: '仙坊传送阵已开启：枯骨林（练气）、迷雾泽（炼气–筑基）可进入。突破至筑基后解锁更高阶灵墟。',
  },

  seats: [
    { id: 1, zone: 'bar', label: '吧台 1 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 2, zone: 'bar', label: '吧台 2 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 3, zone: 'bar', label: '吧台 3 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 4, zone: 'bar', label: '吧台 4 号', adventurer: null, drink: null, food: null, chatter: null },
    { id: 5, zone: 'table', table_label: '八仙桌 甲', adventurer: null, drink: null, food: null, chatter: null },
    { id: 6, zone: 'table', table_label: '八仙桌 甲', adventurer: null, drink: null, food: null, chatter: null },
    { id: 7, zone: 'table', table_label: '八仙桌 乙', adventurer: null, drink: null, food: null, chatter: null },
    { id: 8, zone: 'table', table_label: '八仙桌 乙', adventurer: null, drink: null, food: null, chatter: null },
  ],

  chat: [
    { nickname: '白芷', title: '药童', content: '新来的道友？先去「我的」创建你的角色，灵根选好，道途才稳。', time: '2026-08-15T10:00:17Z' },
  ],

  adventurers: [],

  my_adventurer: null,

  my_feed: [],  // 最近动态：真实道具/灵石流水（由 addFeed 写入并持久化）

  activity: {
    activity: {
      id: 1, name: '论道大会', activity_type: 'narrative_tournament', current_stage: 3,
      description: '仙坊百年一度的论道大会：以辩法、斗法、炼丹三关定魁首，胜者可得仙坊秘藏。',
      gameplay: { display_name: '斗法台', rules_summary: '同境界修士登台斗法，法器丹药皆可用，由台上长老裁决胜负。', table_rules: ['第一关·辩法：对答大道之问，神识胜者过关。', '第二关·斗法：登台切磋，法宝丹药不限，败者出局。', '第三关·炼丹：限时炼制指定丹药，丹成品质定高下。'], ranking_rule: '三关累计积分，最高者为本届魁首。', asset_boundary: '斗法台筹码仅用于本场排序，非灵石资产。' },
      rules: { group_size: 8, advance_count: 2, checkin_minutes: 60, poker_starting_stack: 1000, poker_small_blind: 10, poker_big_blind: 20, poker_blind_raise_every_hands: 6 }
    },
    stages: [ { stage_number: 3, match_count: 1 }, { stage_number: 2, match_count: 2 }, { stage_number: 1, match_count: 5 } ],
    final_ranking: [],
  },

  buildings: [
    { id: 1, code: 'pill_hall', name: '丹药阁', icon: '⚗️', category: '炼丹', description: '炼制与出售丹药：聚气丹、筑基丹、破境丹、续命丹。', status: 'built', upgrade_level: 1 },
    { id: 2, code: 'forge', name: '炼器坊', icon: '🔥', category: '炼器', description: '锻造与强化法器，由器道宗师根据材料品质决定结果。', status: 'built', upgrade_level: 1 },
    { id: 3, code: 'herb_garden', name: '灵植园', icon: '🌿', category: '灵植', description: '种植灵草灵药，产出炼丹材料。', status: 'built', upgrade_level: 1 },
    { id: 4, code: 'mine', name: '灵石矿场', icon: '⛏️', category: '灵植', description: '开采灵石与矿晶的矿脉，设有 8 个采集位。', status: 'built', upgrade_level: 1 },
    { id: 5, code: 'training_strength', name: '体修场', icon: '💪', category: '修炼', description: '锤炼体魄，增长气血。', status: 'built', upgrade_level: 1 },
    { id: 6, code: 'training_agility', name: '身法阁', icon: '🏃', category: '修炼', description: '遁法训练、身法切磋，提升敏捷。', status: 'built', upgrade_level: 1 },
    { id: 7, code: 'training_intelligence', name: '藏经阁', icon: '📖', category: '修炼', description: '典藏炼气期与筑基期功法术法，参悟后录入功法栏，装备即可施展。', status: 'built', upgrade_level: 1 },
    { id: 13, code: 'spirit_platform', name: '聚灵台', icon: '☯', category: '修炼', description: '闭关吐纳聚灵，积累修为；练气圆满后可于此冲击筑基。', status: 'built', upgrade_level: 1 },
    { id: 14, code: 'taixu_realm', name: '太虚幻境', icon: '◎', category: '修炼', description: '观想太虚万象，依自身道途参悟新的功法与术法。', status: 'built', upgrade_level: 1 },
    { id: 8, code: 'tea_house', name: '灵茶楼', icon: '🍵', category: '休闲', description: '品茗论道之所，入座后精力恢复提升。', status: 'built', upgrade_level: 1 },
    { id: 9, code: 'market', name: '坊市', icon: '🏪', category: '交易', description: '修士间自由交易物品，以物易物，成交各付手续费。', status: 'built', upgrade_level: 1 },
    { id: 10, code: 'auction', name: '拍卖行', icon: '🎭', category: '交易', description: '拍卖稀有法宝与丹方，密封出价，到期最高者得。', status: 'built', upgrade_level: 1 },
    { id: 11, code: 'task_board', name: '任务堂', icon: '📜', category: '任务', description: '张贴委托的公告栏，可接取任务获取灵石报酬。', status: 'built', upgrade_level: 1 },
    { id: 12, code: 'dormitory', name: '洞府宿舍', icon: '🛏️', category: '宿舍', description: '修士休息之所，恢复伤势与精力。', status: 'built', upgrade_level: 1 },
    { id: 13, code: 'clinic', name: '疗伤阁', icon: '⚕️', category: '治疗', description: '医师诊治伤患，付费快速恢复气血。', status: 'built', upgrade_level: 1 },
    { id: 14, code: 'memorial', name: '问心台', icon: '🪦', category: '纪念', description: '陨落修士的归宿，碑文刻其生前最后的叙事。', status: 'built', upgrade_level: 1 },
    { id: 15, code: 'gambling', name: '灵签阁', icon: '🎲', category: '休闲', description: '求签问卜，押注今日机缘，须有签师当值方可开市。', status: 'built', upgrade_level: 1 },
    { id: 16, code: 'hidden_exchange', name: '秘境收藏馆', icon: '🏛️', category: '收藏', description: '陈列灵墟带回的珍奇；可按固定组合兑换隐藏秘境门票。', status: 'built', upgrade_level: 1 },
    { id: 17, code: 'mailbox', name: '传讯邮箱', icon: '📮', category: '通讯', description: '坊市与宗门寄来的补给和福利，会不定期投递到这里。', status: 'built', upgrade_level: 1 },
  ],

  drinks: [
    { key: 'spirit_tea', icon: '🍵', name: '云雾灵茶', price: 2, desc: '茶汤澄澈，灵气自杯沿袅袅而起，涤尽凡尘。' },
    { key: 'spirit_wine', icon: '🍶', name: '三蒸灵酿', price: 5, desc: '入口绵柔，丹田却似点燃了一簇火。' },
    { key: 'dew', icon: '🍃', name: '灵露', price: 8, desc: '一滴入喉，神识清明如被晨露洗过。' },
    { key: 'amber', icon: '🍷', name: '百年陈酿', price: 100, desc: '入口如剑，一线辛辣直抵喉间，元婴亦要晃上一晃。' },
    { key: 'dragon_fire', icon: '🔥', name: '龙息火酒', price: 250, desc: '传说兑了一滴龙息，喝前请先写好遗书。' },
    { key: 'frost', icon: '❄️', name: '霜语冰酿', price: 300, desc: '极北寒潭冰酿，杯壁永远挂着一层细霜。' },
    { key: 'abyss', icon: '🌌', name: '无底渊酿', price: 500, desc: '酒保从柜台最深处取出的黑酒，传说每一滴都映着幽冥星空。' },
  ],

  materials: ['灵草', '妖兽内丹', '矿晶', '阵法残片', '上古遗物', '星图残片', '剑灵碎片'],

  matchmaking: {
    available_dungeons: { items: [
      { name: '枯骨林', level_desc: '练气', rank: 0 },
      { name: '迷雾泽', level_desc: '练气–筑基', rank: 1 },
      { name: '赤炎谷', level_desc: '筑基', rank: 2 },
      { name: '万剑冢', level_desc: '筑基–金丹', rank: 3 },
      { name: '幽冥渊', level_desc: '金丹', rank: 4 },
      { name: '雷音山', level_desc: '金丹–元婴', rank: 5 },
      { name: '落仙台', level_desc: '元婴+', rank: 6 },
    ]},
    queue_summary: { dungeon_member_counts: {}, queued_member_count: 3, queued_count: 1, random_member_count: 2 },
  },

  parties: { parties: [] },

  logs: [],

  // npcs: 角落里的相遇卡片（暂全部隐藏；需要恢复时取消注释即可）
  // npcs: {
  //   tavern: { name: '白芷', breed: '药童', intro: '药童白芷在柜台后打盹，怀里抱着半本《百草经》。' },
  //   adventurers: { name: '灯芯', breed: '灵猫', intro: '一只三花灵猫从长凳后闪过，谨慎地观察着你，尾巴轻摆。' },
  //   activity: { name: '金渐层', breed: '灵猫', intro: '金绿圆眼从狭窄缝隙里打量四周，两只圆耳轮流转动。' },
  //   building: { name: '卡比', breed: '灵猫', intro: '金渐层灵猫不声不响蹲在建筑图纸上，像是在监工。' },
  //   'my-adventurers': { name: '墨痕', breed: '灵猫', intro: '黑色孟买猫占据了窗台一角，尾巴整齐地盘在爪边。' },
  //   party: { name: '麦穗', breed: '灵猫', intro: '橘色灵猫从桌脚旁一闪而过，换到更远的位置才重新伏下。' },
  //   logs: { name: '小雪', breed: '灵猫', intro: '白色灵猫趴在日志堆上，尾巴轻轻扫过墨迹未干的纸页。' },
  // },
  npcs: {},

  support_vote: { is_active: false, title: '', content: '', options: [] },
  special_dungeons: [],
};
