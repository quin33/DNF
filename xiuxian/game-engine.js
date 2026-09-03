/* ============================================================
   game-engine.js · 服务端权威副本引擎
   移植自单机版 index.html 的副本核心逻辑（计划/判定/效果/解析），
   供在线房间系统调用；AI 剧情生成由 server.js 注入 callAI 完成。
   ============================================================ */
const GC = require('./game-create.js');
const AI_COMPANIONS = require('./ai-companions.js');
const { normalizeTraitGrant, normalizeInjuryGrant, clearExpiredInjury } = require('./trait-system.js');
const LootSettlement = require('./loot-settlement.js');

const MAX_SKILLS = 5;
const STAGE_ATTR = { explore: ['intelligence', 'luck'], battle: ['strength', 'agility'], boss: ['strength', 'agility', 'luck'], loot: ['luck', 'intelligence'], breakthrough: ['luck', 'intelligence'] };
const ATTR_NAME = { strength: '体魄', agility: '身法', intelligence: '神识', luck: '气运' };
const QI_LAYER = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const SKILL_TIERS = ['黄阶', '玄阶', '地阶', '天阶'];
const SKILL_TIER_COLOR = { 黄阶: '#8b949e', 玄阶: '#58a6ff', 地阶: '#a371f7', 天阶: '#f0883e' };
const BAD_TRAIT_POOL = ['重伤未愈', '惊吓过度', '中了尸毒', '心有余悸'];
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
  { name: '枯骨林', hiddenName: '白骨深渊·万骨冢', icon: '🦴', desc: '枯骨遍地、阴风阵阵的乱葬林，亡魂在碑影间低语。', hiddenDesc: '林间怨气远超寻常——那万人坑的深处，有什么东西在呼唤。',
    lore: '相传此地原是上古战场的一处万人坑，战死的士卒怨气不散，化作白骨与亡魂在林中徘徊。',
    explore: ['瘴气弥漫的枯骨坡地', '横七竖八的断碑残棺', '亡魂游荡的骨林深处'],
    enemies: [
      { name: '腐骨妖狼', desc: '由散落骨骸拼凑而成的妖狼，骨缝间渗出磷火，极擅伏击。' }, { name: '拾骨亡魂', desc: '披着残破战甲的亡魂，仍执着地搜刮生者的血肉。' }, { name: '骨甲骷髅兵', desc: '生前是悍卒，死后仍保持着军阵的杀意。' }, { name: '白骨秃鹫', desc: '盘旋于骨林上空的巨鹫，羽翼由骨片拼成。' }, { name: '噬骨蛆潮', desc: '骨缝间涌出的蛆群，所过之处连骨髓都被啃食殆尽。' }, { name: '执戈老兵魂', desc: '生前是执戈冲锋的悍卒，死后仍不肯放下长戈。' },
    ],
    bosses: [
      { name: '白骨将军', desc: '万人坑最深处的执念所化，披着锈蚀战甲，战旗残破却杀气凛然。', realm: '筑基初期', reward: { name: '将军虎符', desc: '锈蚀的铜符，据说能号令枯骨。' } }, { name: '噬骨怨灵', desc: '千万亡魂凝成的怨灵，哀嚎声直入识海。', realm: '筑基中期', reward: { name: '怨灵结晶', desc: '万千亡魂凝成的黑晶，隐隐传来呜咽。' } },
    ],
    loot: [{ name: '兽皮', desc: '妖兽皮缝制的粗料，能卖些灵石。' }, { name: '骨笛', desc: '以灵骨磨制的短笛，呜呜作响。' }, { name: '灵骨碎片', desc: '一块莹白的骨片，蕴含残存灵气。' }] },
  { name: '迷雾泽', hiddenName: '迷雾泽·沉镇幽影', icon: '🌫️', desc: '终年不散的毒雾笼罩泽地，水下潜伏着不知名的猎手。', hiddenDesc: '毒雾浓得化不开，水下的药镇废墟在雾气中若隐若现。',
    lore: '旧时这里是一座药镇，一场瘟疫让全镇覆灭，残存的怨念与毒雾纠缠成这片沼泽。',
    explore: ['雾锁断桥的深泽', '浮萍下的暗流通道', '废弃的采药人茅屋'],
    enemies: [
      { name: '毒瘴水蟒', desc: '盘踞深泽的巨蟒，毒腺喷出的瘴气能腐蚀护体灵光。' }, { name: '迷雾蛙群', desc: '成群结队的毒蛙，皮肤分泌的黏液是毒雾的源头之一。' }, { name: '泽地巨蚊', desc: '吸血巨蚊，口器如针，叮咬处红肿溃烂。' }, { name: '溺影水鬼', desc: '溺亡采药人的怨魂，湿发如蛇，专拖活人入水。' }, { name: '雾隐毒蛛', desc: '藏身水草间的巨蛛，通体灰白，毒液能蚀穿护体罡气。' }, { name: '腐沼鳄鲵', desc: '潜伏泥沼的巨鲵，体表覆满腐苔，张口便是一股腥臭毒气。' },
    ],
    bosses: [
      { name: '瘟疫之源·雾母', desc: '瘟疫的源头化作人形，周身毒雾缭绕，所立之处草木皆枯。', realm: '筑基初期', reward: { name: '雾灵珠', desc: '雾母本体凝成的珠子，内里雾气流转不息。' } }, { name: '沉镇怨首·病柳', desc: '药镇的老柳树饮尽全镇死者的血，化作盘踞水下的凶物。', realm: '筑基中期', reward: { name: '瘟疫古方', desc: '一张残缺的羊皮古方，记载着失传的解毒秘术。' } },
    ],
    loot: [{ name: '龙涎草', desc: '生于深泽的灵草，气味清冽，可入丹。' }, { name: '避瘴珠', desc: '千年灵木结成的珠子，可避瘴气毒雾。' }, { name: '雾隐石', desc: '灰蒙蒙的石子，握在掌心时周围雾气会微微散开。' }] },
  { name: '赤炎谷', hiddenName: '赤炎谷·地火核心', icon: '🔥', desc: '地火翻涌的灼热山谷，火灵草木丛中栖息着炽焰妖兽。', hiddenDesc: '山谷深处的熔岩湖彻底沸腾——传说中沉于湖底的上古火系至宝似乎正在苏醒。',
    lore: '千年前天火坠落于此，地火至今未熄。火属性修士视此为圣地。',
    explore: ['熔岩裂谷的栈道', '火灵草丛生的热泉', '被岩浆封死的洞窟'],
    enemies: [
      { name: '赤炎蜥蜴', desc: '火灵草养大的蜥蜴，鳞甲能短暂喷出烈焰。' }, { name: '熔岩傀儡', desc: '地火凝聚的傀儡，拳脚带着滚烫的岩浆。' }, { name: '火鸦群', desc: '成群的火鸦，翅羽燃着赤焰，俯冲如流星坠地。' }, { name: '地火甲虫', desc: '背甲灼红如炭的甲虫，受惊时喷出灼热气浪。' }, { name: '火灵精', desc: '火灵草间游荡的赤色灵体，触之灼伤。' }, { name: '岩浆鳄', desc: '半身浸在熔岩中的巨鳄，皮甲上岩浆流淌。' },
    ],
    bosses: [
      { name: '地火之灵', desc: '天火残魂孕育的灵体，通体赤红，举手投足皆引动地火。', realm: '筑基初期', reward: { name: '地火精魄', desc: '地火之灵的核心，散发的热意永不消散。' } }, { name: '熔核巨蜥', desc: '沉睡在熔岩湖底的巨蜥，苏醒时整座山谷都在震颤。', realm: '筑基中期', reward: { name: '熔核晶', desc: '巨蜥心口凝出的晶核，内里仿佛封着一团流动的岩浆。' } },
    ],
    loot: [{ name: '火灵草', desc: '赤炎谷特有的灵草，叶脉赤红如血。' }, { name: '火晶石', desc: '熔岩中凝结的晶石，握在手里微微发烫。' }, { name: '灰烬木', desc: '被地火淬炼过的焦木，质地坚硬。' }] },
  { name: '万剑冢', hiddenName: '万剑冢·剑冢之心', icon: '🗡️', desc: '上古剑修陨落之地，万千残剑倒插于山丘，剑意彻骨。', hiddenDesc: '万千残剑同时震颤低鸣——封存千年的剑意正在核心处苏醒。',
    lore: '上古剑宗覆灭之夜，十万弟子以身为祭，将宗门万剑埋入山丘，剑意封存千年。',
    explore: ['剑丘之巅的试炼台', '锈剑密布的剑林', '剑修遗府的石阶'],
    enemies: [
      { name: '剑灵残影', desc: '陨落剑修的残魂，执念于剑，出手便是凌厉剑意。' }, { name: '锈剑傀儡', desc: '残剑拼成的傀儡，浑身锈迹却快如闪电。' }, { name: '剑意风暴', desc: '封存的剑意失控化作风暴，卷入者如遭千剑穿身。' }, { name: '断剑亡魂', desc: '以身殉剑的剑修残念，双臂化为残剑。' }, { name: '剑匣机关兽', desc: '半毁的剑匣化形而成，开匣一瞬万剑齐发。' }, { name: '噬剑铁蠹', desc: '啃食残剑为生的铁蠹，甲壳坚逾精钢，口器能咬断剑刃。' },
    ],
    bosses: [
      { name: '剑冢守墓人', desc: '镇守剑冢千年的老者残影，怀中古剑温养千年，一剑出则风云变色。', realm: '筑基初期', reward: { name: '守墓剑令', desc: '守墓人随身剑令，古意盎然，可令残剑短暂听命。' } }, { name: '万剑之主·残念', desc: '剑宗宗主的执念，万剑环绕，剑意通天彻地。', realm: '筑基中期', reward: { name: '剑冢之心', desc: '万剑冢的核心，内里似有万剑低鸣。' } },
    ],
    loot: [{ name: '剑灵碎片', desc: '古剑残魂凝成的碎片，隐隐震颤。' }, { name: '残剑刃', desc: '断剑残刃，仍有余锋。' }, { name: '剑修遗简', desc: '残破玉简，隐约刻着半篇剑诀。' }] },
  { name: '幽冥渊', hiddenName: '幽冥渊·渊底裂隙', icon: '🌑', desc: '阴煞之气凝成黑雾的深渊，鬼修巢穴，越深越冷。', hiddenDesc: '今晚正是月圆——渊底传来低沉的呼吸声，阴阳两界的裂隙正在缓缓张开。',
    lore: '幽冥渊是阴阳两界的裂隙，阴煞之气常年倒灌。曾有鬼修在此开宗立派，后被正道联军剿灭。',
    explore: ['鬼火摇曳的崖壁栈道', '白骨铺就的渊底甬道', '被封印的鬼修洞府'],
    enemies: [
      { name: '幽冥鬼爪', desc: '从阴影中探出的鬼爪，五根枯骨般的指节力可碎铁。' }, { name: '鬼潮', desc: '成百上千的低阶亡魂汇成的潮水，所过之处生机尽灭。' }, { name: '缚魂阴煞', desc: '以魂锁缚人的阴煞，被缠上者神识如坠冰窟。' }, { name: '吊颈孤魂', desc: '悬在崖壁半空的孤魂，目光空洞，靠近者喉间发紧。' }, { name: '阴火狐', desc: '口吐幽蓝鬼火的狐妖，狡诈善惑，专诱活人误入绝路。' }, { name: '白骨夜叉', desc: '手持骨叉的夜叉，赤目獠牙，力可开碑裂石。' },
    ],
    bosses: [
      { name: '缚魂鬼母', desc: '鬼修宗门残存的祖师，半身已与阴煞同化，魂锁漫天。', realm: '筑基初期', reward: { name: '缚魂索', desc: '鬼母以千年阴煞凝成的魂索，缠上便难挣脱。' } }, { name: '渊底·沉眠者', desc: '深渊最深处沉睡的东西终于睁眼，阴煞之气随它的呼吸暴涨。', realm: '筑基中期', reward: { name: '渊底之瞳', desc: '沉眠者遗落的眼瞳，通体漆黑，凝视时如坠深渊。' } },
    ],
    loot: [{ name: '幽冥寒铁', desc: '渊底寒铁，入手冰冷彻骨。' }, { name: '阴煞珠', desc: '凝聚阴煞之气的珠子，魔修趋之若鹜。' }, { name: '魂灯残油', desc: '半盏魂灯残油，可照见幽冥之物。' }] },
  { name: '雷音山', hiddenName: '雷音山·雷池尽头', icon: '⚡', desc: '常年雷云密布的孤峰，天雷淬体，雷系灵物遍地。', hiddenDesc: '雷云低得压到了山巅，雷池中的雷灵砂剧烈沸腾——那名失败的上古雷修似乎要在今日再渡一次劫。',
    lore: '这座孤峰常年被雷云笼罩，据说是上古雷修渡劫失败之地，雷意千年不散。',
    explore: ['雷云下的通天石阶', '被雷劈开的古树洞', '雷池边缘的乱石滩'],
    enemies: [
      { name: '雷兽', desc: '沐浴天雷而生的异兽，皮毛间电弧流窜。' }, { name: '雷暴傀儡', desc: '雷池畔的傀儡，受雷意驱动，出手便引动雷霆。' }, { name: '天雷余威', desc: '残留的雷意凝成人形，触之如遭雷击。' }, { name: '雷音蝠群', desc: '雷电环绕的蝙蝠群，尖啸声与雷鸣共振。' }, { name: '紫电蛇', desc: '通体缠绕紫色电弧的雷蛇，速度极快。' }, { name: '雷纹石人', desc: '雷纹密布的山石化形，一拳砸下带闷雷之声。' },
    ],
    bosses: [
      { name: '雷池化身', desc: '雷池中的雷意凝成的化身，通体电光，威严如天神降世。', realm: '筑基初期', reward: { name: '雷池玉髓', desc: '雷池深处的玉髓，入手酥麻，蕴含纯净雷灵。' } }, { name: '渡劫残魂', desc: '上古雷修的残魂，执念于那场失败的天劫。', realm: '筑基中期', reward: { name: '劫雷木心', desc: '被劫雷劈过千年的古木心，木纹里封着一道未散的劫雷。' } },
    ],
    loot: [{ name: '雷击木', desc: '被天雷劈中的古木，木纹间流窜细碎电光。' }, { name: '雷灵砂', desc: '雷池畔的砂砾，触碰时指尖微微发麻。' }, { name: '引雷针', desc: '一指长的银针，雨夜时会自己指向天空。' }] },
  { name: '落仙台', hiddenName: '落仙台·仙宫秘境', icon: '🏯', desc: '仙人陨落之地，残破仙宫悬浮于云海之上，逆天机缘与绝命凶险并存。', hiddenDesc: '云海翻涌，仙宫深处的道则碎片亮起——那位仙人陨落时的执念，正在等待一个"有缘人"。',
    lore: '上古仙人于此地飞升失败，肉身崩解，仙宫残骸悬浮于云海之上。仙人的道则碎片散落各处。',
    explore: ['云海浮桥', '仙宫残殿', '仙人悟道石'],
    enemies: [
      { name: '仙宫守卫傀儡', desc: '仙宫残留的守卫傀儡，符文明灭，依旧尽职地驱逐入侵者。' }, { name: '心魔幻象', desc: '仙人道则滋生的幻象，映照出每个修士心底最深的执念。' }, { name: '上古残阵', desc: '残缺的仙家阵法，无人主持却仍在缓缓运转。' }, { name: '云海螭龙', desc: '云海灵气凝成的螭龙残影，翻腾之间掀起风雷。' }, { name: '道音钟灵', desc: '仙宫残钟化出的灵体，每一声钟鸣都直震神魂。' }, { name: '玉简书灵', desc: '仙家玉简化形，以道文为刃，字字皆是杀机。' },
    ],
    bosses: [
      { name: '仙宫镇守者', desc: '仙宫最后的镇守者，半身已石化，眼中神光却未熄灭。', realm: '筑基初期', reward: { name: '仙宫令牌', desc: '镇守者腰间的令牌，镌刻着仙宫纹章。' } }, { name: '仙人残念·道则', desc: '仙人陨落时遗下的道则残念，举手投足皆是大道轰鸣。', realm: '筑基中期', reward: { name: '道则碎片', desc: '仙人道则凝成的碎片，内里日月流转。' } },
    ],
    loot: [{ name: '仙府残卷', desc: '仙宫残卷，字迹流转不定。' }, { name: '悟道茶', desc: '仙人遗落的茶饼，泡开时有道韵流转。' }, { name: '星图残片', desc: '星图一角，凑齐三块可开启隐藏试炼。' }] },
];

const rollD20 = () => 1 + Math.floor(Math.random() * 20);
const pick = a => a[Math.floor(Math.random() * a.length)];
const skillTier = s => (s && s.tier && SKILL_TIERS.includes(s.tier)) ? s.tier : '黄阶';

/* 境界值换算（练气一层=1…筑基初期=11…） */
function enemyRealmVal(realm) {
  const s = String(realm || '');
  const qi = s.match(/练气([一二三四五六七八九十]+)层/); if (qi) return QI_LAYER.indexOf(qi[1]);
  const zj = s.match(/筑基(初期|前期|中期|后期)/); if (zj) return 11 + ({ 初期: 0, 前期: 0, 中期: 1, 后期: 2 }[zj[1]] || 0);
  const jd = s.match(/金丹(初期|前期|中期|后期)/); if (jd) return 14 + ({ 初期: 0, 前期: 0, 中期: 1, 后期: 2 }[jd[1]] || 0);
  const yy = s.match(/元婴(初期|前期|中期|后期)/); if (yy) return 17 + ({ 初期: 0, 前期: 0, 中期: 1, 后期: 2 }[yy[1]] || 0);
  return 0;
}
function actorRealmVal(actor) { const lv = actor.level || 1; if (lv <= 10) return lv; if (lv <= 13) return 11 + (lv - 11); if (lv <= 16) return 14 + (lv - 14); return 17 + Math.min(2, lv - 17); }
function realmDiffMod(actor, enemy) { if (!enemy || !enemy.realm) return 0; const ev = enemyRealmVal(enemy.realm); if (!ev) return 0; return Math.max(-4, Math.min(4, actorRealmVal(actor) - ev)); }
function realmBonus(actor) { return Math.min(9, Math.floor(((actor.level || 1) - 1) / 2)); }
function elemMatchMod(actor, sk) {
  const root = ((actor.traits || [])[0] || '');
  const elem = (sk && sk.elem) || '';
  if (!elem || elem === '无' || !root) return 0;
  return elem === root ? 2 : 0;
}
function traitBonus(actor) { let b = 0; (actor.traits || []).forEach(t => { if (/灵觉|夜视|听风/.test(t)) b += 1; if (/心狠|老练/.test(t)) b += 1; if (/寻宝|气运/.test(t)) b += 1; if (/胆大心细/.test(t)) b += 1; }); return Math.min(b, 2); }

const ITEM_BONUS = [
  { kw: '避瘴珠', stage: 'explore', mod: 2 }, { kw: '引灵灯', stage: 'explore', mod: 2 }, { kw: '罗盘', stage: 'explore', mod: 2 },
  { kw: '灵锄', stage: 'explore', mod: 1 }, { kw: '灵锄', stage: 'loot', mod: 1 },
  { kw: '兽皮囊', stage: 'loot', mod: 1 }, { kw: '聚气丹', stage: 'explore', mod: 1 },
  { kw: '火球符', stage: 'battle', mod: 2 }, { kw: '铁剑', stage: 'battle', mod: 1 }, { kw: '剑', stage: 'battle', mod: 2 },
  { kw: '暴血丹', stage: 'battle', mod: 1 }, { kw: '雷暴符', stage: 'battle', mod: 2 }, { kw: '噬魂刃', stage: 'battle', mod: 2 }, { kw: '仙衣', stage: 'battle', mod: 1 },
];
function itemBonus(dg, stage) { let b = 0; dg.party.forEach(m => (m.equipment || []).forEach(it => { const hit = ITEM_BONUS.find(x => x.stage === stage && (it.name || '').includes(x.kw)); if (hit) b += hit.mod; })); return Math.min(b, 4); }

/* 开本：随机 0~3 敌人（特殊事件必 ≥1 且修为上调）、首领定型 */
function rollEnemies(dungeon, specialEvent) {
  const pool = (dungeon.enemies || []).slice();
  const n = specialEvent ? 1 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 4);
  const picked = [];
  while (picked.length < n && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return picked.map(e => { let layer = 1 + Math.floor(Math.random() * 10); if (specialEvent) layer = Math.min(10, layer + 2 + Math.floor(Math.random() * 3)); return { ...e, realm: '练气' + QI_LAYER[layer] + '层' }; });
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
  const p = [ { key: 'opening', label: '入谷', steps: 1, check: false }, { key: 'explore', label: '探索', steps: explore, check: true } ];
  if (hasBattle) p.push({ key: 'battle', label: '战斗', steps: battle, check: true });
  if (hasBoss) p.push({ key: 'boss', label: '首领', steps: boss, check: true });
  p.push({ key: 'loot', label: '搜刮', steps: loot, check: true });
  if (breakthrough) p.push({ key: 'breakthrough', label: '突破', steps: 1 + Math.floor(Math.random() * 2), check: true });
  p.push({ key: 'closing', label: '归途', steps: 1, check: false });
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
/* 技能判定：D20 + 术法3/功法2 + 灵根契合±0/+2，成功 ≥12 */
function skillUseCheck(dg, stageKey, actor) {
  const skills = actor.skills || []; if (!skills.length) return null;
  const p = (stageKey === 'battle' || stageKey === 'boss') ? 1 : stageKey === 'explore' ? 0.6 : 0.35;
  if (Math.random() > p) return null;
  let pool = skills;
  if (stageKey === 'battle' || stageKey === 'boss') { const shufa = skills.filter(s => s.type === '术法'); if (shufa.length && Math.random() < 0.7) pool = shufa; }
  else if (stageKey === 'explore') { const gongfa = skills.filter(s => s.type === '功法'); if (gongfa.length && Math.random() < 0.6) pool = gongfa; }
  const sk = pick(pool); const elemMod = elemMatchMod(actor, sk); const roll = rollD20();
  const total = roll + (sk.type === '术法' ? 3 : 2) + elemMod;
  return { name: sk.name, type: sk.type || '功法', tier: skillTier(sk), elem: sk.elem || '', desc: sk.desc || '', elemMod, roll, total, success: total >= 12 };
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
  const m = String(text || '').match(/灵石\s*([一二两三四五六七八九十百千万]+|)\s*(\d+)/);
  if (m) return parseInt(m[2], 10) || 0;
  const m2 = String(text || '').match(/(\d+)\s*[块枚]?\s*灵石/);
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
    const rarity = ['common', 'rare', 'epic', 'legendary'].includes(entry && entry.rarity) ? entry.rarity : null;
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
    const rarity = ['common', 'rare', 'epic', 'legendary'].includes(entry && entry.rarity) ? entry.rarity : null;
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
    return { ...src, realm: String(entry && entry.realm || '').trim() || '练气一层' };
  }).filter(Boolean).slice(0, specialEvent ? 4 : 3);
  const bosses = (base && Array.isArray(base.bosses) ? base.bosses : []).map((b, i) => ({ ...b, realm: i === 1 ? '筑基中期' : '筑基初期' }));
  return {
    ...base,
    name: isHidden && base ? (base.hiddenName || base.name) : (base && base.name) || '',
    desc: isHidden && base ? (base.hiddenDesc || base.desc) : (base && base.desc) || '',
    isHidden, baseName: base && base.name, enemies: chosen, bosses, specialEvent, breakthrough,
  };
}

/* 单步效果应用：AI 伤害/首领掉落/突破结果（服务端权威修改 party 成员状态） */
function applyStageEffects(dg, stageKey, actor, total, outcome, aiDamage) {
  const g = dg.memberGains[actor.id];
  const dmg = Number.isFinite(Number(aiDamage)) ? Math.max(0, Math.round(Number(aiDamage))) : 0;
  if (dmg > 0) {
    actor.hp = Math.max(0, (actor.hp || 0) - dmg);
    dg.damage += dmg;
    if (g) g.damage += dmg;
    if (actor.hp <= 0 && !actor.isDead) {
      actor.isDead = true;
      dg.deaths = Array.isArray(dg.deaths) ? dg.deaths : [];
      dg.deaths.push(actor.name);
    }
  }
  if (stageKey === 'boss') {
    const boss = dg._curEnemy;
    if (outcome === 'crit' || outcome === 'good') {
      if (boss && boss.reward && !dg.bossDrops.some(r => r.name === boss.reward.name)) dg.bossDrops.push(boss.reward);
    }
  }
  if (stageKey === 'breakthrough' && (outcome === 'good' || outcome === 'crit')) dg.breachSuccess = true;
}
function addTrait(role, t) { if (!role) return; role.traits = role.traits || []; if (!role.traits.includes(t)) role.traits.push(t); }

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
    // 练气十层的 1000 经验是突破门槛，不是经验上限；允许探险继续积累经验。
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
  const validTypes = new Set(['功法', '术法']);
  const validTiers = new Set(SKILL_TIERS);
  const seen = new Set();
  return parsed.flatMap(item => {
    const member = String(item && item.member || '').trim();
    const name = String(item && item.name || '').trim();
    const type = String(item && item.type || '').trim();
    const tier = String(item && item.tier || '').trim();
    const desc = String(item && item.desc || '').trim();
    const key = member + '\u0000' + name;
    if (!member || member.includes('�') || member.length > 20 || !name || name.includes('�') || name.length > 20 || !validTypes.has(type) || !validTiers.has(tier) || !desc || desc.includes('�') || desc.length > 120 || seen.has(key)) return [];
    seen.add(key);
    return [{ member, name, type, tier, desc }];
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
    const saved = { name: skill.name, type: skill.type, tier: skill.tier, desc: skill.desc };
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
const AI_PHASE_LABELS = { opening: '入谷', explore: '探索', encounter: '遭遇', battle: '战斗', boss: '首领', loot: '搜刮', rest: '休整', retreat: '撤退', closing: '归途' };

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
    gold: 0, character_class: '练气' + QI_LAYER[1 + Math.floor(Math.random() * 10)] + '层',
    personality: pick(GC.PERS_LIST), traits: ['初入仙途'], equipment: [], bag: [], skills: [],
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
    const bosses = (base.bosses || []).map((b, i) => ({ ...b, realm: i === 1 ? '筑基中期' : '筑基初期' }));
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
    enemy: dg._curEnemy ? { name: dg._curEnemy.name, realm: dg._curEnemy.realm || '', desc: dg._curEnemy.desc || '' } : null,
    itemUse: null,
    availableItems: availableItemsForActor(dg, actor),
    ownedItems: collectOwnedItems(dg),
    skillUse: null,
    party: dg.party.map(m => ({
      name: m.name, gender: m.gender || '男', realm: m.character_class || '', root: (m.traits && m.traits[0]) || '',
      personality: m.personality || '', traits: m.traits || [],
      skills: (m.skills || []).map(s => ({ name: s.name, type: s.type || '', tier: skillTier(s), desc: s.desc || '' })),
      items: [...(m.equipment || []), ...(m.bag || [])].map(i => ({ name: i.name, kind: i.kind || 'misc', desc: i.desc || '', qty: i.qty || 1, ownerId: memberIdentity(m), ownerName: m.name || '' })),
    })),
    context: dg.steps.slice(-5).map(s => s.text).join('\n'),
  };
}

module.exports = {
  DUNGEON_POOL, STAGE_ATTR, ATTR_NAME, QI_LAYER, SKILL_TIERS, MAX_SKILLS, NPC_NAME_POOL, BREAKTHROUGH_EXP, STEP_OUTCOMES,
  rollD20, pick, skillTier, itemBonus, traitBonus, realmBonus, realmDiffMod, elemMatchMod,
  rollEnemies, pickDungeon, buildPlan, buildNarrativeFocusPlan, dynamicNarrativeFocus, appendDynamicNarrativeFocus, itemUseCheck, recordItemLoan, recordItemLoansFromText, collectItemLoansFromText, itemUseExplicitInText, consumeItemUse, settleItemLoans, availableItemsForActor, skillUseCheck, parseLootMarkers, extractGold,
  registerLootOwnership, validateStepItemUsage, itemGuardFeedback,
  applyStageEffects, genNpc, createDg, aiStoryPayload, addTrait, regenerateHp, regenerateStamina, assignLoot, hasDuplicateCharacterName, experienceNeeded, canBreakthrough,
  applyLevelGrowth, applyExperience, parseLearnedSkills, applyLearnedSkills,
  normalizeTraitGrant, normalizeInjuryGrant, clearExpiredInjury,
  normalizeAiDecision, canEnterClosing, resolveNextPhase, applyAiDecision,
  normalizeAiStepResult, recordAiLoot, applyDungeonSetup,
};
