const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const TEST_DB_PATH = makeTempDbPath('admin-api');
process.env.TAVERN_DB_PATH = TEST_DB_PATH;
process.env.TAVERN_LOAD_ENV = '0';
const DB = require('../db');

const suffix = `admin-api-${process.pid}-${Date.now()}`;
const adminPassword = `secret-${suffix}`;
const username = `player-${suffix}`;
const secondUsername = `guest-${suffix}`;
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
  traits: ['金灵根', 'Steady'],
  personality: '重诺',
  equipment: [{ name: 'Sword', slot: 'weapon', rarity: 'common' }],
  bag: [{ name: 'Potion', qty: 2, rarity: 'common' }],
  skills: [{ name: 'Slash', desc: 'A measured strike.' }],
  skillPool: [{ name: 'Guard', desc: 'A guarded stance.' }],
  hidden: 'must survive admin updates',
};
const wellRestedCharacter = {
  ...originalCharacter,
  stamina: 100,
  max_stamina: 100,
  status: 'resting',
};

let userId;
let characterId;
let playerToken;
let adminToken;
let serverFixture;
let baseUrl;
let smokeUserId;
let smokeCharacterId;
let pushCharacterId;
let cultivationCharacterId;
let secondUserId;
let secondCharacterId;
let secondPlayerToken;
const additionalPlayers = [];
const roomStartPlayers = [];
const paginationPlayers = [];

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

function connectPlayerWebSocket(token = playerToken) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/ws');
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket did not authenticate'));
    }, 2_000);
    socket.once('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'authed') {
        clearTimeout(timeout);
        socket.removeListener('error', reject);
        resolve(socket);
      }
    });
  });
}

function connectUnauthenticatedWebSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace('http', 'ws') + '/ws');
    socket.once('error', reject);
    socket.once('open', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

function nextWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message was not received')), 2_000);
    socket.once('error', reject);
    socket.on('message', raw => {
      clearTimeout(timeout);
      socket.removeListener('error', reject);
      resolve(JSON.parse(String(raw)));
    });
  });
}

function nextWebSocketMessageOfType(socket, type, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error(`WebSocket ${type} message was not received`));
    }, timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(String(raw));
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timeout);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

function nextWebSocketMessageOfTypes(socket, types, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error(`WebSocket ${types.join('/')} message was not received`));
    }, timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(String(raw));
      if (!types.includes(message.type)) return;
      clearTimeout(timeout);
      socket.removeListener('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

test.before(async () => {
  userId = Number(DB.createUser(username, 'hash', 'salt'));
  characterId = Number(DB.createCharacter(userId, originalCharacter.name, originalCharacter));
  cultivationCharacterId = Number(DB.createCharacter(userId, `Cultivation ${suffix}`, {
    ...originalCharacter,
    name: `Cultivation ${suffix}`,
    gold: 500,
    exp: 0,
    status: 'resting',
  }));
  pushCharacterId = Number(DB.createCharacter(userId, `Push ${suffix}`, {
    ...wellRestedCharacter,
    name: `Push ${suffix}`,
    hp: 20,
  }));
  playerToken = `${suffix}-player-token`;
  DB.createSession(userId, playerToken);
  secondUserId = Number(DB.createUser(secondUsername, 'hash', 'salt'));
  secondCharacterId = Number(DB.createCharacter(secondUserId, `Guest ${suffix}`, { ...wellRestedCharacter, name: `Guest ${suffix}` }));
  secondPlayerToken = `${suffix}-guest-token`;
  DB.createSession(secondUserId, secondPlayerToken);
  for (let index = 3; index <= 5; index++) {
    const id = Number(DB.createUser(`player-${index}-${suffix}`, 'hash', 'salt'));
    const characterId = Number(DB.createCharacter(id, `Player ${index} ${suffix}`, { ...originalCharacter, name: `Player ${index} ${suffix}` }));
    const token = `${suffix}-player-${index}-token`;
    DB.createSession(id, token);
    additionalPlayers.push({ id, characterId, token });
  }
  for (let index = 1; index <= 4; index++) {
    const id = Number(DB.createUser(`room-start-${index}-${suffix}`, 'hash', 'salt'));
    const characterId = Number(DB.createCharacter(id, `Room Start ${index} ${suffix}`, { ...wellRestedCharacter, name: `Room Start ${index} ${suffix}` }));
    const token = `${suffix}-room-start-${index}-token`;
    DB.createSession(id, token);
    roomStartPlayers.push({ id, characterId, token });
  }

  serverFixture = await startServer({
    dbPath: TEST_DB_PATH,
    env: { ADMIN_PASSWORD: adminPassword, ROOM_FAST: '1' },
  });
  baseUrl = serverFixture.baseUrl;
});

test.after(async () => {
  if (serverFixture) await serverFixture.stop({ cleanup: false });
  if (typeof DB.db.close === 'function') DB.db.close();
  await cleanupDatabaseFiles(TEST_DB_PATH);
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

test('cultivation start charges upfront and character reads settle completed half-hours once', async () => {
  const current = await request('GET', `/api/character/${cultivationCharacterId}`, { token: playerToken });
  const started = await request('POST', `/api/character/${cultivationCharacterId}/cultivation/start`, {
    token: playerToken,
    body: { updated_at: current.body.updated_at, hours: 1 },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.character.gold, current.body.character.gold - 100);
  assert.equal(started.body.character.status, 'cultivating');
  assert.equal(started.body.character.cultivation.mode, 'cultivate');

  const elapsed = {
    ...started.body.character,
    exp: 0,
    cultivation: {
      ...started.body.character.cultivation,
      startedAt: Date.now() - 61 * 60 * 1000,
      lastSettledAt: Date.now() - 61 * 60 * 1000,
      endsAt: Date.now() + 60 * 60 * 1000,
    },
  };
  DB.saveCharacter(userId, cultivationCharacterId, elapsed, elapsed.name);

  const first = await request('GET', `/api/character/${cultivationCharacterId}`, { token: playerToken });
  assert.equal(first.body.character.exp, 100);
  const second = await request('GET', `/api/character/${cultivationCharacterId}`, { token: playerToken });
  assert.equal(second.body.character.exp, 100);
});

test('public character data exposes class, personality, and current state fields', async () => {
  const response = await request('GET', '/api/public/characters', { token: secondPlayerToken });
  assert.equal(response.status, 200);
  const character = response.body.characters.find(entry => entry.id === pushCharacterId);
  assert.deepEqual(
    {
      character_class: character.character_class,
      personality: character.personality,
      hp: character.hp,
      max_hp: character.max_hp,
      stamina: character.stamina,
      max_stamina: character.max_stamina,
      status: character.status,
    },
    { character_class: 'Warrior', personality: '重诺', hp: 20, max_hp: 50, stamina: 100, max_stamina: 100, status: 'resting' },
  );
});

test('public character data matches the complete role profile used by my page', async () => {
  const response = await request('GET', '/api/public/characters', { token: secondPlayerToken });
  assert.equal(response.status, 200);
  const character = response.body.characters.find(entry => entry.id === pushCharacterId);
  assert.equal(character.traits, undefined);
  assert.equal(character.traitDescs, undefined);
  assert.equal(character.root, undefined);
  assert.deepEqual(character.skills, originalCharacter.skills);
  assert.deepEqual(character.bag, originalCharacter.bag.map(item => ({ ...item, rarity: 'common' })));
  assert.deepEqual(character.equipment, originalCharacter.equipment.map(item => ({ ...item, rarity: 'common' })));
});

test('followed characters persist per account and sort after the current character', async () => {
  const followed = await request('POST', `/api/public/characters/${secondCharacterId}/follow`, {
    token: playerToken,
    body: { followed: true },
  });
  assert.deepEqual(followed, { status: 200, body: { characterId: secondCharacterId, is_followed: true } });

  const firstPage = await request('GET', `/api/public/characters?page=1&pin_current=1&sort=name&order=asc&q=${encodeURIComponent(suffix)}`, {
    token: playerToken,
  });
  const currentCharacterId = DB.getCharacters(userId)[0].id;
  assert.deepEqual(
    firstPage.body.characters.slice(0, 2).map(character => ({ id: character.id, is_followed: character.is_followed })),
    [{ id: currentCharacterId, is_followed: false }, { id: secondCharacterId, is_followed: true }],
  );

  const unfollowed = await request('POST', `/api/public/characters/${secondCharacterId}/follow`, {
    token: playerToken,
    body: { followed: false },
  });
  assert.deepEqual(unfollowed, { status: 200, body: { characterId: secondCharacterId, is_followed: false } });
});

test('public character endpoint returns the requested filtered page and metadata', async () => {
  for (let index = 1; index <= 13; index++) {
    const userId = Number(DB.createUser(`page-${index}-${suffix}`, 'hash', 'salt'));
    const name = `Page ${index} ${suffix}`;
    const characterId = Number(DB.createCharacter(userId, name, {
      ...originalCharacter,
      name,
      status: 'idle',
      level: index,
    }));
    paginationPlayers.push({ userId, characterId });
  }

  const query = `?q=${encodeURIComponent(suffix)}&status=idle&sort=level&order=asc&page=1`;
  const firstPage = await request('GET', `/api/public/characters${query}`, { token: secondPlayerToken });
  const secondPage = await request('GET', `/api/public/characters${query.replace('page=1', 'page=2')}`, { token: secondPlayerToken });

  assert.equal(firstPage.status, 200);
  assert.deepEqual(
    {
      total: firstPage.body.total,
      page: firstPage.body.page,
      pageSize: firstPage.body.pageSize,
      pages: firstPage.body.pages,
      count: firstPage.body.characters.length,
      firstName: firstPage.body.characters[0].name,
    },
    { total: 13, page: 1, pageSize: 12, pages: 2, count: 12, firstName: `Page 1 ${suffix}` },
  );
  assert.deepEqual(
    { page: secondPage.body.page, count: secondPage.body.characters.length, name: secondPage.body.characters[0].name },
    { page: 2, count: 1, name: `Page 13 ${suffix}` },
  );

  const pinnedFirstPage = await request('GET', `/api/public/characters${query}&pin_current=1`, { token: secondPlayerToken });
  const pinnedSecondPage = await request('GET', `/api/public/characters${query.replace('page=1', 'page=2')}&pin_current=1`, { token: secondPlayerToken });
  assert.deepEqual(
    { total: pinnedFirstPage.body.total, page: pinnedFirstPage.body.page, count: pinnedFirstPage.body.characters.length, firstId: pinnedFirstPage.body.characters[0].id },
    { total: 14, page: 1, count: 12, firstId: secondCharacterId },
  );
  assert.equal(pinnedSecondPage.body.characters.some(character => character.id === secondCharacterId), false);

  const memberDetail = await request('GET', `/api/public/characters/${paginationPlayers[12].characterId}`, { token: secondPlayerToken });
  assert.equal(memberDetail.status, 200);
  assert.equal(memberDetail.body.character.name, `Page 13 ${suffix}`);
});

test('player can delete their own character for recreation', async () => {
  const deletableId = Number(DB.createCharacter(userId, `Delete ${suffix}`, { name: `Delete ${suffix}`, traits: ['木灵根'] }));
  const response = await request('POST', `/api/character/${deletableId}/delete`, { token: playerToken });
  assert.equal(response.status, 200);
  assert.equal(DB.getCharacter(userId, deletableId), null);
});

test('admin login denies missing configuration and wrong passwords, then creates a bearer session', async () => {
  const unconfigured = await startServer({
    dbPath: makeTempDbPath('admin-api-disabled'),
    env: { ADMIN_PASSWORD: undefined },
  });
  try {
    const response = await fetch(`${unconfigured.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });
    assert.equal(response.status, 401);
  } finally {
    await unconfigured.stop();
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

test('HTTP public room listing requires a player session', async () => {
  const denied = await request('GET', '/api/rooms');
  assert.equal(denied.status, 401);

  const allowed = await request('GET', '/api/rooms', { token: playerToken });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { rooms: [] });
});

test('admin can search players and read a character with its owner and version', async () => {
  const search = await adminRequest('GET', `/api/admin/players?q=${encodeURIComponent(username)}`);
  assert.equal(search.status, 200);
  const player = search.body.players.find(player => player.characterId === characterId);
  assert.deepEqual(player, {
    userId,
    username,
    characterId,
    characterName: originalCharacter.name,
  });

  const detail = await adminRequest('GET', `/api/admin/characters/${characterId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.character.id, characterId);
  assert.equal(detail.body.character.userId, userId);
  assert.equal(detail.body.character.username, username);
  assert.equal(typeof detail.body.character.updated_at, 'number');
  assert.deepEqual(detail.body.character.data, {
    ...originalCharacter,
    bag: originalCharacter.bag.map(item => ({ ...item, rarity: 'common' })),
    equipment: originalCharacter.equipment.map(item => ({ ...item, rarity: 'common' })),
    consumableSlots: [],
  });

  const missing = await adminRequest('GET', '/api/admin/characters/999999999');
  assert.equal(missing.status, 404);
});

test('match queue broadcasts a two-minute countdown to the queued player', async () => {
  const socket = await connectPlayerWebSocket();
  try {
    const received = nextWebSocketMessageOfType(socket, 'match_state');
    socket.send(JSON.stringify({ type: 'match_start', token: playerToken, charId: pushCharacterId }));
    const state = await received;
    assert.equal(state.queued, 1);
    assert.equal(typeof state.remainingMs, 'number');
    assert.ok(state.remainingMs > 118_000 && state.remainingMs <= 120_000);
  } finally {
    socket.send(JSON.stringify({ type: 'match_cancel' }));
    socket.terminate();
  }
});

test('a player creates a map-backed public room and another player joins it', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const created = await createdMessage;
    assert.equal(created.rooms.length, 1);
    assert.equal(created.rooms[0].dungeon, '幽暗密林');

    const hasTwoMembers = message => message.rooms[0] && message.rooms[0].party.length === 2;
    const hostJoinedMessage = nextWebSocketMessageOfType(host, 'rooms_updated', hasTwoMembers);
    const guestJoinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', hasTwoMembers);
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId: created.rooms[0].id, charId: secondCharacterId }));
    const [hostJoined, guestJoined] = await Promise.all([hostJoinedMessage, guestJoinedMessage]);
    assert.equal(hostJoined.rooms[0].party.length, 2);
    assert.equal(guestJoined.rooms[0].party.length, 2);
  } finally {
    host.terminate();
    guest.terminate();
  }
});

test('a player cannot occupy multiple waiting rooms through separate WebSockets', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const hostAgain = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  const guestAgain = await connectPlayerWebSocket(secondPlayerToken);
  const other = await connectPlayerWebSocket(additionalPlayers[0].token);
  try {
    const hostCreatedMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const hostCreated = await hostCreatedMessage;

    const duplicateCreate = nextWebSocketMessageOfType(hostAgain, 'error');
    hostAgain.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: characterId, dungeon: '雷鸣废墟' }));
    assert.equal((await duplicateCreate).error, '无法创建队伍');

    const otherCreatedMessage = nextWebSocketMessageOfType(other, 'rooms_updated');
    other.send(JSON.stringify({ type: 'room_create', token: additionalPlayers[0].token, charId: additionalPlayers[0].characterId, dungeon: '雷鸣废墟' }));
    const otherCreated = await otherCreatedMessage;
    const otherRoom = otherCreated.rooms.find(room => room.host === additionalPlayers[0].id);

    const guestJoinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated');
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId: hostCreated.rooms[0].id, charId: secondCharacterId }));
    await guestJoinedMessage;

    const duplicateJoin = nextWebSocketMessageOfType(guestAgain, 'error');
    guestAgain.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId: otherRoom.id, charId: secondCharacterId }));
    assert.equal((await duplicateJoin).error, '无法加入队伍');
  } finally {
    host.terminate();
    hostAgain.terminate();
    guest.terminate();
    guestAgain.terminate();
    other.terminate();
  }
});

test('room lifecycle rejects unauthenticated, foreign, full, duplicate, and queued memberships', async () => {
  const unauthenticated = await connectUnauthenticatedWebSocket();
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  const third = await connectPlayerWebSocket(additionalPlayers[0].token);
  const fourth = await connectPlayerWebSocket(additionalPlayers[1].token);
  const fifth = await connectPlayerWebSocket(additionalPlayers[2].token);
  const guestAgain = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const unauthenticatedError = nextWebSocketMessageOfType(unauthenticated, 'error');
    unauthenticated.send(JSON.stringify({ type: 'room_create', charId: pushCharacterId, dungeon: '幽暗密林' }));
    assert.equal((await unauthenticatedError).error, '无法创建队伍');

    const foreignCharacterError = nextWebSocketMessageOfType(guest, 'error');
    guest.send(JSON.stringify({ type: 'room_create', token: secondPlayerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    assert.equal((await foreignCharacterError).error, '无法创建队伍');

    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    for (const [socket, player] of [[guest, { token: secondPlayerToken, characterId: secondCharacterId }], [third, additionalPlayers[0]], [fourth, additionalPlayers[1]]]) {
      const joinedMessage = nextWebSocketMessageOfType(socket, 'rooms_updated');
      socket.send(JSON.stringify({ type: 'room_join', token: player.token, roomId, charId: player.characterId }));
      await joinedMessage;
    }

    const fullError = nextWebSocketMessageOfType(fifth, 'error');
    fifth.send(JSON.stringify({ type: 'room_join', token: additionalPlayers[2].token, roomId, charId: additionalPlayers[2].characterId }));
    assert.equal((await fullError).error, '无法加入队伍');

    const duplicateError = nextWebSocketMessageOfType(guestAgain, 'error');
    guestAgain.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId, charId: secondCharacterId }));
    assert.equal((await duplicateError).error, '无法加入队伍');

    const queuedError = nextWebSocketMessageOfType(host, 'error');
    host.send(JSON.stringify({ type: 'match_start', token: playerToken, charId: pushCharacterId }));
    assert.equal((await queuedError).error, '已在公开队伍中');
  } finally {
    unauthenticated.terminate();
    host.terminate();
    guest.terminate();
    third.terminate();
    fourth.terminate();
    fifth.terminate();
    guestAgain.terminate();
  }
});

test('host disconnect transfers waiting-room ownership and broadcasts the updated room', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    const joinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated');
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId, charId: secondCharacterId }));
    await joinedMessage;

    const transferredMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', message => (
      message.rooms.length === 1
      && message.rooms[0].id === roomId
      && message.rooms[0].host === secondUserId
      && message.rooms[0].party.length === 1
    ));
    host.terminate();
    const transferred = await transferredMessage;
    assert.equal(transferred.rooms.length, 1);
    assert.equal(transferred.rooms[0].id, roomId);
    assert.equal(transferred.rooms[0].host, secondUserId);
    assert.equal(transferred.rooms[0].party.length, 1);
    const dissolvedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', message => message.rooms.length === 0);
    guest.send(JSON.stringify({ type: 'room_dissolve', token: secondPlayerToken, roomId }));
    await dissolvedMessage;
  } finally {
    host.terminate();
    guest.terminate();
  }
});

test('only the room host starts and missing members are filled with AI', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '雷鸣废墟' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    const joinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', message => (
      message.rooms.some(room => room.id === roomId && room.party.length === 2)
    ));
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId, charId: secondCharacterId }));
    await joinedMessage;

    const rejected = nextWebSocketMessageOfType(guest, 'error');
    guest.send(JSON.stringify({ type: 'room_start', token: secondPlayerToken, roomId }));
    assert.equal((await rejected).error, '只有队长可以开始探险');

    const hostStarting = nextWebSocketMessageOfType(host, 'dungeon_starting');
    const guestStarting = nextWebSocketMessageOfType(guest, 'dungeon_starting');
    const hostStarted = nextWebSocketMessageOfType(host, 'dungeon_started');
    const guestStarted = nextWebSocketMessageOfType(guest, 'dungeon_started');
    const firstStep = nextWebSocketMessageOfType(host, 'step', () => true, 12_000);
    const terminal = nextWebSocketMessageOfTypes(host, ['settled', 'run_error'], 12_000);
    const roomRemoved = nextWebSocketMessageOfType(host, 'rooms_updated', message => (
      !message.rooms.some(room => room.id === roomId)
    ));
    host.send(JSON.stringify({ type: 'room_start', token: playerToken, roomId }));
    const [starting, guestStartingMsg, started, guestSnapshot] = await Promise.all([hostStarting, guestStarting, hostStarted, guestStarted]);
    await roomRemoved;

    assert.equal(starting.type, 'dungeon_starting');
    assert.equal(starting.room.status, 'starting');
    assert.equal(starting.room.party.length, 4);
    assert.equal(guestStartingMsg.room.status, 'starting');
    assert.equal(started.snapshot.party.length, 4);
    assert.equal(started.snapshot.party.filter(member => member.isNpc).length, 2);
    assert.equal(started.snapshot.baseDungeon, '雷鸣废墟');
    assert.equal(guestSnapshot.snapshot.party.length, 4);
    await firstStep;
    const durableRun = DB.getExpeditionRun(started.runId);
    assert.ok(durableRun.snapshot.steps.length >= 1);
    assert.equal((await terminal).type, 'settled');
    assert.equal(DB.getExpeditionRun(started.runId).status, 'completed');
  } finally {
    host.terminate();
    guest.terminate();
  }
});

test('a player can create a new public room after their expedition settles', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    const terminal = nextWebSocketMessageOfTypes(host, ['settled', 'run_error'], 12_000);
    host.send(JSON.stringify({ type: 'room_start', token: playerToken, roomId }));
    const result = await terminal;
    assert.equal(result.type, 'settled', result.error || 'expedition did not settle');

    const recreated = nextWebSocketMessageOfType(host, 'rooms_updated', message => (
      message.rooms.some(room => room.host === userId && room.dungeon === '雷鸣废墟')
    ));
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '雷鸣废墟' }));
    assert.equal((await recreated).rooms.filter(room => room.host === userId).length, 1);
  } finally {
    host.terminate();
  }
});

test('every expedition member log contains the complete party status update', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    const joinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', message => (
      message.rooms.some(room => room.id === roomId && room.party.length === 2)
    ));
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId, charId: secondCharacterId }));
    await joinedMessage;

    const hostSettled = nextWebSocketMessageOfTypes(host, ['settled', 'run_error'], 12_000);
    const guestSettled = nextWebSocketMessageOfTypes(guest, ['settled', 'run_error'], 12_000);
    host.send(JSON.stringify({ type: 'room_start', token: playerToken, roomId }));
    const [hostResult, guestResult] = await Promise.all([hostSettled, guestSettled]);
    assert.equal(hostResult.type, 'settled', hostResult.error || 'expedition did not settle');
    assert.equal(guestResult.type, 'settled', guestResult.error || 'expedition did not settle');
    const expectedNames = hostResult.results.map(member => member.name).sort();
    assert.deepEqual(guestResult.results.map(member => member.name).sort(), expectedNames);

    const [hostLogs, guestLogs] = await Promise.all([
      request('GET', '/api/logs', { token: playerToken }),
      request('GET', '/api/logs', { token: secondPlayerToken }),
    ]);
    for (const response of [hostLogs, guestLogs]) {
      assert.equal(response.status, 200);
      const log = response.body.logs.find(entry => entry.party_name === `匹配小队${roomId}`);
      assert.ok(log, 'the player should receive their expedition log');
      assert.deepEqual(log.settlement.members.map(member => member.name).sort(), expectedNames);
    }
    const publicLogs = await request('GET', '/api/public/logs', { token: additionalPlayers[0].token });
    assert.equal(publicLogs.status, 200);
    const publicLog = publicLogs.body.logs.find(entry => entry.party_name === `匹配小队${roomId}`);
    assert.ok(publicLog, 'an uninvolved player should receive the public expedition log');
    assert.deepEqual(publicLog.settlement.members.map(member => member.name).sort(), expectedNames);
    assert.equal(Array.isArray(publicLog.dg_snapshot && publicLog.dg_snapshot.steps), false);
    const publicDetail = await request('GET', '/api/public/logs/' + publicLog.log_key, { token: additionalPlayers[0].token });
    assert.equal(publicDetail.status, 200);
    assert.equal(Array.isArray(publicDetail.body.log.dg_snapshot && publicDetail.body.log.dg_snapshot.steps), true);
  } finally {
    host.terminate();
    guest.terminate();
  }
});

test('only the room host dissolves a waiting room', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
    host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽暗密林' }));
    const roomId = (await createdMessage).rooms.find(room => room.host === userId).id;

    const joinedMessage = nextWebSocketMessageOfType(guest, 'rooms_updated', message => (
      message.rooms.some(room => room.id === roomId && room.party.length === 2)
    ));
    guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId, charId: secondCharacterId }));
    await joinedMessage;

    const rejected = nextWebSocketMessageOfType(guest, 'error');
    guest.send(JSON.stringify({ type: 'room_dissolve', token: secondPlayerToken, roomId }));
    assert.equal((await rejected).error, '只有队长可以解散队伍');

    const roomRemoved = nextWebSocketMessageOfType(guest, 'rooms_updated', message => (
      !message.rooms.some(room => room.id === roomId)
    ));
    host.send(JSON.stringify({ type: 'room_dissolve', token: playerToken, roomId }));
    await roomRemoved;
  } finally {
    host.terminate();
    guest.terminate();
  }
});

test('admin saves notify the owning player through WebSocket', async () => {
  const socket = await connectPlayerWebSocket();
  try {
    const before = DB.getCharacterAdmin(pushCharacterId);
    const received = nextWebSocketMessage(socket);
    const response = await adminRequest('PUT', `/api/admin/characters/${pushCharacterId}`, {
      updated_at: before.updated_at,
      character: { hp: 31 },
    });

    assert.equal(response.status, 200);
    const message = await received;
    assert.deepEqual(message, {
      type: 'character_updated',
      characterId: pushCharacterId,
      updated_at: response.body.character.updated_at,
    });
  } finally {
    socket.terminate();
  }
});

test('admin character saves notify other players to refresh public character state', async () => {
  const guestSocket = await connectPlayerWebSocket(secondPlayerToken);
  try {
    const before = DB.getCharacterAdmin(pushCharacterId);
    const received = nextWebSocketMessageOfType(guestSocket, 'public_characters_updated');
    const response = await adminRequest('PUT', `/api/admin/characters/${pushCharacterId}`, {
      updated_at: before.updated_at,
      character: { hp: 30, stamina: 11 },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await received, {
      type: 'public_characters_updated',
      characterId: pushCharacterId,
      updated_at: response.body.character.updated_at,
    });
  } finally {
    guestSocket.terminate();
  }
});

test('player saves with an outdated character version do not overwrite admin changes', async () => {
  const before = DB.getCharacterAdmin(pushCharacterId);
  const adminUpdate = await adminRequest('PUT', `/api/admin/characters/${pushCharacterId}`, {
    updated_at: before.updated_at,
    character: { gold: 888 },
  });
  assert.equal(adminUpdate.status, 200);

  const staleSave = await request('POST', `/api/character/${pushCharacterId}`, {
    token: playerToken,
    body: { updated_at: before.updated_at, character: { ...before.data, gold: 1 } },
  });
  assert.equal(staleSave.status, 409);
  assert.equal(DB.getCharacterAdmin(pushCharacterId).data.gold, 888);
});

test('admin save updates only submitted whitelist fields and records safe audit snapshots', async () => {
  const before = DB.getCharacterAdmin(characterId);
  const response = await adminRequest('PUT', `/api/admin/characters/${characterId}`, {
    updated_at: before.updated_at,
    character: { name: 'Updated Fixture', hp: 45, strength: 20 },
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

test('admin can list, edit, and reset fixed AI companion cards', async () => {
  const listing = await adminRequest('GET', '/api/admin/ai-companions');
  assert.equal(listing.status, 200);
  assert.equal(Array.isArray(listing.body.cards), true);
  assert.equal(listing.body.cards.length, 20);
  const aganzuo = listing.body.cards.find(card => card.key === 'aganzuo');
  assert.ok(aganzuo, 'default 阿甘左 card must exist');
  assert.equal(aganzuo.data.name, '阿甘左');
  assert.equal(typeof aganzuo.data.bio, 'string');
  assert.ok(aganzuo.data.bio.length > 0);

  const denied = await request('GET', '/api/admin/ai-companions', { token: playerToken });
  assert.equal(denied.status, 401);

  const companionFields = [
    'name', 'title', 'gender', 'personality', 'character_class', 'title_frame',
    'level', 'exp', 'gold', 'hp', 'max_hp', 'stamina', 'max_stamina',
    'strength', 'agility', 'intelligence', 'luck', 'status', 'bio',
    'equipment', 'bag', 'skills', 'skillPool',
  ];
  const pick = (data, fields) => Object.fromEntries(fields.filter(field => data[field] !== undefined).map(field => [field, data[field]]));
  const cardPayload = pick(aganzuo.data, companionFields);
  const updated = await adminRequest('PUT', '/api/admin/ai-companions/aganzuo', {
    card: { ...cardPayload, gold: 12345, bio: '后台测试修改后的小传。' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.card.data.gold, 12345);
  assert.equal(updated.body.card.data.bio, '后台测试修改后的小传。');
  assert.equal(updated.body.card.is_default, false);
  assert.equal(DB.getAiCompanionCard('aganzuo').data.gold, 12345);

  const rejected = await adminRequest('PUT', '/api/admin/ai-companions/aganzuo', {
    card: { ...updated.body.card.data, name: '不应改名' },
  });
  assert.equal(rejected.status, 400);

  const reset = await adminRequest('POST', '/api/admin/ai-companions/aganzuo/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.card.is_default, true);
  assert.equal(reset.body.card.data.gold, aganzuo.data.gold);
  assert.equal(DB.getAiCompanionCard('aganzuo').is_default, true);
});

test('admin logout invalidates the current session', async () => {
  const logout = await adminRequest('POST', '/api/admin/logout');
  assert.equal(logout.status, 200);
  assert.equal(logout.body.ok, true);

  const denied = await adminRequest('GET', '/api/admin/players');
  assert.equal(denied.status, 401);
});

test('room starts fill one through four human parties to exactly four members', async () => {
  const players = roomStartPlayers;

  for (const humanCount of [1, 2, 3, 4]) {
    const sockets = await Promise.all(players.slice(0, humanCount).map(player => connectPlayerWebSocket(player.token)));
    const [host, ...guests] = sockets;
    try {
      const createdMessage = nextWebSocketMessageOfType(host, 'rooms_updated');
      host.send(JSON.stringify({ type: 'room_create', token: players[0].token, charId: players[0].characterId, dungeon: '幽暗密林' }));
      const roomId = (await createdMessage).rooms.find(room => room.host === players[0].id).id;

      for (let index = 0; index < guests.length; index++) {
        const expectedMembers = index + 2;
        const joinedMessage = nextWebSocketMessageOfType(host, 'rooms_updated', message => (
          message.rooms.some(room => room.id === roomId && room.party.length === expectedMembers)
        ));
        const player = players[index + 1];
        guests[index].send(JSON.stringify({ type: 'room_join', token: player.token, roomId, charId: player.characterId }));
        await joinedMessage;
      }

      const startedMessage = nextWebSocketMessageOfType(host, 'dungeon_started');
      const terminalMessage = nextWebSocketMessageOfTypes(host, ['settled', 'run_error'], 12_000);
      host.send(JSON.stringify({ type: 'room_start', token: players[0].token, roomId }));
      const started = await startedMessage;
      assert.equal(started.snapshot.party.length, 4);
      assert.equal(started.snapshot.party.filter(member => member.isNpc).length, 4 - humanCount);
      assert.equal((await terminalMessage).type, 'settled');
    } finally {
      sockets.forEach(socket => socket.terminate());
    }
  }
});
