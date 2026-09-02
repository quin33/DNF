/* ============================================================
   ai-companions.js · AI 队友固定预设名片
   前后端共用：server.js/db.js 负责持久化与后台编辑，
   浏览器端由 index.html 加载后用于单机模式与详情展示。
   字段与玩家角色卡片保持一致（name/title/character_class/
   strength/agility/intelligence/luck/skills/equipment/bag/...），
   并额外提供 biography（bio）。
   —— DNF60：12 张职业预设冒险家卡（物理技/魔法技 + 四档稀有度）。
   ============================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AI_COMPANION_CARDS = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ITEM_LIBRARY = {
    short_sword: { key: 'short_sword', name: '短剑', kind: 'weapon', desc: '一柄制式短剑，剑刃缺口处还泛着微光。' },
    cloth_vest: { key: 'cloth_vest', name: '布甲', kind: 'armor', desc: '粗布缝制的轻型护甲，洗得发白，却异常结实。' },
    hp_potion: { key: 'hp_potion', name: '生命药水', kind: 'pill', qty: 3, desc: '淡红色的恢复药剂，饮下能愈合伤口。' },
    mp_potion: { key: 'mp_potion', name: '魔力药剂', kind: 'pill', qty: 3, desc: '蔚蓝色的魔力药剂，饮下精神一振。' },
    torch: { key: 'torch', name: '火把', kind: 'tool', desc: '浸过松脂的火把，能照亮地下城最黑的角落。' },
    compass: { key: 'compass', name: '旧怀表', kind: 'tool', desc: '指针总是固执地指向遗迹深处。' },
    satchel: { key: 'satchel', name: '皮质背包', kind: 'tool', desc: '冒险家背惯的旧皮囊，能装不少杂物。' },
    first_aid: { key: 'first_aid', name: '绷带', kind: 'tool', desc: '卷干净的绷带，缠上伤口能少流不少血。' },
    holy_talisman: { key: 'holy_talisman', name: '圣光符', kind: 'talisman', desc: '圣职者加持过的符纸，掷出即爆出一团圣光。' },
    treasure_map: { key: 'treasure_map', name: '寻宝图', kind: 'tool', desc: '半张泛黄的藏宝图，标注着一处古老遗迹的入口。' },
  };

  function item(key) {
    const source = ITEM_LIBRARY[key];
    if (!source) return null;
    const { key: _key, ...rest } = source;
    return { ...rest };
  }

  const skills = {
    liguijian: { name: '里鬼剑术', type: '物理技', elem: '', desc: '基础剑法，横斩斜挑一气呵成，收势之间暗藏杀机。' },
    sanduanzhan: { name: '三段斩', type: '物理技', elem: '', desc: '收剑、送肩、连斩三击，借势前突，地下城起手最稳的一招。' },
    guizhan: { name: '鬼斩', type: '物理技', elem: '', desc: '凝怨气于兵刃，一刀劈下，鬼影森森。' },
    yueguangzhan: { name: '月光斩', type: '物理技', elem: '', desc: '剑光如一弯月牙横掠，清冷而致命。' },
    bengquan: { name: '崩拳', type: '物理技', elem: '', desc: '蓄力一击，拳出如崩山，将面前敌人打得踉跄后退。' },
    beishuai: { name: '背摔', type: '物理技', elem: '', desc: '贴身擒抱，借力把敌人掼向地面，土石四溅。' },
    tieshankao: { name: '铁山靠', type: '物理技', elem: '', desc: '以肩为锋，沉身撞出，把人连盾带人轰开半丈。' },
    jialin: { name: '加特林扫射', type: '物理技', elem: '', desc: '架起重型枪械一顿扫射，弹雨压得敌人抬不起头。' },
    yindan: { name: '银弹', type: '魔法技', elem: '', desc: '给弹头附上圣光，破邪驱魔，击中要害时格外疼痛。' },
    futan: { name: '浮空弹', type: '物理技', elem: '', desc: '一发挑射把敌人抬离地面，为后续连击留出空档。' },
    moli: { name: '魔力弹', type: '魔法技', elem: '', desc: '指尖凝出一颗刺目的魔力弹，折线扑向敌人。' },
    huoqiu: { name: '火球术', type: '魔法技', elem: '', desc: '聚一团赤焰火球掷出，落地爆开，灼浪翻涌。' },
    bingxue: { name: '冰霜雪人', type: '魔法技', elem: '', desc: '召出一只圆滚滚的冰霜雪人扑向敌人，撞碎时寒气四溢。' },
    shengguang: { name: '圣光十字', type: '物理技', elem: '', desc: '以十字架划出一道圣光，正面镇压扑来的魔物。' },
    zhiyu: { name: '治愈术', type: '魔法技', elem: '', desc: '引导圣光疗愈伤势，让人在恶战中喘一口气。' },
    luolei: { name: '落雷符', type: '魔法技', elem: '', desc: '掷出一道符纸召来落雷，噼啪一声焦了敌手。' },
  };

  const cards = [
    {
      key: 'mo_chen', name: '墨尘', title: '鬼剑士·剑魂', title_frame: 'fate_companion', gender: '男',
      level: 3, exp: 120, character_class: '鬼剑士', hp: 160, max_hp: 160, stamina: 110, max_stamina: 110,
      strength: 17, agility: 15, intelligence: 13, luck: 12, gold: 80,
      personality: '高傲',
      skills: [skills.liguijian, skills.sanduanzhan, skills.yueguangzhan], skillPool: [],
      equipment: [item('short_sword')], bag: [item('satchel'), item('hp_potion')],
      bio: '墨尘出身矿脉边的小村，幼时从矿洞深处拾得半截残剑，自此夜夜有剑鸣入梦。十六岁那年他在崖上练剑，剑光引动天边金气，被路过的剑魂收为师弟。他寡言少语，只认剑理不认人情，认定同队冒险家只要握得住剑，便值得托付后背。',
    },
    {
      key: 'liu_yan', name: '柳烟', title: '圣职者·蓝拳', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 90, character_class: '圣职者', hp: 130, max_hp: 130, stamina: 100, max_stamina: 100,
      strength: 8, agility: 17, intelligence: 15, luck: 13, gold: 140,
      personality: '明哲',
      skills: [skills.shengguang, skills.zhiyu], skillPool: [],
      equipment: [], bag: [item('holy_talisman'), item('torch')],
      bio: '柳烟是教会收养的孤女，跟着老执事在城郊义诊十年，识得百草，也练出一身踏烟无痕的轻身功夫。她性子安静，凡事习惯先退半步看清楚利害，危急时却总能把最要紧的人稳稳捞回来。',
    },
    {
      key: 'gu_changfeng', name: '顾长风', title: '鬼剑士·狂战士', title_frame: 'fate', gender: '男',
      level: 3, exp: 180, character_class: '鬼剑士', hp: 150, max_hp: 150, stamina: 100, max_stamina: 100,
      strength: 16, agility: 14, intelligence: 10, luck: 11, gold: 60,
      personality: '莽撞',
      skills: [skills.liguijian, skills.guizhan], skillPool: [],
      equipment: [], bag: [item('holy_talisman'), item('satchel')],
      bio: '顾长风是佣兵团长家的少东，押镖时被劫匪逼入火窟，却在烈焰里悟出一丝狂气。他嘴上总说“莽就完事”，行动前却会把退路、后手都盘算一遍。长刀一横，火光亮起时，他永远是冲在最前的那一个。',
    },
    {
      key: 'su_yan', name: '苏砚', title: '魔法师·魔道学者', title_frame: 'developer', gender: '男',
      level: 2, exp: 80, character_class: '魔法师', hp: 140, max_hp: 140, stamina: 100, max_stamina: 100,
      strength: 12, agility: 9, intelligence: 16, luck: 14, gold: 200,
      personality: '好奇',
      skills: [skills.moli, skills.huoqiu, skills.bingxue], skillPool: [],
      equipment: [item('cloth_vest')], bag: [item('compass'), item('treasure_map')],
      bio: '苏砚原是一名落第书生，为寻古卷误入地下遗迹，被厚重的魔力气息灌体，捡回半部残破法术书。他随身带一本注满批注的札记，每进一座地下城都要抄回一页碑文。队伍里没人比他更擅长读懂残阵与旧地图。',
    },
    {
      key: 'chu_jinghong', name: '楚惊鸿', title: '格斗家·散打', title_frame: 'fate_companion', gender: '女',
      level: 4, exp: 260, character_class: '格斗家', hp: 145, max_hp: 145, stamina: 110, max_stamina: 110,
      strength: 18, agility: 16, intelligence: 11, luck: 10, gold: 50,
      personality: '孤僻',
      skills: [skills.bengquan, skills.beishuai, skills.tieshankao], skillPool: [],
      equipment: [item('short_sword')], bag: [item('hp_potion'), item('torch')],
      bio: '楚惊鸿曾是武馆杂役，因一次偷看馆主练拳被逐出门墙。她没有门派，只凭一对硬拳在地下城边缘讨生活，练出快而无声的拳法。她不爱与人同行，但一旦应下同行，便会在夜色里替全队守完最后一班岗。',
    },
    {
      key: 'jiang_xue', name: '姜雪', title: '圣职者·圣骑士', title_frame: 'fate', gender: '女',
      level: 2, exp: 70, character_class: '圣职者', hp: 125, max_hp: 125, stamina: 100, max_stamina: 100,
      strength: 9, agility: 12, intelligence: 15, luck: 15, gold: 160,
      personality: '重诺',
      skills: [skills.shengguang, skills.zhiyu], skillPool: [skills.luolei],
      equipment: [], bag: [item('satchel'), item('cloth_vest')],
      bio: '姜雪是猎户之女，娘亲病故前教她认药，也教她“答应人的事，拼死也要做到”。她背着药篓行走山林，能一眼认出毒草与药草。她把每位队友都当作欠过恩情的病人照顾，谁受了伤，她比谁都在意。',
    },
    {
      key: 'lu_li', name: '陆离', title: '神枪手·漫游枪手', title_frame: 'developer', gender: '男',
      level: 3, exp: 150, character_class: '神枪手', hp: 135, max_hp: 135, stamina: 105, max_stamina: 105,
      strength: 13, agility: 10, intelligence: 17, luck: 9, gold: 90,
      personality: '狡诈',
      skills: [skills.futan, skills.jialin], skillPool: [],
      equipment: [item('cloth_vest')], bag: [item('compass'), item('satchel')],
      bio: '陆离自称自由冒险家，实则做过走私、押货、替人破阵的营生，身上每一件装备都来得不太干净。他能从墙缝里看出暗门，从地形里嗅出机关。他说话总是半真半假，但到了分赃的时候，又意外地从不食言。',
    },
    {
      key: 'yan_wujiu', name: '晏无咎', title: '格斗家·柔道家', title_frame: 'fate', gender: '男',
      level: 4, exp: 240, character_class: '格斗家', hp: 150, max_hp: 150, stamina: 110, max_stamina: 110,
      strength: 14, agility: 18, intelligence: 12, luck: 13, gold: 40,
      personality: '仗义',
      skills: [skills.bengquan, skills.beishuai], skillPool: [],
      equipment: [], bag: [item('holy_talisman'), item('satchel')],
      bio: '晏无咎是佣兵营里的义子，名字取自“行无咎”，意思是一生不做亏心事。他腿脚极快，能在林间借风穿梭，也总在别人遇险时第一个赶到。他信奉一条规矩：既然同行，就是把命交给了彼此。',
    },
    {
      key: 'ji_yunshen', name: '纪云深', title: '神枪手·弹药专家', title_frame: 'fate_companion', gender: '男',
      level: 3, exp: 130, character_class: '神枪手', hp: 138, max_hp: 138, stamina: 100, max_stamina: 100,
      strength: 11, agility: 11, intelligence: 15, luck: 16, gold: 110,
      personality: '明哲',
      skills: [skills.yindan, skills.futan], skillPool: [],
      equipment: [], bag: [item('hp_potion'), item('holy_talisman')],
      bio: '纪云深是退役的军需兵，见过太多伤者临终前的眼神。他枪法不算拔尖，却最会“稳”：再慌乱的局面，他也能先救人、再论因果。他相信军规里的那句话：弹药齐备，底气就足。',
    },
    {
      key: 'pei_zhao', name: '裴照', title: '魔法师·元素师', title_frame: 'developer', gender: '女',
      level: 2, exp: 60, character_class: '魔法师', hp: 120, max_hp: 120, stamina: 95, max_stamina: 95,
      strength: 10, agility: 13, intelligence: 16, luck: 14, gold: 180,
      personality: '好奇',
      skills: [skills.moli, skills.huoqiu, skills.bingxue], skillPool: [],
      equipment: [], bag: [item('treasure_map'), item('cloth_vest')],
      bio: '裴照是城中魔法杂货铺的学徒，因一次炼金炸炉，反而引火入体悟得元素亲和。她烧了三年炉子，最懂火候，也最爱往地下城里钻，只为找几味稀有晶尘。她笑起来眉眼弯弯，手上却总捏着随时能点燃的火球术。',
    },
    {
      key: 'xiao_se', name: '萧瑟', title: '鬼剑士·阿修罗', title_frame: 'fate', gender: '男',
      level: 4, exp: 300, character_class: '鬼剑士', hp: 148, max_hp: 148, stamina: 105, max_stamina: 105,
      strength: 13, agility: 14, intelligence: 14, luck: 12, gold: 70,
      personality: '孤僻',
      skills: [skills.liguijian, skills.guizhan, skills.moli], skillPool: [],
      equipment: [], bag: [item('torch'), item('hp_potion')],
      bio: '萧瑟是北地铁匠的遗孤，曾在雪崩里失去整个村落，从此不再轻易与人交心。他话少、笑冷，出手却极狠，鬼斩过处连血都凝成冰屑。有人骂他冷血，他只是沉默——他比谁都清楚，活着回来才有资格讲情义。',
    },
    {
      key: 'luo_qinghuan', name: '洛清欢', title: '魔法师·召唤师', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 75, character_class: '魔法师', hp: 122, max_hp: 122, stamina: 100, max_stamina: 100,
      strength: 8, agility: 16, intelligence: 14, luck: 17, gold: 150,
      personality: '仗义',
      skills: [skills.moli, skills.bingxue], skillPool: [],
      equipment: [], bag: [item('torch'), item('compass')],
      bio: '洛清欢是走南闯北的歌伶，嗓音能借魔力之音抚慰人心，也总能凭直觉避开最险的杀机。她运气好得出奇，却从不独享机缘，总把好东西分给同路之人。她常说：天命是挡箭牌，义气才是真本事。',
    },
  ];

  function makeCard(entry) {
    return {
      ...entry,
      skills: (entry.skills || []).map(skill => ({ ...skill })),
      skillPool: (entry.skillPool || []).map(skill => ({ ...skill })),
      equipment: (entry.equipment || []).filter(Boolean).map(itemEntry => ({ ...itemEntry })),
      bag: (entry.bag || []).filter(Boolean).map(itemEntry => ({ ...itemEntry })),
      latest_score: 0, praise_count: 0, is_followed: false,
      status: 'resting', is_npc: true, is_mine: false,
    };
  }

  const DEFAULT_CARDS = cards.map(makeCard);
  const NPC_NAME_POOL = DEFAULT_CARDS.map(card => card.name);

  function findCardByKey(key) {
    return DEFAULT_CARDS.find(card => card.key === key) || null;
  }

  function findCardByName(name) {
    return DEFAULT_CARDS.find(card => card.name === name) || null;
  }

  return { DEFAULT_CARDS, NPC_NAME_POOL, findCardByKey, findCardByName };
});
