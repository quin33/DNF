const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('server exposes runtime AI control and IPC acknowledgement', () => {
  assert.match(serverSource, /ai_disabled/);
  assert.match(serverSource, /process\.on\(['"]message['"]/);
  assert.match(serverSource, /runtime_config_ack/);
});

test('health exposes runtime AI state without secrets', () => {
  assert.match(serverSource, /getRuntimeAiStatus/);
  assert.match(serverSource, /ai:\s*getRuntimeAiStatus\(\)/);
  assert.doesNotMatch(serverSource, /ai:\s*\{[^}]*apiKey\s*:/s);
});

test('runtime AI state ignores stale IPC versions', () => {
  assert.match(serverSource, /Number\(message\.version\)\s*<=\s*runtimeAiState\.version/);
});

