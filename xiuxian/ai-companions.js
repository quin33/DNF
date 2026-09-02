/* ============================================================
   ai-companions.js · AI 队友固定预设名片
   前后端共用：server.js/db.js 负责持久化与后台编辑，
   浏览器端由 index.html 加载后用于单机模式与详情展示。
   字段与玩家角色卡片保持一致（name/title/character_class/
   strength/agility/intelligence/luck/skills/equipment/bag/...），
   并额外提供 biography（bio）与特质描述（traitDescs）。
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
    iron_sword: { key: 'iron_sword', name: '铁剑', kind: 'weapon', desc: '一柄锈迹斑斑的旧铁剑，剑刃缺口处泛着微光。' },
    cloth_robe: { key: 'cloth_robe', name: '粗布道袍', kind: 'armor', desc: '粗布缝制的道袍，洗得发白，却异常结实。' },
    condense_pill: { key: 'condense_pill', name: '聚气丹', kind: 'pill', qty: 3, desc: '低阶丹药，服之可凝神聚气，聊胜于无。' },
    fire_talisman: { key: 'fire_talisman', name: '火球符', kind: 'talisman', desc: '黄纸朱砂所绘，注入灵力即可激发一团火球。' },
    spirit_hoe: { key: 'spirit_hoe', name: '灵锄', kind: 'tool', desc: '药园常用之物，据说能掘开灵土。' },
    compass: { key: 'compass', name: '古旧罗盘', kind: 'tool', desc: '指针总是固执地指向迷雾深处。' },
    beast_pouch: { key: 'beast_pouch', name: '兽皮囊', kind: 'tool', desc: '妖兽皮缝制的储物袋，能装不少杂物。' },
    sound_talisman: { key: 'sound_talisman', name: '传音符', kind: 'talisman', desc: '一张可千里传音的符纸，仅能使用一次。' },
    mist_pearl: { key: 'mist_pearl', name: '避瘴珠', kind: 'tool', desc: '千年灵木结成的珠子，可避瘴气毒雾。' },
    spirit_lamp: { key: 'spirit_lamp', name: '引灵灯', kind: 'tool', desc: '一盏昏黄的油灯，再微弱的灵气角落也能点亮。' },
  };

  function item(key) {
    const source = ITEM_LIBRARY[key];
    if (!source) return null;
    const { key: _key, ...rest } = source;
    return { ...rest };
  }

  const skills = {
    gengjin_lianqi: { name: '庚金炼体诀', type: '功法', elem: '金灵根', tier: '玄阶', desc: '以庚金之气淬炼体魄，身如精钢，刀枪难伤。' },
    jinren: { name: '金刃术', type: '术法', elem: '金灵根', tier: '黄阶', desc: '凝聚一道锋锐金刃，可近可远，削铁如泥。' },
    yujian: { name: '御剑术·初窥', type: '术法', elem: '金灵根', tier: '地阶', desc: '剑修入门秘录，御使飞剑千里取敌，初窥门径已非凡俗可比。' },
    qingmu: { name: '青木养气诀', type: '功法', elem: '木灵根', tier: '黄阶', desc: '吐纳青木生气，绵绵不绝，伤势恢复极快。' },
    chanteng: { name: '缠藤术', type: '术法', elem: '木灵根', tier: '玄阶', desc: '催生藤蔓缠缚敌人，牵制其行动。' },
    qingmu_changsheng: { name: '青木长生功', type: '功法', elem: '木灵根', tier: '天阶', desc: '筑基级木系功法，吐纳青木生气，绵绵不绝，伤势恢复极快。' },
    xianshui: { name: '玄水凝元功', type: '功法', elem: '水灵根', tier: '地阶', desc: '引水灵凝聚真元，生生不息，神识绵长。' },
    shuijian: { name: '水箭术', type: '术法', elem: '水灵根', tier: '黄阶', desc: '凝水成箭，破空而去，无声无息。' },
    xuanbing: { name: '玄冰真气', type: '功法', elem: '水灵根', tier: '地阶', desc: '筑基级水系功法，引水灵凝寒成冰，真气过处寒气逼人。' },
    chiyan: { name: '赤炎心法', type: '功法', elem: '火灵根', tier: '天阶', desc: '以心驭火，真元如焰，攻伐猛烈。' },
    huoqiu: { name: '火球术', type: '术法', elem: '火灵根', tier: '黄阶', desc: '凝聚一团赤焰火球，掷向敌手，爆裂灼烧。' },
    houtu: { name: '厚土镇岳诀', type: '功法', elem: '土灵根', tier: '黄阶', desc: '借大地厚土之力护体，稳如泰山。' },
    tudun: { name: '土盾术', type: '术法', elem: '土灵根', tier: '玄阶', desc: '凝聚土盾挡于身前，硬撼重击。' },
  };

  const cards = [
    {
      key: 'mo_chen', name: '墨尘', title: '庚金剑修', title_frame: 'fate_companion', gender: '男',
      level: 3, exp: 120, character_class: '练气三层', hp: 160, max_hp: 160, stamina: 110, max_stamina: 110,
      strength: 17, agility: 15, intelligence: 13, luck: 12, gold: 80,
      personality: '高傲', traits: ['金灵根', '剑心通明'],
      traitDescs: { '金灵根': '锋锐果决，与兵刃之道有缘。', '剑心通明': '与剑意天然相合，遇剑便知其锋芒。' },
      skills: [skills.gengjin_lianqi, skills.jinren, skills.yujian], skillPool: [],
      equipment: [item('iron_sword')], bag: [item('beast_pouch'), item('condense_pill')],
      bio: '墨尘出身矿脉边的小村，幼时从矿洞深处拾得半截残剑，自此夜夜有剑鸣入梦。十六岁那年他在崖上练剑，剑光引动天边金气，被路过的剑修收为弟子。他寡言少语，只认剑理不认人情，认定同队道友只要握得住剑，便值得托付后背。',
    },
    {
      key: 'liu_yan', name: '柳烟', title: '玄水医修', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 90, character_class: '练气二层', hp: 130, max_hp: 130, stamina: 100, max_stamina: 100,
      strength: 8, agility: 17, intelligence: 15, luck: 13, gold: 140,
      personality: '明哲', traits: ['水灵根', '百毒不侵'],
      traitDescs: { '水灵根': '润物无声，善纳百川。', '百毒不侵': '幼时服过解毒灵泉，寻常瘴毒难近其身。' },
      skills: [skills.xianshui, skills.shuijian], skillPool: [],
      equipment: [], bag: [item('mist_pearl'), item('spirit_lamp')],
      bio: '柳烟是药王谷外门弟子的孤女，跟着师父在深山里采药十年，识得百草，也练出一身踏水无痕的轻身功夫。她性子安静，凡事习惯先退半步看清楚利害，危急时却总能把最要紧的人稳稳捞回来。',
    },
    {
      key: 'gu_changfeng', name: '顾长风', title: '赤焰枪修', title_frame: 'fate', gender: '男',
      level: 3, exp: 180, character_class: '练气三层', hp: 150, max_hp: 150, stamina: 100, max_stamina: 100,
      strength: 16, agility: 14, intelligence: 10, luck: 11, gold: 60,
      personality: '莽撞', traits: ['火灵根', '胆大心细'],
      traitDescs: { '火灵根': '狂暴炽烈，攻伐凌厉。', '胆大心细': '看着莽撞，遇险时反而比谁都沉得住气。' },
      skills: [skills.chiyan, skills.huoqiu], skillPool: [],
      equipment: [], bag: [item('fire_talisman'), item('beast_pouch')],
      bio: '顾长风是镖局少东，押镖时被劫匪逼入火窟，却在烈焰里悟出一丝火灵真意。他嘴上总说“莽就完事”，行动前却会把退路、后手都盘算一遍。长枪一横，火光亮起时，他永远是冲在最前的那一个。',
    },
    {
      key: 'su_yan', name: '苏砚', title: '厚土书生', title_frame: 'developer', gender: '男',
      level: 2, exp: 80, character_class: '练气二层', hp: 140, max_hp: 140, stamina: 100, max_stamina: 100,
      strength: 12, agility: 9, intelligence: 16, luck: 14, gold: 200,
      personality: '好奇', traits: ['土灵根', '博闻强记'],
      traitDescs: { '土灵根': '沉稳厚重，不动如山。', '博闻强记': '过目不忘，凡看过的残卷碑文皆能默诵。' },
      skills: [skills.houtu, skills.tudun], skillPool: [],
      equipment: [item('cloth_robe')], bag: [item('compass'), item('sound_talisman')],
      bio: '苏砚原是一名落第书生，为寻古卷误入地底洞府，被厚土灵气灌体，捡回半部残缺功法。他随身带一本注满批注的札记，每进一座灵墟都要抄回一页碑文。队伍里没人比他更擅长读懂残阵与旧地图。',
    },
    {
      key: 'chu_jinghong', name: '楚惊鸿', title: '无锋剑女', title_frame: 'fate_companion', gender: '女',
      level: 4, exp: 260, character_class: '练气四层', hp: 145, max_hp: 145, stamina: 110, max_stamina: 110,
      strength: 18, agility: 16, intelligence: 11, luck: 10, gold: 50,
      personality: '孤僻', traits: ['金灵根', '夜视之眼'],
      traitDescs: { '金灵根': '锋锐果决，与兵刃之道有缘。', '夜视之眼': '在黑暗处视物如昼，暗巷深窟皆可来去。' },
      skills: [skills.gengjin_lianqi, skills.jinren], skillPool: [skills.yujian],
      equipment: [item('iron_sword')], bag: [item('condense_pill'), item('sound_talisman')],
      bio: '楚惊鸿曾是剑阁杂役，因一次偷看长老练剑被逐出门墙。她没有门派，只凭一柄钝剑在灵墟边缘讨生活，练出快而无声的剑法。她不爱与人同行，但一旦应下同行，便会在夜色里替全队守完最后一班岗。',
    },
    {
      key: 'jiang_xue', name: '姜雪', title: '青木灵医', title_frame: 'fate', gender: '女',
      level: 2, exp: 70, character_class: '练气二层', hp: 125, max_hp: 125, stamina: 100, max_stamina: 100,
      strength: 9, agility: 12, intelligence: 15, luck: 15, gold: 160,
      personality: '重诺', traits: ['木灵根', '老练猎手'],
      traitDescs: { '木灵根': '生生不息，亲和草木生机。', '老练猎手': '常在林中穿行，辨足迹、寻猎物皆有一手。' },
      skills: [skills.qingmu, skills.chanteng], skillPool: [skills.qingmu_changsheng],
      equipment: [], bag: [item('spirit_hoe'), item('cloth_robe')],
      bio: '姜雪是猎户之女，娘亲病故前教她认药，也教她“答应人的事，拼死也要做到”。她背着药篓行走山林，能一眼认出毒草与药草。她把每位队友都当作欠过恩情的病人照顾，谁受了伤，她比谁都在意。',
    },
    {
      key: 'lu_li', name: '陆离', title: '阵道学徒', title_frame: 'developer', gender: '男',
      level: 3, exp: 150, character_class: '练气三层', hp: 135, max_hp: 135, stamina: 105, max_stamina: 105,
      strength: 13, agility: 10, intelligence: 17, luck: 9, gold: 90,
      personality: '狡诈', traits: ['土灵根', '寻宝直觉'],
      traitDescs: { '土灵根': '沉稳厚重，不动如山。', '寻宝直觉': '对暗格秘藏有近乎本能的嗅觉。' },
      skills: [skills.houtu, skills.tudun], skillPool: [],
      equipment: [item('cloth_robe')], bag: [item('compass'), item('spirit_hoe')],
      bio: '陆离自称散修，实则做过盗墓、押货、替人破阵的营生，身上每一件法器都来得不太干净。他能从墙缝里看出暗门，从风水走势里嗅出灵脉。他说话总是半真半假，但到了分赃的时候，又意外地从不食言。',
    },
    {
      key: 'yan_wujiu', name: '晏无咎', title: '雷行客', title_frame: 'fate', gender: '男',
      level: 4, exp: 240, character_class: '练气四层', hp: 150, max_hp: 150, stamina: 110, max_stamina: 110,
      strength: 14, agility: 18, intelligence: 12, luck: 13, gold: 40,
      personality: '仗义', traits: ['木灵根', '听风辨位'],
      traitDescs: { '木灵根': '生生不息，亲和草木生机。', '听风辨位': '凭风声与脚步便能辨明四周动向。' },
      skills: [skills.qingmu, skills.chanteng], skillPool: [],
      equipment: [], bag: [item('mist_pearl'), item('beast_pouch')],
      bio: '晏无咎是山寨里的义子，名字取自“行无咎”，意思是一生不做亏心事。他腿脚极快，能在林间借风穿梭，也总在别人遇险时第一个赶到。他信奉一条规矩：既然同行，就是把命交给了彼此。',
    },
    {
      key: 'ji_yunshen', name: '纪云深', title: '守墓医修', title_frame: 'fate_companion', gender: '男',
      level: 3, exp: 130, character_class: '练气三层', hp: 138, max_hp: 138, stamina: 100, max_stamina: 100,
      strength: 11, agility: 11, intelligence: 15, luck: 16, gold: 110,
      personality: '明哲', traits: ['土灵根', '百毒不侵'],
      traitDescs: { '土灵根': '沉稳厚重，不动如山。', '百毒不侵': '多年在瘴地行医，寻常毒物已奈何不得。' },
      skills: [skills.houtu, skills.tudun], skillPool: [],
      equipment: [], bag: [item('condense_pill'), item('mist_pearl')],
      bio: '纪云深是守墓人家族的独子，从小在祖坟旁的药田长大，见过太多伤者临终前的眼神。他医术不算拔尖，却最会“稳”：再慌乱的局面，他也能先救人、再论因果。他相信土里的东西不会说谎，人也一样。',
    },
    {
      key: 'pei_zhao', name: '裴照', title: '赤霄丹修', title_frame: 'developer', gender: '女',
      level: 2, exp: 60, character_class: '练气二层', hp: 120, max_hp: 120, stamina: 95, max_stamina: 95,
      strength: 10, agility: 13, intelligence: 16, luck: 14, gold: 180,
      personality: '好奇', traits: ['火灵根', '灵觉敏锐'],
      traitDescs: { '火灵根': '狂暴炽烈，攻伐凌厉。', '灵觉敏锐': '对灵气波动异常敏感，异动未至已先觉。' },
      skills: [skills.chiyan, skills.huoqiu], skillPool: [],
      equipment: [], bag: [item('fire_talisman'), item('cloth_robe')],
      bio: '裴照是丹房烧火丫头出身，因一次丹炉炸裂，反而引火入体悟得火灵根。她烧了三年炉子，最懂火候，也最爱往灵墟里钻，只为找几味稀有灵草。她笑起来眉眼弯弯，手上却总捏着随时能点燃的火球符。',
    },
    {
      key: 'xiao_se', name: '萧瑟', title: '玄冰独行客', title_frame: 'fate', gender: '男',
      level: 4, exp: 300, character_class: '练气四层', hp: 148, max_hp: 148, stamina: 105, max_stamina: 105,
      strength: 13, agility: 14, intelligence: 14, luck: 12, gold: 70,
      personality: '孤僻', traits: ['水灵根', '心狠手辣'],
      traitDescs: { '水灵根': '润物无声，善纳百川。', '心狠手辣': '对敌人绝不手软，出手不留余情。' },
      skills: [skills.xianshui, skills.shuijian, skills.xuanbing], skillPool: [],
      equipment: [], bag: [item('sound_talisman'), item('condense_pill')],
      bio: '萧瑟是北地冰原的猎人，曾在雪崩里失去整个村落，从此不再轻易与人交心。他话少、笑冷，出手却极狠，玄冰真气过处连血都凝成红晶。有人骂他冷血，他只是沉默——他比谁都清楚，活着回来才有资格讲情义。',
    },
    {
      key: 'luo_qinghuan', name: '洛清欢', title: '云水歌者', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 75, character_class: '练气二层', hp: 122, max_hp: 122, stamina: 100, max_stamina: 100,
      strength: 8, agility: 16, intelligence: 14, luck: 17, gold: 150,
      personality: '仗义', traits: ['水灵根', '气运缠身'],
      traitDescs: { '水灵根': '润物无声，善纳百川。', '气运缠身': '常与机缘不期而遇，也常被麻烦缠上。' },
      skills: [skills.xianshui, skills.shuijian], skillPool: [],
      equipment: [], bag: [item('spirit_lamp'), item('compass')],
      bio: '洛清欢是走南闯北的歌伶，嗓音能借水灵之音抚慰人心，也总能凭直觉避开最险的杀机。她运气好得出奇，却从不独享机缘，总把好东西分给同路之人。她常说：天命是挡箭牌，义气才是真本事。',
    },
  ];

  function makeCard(entry) {
    return {
      ...entry,
      skills: (entry.skills || []).map(skill => ({ ...skill })),
      skillPool: (entry.skillPool || []).map(skill => ({ ...skill })),
      equipment: (entry.equipment || []).filter(Boolean).map(itemEntry => ({ ...itemEntry })),
      bag: (entry.bag || []).filter(Boolean).map(itemEntry => ({ ...itemEntry })),
      traits: (entry.traits || []).slice(),
      traitDescs: { ...(entry.traitDescs || {}) },
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
