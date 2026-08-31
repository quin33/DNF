const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  parseChineseNumber,
  extractSpiritStoneEvents,
  splitSpiritStones,
} = require('../loot-settlement.js');

test('parses Chinese spirit-stone amounts containing ten-thousands', () => {
  assert.equal(parseChineseNumber('一万零三十'), 10030);
  assert.equal(parseChineseNumber('一万二千三百四十五'), 12345);
});

test('extracts all global spirit-stone gains from separate story steps', () => {
  const steps = [
    { stepNo: 4, actor: '洛清欢', text: '旧木匣内裹着四十块下品灵石，她将遗物收好。' },
    { stepNo: 29, actor: '洛清欢', text: '回宗复命，执事酬以三百灵石。' },
    { stepNo: 30, actor: '萧瑟', text: '同一趟复命已核验无讹，执事仍酬以三百灵石。' },
  ];

  const events = extractSpiritStoneEvents(steps);

  assert.deepEqual(events.map(event => event.amount), [40, 300, 300]);
  assert.equal(events.reduce((sum, event) => sum + event.amount, 0), 640);
});

test('splits total spirit stones evenly across the whole party', () => {
  assert.deepEqual(splitSpiritStones(640, [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
  ]), { a: 160, b: 160, c: 160, d: 160 });

  assert.deepEqual(splitSpiritStones(10, [
    { id: 'a' }, { id: 'b' }, { id: 'c' },
  ]), { a: 4, b: 3, c: 3 });
});

test('returns zero shares when the expedition has no explicit spirit-stone gain', () => {
  assert.deepEqual(splitSpiritStones(0, [{ id: 'a' }, { id: 'b' }]), { a: 0, b: 0 });
});

test('online settlement uses global spirit-stone events instead of a fixed reward formula', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(server, /require\('\.\/loot-settlement\.js'\)/);
  assert.match(settlement, /extractSpiritStoneEvents\(dg\.steps\)/);
  assert.match(settlement, /splitSpiritStones\(/);
  assert.doesNotMatch(settlement, /const goldGain = ok \? 20 \+ exp : 5/);
});

test('local settlement has no fallback spirit-stone reward and splits the global total', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function realmForLevel'));
  assert.match(settlement, /extractGold\(storyText\)/);
  assert.match(settlement, /splitGoldForParty\(/);
  assert.doesNotMatch(settlement, /30 \+ \(role\.level \|\| 1\) \* 2/);
});
