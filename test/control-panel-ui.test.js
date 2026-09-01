const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'control-panel.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'control-panel.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'control-panel-ui.js'), 'utf8');

test('control panel includes protected operations and status surfaces', () => {
  assert.match(html, /服务器状态/);
  assert.match(html, /AI 服务/);
  assert.match(html, /启动服务器/);
  assert.match(html, /重启服务器/);
  assert.match(html, /ai-toggle/);
  assert.match(html, /log-list/);
});

test('control panel UI uses authenticated API calls and refresh polling', () => {
  assert.match(js, /api\/control\/login/);
  assert.match(js, /api\/control\/status/);
  assert.match(js, /api\/control\/logs/);
  assert.match(js, /setInterval\(/);
  assert.match(js, /x-csrf-token/);
});

test('control panel styles cover responsive and accessible interaction states', () => {
  assert.match(css, /@media/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /:disabled/);
  assert.match(css, /prefers-reduced-motion/);
});
