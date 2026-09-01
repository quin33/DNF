const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  aiStoryPayload,
  collectItemLoansFromText,
  registerLootOwnership,
  validateStepItemUsage,
  itemGuardFeedback,
} = require('../game-engine.js');

const ROOT = path.join(__dirname, '..');

function buildPrompt(payload) {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('function buildUserMessage');
  const source = server.slice(start, server.indexOf('\n/*', start));
  const context = {};
  require('node:vm').createContext(context);
  require('node:vm').runInContext(source + '\nthis.buildUserMessage = buildUserMessage;', context);
  return context.buildUserMessage(payload);
}

function makeDg() {
  const owner = {
    id: 'u50',
    name: '1111',
    traits: [],
    skills: [],
    equipment: [{ name: '净魂道铃', kind: 'misc', qty: 1 }],
    bag: [],
  };
  const npcs = ['顾长风', '洛清欢', '楚惊鸿'].map(name => ({
    id: 'npc-' + name,
    name,
    traits: [],
    skills: [],
    equipment: [],
    bag: [],
  }));
  return {
    flowMode: 'dynamic',
    dungeon: { name: '枯骨林', baseName: '枯骨林', isHidden: false, specialEvent: false, breakthrough: false, lore: '', enemies: [], bosses: [] },
    party: [owner, ...npcs],
    itemLoans: [],
    itemRegistry: [],
    steps: [],
    totalStep: 0,
  };
}

function makePayload(dg, actor, stage = 'battle') {
  dg.focusPlan = [{ mode: 'focus', focusStep: 1, windowSize: 1 }];
  return aiStoryPayload(dg, stage, actor, null, null, 'strength', 10, 0, 10, null, null);
}

test('item guard flags a non-owner using another member item', () => {
  const dg = makeDg();
  const violations = validateStepItemUsage(dg, '顾长风摇动净魂道铃，铃音清越。');

  assert.equal(violations.length, 1);
  assert.equal(violations[0].item, '净魂道铃');
  assert.equal(violations[0].owner, '1111');
  assert.equal(violations[0].user, '顾长风');
});

test('item guard also blocks one player using another player item', () => {
  const owner = { id: 'u100', name: '甲玩家', equipment: [{ name: '净魂道铃', kind: 'misc', qty: 1 }], bag: [] };
  const other = { id: 'u200', name: '乙玩家', equipment: [], bag: [] };
  const dg = { party: [owner, other], itemLoans: [], itemRegistry: [] };

  const violations = validateStepItemUsage(dg, '乙玩家摇动净魂道铃，铃音清越。');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].owner, '甲玩家');
  assert.equal(violations[0].user, '乙玩家');

  const text = '甲玩家将净魂道铃递给乙玩家。乙玩家接过净魂道铃，摇动净魂道铃。';
  assert.deepEqual(validateStepItemUsage(dg, text), []);
});

test('item guard flags new loot used by another member in the acquiring step', () => {
  const dg = makeDg();
  const owner = dg.party[0];
  const violations = validateStepItemUsage(
    dg,
    '楚惊鸿抡起药镇铁杵，砸向黑根。',
    { actor: owner, lootNames: ['药镇铁杵'] },
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].item, '药镇铁杵');
  assert.equal(violations[0].owner, '1111');
  assert.equal(violations[0].user, '楚惊鸿');
});

test('explicit lending text authorizes the named borrower in the same step', () => {
  const dg = makeDg();
  const text = '1111将净魂道铃递给顾长风。顾长风接过净魂道铃，摇动净魂道铃。';

  assert.equal(collectItemLoansFromText(dg, text).length, 1);
  assert.deepEqual(validateStepItemUsage(dg, text), []);
});

test('loan parsing recognizes temporary and borrower-oriented lending verbs', () => {
  const dg = makeDg();
  const records = collectItemLoansFromText(dg, '1111将净魂道铃暂借顾长风使用。');

  assert.equal(records.length, 1);
  assert.equal(records[0].ownerId, 'u50');
  assert.equal(records[0].userId, 'npc-顾长风');
});

test('story payload and prompt expose item ownership to the writer', () => {
  const dg = makeDg();
  const actor = dg.party[0];
  const payload = makePayload(dg, actor);
  const prompt = buildPrompt(payload);

  assert.equal(payload.party[0].items[0].ownerName, '1111');
  assert.equal(payload.ownedItems.find(item => item.name === '净魂道铃').ownerName, '1111');
  assert.match(prompt, /携带：净魂道铃（.*持有人：1111）/);
  assert.match(prompt, /【物品归属】/);
  assert.match(prompt, /净魂道铃（1111持有）/);
});

test('registered loot is included in the next step ownership list', () => {
  const dg = makeDg();
  const actor = dg.party[0];
  registerLootOwnership(dg, actor, ['药镇铁杵']);
  const payload = makePayload(dg, actor);

  assert.equal(payload.ownedItems.find(item => item.name === '药镇铁杵').ownerName, '1111');
});

test('item guard feedback tells the AI who owns the item and who misused it', () => {
  const dg = makeDg();
  const violations = validateStepItemUsage(dg, '顾长风摇动净魂道铃。');
  const feedback = itemGuardFeedback(violations);

  assert.match(feedback, /净魂道铃归1111所有/);
  assert.match(feedback, /顾长风/);
});
