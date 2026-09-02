const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadRuntimeState, saveRuntimeState, redact } = require('../control-runtime');
const { createControlPanel } = require('../control-panel');

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-runtime-'));
  return { dir, file: path.join(dir, 'runtime-state.json') };
}

function fakeSupervisor() {
  const listeners = new Set();
  const messages = [];
  const status = { state: 'running', pid: 4321, port: 8787, managed: true, startedAt: 1, healthAt: 2, exitCode: null, error: '' };
  return {
    messages,
    start: async () => status,
    stop: async () => ({ ...status, state: 'stopped', pid: null }),
    restart: async () => status,
    getStatus: () => ({ ...status }),
    getLogs: () => [],
    onStatus: () => () => {},
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    send: message => {
      messages.push(message);
      queueMicrotask(() => listeners.forEach(listener => listener({ type: 'runtime_config_ack', version: message.version })));
      return true;
    },
    close: async () => {},
  };
}

test('runtime state uses persisted override before env and default', () => {
  const { file, dir } = tempStateFile();
  try {
    assert.equal(loadRuntimeState(file, { AI_ENABLED: '0' }).aiEnabled, false);
    fs.writeFileSync(file, JSON.stringify({ aiEnabled: true, version: 4 }));
    assert.equal(loadRuntimeState(file, { AI_ENABLED: '0' }).aiEnabled, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runtime state writes atomically and preserves version metadata', () => {
  const { file, dir } = tempStateFile();
  try {
    saveRuntimeState(file, { aiEnabled: false, version: 7, updatedAt: 12 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { aiEnabled: false, version: 7, updatedAt: 12, lastOperation: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction hides provider secrets and bearer tokens', () => {
  const safe = redact('AI_API_KEY=secret Bearer abc123 password=hello');
  assert.doesNotMatch(safe, /secret|abc123|hello/);
});

test('control panel authenticates and waits for runtime AI acknowledgement', async () => {
  const { file, dir } = tempStateFile();
  const supervisor = fakeSupervisor();
  const panel = createControlPanel({ port: 0, password: 'test-password', stateFile: file, supervisor, autoStart: false });
  try {
    const address = await panel.start();
    const base = `http://${address.host}:${address.port}`;
    const login = await fetch(`${base}/api/control/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const credentials = await login.json();
    const headers = { authorization: `Bearer ${credentials.token}`, 'x-csrf-token': credentials.csrfToken, origin: base, 'content-type': 'application/json' };
    const toggled = await fetch(`${base}/api/control/ai/toggle`, { method: 'POST', headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json()).status.aiEnabled, false);
    assert.equal(supervisor.messages[0].aiEnabled, false);
  } finally {
    await panel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control panel reapplies persisted AI state after server start', async () => {
  const { file, dir } = tempStateFile();
  fs.writeFileSync(file, JSON.stringify({ aiEnabled: false, version: 4 }));
  const supervisor = fakeSupervisor();
  const panel = createControlPanel({ port: 0, password: 'test-password', stateFile: file, supervisor, autoStart: false });
  try {
    const address = await panel.start();
    const base = `http://${address.host}:${address.port}`;
    const login = await fetch(`${base}/api/control/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'test-password' }),
    });
    const credentials = await login.json();
    const headers = { authorization: `Bearer ${credentials.token}`, 'x-csrf-token': credentials.csrfToken, origin: base };
    const started = await fetch(`${base}/api/control/server/start`, { method: 'POST', headers });
    assert.equal(started.status, 200);
    assert.equal(supervisor.messages[0].type, 'runtime_config');
    assert.equal(supervisor.messages[0].aiEnabled, false);
    assert.equal(supervisor.messages[0].version, 5);
  } finally {
    await panel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control panel loads CONTROL_PANEL_PASSWORD from its project .env', async () => {
  const dir = tempStateFile().dir;
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.env'), 'CONTROL_PANEL_PASSWORD=from-dot-env\n');
  const supervisor = fakeSupervisor();
  const panel = createControlPanel({ rootDir: projectDir, port: 0, supervisor, autoStart: false });
  try {
    const address = await panel.start();
    const base = `http://${address.host}:${address.port}`;
    const login = await fetch(`${base}/api/control/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'from-dot-env' }),
    });
    assert.equal(login.status, 200);
  } finally {
    await panel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
