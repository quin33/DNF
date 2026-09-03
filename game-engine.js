/* ============================================================
   game-engine.js · 服务端权威副本引擎
   移植自单机版 index.html 的副本核心逻辑（计划/判定/效果/解析），
   供在线房间系统调用；AI 剧情生成由 server.js 注入 callAI 完成。
   ============================================================ */
const GC = require('./game-create.js');
const AI_COMPANIONS = require('./ai-companions.js');
const { normalizeInjuryGrant, clearExpiredInjury } = require('./trait-system.js');
const LootSettlement = require('./loot-settlement.js');

const MAX_SKILLS = 5;
const STAGE_ATTR = { explore: ['intelligence', 'luck'], battle: ['strength', 'agility'], boss: ['strength', 'agility', 'luck'], loot: ['luck', 'intelligence'], breakthrough: ['luck', 'intelligence'] };
const ATTR_NAME = { strength: '力量', agility: '敏捷', intelligence: '智力', luck: '幸运' };
const QI_LAYER = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const NPC_NAME_POOL = AI_COMPANIONS.NPC_NAME_POOL;
const BREAKTHROUGH_EXP = 2000;

function experienceNeeded(level) {
  const value = Number(level || 1);
  return value < 10 ? value * 100 : value < 14 ? value * 200 : 2800;
}
function canBreakthrough(role) {
  return Number(role && role.level) === 10 && Number(role && role.exp) >= BREAKTHROUGH_EXP;
}

const DUNGEON_POOL = [
  { name: '洛兰', hiddenName: '洛兰·魔王洞穴', icon: '🌲', region: '格兰之森', desc: '格兰之森边缘的魔兽林地，哥布林与牛头兵在此劫掠过往旅人。', hiddenDesc: '密林深处藏着一条直通魔王洞穴的暗道，魔气蠢蠢欲动。',
    lore: '这里是冒险家踏入地下城的第一步——格兰之森外围的洛兰，哥布林部落盘踞多年，草木间弥漫着粗野的杀气。',
    explore: ['哥布林扼守的林间小径', '坍塌的边境哨塔', '树根盘绕的幽暗洞穴'],
    enemies: [
      { name: '哥布林', desc: '矮小狡诈的绿色魔物，挥舞木棒，成群结队地袭击落单者。' }, { name: '青哥布林', desc: '皮糙肉厚的哥布林，臂力过人，一棒抡下能砸碎岩石。' }, { name: '猫妖', desc: '灵巧的丛林猎手，爪刃锋利，惯于从树影中扑出。' }, { name: '刀锋猫妖', desc: '爪刃淬过毒的猫妖，出手又快又狠。' }, { name: '牛头兵', desc: '蛮横的牛头魔物，手持锈斧，横冲直撞势不可挡。' }, { name: '赤毛野猪', desc: '獠牙外翻的野猪，受惊后横冲直撞，皮糙肉厚。' },
    ],
    bosses: [
      { name: '烈焰哥布林', desc: '洛兰魔王洞穴的守门领主，手中战斧燃着不灭的火焰。', level: 11, reward: { name: '火焰哥布林战斧', desc: '一柄被烈焰熏得发黑的战斧，斧刃上仍残留灼灼热气。' } }, { name: '牛头巨兵', desc: '洛兰深处被魔气侵蚀的牛头统领，浑身肌肉虬结，一斧劈开山石。', level: 12, reward: { name: '牛头巨兵的裂斧', desc: '断裂的巨斧，斧面刻着扭曲的魔纹。' } },
    ],
    loot: [{ name: '哥布林的木棒', desc: '粗犷的木棒，敲上去闷响。' }, { name: '牛头兵的麻布', desc: '牛头兵裹身的粗麻布，带着一股膻味。' }, { name: '猫妖的利爪', desc: '打磨锋利的猫妖爪刃，泛着冷光。' }] },
  { name: '幽暗密林', hiddenName: '幽暗密林·树精深渊', icon: '🌿', region: '格兰之森', desc: '阳光透不进的深林，树影间潜伏着嗜血的猫妖与巨型哥布林。', hiddenDesc: '越往深处走，古树越粗——那些老树的根系下，似乎埋着什么会呼吸的东西。',
    lore: '幽暗密林的古树已经吞噬了不止一支冒险队。树精与猫妖在这里结成了猎场，专等活人送上门。',
    explore: ['藤蔓垂落的密林小径', '猫妖聚集的枯树广场', '盘根错节的树精巢穴'],
    enemies: [
      { name: '哥布林斥候', desc: '哨探哥布林，瘦小却警觉，一有风吹草动便吹哨示警。' }, { name: '猫妖', desc: '灵巧的丛林猎手，爪刃锋利，惯于从树影中扑出。' }, { name: '巨型哥布林', desc: '哥布林中的异类，体型堪比牛头兵，行动却丝毫不笨拙。' }, { name: '树精', desc: '古树化成的精怪，皮如树皮，挥臂横扫。' }, { name: '毒蘑菇怪', desc: '背生毒斑的蘑菇怪，靠近便释放刺鼻孢子。' }, { name: '猫妖王侍从', desc: '猫妖王的贴身护卫，爪刃缠着血色绷带。' },
    ],
    bosses: [
      { name: '巨型哥布林', desc: '幽暗密林深处的哥布林之王，腰围惊人，巨棒横扫如砍瓜切菜。', level: 11, reward: { name: '巨棒骨饰', desc: '巨型哥布林的骨制饰物，挂满胜利者的牙齿。' } }, { name: '猫妖王', desc: '密林猎场之主，身法快如鬼魅，双爪泛着幽绿的毒光。', level: 12, reward: { name: '猫妖王毒爪', desc: '淬毒的爪刃，刃上绿光幽幽。' } },
    ],
    loot: [{ name: '树精的树皮', desc: '坚韧的树皮，摸上去粗糙温热。' }, { name: '哥布林骨笛', desc: '以兽骨磨制的短笛，呜呜作响。' }, { name: '猫妖的利爪', desc: '打磨锋利的猫妖爪刃，泛着冷光。' }] },
  { name: '雷鸣废墟', hiddenName: '雷鸣废墟·落雷祭坛', icon: '⛈️', region: '格兰之森', desc: '终日被雷电笼罩的哥布林废墟，断壁残垣间电光如蛇。', hiddenDesc: '废墟中央的祭坛上，雷光汇聚——那里的落雷哥布林似乎正在举行某种仪式。',
    lore: '一处被落雷劈毁的古镇废墟，哥布林巫师借雷光立起祭坛，妄图让整片格兰之森臣服于雷鸣之下。',
    explore: ['雷光闪烁的断壁街道', '焦黑的巨型老树', '半塌的哥布林祭坛'],
    enemies: [
      { name: '落雷哥布林', desc: '手持引雷棒的哥布林，棒尖不时迸出滋滋电弧。' }, { name: '落雷哥布林卫兵', desc: '披着藤甲的落雷哥布林，挺着一根缠电的长矛。' }, { name: '夜视猫妖', desc: '能在雷光中蛰伏的猫妖，漆黑皮毛下藏着杀机。' }, { name: '火花哥布林', desc: '口袋里装满火花的哥布林，一扬手便是一蓬灼热火粒。' }, { name: '祭坛石灵', desc: '祭坛崩落的碎石拼成的石灵，行动迟缓却异常沉重。' }, { name: '雷纹蝙蝠', desc: '翅膜上浮着电纹的蝙蝠，成群掠过时带起一片静电。' },
    ],
    bosses: [
      { name: '雷光哥布林指挥官', desc: '落雷祭坛的执鞭者，挥动引雷杖召来一道道落雷。', level: 11, reward: { name: '雷光引雷杖', desc: '一根引雷杖，杖头凝着一团噼啪作响的电光。' } }, { name: '大落雷哥布林', desc: '沐浴雷光而生的巨大哥布林，浑身电弧缠动，踏一步地面便爆出火花。', level: 12, reward: { name: '大落雷之核', desc: '落雷哥布林心口凝成的雷核，触碰时指尖微微发麻。' } },
    ],
    loot: [{ name: '雷击木', desc: '被天雷劈中的古木，木纹间流窜细碎电光。' }, { name: '哥布林引雷棒', desc: '一根粗制的引雷棒，棒头焦黑。' }, { name: '电光尘土', desc: '废墟里刮起的电光尘土，握在手里酥酥麻麻。' }] },
  { name: '格拉卡', hiddenName: '格拉卡·哥布林王都', icon: '⚔️', region: '格兰之森', desc: '哥布林王国的腹地，部落的战旗与牛头兵的铁蹄踏满这片草原。', hiddenDesc: '格拉卡深处的王宫正门洞开——哥布林王似乎正为一场大战秣马厉兵。',
    lore: '格拉卡是格兰之森里最大的哥布林聚居地，部落林立，牛头兵横行。每当有冒险家试图深入，迎来的都是一场恶战。',
    explore: ['战旗猎猎的哥布林营地', '牛头兵巡逻的草原', '哥布林王的宫殿前庭'],
    enemies: [
      { name: '哥布林弓手', desc: '躲在战旗后放冷箭的哥布林，箭法刁钻。' }, { name: '哥布林精英', desc: '披精甲、持短矛的哥布林精锐，纪律严明。' }, { name: '牛头兵', desc: '蛮横的牛头魔物，手持锈斧，横冲直撞势不可挡。' }, { name: '牛头卫兵', desc: '持巨盾的牛头兵，盾墙一立便牢不可破。' }, { name: '哥布林盗贼', desc: '潜行摸包的哥布林，专挑落单者下手。' }, { name: '骸骨猎犬', desc: '食尸而生的魔犬，骨瘦如柴却凶猛异常。' },
    ],
    bosses: [
      { name: '牛头卫兵队长', desc: '格拉卡草原上最壮硕的牛头，扛着一面嵌满钉刺的塔盾。', level: 11, reward: { name: '钉刺塔盾', desc: '一面嵌满铁钉的塔盾，盾面坑坑洼洼，全是交战的伤疤。' } }, { name: '哥布林王·皮鲁斯', desc: '格拉卡哥布林部落之王，头戴骨冠，挥舞的双斧能劈开一整排盾牌。', level: 12, reward: { name: '哥布林王的骨冠', desc: '一顶白骨雕成的王冠，嵌着几颗暗红的宝石。' } },
    ],
    loot: [{ name: '哥布林战旗', desc: '一面残破的哥布林战旗，旗帜上血渍斑斑。' }, { name: '牛头兵的铁环', desc: '牛头兵鼻梁上的铁环，锈迹里带着倔强。' }, { name: '部落矛尖', desc: '粗制的矛尖，仍留着反复淬火的痕迹。' }] },
  { name: '天空之城·龙人之塔', hiddenName: '龙人之塔·断裂之巅', icon: '🐉', region: '天空之城', desc: '悬浮于云海之上的龙人之塔，龙人盘踞塔顶，石巨人镇守廊道。', hiddenDesc: '塔顶的龙人祭坛正在苏醒——传说中的龙人之王似乎要在今日现世。',
    lore: '天空之城崩塌后仅存的龙人之塔，古老龙人一族在此盘踞万年，凝视着脚下的大地。',
    explore: ['云海环绕的塔基廊道', '龙人盘踞的盘旋阶梯', '石巨人镇守的殿堂'],
    enemies: [
      { name: '龙人', desc: '半龙半人的魔物，鳞甲坚硬，利爪能撕裂铁甲。' }, { name: '狂龙人', desc: '狂化的龙人，双目赤红，攻速快得惊人。' }, { name: '石巨人', desc: '以塔身岩石凝聚的巨人，一拳砸地震得石屑纷飞。' }, { name: '翼龙', desc: '盘旋塔外的飞龙，俯冲时翼风呼啸。' }, { name: '龙人卫兵', desc: '持长斧的龙人卫兵，列队成阵，杀意森然。' }, { name: '塔灵', desc: '龙人之塔的古老灵体，无形无影，专扰人心神。' },
    ],
    bosses: [
      { name: '召唤龙人', desc: '龙人一族的守护者，缠着祭坛的古老魔力，召来漫天石与火。', level: 11, reward: { name: '龙人古石', desc: '一枚浸染龙人魔力的古石，内里似有龙影盘旋。' } }, { name: '龙人统领', desc: '龙人塔的至强者，龙鳞泛着暗金光泽，一击便能震断半根塔柱。', level: 12, reward: { name: '龙鳞甲片', desc: '一枚厚重龙鳞，触手冰凉而坚不可摧。' } },
    ],
    loot: [{ name: '龙人鳞片', desc: '一片泛着微光的龙鳞，边缘锋利。' }, { name: '塔岩碎片', desc: '天空之城崩落的塔岩，握在手里轻若无物。' }, { name: '远古石像残块', desc: '石巨人身上崩落的残块，雕刻着看不懂的文字。' }] },
  { name: '天空之城·黑暗玄廊', hiddenName: '黑暗玄廊·深渊之门', icon: '🌌', region: '天空之城', desc: '阳光无法触及的幽暗长廊，石巨人与暗影怪在黑暗中徘徊。', hiddenDesc: '玄廊尽头那扇紧闭的深渊之门，正渗出令人不安的黑暗气息。',
    lore: '黑暗玄廊是天空之城最幽深的角落，巨人与暗影怪把守在此，阻隔着所有窥探深渊的生灵。',
    explore: ['幽暗的玄廊石道', '巨人守卫的空旷大殿', '被封印的深渊之门'],
    enemies: [
      { name: '暗石巨人', desc: '覆着青苔的石巨人，行动迟缓，但一拳足以砸碎石壁。' }, { name: '黑暗鹰', desc: '通体漆黑的鹰，翅展遮光，俯冲无声。' }, { name: '巴罗', desc: '藏在暗处的神秘生物，双爪如钩，伺机扑杀。' }, { name: '暗影蝙蝠', desc: '黑暗里产出的蝙蝠，成群掠过时仿佛一团移动的黑雾。' }, { name: '玄廊魔像', desc: '半毁的魔像，眼窝里燃着幽蓝鬼火。' }, { name: '暗影触手', desc: '深渊之门渗出的黑暗凝成的触手，缠上便拖向深渊。' },
    ],
    bosses: [
      { name: '暗黑石巨像', desc: '黑暗玄廊的镇守巨像，由深渊之石拼成，眼窝两团暗火腾腾。', level: 11, reward: { name: '深渊之石', desc: '巨像眼窝里取出的黑石，握在掌心冰凉彻骨。' } }, { name: '玄廊之主·巴罗王', desc: '蛰伏玄廊深处的巴罗之王，双翼张开几乎遮住整条长廊。', level: 12, reward: { name: '巴罗王之翼', desc: '一片漆黑的翼膜，边缘锋利如刀。' } },
    ],
    loot: [{ name: '暗影晶石', desc: '黑暗里凝结的晶石，触手冰凉。' }, { name: '巨人苔石', desc: '石巨人身上剥落的苔石，覆着厚厚青苔。' }, { name: '玄廊符文', desc: '刻着深渊符文的石片，幽幽发光。' }] },
  { name: '天帷巨兽·神殿外围', hiddenName: '神殿外围·教团密室', icon: '🔱', region: '天帷巨兽', desc: '矗立在天帷巨兽背上的神殿，GBL 教徒在此狂热朝拜。', hiddenDesc: '神殿地底的密室透出诡异的蓝光——教团似乎正谋划着什么不可告人的仪式。',
    lore: '天帷巨兽背上矗立着古老的教团神殿，GBL 教徒在此日夜朝拜，狂热而排外，任何外来者都是他们口中的异端。',
    explore: ['巨兽背上的青石台阶', '教徒诵经的大殿', '教团封锁的地底密室'],
    enemies: [
      { name: 'GBL 教徒', desc: '披着白袍的狂热教徒，手持短杖，口中念念有词。' }, { name: 'GBL 祭司', desc: '教团的司祭，能引动神殿的蓝光化作护盾。' }, { name: '神殿守卫', desc: '守护教团的巨汉，手持铁锤，面容虔诚而冰冷。' }, { name: '空海翼龙', desc: '盘踞神殿上空的海翼龙，俯冲掀起狂风。' }, { name: '教堂僵尸', desc: '被教团仪式复生的僵尸，动作僵硬却力大无穷。' }, { name: '狂热信徒', desc: '被洗脑的狂热信徒，赤手空拳也奋不顾身。' },
    ],
    bosses: [
      { name: 'GBL 主教', desc: '神殿外围的主教，掌中托着一团幽蓝的教团圣火。', level: 11, reward: { name: '教团圣火', desc: '一团不灭的蓝色圣火，封在水晶瓶里静静燃烧。' } }, { name: '教团骑士团长', desc: '教团武装的头目，身披重甲，铁锤落下大地都要颤三颤。', level: 12, reward: { name: '骑士团长铁锤', desc: '一把缠着蓝纹的重锤，锤头还残留着圣火的余温。' } },
    ],
    loot: [{ name: '教团白袍', desc: '一件洗得发白的教团白袍，反复浆洗过。' }, { name: '圣水瓶', desc: '装过圣水的小瓶，瓶壁泛着淡蓝。' }, { name: '神殿残卷', desc: '一卷残破的教团经文，字迹工整。' }] },
];

const rollD20 = () => 1 + Math.floor(Math.random() * 20);
const pick = a => a[Math.floor(Math.random() * a.length)];

/* 敌人强度换算：优先读取数值等级，兼容 "Lv.N" 字符串与旧数值（不保留修仙境界词）。 */
function realmWordToLevel(text) {
  const s = String(text || '');
  const num = Number(s);
  if (Number.isFinite(num) && num > 0) return num;
  const lv = s.match(/Lv\.?(\d+)/i); if (lv) return parseInt(lv[1], 10);
  return 0;
}
function enemyRealmVal(input) {
  if (typeof input === 'number') return input;
  if (typeof input === 'object') {
    if (input && Number.isFinite(Number(input.level)) && Number(input.level) > 0) return Number(input.level);
    return realmWordToLevel(input && input.realm);
  }
  return realmWordToLevel(input);
}
function actorRealmVal(actor) { const lv = Number(actor && actor.level); return Number.isFinite(lv) && lv > 0 ? lv : 1; }
function realmDiffMod(actor, enemy) { if (!enemy) return 0; const ev = enemyRealmVal(enemy); if (!ev) return 0; return Math.max(-4, Math.min(4, actorRealmVal(actor) - ev)); }
function realmBonus(actor) { return Math.min(9, Math.floor(((actor.level || 1) - 1) / 2)); }
function elemMatchMod(actor, sk) {
  // DNF60：技能无五行属性、角色无特质，元素契合恒为 0；保留签名以最小化调用处改动。
  return 0;
}

const ITEM_BONUS = [
  { kw: '火把', stage: 'explore', mod: 2 }, { kw: '寻宝图', stage: 'explore', mod: 2 }, { kw: '布甲', stage: 'explore', mod: 1 },
  { kw: '生命药水', stage: 'explore', mod: 1 }, { kw: '短剑', stage: 'battle', mod: 1 }, { kw: '长刀', stage: 'battle', mod: 1 },
  { kw: '格斗护拳', stage: 'battle', mod: 2 }, { kw: '旧式手枪', stage: 'battle', mod: 2 }, { kw: '榆木法杖', stage: 'battle', mod: 2 },
  { kw: '圣光十字架', stage: 'battle', mod: 1 }, { kw: '圣光符', stage: 'battle', mod: 1 }, { kw: '爆裂符', stage: 'battle', mod: 2 },
  { kw: '魔力药剂', stage: 'battle', mod: 1 }, { kw: '旧怀表', stage: 'loot', mod: 1 }, { kw: '绷带', stage: 'loot', mod: 1 },
];
function itemBonus(dg, stage) { let b = 0; dg.party.forEach(m => (m.equipment || []).forEach(it => { const hit = ITEM_BONUS.find(x => x.stage === stage && (it.name || '').includes(x.kw)); if (hit) b += hit.mod; })); return Math.min(b, 4); }

/* 开本：随机 0~3 敌人（特殊事件必 ≥1 且等级上调）、首领定型 */
function rollEnemies(dungeon, specialEvent) {
  const pool = (dungeon.enemies || []).slice();
  const n = specialEvent ? 1 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 4);
  const picked = [];
  while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return picked.map(e => { let level = 1 + Math.floor(Math.random() * 10); if (specialEvent) level = Math.min(10, level + 2 + Math.floor(Math.random() * 3)); return { ...e, level }; });
}
function pickDungeon(role) {
  const pool = DUNGEON_POOL.filter(d => d.rank * 0 + (role.level || 1) <= 18);
  const idx = Math.min(pool.length - 1, Math.floor(((role.level || 1) - 1) / 3) + Math.floor(Math.random() * 2));
  return DUNGEON_POOL[Math.max(0, Math.min(idx, DUNGEON_POOL.length - 1))];
}
/* 副本阶段计划：联机与单机统一为 10~40 段。加权分配；首领始终可；突破/特殊事件影响 */
function buildPlan(isHidden, enemyCount, specialEvent, breakthrough) {
  const hasBoss = isHidden || specialEvent || Math.random() < 0.1;
  const hasBattle = (enemyCount || 0) > 0;
  const total = 10 + Math.floor(Math.random() * 31);
  const minE = 2, minL = 2, minB = hasBattle ? 2 : 0, minBo = hasBoss ? (isHidden ? 2 : 1) : 0;
  let explore = minE, loot = minL, battle = minB, boss = minBo;
  let extra = Math.max(0, total - 2 - minE - minL - minB - minBo);
  while (extra > 0) { const r = Math.random(); if (r < 0.34) explore++; else if (r < 0.58) loot++; else if (r < 0.82 && hasBattle) battle++; else if (hasBoss) boss++; else explore++; extra--; }
  const p = [ { key: 'opening', label: '进入地下城', steps: 1, check: false }, { key: 'explore', label: '探索', steps: explore, check: true } ];
  if (hasBattle) p.push({ key: 'battle', label: '战斗', steps: battle, check: true });
  if (hasBoss) p.push({ key: 'boss', label: '首领', steps: boss, check: true });
  p.push({ key: 'loot', label: '搜刮', steps: loot, check: true });
  if (breakthrough) p.push({ key: 'breakthrough', label: '晋级', steps: 1 + Math.floor(Math.random() * 2), check: true });
  p.push({ key: 'closing', label: '撤离回城', steps: 1, check: false });
  return p;
}
/* 叙事焦点调度：把连续步骤分成 2~3 步的角色窗口，最后一步完成个人高光。 */
function buildNarrativeFocusPlan(dg) {
  const partySize = Math.max(1, (dg.party || []).length);
  const middle = [];
  for (const plan of dg.plan || []) {
    if (plan.key === 'opening' || plan.key === 'closing') continue;
    for (let i = 0; i < (plan.steps || 0); i++) middle.push({ stageKey: plan.key });
  }
  let cursor = 0;
  let remaining = middle.length;
  let windowId = 0;
  let actorIndex = 0;
  const windowCount = remaining > 0 ? Math.max(Math.ceil(remaining / 3), Math.min(partySize, Math.floor(remaining / 2))) : 0;
  const baseWindowSize = windowCount ? Math.floor(remaining / windowCount) : 0;
  let largerWindows = windowCount ? remaining % windowCount : 0;
  while (remaining > 0) {
    const size = remaining === 1 ? 1 : baseWindowSize + (largerWindows > 0 ? 1 : 0);
    if (largerWindows > 0) largerWindows--;
    const currentWindow = windowId++;
    for (let i = 0; i < size && cursor < middle.length; i++, cursor++) {
      const isHighlight = i === size - 1;
      middle[cursor] = {
        ...middle[cursor], mode: 'focus', windowId: currentWindow, focusStep: i + 1, windowSize: size,
        actorIndex, supportIndex: isHighlight || partySize < 2 ? null : (actorIndex + 1) % partySize,
        support2Index: isHighlight || partySize < 3 ? null : (actorIndex + 2) % partySize,
        highlight: isHighlight,
      };
    }
    actorIndex = (actorIndex + 1) % partySize;
    remaining -= size;
  }
  const breakthroughEntries = middle.filter(step => step.stageKey === 'breakthrough');
  if (breakthroughEntries.length) {
    const breakthroughWindowId = windowId++;
    breakthroughEntries.forEach((step, index) => Object.assign(step, {
      windowId: breakthroughWindowId,
      focusStep: index + 1,
      windowSize: breakthroughEntries.length,
      actorIndex: 0,
      supportIndex: null,
      support2Index: null,
      highlight: index === breakthroughEntries.length - 1,
    }));
  }
  const ordered = [];
  let middleIndex = 0;
  for (const plan of dg.plan || []) {
    for (let i = 0; i < (plan.steps || 0); i++) {
      if (plan.key === 'opening' || plan.key === 'closing') {
        ordered.push({ stageKey: plan.key, mode: 'group', windowId: null, focusStep: 1, windowSize: 1, actorIndex: 0, supportIndex: partySize > 1 ? 1 : null, support2Index: partySize > 2 ? 2 : null, highlight: false });
      } else {
        ordered.push(middle[middleIndex++]);
      }
    }
  }
  return ordered;
}
function dynamicNarrativeFocus(dg, stageKey) {
  const partySize = Math.max(1, (dg.party || []).length);
  const stepNo = Number(dg.totalStep || 0);
  const group = stepNo === 0 || stageKey === 'opening' || stageKey === 'closing' || stageKey === 'retreat';
  return group
    ? { stageKey, mode: 'group', windowId: null, focusStep: 1, windowSize: 1, actorIndex: 0, supportIndex: partySize > 1 ? 1 : null, support2Index: partySize > 2 ? 2 : null, highlight: false }
    : (() => {
      const offset = stepNo - 1;
      const focusStep = (offset % 2) + 1;
      const highlight = focusStep === 2;
      return { stageKey, mode: 'focus', windowId: Math.floor(offset / 2), focusStep, windowSize: 2, actorIndex: Math.floor(offset / 2) % partySize, supportIndex: highlight || partySize < 2 ? null : (Math.floor(offset / 2) + 1) % partySize, support2Index: highlight || partySize < 3 ? null : (Math.floor(offset / 2) + 2) % partySize, highlight };
    })();
}
function appendDynamicNarrativeFocus(dg, stageKey) {
  dg.focusPlan = Array.isArray(dg.focusPlan) ? dg.focusPlan : [];
  const focus = dynamicNarrativeFocus(dg, stageKey);
  dg.focusPlan.push(focus);
  return focus;
}
function memberIdentity(member) {
  if (!member) return null;
  return member.uid || member.id || member.charId || member.name || null;
}
function itemIsConsumable(item) {
  if (!item) return false;
  if (item.consumable === true) return true;
  return ['pill', 'talisman', 'consumable'].includes(String(item.kind || '').toLowerCase());
}
function findMemberItem(member, item, preferredSrc) {
  if (!member || !item) return null;
  const lists = preferredSrc === 'bag' ? [['bag', member.bag || []], ['equipment', member.equipment || []]]
    : preferredSrc === 'equipment' ? [['equipment', member.equipment || []], ['bag', member.bag || []]]
      : [['equipment', member.equipment || []], ['bag', member.bag || []]];
  const name = String(item.name || '');
  for (const [src, list] of lists) {
    const found = list.find(entry => entry && String(entry.name || '') === name && Number(entry.qty == null ? (entry.count == null ? 1 : entry.count) : entry.qty) > 0);
    if (found) return { src, item: found };
  }
  return null;
}
function normalizeLoanRecord(record) {
  if (!record || !record.ownerId || !record.userId || !record.name) return null;
  return {
    name: String(record.name), ownerId: record.ownerId, userId: record.userId,
    qty: Math.max(1, Number(record.qty || 1)), src: record.src || 'bag',
    kind: record.kind || 'misc', consumable: itemIsConsumable(record),
    itemRef: record.itemRef || null,
  };
}
function recordItemLoan(dg, lender, borrower, item, qty = 1) {
  if (!dg) throw new Error('缺少副本状态');
  const located = findMemberItem(lender, item);
  if (!located) throw new Error('出借人未持有该道具');
  const ownerId = memberIdentity(lender), userId = memberIdentity(borrower);
  if (!ownerId || !userId || ownerId === userId) throw new Error('无效的道具借出关系');
  dg.itemLoans = Array.isArray(dg.itemLoans) ? dg.itemLoans : [];
  const available = Number(located.item.qty == null ? (located.item.count == null ? 1 : located.item.count) : located.item.qty);
  const loanQty = Math.max(1, Math.min(Number(qty || 1), available));
  const existing = dg.itemLoans.find(loan => loan.ownerId === ownerId && loan.userId === userId && loan.name === String(item.name));
  if (existing) existing.qty += loanQty;
  else dg.itemLoans.push({ name: String(item.name), ownerId, userId, qty: loanQty, src: located.src, kind: item.kind || located.item.kind || 'misc', consumable: itemIsConsumable(item), itemRef: located.item, loaned: true });
  const loan = existing || dg.itemLoans[dg.itemLoans.length - 1];
  return { item: { ...located.item, name: String(located.item.name), ownerId, userId, loaned: true, loanQty: loan.qty, source: located.src }, ownerId, userId, loaned: true };
}
function consumeItemUse(dg, use, options = {}) {
  const itemUse = use || {};
  const item = itemUse.item || itemUse;
  if (!item || !itemUse.success || options.explicitUse !== true) return { consumed: false, reason: 'not-explicit-success' };
  if (!itemIsConsumable(item)) return { consumed: false, reason: 'non-consumable' };
  const ownerId = item.ownerId || memberIdentity(item.owner);
  const userId = item.userId || memberIdentity(options.actor) || ownerId;
  const owner = (dg.party || []).find(member => memberIdentity(member) === ownerId);
  const located = findMemberItem(owner, item, item.source);
  if (!owner || !located) return { consumed: false, reason: 'owner-item-missing' };
  const current = Number(located.item.qty == null ? (located.item.count == null ? 1 : located.item.count) : located.item.qty);
  const next = Math.max(0, current - 1);
  if (located.item.qty != null) located.item.qty = next; else if (located.item.count != null) located.item.count = next;
  if (next <= 0) {
    const list = owner[located.src] || [];
    const index = list.indexOf(located.item);
    if (index >= 0) list.splice(index, 1);
  }
  const loan = (dg.itemLoans || []).find(entry => entry.ownerId === ownerId && entry.userId === userId && entry.name === String(item.name));
  if (loan) { loan.qty -= 1; if (loan.qty <= 0) dg.itemLoans.splice(dg.itemLoans.indexOf(loan), 1); }
  dg.consumed = Array.isArray(dg.consumed) ? dg.consumed : [];
  const record = { name: String(item.name), ownerId, userId, qty: 1 };
  if (typeof item.loaned === 'boolean') record.loaned = item.loaned;
  if (!item.source) record.src = located.src === 'equipment' ? 'equip' : located.src;
  dg.consumed.push(record);
  return { consumed: true, ...record };
}
function settleItemLoans(dg) {
  const loans = Array.isArray(dg && dg.itemLoans) ? dg.itemLoans : [];
  const returned = loans.filter(loan => Number(loan.qty || 0) > 0).map(loan => ({ name: loan.name, ownerId: loan.ownerId, userId: loan.userId, qty: Number(loan.qty || 0) }));
  if (dg) dg.itemLoans = [];
  return returned;
}
function itemUseExplicitInText(text, item, actor) {
  const body = String(text || '');
  const name = String(item && item.name || '');
  if (!name || !body.includes(name)) return false;
  const actorName = actor && actor.name ? String(actor.name) : '';
  if (actorName && !body.includes(actorName)) return false;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sentence = body.split(/[。！？\\n]/).find(part => part.includes(name)) || body;
  if (/(?:未能|没能|无法|没有|未曾|并未|不曾|未成功|失败|未激发|未使用)/.test(sentence)) return false;
  const action = '(?:服下|吞下|饮下|服用|使用|激发|催动|掷出|祭出|引爆|捏碎|燃起|贴上|吞服)';
  return new RegExp(`${action}\\s*[^。！？\\n]{0,24}${escapedName}`).test(sentence)
    || new RegExp(`${escapedName}[^。！？\\n]{0,24}${action}`).test(sentence);
}
function collectItemLoansFromText(dg, text) {
  const body = String(text || '');
  const records = [];
  const party = dg && Array.isArray(dg.party) ? dg.party : [];
  for (const lender of party) {
    for (const borrower of party) {
      if (!lender || !borrower || memberIdentity(lender) === memberIdentity(borrower)) continue;
      const inventory = [...(lender.equipment || []), ...(lender.bag || [])];
      for (const item of inventory) {
        const itemName = String(item && item.name || '');
        if (!itemName || !body.includes(itemName) || !body.includes(lender.name) || !body.includes(borrower.name)) continue;
        const located = findMemberItem(lender, item);
        if (!located) continue;
        const lenderName = String(lender.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const borrowerName = String(borrower.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedItem = itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const explicit = new RegExp(`${lenderName}[^。！？\\n]{0,40}(?:借给|借出|递给|交给|给了|交予|托给|借予|暂借|借来|借与)[^。！？\\n]{0,20}${borrowerName}[^。！？\\n]{0,20}${escapedItem}`).test(body)
          || new RegExp(`${lenderName}[^。！？\\n]{0,40}${escapedItem}[^。！？\\n]{0,20}(?:借给|借出|递给|交给|给了|交予|托给|借予|暂借|借来|借与)[^。！？\\n]{0,20}${borrowerName}`).test(body)
          || new RegExp(`${escapedItem}[^。！？\\n]{0,20}(?:借给|借出|递给|交给|给了|交予|托给|借予|暂借|借来|借与)[^。！？\\n]{0,20}${borrowerName}`).test(body);
        if (explicit) {
          records.push({
            name: itemName,
            ownerId: memberIdentity(lender),
            userId: memberIdentity(borrower),
            qty: 1,
            src: located.src,
            kind: item.kind || located.item.kind || 'misc',
            consumable: itemIsConsumable(item),
            itemRef: located.item,
          });
        }
      }
    }
  }
  return records;
}
function recordItemLoansFromText(dg, text) {
  const records = [];
  const party = dg && Array.isArray(dg.party) ? dg.party : [];
  for (const loan of collectItemLoansFromText(dg, text)) {
    const lender = party.find(member => memberIdentity(member) === loan.ownerId);
    const borrower = party.find(member => memberIdentity(member) === loan.userId);
    const located = lender && findMemberItem(lender, loan.itemRef || { name: loan.name }, loan.src);
    if (!lender || !borrower || !located) continue;
    try { records.push(recordItemLoan(dg, lender, borrower, located.item, loan.qty)); } catch (_) { /* stale text cannot grant a loan */ }
  }
  return records;
}
function registerLootOwnership(dg, actor, names) {
  if (!dg || !actor || !Array.isArray(names)) return [];
  dg.itemRegistry = Array.isArray(dg.itemRegistry) ? dg.itemRegistry : [];
  const ownerId = memberIdentity(actor);
  const ownerName = actor.name || '';
  const added = [];
  for (const name of names) {
    const key = String(name || '').trim();
    if (!key) continue;
    const existing = dg.itemRegistry.find(entry => entry.name === key && entry.ownerId === ownerId);
    if (existing) continue;
    const entry = { name: key, ownerId, ownerName };
    dg.itemRegistry.push(entry);
    added.push(entry);
  }
  return added;
}
function collectOwnedItems(dg, options = {}) {
  const out = [];
  const seen = new Set();
  const add = (name, owner) => {
    const key = String(name || '').trim();
    if (!key || !owner) return;
    const ownerId = memberIdentity(owner);
    const record = `${key}|${ownerId}`;
    if (seen.has(record)) return;
    seen.add(record);
    out.push({ name: key, ownerId, ownerName: owner.name || '' });
  };
  for (const member of (dg && Array.isArray(dg.party) ? dg.party : [])) {
    for (const item of [...(member.equipment || []), ...(member.bag || [])]) add(item && item.name, member);
  }
  for (const entry of (dg && Array.isArray(dg.itemRegistry) ? dg.itemRegistry : [])) {
    const owner = (dg.party || []).find(member => memberIdentity(member) === entry.ownerId);
    add(entry.name, owner || { id: entry.ownerId, name: entry.ownerName });
  }
  for (const name of (options.lootNames || [])) add(name, options.actor);
  return out;
}
function validateStepItemUsage(dg, text, options = {}) {
  const body = String(text || '');
  if (!body.trim()) return [];
  const party = dg && Array.isArray(dg.party) ? dg.party : [];
  const items = collectOwnedItems(dg, options);
  const ownersByItem = new Map();
  for (const item of items) {
    const list = ownersByItem.get(item.name) || [];
    list.push(item);
    ownersByItem.set(item.name, list);
  }
  const allowedUsers = new Set();
  for (const loan of [...(Array.isArray(dg.itemLoans) ? dg.itemLoans : []), ...collectItemLoansFromText(dg, body)]) {
    allowedUsers.add(`${loan.userId}|${loan.name}`);
  }
  const violations = [];
  const seenViolations = new Set();
  const clauses = body.split(/[。！？\n；，、]/).map(part => part.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const [itemName, ownerList] of ownersByItem) {
      if (!clause.includes(itemName)) continue;
      const hasAction = /(?:取出|拿出|拿起|握|攥|摇|摇动|使用|祭出|催动|掷出|抛出|抛向|抡|挥舞|服用|服下|吞下|吞服|激发|引爆|捏碎|举起|抵|贴上|现出|收入怀中|塞入怀中|收下|裹紧|借用|借|用)/.test(clause);
      if (!hasAction) continue;
      for (const member of party) {
        if (!member || !member.name || !clause.includes(member.name)) continue;
        const memberId = memberIdentity(member);
        if (ownerList.some(owner => owner.ownerId === memberId)) continue;
        if (allowedUsers.has(`${memberId}|${itemName}`)) continue;
        const key = `${itemName}|${memberId}|${ownerList[0].ownerId}|${clause}`;
        if (seenViolations.has(key)) continue;
        seenViolations.add(key);
        violations.push({
          item: itemName,
          owner: ownerList[0].ownerName,
          ownerId: ownerList[0].ownerId,
          user: member.name,
          userId: memberId,
          sentence: clause,
        });
      }
    }
  }
  return violations;
}
function itemGuardFeedback(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return '';
  const lines = list.map(v => `${v.item}归${v.owner}所有，未经明确借出，${v.user}不得使用或持有。请重写：要么改为${v.owner}使用，要么先由${v.owner}明确将${v.item}借给${v.user}。`);
  return '【道具归属纠正】\n' + lines.join('\n');
}
function availableItemsForActor(dg, actor) {
  const userId = memberIdentity(actor);
  if (!userId) return [];
  const out = [];
  const add = (entry, owner, src, loaned = false) => {
    if (!entry || Number(entry.qty == null ? (entry.count == null ? 1 : entry.count) : entry.qty) <= 0) return;
    out.push({ name: entry.name, kind: entry.kind || 'misc', desc: entry.desc || '', ownerId: memberIdentity(owner), ownerName: owner && owner.name || '', userId, userName: actor.name || '', loaned, source: src });
  };
  const borrowedQty = new Map();
  (dg.itemLoans || []).filter(loan => loan.ownerId === userId && Number(loan.qty || 0) > 0)
    .forEach(loan => borrowedQty.set(loan.name, (borrowedQty.get(loan.name) || 0) + Number(loan.qty || 0)));
  const addOwn = (item, src) => {
    const available = Number(item && (item.qty == null ? (item.count == null ? 1 : item.count) : item.qty));
    const usable = Math.max(0, available - (borrowedQty.get(item && item.name) || 0));
    if (usable > 0) add({ ...item, qty: usable }, actor, src);
  };
  (actor.equipment || []).forEach(item => addOwn(item, 'equipment'));
  (actor.bag || []).forEach(item => addOwn(item, 'bag'));
  (dg.itemLoans || []).filter(loan => loan.userId === userId && Number(loan.qty || 0) > 0).forEach(loan => {
    const owner = (dg.party || []).find(member => memberIdentity(member) === loan.ownerId);
    const located = findMemberItem(owner, loan, loan.src);
    if (located) add({ ...located.item, ...loan }, owner, located.src, true);
  });
  return out;
}
/* 物品判定（探索/搜刮步按概率尝试；默认仅行动角色自有物品，明确借出例外） */
function itemUseCheck(dg, stageKey, actor) {
  if (stageKey === 'explore' && Math.random() > 0.4) return null;
  if (stageKey === 'loot' && Math.random() > 0.25) return null;
  const pool = [];
  const currentActor = actor || (dg.party || [])[0];
  const ownerId = memberIdentity(currentActor);
  const add = (entry, src, owner, loaned = false) => {
    const hit = ITEM_BONUS.find(x => x.stage === stageKey && (entry.name || '').includes(x.kw));
    if (hit && Number(entry.qty == null ? (entry.count == null ? 1 : entry.count) : entry.qty) > 0) pool.push({ ...entry, kind: entry.kind || 'misc', owner, ownerId: memberIdentity(owner), userId: ownerId, loaned, source: src, mod: hit.mod });
  };
  if (currentActor) {
    const borrowedQty = new Map();
    (dg.itemLoans || []).filter(loan => loan.ownerId === ownerId && Number(loan.qty || 0) > 0).forEach(loan => borrowedQty.set(loan.name, (borrowedQty.get(loan.name) || 0) + Number(loan.qty || 0)));
    const addOwn = (it, src) => {
      const available = Number(it && (it.qty == null ? (it.count == null ? 1 : it.count) : it.qty));
      const usable = Math.max(0, available - (borrowedQty.get(it && it.name) || 0));
      if (usable <= 0) return;
      add({ ...it, qty: usable }, src, currentActor);
    };
    (currentActor.equipment || []).forEach(it => addOwn(it, 'equipment'));
    (currentActor.bag || []).forEach(it => addOwn(it, 'bag'));
  }
  (dg.itemLoans || []).filter(loan => loan.userId === ownerId && Number(loan.qty || 0) > 0).forEach(loan => {
    const lender = (dg.party || []).find(member => memberIdentity(member) === loan.ownerId);
    const located = findMemberItem(lender, loan, loan.src);
    if (located) add({ ...located.item, ...loan }, located.src, lender, true);
  });
  if (!pool.length) return null;
  const it = pick(pool); const roll = rollD20(); const total = roll + (it.mod || 0);
  return { item: it, roll, total, success: total >= 12 };
}
/* 技能判定：D20 + 基础技能修正2 + 元素契合±0/+2，成功 ≥12 */
function skillUseCheck(dg, stageKey, actor) {
  const skills = actor.skills || []; if (!skills.length) return null;
  const p = (stageKey === 'battle' || stageKey === 'boss') ? 1 : stageKey === 'explore' ? 0.6 : 0.35;
  if (Math.random() > p) return null;
  const sk = pick(skills); const elemMod = elemMatchMod(actor, sk); const roll = rollD20();
  const total = roll + 2 + elemMod;
  return { name: sk.name, elem: sk.elem || '', desc: sk.desc || '', elemMod, roll, total, success: total >= 12 };
}
/* 解析剧情【获得：…】标记 */
function parseLootMarkers(text) {
  const out = [];
  const re = /【获得：([^】]+)】/g; let m;
  while ((m = re.exec(text)) && out.length < 6) {
    (m[1] || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean).forEach(n => {
      const name = String(n).replace(/\s+/g, '').trim().slice(0, 12);
      if (LootSettlement.isValidLootName(name) && !out.some(x => x.name === name)) out.push({ name, desc: '' });
    });
  }
  return out;
}
function extractGold(text) {
  const m = String(text || '').match(/金币\s*([一二两三四五六七八九十百千万]+|)\s*(\d+)/);
  if (m) return parseInt(m[2], 10) || 0;
  const m2 = String(text || '').match(/(\d+)\s*[枚个]?\s*金币/);
  return m2 ? parseInt(m2[1], 10) : 30;
}

const STEP_OUTCOMES = ['crit', 'good', 'mid', 'bad', 'fumble'];

function normalizeNamedResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').trim().slice(0, 20);
  if (!name) return null;
  return { name, success: raw.success === true };
}

/* AI 单步结果归一化：AI 直接决定成败、伤害、道具/技能使用与掉落。 */
function normalizeAiStepResult(raw, fallback = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const fallbackOutcome = STEP_OUTCOMES.includes(fallback.outcome) ? fallback.outcome : 'mid';
  const outcome = STEP_OUTCOMES.includes(input.outcome) ? input.outcome : fallbackOutcome;
  const damage = Number.isFinite(Number(input.damage)) ? Math.max(0, Math.round(Number(input.damage))) : 0;
  const itemUse = normalizeNamedResult(input.itemUse);
  const skillUse = normalizeNamedResult(input.skillUse);
  const loot = (Array.isArray(input.loot) ? input.loot : []).map(entry => {
    const name = String(entry && entry.name || '').replace(/\s+/g, '').trim().slice(0, 12);
    if (!LootSettlement.isValidLootName(name)) return null;
    const qty = Math.max(1, Math.min(99, Math.round(Number(entry && entry.qty) || 1)));
    const candidate = LootSettlement.normalizeRarity(entry && entry.rarity);
    const rarity = LootSettlement.OPEN_DROP_RARITIES.includes(candidate) ? candidate : null;
    return { name, qty, rarity };
  }).filter(Boolean);
  return { outcome, damage, itemUse, skillUse, loot };
}

/* AI 掉落登记：合并数量与稀有度，并把道具名登记给获得它的角色。 */
function recordAiLoot(dg, actor, entries) {
  const names = [];
  dg.aiLoot = Array.isArray(dg.aiLoot) ? dg.aiLoot : [];
  for (const entry of entries || []) {
    const name = String(entry && entry.name || '').replace(/\s+/g, '').trim().slice(0, 12);
    if (!LootSettlement.isValidLootName(name)) continue;
    const qty = Math.max(1, Math.min(99, Math.round(Number(entry && entry.qty) || 1)));
    const candidate = LootSettlement.normalizeRarity(entry && entry.rarity);
    const rarity = LootSettlement.OPEN_DROP_RARITIES.includes(candidate) ? candidate : null;
    const existing = dg.aiLoot.find(x => x.name === name);
    if (existing) existing.qty += qty;
    else dg.aiLoot.push({ name, qty, rarity });
    if (!names.includes(name)) names.push(name);
  }
  if (names.length && typeof registerLootOwnership === 'function') registerLootOwnership(dg, actor, names);
  return names;
}

/* AI 开本参数落库：隐藏/特殊事件/突破由 AI 决定，敌人名称限定在副本池内。 */
function applyDungeonSetup(base, setup) {
  const s = setup || {};
  const isHidden = s.isHidden === true;
  const specialEvent = s.specialEvent === true;
  const breakthrough = s.breakthrough === true;
  const pool = Array.isArray(base && base.enemies) ? base.enemies : [];
  const chosen = (Array.isArray(s.enemies) ? s.enemies : []).map(entry => {
    const name = String(entry && entry.name || '').replace(/\s+/g, '').trim();
    const src = pool.find(x => String(x.name || '').trim() === name);
    if (!src) return null;
    const level = realmWordToLevel(entry && (entry.level != null ? entry.level : entry.realm));
    return { ...src, level: Number.isFinite(level) && level > 0 ? level : 1 };
  }).filter(Boolean).slice(0, specialEvent ? 4 : 3);
  const bosses = (base && Array.isArray(base.bosses) ? base.bosses : []).map((b, i) => ({ ...b, level: i === 1 ? 12 : 11 }));
  return {
    ...base,
    name: isHidden && base ? (base.hiddenName || base.name) : (base && base.name) || '',
    desc: isHidden && base ? (base.hiddenDesc || base.desc) : (base && base.desc) || '',
    isHidden, baseName: base && base.name, enemies: chosen, bosses, specialEvent, breakthrough,
  };
}

/* 单步效果应用：受伤/首领掉落/异常特质（服务端权威修改 party 成员状态） */
function applyStageEffects(dg, stageKey, actor, total, outcome, aiDamage) {
  const g = dg.memberGains[actor.id];
  const hurt = n => {
    const dmg = Number.isFinite(Number(aiDamage)) && Number(aiDamage) > 0 ? Math.round(Number(aiDamage)) : n;
    actor.hp = Math.max(0, (actor.hp || 0) - dmg);
    dg.damage += dmg;
    if (g) g.damage += dmg;
    if (actor.hp <= 0 && !actor.isDead) {
      actor.isDead = true;
      dg.deaths = Array.isArray(dg.deaths) ? dg.deaths : [];
      dg.deaths.push(actor.name);
    }
  };
  if (stageKey === 'battle') {
    if (outcome === 'bad') hurt(8 + Math.floor(Math.random() * 12));
    if (outcome === 'fumble') hurt(20 + Math.floor(Math.random() * 20));
    if (outcome === 'crit' && (actor.equipment || []).find(i => i.name.includes('爆裂符'))) hurt(8);
  }
  if (stageKey === 'boss') {
    const boss = dg._curEnemy;
    if (outcome === 'crit' || outcome === 'good') {
      if (boss && boss.reward && !dg.bossDrops.some(r => r.name === boss.reward.name)) dg.bossDrops.push(boss.reward);
      if (outcome === 'crit') hurt(4 + Math.floor(Math.random() * 8)); else hurt(10 + Math.floor(Math.random() * 12));
    } else if (outcome === 'mid') hurt(18 + Math.floor(Math.random() * 12));
    else if (outcome === 'bad') hurt(24 + Math.floor(Math.random() * 16));
    else hurt(35 + Math.floor(Math.random() * 25));
  }
  if (stageKey === 'explore' && outcome === 'fumble') hurt(12 + Math.floor(Math.random() * 12));
  if (stageKey === 'loot' && outcome === 'fumble') hurt(6);
  if (stageKey === 'breakthrough' && (outcome === 'good' || outcome === 'crit')) dg.breachSuccess = true;
}

function regenerateHp(role, now = Date.now()) {
  if (!role) return false;
  if (role.status === 'adventuring') { role.hpTs = now; return false; }
  const ts = Number.isFinite(Number(role.hpTs)) ? Number(role.hpTs) : now;
  const max = Number(role.max_hp || 100);
  if (ts > now) { role.hpTs = now; return false; }
  const intervalMs = 3 * 60 * 1000;
  const intervals = Math.floor((now - ts) / intervalMs);
  if (intervals <= 0) return false;
  const before = Number(role.hp || 0);
  role.hp = Math.min(max, before + intervals);
  role.hpTs = role.hp >= max ? now : ts + intervals * intervalMs;
  return role.hp !== before;
}

function regenerateStamina(role, now = Date.now()) {
  if (!role) return false;
  const ts = Number.isFinite(Number(role.staminaTs)) ? Number(role.staminaTs) : now;
  const max = Number(role.max_stamina || 100);
  if (ts > now) { role.staminaTs = now; return false; }
  const minutes = Math.floor((now - ts) / 60000);
  if (minutes <= 0) return false;
  const before = Number(role.stamina || 0);
  role.stamina = Math.min(max, before + minutes);
  role.staminaTs = role.stamina >= max ? now : ts + minutes * 60000;
  return role.stamina !== before;
}

function assignLoot(items, members, random = Math.random) {
  return LootSettlement.assignLoot(items, members, random);
}

function hasDuplicateCharacterName(name, characters) {
  const target = String(name || '').trim();
  return !!target && (characters || []).some(character => String(character && character.name || '').trim() === target);
}

function applyLevelGrowth(role, options = {}) {
  const breakthrough = !!options.breakthrough;
  const statIndexes = Array.isArray(options.statIndexes) ? options.statIndexes : [];
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const hpGain = breakthrough ? 0 : Number.isFinite(options.hpGain) ? options.hpGain : (role.level <= 10 ? 20 + Math.floor(random() * 11) : 30 + Math.floor(random() * 21));
  const beforeHp = Number(role.max_hp || 100);
  role.max_hp = breakthrough ? Math.round(beforeHp * 1.5) : beforeHp + hpGain;
  const totalStats = breakthrough ? 20 : role.level <= 10 ? 5 : 10;
  const fields = ['strength', 'agility', 'intelligence', 'luck'];
  for (let i = 0; i < totalStats; i++) {
    const index = Number.isInteger(statIndexes[i]) ? statIndexes[i] : Math.floor(random() * fields.length);
    const field = fields[Math.max(0, Math.min(fields.length - 1, index))];
    role[field] = Number(role[field] || 0) + 1;
  }
  role.hp = role.max_hp;
  return { maxHpGain: role.max_hp - beforeHp, statPoints: totalStats };
}

function applyExperience(role, amount, options = {}) {
  role.exp = Number(role.exp || 0) + Number(amount || 0);
  const levels = [];
  while (true) {
    const level = Number(role.level || 1);
    // Lv.10 的 1000 经验是转职门槛，不是经验上限；允许探险继续积累经验。
    if (level === 10) break;
    if (level >= 14) { role.exp = 2800; break; }
    const threshold = level < 10 ? level * 100 : level * 200;
    if (role.exp < threshold) break;
    role.exp -= threshold;
    role.level = level + 1;
    applyLevelGrowth(role, options);
    levels.push(role.level);
  }
  return levels;
}

function parseLearnedSkills(raw) {
  let parsed;
  try {
    const text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch (_) { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  return parsed.flatMap(item => {
    const member = String(item && item.member || '').trim();
    const name = String(item && item.name || '').trim();
    const desc = String(item && item.desc || '').trim();
    const key = member + '\u0000' + name;
    if (!member || member.includes('�') || member.length > 20 || !name || name.includes('�') || name.length > 20 || !desc || desc.includes('�') || desc.length > 120 || seen.has(key)) return [];
    seen.add(key);
    return [{ member, name, desc }];
  });
}

function applyLearnedSkills(role, learned) {
  if (!role || !Array.isArray(learned)) return [];
  role.skills = Array.isArray(role.skills) ? role.skills : [];
  role.skillPool = Array.isArray(role.skillPool) ? role.skillPool : [];
  const known = new Set([...role.skills, ...role.skillPool].map(skill => skill && skill.name).filter(Boolean));
  const granted = [];
  for (const skill of learned) {
    if (!skill || !skill.name || known.has(skill.name)) continue;
    const saved = { name: skill.name, desc: skill.desc };
    const storage = role.skills.length < MAX_SKILLS ? 'equipped' : 'pool';
    (storage === 'equipped' ? role.skills : role.skillPool).push(saved);
    known.add(saved.name);
    granted.push({ ...saved, storage });
  }
  return granted;
}

/* AI 决策纯函数与收束门禁 */
const AI_PHASES = ['opening', 'explore', 'encounter', 'battle', 'boss', 'loot', 'rest', 'retreat', 'closing'];
const AI_EVENTS = ['advance', 'resolve', 'fail', 'retreat'];
const AI_QUEST_STATUSES = ['active', 'completed', 'failed', 'retreated'];
const AI_ENCOUNTER_STATUSES = ['none', 'active', 'resolved', 'escaped'];
const AI_PHASE_LABELS = { opening: '进入地下城', explore: '探索', encounter: '遭遇', battle: '战斗', boss: '首领', loot: '搜刮', rest: '休整', retreat: '撤退', closing: '撤离回城' };

function normalizeAiDecision(raw, fallback = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const phase = AI_PHASES.includes(input.phase) ? input.phase : (AI_PHASES.includes(fb.phase) ? fb.phase : 'explore');
  const event = AI_EVENTS.includes(input.event) ? input.event : (AI_EVENTS.includes(fb.event) ? fb.event : 'advance');
  const questStatus = AI_QUEST_STATUSES.includes(input.questStatus) ? input.questStatus : (AI_QUEST_STATUSES.includes(fb.questStatus) ? fb.questStatus : 'active');
  const encounterStatus = AI_ENCOUNTER_STATUSES.includes(input.encounterStatus) ? input.encounterStatus : (AI_ENCOUNTER_STATUSES.includes(fb.encounterStatus) ? fb.encounterStatus : 'active');
  const hint = input.nextHint !== undefined ? input.nextHint : fb.nextHint;
  const nextHint = String(hint == null ? '' : hint).trim().slice(0, 240);
  const normalizeContinue = value => typeof value === 'boolean' ? value : (value === 0 ? false : (value === 1 ? true : null));
  const inputContinue = normalizeContinue(input.continue);
  const fallbackContinue = normalizeContinue(fb.continue);
  const normalizedContinue = inputContinue == null ? (fallbackContinue == null ? true : fallbackContinue) : inputContinue;
  return { phase, event, questStatus, encounterStatus, nextHint, continue: normalizedContinue };
}

function canEnterClosing(state = {}, decision = {}) {
  const minSteps = Number(state.minSteps == null ? 10 : state.minSteps);
  const totalStep = Number(state.totalStep || 0);
  if (totalStep < minSteps || decision.phase !== 'closing') return false;
  const questStatus = state.quest && state.quest.status || decision.questStatus;
  const encounterStatus = state.encounter && state.encounter.status || decision.encounterStatus;
  if (questStatus === 'active' || encounterStatus === 'active') return false;
  return ['none', 'resolved', 'escaped'].includes(encounterStatus) && ['completed', 'failed', 'retreated'].includes(questStatus);
}

function resolveNextPhase(state = {}, decision) {
  const d = normalizeAiDecision(decision, { phase: AI_PHASES.includes(state.phase) ? state.phase : 'explore' });
  const current = state.phase || 'explore';
  const maxSteps = Number(state.maxSteps == null ? 40 : state.maxSteps);
  if (Number(state.totalStep || 0) >= maxSteps) {
    return 'closing';
  }
  const encounterStatus = state.encounter && state.encounter.status;
  if (encounterStatus === 'active' && (d.phase === 'loot' || d.phase === 'closing')) return current;
  if (d.phase === 'closing' && !canEnterClosing(state, d)) return current;
  return d.phase;
}

function applyAiDecision(state, decision) {
  if (!state || typeof state !== 'object') return normalizeAiDecision(decision);
  const priorQuestStatus = state.quest && state.quest.status;
  const priorEncounterStatus = state.encounter && state.encounter.status;
  const normalized = normalizeAiDecision(decision, { phase: state.phase || 'explore', questStatus: priorQuestStatus, encounterStatus: priorEncounterStatus, nextHint: state.nextHint });
  state.quest = state.quest && typeof state.quest === 'object' ? state.quest : {};
  state.encounter = state.encounter && typeof state.encounter === 'object' ? state.encounter : {};
  if (Number(state.totalStep || 0) >= Number(state.maxSteps == null ? 40 : state.maxSteps)) {
    const questSettled = ['completed', 'failed', 'retreated'].includes(priorQuestStatus);
    const encounterSettled = ['none', 'resolved', 'escaped'].includes(priorEncounterStatus);
    if (!questSettled) normalized.questStatus = 'failed';
    if (!encounterSettled) normalized.encounterStatus = 'escaped';
    if (!questSettled || !encounterSettled) state.forcedTerminal = 'failed';
  }
  if (priorEncounterStatus === 'active' && (normalized.phase === 'loot' || normalized.phase === 'closing')) normalized.phase = state.phase || 'explore';
  if (state.quest && AI_QUEST_STATUSES.includes(normalized.questStatus)) state.quest.status = normalized.questStatus;
  if (state.encounter && AI_ENCOUNTER_STATUSES.includes(normalized.encounterStatus)) state.encounter.status = normalized.encounterStatus;
  const nextPhase = resolveNextPhase(state, normalized);
  state.phase = nextPhase;
  state.lastDecision = normalized;
  state.nextHint = normalized.nextHint;
  return normalized;
}

/* 生成 NPC 陪跑角色（单人/缺员补位）。
   传入预设名片（card）时优先使用完整名片，找不到才回退随机生成。 */
function genNpc(name, card) {
  if (card && typeof card === 'object' && card.name) {
    const now = Date.now();
    return {
      ...card,
      id: 'npc-' + Math.random().toString(36).slice(2, 8),
      name: card.name,
      is_npc: true,
      is_mine: false,
      hp: Number.isFinite(Number(card.hp)) ? Number(card.hp) : 160,
      max_hp: Number.isFinite(Number(card.max_hp)) ? Number(card.max_hp) : 160,
      stamina: Number.isFinite(Number(card.stamina)) ? Number(card.stamina) : 100,
      max_stamina: Number.isFinite(Number(card.max_stamina)) ? Number(card.max_stamina) : 100,
      hpTs: now,
      staminaTs: now,
    };
  }
  const rand = () => 1 + Math.floor(Math.random() * 20);
  return {
    id: 'npc-' + Math.random().toString(36).slice(2, 8), name: name || pick(NPC_NAME_POOL), is_npc: true, is_mine: false,
    gender: Math.random() < 0.5 ? '男' : '女', hp: 100 + Math.floor(Math.random() * 60), max_hp: 160, stamina: 100, max_stamina: 100, hpTs: Date.now(),
    level: 1 + Math.floor(Math.random() * 3),
    strength: rand(), agility: rand(), intelligence: rand(), luck: rand(),
    gold: 0, character_class: pick(Object.values(GC.ROOT_KEYS)).label,
    personality: pick(GC.PERS_LIST), equipment: [], bag: [], skills: [],
    exp: 0, status: 'idle',
  };
}

/* 创建房间 dg（开本）；联机与单机共用默认长度 */
function createDg(hostChar, opts = {}) {
  hostChar = hostChar || {};
  const base = opts.base || (opts.choice && DUNGEON_POOL.find(d => d.name === opts.choice)) || pickDungeon(hostChar);
  const dungeon = opts.setup ? applyDungeonSetup(base, opts.setup) : (() => {
    const isHidden = Math.random() < 0.1;
    const specialEvent = Math.random() < 0.1;
    const breakthrough = canBreakthrough(hostChar) && Math.random() < 0.1;
    const enemies = rollEnemies(base, specialEvent);
    const bosses = (base.bosses || []).map((b, i) => ({ ...b, level: i === 1 ? 12 : 11 }));
    return { ...base, name: isHidden ? (base.hiddenName || base.name) : base.name, desc: isHidden ? (base.hiddenDesc || base.desc) : base.desc, isHidden, baseName: base.name, enemies, bosses, specialEvent, breakthrough };
  })();
  const objective = String(dungeon.lore || '').trim() || `探索${dungeon.name}`;
  return {
    id: 'dg' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    dungeon, party: [], flowMode: 'dynamic', minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'opening', quest: { status: 'active', objective }, encounter: { status: 'none', name: '' },
    lastDecision: {}, nextHint: '', plan: buildPlan(dungeon.isHidden, dungeon.enemies.length, dungeon.specialEvent, dungeon.breakthrough),
    planIdx: 0, stepIdx: 0, totalStep: 0, steps: [], damage: 0, deaths: [],
    status: 'waiting', startedAt: Date.now(), timer: null, memberGains: {},
    bossDrops: [], _curEnemy: null, gains: {}, consumed: [], itemLoans: [], itemRegistry: [], aiLoot: [], breachSuccess: false, localUsed: false, source: 'online',
  };
}

/* AI 请求体构造（与单机 generateStep 载荷一致） */
function aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse) {
  const focus = dg.flowMode === 'dynamic'
    ? ((dg.focusPlan || [])[dg.totalStep] || (dg.focusPlan || []).at(-1) || null)
    : (dg.focusPlan || [])[dg.totalStep] || null;
  const cast = focus && focus.mode === 'group' ? (dg.party || []) : [actor, support, support2].filter(Boolean);
  const allowedCharacters = [...new Set(cast.map(member => member && member.name).filter(Boolean))];
  const forbiddenCharacters = [...new Set((dg.party || []).map(member => member && member.name).filter(Boolean))].filter(name => !allowedCharacters.includes(name));
  return {
    dungeon: dg.dungeon.name, baseDungeon: dg.dungeon.baseName || dg.dungeon.name, isHidden: !!dg.dungeon.isHidden,
    specialEvent: !!dg.dungeon.specialEvent, breakthrough: !!dg.dungeon.breakthrough,
    lore: dg.dungeon.lore || '', enemies: dg.dungeon.enemies || [], bosses: dg.dungeon.bosses || [],
    flowMode: dg.flowMode || 'legacy', phase: dg.phase || stageKey,
    quest: dg.quest || { status: 'active', objective: '' },
    encounter: dg.encounter || { status: 'none', name: '' },
    minSteps: Number(dg.minSteps == null ? 10 : dg.minSteps), preferredMaxSteps: Number(dg.preferredMaxSteps == null ? 25 : dg.preferredMaxSteps), maxSteps: Number(dg.maxSteps == null ? 40 : dg.maxSteps),
    lastDecision: dg.lastDecision || {}, nextHint: dg.nextHint || '',
    stage: stageKey, stageLabel: dg.flowMode === 'dynamic' ? (AI_PHASE_LABELS[stageKey] || stageKey) : ((dg.plan && dg.plan[dg.planIdx] || {}).label || stageKey),
    roll: null, mod: null, total: null, actor: actor.name,
    support: support ? support.name : null, support2: support2 ? support2.name : null, attr: '',
    needsCheck: dg.flowMode === 'dynamic' ? !['opening', 'closing', 'rest', 'retreat'].includes(stageKey) : !!((dg.plan && dg.plan[dg.planIdx] || {}).check),
    focus: focus ? { actor: actor.name, step: focus.focusStep, size: focus.windowSize, highlight: !!focus.highlight, mode: focus.mode } : null,
    allowedCharacters, forbiddenCharacters,
    stepNo: dg.totalStep + 1, totalSteps: Number(dg.maxSteps == null ? ((dg.plan || []).reduce((a, p) => a + p.steps, 0) || 40) : dg.maxSteps),
    enemy: dg._curEnemy ? { name: dg._curEnemy.name, level: dg._curEnemy.level || null, realm: dg._curEnemy.realm || '', desc: dg._curEnemy.desc || '' } : null,
    itemUse: null,
    availableItems: availableItemsForActor(dg, actor),
    ownedItems: collectOwnedItems(dg),
    skillUse: null,
    party: dg.party.map(m => ({
      name: m.name, gender: m.gender || '男', realm: m.character_class || '', level: Number(m.level) || 1,
      personality: m.personality || '',
      skills: (m.skills || []).map(s => ({ name: s.name, desc: s.desc || '' })),
      items: [...(m.equipment || []), ...(m.bag || [])].map(i => ({ name: i.name, kind: i.kind || 'misc', desc: i.desc || '', qty: i.qty || 1, ownerId: memberIdentity(m), ownerName: m.name || '' })),
    })),
    context: dg.steps.slice(-5).map(s => s.text).join('\n'),
  };
}

module.exports = {
  DUNGEON_POOL, STAGE_ATTR, ATTR_NAME, QI_LAYER, MAX_SKILLS, NPC_NAME_POOL, BREAKTHROUGH_EXP, STEP_OUTCOMES,
  rollD20, pick, itemBonus, realmBonus, realmDiffMod, elemMatchMod,
  rollEnemies, pickDungeon, buildPlan, buildNarrativeFocusPlan, dynamicNarrativeFocus, appendDynamicNarrativeFocus, itemUseCheck, recordItemLoan, recordItemLoansFromText, collectItemLoansFromText, itemUseExplicitInText, consumeItemUse, settleItemLoans, availableItemsForActor, skillUseCheck, parseLootMarkers, extractGold,
  registerLootOwnership, validateStepItemUsage, itemGuardFeedback,
  applyStageEffects, genNpc, createDg, aiStoryPayload, regenerateHp, regenerateStamina, assignLoot, hasDuplicateCharacterName, experienceNeeded, canBreakthrough,
  applyLevelGrowth, applyExperience, parseLearnedSkills, applyLearnedSkills,
  normalizeInjuryGrant, clearExpiredInjury,
  normalizeAiDecision, canEnterClosing, resolveNextPhase, applyAiDecision,
  normalizeAiStepResult, recordAiLoot, applyDungeonSetup,
};
