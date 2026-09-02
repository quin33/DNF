const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

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

async function startServer(dbPath) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'auth-registration-test',
      TAVERN_LOAD_ENV: '0',
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_MODEL: '',
      TAVERN_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return { child, base };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill();
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

function seedLegacyChineseUser(dbPath) {
  const code = `
    const { DatabaseSync } = require('node:sqlite');
    const crypto = require('node:crypto');
    const d = new DatabaseSync(process.env.TAVERN_DB_PATH);
    d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const salt = 'seed-salt';
    const hash = crypto.scryptSync('password123', salt, 64).toString('hex');
    d.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?,?,?,?)').run('张三', hash, salt, Date.now());
    d.close();
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TAVERN_DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('new registration uses ASCII usernames while legacy Chinese logins keep working', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-auth-register-'));
  const dbPath = path.join(dir, 'auth.db');
  seedLegacyChineseUser(dbPath);
  const { child, base } = await startServer(dbPath);
  t.after(async () => { await stopServer(child); fs.rmSync(dir, { recursive: true, force: true }); });

  const legacyLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '张三', password: 'password123' }),
  });
  assert.equal(legacyLogin.status, 200);

  const chineseName = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '李四', password: 'password123' }),
  });
  assert.equal(chineseName.status, 400);

  const shortName = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ab', password: 'password123' }),
  });
  assert.equal(shortName.status, 400);

  const shortPassword = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'new_user_01', password: '12345' }),
  });
  assert.equal(shortPassword.status, 400);

  const suffix = Math.random().toString(36).slice(2, 8);
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: `new_${suffix}`, nickname: '青璃真人', password: 'password123' }),
  });
  assert.equal(registered.status, 200);
  const registeredBody = await registered.json();
  assert.equal(registeredBody.user.nickname, '青璃真人');

  const me = await fetch(`${base}/api/me`, {
    headers: { authorization: `Bearer ${registeredBody.token}` },
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.user.username, `new_${suffix}`);
  assert.equal(meBody.user.nickname, '青璃真人');
});
