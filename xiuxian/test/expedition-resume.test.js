const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocket } = require('ws');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const dbPath = makeTempDbPath('expedition-resume');
process.env.TAVERN_DB_PATH = dbPath;
process.env.TAVERN_LOAD_ENV = '0';

const DB = require('../db');
const {
  SNAPSHOT_VERSION,
  classifyAiFailure,
  hydrateDurableRoom,
  isRestorableSnapshot,
  retryDelay,
  serializeDurableRoom,
} = require('../expedition-resume');

function role(name, stamina = 40) {
  return {
    name,
    status: 'resting',
    stamina,
    max_stamina: 100,
    hp: 100,
    max_hp: 100,
    bag: [],
    equipment: [],
    skills: [],
    skillPool: [],
  };
}

function runtimeRoom(runId = 'run-durable', roomId = 'R-resume') {
  const human = {
    uid: 11,
    charId: 22,
    id: 11,
    name: '云岫',
    hp: 73,
    max_hp: 120,
    bag: [{ name: '回春丹', qty: 2 }],
    equipment: [{ name: '青锋剑', kind: '武器' }],
    skills: [{ name: '流云诀', type: '功法' }],
    ws: { readyState: 1 },
    isNpc: false,
  };
  const npc = { id: 'npc-1', name: '玄照', hp: 88, max_hp: 100, bag: [], equipment: [], skills: [], ws: null, isNpc: true };
  return {
    id: roomId,
    name: '续行小队',
    host: 11,
    choice: '断桥遗迹',
    createdAt: 123456,
    status: 'running',
    party: [human, npc],
    _timer: { internal: true },
    dg: {
      id: runId,
      startedAt: 123456,
      status: 'running',
      flowMode: 'dynamic',
      dungeon: { name: '断桥遗迹', baseName: '断桥遗迹', enemies: [], bosses: [] },
      party: [human, npc],
      plan: [{ key: 'opening', label: '启程', steps: 1 }],
      planIdx: 0,
      stepIdx: 0,
      totalStep: 1,
      steps: [{ stepNo: 1, text: '众人踏过断桥。' }],
      phase: 'explore',
      quest: { status: 'active', objective: '穿过断桥' },
      encounter: { status: 'none', name: '' },
      lastDecision: { phase: 'explore', continue: true },
      nextHint: '桥后有微光',
      focusPlan: [{ actorIndex: 0, supportIndex: 1 }],
      memberGains: { 11: { acts: 1, damage: 7, loot: [] } },
      consumed: [{ name: '回春丹', ownerId: 11, qty: 1 }],
      itemLoans: [{ name: '青锋剑', ownerId: 11, userId: 'npc-1', qty: 1, loaned: true }],
      itemRegistry: [{ name: '青锋剑', ownerId: 11, qty: 1 }],
      aiLoot: [{ name: '残碑碎片', qty: 1, rarity: 'rare' }],
      gainedLoot: [{ name: '残碑碎片' }],
      damage: 7,
      deaths: [],
      breachSuccess: false,
      _curEnemy: { name: '桥灵' },
      timer: { internal: true },
    },
  };
}

function waitForMessages(socket, requiredTypes) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${requiredTypes.join(', ')}`)), 3000);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (requiredTypes.every(type => messages.some(entry => entry.type === type))) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test.after(async () => {
  if (typeof DB.db.close === 'function') DB.db.close();
  await cleanupDatabaseFiles(dbPath);
});

test('durable snapshots preserve expedition progress while removing live transports', () => {
  const room = runtimeRoom();
  const snapshot = serializeDurableRoom(room, {
    attempt: 3,
    nextRetryAt: 999999,
    lastError: 'AI 服务繁忙',
    resumeState: 'running',
  });

  assert.equal(snapshot.schemaVersion, SNAPSHOT_VERSION);
  assert.equal(snapshot.room.dg.memberGains['11'].damage, 7);
  assert.equal(snapshot.room.dg.focusPlan.length, 1);
  assert.equal(snapshot.room.dg.consumed[0].name, '回春丹');
  assert.equal(snapshot.room.dg.itemLoans[0].userId, 'npc-1');
  assert.equal(snapshot.room.dg.itemRegistry[0].ownerId, 11);
  assert.equal(snapshot.room.dg.aiLoot[0].name, '残碑碎片');
  assert.equal(snapshot.room.party[0].ws, undefined);
  assert.equal(snapshot.room.dg.party[0].ws, undefined);
  assert.equal(snapshot.room._timer, undefined);
  assert.equal(snapshot.room.dg.timer, undefined);
  assert.equal(snapshot.room.dg._curEnemy, undefined);

  const restored = hydrateDurableRoom({
    runId: 'run-durable',
    roomId: 'R-resume',
    status: 'waiting_ai',
    snapshot,
  });
  assert.equal(restored.status, 'waiting_ai');
  assert.equal(restored.dg.status, 'waiting_ai');
  assert.equal(restored._timer, null);
  assert.equal(restored.dg._curEnemy, null);
  assert.equal(restored.party[0].ws, null);
  assert.equal(restored.dg.party[0].ws, null);
  assert.equal(restored._aiRetry.resumeState, 'running');
  assert.equal(restored.dg.steps.length, 1);
});

test('only current version complete snapshots are restorable', () => {
  const current = serializeDurableRoom(runtimeRoom());
  assert.equal(isRestorableSnapshot(current), true);
  assert.equal(isRestorableSnapshot({ ...current, schemaVersion: 1 }), false);
  assert.equal(isRestorableSnapshot({ schemaVersion: SNAPSHOT_VERSION, room: { id: 'R1' } }), false);
  assert.equal(hydrateDurableRoom({ runId: 'legacy', roomId: 'R1', status: 'running', snapshot: { steps: [] } }), null);
});

test('AI retry policy distinguishes resumable failures and caps exponential delay', () => {
  const throttled = new Error('rate limited');
  throttled.aiFailure = true;
  throttled.status = 429;
  const disabled = new Error('AI 服务当前已停用');
  disabled.aiFailure = true;
  disabled.code = 'ai_disabled';

  assert.deepEqual(classifyAiFailure(throttled), { resumable: true, longDelay: false });
  assert.deepEqual(classifyAiFailure(disabled), { resumable: true, longDelay: true });
  assert.deepEqual(classifyAiFailure(new Error('副本检查点写入失败')), { resumable: false, longDelay: false });
  assert.equal(retryDelay(1, false), 5000);
  assert.equal(retryDelay(8, false), 300000);
  assert.equal(retryDelay(1, true), 60000);
});

test('waiting AI runs remain active and recovery can exclude hydrated runs', () => {
  const userId = Number(DB.createUser('waiting-ai-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '云岫', role('云岫')));
  const snapshot = serializeDurableRoom(runtimeRoom('run-waiting-ai', 'R-waiting'), {
    attempt: 1,
    nextRetryAt: Date.now() + 60000,
    lastError: 'AI 服务繁忙',
    resumeState: 'running',
  });
  DB.beginExpeditionRun({
    runId: 'run-waiting-ai',
    roomId: 'R-waiting',
    snapshot,
    members: [{ userId, characterId, memberName: '云岫' }],
  });

  assert.equal(DB.setExpeditionRunState('run-waiting-ai', 'waiting_ai', snapshot, ['running']), true);
  assert.equal(DB.getActiveExpeditionRuns().some(run => run.runId === 'run-waiting-ai'), true);
  assert.deepEqual(DB.recoverInterruptedExpeditions({ excludeRunIds: ['run-waiting-ai'] }), {
    runs: 0,
    characters: 0,
    refunded: 0,
    logs: 0,
    legacyCharacters: 0,
  });
  assert.equal(DB.getExpeditionRun('run-waiting-ai').status, 'waiting_ai');
  assert.equal(DB.getCharacter(userId, characterId).data.status, 'adventuring');

  const recovered = DB.recoverInterruptedExpeditions();
  assert.equal(recovered.runs, 1);
  assert.equal(DB.getExpeditionRun('run-waiting-ai').status, 'interrupted');
  assert.equal(DB.getCharacter(userId, characterId).data.status, 'resting');
});

test('server startup restores a waiting AI run, exposes it to its owner, and answers heartbeat', async () => {
  const userId = Number(DB.createUser('resume-server-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '归舟', role('归舟')));
  const token = 'resume-token';
  DB.createSession(userId, token);
  const room = runtimeRoom('run-server-resume', 'R-server-resume');
  room.host = userId;
  room.party[0].uid = userId;
  room.party[0].id = userId;
  room.party[0].charId = characterId;
  room.dg.party[0].uid = userId;
  room.dg.party[0].id = userId;
  room.dg.party[0].charId = characterId;
  const snapshot = serializeDurableRoom(room, {
    attempt: 2,
    nextRetryAt: Date.now() + 60000,
    lastError: 'AI 服务维护中',
    resumeState: 'running',
  });
  DB.beginExpeditionRun({
    runId: 'run-server-resume',
    roomId: 'R-server-resume',
    snapshot,
    members: [{ userId, characterId, memberName: '归舟' }],
  });
  DB.setExpeditionRunState('run-server-resume', 'waiting_ai', snapshot, ['running']);

  const server = await startServer({ dbPath, env: { AI_ENABLED: '0' } });
  let socket;
  try {
    assert.equal(DB.getExpeditionRun('run-server-resume').status, 'waiting_ai');
    const unauthorized = await fetch(`${server.baseUrl}/api/expeditions/active`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${server.baseUrl}/api/expeditions/active`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].runId, 'run-server-resume');
    assert.equal(body.runs[0].status, 'waiting_ai');
    assert.equal(Array.isArray(body.runs[0].snapshot.dgParty), true);
    assert.equal(Array.isArray(body.runs[0].snapshot.steps), true);

    socket = new WebSocket(server.baseUrl.replace('http', 'ws') + '/ws');
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const messagesPromise = waitForMessages(socket, ['authed', 'dungeon_resumed', 'run_waiting_ai', 'pong']);
    socket.send(JSON.stringify({ type: 'auth', token }));
    socket.send(JSON.stringify({ type: 'ping', at: 123 }));
    const messages = await messagesPromise;
    assert.equal(messages.find(message => message.type === 'pong').at, 123);
    assert.equal(messages.find(message => message.type === 'run_waiting_ai').runId, 'run-server-resume');
  } finally {
    if (socket) socket.close();
    await server.stop({ cleanup: false });
  }
});

test('server resumes a persisted waiting AI run and advances without a failed log', async () => {
  const userId = Number(DB.createUser('retry-success-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '渡川', role('渡川')));
  const room = runtimeRoom('run-retry-success', 'R-retry-success');
  room.host = userId;
  room.party[0].uid = userId;
  room.party[0].id = userId;
  room.party[0].charId = characterId;
  room.dg.party[0].uid = userId;
  room.dg.party[0].id = userId;
  room.dg.party[0].charId = characterId;
  const snapshot = serializeDurableRoom(room, {
    attempt: 1,
    nextRetryAt: Date.now() - 1000,
    lastError: 'AI 服务繁忙',
    resumeState: 'running',
  });
  DB.beginExpeditionRun({
    runId: 'run-retry-success',
    roomId: 'R-retry-success',
    snapshot,
    members: [{ userId, characterId, memberName: '渡川' }],
  });
  DB.setExpeditionRunState('run-retry-success', 'waiting_ai', snapshot, ['running']);

  const server = await startServer({ dbPath, env: { ROOM_FAST: '1', AI_ENABLED: '1' } });
  try {
    const deadline = Date.now() + 8000;
    let run = DB.getExpeditionRun('run-retry-success');
    while (run && !['completed', 'failed', 'interrupted'].includes(run.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      run = DB.getExpeditionRun('run-retry-success');
    }
    assert.ok(run, 'restored run disappeared');
    assert.equal(run.status, 'completed');
    assert.equal(DB.getLogs(userId).filter(log => log.run_id === 'run-retry-success').length, 1);
    assert.equal(DB.getLogs(userId).some(log => log.run_id === 'run-retry-success' && log.status === 'failed'), false);
  } finally {
    await server.stop({ cleanup: false });
  }
});
