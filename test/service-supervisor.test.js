const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createServiceSupervisor } = require('../service-supervisor');

function createFakeProcess(options = {}) {
  const pid = 4321;
  const health = Array.isArray(options.health) ? options.health.slice() : [true];
  let stopReleased = !options.holdStop;
  let child = null;
  const releaseStop = () => {
    stopReleased = true;
    if (child && child._killRequested) {
      child._killRequested = false;
      child.emit('exit', 0, null);
    }
  };
  const spawn = () => {
    child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child._killRequested = false;
    child.kill = () => {
      child._killRequested = true;
      if (stopReleased) queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    };
    child.send = (message, callback) => { if (callback) callback(null); child.emit('message', message); };
    return child;
  };
  const healthCheck = async () => health.length ? health.shift() : true;
  return { pid, spawn, healthCheck, releaseStop };
}

test('starts server, waits for health, and exposes managed pid', async () => {
  const fake = createFakeProcess({ health: [false, true] });
  const supervisor = createServiceSupervisor({ spawnImpl: fake.spawn, healthCheck: fake.healthCheck, findPortOwner: async () => null, healthAttempts: 3, healthIntervalMs: 0 });
  const status = await supervisor.start();
  assert.equal(status.state, 'running');
  assert.equal(status.managed, true);
  assert.equal(status.pid, fake.pid);
});

test('rejects a second lifecycle operation while restarting', async () => {
  const fake = createFakeProcess({ holdStop: true, health: [true, true] });
  const supervisor = createServiceSupervisor({ spawnImpl: fake.spawn, healthCheck: fake.healthCheck, findPortOwner: async () => null, stopTimeoutMs: 10_000 });
  await supervisor.start();
  const first = supervisor.restart();
  await assert.rejects(() => supervisor.restart(), error => error.code === 'operation_in_progress');
  fake.releaseStop();
  await first;
});

test('does not kill an unknown process occupying the port', async () => {
  const supervisor = createServiceSupervisor({ port: 8787, findPortOwner: async () => ({ pid: 777 }) });
  await assert.rejects(() => supervisor.start(), error => error.code === 'port_occupied');
});
