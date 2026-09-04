/* ============================================================
   game-create.js · 在线版角色创建（服务端权威生成）
   常量与数据与单机版 index.html 保持一致（避免依赖拆分改动）
   —— DNF60：职业系统（五大初始职业 + Lv10 转职），技能统一为战斗技能
      技能系统（已取消分类）；初始装备固定为
      「职业新手武器 + 3 瓶治疗药水」，创建后放入随身装备。
   ============================================================ */

// 五大初始职业（key 供前端选择；label=职业名；skills=初始候选 4 门技能）
const ROOT_KEYS = {
  slayer: { label: '鬼剑士', desc: '被鬼手诅咒的剑士，左臂缠着卡赞的怨念，拔刀时鬼神之力随剑而出，以弑魔之剑斩断宿命。' },
  fighter: { label: '格斗家', desc: '来自虚祖的武者，以拳脚淬炼血肉筋骨，气随意动、力贯周身，坚信千锤百炼的肉身便是最强武器。' },
  gunner: { label: '神枪手', desc: '来自天界的流浪枪手，枪膛里装满故土战火的记忆，不问出身、只认扳机，要在阿拉德闯出一条生路。' },
  mage: { label: '魔法师', desc: '来自魔界的持杖者，自幼在魔物横行之地偷习禁术，元素听其号令，誓以凡躯探寻诸界深处的奥义。' },
  priest: { label: '圣职者', desc: '虚祖圣职者教团的信徒，以铁十字与圣光清扫阿拉德的魔物，坚信圣光之下没有驱不散的黑暗。' },
};
const PERS_LIST = ['重诺', '好奇', '莽撞', '明哲', '高傲', '仗义', '孤僻', '狡诈'];
const MAX_SKILLS = 5;

/* 初始技能：参考 DNF 未转职角色基础技能，每职业 4 门候选，创建时由玩家 4 选 2。
   技能不再携带分类或稀有度，仅保留 名称/属性/描述。 */
const ROOT_SKILLS = {
  slayer: [
    { name: '上挑', elem: '', desc: '向上挥剑挑击，命中后把敌人挑至浮空，趁其离地衔接连击，是鬼剑士最常用的起手式。' },
    { name: '三段斩', elem: '', desc: '向前连续挥砍三刀，每段命中独立判定，最后一击力道最重，能把射程内的敌人一起震退。' },
    { name: '鬼斩', elem: '', desc: '蓄鬼气于剑锋，向前斩出暗色剑气，命中可使敌人短暂僵直，是输出与控场兼顾的一击。' },
    { name: '裂波斩', elem: '', desc: '挥剑斩出波动剑气，向前扩散撕开近身魔物护甲，范围虽窄出手极快，适合贴身拼刀。' },
  ],
  fighter: [
    { name: '上勾拳', elem: '', desc: '沉腰挥出上勾拳，命中后把敌人挑离地面浮空，可接空中连击，是格斗家的主力起手技。' },
    { name: '前踢', elem: '', desc: '正面蹬出势大力沉的直踢，攻击距离远、命中把敌人踢退数步，拉开身位或起动连招皆宜。' },
    { name: '下段踢', elem: '', desc: '放低重心贴地横扫，命中使敌人下盘失衡踉跄不稳，能在对方起手时打断其攻击。' },
    { name: '背摔', elem: '', desc: '贴身擒抱住敌人，借力一拧将其过肩摔向地面，落地造成伤害并顺势压制，衔接地面连击。' },
  ],
  gunner: [
    { name: '瞬踢', elem: '', desc: '近身快速一记侧踢，出脚快得难以捕捉，命中把敌人踢得后退，用来摆脱贴身缠斗。' },
    { name: '浮空弹', elem: '', desc: '抬枪朝敌人脚下射击，弹着冲击把人抬离地面浮空，为后续连射或连招留出稳定输出窗口。' },
    { name: '加特林机枪', elem: '', desc: '架起加特林向前持续扫射，弹幕密集覆盖一线，能把掩体后的敌人压得抬不起头。' },
    { name: '膝撞', elem: '', desc: '近身屈膝向上猛顶，命中把人顶得倒退并短暂僵直，趁对方弯腰僵直的功夫补上一枪。' },
  ],
  mage: [
    { name: '魔法星弹', elem: '', desc: '凝聚魔力射出一枚星形弹丸，碰到目标炸开星屑灼伤周围敌人，消耗少、出手快。' },
    { name: '杰克爆弹', elem: '', desc: '向前掷出杰克南瓜炸弹，落地引爆火焰吞噬范围敌人，冷却短伤害足，清理成片的小怪。' },
    { name: '冰霜雪人', elem: '', desc: '召唤冰霜雪人扑向敌人，撞碎时寒气四散，能让范围内的敌人减速并造成冰属性伤害。' },
    { name: '魔力护盾', elem: '', desc: '张开一面魔力护盾，正面来的一部分伤害会被吸收，护盾碎裂瞬间把近身敌人震开。' },
  ],
  priest: [
    { name: '圣光十字', elem: '', desc: '挥动十字架划出圣光正面扫落，圣光所过之处魔气消散，对黑暗系魔物格外克制。' },
    { name: '治愈术', elem: '', desc: '引导圣光治愈同伴伤势，肉眼可见愈合，战斗中为前排持续回血，是圣职者的续航核心。' },
    { name: '直拳冲击', elem: '', desc: '把圣光凝聚在拳头上正拳轰出，命中造成可观伤害，并顺势击退敌人、震散其护体效果。' },
    { name: '净化', elem: '', desc: '释放圣光涤荡体表，驱散诅咒毒素等异常，救急时能清空身上负面状态，稳住局面。' },
  ],
};

/* 初始装备：每个职业固定一把对应新手武器（复用 ITEM_CHOICES 的 weapon 项）。 */
const ROOT_WEAPON = { slayer: 'sword', fighter: 'gauntlet', gunner: 'gun', mage: 'staff', priest: 'cross' };
/* 初始治疗药水：3 瓶，创建后与职业武器一起放入随身装备。 */
const STARTER_POTION = { name: '治疗药水', kind: 'pill', qty: 3, desc: '恢复药剂，饮下能愈合伤口。' };

const ITEM_CHOICES = [
  { key: 'sword', name: '新手长刀', kind: 'weapon', desc: '刀鞘做旧，刃口还带着崩口，是初入阿拉德的冒险家最顺手的家伙。' },
  { key: 'gauntlet', name: '格斗护拳', kind: 'weapon', desc: '缠着旧布条的护拳，护腕磨得发亮，一拳下去颇为有力。' },
  { key: 'gun', name: '旧式手枪', kind: 'weapon', desc: '枪身磨得发亮，弹仓里只剩几发子弹，却记着主人的胆量。' },
  { key: 'staff', name: '榆木法杖', kind: 'weapon', desc: '杖尾镶着一颗黯淡的魔法石，握在掌心里微微发温。' },
  { key: 'cross', name: '圣光十字架', kind: 'weapon', desc: '圣职者的护身法器，握久了掌心会泛起一层暖意。' },
  { key: 'torch', name: '火把', kind: 'tool', desc: '浸过松脂的火把，能照亮地下城最黑的角落。' },
  { key: 'treasure_map', name: '寻宝图', kind: 'tool', desc: '半张泛黄的藏宝图，标注着一处古老遗迹的入口。' },
  { key: 'hp_potion', name: '生命药水', kind: 'pill', qty: 3, desc: '恢复药剂，饮下能愈合伤口，聊胜于无。' },
  { key: 'mp_potion', name: '魔力药剂', kind: 'pill', qty: 3, desc: '蓝色的魔力药剂，饮下精神一振，施法更有底气。' },
  { key: 'explosive', name: '爆裂符', kind: 'talisman', desc: '以符文凝成的一次性爆裂咒，掷出即炸，杀伤可观。' },
];

/* 服务端权威生成角色对象（与单机 createRole 同构）：
   skills 为玩家选中的技能名数组（4 选 2），按 ROOT_SKILLS 顺序映射；
   初始装备固定为 职业武器 + 3 瓶治疗药水，直接放入随身装备。 */
function createCharacterObject({ name, rootKey, gender, pers, skills }) {
  const source = ROOT_SKILLS[rootKey] || ROOT_SKILLS.slayer;
  const chosen = (Array.isArray(skills) && skills.length ? skills : source.map(s => s.name));
  const selected = source.filter(s => chosen.includes(s.name)).slice(0, 2);
  const root = ROOT_KEYS[rootKey] || ROOT_KEYS.slayer;
  const rand = () => 1 + Math.floor(Math.random() * 20);
  const now = Date.now();
  const weaponKey = ROOT_WEAPON[rootKey] || ROOT_WEAPON.slayer;
  const weapon = ITEM_CHOICES.find(i => i.key === weaponKey) || ITEM_CHOICES[0];
  return {
    id: now, name: String(name || '').trim(), title: '', status: 'resting', is_mine: true,
    gender: gender === '女' ? '女' : '男',
    hp: 100, max_hp: 100, stamina: 100, max_stamina: 100, level: 1,
    staminaTs: now, hpTs: now,
    strength: rand(), agility: rand(), intelligence: rand(), luck: rand(),
    gold: 100, character_class: root.label, classTitle: null,
    personality: PERS_LIST.includes(pers) ? pers : PERS_LIST[0],
    skills: selected.map(s => ({ ...s })),   // 技能栏：选中的 2 门（最多 5 门）
    skillPool: [],
    equipment: [
      { name: weapon.name, desc: weapon.desc, qty: 1, kind: weapon.kind },
      { ...STARTER_POTION },
    ],
    bag: [],
    consumableSlots: [],
    latest_score: 0, praise_count: 0, is_followed: false,
  };
}

/* 创建表单数据（前端渲染用）；roots 仍是旧字段名，内容为职业列表与候选技能 */
function creationData() {
  return {
    roots: Object.entries(ROOT_KEYS).map(([k, v]) => ({ key: k, ...v, skills: ROOT_SKILLS[k].map(s => ({ name: s.name, desc: s.desc })) })),
    pers: PERS_LIST,
    items: ITEM_CHOICES,
  };
}

module.exports = { createCharacterObject, creationData, ROOT_KEYS, ROOT_SKILLS, ROOT_WEAPON, ITEM_CHOICES, PERS_LIST, MAX_SKILLS };
