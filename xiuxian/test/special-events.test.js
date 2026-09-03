const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const GE = require('../game-engine.js');

test('each xianxia dungeon ships three named special event templates', () => {
  assert.equal(GE.DUNGEON_POOL.length, 7);
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

test('applyDungeonSetup resolves a special event from the current dungeon pool', () => {
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

test('special event prompt carries the active xianxia template into the narrative', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('function buildUserMessage');
  const source = server.slice(start, server.indexOf('\n/*', start));
  const context = {};
  vm.createContext(context);
  vm.runInContext(source + '\nthis.buildUserMessage = buildUserMessage;', context);
  const prompt = context.buildUserMessage({
    flowMode: 'dynamic', dungeon: '枯骨林', specialEvent: true,
    activeSpecialEvent: { name: '阴兵借道', desc: '成列阴兵抬着残旗穿林而过。' },
    party: [], stepNo: 3, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'explore', stage: 'explore', stageLabel: '探索', quest: { status: 'active', objective: '查清异动' },
    encounter: { status: 'none', name: '' },
  });
  assert.match(prompt, /阴兵借道/);
  assert.match(prompt, /成列阴兵抬着残旗穿林而过/);
  assert.match(prompt, /把这一异象贯穿始终/);
});
