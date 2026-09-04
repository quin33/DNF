const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const TEST_DB_PATH = makeTempDbPath('seria-inn');
process.env.TAVERN_DB_PATH = TEST_DB_PATH;
process.env.TAVERN_LOAD_ENV = '0';
const DB = require('../db');

const suffix = `seria-inn-${process.pid}-${Date.now()}`;
const username = `player-${suffix}`;
let userId;
let token;
let chars = {};
let serverFixture;
let baseUrl;

function baseCharacter(name, overrides = {}) {
  const now = Date.now();
  return {
    name,
    character_class: '鬼剑士',
    level: 1,
    hp: 80,
    max_hp: 100,
    stamina: 100,
    max_stamina: 100,
    gold: 500,
    exp: 0,
    status: 'resting',
    strength: 10,
    agility: 10,
    intelligence: 10,
    luck: 10,
    equipment: [],
    bag: [],
    skills: [],
    skillPool: [],
    consumableSlots: [],
    hpTs: now,
    staminaTs: now,
    ...overrides,
  };
}

async function request(method, urlPath, { token: useToken = token, body } = {}) {
  const headers = {};
  if (useToken) headers.authorization = `Bearer ${useToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let responseBody = null;
  if (text) {
    try { responseBody = JSON.parse(text); }
    catch { responseBody = text; }
  }
  return { status: response.status, body: responseBody };
}

async function characterAction(charId, actionName, payload = {}) {
  const current = DB.getCharacter(userId, charId);
  return request('POST', `/api/character/${charId}/action`, {
    body: { action: actionName, updated_at: current.updated_at, ...payload },
  });
}

test.before(async () => {
  userId = Number(DB.createUser(username, 'hash', 'salt'));
  token = `token-${suffix}`;
  DB.createSession(userId, token);
  chars.blocked = Number(DB.createCharacter(userId, `Blocked ${suffix}`, baseCharacter(`Blocked ${suffix}`, { hp: 70 })));
  chars.goldShort = Number(DB.createCharacter(userId, `Gold ${suffix}`, baseCharacter(`Gold ${suffix}`, { hp: 80 })));
  chars.full = Number(DB.createCharacter(userId, `Full ${suffix}`, baseCharacter(`Full ${suffix}`, { hp: 100 })));
  serverFixture = await startServer({ dbPath: TEST_DB_PATH });
  baseUrl = serverFixture.baseUrl;
});

test.after(async () => {
  if (serverFixture) await serverFixture.stop({ cleanup: false });
  if (typeof DB.db.close === 'function') DB.db.close();
  await cleanupDatabaseFiles(TEST_DB_PATH);
});

test('seria inn is registered as a featured building and has modal entry points', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
  assert.match(data, /code: 'seria_inn'/);
  assert.match(data, /赛利亚旅馆/);
  assert.match(html, /FEATURED_BUILDING_CODES\s*=\s*new Set\(\[[^\]]*'seria_inn'[^\]]*\]\)/);
  assert.match(html, /treating:'治疗中'/);
  assert.match(html, /function openSeriaInnModal\(\)/);
  assert.match(html, /function startSeriaInnTreatment\(\)/);
  assert.match(html, /function exitSeriaInnTreatment\(\)/);
});

test('inn start marks treating, blocks other actions, and exit before a minute is free', async () => {
  const started = await characterAction(chars.blocked, 'inn_start');
  assert.equal(started.status, 200);
  assert.equal(started.body.character.status, 'treating');
  assert.equal(started.body.character.seriaInn.minutes, 0);
  assert.equal(started.body.character.gold, 500);

  const library = await characterAction(chars.blocked, 'library_buy', { code: 'tuna' });
  assert.equal(library.status, 400);
  assert.equal(library.body.code, 'character_busy');
  assert.match(String(library.body.error || ''), /治疗/);

  const equipment = await characterAction(chars.blocked, 'inventory_unequip');
  assert.equal(equipment.status, 400);
  assert.equal(equipment.body.code, 'character_busy');

  const exited = await characterAction(chars.blocked, 'inn_exit');
  assert.equal(exited.status, 200);
  assert.equal(exited.body.character.status, 'resting');
  assert.equal(exited.body.character.seriaInn, undefined);
  assert.equal(exited.body.character.hp, 70);
  assert.equal(exited.body.character.gold, 500);
  assert.equal(exited.body.event.type, 'seria_inn_exited');
});

test('insufficient gold settles paid minute then stops', async () => {
  const started = await characterAction(chars.goldShort, 'inn_start');
  assert.equal(started.status, 200);
  const latest = DB.getCharacter(userId, chars.goldShort);
  latest.data.gold = 15;
  latest.data.seriaInn.lastTickAt = Date.now() - 61 * 1000;
  DB.saveCharacter(userId, chars.goldShort, latest.data, latest.data.name);

  const exited = await characterAction(chars.goldShort, 'inn_exit');
  assert.equal(exited.status, 200);
  assert.equal(exited.body.character.hp, 82);
  assert.equal(exited.body.character.gold, 5);
  assert.equal(exited.body.character.seriaInn, undefined);
  assert.equal(exited.body.event.type, 'seria_inn_stopped_insufficient_gold');
  assert.equal(exited.body.event.minutes, 1);
  assert.equal(exited.body.event.hpGain, 2);
  assert.equal(exited.body.event.goldCost, 10);
});

test('full-heal settlement releases character before a later action', async () => {
  const current = DB.getCharacter(userId, chars.full);
  current.data.hp = 98;
  DB.saveCharacter(userId, chars.full, current.data, current.data.name);
  const started = await characterAction(chars.full, 'inn_start');
  assert.equal(started.status, 200);

  const aged = DB.getCharacter(userId, chars.full);
  aged.data.seriaInn.lastTickAt = Date.now() - 61 * 1000;
  DB.saveCharacter(userId, chars.full, aged.data, aged.data.name);

  const ordered = await characterAction(chars.full, 'tavern_order', { code: 'pale_ale' });
  assert.equal(ordered.status, 200);
  assert.equal(ordered.body.character.hp, 100);
  assert.equal(ordered.body.character.gold, 488);
  assert.equal(ordered.body.character.status, 'resting');
  assert.equal(ordered.body.character.seriaInn, undefined);
});

test('full character cannot start inn treatment', async () => {
  const full = DB.getCharacter(userId, chars.full);
  const blocked = await request('POST', `/api/character/${chars.full}/action`, {
    body: { action: 'inn_start', updated_at: full.updated_at },
  });
  assert.equal(blocked.status, 400);
  assert.match(String(blocked.body.error || ''), /生命已满/);
});
