const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const TEST_DB_PATH = makeTempDbPath('mailbox-api');
const suffix = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const username = `mailbox_${suffix}`;
const password = `mailbox-password-${suffix}`;
const characterName = 'Mail Hero';
const secondUsername = `viewer_${suffix}`;
const secondPassword = `viewer-password-${suffix}`;

let server;
let baseUrl;
let token;
let secondToken;
let characterId;

async function request(method, urlPath, { token: useToken, body } = {}) {
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

test.before(async () => {
  server = await startServer({ dbPath: TEST_DB_PATH });
  baseUrl = server.baseUrl;

  const registered = await request('POST', '/api/auth/register', {
    body: { username, password },
  });
  assert.equal(registered.status, 200);
  token = registered.body.token;

  const created = await request('POST', '/api/character', {
    token,
    body: { character: { name: characterName, bag: [], status: 'resting' } },
  });
  assert.equal(created.status, 200);
  characterId = Number(created.body.id);

  const secondRegistered = await request('POST', '/api/auth/register', {
    body: { username: secondUsername, password: secondPassword },
  });
  assert.equal(secondRegistered.status, 200);
  secondToken = secondRegistered.body.token;
  const secondCreated = await request('POST', '/api/character', {
    token: secondToken,
    body: { character: { name: 'Mail Viewer', bag: [], status: 'resting' } },
  });
  assert.equal(secondCreated.status, 200);
});

test.after(async () => {
  if (server) await server.stop({ cleanup: false });
  await cleanupDatabaseFiles(TEST_DB_PATH);
});

test('mailbox seeds a welcome letter and claims its attachments exactly once', async () => {
  const sync = await request('GET', `/api/character/${characterId}/mailbox`, { token });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.ok, true);
  assert.equal(sync.body.generated, 1);
  assert.equal(sync.body.mailbox.unreadCount, 1);
  assert.equal(sync.body.mailbox.letters.length, 1);
  const letterId = sync.body.mailbox.letters[0].id;

  const claimed = await request('POST', `/api/character/${characterId}/mailbox/claim`, {
    token,
    body: { id: letterId },
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.ok, true);
  assert.equal(claimed.body.items.length, sync.body.mailbox.letters[0].items.length);
  assert.equal(claimed.body.mailbox.unreadCount, 0);
  assert.ok(claimed.body.character.bag.some(item => item.name === claimed.body.items[0].name));

  const duplicate = await request('POST', `/api/character/${characterId}/mailbox/claim`, {
    token,
    body: { id: letterId },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'already_claimed');
});

test('mailbox endpoints reject unauthenticated access', async () => {
  const sync = await request('GET', `/api/character/${characterId}/mailbox`);
  assert.equal(sync.status, 401);
  const claim = await request('POST', `/api/character/${characterId}/mailbox/claim`, {
    body: { id: 'mail-1' },
  });
  assert.equal(claim.status, 401);
});

test('public character profile hides the private mailbox', async () => {
  const listing = await request('GET', '/api/public/characters', { token: secondToken });
  assert.equal(listing.status, 200);
  const profile = (listing.body.characters || []).find(character => character.name === characterName);
  assert.ok(profile);
  assert.equal(profile.mailbox, undefined);
});
