/* ============================================================
   game-create.js · 在线版角色创建（服务端权威生成）
   常量与数据与单机版 index.html 保持一致（避免依赖拆分改动）
   —— DNF60：职业系统（五大初始职业 + Lv10 转职），技能二分类
      物理技/魔法技 + 四档稀有度；字段名兼容旧结构（roots/rootKey）。
   ============================================================ */

// 五大初始职业（key 供前端选择；label=职业名；skills=初始 2 门技能）
const ROOT_KEYS = {
  slayer: { label: '鬼剑士', desc: '以刀剑为伴，斩尽地下城的魔物，出手凌厉，战意冲天。' },
  fighter: { label: '格斗家', desc: '拳拳到肉的近身斗士，身法矫健，信奉硬桥硬马的力量。' },
  gunner: { label: '神枪手', desc: '来自天界与人类的混血枪手，弹仓里装着胆量，靠枪法说话。' },
  mage: { label: '魔法师', desc: '沟通元素的施法者，手中法杖划出火焰与冰霜，一念之间焚尽群魔。' },
  priest: { label: '圣职者', desc: '背负圣光的守护者，既能以铁十字退敌，也能为同伴疗伤续命。' },
};
const PERS_LIST = ['重诺', '好奇', '莽撞', '明哲', '高傲', '仗义', '孤僻', '狡诈'];
const MAX_SKILLS = 5;
const SKILL_TIERS = ['普通', '高级', '稀有', '神器'];

const ROOT_SKILLS = {
  slayer: [
    { name: '里鬼剑术', type: '物理技', elem: '', tier: '普通', desc: '基础剑法，横斩斜挑一气呵成，收势之间暗藏杀机。' },
    { name: '三段斩', type: '物理技', elem: '', tier: '普通', desc: '收剑、送肩、连斩三击，借势前突，地下城起手最稳的一招。' },
  ],
  fighter: [
    { name: '崩拳', type: '物理技', elem: '', tier: '普通', desc: '蓄力一击，拳出如崩山，将面前敌人打得踉跄后退。' },
    { name: '背摔', type: '物理技', elem: '', tier: '普通', desc: '贴身擒抱，借力把敌人掼向地面，土石四溅。' },
  ],
  gunner: [
    { name: '加特林扫射', type: '物理技', elem: '', tier: '高级', desc: '架起重型枪械一顿扫射，弹雨压得敌人抬不起头。' },
    { name: '银弹', type: '魔法技', elem: '', tier: '普通', desc: '给弹头附上圣光，破邪驱魔，击中要害时格外疼痛。' },
  ],
  mage: [
    { name: '魔力弹', type: '魔法技', elem: '', tier: '普通', desc: '指尖凝出一颗刺目的魔力弹，折线扑向敌人。' },
    { name: '火球术', type: '魔法技', elem: '', tier: '普通', desc: '聚一团赤焰火球掷出，落地爆开，灼浪翻涌。' },
  ],
  priest: [
    { name: '圣光十字', type: '物理技', elem: '', tier: '普通', desc: '以十字架划出一道圣光，正面镇压扑来的魔物。' },
    { name: '治愈术', type: '魔法技', elem: '', tier: '高级', desc: '引导圣光疗愈伤势，让人在恶战中喘一口气。' },
  ],
};

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

/* 服务端权威生成角色对象（与单机 createRole 同构） */
function createCharacterObject({ name, rootKey, gender, pers, itemKeys }) {
  const root = ROOT_KEYS[rootKey] || ROOT_KEYS.slayer;
  const rand = () => 1 + Math.floor(Math.random() * 20);
  const now = Date.now();
  return {
    id: now, name: String(name || '').trim(), title: '', status: 'resting', is_mine: true,
    gender: gender === '女' ? '女' : '男',
    hp: 100, max_hp: 100, stamina: 100, max_stamina: 100, level: 1,
    staminaTs: now, hpTs: now,
    strength: rand(), agility: rand(), intelligence: rand(), luck: rand(),
    gold: 100, character_class: root.label, classTitle: null,
    personality: PERS_LIST.includes(pers) ? pers : PERS_LIST[0],
    traits: ['初入阿拉德'],
    skills: (ROOT_SKILLS[rootKey] || ROOT_SKILLS.slayer).map(s => ({ ...s })),
    skillPool: [],
    equipment: [],
    bag: (itemKeys || []).slice(0, 2).map(k => { const it = ITEM_CHOICES.find(i => i.key === k); return it ? { name: it.name, desc: it.desc, qty: it.qty || 1, kind: it.kind } : null; }).filter(Boolean),
    latest_score: 0, praise_count: 0, is_followed: false,
  };
}

/* 创建表单数据（前端渲染用）；roots 仍是旧字段名，内容为职业列表 */
function creationData() {
  return {
    roots: Object.entries(ROOT_KEYS).map(([k, v]) => ({ key: k, ...v, skills: ROOT_SKILLS[k].map(s => ({ name: s.name, type: s.type, tier: s.tier, desc: s.desc })) })),
    pers: PERS_LIST,
    items: ITEM_CHOICES,
  };
}

module.exports = { createCharacterObject, creationData, ROOT_KEYS, ROOT_SKILLS, ITEM_CHOICES, PERS_LIST, MAX_SKILLS };
