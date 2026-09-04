const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const TEST_DB_PATH = makeTempDbPath('kanina-grocery');
process.env.TAVERN_DB_PATH = TEST_DB_PATH;
process.env.TAVERN_LOAD_ENV = '0';
const DB = require('../db');

const suffix = `kanina-grocery-${process.pid}-${Date.now()}`;
let userId;
let characterId;
let token;
let fixture;
let baseUrl;

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

async function groceryAction(code) {
  const current = DB.getCharacter(userId, characterId);
  return request('POST', `/api/character/${characterId}/action`, {
    action: 'grocery_buy',
    code,
    updated_at: current.updated_at,
  });
}

test.before(async () => {
  userId = Number(DB.createUser(`player-${suffix}`, 'hash', 'salt'));
  token = `token-${suffix}`;
  DB.createSession(userId, token);
  characterId = Number(DB.createCharacter(userId, `Kanina ${suffix}`, {
    name: `Kanina ${suffix}`,
    character_class: '鬼剑士',
    level: 1,
    hp: 100,
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
  }));
  fixture = await startServer({ dbPath: TEST_DB_PATH });
  baseUrl = fixture.baseUrl;
});

test.after(async () => {
  await fixture.stop({ cleanup: false });
  try { DB.db.close(); } catch (_) {}
  await cleanupDatabaseFiles(TEST_DB_PATH);
});

test('kanina grocery is a featured building with shop modal entry points', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'data.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(data, /code: 'kanina_grocery'/);
  assert.match(data, /卡妮娜的杂货铺/);
  assert.match(html, /FEATURED_BUILDING_CODES\s*=\s*new Set\(\[[^\]]*'kanina_grocery'[^\]]*\]\)/);
  assert.match(html, /function openKaninaGroceryModal\(\)/);
  assert.match(html, /function renderKaninaGroceryModal\(\)/);
  assert.match(html, /async function buyKaninaGroceryItem\(code\)/);
  assert.match(html, /function kaninaItemCardHTML\(item, role\)/);
  assert.match(server, /action === 'grocery_buy'/);
  assert.match(server, /SERVER_GROCERY_ITEMS/);
});

test('grocery purchase puts potions and gear into the authoritative bag', async () => {
  const potion = await groceryAction('hp_potion');
  assert.equal(potion.status, 200);
  assert.equal(potion.body.character.gold, 490);
  assert.equal(potion.body.character.bag.length, 1);
  assert.equal(potion.body.character.bag[0].name, '生命药水');
  assert.equal(potion.body.character.bag[0].kind, 'pill');
  assert.equal(potion.body.character.bag[0].rarity, 'common');
  assert.equal(potion.body.character.bag[0].qty, 1);

  const secondPotion = await groceryAction('hp_potion');
  assert.equal(secondPotion.status, 200);
  assert.equal(secondPotion.body.character.gold, 480);
  assert.equal(secondPotion.body.character.bag.length, 1);
  assert.equal(secondPotion.body.character.bag[0].qty, 2);

  const weapon = await groceryAction('steel_sword');
  assert.equal(weapon.status, 200);
  assert.equal(weapon.body.character.gold, 330);
  assert.equal(weapon.body.character.bag.length, 2);
  const sword = weapon.body.character.bag.find(entry => entry.name === '高级精钢阔剑');
  assert.ok(sword);
  assert.equal(sword.kind, 'weapon');
  assert.equal(sword.rarity, 'advanced');
});

test('grocery purchase rejects items when gold is insufficient', async () => {
  const latest = DB.getCharacter(userId, characterId);
  latest.data.gold = 100;
  DB.saveCharacter(userId, characterId, latest.data, latest.data.name);

  const poor = await groceryAction('fine_chain');
  assert.equal(poor.status, 400);
  assert.match(poor.body.error, /金币不足/);
  const after = DB.getCharacter(userId, characterId);
  assert.equal(after.data.gold, 100);
  assert.equal(after.data.bag.length, 2);
});
