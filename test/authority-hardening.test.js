const assert = require('node:assert/strict');
const test = require('node:test');

const DB = require('../db');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');

test('SQLite uses WAL, foreign keys, and a busy timeout', () => {
  assert.equal(DB.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(DB.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(DB.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('characters have indexes for ownership and update ordering', () => {
  const indexes = DB.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_characters_%'").all().map(row => row.name);
  assert.ok(indexes.includes('idx_characters_user_id'));
  assert.ok(indexes.includes('idx_characters_updated_at'));
});

test('player character saves protect authoritative progression fields', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /AUTHORITATIVE_CHARACTER_FIELDS/);
  assert.match(server, /角色经济与战斗字段只能由服务端操作/);
});

test('root server does not reference the removed xianxia realm mapper', () => {
  // DNF60: character_class 固定为职业，不随等级/境界回写。旧境界函数 cultivationRealmForLevel
  // 已在根 server.js 移除，若再次出现会导致结算 ReferenceError（曾致 洛兰 探险以 failed 收场）。
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /cultivationRealmForLevel/);
});

test('server exposes versioned authoritative character actions', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /\/action\$/);
  assert.match(server, /inventory_equip/);
  assert.match(server, /inventory_unequip/);
  assert.match(server, /skill_equip/);
  assert.match(server, /skill_unequip/);
  assert.match(server, /library_buy/);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function startAuthorityServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'authority-test-password', TAVERN_LOAD_ENV: '0', AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '', TAVERN_DB_PATH: path.join(os.tmpdir(), `authority-test-${port}.db`) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill();
  throw new Error('server did not become ready');
}

async function stopAuthorityServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

test('authoritative actions mutate only server-owned inventory and skill state', async t => {
  const { child, base } = await startAuthorityServer();
  t.after(() => stopAuthorityServer(child));
  const username = `a${Math.random().toString(36).slice(2, 11)}`;
  const register = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'password123' }) });
  assert.equal(register.status, 200);
  const token = (await register.json()).token;
  const created = await fetch(`${base}/api/character/create`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ creation_request_id: `req-${Date.now()}-${Math.random()}`, name: `权威${Math.random().toString(36).slice(2, 9)}`, root: 'mage', gender: '男', pers: '重诺', items: ['sword', 'hp_potion'] }),
  });
  assert.equal(created.status, 200);
  const role = await created.json();
  const id = role.id;
  let current = await (await fetch(`${base}/api/character/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
  const tampered = await fetch(`${base}/api/character/${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ updated_at: current.updated_at, character: { ...current.character, gold: 999999 } }) });
  assert.equal(tampered.status, 400);
  const bought = await fetch(`${base}/api/character/${id}/action`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'library_buy', code: 'tuna', updated_at: current.updated_at }) });
  assert.equal(bought.status, 200);
  const boughtBody = await bought.json();
  assert.equal(boughtBody.character.gold, current.character.gold - 50);
  assert.ok(boughtBody.character.skills.some(skill => skill.name === '里鬼剑术'));
  current = boughtBody;
  // 初始装备即入随身装备（职业武器+治疗药水），背包为空；此处把第一件从装备栏卸入背包
  const unequipped = await fetch(`${base}/api/character/${id}/action`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'inventory_unequip', index: 0, updated_at: current.updated_at }) });
  assert.equal(unequipped.status, 200);
  const unequippedBody = await unequipped.json();
  assert.equal(unequippedBody.character.equipment.length, 1);
  assert.equal(unequippedBody.character.bag.length, 1);
  const stale = await fetch(`${base}/api/character/${id}/action`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'inventory_unequip', index: 0, updated_at: current.updated_at }) });
  assert.equal(stale.status, 409);
});
