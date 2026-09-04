const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const TEST_DB_PATH = makeTempDbPath('tavern-order');
process.env.TAVERN_DB_PATH = TEST_DB_PATH;
process.env.TAVERN_LOAD_ENV = '0';
const DB = require('../db');

const suffix = `tavern-order-${process.pid}-${Date.now()}`;
let fixture;
let baseUrl;
let userId;
let characterId;
let token;

async function request(method, urlPath, payload, authToken = token) {
  const headers = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  userId = Number(DB.createUser(`player-${suffix}`, 'hash', 'salt'));
  characterId = Number(DB.createCharacter(userId, `Tavern ${suffix}`, {
    name: `Tavern ${suffix}`,
    character_class: '鬼剑士',
    classTitle: '鬼剑士',
    level: 1,
    hp: 100,
    max_hp: 100,
    stamina: 100,
    max_stamina: 100,
    gold: 100,
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
  }));
  token = `${suffix}-token`;
  DB.createSession(userId, token);
  fixture = await startServer({ dbPath: TEST_DB_PATH });
  baseUrl = fixture.baseUrl;
});

test.after(async () => {
  await fixture.stop({ cleanup: false });
  try { DB.db.close(); } catch (_) {}
  await cleanupDatabaseFiles(TEST_DB_PATH);
});

test('tavern_order deducts gold on the server and rejects expensive drinks', async () => {
  const before = DB.getCharacter(userId, characterId);
  assert.equal(before.data.gold, 100);

  const order = await request('POST', `/api/character/${characterId}/action`, {
    action: 'tavern_order',
    code: 'pale_ale',
    updated_at: before.updated_at,
  });
  assert.equal(order.status, 200);
  assert.equal(order.body.character.gold, 98);

  const poor = await request('POST', `/api/character/${characterId}/action`, {
    action: 'tavern_order',
    code: 'abyss_brew',
    updated_at: order.body.updated_at,
  });
  assert.equal(poor.status, 400);
  assert.match(poor.body.error, /金币不足/);

  const after = DB.getCharacter(userId, characterId);
  assert.equal(after.data.gold, 98);
});
