const assert = require('node:assert/strict');
const test = require('node:test');
const { createRoomRunner } = require('../room-runner');

function createHarness({ setup, beginError } = {}) {
  const events = { created: [], begun: [], started: [], starting: [], scheduled: [], failed: [] };
  const runner = createRoomRunner({
    aiDecideSetup: async () => setup,
    GE: {
      DUNGEON_POOL: [{ name: '枯骨林' }],
      pickDungeon: () => ({ name: '枯骨林' }),
      createDg: (...args) => {
        events.created.push(args);
        return { id: 'run-1', flowMode: 'dynamic', status: 'created', memberGains: {}, party: [] };
      },
      buildNarrativeFocusPlan: () => [],
    },
    GC: { ROOT_SKILLS: [] },
    beginRun: input => {
      events.begun.push(input);
      if (beginError) throw beginError;
    },
    broadcastAll: message => events.started.push(message),
    broadcastStarting: room => events.starting.push(room),
    scheduleTick: room => events.scheduled.push(room),
    runningSnapshot: () => ({ runId: 'run-1' }),
    onFailure: (...args) => events.failed.push(args),
    console,
  });
  return { ...runner, events };
}

test('starting a room while setup is pending cannot start twice', async () => {
  let resolveSetup;
  const setup = new Promise(resolve => { resolveSetup = resolve; });
  const { startRoomRun, events } = createHarness({ setup });
  const room = { id: 'R1', status: 'waiting', party: [{ isNpc: true, id: 'npc', name: '青竹客' }] };
  const host = {};

  const firstRun = startRoomRun(room, host);
  assert.equal(room.status, 'starting');
  assert.equal(events.starting.length, 1);
  assert.equal(events.begun.length, 0);
  assert.equal(events.started.length, 0);
  const secondRun = startRoomRun(room, host);
  resolveSetup();
  await Promise.all([firstRun, secondRun]);

  assert.equal(events.created.length, 1);
  assert.equal(events.begun.length, 1);
  assert.equal(events.started.length, 1);
  assert.equal(events.scheduled.length, 1);
  assert.equal(events.failed.length, 0);
});

test('a durable begin failure restores the waiting room without broadcasting a start', async () => {
  const beginError = new Error('精力不足');
  const { startRoomRun, events } = createHarness({
    setup: { isHidden: false, specialEvent: false, breakthrough: false, enemies: [] },
    beginError,
  });
  const room = { id: 'R2', status: 'waiting', party: [{ isNpc: true, id: 'npc', name: '青竹客' }] };

  const result = await startRoomRun(room, {});

  assert.equal(result, null);
  assert.equal(room.status, 'waiting');
  assert.equal(room.dg, null);
  assert.equal(events.begun.length, 1);
  assert.equal(events.failed.length, 1);
  assert.equal(events.failed[0][1], beginError);
  assert.deepEqual(events.failed[0][2], { beforeStart: true });
  assert.equal(events.started.length, 0);
  assert.equal(events.scheduled.length, 0);
});
