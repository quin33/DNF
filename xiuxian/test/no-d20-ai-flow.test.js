const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GE = require('../game-engine.js');

test('normalizeAiStepResult keeps AI outcome, damage, healing, item/skill use, and loot metadata', () => {
  const step = GE.normalizeAiStepResult({
    outcome: 'crit',
    damage: '18',
    heal: '12',
    itemUse: { name: '聚气丹', success: true },
    skillUse: { name: '火球术', success: false },
    loot: [{ name: '幽绿灵骨珠', qty: 2, rarity: 'rare' }],
  }, { outcome: 'mid' });
  assert.deepEqual(step, {
    outcome: 'crit',
    damage: 18,
    heal: 12,
    itemUse: { name: '聚气丹', success: true },
    skillUse: { name: '火球术', success: false },
    loot: [{ name: '幽绿灵骨珠', qty: 2, rarity: 'rare' }],
  });
});

test('AI healing described in text works even when skillUse is omitted', () => {
  const healer = { id: 'healer', name: '柳烟', hp: 60, max_hp: 130 };
  const ally = { id: 'ally', name: '姜雪', hp: 80, max_hp: 150 };
  const dg = { party: [healer, ally] };
  const info = GE.resolveHealInfo(
    dg,
    healer,
    '柳烟催动青木养气诀恢复气血，伤口渐渐愈合。',
    '',
    {}
  );
  assert.equal(info.allowed, true);
  assert.equal(info.target.name, '柳烟');
});

test('AI healing resolves a named teammate as the heal target', () => {
  const healer = { id: 'healer', name: '柳烟', hp: 120, max_hp: 130 };
  const ally = { id: 'ally', name: '姜雪', hp: 60, max_hp: 150 };
  const dg = { party: [healer, ally] };
  const info = GE.resolveHealInfo(
    dg,
    healer,
    '柳烟为姜雪施展疗伤术，姜雪的气血缓缓回升。',
    '',
    {}
  );
  assert.equal(info.allowed, true);
  assert.equal(info.target.name, '姜雪');
});

test('healing without a narrative recovery action stays disallowed', () => {
  const healer = { id: 'healer', name: '柳烟', hp: 60, max_hp: 130 };
  const dg = { party: [healer] };
  assert.equal(GE.resolveHealInfo(dg, healer, '柳烟收功调息，继续前行。', '', {}).allowed, false);
});

test('applyStageEffects heals the named target instead of the acting member', () => {
  const dg = {
    damage: 0,
    deaths: [],
    memberGains: { healer: { damage: 0 }, ally: { damage: 0, healing: 0 } },
    _curEnemy: null,
    bossDrops: [],
  };
  const healer = { id: 'healer', name: '柳烟', hp: 100, max_hp: 100 };
  const ally = { id: 'ally', name: '姜雪', hp: 40, max_hp: 50 };

  GE.applyStageEffects(dg, 'battle', healer, 0, 'good', 0, 20, true, ally);

  assert.equal(healer.hp, 100);
  assert.equal(ally.hp, 50);
  assert.equal(dg.healing, 10);
  assert.equal(dg.memberGains.ally.healing, 10);
});

test('recordAiLoot merges AI loot quantities and carries rarity into gainedLoot', () => {
  const dg = { aiLoot: [], gainedLoot: [] };
  const actor = { id: 'u1', name: '甲' };
  const names = GE.recordAiLoot(dg, actor, [
    { name: '幽绿灵骨珠', qty: 2, rarity: 'rare' },
    { name: '幽绿灵骨珠', qty: 1, rarity: 'rare' },
  ]);
  assert.deepEqual(names, ['幽绿灵骨珠']);
  assert.deepEqual(dg.aiLoot, [{ name: '幽绿灵骨珠', qty: 3, rarity: 'rare' }]);
});

test('AI loot normalization drops short names and pseudo currencies', () => {
  const step = GE.normalizeAiStepResult({
    loot: [
      { name: '无' },
      { name: '灵石三十块' },
      { name: '残箭杆' },
      { name: '幽绿灵骨珠', qty: 2, rarity: 'rare' },
    ],
  }, {});
  assert.deepEqual(step.loot, [{ name: '幽绿灵骨珠', qty: 2, rarity: 'rare' }]);

  const dg = { aiLoot: [], gainedLoot: [] };
  const names = GE.recordAiLoot(dg, { id: 'u1', name: '甲' }, step.loot);
  assert.deepEqual(names, ['幽绿灵骨珠']);
});

test('applyDungeonSetup uses AI-selected enemies while ignoring out-of-pool names', () => {
  const base = {
    name: '枯骨林',
    hiddenName: '白骨深渊·万骨冢',
    desc: '普通',
    hiddenDesc: '隐藏',
    enemies: [{ name: '腐骨妖狼', desc: '妖狼' }, { name: '拾骨亡魂', desc: '亡魂' }],
    bosses: [{ name: '白骨将军' }],
  };
  const dungeon = GE.applyDungeonSetup(base, {
    isHidden: true,
    specialEvent: true,
    breakthrough: true,
    enemies: [{ name: '腐骨妖狼', realm: '练气三层' }, { name: '不存在的敌人', realm: '筑基中期' }],
  });
  assert.equal(dungeon.name, '白骨深渊·万骨冢');
  assert.equal(dungeon.desc, '隐藏');
  assert.equal(dungeon.isHidden, true);
  assert.equal(dungeon.specialEvent, true);
  assert.equal(dungeon.breakthrough, true);
  assert.deepEqual(dungeon.enemies, [{ name: '腐骨妖狼', desc: '妖狼', realm: '练气三层' }]);
});

test('server parseAiStoryResponse exposes AI step fields for single-player story route', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const source = server.slice(server.indexOf('function parseAiStoryResponse'), server.indexOf('async function callAIStory'));
  const context = { GE };
  vm.createContext(context);
  vm.runInContext(source, context);
  const parsed = context.parseAiStoryResponse(
    JSON.stringify({
      text: '雷光撕裂夜幕。',
      outcome: 'bad',
      damage: 22,
      itemUse: { name: '聚气丹', success: true },
      skillUse: null,
      loot: [{ name: '千年雷击木', qty: 1, rarity: 'epic' }],
    }),
    { needsCheck: true }
  );
  assert.equal(parsed.outcome, 'bad');
  assert.equal(parsed.damage, 22);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.itemUse)), { name: '聚气丹', success: true });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.loot)), [{ name: '千年雷击木', qty: 1, rarity: 'epic' }]);
});

test('single-player dungeon flow and settlement are fully AI-driven without D20 rolls', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const tick = html.slice(html.indexOf('async function dungeonTick'), html.indexOf('function itemBonus'));
  const step = html.slice(html.indexOf('async function generateStep'), html.indexOf('/* ---------- 阶段效果'));
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function realmForLevel'));
  const extract = html.slice(html.indexOf('async function aiExtractLoot'), html.indexOf('async function aiGrantTrait'));

  assert.doesNotMatch(tick, /rollD20|itemUseCheck|skillUseCheck/);
  assert.match(tick, /outcome = gs\.outcome/);
  assert.match(tick, /applyStageEffects\(dg, stageKey, actor, '', 0, 0, 0, outcome, aiDamage, gs\.heal, healAllowed, healTarget\)/);
  assert.match(html, /fetch\('\/api\/ai\/setup'/);
  assert.match(step, /availableItems: availableItemsForActor\(dg, actor\)/);
  assert.match(step, /outcome: step\.outcome, damage: step\.damage/);
  assert.doesNotMatch(settlement, /pickRarity|traitPlan|scrollPromise/);
  assert.match(settlement, /aiVerdict\.statBuffs/);
  assert.match(settlement, /aiVerdict\.traits/);
  assert.match(settlement, /aiVerdict\.scroll/);
  assert.match(extract, /qty: Math\.max\(1, Math\.round/);
  assert.doesNotMatch(extract, /Math\.min\(99/);
  assert.match(settlement, /LootSettlement\.normalizeLootItems/);
  assert.match(extract, /rarity: \['common', 'rare', 'epic', 'legendary'\]/);
});

test('server prompts tell the AI to decide outcomes instead of using dice', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.doesNotMatch(server, /D20/);
  assert.match(server, /本步没有骰子/);
  assert.match(server, /本步成败、受伤与收获由你依据剧情直接判定/);
});

test('AI damage guidance carries HP context and a shared non-lethal floor', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');

  assert.match(server, /伤害尺度（按当前最大气血比例）/);
  assert.match(server, /气血 \$\{Math\.max/);
  assert.match(html, /hp: Math\.max\(0, Number\(m\.hp\)/);
  assert.match(html, /max_hp: Math\.max\(1, Number\(m\.max_hp\)/);

  const source = html.slice(
    html.indexOf('/* 敌人修为字符串'),
    html.indexOf('/* ---------- 阶段效果')
  );
  const context = { QI_LAYER: ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(context.resolveDamageFloor(
    { dungeon: { isHidden: false, specialEvent: false }, _curEnemy: { realm: '练气一层' } },
    'battle',
    { hp: 100, max_hp: 100, level: 1 },
    'bad'
  ), 10);
  assert.equal(context.resolveDamageFloor(
    { dungeon: { isHidden: false, specialEvent: false }, _curEnemy: { realm: '练气一层' } },
    'battle',
    { hp: 100, max_hp: 100, level: 1 },
    'good'
  ), 0);
});

test('AI heal guidance and settlement expose HP deltas with level-up badges', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const online = fs.readFileSync('online.js', 'utf8');
  const runner = fs.readFileSync('room-runner.js', 'utf8');

  assert.match(server, /治疗尺度（按当前最大气血比例）/);
  assert.match(server, /hpDelta: Number\.isFinite\(hpEntry\)/);
  assert.match(server, /memberRes\.levelUp = leveledUp/);
  assert.match(server, /memberRes\.hpDelta = memberRes\.hpFinal - hpEntry/);
  assert.match(html, /dg\.entryHp/);
  assert.match(html, /function settlementHpView/);
  assert.match(html, /💚 气血\+/);
  assert.match(html, /修为提升/);
  assert.doesNotMatch(html, /LEVEL UP↑/);
  assert.match(online, /hpDelta: r\.hpDelta/);
  assert.match(online, /levelUp: !!r\.levelUp/);
  assert.match(runner, /dungeon\.entryHp/);

  const hpSource = html.slice(html.indexOf('function settlementHpView'), html.indexOf('function showSettlement(log)'));
  const hpContext = {};
  vm.createContext(hpContext);
  vm.runInContext(hpSource, hpContext);
  assert.equal(hpContext.settlementHpView({ hpDelta: 18 }).text, '+18');
  assert.match(hpContext.settlementHpSpan({ hpDelta: 18 }), /💚 气血\+18/);
  assert.equal(hpContext.settlementHpView({ hpDelta: -12 }).text, '-12');
});

test('server keeps AI outcome JSON clear of the default narrative truncation', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const outcomeCalls = server.match(/callLLM\([^;]*OUTCOME_PROMPT,\s*2000,?\s*\)/g) || [];
  assert.equal(outcomeCalls.length, 2);
});

test('server settlement exposes AI companion loot in results without writing it to their bag', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  const npcBranch = settlement.slice(settlement.indexOf('if (m.isNpc)'), settlement.indexOf('const char = DB.getCharacter'));

  assert.match(npcBranch, /lootByMember\[m\.uid \|\| m\.id\]/);
  assert.match(npcBranch, /memberRes\.lootItems = npcLoot\.map/);
  // NPC 分支必须直接结束，不得落入玩家持久化逻辑（不写背包、不保存角色）。
  assert.match(npcBranch, /results\.push\(memberRes\);\s*continue;/);
});

test('normalizeConsumableSlots collapses duplicate consumable references', () => {
  const role = {
    consumableSlots: [
      { name: ' 疗伤丹 ', desc: 'a', kind: 'consumable' },
      { name: '疗伤丹', desc: 'b', kind: 'consumable' },
      { name: '清心符', desc: 'c', kind: 'consumable' },
      { name: '护体符', desc: 'd', kind: 'consumable' },
    ],
  };
  GE.normalizeConsumableSlots(role);
  assert.deepEqual(role.consumableSlots.map(slot => slot.name), ['疗伤丹', '清心符']);
});
