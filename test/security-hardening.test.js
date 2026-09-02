const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startProvider({ delay = 0, responses = null } = {}) {
  let hits = 0, index = 0;
  const provider = http.createServer((req, res) => {
    hits++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const content = Array.isArray(responses) ? responses[Math.min(index++, responses.length - 1)] : '测试叙事';
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }, delay);
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  return { provider, baseURL: `http://127.0.0.1:${provider.address().port}`, get hits() { return hits; } };
}

async function startServer(overrides = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'test-admin-password',
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { child, base };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill();
  throw new Error('server did not become ready');
}

async function login(base) {
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `s${Math.random().toString(36).slice(2, 12)}`, password: 'password123' }),
  });
  assert.equal(registered.status, 200);
  return (await registered.json()).token;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('static server rejects private project files', async t => {
  const { child, base } = await startServer();
  t.after(() => stopServer(child));

  for (const file of ['ai.config.json', 'tavern.db', 'tavern-before-encoding-fix-20260822.db', 'server.js', 'README.md']) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 404, file);
  }
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
});

test('AI routes reject unauthenticated requests before provider access', async t => {
  const { child, base } = await startServer();
  t.after(() => stopServer(child));

  for (const route of ['/api/ai/story', '/api/ai/summary', '/api/ai/death-summary', '/api/ai/outcome', '/api/ai/extract_loot', '/api/ai/trait', '/api/ai/scroll', '/api/ai/forge']) {
    const response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401, route);
  }
});

test('checked-in configuration and launch scripts contain no live/default credentials', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai.config.json'), 'utf8'));
  assert.equal(config.apiKey, '');
  for (const file of ['启动游戏.bat', '启动后台.bat', '启动公网游戏.bat']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /ADMIN_PASSWORD\s*=\s*admin/i, file);
    assert.match(text, /TAVERN_LOAD_ENV\s*=\s*1/i, file);
    assert.doesNotMatch(text, /for\s+\/f.*\.env/i, file);
  }
});

test('game launcher does not start a duplicate server when port 8788 is already listening', () => {
  const launcher = fs.readFileSync(path.join(ROOT, '启动游戏.bat'), 'utf8');
  assert.match(launcher, /netstat\s+-ano[\s\S]*8788[\s\S]*LISTENING/i);
  assert.match(launcher, /if\s+not\s+"%[^%]*%"\s*==\s*""/i);
  assert.match(launcher, /node\s+server\.js/i);
});

test('authenticated AI requests enforce body limit before provider access', async t => {
  const provider = await startProvider();
  const { child, base } = await startServer({ AI_BASE_URL: provider.baseURL, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  t.after(async () => { await stopServer(child); await new Promise(resolve => provider.provider.close(resolve)); });
  const token = await login(base);
  const response = await fetch(`${base}/api/ai/story`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(600 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal(provider.hits, 0);
});

test('AI requests are rate limited per client IP', async t => {
  const provider = await startProvider();
  const { child, base } = await startServer({ AI_BASE_URL: provider.baseURL, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  t.after(async () => { await stopServer(child); await new Promise(resolve => provider.provider.close(resolve)); });
  const token = await login(base);
  let last;
  for (let i = 0; i < 31; i++) {
    last = await fetch(`${base}/api/ai/story`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  }
  assert.equal(last.status, 429);
  assert.equal(provider.hits, 30);
});

test('AI rate limit keys on socket address and ignores spoofed X-Forwarded-For by default', async t => {
  const provider = await startProvider();
  const { child, base } = await startServer({ AI_BASE_URL: provider.baseURL, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  t.after(async () => { await stopServer(child); await new Promise(resolve => provider.provider.close(resolve)); });
  const token = await login(base);
  let last;
  for (let i = 0; i < 31; i++) {
    last = await fetch(`${base}/api/ai/story`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i % 256}` },
      body: '{}',
    });
  }
  assert.equal(last.status, 429);
  assert.equal(provider.hits, 30);
});

test('auth login endpoint rate limits repeated failed attempts per account', async t => {
  const { child, base } = await startServer();
  t.after(() => stopServer(child));
  const username = `u${Math.random().toString(36).slice(2, 9)}`;
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) });
  assert.equal(reg.status, 200);
  let last;
  for (let i = 0; i < 16; i++) {
    last = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'wrongpass' }) });
  }
  assert.equal(last.status, 429);
});

test('AI requests are capped by global concurrency', async t => {
  const provider = await startProvider({ delay: 250 });
  const { child, base } = await startServer({ AI_BASE_URL: provider.baseURL, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  t.after(async () => { await stopServer(child); await new Promise(resolve => provider.provider.close(resolve)); });
  const token = await login(base);
  const requests = Array.from({ length: 5 }, () => fetch(`${base}/api/ai/story`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }));
  const responses = await Promise.all(requests);
  assert.equal(responses.filter(r => r.status === 429).length, 1);
  assert.equal(provider.hits, 4);
});

test('story route rewrites one player using another player item', async t => {
  const provider = await startProvider({ responses: ['乙玩家摇动净魂道铃，铃音清越。', '甲玩家摇动净魂道铃，铃音清越。'] });
  const { child, base } = await startServer({ AI_BASE_URL: provider.baseURL, AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });
  t.after(async () => { await stopServer(child); await new Promise(resolve => provider.provider.close(resolve)); });
  const token = await login(base);
  const response = await fetch(`${base}/api/ai/story`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      dungeon: '枯骨林',
      baseDungeon: '枯骨林',
      stage: 'battle',
      actor: '甲玩家',
      roll: 10,
      mod: 0,
      total: 10,
      party: [
        { name: '甲玩家', items: [{ name: '净魂道铃', kind: 'misc', qty: 1 }] },
        { name: '乙玩家', items: [] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.text, /甲玩家摇动净魂道铃/);
  assert.equal(provider.hits, 2);
});
