const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createControlPanel } = require('../control-panel');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-control-')); }

test('control panel serves local UI and exposes protected status on a temporary port', async () => {
  const rootDir = tempDir();
  const stateFile = path.join(rootDir, 'runtime-state.json');
  const supervisor = {
    getStatus: () => ({ state: 'stopped', pid: null, port: 0, managed: false }),
    getLogs: () => [],
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    restart: async () => ({ state: 'running' }),
    close: async () => {},
  };
  const panel = createControlPanel({ rootDir: path.join(__dirname, '..'), port: 0, password: 'integration-password', stateFile, supervisor, autoStart: false });
  try {
    const address = await panel.start();
    const base = `http://${address.host}:${address.port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /服务控制台/);
    const login = await fetch(`${base}/api/control/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'integration-password' }) });
    const credentials = await login.json();
    const status = await fetch(`${base}/api/control/status`, { headers: { authorization: `Bearer ${credentials.token}`, 'x-csrf-token': credentials.csrfToken, origin: base } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status.server.state, 'stopped');
  } finally {
    await panel.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
