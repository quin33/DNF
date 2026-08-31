const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('index.html', 'utf8');
const match = source.match(/function addFeedBatch\([\s\S]*?\n}\n(?=\/\* 兼容既有调用)/);

test('a forge operation records material consumption and output in one feed entry', () => {
  assert.ok(match, 'addFeedBatch must exist to record an operation as one feed entry');

  const context = {
    D: { my_feed: [] },
    FEED_MAX: 100,
    fmtTimeFull: () => '2026-08-18 19:26',
    saveFeed: () => {},
    document: { getElementById: () => null },
    renderMine: () => {},
  };
  vm.createContext(context);
  vm.runInContext(match[0], context);

  context.addFeedBatch('⚔️', '炼器坊', '炼器成功', [
    { delta: '-1 铁剑', color: 'common' },
    { delta: '-1 暗红骨书', color: 'common' },
    { delta: '+1 血阵铁兵', color: 'rare' },
  ]);

  assert.equal(context.D.my_feed.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.D.my_feed[0].changes)), [
    { delta: '-1 铁剑', color: 'common' },
    { delta: '-1 暗红骨书', color: 'common' },
    { delta: '+1 血阵铁兵', color: 'rare' },
  ]);
});
