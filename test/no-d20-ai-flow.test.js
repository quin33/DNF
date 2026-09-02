const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GE = require('../game-engine.js');

test('normalizeAiStepResult keeps AI outcome, damage, item/skill use, and loot metadata', () => {
  const step = GE.normalizeAiStepResult({
    outcome: 'crit',
    damage: '18',
    itemUse: { name: '聚气丹', success: true },
    skillUse: { name: '火球术', success: false },
    loot: [{ name: '幽绿灵骨珠', qty: 2, rarity: 'rare' }],
  }, { outcome: 'mid' });
  assert.deepEqual(step, {
    outcome: 'crit',
    damage: 18,
    itemUse: { name: '聚气丹', success: true },
    skillUse: { name: '火球术', success: false },
    loot: [{ name: '幽绿灵骨珠', qty: 2, rarity: 'rare' }],
  });
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
      { name: '金币三十块' },
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
    enemies: [{ name: '腐骨妖狼', level: 'Lv.3' }, { name: '不存在的敌人', level: 'Lv.5' }],
  });
  assert.equal(dungeon.name, '白骨深渊·万骨冢');
  assert.equal(dungeon.desc, '隐藏');
  assert.equal(dungeon.isHidden, true);
  assert.equal(dungeon.specialEvent, true);
  assert.equal(dungeon.breakthrough, true);
  assert.deepEqual(dungeon.enemies, [{ name: '腐骨妖狼', desc: '妖狼', level: 3 }]);
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
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function applyLocalLevelGrowth'));
  const extract = html.slice(html.indexOf('async function aiExtractLoot'), html.indexOf('async function aiScroll'));

  assert.doesNotMatch(tick, /rollD20|itemUseCheck|skillUseCheck/);
  assert.match(tick, /outcome = gs\.outcome/);
  assert.match(tick, /applyStageEffects\(dg, stageKey, actor, '', 0, 0, 0, outcome, aiDamage\)/);
  assert.match(html, /fetch\('\/api\/ai\/setup'/);
  assert.match(step, /availableItems: availableItemsForActor\(dg, actor\)/);
  assert.match(step, /outcome: step\.outcome, damage: step\.damage/);
  assert.doesNotMatch(settlement, /pickRarity|traitPlan|scrollPromise/);
  assert.match(settlement, /aiVerdict\.statBuffs/);
  assert.match(settlement, /aiVerdict\.scroll/);
  assert.doesNotMatch(settlement, /aiVerdict\.traits/);
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
