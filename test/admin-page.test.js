const assert = require('node:assert/strict');
const test = require('node:test');
const { makeTempDbPath, startServer } = require('./helpers/server-fixture');

test('admin page is served only when administrator access is configured', async () => {
  const unconfigured = await startServer({
    dbPath: makeTempDbPath('admin-page-disabled'),
    env: { ADMIN_PASSWORD: undefined },
  });
  try {
    const response = await fetch(`${unconfigured.baseUrl}/admin`);
    assert.equal(response.status, 404);
    const traversal = await fetch(`${unconfigured.baseUrl}/foo/../admin.html`);
    assert.equal(traversal.status, 404);
    const backslashTraversal = await fetch(`${unconfigured.baseUrl}/admin%5C..%5Cadmin.html`);
    assert.equal(backslashTraversal.status, 404);
  } finally {
    await unconfigured.stop();
  }

  const configured = await startServer({
    dbPath: makeTempDbPath('admin-page-enabled'),
    env: { ADMIN_PASSWORD: 'page-test-password' },
  });
  try {
    const response = await fetch(`${configured.baseUrl}/admin`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/html\b/);

    const html = await response.text();
    assert.match(html, /id="admin-login"/);
    assert.match(html, /id="player-search"/);
    assert.match(html, /id="player-results"/);
    assert.match(html, /id="character-editor"/);
    assert.match(html, /id="audit-list"/);
    assert.match(html, /id="logout-button"/);

    const css = await fetch(`${configured.baseUrl}/admin.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') || '', /^text\/css\b/);

    const script = await fetch(`${configured.baseUrl}/admin.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') || '', /^text\/javascript\b/);
  } finally {
    await configured.stop();
  }
});
