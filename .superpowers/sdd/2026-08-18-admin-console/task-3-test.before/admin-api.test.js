const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const DB = require('../db');

const ROOT = path.resolve(__dirname, '..');
const suffix = `admin-api-${process.pid}-${Date.now()}`;
const adminPassword = `secret-${suffix}`;
const username = `player-${suffix}`;
const smokeUsername = `smoke${process.pid}${Date.now().toString(36)}`.slice(0, 20);
const smokePassword = `player-password-${suffix}`;
const originalCharacter = {
  name: `Fixture ${suffix}`,
  character_class: 'Warrior',
  level: 8,
  hp: 42,
  max_hp: 50,
  stamina: 12,
  max_stamina: 20,
  strength: 9,
  agility: 7,
  intelligence: 5,
  luck: 4,
  gold: 123,
  exp: 456,
  traits: ['Steady'],
  equipment: [{ name: 'Sword', slot: 'weapon' }],
  bag: [{ name: 'Potion', qty: 2 }],
  skills: [{ name: 'Slash', desc: 'A measured strike.' }],
  skillPool: [{ name: 'Guard', desc: 'A guarded stance.' }],
  hidden: 'must survive admin updates',
};

let userId;
let characterId;
let playerToken;
let adminToken;
let serverProcess;
let baseUrl;
let smokeUserId;
let smokeCharacterId;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function startServer(password) {
  const port = await getFreePort();
  const env = { ...process.env, PORT: String(port) };
  if (password === undefined) delete env.ADMIN_PASSWORD;
  else env.ADMIN_PASSWORD = password;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(url, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${output}`);
  }
  return { child, url };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ]);
}

async function request(method, urlPath, { token, body, rawBody } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let responseBody = null;
  if (text) {
    try { responseBody = JSON.parse(text); }
    catch { responseBody = text; }
  }
  return { status: response.status, body: responseBody };
}

function adminRequest(method, urlPath, body) {
  return request(method, urlPath, { token: adminToken, body });
}

test.before(async () => {
  userId = Number(DB.createUser(username, 'hash', 'salt'));
  characterId = Number(DB.createCharacter(userId, originalCharacter.name, originalCharacter));
  playerToken = `${suffix}-player-token`;
  DB.createSession(userId, playerToken);

  const started = await startServer(adminPassword);
  serverProcess = started.child;
  baseUrl = started.url;
});

test.after(async () => {
  await stopServer(serverProcess);
  const smokeUser = DB.findUserByUsername(smokeUsername);
  const cleanupSmokeUserId = Number.isInteger(smokeUserId) ? smokeUserId : Number(smokeUser && smokeUser.id);
  if (Number.isInteger(cleanupSmokeUserId)) {
    DB.db.prepare('DELETE FROM logs WHERE user_id = ?').run(cleanupSmokeUserId);
    DB.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(cleanupSmokeUserId);
    DB.db.prepare('DELETE FROM characters WHERE user_id = ?').run(cleanupSmokeUserId);
    DB.db.prepare('DELETE FROM users WHERE id = ?').run(cleanupSmokeUserId);
  }
  if (Number.isInteger(characterId)) {
    DB.db.prepare('DELETE FROM admin_audit_logs WHERE character_id = ?').run(characterId);
    DB.db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
  }
  DB.db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(adminToken || '');
  if (playerToken) DB.db.prepare('DELETE FROM sessions WHERE token = ?').run(playerToken);
  if (Number.isInteger(userId)) DB.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

test('spawned server preserves player login sessions and character access', async () => {
  const registered = await request('POST', '/api/auth/register', {
    body: { username: smokeUsername, password: smokePassword },
  });
  assert.equal(registered.status, 200);
  smokeUserId = Number(registered.body.user.id);

  const registeredLogout = await request('POST', '/api/auth/logout', {
    token: registered.body.token,
  });
  assert.equal(registeredLogout.status, 200);

  const loggedIn = await request('POST', '/api/auth/login', {
    body: { username: smokeUsername, password: smokePassword },
  });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.user.id, smokeUserId);

  const created = await request('POST', '/api/character', {
    token: loggedIn.body.token,
    body: { character: { name: 'Smoke Hero', hp: 10, max_hp: 10, bag: [] } },
  });
  assert.equal(created.status, 200);
  smokeCharacterId = Number(created.body.id);

  const me = await request('GET', '/api/me', { token: loggedIn.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, smokeUsername);
  assert.equal(me.body.characters.length, 1);
  assert.equal(me.body.characters[0].id, smokeCharacterId);
  assert.equal(me.body.characters[0].name, 'Smoke Hero');
  assert.equal(typeof me.body.characters[0].updated_at, 'number');

  const character = await request('GET', `/api/character/${smokeCharacterId}`, {
    token: loggedIn.body.token,
  });
  assert.equal(character.status, 200);
  assert.equal(character.body.id, smokeCharacterId);
  assert.equal(character.body.character.name, 'Smoke Hero');
  assert.equal(character.body.character.hp, 10);
});

test('admin login denies missing configuration and wrong passwords, then creates a bearer session', async () => {
  const unconfigured = await startServer(undefined);
  try {
    const response = await fetch(`${unconfigured.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });
    assert.equal(response.status, 401);
  } finally {
    await stopServer(unconfigured.child);
  }

  const denied = await request('POST', '/api/admin/login', { body: { password: `${adminPassword}-wrong` } });
  assert.equal(denied.status, 401);

  const accepted = await request('POST', '/api/admin/login', { body: { password: adminPassword } });
  assert.equal(accepted.status, 200);
  assert.equal(typeof accepted.body.token, 'string');
  assert.ok(accepted.body.token.length >= 32);
  assert.equal(DB.adminSessionValid(accepted.body.token), true);
  adminToken = accepted.body.token;
});

test('admin endpoints reject missing credentials and ordinary player sessions', async () => {
  const missing = await request('GET', '/api/admin/players');
  assert.equal(missing.status, 401);

  const player = await request('GET', '/api/admin/players', { token: playerToken });
  assert.equal(player.status, 401);
});

test('admin can search players and read a character with its owner and version', async () => {
  const search = await adminRequest('GET', `/api/admin/players?q=${encodeURIComponent(username)}`);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.players, [{
    userId,
    username,
    characterId,
    characterName: originalCharacter.name,
  }]);

  const detail = await adminRequest('GET', `/api/admin/characters/${characterId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.character.id, characterId);
  assert.equal(detail.body.character.userId, userId);
  assert.equal(detail.body.character.username, username);
  assert.equal(typeof detail.body.character.updated_at, 'number');
  assert.deepEqual(detail.body.character.data, originalCharacter);

  const missing = await adminRequest('GET', '/api/admin/characters/999999999');
  assert.equal(missing.status, 404);
});

test('admin save updates only submitted whitelist fields and records safe audit snapshots', async () => {
  const before = DB.getCharacterAdmin(characterId);
  const response = await adminRequest('PUT', `/api/admin/characters/${characterId}`, {
    updated_at: before.updated_at,
    character: { name: 'Updated Fixture', hp: 45, traits: ['Steady', 'Focused'] },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.character.data.name, 'Updated Fixture');
  assert.equal(response.body.character.data.hp, 45);
  assert.equal(response.body.character.data.gold, originalCharacter.gold);
  assert.equal(response.body.character.data.hidden, originalCharacter.hidden);
  assert.notEqual(response.body.character.updated_at, before.updated_at);

  const audit = await adminRequest('GET', `/api/admin/audit?characterId=${characterId}`);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.logs.length, 1);
  assert.equal(audit.body.logs[0].before.hp, originalCharacter.hp);
  assert.equal(audit.body.logs[0].after.hp, 45);
  assert.equal(audit.body.logs[0].before.hidden, undefined);
  assert.equal(audit.body.logs[0].after.hidden, undefined);
});

test('admin save rejects unknown fields, invalid numbers, invalid arrays, and oversized text or inventories', async t => {
  const cases = [
    ['unknown field', { character: { pass_hash: 'forbidden' } }],
    ['negative number', { character: { gold: -1 } }],
    ['resource above maximum', { character: { hp: 51, max_hp: 50 } }],
    ['stamina above maximum', { character: { stamina: 21, max_stamina: 20 } }],
    ['non-array collection', { character: { bag: { name: 'not-an-array' } } }],
    ['malformed collection item', { character: { bag: ['not-an-item-object'] } }],
    ['overlong text', { character: { name: 'x'.repeat(10_001) } }],
    ['oversized inventory', { character: { bag: Array.from({ length: 101 }, (_, i) => ({ name: `item-${i}` })) } }],
  ];

  for (const [name, partial] of cases) {
    await t.test(name, async () => {
      const current = DB.getCharacterAdmin(characterId);
      const response = await adminRequest('PUT', `/api/admin/characters/${characterId}`, {
        updated_at: current.updated_at,
        ...partial,
      });
      assert.equal(response.status, 400);
    });
  }

  const current = DB.getCharacterAdmin(characterId);
  const nonFinite = await request('PUT', `/api/admin/characters/${characterId}`, {
    token: adminToken,
    rawBody: `{"updated_at":${current.updated_at},"character":{"gold":1e309}}`,
  });
  assert.equal(nonFinite.status, 400);

  const malformedJson = await request('PUT', `/api/admin/characters/${characterId}`, {
    token: adminToken,
    rawBody: '{"character":',
  });
  assert.equal(malformedJson.status, 400);
});

test('admin save returns conflict for a stale version and not found for a missing character', async () => {
  const current = DB.getCharacterAdmin(characterId);
  const conflict = await adminRequest('PUT', `/api/admin/characters/${characterId}`, {
    updated_at: current.updated_at - 1,
    character: { gold: 999 },
  });
  assert.equal(conflict.status, 409);
  assert.equal(DB.getCharacterAdmin(characterId).data.gold, originalCharacter.gold);

  const missing = await adminRequest('PUT', '/api/admin/characters/999999999', {
    updated_at: current.updated_at,
    character: { gold: 999 },
  });
  assert.equal(missing.status, 404);
});

test('admin logout invalidates the current session', async () => {
  const logout = await adminRequest('POST', '/api/admin/logout');
  assert.equal(logout.status, 200);
  assert.equal(logout.body.ok, true);

  const denied = await adminRequest('GET', '/api/admin/players');
  assert.equal(denied.status, 401);
});
