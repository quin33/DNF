const assert = require('node:assert/strict');
const test = require('node:test');

test('the game page has no legacy navigation shell and keeps the theme toggle', async () => {
  const response = await fetch('http://127.0.0.1:8787/');
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(html.includes('class="app-sidebar"'), false);
  assert.equal(html.includes('class="navbar-brand"'), false);
  assert.equal(html.includes('id="theme-toggle"'), true);
});
