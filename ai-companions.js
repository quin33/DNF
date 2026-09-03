/* ============================================================
   ai-companions.js · AI 队友固定预设名片
   前后端共用：server.js/db.js 负责持久化与后台编辑，
   浏览器端由 index.html 加载后用于单机模式与详情展示。
   字段与玩家角色卡片保持一致（name/title/character_class/
   strength/agility/intelligence/luck/skills/equipment/bag/...），
   并额外提供 biography（bio）。
   —— DNF60：20 张 DNF 城镇与传说 NPC 名片（职业 + 装备 + 技能）。
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
    starlight_staff: { key: 'starlight_staff', name: '星语法杖', kind: 'weapon', desc: '木纹里嵌着星屑的法杖，轻轻一挥便有萤光绕杖尖流转。' },
    rough_broadsword: { key: 'rough_broadsword', name: '碎岩巨剑', kind: 'weapon', desc: '铁匠炉里反复锻打的宽刃巨剑，剑脊上留着一次次的锤痕。' },
    thorn_claw: { key: 'thorn_claw', name: '刺藤爪', kind: 'weapon', desc: '形似老树刺藤的铁爪，爪尖泛着暗色，专门用来撕开硬壳魔物。' },
    silver_revolver: { key: 'silver_revolver', name: '银色左轮', kind: 'weapon', desc: '保养极好的六发左轮，枪身银白，转轮声清脆利落。' },
    frost_staff: { key: 'frost_staff', name: '凛冬法杖', kind: 'weapon', desc: '杖头悬着一枚冷色晶石，靠近时连空气都会凝出细霜。' },
    iron_guard: { key: 'iron_guard', name: '铁臂护腕', kind: 'weapon', desc: '包住前臂的厚重铁腕，挥拳砸击时能借整条手臂压出崩山之势。' },
    silent_katana: { key: 'silent_katana', name: '无声太刀', kind: 'weapon', desc: '漆黑刀身、灰白刀柄，收鞘时没有一点声响，像盲者的直觉一样安静。' },
    holy_cross: { key: 'holy_cross', name: '圣殿十字架', kind: 'weapon', desc: '圣堂赐下的十字架，祷词响起时会浮起一层柔和的圣光。' },
    grapple_bracer: { key: 'grapple_bracer', name: '柔术护拳', kind: 'weapon', desc: '缠着软绳的短护拳，方便贴身抓取，也能在摔投时护住手腕。' },
    bless_totem: { key: 'bless_totem', name: '圣光图腾', kind: 'weapon', desc: '粗壮的原木图腾刻满圣纹，插地时向四周荡开一圈祝福之力。' },
    moon_broom: { key: 'moon_broom', name: '月光扫把', kind: 'weapon', desc: '一把看起来平平无奇的扫把，只有骑上它时才会现出月白色尾迹。' },
    nen_glove: { key: 'nen_glove', name: '念气手套', kind: 'weapon', desc: '薄而韧的手套，灌注斗气后会在掌缘凝出一层明亮的念气。' },
    wind_broadsword: { key: 'wind_broadsword', name: '破风巨剑', kind: 'weapon', desc: '四剑圣遗留的阔剑，剑身微弧，挥动时像有一道风墙随剑压来。' },
    cloud_katana: { key: 'cloud_katana', name: '云岚太刀', kind: 'weapon', desc: '刀身清亮如云隙天光，刀锋掠过时连雨滴都会被切成两半。' },
    snow_blunt: { key: 'snow_blunt', name: '雪峰钝锤', kind: 'weapon', desc: '以寒山矿石铸成的重钝器，锤面覆着洗不掉的霜痕。' },
    royal_shortsword: { key: 'royal_shortsword', name: '宫廷短剑', kind: 'weapon', desc: '帝国制式的轻巧短剑，装饰克制，拔剑和收剑都极快。' },
    weeping_sword: { key: 'weeping_sword', name: '泣血巨剑', kind: 'weapon', desc: '剑刃被血气浸成暗红，握柄处留着一圈圈缠紧的旧布。' },
    poison_claw: { key: 'poison_claw', name: '噬骨爪', kind: 'weapon', desc: '来历不明的铁爪，凹槽里残留着紫色毒液，出手比蛇还快。' },
    desert_revolver: { key: 'desert_revolver', name: '沙漠之风', kind: 'weapon', desc: '黄铜枪身被风沙磨得发亮，老枪手从不让人碰它的扳机护圈。' },
    revenge_weapon: { key: 'revenge_weapon', name: '复仇巨兵', kind: 'weapon', desc: '沉重得近乎畸形的巨型兵刃，握柄缠着圣堂束带，刃口却透出暗影。' },
    mage_robe: { key: 'mage_robe', name: '学者长袍', kind: 'armor', desc: '魔法学院常穿的长袍，袖口缝着防灼烧的符文。' },
    leather_guard: { key: 'leather_guard', name: '硬皮护甲', kind: 'armor', desc: '经过鞣制的厚皮甲，耐磨抗打，是冒险家最常穿的一件。' },
    plate_armor: { key: 'plate_armor', name: '精铁板甲', kind: 'armor', desc: '铁匠一锤一锤敲出的板甲，护住胸腹，也在近战时压得住阵脚。' },
    hp_potion: { key: 'hp_potion', name: '生命药水', kind: 'pill', qty: 3, desc: '淡红色的炼金恢复药水，饮下能快速愈合伤口。' },
    mp_potion: { key: 'mp_potion', name: '魔力药水', kind: 'pill', qty: 3, desc: '湛蓝色的魔力药水，饮下后精神一振，魔力流转恢复。' },
    torch: { key: 'torch', name: '火把', kind: 'tool', desc: '浸过松脂的火把，能照亮地下城最黑的角落。' },
    satchel: { key: 'satchel', name: '皮质背包', kind: 'tool', desc: '冒险家背惯的旧皮囊，扣带磨得发亮，能装不少杂物。' },
    first_aid: { key: 'first_aid', name: '绷带', kind: 'tool', desc: '卷干净的绷带，缠上伤口能少流不少血。' },
    holy_water: { key: 'holy_water', name: '圣水', kind: 'talisman', desc: '圣堂祝圣过的瓶装圣水，对污秽与不死魔物格外有效。' },
    compass: { key: 'compass', name: '旧罗盘', kind: 'tool', desc: '指针总是固执地指向遗迹深处，据说上面附过地脉魔法。' },
    repair_kit: { key: 'repair_kit', name: '修理工具', kind: 'tool', desc: '小锤、锉刀和油布打包成的修理包，能临时保养破损的兵刃。' },
  };

  function item(key) {
    const source = ITEM_LIBRARY[key];
    if (!source) return null;
    const { key: _key, ...rest } = source;
    return { ...rest };
  }

  const skills = {
    shangtiao: { name: '上挑', elem: '', desc: '起手一剑自下而上撩起，将近身的魔物挑离地面，为后续连击腾出空隙。' },
    sanduanzhan: { name: '三段斩', elem: '', desc: '收剑、送肩、连斩三击，借势向前突进，是地下城最稳的开路招法。' },
    liguijian: { name: '里鬼剑术', elem: '', desc: '鬼剑士赖以成名的基础剑法，横斩斜挑一气呵成，收势间暗藏杀机。' },
    pojun: { name: '破军升龙击', elem: '', desc: '旋身蓄力后一剑冲天，剑光如龙昂首，把面前的敌人连甲带人掀开。' },
    huanjian: { name: '幻影剑舞', elem: '', desc: '人随剑走，残影交错，密集的剑光如雪崩般压向同一处破绽。' },
    menglong: { name: '猛龙断空斩', elem: '', desc: '拖出一串锐利残影突进，剑锋连续切割，所过之处地面留下细长的剑痕。' },
    bengshan: { name: '崩山击', elem: '', desc: '纵身跃起借势下劈，落地时震起一圈碎石与气浪，把围攻者尽数逼退。' },
    xuekuang: { name: '血之狂暴', elem: '', desc: '放任鬼手血气翻涌，换来更凶猛的斩击，代价是伤口也愈合得慢一些。' },
    nuqibaofa: { name: '怒气爆发', elem: '', desc: '把压抑的怒气灌入大地，脚下轰然爆出赤红气柱，灼伤四面敌人。' },
    shihun: { name: '噬魂之手', elem: '', desc: '一把擒住敌人肩头汲取血气，掌心的暗红纹路会随着怒吼涨起。' },
    guizhu: { name: '鬼印珠', elem: '', desc: '凝出旋转的波动珠推向敌阵，珠体越转越快，触敌时炸成一圈波痕。' },
    xieguang: { name: '邪光斩', elem: '', desc: '双手自头顶斩下，一道宽阔的暗色剑气贴地飞出，避无可避。' },
    shayibo: { name: '杀意波动', elem: '', desc: '全身释放无形波动，脚下的地面随之龟裂，越接近的敌人受创越重。' },
    dongbo: { name: '冰刃·波动剑', elem: '', desc: '挥剑凝出一道贴地飞驰的冰刃，寒气掠过之处连水洼都瞬间冻结。' },
    baoyan: { name: '爆炎·波动剑', elem: '', desc: '将波动灌成灼热炎刃横扫而出，触物即炸，火光照亮整条甬道。' },
    bengquan: { name: '崩拳', elem: '', desc: '蓄力一击，拳出如崩山，将面前敌人打得踉跄后退。' },
    tieshanka: { name: '铁山靠', elem: '', desc: '以肩为锋，沉身撞出，连人带盾轰开半丈，最擅长破开正面围堵。' },
    xuanfengtui: { name: '旋风腿', elem: '', desc: '借旋转的腰劲连环扫踢，衣袂破空，一圈下来把近身敌人全部踢散。' },
    beishuai: { name: '背摔', elem: '', desc: '贴身擒抱，借力把敌人掼向地面，土石四溅，砸得敌人半天爬不起来。' },
    leitingbeishuai: { name: '雷霆背摔', elem: '', desc: '抓住敌人后高高跃起再猛然背摔，落地时震出一圈气浪，威力惊人。' },
    yaolan: { name: '摇篮', elem: '', desc: '抓住敌人旋身抡起，像摇篮一样荡出半圈后狠狠砸落，让重甲也无处着力。' },
    zhuanzhong: { name: '砖袭', elem: '', desc: '从腰后摸出半块砖头迎面砸去，招式不雅，却能出其不意地打断敌人。' },
    paosha: { name: '抛沙', elem: '', desc: '抓起一把沙土扬向敌人双目，趁对方揉眼时欺身上前连击。' },
    duyingzhen: { name: '毒影针', elem: '', desc: '指尖弹出淬毒的暗针，出手无声，中针处很快便泛起一圈青紫。' },
    nianqibo: { name: '念气波', elem: '', desc: '双掌合拢推出明亮的念气光波，飞行轨迹笔直，触物便轰然炸开。' },
    nianqizhao: { name: '念气罩', elem: '', desc: '在身周撑起球形念气护罩，短暂抵挡飞来伤害，为全队争取调整时机。' },
    fukongdan: { name: '浮空弹', elem: '', desc: '一发挑射把敌人抬离地面，为后续连击留出空档。' },
    yindan: { name: '银弹', elem: '', desc: '给弹头附上圣光，破邪驱魔，击中要害时格外疼痛。' },
    baotou: { name: '爆头一击', elem: '', desc: '凝神一枪直取要害，枪响时敌人应声栽倒，几乎不给还手机会。' },
    luanshe: { name: '乱射', elem: '', desc: '翻身拔枪向四面连续射击，弹雨笼罩半个战场，把敌人压得抬不起头。' },
    duochongbaotou: { name: '多重爆头', elem: '', desc: '锁定数个敌人快速点射，枪口火光连闪，每一发都直奔要害。' },
    jieke: { name: '杰克爆弹', elem: '', desc: '召出一颗咧嘴嬉笑的火球砸向敌人，落地即爆，灼浪四溅。' },
    bingxuesnowman: { name: '冰霜雪人', elem: '', desc: '召出一只圆滚滚的冰霜雪人扑向敌人，撞碎时寒气四溢。' },
    anyingmao: { name: '暗影夜猫', elem: '', desc: '指尖凝出一只暗紫色猫影，沿着弧线扑咬敌人，来去无声。' },
    guangdianman: { name: '光电鳗', elem: '', desc: '召出两条盘绕的光鳗，电光噼啪作响，逼得敌人不敢近身。' },
    gaixingdan: { name: '改良魔法星弹', elem: '', desc: '甩出会蹦跳的魔法星弹，落在敌人间连续弹射，越弹越亮。' },
    suanyuyun: { name: '酸雨云', elem: '', desc: '头顶凝出一团冒着酸泡的雨云，向整片区域浇下腐蚀性酸雨。' },
    rongyan: { name: '熔岩药瓶', elem: '', desc: '掷出炼金药瓶，落地化开一片熔岩，赤红泡沫咕嘟作响。' },
    zhaohuanleiwosi: { name: '精灵召唤·雷沃斯', elem: '', desc: '从法阵中唤出雀跃的雷光精灵，劈啪作响的电弧替主人探路护身。' },
    zhaohuanhudeer: { name: '契约召唤·赫德尔', elem: '', desc: '唤来扛着短矛的哥布林佣兵赫德尔，它嗷嗷叫着替队伍打头阵。' },
    zhaohuanluyishi: { name: '契约召唤·路易丝', elem: '', desc: '从契约法阵中唤出冰霜魔女路易丝，寒冰魔法替队伍压制整片战场。' },
    kuaisuzhiyu: { name: '快速愈合', elem: '', desc: '以圣光催愈伤口，让受伤的队友迅速回到能再战的状态。' },
    shengguangshizi: { name: '圣光十字', elem: '', desc: '以十字架划出一道圣光，正面镇压扑来的魔物。' },
    shengguangqindun: { name: '圣光沁盾', elem: '', desc: '在身前立起一堵柔和发光的圣盾，能挡下正面的爪牙与箭矢。' },
    wuqizhufu: { name: '武器祝福', elem: '', desc: '将圣光附到队友的兵刃上，让刀剑在下一轮交锋中更加锋锐。' },
    zhiquanchongji: { name: '直拳冲击', elem: '', desc: '俯身一记迅猛直拳，拳锋带着白芒贯穿敌人防线。' },
    fuchongxiangquan: { name: '俯冲翔拳', elem: '', desc: '俯身滑步后冲天出拳，将敌人打得离地翻飞，衔接自如。' },
    yiniandong: { name: '意念驱动', elem: '', desc: '以意念将图腾悬于半空，念力与圣纹一同扩散，护住身边所有人。' },
    tianqianjufeng: { name: '天谴飓风', elem: '', desc: '唤来一道旋转的圣光飓风横推战场，把成群的魔物卷得东倒西歪。' },
    emoshou: { name: '恶魔之手', elem: '', desc: '鬼手化出漆黑的巨爪探出，一把攫住敌人拖向自己，爪心燃着幽焰。' },
    huamo: { name: '化魔', elem: '', desc: '将潜藏的魔性转化为力量，身周涌起暗影，换来更沉重的一击。' },
    liedichui: { name: '裂地锤', elem: '', desc: '抡起巨兵重重砸向地面，裂纹如闪电般蔓延，冲击波掀飞面前敌人。' },
  };

  const cards = [
    {
      key: 'sairiya', name: '赛丽亚·克鲁敏', title: '魔法师·召唤师', title_frame: 'fate_companion', gender: '女',
      level: 3, exp: 150, character_class: '魔法师', hp: 140, max_hp: 140, stamina: 100, max_stamina: 100,
      strength: 9, agility: 12, intelligence: 18, luck: 15, gold: 260,
      personality: '重诺',
      skills: [skills.zhaohuanleiwosi, skills.zhaohuanhudeer, skills.bingxuesnowman], skillPool: [],
      equipment: [item('starlight_staff')], bag: [item('hp_potion'), item('satchel'), item('compass')],
      bio: '赛丽亚·克鲁敏是在艾尔文防线经营旅店的精灵少女，能听懂草木与风的声音，也总把迷路的冒险家请进店里歇脚。她召唤精灵时指尖会亮起细碎星光，答应照看的同伴，哪怕隔着一整座地下城也会等下去。',
    },
    {
      key: 'lin_nasi', name: '林纳斯', title: '鬼剑士·剑魂', title_frame: 'fate_companion', gender: '男',
      level: 3, exp: 180, character_class: '鬼剑士', hp: 165, max_hp: 165, stamina: 105, max_stamina: 105,
      strength: 17, agility: 15, intelligence: 12, luck: 10, gold: 80,
      personality: '明哲',
      skills: [skills.shangtiao, skills.sanduanzhan, skills.pojun], skillPool: [],
      equipment: [item('rough_broadsword'), item('plate_armor')], bag: [item('repair_kit'), item('hp_potion')],
      bio: '林纳斯年轻时走遍了整个阿拉德大陆，如今在艾尔文防线守着铁匠铺，替新来的冒险家磨剑、修甲、讲地下城里的规矩。他说剑不只要磨得快，更要磨得正，冒险也是同一回事。',
    },
    {
      key: 'kanina', name: '卡妮娜', title: '格斗家·街霸', title_frame: 'fate', gender: '女',
      level: 2, exp: 90, character_class: '格斗家', hp: 130, max_hp: 130, stamina: 100, max_stamina: 100,
      strength: 13, agility: 16, intelligence: 10, luck: 14, gold: 310,
      personality: '狡诈',
      skills: [skills.zhuanzhong, skills.paosha, skills.duyingzhen], skillPool: [],
      equipment: [item('thorn_claw')], bag: [item('hp_potion'), item('holy_water'), item('satchel')],
      bio: '卡妮娜在赫顿玛尔的街角摆摊长大，嘴上永远挂着比糖还甜的价钱，手上却比谁都清楚一件旧护甲真正值几个金币。她打架不讲套路，砖头、沙土、指甲缝里的毒针都用得顺手，但答应别人的货，从不会少一角。',
    },
    {
      key: 'kaili', name: '凯丽', title: '神枪手·漫游枪手', title_frame: 'developer', gender: '女',
      level: 3, exp: 170, character_class: '神枪手', hp: 140, max_hp: 140, stamina: 105, max_stamina: 105,
      strength: 13, agility: 18, intelligence: 14, luck: 12, gold: 500,
      personality: '好奇',
      skills: [skills.fukongdan, skills.baotou, skills.luanshe], skillPool: [],
      equipment: [item('silver_revolver')], bag: [item('mp_potion'), item('repair_kit'), item('satchel')],
      bio: '凯丽是从天界跌落到阿拉德的漫游枪手，把西海岸的强化机当成最大的爱好。她总说装备强化一半靠材料一半靠胆量，眼睛亮起来时，没人知道她下一枪会打向敌人还是打向幸运。',
    },
    {
      key: 'shalan', name: '莎兰', title: '魔法师·元素师', title_frame: 'fate_companion', gender: '女',
      level: 4, exp: 260, character_class: '魔法师', hp: 145, max_hp: 145, stamina: 100, max_stamina: 100,
      strength: 8, agility: 10, intelligence: 20, luck: 15, gold: 420,
      personality: '高傲',
      skills: [skills.jieke, skills.bingxuesnowman, skills.anyingmao, skills.guangdianman], skillPool: [],
      equipment: [item('frost_staff'), item('mage_robe')], bag: [item('mp_potion'), item('compass')],
      bio: '莎兰是西海岸魔法学院的院长，也是阿拉德最权威的元素导师。她授课时极有耐心，却从不原谅浪费魔力的学生；在她眼里，元素从不会背叛认真的人，只有学艺不精者才会被火焰反噬。',
    },
    {
      key: 'fengzhen', name: '风振', title: '格斗家·散打', title_frame: 'fate', gender: '男',
      level: 3, exp: 190, character_class: '格斗家', hp: 160, max_hp: 160, stamina: 110, max_stamina: 110,
      strength: 18, agility: 16, intelligence: 10, luck: 9, gold: 90,
      personality: '莽撞',
      skills: [skills.bengquan, skills.tieshanka, skills.xuanfengtui], skillPool: [],
      equipment: [item('iron_guard')], bag: [item('hp_potion'), item('first_aid')],
      bio: '风振把拳馆开在赫顿玛尔最热闹的街区，收徒第一课永远是站桩和挨打。他崇尚拳拳到肉的力量，也相信散打是斗气与身体最直接的语言，遇见讲道理的魔物太少，所以他的拳头总比劝告先到。',
    },
    {
      key: 'gsd', name: 'G.S.D', title: '鬼剑士·阿修罗', title_frame: 'developer', gender: '男',
      level: 4, exp: 300, character_class: '鬼剑士', hp: 150, max_hp: 150, stamina: 105, max_stamina: 105,
      strength: 12, agility: 13, intelligence: 17, luck: 14, gold: 70,
      personality: '孤僻',
      skills: [skills.shangtiao, skills.guizhu, skills.xieguang, skills.shayibo], skillPool: [],
      equipment: [item('silent_katana')], bag: [item('hp_potion'), item('torch'), item('satchel')],
      bio: 'G.S.D 是暗黑城的老剑客，双眼早已失明，却比大多数冒险家更早听见剑气与魔物的脚步。他话少，讲课也总在最后补一句最狠的叮嘱；波动在他脚下像活水一样流淌，没有人知道他究竟藏了多少杀招。',
    },
    {
      key: 'gelantisi', name: '歌兰蒂斯', title: '圣职者·圣骑士', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 100, character_class: '圣职者', hp: 130, max_hp: 130, stamina: 100, max_stamina: 100,
      strength: 10, agility: 10, intelligence: 17, luck: 17, gold: 220,
      personality: '重诺',
      skills: [skills.kuaisuzhiyu, skills.shengguangshizi, skills.wuqizhufu], skillPool: [],
      equipment: [item('holy_cross')], bag: [item('holy_water'), item('first_aid')],
      bio: '歌兰蒂斯是赫顿玛尔圣堂的圣骑士，祈祷时声音轻得像晨雾，举盾时却比城墙还稳。她相信每个迷途的灵魂都还有被圣光接住的机会，因此在等待哥哥回家的这些年里，她把每一份没能送出的牵挂都护在了同伴身上。',
    },
    {
      key: 'aerbote', name: '阿尔伯特', title: '格斗家·柔道家', title_frame: 'fate', gender: '男',
      level: 3, exp: 160, character_class: '格斗家', hp: 155, max_hp: 155, stamina: 110, max_stamina: 110,
      strength: 16, agility: 17, intelligence: 13, luck: 11, gold: 120,
      personality: '高傲',
      skills: [skills.beishuai, skills.leitingbeishuai, skills.yaolan], skillPool: [],
      equipment: [item('grapple_bracer')], bag: [item('hp_potion'), item('satchel')],
      bio: '阿尔伯特自认是阿拉德百年难遇的武学天才，路过任何拳馆都要停下来点评两句。他嘴上刻薄，却从不拒绝真正的挑战者，摔投时手腕又稳又轻，仿佛能把任何重甲敌人当成一只不听话的沙袋。',
    },
    {
      key: 'xinda', name: '辛达', title: '圣职者·蓝拳圣使', title_frame: 'developer', gender: '男',
      level: 3, exp: 150, character_class: '圣职者', hp: 150, max_hp: 150, stamina: 105, max_stamina: 105,
      strength: 15, agility: 16, intelligence: 14, luck: 13, gold: 150,
      personality: '仗义',
      skills: [skills.zhiquanchongji, skills.fuchongxiangquan, skills.yiniandong, skills.tianqianjufeng], skillPool: [],
      equipment: [item('bless_totem')], bag: [item('holy_water'), item('hp_potion')],
      bio: '辛达是驻守在岔路口圣所的老蓝拳圣使，替商队和冒险家看了一辈子路。他把图腾插在地上就能召集整条街的人一起祷告，也用那双布满老茧的拳头压过无数趁夜打劫的匪徒。',
    },
    {
      key: 'luolian', name: '罗莉安', title: '魔法师·魔道学者', title_frame: 'fate_companion', gender: '女',
      level: 2, exp: 80, character_class: '魔法师', hp: 125, max_hp: 125, stamina: 100, max_stamina: 100,
      strength: 8, agility: 14, intelligence: 18, luck: 17, gold: 210,
      personality: '好奇',
      skills: [skills.gaixingdan, skills.suanyuyun, skills.rongyan], skillPool: [],
      equipment: [item('moon_broom'), item('mage_robe')], bag: [item('mp_potion'), item('compass')],
      bio: '罗莉安总抱着那把会自己浮起来的月光扫把，在艾尔文防线附近寻找稀奇的炼金材料。她把每场探险都当成实验课，药瓶炸了也不心疼，只忙着记下烟的颜色；但若队友沾上酸雨，她总会第一个丢来干净的毛巾。',
    },
    {
      key: 'aolan', name: '奥兰奶奶', title: '格斗家·气功师', title_frame: 'fate', gender: '女',
      level: 3, exp: 140, character_class: '格斗家', hp: 150, max_hp: 150, stamina: 100, max_stamina: 100,
      strength: 12, agility: 15, intelligence: 16, luck: 18, gold: 90,
      personality: '重诺',
      skills: [skills.nianqibo, skills.nianqizhao, skills.bengquan], skillPool: [],
      equipment: [item('nen_glove')], bag: [item('hp_potion'), item('holy_water'), item('satchel')],
      bio: '奥兰奶奶年轻时走遍各地驯养精灵动物，老了便在西海岸开了一间暖融融的窝棚。她念气圆润绵长，能隔着老远察觉魔物藏在树影里的恶意，也总说孩子们只管往前闯，老骨头替你们守住后路。',
    },
    {
      key: 'aganzuo', name: '阿甘左', title: '传说·鬼剑士·剑魂', title_frame: 'developer', gender: '男',
      level: 5, exp: 380, character_class: '鬼剑士', hp: 175, max_hp: 175, stamina: 110, max_stamina: 110,
      strength: 19, agility: 14, intelligence: 12, luck: 15, gold: 180,
      personality: '仗义',
      skills: [skills.shangtiao, skills.liguijian, skills.pojun, skills.huanjian], skillPool: [],
      equipment: [item('wind_broadsword')], bag: [item('hp_potion'), item('satchel')],
      bio: '阿甘左是大陆上最负盛名的四剑圣之一，腰间那柄巨剑曾在悲鸣洞穴留下无数刻痕。他平日沉默饮酒，仿佛把很多话都留在了那个没能带回来的同伴身边；可一旦有人需要，他依然会第一个拔出剑，像许多年前一样挡在众人前面。',
    },
    {
      key: 'xilan', name: '西岚', title: '传说·鬼剑士·剑魂', title_frame: 'fate_companion', gender: '男',
      level: 5, exp: 350, character_class: '鬼剑士', hp: 168, max_hp: 168, stamina: 108, max_stamina: 108,
      strength: 17, agility: 17, intelligence: 15, luck: 16, gold: 160,
      personality: '明哲',
      skills: [skills.sanduanzhan, skills.liguijian, skills.pojun, skills.menglong], skillPool: [],
      equipment: [item('cloud_katana')], bag: [item('hp_potion'), item('compass')],
      bio: '西岚是四剑圣中看起来最随性的一个，太刀从不离身，说话却总像在讲别人的故事。他见识过时间的裂隙与无数命运的岔路，因此格外珍惜眼前同伴的每一次选择；刀出鞘时，他比任何人都清楚这一斩会留下怎样的因果。',
    },
    {
      key: 'buwanjia', name: '布万加', title: '传说·鬼剑士·剑魂', title_frame: 'developer', gender: '男',
      level: 5, exp: 400, character_class: '鬼剑士', hp: 185, max_hp: 185, stamina: 112, max_stamina: 112,
      strength: 20, agility: 13, intelligence: 11, luck: 12, gold: 130,
      personality: '莽撞',
      skills: [skills.shangtiao, skills.liguijian, skills.bengshan, skills.huanjian], skillPool: [],
      equipment: [item('snow_blunt')], bag: [item('hp_potion'), item('first_aid')],
      bio: '布万加在终年积雪的班图部落长大，是四剑圣中最像一座山的那个。他不讲花哨剑理，只相信重剑压势、锤落土裂；别人问他如何胜过强敌，他抹一把脸上的霜，说站在雪里的人从不怕冷，站在敌人面前的人从不怕狠。',
    },
    {
      key: 'ba_en', name: '巴恩', title: '传说·鬼剑士·剑魂', title_frame: 'fate_companion', gender: '男',
      level: 4, exp: 320, character_class: '鬼剑士', hp: 160, max_hp: 160, stamina: 108, max_stamina: 108,
      strength: 16, agility: 18, intelligence: 14, luck: 13, gold: 230,
      personality: '狡诈',
      skills: [skills.liguijian, skills.sanduanzhan, skills.pojun, skills.menglong], skillPool: [],
      equipment: [item('royal_shortsword'), item('leather_guard')], bag: [item('hp_potion'), item('satchel')],
      bio: '巴恩是四剑圣中最年轻的成员，也是帝国宫廷里最受器重的剑士。他笑容得体，短剑出鞘却快得连影子都追不上，总在最后关头才亮出真正的底牌。有人说他野心太深，他只轻轻擦剑，说棋盘上先落子的人未必能赢。',
    },
    {
      key: 'luxi', name: '卢克西', title: '传说·鬼剑士·狂战士', title_frame: 'developer', gender: '女',
      level: 4, exp: 360, character_class: '鬼剑士', hp: 175, max_hp: 175, stamina: 108, max_stamina: 108,
      strength: 20, agility: 16, intelligence: 10, luck: 11, gold: 30,
      personality: '莽撞',
      skills: [skills.bengshan, skills.xuekuang, skills.nuqibaofa, skills.shihun], skillPool: [],
      equipment: [item('weeping_sword')], bag: [item('hp_potion'), item('torch')],
      bio: '卢克西是背负鬼手的女剑士，也是传说中在悲鸣洞穴与希洛克同归于尽的人。她活着时性子烈得像烧红的铁，剑锋一出便不肯回头，把自己的血和命都算进最后一击里；如今她的名字仍被地下城的旅人当作一句誓言念起。',
    },
    {
      key: 'palisi', name: '帕丽丝', title: '传说·格斗家·街霸', title_frame: 'fate', gender: '女',
      level: 3, exp: 220, character_class: '格斗家', hp: 145, max_hp: 145, stamina: 106, max_stamina: 106,
      strength: 14, agility: 18, intelligence: 15, luck: 16, gold: 280,
      personality: '狡诈',
      skills: [skills.zhuanzhong, skills.paosha, skills.duyingzhen], skillPool: [],
      equipment: [item('poison_claw')], bag: [item('holy_water'), item('satchel')],
      bio: '帕丽丝在暗黑城的暗巷里打出了自己的名号，人人都说她的毒爪比蛇信还准，惹她的人第二天多半会出现在护城河里。她爱钱、记仇，却从不欺负比她更弱的人；黑市上的小贩都知道，赊给帕丽丝的账永远收得回来。',
    },
    {
      key: 'shaying', name: '沙影·贝利特', title: '传说·神枪手·漫游枪手', title_frame: 'developer', gender: '男',
      level: 4, exp: 280, character_class: '神枪手', hp: 155, max_hp: 155, stamina: 106, max_stamina: 106,
      strength: 15, agility: 19, intelligence: 13, luck: 17, gold: 260,
      personality: '孤僻',
      skills: [skills.fukongdan, skills.baotou, skills.duochongbaotou, skills.yindan], skillPool: [],
      equipment: [item('desert_revolver'), item('leather_guard')], bag: [item('mp_potion'), item('repair_kit')],
      bio: '沙影·贝利特是天界传说般的老枪手，风沙把他的面容磨得沧桑，也把他的枪法磨得更冷。他习惯独自坐在酒馆角落数弹壳，只有枪响时才肯展露真正的锋芒；据说年轻时的凯丽，也曾追着他的背影学了很久如何瞄准。',
    },
    {
      key: 'nierbasi', name: '尼尔巴斯·格拉西亚', title: '传说·圣职者·复仇者', title_frame: 'fate_companion', gender: '男',
      level: 4, exp: 310, character_class: '圣职者', hp: 175, max_hp: 175, stamina: 108, max_stamina: 108,
      strength: 18, agility: 12, intelligence: 15, luck: 11, gold: 100,
      personality: '明哲',
      skills: [skills.emoshou, skills.huamo, skills.liedichui], skillPool: [],
      equipment: [item('revenge_weapon')], bag: [item('holy_water'), item('first_aid')],
      bio: '尼尔巴斯·格拉西亚曾是圣堂最耀眼的圣骑士，为了守护妹妹歌兰蒂斯而自愿踏入深渊，从此左手缠绕着无法洗净的魔性。他一边与体内恶念搏斗，一边替圣堂处理见不得光的污秽；那把复仇巨兵落下时，他总先向神祈祷一句：请原谅这一击的代价。',
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
