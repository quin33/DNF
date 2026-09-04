/* ============================================================
   game-create.js · 在线版角色创建（服务端权威生成）
   常量与数据与单机版 index.html 保持一致（避免依赖拆分改动）
   ============================================================ */

const ROOT_KEYS = { jin: { label: '金灵根', desc: '锋锐果决，与兵刃之道有缘。' }, mu: { label: '木灵根', desc: '生生不息，亲和草木生机。' }, shui: { label: '水灵根', desc: '润物无声，善纳百川。' }, huo: { label: '火灵根', desc: '狂暴炽烈，攻伐凌厉。' }, tu: { label: '土灵根', desc: '沉稳厚重，不动如山。' } };
const PERS_LIST = ['重诺', '好奇', '莽撞', '明哲', '高傲', '仗义', '孤僻', '狡诈'];
const MAX_SKILLS = 5;
const SKILL_TIERS = ['黄阶', '玄阶', '地阶', '天阶'];

const ROOT_SKILLS = {
  jin: [
    { name: '庚金炼体诀', type: '功法', elem: '金灵根', tier: '玄阶', desc: '以庚金之气淬炼体魄，身如精钢，刀枪难伤。' },
    { name: '金刃术', type: '术法', elem: '金灵根', tier: '黄阶', desc: '凝聚一道锋锐金刃，可近可远，削铁如泥。' },
  ],
  mu: [
    { name: '青木养气诀', type: '功法', elem: '木灵根', tier: '黄阶', desc: '吐纳青木生气，绵绵不绝，伤势恢复极快。' },
    { name: '缠藤术', type: '术法', elem: '木灵根', tier: '玄阶', desc: '催生藤蔓缠缚敌人，牵制其行动。' },
  ],
  shui: [
    { name: '玄水凝元功', type: '功法', elem: '水灵根', tier: '地阶', desc: '引水灵凝聚真元，生生不息，神识绵长。' },
    { name: '水箭术', type: '术法', elem: '水灵根', tier: '黄阶', desc: '凝水成箭，破空而去，无声无息。' },
  ],
  huo: [
    { name: '赤炎心法', type: '功法', elem: '火灵根', tier: '天阶', desc: '以心驭火，真元如焰，攻伐猛烈。' },
    { name: '火球术', type: '术法', elem: '火灵根', tier: '黄阶', desc: '凝聚一团赤焰火球，掷向敌手，爆裂灼烧。' },
  ],
  tu: [
    { name: '厚土镇岳诀', type: '功法', elem: '土灵根', tier: '黄阶', desc: '借大地厚土之力护体，稳如泰山。' },
    { name: '土盾术', type: '术法', elem: '土灵根', tier: '玄阶', desc: '凝聚土盾挡于身前，硬撼重击。' },
  ],
};

const ITEM_CHOICES = [
  { key: 'iron_sword', name: '铁剑', kind: 'weapon', desc: '一柄锈迹斑斑的旧铁剑，剑刃缺口处泛着微光。' },
  { key: 'cloth_robe', name: '粗布道袍', kind: 'armor', desc: '粗布缝制的道袍，洗得发白，却异常结实。' },
  { key: 'condense_pill', name: '聚气丹', kind: 'pill', qty: 3, desc: '低阶丹药，服之可凝神聚气，聊胜于无。' },
  { key: 'fire_talisman', name: '火球符', kind: 'talisman', desc: '黄纸朱砂所绘，注入灵力即可激发一团火球。' },
  { key: 'spirit_hoe', name: '灵锄', kind: 'tool', desc: '药园常用之物，据说能掘开灵土。' },
  { key: 'compass', name: '古旧罗盘', kind: 'tool', desc: '指针总是固执地指向迷雾深处。' },
  { key: 'beast_pouch', name: '兽皮囊', kind: 'tool', desc: '妖兽皮缝制的储物袋，能装不少杂物。' },
  { key: 'sound_talisman', name: '传音符', kind: 'talisman', desc: '一张可千里传音的符纸，仅能使用一次。' },
  { key: 'mist_pearl', name: '避瘴珠', kind: 'tool', desc: '千年灵木结成的珠子，可避瘴气毒雾。' },
  { key: 'spirit_lamp', name: '引灵灯', kind: 'tool', desc: '一盏昏黄的油灯，再微弱的灵气角落也能点亮。' },
];

/* 服务端权威生成角色对象（与单机 createRole 同构） */
function createCharacterObject({ name, rootKey, gender, pers, itemKeys }) {
  const root = ROOT_KEYS[rootKey] || ROOT_KEYS.jin;
  const rand = () => 1 + Math.floor(Math.random() * 20);
  const now = Date.now();
  return {
    id: now, name: String(name || '').trim(), title: '', status: 'resting', is_mine: true,
    gender: gender === '女' ? '女' : '男',
    hp: 100, max_hp: 100, stamina: 100, max_stamina: 100, level: 1,
    staminaTs: now, hpTs: now,
    strength: rand(), agility: rand(), intelligence: rand(), luck: rand(),
    gold: 100, character_class: '练气一层',
    personality: PERS_LIST.includes(pers) ? pers : PERS_LIST[0],
    traits: [root.label, '初入仙途'],
    skills: ROOT_SKILLS[rootKey].map(s => ({ ...s })),
    skillPool: [],
    equipment: [],
    bag: (itemKeys || []).slice(0, 2).map(k => { const it = ITEM_CHOICES.find(i => i.key === k); return it ? { name: it.name, desc: it.desc, qty: it.qty || 1, kind: it.kind } : null; }).filter(Boolean),
    consumableSlots: [],
    latest_score: 0, praise_count: 0, is_followed: false,
  };
}

/* 创建表单数据（前端渲染用） */
function creationData() {
  return {
    roots: Object.entries(ROOT_KEYS).map(([k, v]) => ({ key: k, ...v, skills: ROOT_SKILLS[k].map(s => ({ name: s.name, type: s.type, tier: s.tier, desc: s.desc })) })),
    pers: PERS_LIST,
    items: ITEM_CHOICES,
  };
}

module.exports = { createCharacterObject, creationData, ROOT_KEYS, ROOT_SKILLS, ITEM_CHOICES, PERS_LIST, MAX_SKILLS };
