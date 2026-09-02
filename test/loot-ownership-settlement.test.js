const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const LootSettlement = require('../loot-settlement.js');
const { startServer } = require('./helpers/server-fixture.js');

test('merges repeated references to one physical item without doubling quantity', () => {
  const items = LootSettlement.normalizeLootItems([
    {
      name: '青白古剑', canonicalName: '殉剑古剑', desc: '剑身青白，残留殉剑执念。',
      qty: 1, rarity: 'epic', owner: '洛清欢', sourceStep: 12,
    },
    {
      name: '殉剑古剑', canonicalName: '殉剑古剑', desc: '古剑在后续清点时再次被提及。',
      qty: 1, rarity: 'epic', owner: '洛清欢', sourceStep: 18, sameAsStep: 12,
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].name, '殉剑古剑');
  assert.equal(items[0].qty, 1);
  assert.deepEqual(items[0].aliases, ['青白古剑', '殉剑古剑']);
  assert.deepEqual(items[0].sourceSteps, [12, 18]);
  assert.match(items[0].mergeReason, /sameAsStep/);
});

test('uses canonical names to prevent alias drift in the final reward', () => {
  const items = LootSettlement.normalizeLootItems([
    {
      name: '锈剑格', canonicalName: '锈蚀剑格', desc: '古剑残件。',
      qty: 1, rarity: 'common', sourceStep: 4,
    },
    {
      name: '锈蚀剑格', canonicalName: '锈蚀剑格', desc: '同一残件的完整称呼。',
      qty: 1, rarity: 'common', sourceStep: 9, sameAsStep: 4,
    },
  ]);

  assert.deepEqual(items.map(item => item.name), ['锈蚀剑格']);
});

test('normalizing an already merged API result preserves its audit trail', () => {
  const once = LootSettlement.normalizeLootItems([
    { name: '青白古剑', canonicalName: '殉剑古剑', desc: '古剑。', sourceStep: 12, entityId: 'sword-1' },
    { name: '殉剑古剑', canonicalName: '殉剑古剑', desc: '同一古剑。', sourceStep: 18, sameAsStep: 12, entityId: 'sword-1' },
  ]);
  const twice = LootSettlement.normalizeLootItems(once);

  assert.deepEqual(twice[0].aliases, ['青白古剑', '殉剑古剑']);
  assert.deepEqual(twice[0].sourceSteps, [12, 18]);
  assert.equal(twice[0].sources.length, 2);
  assert.match(twice[0].mergeReason, /entityId|sameAsStep/);
});

test('assigns explicitly owned loot to the named member before merit weighting', () => {
  const members = [
    { id: 'low', name: '洛清欢', merit: 1 },
    { id: 'high', name: '萧瑟', merit: 100 },
  ];
  const assigned = LootSettlement.assignLoot([
    { name: '殉剑古剑', owner: '洛清欢' },
  ], members, () => 0.99);

  assert.equal(assigned.low.length, 1);
  assert.equal(assigned.high.length, 0);
  assert.equal(assigned.low[0].finalOwner, '洛清欢');
  assert.equal(assigned.low[0].assignmentReason, 'story-owner');
});

test('falls back to merit weighting when loot has no valid explicit owner', () => {
  const members = [
    { id: 'high', name: '洛清欢', merit: 100 },
    { id: 'low', name: '萧瑟', merit: 1 },
  ];
  const assigned = LootSettlement.assignLoot([
    { name: '无主剑魄', owner: '日志外角色' },
  ], members, () => 0);

  assert.equal(assigned.high.length, 1);
  assert.equal(assigned.low.length, 0);
  assert.equal(assigned.high[0].assignmentReason, 'merit-weighted');
});

test('allows an empty or uncapped loot result', () => {
  assert.deepEqual(LootSettlement.normalizeLootItems([]), []);

  const items = Array.from({ length: 12 }, (_, index) => ({
    name: `战利品${index + 1}`,
    canonicalName: `战利品${index + 1}`,
    desc: '测试物品',
    sourceStep: index + 1,
  }));
  assert.equal(LootSettlement.normalizeLootItems(items).length, 12);
});

test('rejects non-finite AI quantities without restoring a gameplay drop cap', () => {
  const [invalid, large] = LootSettlement.normalizeLootItems([
    { name: '失真宝物', desc: '数量异常。', qty: Infinity, sourceStep: 1 },
    { name: '成批灵材', desc: '数量很多。', qty: 10000, sourceStep: 2 },
  ]);

  assert.equal(invalid.qty, 1);
  assert.equal(large.qty, 10000);
});

test('enforces 4~12 character loot names and filters pseudo loot', () => {
  assert.equal(LootSettlement.isValidLootName('幽绿灵骨珠'), true);
  assert.equal(LootSettlement.isValidLootName('残箭杆'), false);
  assert.equal(LootSettlement.isValidLootName('无'), false);
  assert.equal(LootSettlement.isValidLootName('金币三十块'), false);
  assert.equal(LootSettlement.isValidLootName('非常长的道具名称超过十二个字'), false);

  const items = LootSettlement.normalizeLootItems([
    { name: '残箭杆', canonicalName: '残箭杆', desc: '短名。', sourceStep: 1 },
    { name: '无', canonicalName: '无', desc: '伪道具。', sourceStep: 2 },
    { name: '金币三十块', canonicalName: '金币三十块', desc: '货币。', sourceStep: 3 },
    { name: '幽绿灵骨珠', canonicalName: '幽绿灵骨珠', desc: '合法道具。', sourceStep: 4 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '幽绿灵骨珠');
});

test('formats story steps with stable source numbers for loot extraction', () => {
  assert.equal(LootSettlement.formatStorySteps([
    { stepNo: 4, rawText: '洛清欢拾起古剑。' },
    { stepNo: 5, text: '众人继续前行。' },
  ]), '第4段：洛清欢拾起古剑。\n第5段：众人继续前行。');
});

test('loose parser keeps complete new-schema entries when the AI response is truncated', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const start = server.indexOf('function parseLootJsonLoose');
  const end = server.indexOf('function trimChineseSummary', start);
  const context = { isValidLootName: LootSettlement.isValidLootName };
  vm.createContext(context);
  vm.runInContext(server.slice(start, end) + '\nthis.parseLootJsonLoose = parseLootJsonLoose;', context);

  const parsed = context.parseLootJsonLoose('[\n'
    + '{"name":"青白古剑","canonicalName":"殉剑古剑","desc":"剑身青白。","qty":1,"rarity":"epic","owner":"洛清欢","sourceStep":12,"sameAsStep":null},\n'
    + '{"name":"未完成');

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].canonicalName, '殉剑古剑');
  assert.equal(parsed[0].owner, '洛清欢');
  assert.equal(parsed[0].sourceStep, 12);
});

test('online and local settlement use the shared ownership-aware pipeline', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');

  assert.match(server, /normalizeLootItems/);
  assert.match(server, /GE\.assignLoot\(lootAssign, lootMembers\)/);
  assert.doesNotMatch(server, /out\.slice\(0,\s*8\)/);
  assert.match(server, /lootAudit/);

  assert.match(html, /<script src="loot-settlement\.js"><\/script>/);
  assert.match(html, /LootSettlement\.normalizeLootItems/);
  assert.match(html, /LootSettlement\.assignLoot/);
  assert.match(html, /lootAudit/);
});

test('static server exposes the shared browser settlement module', async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const response = await fetch(`${server.baseUrl}/loot-settlement.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/javascript/);
  assert.match(await response.text(), /window\.LootSettlement/);
});
