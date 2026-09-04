const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GE = require('../game-engine.js');

const source = fs.readFileSync('server.js', 'utf8');

function loadHelper() {
  const start = source.indexOf('function settleDungeonItems');
  assert.ok(start >= 0, 'settleDungeonItems helper should exist');
  const end = source.indexOf('async function settleRoom', start);
  const context = { module: {}, exports: {}, console };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.settleDungeonItems = settleDungeonItems;', context);
  return context.settleDungeonItems;
}

test('settlement consumes successful one-shot items from the owning character inventory', () => {
  const settleDungeonItems = loadHelper();
  const owner = { uid: 'u1', id: 'c1', name: '甲', equipment: [{ name: '聚气丹', kind: 'pill', qty: 1 }], bag: [] };
  const dg = {
    party: [owner],
    consumed: [{ name: '聚气丹', ownerId: 'u1', userId: 'u1', qty: 1 }],
  };
  const result = settleDungeonItems(dg, new Map([['u1', owner]]));
  assert.deepEqual(JSON.parse(JSON.stringify(result.consumed)), [{ name: '聚气丹', ownerId: 'u1', userId: 'u1', qty: 1, ownerName: '甲', userName: '甲' }]);
  assert.deepEqual(owner.equipment, []);
});

test('settlement reports an explicitly loaned item for return when it was not consumed', () => {
  const settleDungeonItems = loadHelper();
  const owner = { uid: 'u1', id: 'c1', name: '甲', equipment: [{ name: '镇魂铃', kind: '法宝', qty: 1 }], bag: [] };
  const borrower = { uid: 'u2', id: 'c2', name: '乙', equipment: [], bag: [] };
  const dg = {
    party: [owner, borrower],
    consumed: [],
    itemLoans: [{ name: '镇魂铃', ownerId: 'u1', userId: 'u2', qty: 1, loaned: true }],
  };
  const result = settleDungeonItems(dg, new Map([['u1', owner], ['u2', borrower]]));
  assert.deepEqual(JSON.parse(JSON.stringify(result.returned)), [{ name: '镇魂铃', ownerId: 'u1', userId: 'u2', qty: 1, ownerName: '甲', userName: '乙' }]);
  assert.deepEqual(owner.equipment, [{ name: '镇魂铃', kind: '法宝', qty: 1 }]);
});

test('successful one-shot use records the inventory owner and the acting user', async () => {
  const start = source.indexOf('async function dungeonStep');
  const end = source.indexOf('function parseAiStoryResponse', start);
  const owner = { id: 'owner', uid: 'u1', name: '甲', equipment: [], skills: [] };
  const actor = { id: 'actor', uid: 'u2', name: '乙', hp: 100, max_hp: 100, equipment: [{ name: '聚气丹', kind: 'pill', qty: 1 }], skills: [], traits: [] };
  const engine = {
    ...GE,
    dynamicNarrativeFocus: () => ({ actorIndex: 1, supportIndex: 0, support2Index: null, focusStep: 1, windowSize: 2, mode: 'focus' }),
    applyStageEffects: () => {},
  };
  const dg = {
    id: 'run', flowMode: 'dynamic', minSteps: 10, maxSteps: 40, phase: 'explore', totalStep: 10,
    quest: { status: 'active' }, encounter: { status: 'none' }, lastDecision: {}, nextHint: '',
    plan: [], planIdx: 0, stepIdx: 0, focusPlan: [], party: [owner, actor], steps: [], consumed: [],
    memberGains: { owner: { acts: 0, rolls: [] }, actor: { acts: 0, rolls: [] } }, damage: 0,
    dungeon: { name: '测试副本', baseName: '测试副本', enemies: [], bosses: [], specialEvent: false },
  };
  const context = {
    GE: engine,
    callAIStory: async () => ({ text: '乙取出聚气丹当即服下。', structured: true, itemUse: { name: '聚气丹', success: true }, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } }),
    broadcastAll: () => {}, scheduleTick: () => {}, settleRoom: async () => {}, console,
    DB: { checkpointExpeditionRun: () => true },
    durableRunSnapshot: room => ({ steps: room.dg.steps }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.dungeonStep({ dg });
  assert.deepEqual(JSON.parse(JSON.stringify(dg.consumed)), [{ name: '聚气丹', ownerId: 'u2', userId: 'u2', qty: 1, loaned: false }]);
});

test('settlement attaches consumed story items to each acting member card', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  const online = fs.readFileSync('online.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');

  assert.match(settlement, /memberRes\.consumed = .*itemSettlement\.consumed/);
  assert.match(settlement, /consumed: r\.consumed \|\| \[\],/);
  assert.match(online, /consumed: r\.consumed \|\| \[\],/);
  assert.match(html, /剧情消耗：/);
});

test('member consumed grouping follows userName and aggregates repeated item uses', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('function memberConsumedGroups');
  const end = html.indexOf('function memberStatusPanelHTML', start);
  assert.ok(start >= 0 && end > start, 'memberConsumedGroups helper should exist');
  const context = {
    module: {}, exports: {},
    esc: value => String(value),
    itemColor: () => '#c8a24f',
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end) + '\nthis.memberConsumedGroups = memberConsumedGroups; this.memberConsumedHTML = memberConsumedHTML;', context);

  const settlement = {
    consumed: [
      { name: '回春丹', userName: '甲', qty: 1 },
      { name: '回春丹', userName: '甲', qty: 1 },
      { name: '聚气丹', userName: '乙', qty: 1 },
    ],
  };
  const jia = { name: '甲', is_mine: false };
  assert.deepEqual(JSON.parse(JSON.stringify(context.memberConsumedGroups(jia, settlement))), [
    { name: '回春丹', qty: 2 },
  ]);
  assert.match(context.memberConsumedHTML(jia, settlement), /剧情消耗：/);
  assert.doesNotMatch(context.memberConsumedHTML(jia, settlement), /聚气丹/);
});
