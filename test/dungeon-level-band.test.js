const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const GE = require('../game-engine.js');

const EXPECTED_BANDS = [
  ['洛兰', 1, 3, 'Lv.1-3'],
  ['幽暗密林', 4, 6, 'Lv.4-6'],
  ['雷鸣废墟', 7, 9, 'Lv.7-9'],
  ['格拉卡', 10, 12, 'Lv.10-12'],
  ['天空之城·龙人之塔', 13, 15, 'Lv.13-15'],
  ['天空之城·黑暗玄廊', 16, 18, 'Lv.16-18'],
  ['天帷巨兽·神殿外围', 19, 19, 'Lv.19'],
];

test('DUNGEON_POOL has the seven authoritative maps with matching level bands', () => {
  assert.equal(GE.DUNGEON_POOL.length, EXPECTED_BANDS.length);
  EXPECTED_BANDS.forEach(([name, min, max, label], index) => {
    const dungeon = GE.DUNGEON_POOL[index];
    assert.equal(dungeon.name, name);
    assert.equal(dungeon.levelMin, min);
    assert.equal(dungeon.levelMax, max);
    assert.equal(dungeon.level_desc, label);
  });
});

test('each DNF dungeon ships three named special event templates', () => {
  for (const dungeon of GE.DUNGEON_POOL) {
    const events = dungeon.specialEvents || [];
    assert.equal(events.length, 3, `${dungeon.name} should have 3 special events`);
    assert.equal(new Set(events.map(event => event.name)).size, 3, `${dungeon.name} event names must be unique`);
    for (const event of events) {
      assert.ok(String(event.name || '').trim().length >= 2, `${dungeon.name} event needs a name`);
      assert.ok(String(event.desc || '').trim().length >= 8, `${dungeon.name} event needs a real description`);
    }
  }
});

test('applyDungeonSetup resolves a special event from the current map pool', () => {
  for (const base of GE.DUNGEON_POOL) {
    const dungeon = GE.applyDungeonSetup(base, { specialEvent: true, enemies: [] });
    assert.equal(dungeon.specialEvent, true);
    assert.ok(dungeon.activeSpecialEvent && dungeon.activeSpecialEvent.name, `${base.name} active event is missing`);
    assert.ok(
      base.specialEvents.some(event => event.name === dungeon.activeSpecialEvent.name && event.desc === dungeon.activeSpecialEvent.desc),
      `${base.name} active event must come from its own template pool`,
    );
    assert.ok(dungeon.enemies.length >= 1, 'special setup with no AI enemies must roll a fallback encounter');
  }
  const normal = GE.applyDungeonSetup(GE.DUNGEON_POOL[0], { specialEvent: false });
  assert.equal(normal.activeSpecialEvent, null);
});

test('rollEnemies keeps normal and special enemies inside the current map band', () => {
  const dungeon = GE.DUNGEON_POOL.find(entry => entry.name === '雷鸣废墟');
  for (let i = 0; i < 120; i++) {
    for (const enemy of GE.rollEnemies(dungeon, false)) {
      assert.ok(enemy.level >= 7 && enemy.level <= 9, `normal enemy level ${enemy.level} out of band`);
    }
    const special = GE.rollEnemies(dungeon, true);
    assert.ok(special.length >= 1, 'special event must keep at least one enemy');
    for (const enemy of special) {
      assert.ok(enemy.level >= 7 && enemy.level <= 9, `special enemy level ${enemy.level} out of band`);
    }
  }
});

test('applyDungeonSetup clamps AI levels and bosses into the map band', () => {
  const base = GE.DUNGEON_POOL.find(entry => entry.name === '幽暗密林');
  const dungeon = GE.applyDungeonSetup(base, {
    isHidden: true,
    specialEvent: true,
    enemies: [
      { name: '树精', level: 'Lv.19' },
      { name: '猫妖', level: 'Lv.1' },
      { name: '池外敌人', level: 'Lv.9' },
    ],
  });
  assert.deepEqual(dungeon.enemies.map(enemy => enemy.level), [6, 4]);
  assert.deepEqual(dungeon.bosses.map(boss => boss.level), [5, 6]);
});

test('createDg and pickDungeon stay inside level bands including the final map', () => {
  const dg = GE.createDg({ level: 19 }, { choice: '天空之城·黑暗玄廊' });
  assert.deepEqual(dg.dungeon.bosses.map(boss => boss.level), [17, 18]);
  for (const enemy of dg.dungeon.enemies) {
    assert.ok(enemy.level >= 16 && enemy.level <= 18, `enemy level ${enemy.level} out of band`);
  }
  assert.equal(GE.pickDungeon({ level: 19 }).name, '天帷巨兽·神殿外围');
});

test('server normalizeAiSetup clamps to the level band supplied with the dungeon', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const source = server.slice(server.indexOf('function normalizeAiSetup'), server.indexOf('async function aiDecideSetup'));
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  const parsed = context.normalizeAiSetup(
    { enemies: [{ name: '树精', level: 'Lv.19' }, { name: '猫妖', level: 'Lv.1' }] },
    { enemies: [{ name: '树精' }, { name: '猫妖' }], levelMin: 4, levelMax: 6 }
  );
  assert.deepEqual(parsed.enemies.map(enemy => enemy.level), [6, 4]);
});

test('legacy dungeons without a level band still fall back to the old 1 to 19 range', () => {
  const base = { name: '枯骨林', enemies: [{ name: '腐骨妖狼' }], bosses: [{ name: '白骨将军' }] };
  assert.deepEqual(GE.dungeonLevelBand(base), [1, 19]);
  assert.equal(GE.clampDungeonLevel(base, 'Lv.3'), 3);
  const dungeon = GE.applyDungeonSetup(base, { enemies: [{ name: '腐骨妖狼', level: 'Lv.3' }] });
  assert.deepEqual(dungeon.enemies.map(enemy => enemy.level), [3]);
});
