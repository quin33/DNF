const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanupDatabaseFiles, makeTempDbPath, startServer } = require('./helpers/server-fixture');

const dbPath = makeTempDbPath('expedition-runs');
process.env.TAVERN_DB_PATH = dbPath;
process.env.TAVERN_LOAD_ENV = '0';

const DB = require('../db');

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

test.after(async () => {
  if (typeof DB.db.close === 'function') DB.db.close();
  await cleanupDatabaseFiles(dbPath);
});

test('beginning an expedition atomically charges every human member once', () => {
  const userA = Number(DB.createUser('run-user-a', 'hash', 'salt'));
  const userB = Number(DB.createUser('run-user-b', 'hash', 'salt'));
  const charA = Number(DB.createCharacter(userA, '甲', role('甲')));
  const charB = Number(DB.createCharacter(userB, '乙', role('乙')));

  const result = DB.beginExpeditionRun({
    runId: 'run-1',
    roomId: 'R1',
    snapshot: { steps: [] },
    staminaCost: 10,
    members: [
      { userId: userA, characterId: charA, memberName: '甲' },
      { userId: userB, characterId: charB, memberName: '乙' },
    ],
  });

  assert.equal(result.status, 'started');
  assert.equal(DB.getExpeditionRun('run-1').status, 'running');
  assert.deepEqual(
    [DB.getCharacter(userA, charA), DB.getCharacter(userB, charB)]
      .map(character => ({ status: character.data.status, stamina: character.data.stamina })),
    [
      { status: 'adventuring', stamina: 30 },
      { status: 'adventuring', stamina: 30 },
    ],
  );
  DB.failExpeditionRun({ runId: 'run-1', terminalStatus: 'failed', reason: 'test cleanup' });
});

test('beginning an expedition rolls back every charge when one member is invalid', () => {
  const userA = Number(DB.createUser('rollback-user-a', 'hash', 'salt'));
  const userB = Number(DB.createUser('rollback-user-b', 'hash', 'salt'));
  const charA = Number(DB.createCharacter(userA, '丙', role('丙')));
  const charB = Number(DB.createCharacter(userB, '丁', role('丁', 5)));

  assert.throws(() => DB.beginExpeditionRun({
    runId: 'run-rollback',
    roomId: 'R2',
    snapshot: { steps: [] },
    staminaCost: 10,
    members: [
      { userId: userA, characterId: charA, memberName: '丙' },
      { userId: userB, characterId: charB, memberName: '丁' },
    ],
  }), /精力不足/);

  assert.equal(DB.getExpeditionRun('run-rollback'), null);
  assert.equal(DB.getCharacter(userA, charA).data.stamina, 40);
  assert.equal(DB.getCharacter(userB, charB).data.stamina, 5);
});

test('retrying the same run id does not charge stamina twice', () => {
  const userId = Number(DB.createUser('retry-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '戊', role('戊')));
  const input = {
    runId: 'run-retry',
    roomId: 'R3',
    snapshot: { steps: [] },
    staminaCost: 10,
    members: [{ userId, characterId, memberName: '戊' }],
  };

  assert.equal(DB.beginExpeditionRun(input).status, 'started');
  assert.equal(DB.beginExpeditionRun(input).status, 'existing');
  assert.equal(DB.getCharacter(userId, characterId).data.stamina, 30);
  assert.equal(
    DB.db.prepare('SELECT COUNT(*) AS count FROM expedition_run_members WHERE run_id=?').get(input.runId).count,
    1,
  );
  DB.failExpeditionRun({ runId: input.runId, terminalStatus: 'failed', reason: 'test cleanup' });
});

test('checkpoints update only running expedition rows', () => {
  const userId = Number(DB.createUser('checkpoint-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '己', role('己')));
  DB.beginExpeditionRun({
    runId: 'run-checkpoint',
    roomId: 'R4',
    snapshot: { steps: [] },
    members: [{ userId, characterId, memberName: '己' }],
  });

  assert.equal(DB.checkpointExpeditionRun('run-checkpoint', { steps: [{ stepNo: 1 }] }), true);
  assert.deepEqual(DB.getExpeditionRun('run-checkpoint').snapshot.steps, [{ stepNo: 1 }]);
  DB.db.prepare("UPDATE expedition_runs SET status='completed' WHERE run_id=?").run('run-checkpoint');
  assert.equal(DB.checkpointExpeditionRun('run-checkpoint', { steps: [{ stepNo: 2 }] }), false);
  assert.equal(DB.checkpointExpeditionRun('missing-run', {}), false);
  const character = DB.getCharacter(userId, characterId).data;
  character.status = 'resting';
  DB.saveCharacter(userId, characterId, character, character.name);
});

test('technical failure restores members and records one failed log exactly once', () => {
  const userId = Number(DB.createUser('failure-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '庚', role('庚')));
  DB.beginExpeditionRun({
    runId: 'run-failure',
    roomId: 'R5',
    snapshot: { dungeon: { name: '迷雾泽' }, steps: [{ stepNo: 1, text: '雾中失路。' }] },
    members: [{ userId, characterId, memberName: '庚' }],
  });

  const input = {
    runId: 'run-failure',
    terminalStatus: 'failed',
    reason: 'AI 服务中断',
    log: {
      id: 1,
      run_id: 'run-failure',
      party_name: '匹配小队R5',
      dungeon_name: '迷雾泽',
      status: 'failed',
      created_at: new Date().toISOString(),
      result_summary: '雾中失路。',
      dg_snapshot: { steps: [{ stepNo: 1, text: '雾中失路。' }] },
      settlement: { members: [] },
    },
  };

  const first = DB.failExpeditionRun(input);
  const second = DB.failExpeditionRun(input);
  const character = DB.getCharacter(userId, characterId).data;

  assert.equal(first.status, 'failed');
  assert.equal(first.refunded, 10);
  assert.equal(first.restored, 1);
  assert.equal(second.status, 'existing');
  assert.equal(second.logKey, first.logKey);
  assert.equal(character.status, 'resting');
  assert.equal(character.stamina, 40);
  assert.equal(DB.getLogs(userId).filter(log => log.run_id === input.runId).length, 1);
  assert.equal(DB.getExpeditionRun(input.runId).status, 'failed');
});

test('startup recovery interrupts active runs and resets legacy adventurers once', () => {
  const runningUser = Number(DB.createUser('recover-running-user', 'hash', 'salt'));
  const settlingUser = Number(DB.createUser('recover-settling-user', 'hash', 'salt'));
  const completedUser = Number(DB.createUser('recover-completed-user', 'hash', 'salt'));
  const legacyUser = Number(DB.createUser('recover-legacy-user', 'hash', 'salt'));
  const runningCharacter = Number(DB.createCharacter(runningUser, '辛', role('辛')));
  const settlingCharacter = Number(DB.createCharacter(settlingUser, '壬', role('壬')));
  const completedCharacter = Number(DB.createCharacter(completedUser, '癸', role('癸')));
  const legacyData = role('子');
  legacyData.status = 'adventuring';
  legacyData.stamina = 17;
  const legacyCharacter = Number(DB.createCharacter(legacyUser, '子', legacyData));

  DB.beginExpeditionRun({
    runId: 'run-recover-running',
    roomId: 'R6',
    snapshot: { dungeon: { name: '断桥遗迹' }, steps: [{ stepNo: 1, text: '桥面崩裂。' }] },
    members: [{ userId: runningUser, characterId: runningCharacter, memberName: '辛' }],
  });
  DB.beginExpeditionRun({
    runId: 'run-recover-settling',
    roomId: 'R7',
    snapshot: { dungeon: { name: '旧王庭' }, steps: [] },
    members: [{ userId: settlingUser, characterId: settlingCharacter, memberName: '壬' }],
  });
  DB.db.prepare("UPDATE expedition_runs SET status='settling',snapshot='not-json' WHERE run_id=?")
    .run('run-recover-settling');
  DB.beginExpeditionRun({
    runId: 'run-recover-completed',
    roomId: 'R8',
    snapshot: { dungeon: { name: '星落谷' }, steps: [] },
    members: [{ userId: completedUser, characterId: completedCharacter, memberName: '癸' }],
  });
  const completedData = DB.getCharacter(completedUser, completedCharacter).data;
  completedData.status = 'resting';
  DB.saveCharacter(completedUser, completedCharacter, completedData, completedData.name);
  DB.db.prepare("UPDATE expedition_runs SET status='completed',finished_at=? WHERE run_id=?")
    .run(Date.now(), 'run-recover-completed');

  const first = DB.recoverInterruptedExpeditions();
  const second = DB.recoverInterruptedExpeditions();

  assert.deepEqual(first, { runs: 2, characters: 2, refunded: 20, logs: 2, legacyCharacters: 1 });
  assert.deepEqual(second, { runs: 0, characters: 0, refunded: 0, logs: 0, legacyCharacters: 0 });
  assert.equal(DB.getExpeditionRun('run-recover-running').status, 'interrupted');
  assert.equal(DB.getExpeditionRun('run-recover-settling').status, 'interrupted');
  assert.equal(DB.getExpeditionRun('run-recover-completed').status, 'completed');
  assert.deepEqual(
    [
      DB.getCharacter(runningUser, runningCharacter).data,
      DB.getCharacter(settlingUser, settlingCharacter).data,
    ].map(data => ({ status: data.status, stamina: data.stamina })),
    [
      { status: 'resting', stamina: 40 },
      { status: 'resting', stamina: 40 },
    ],
  );
  const legacy = DB.getCharacter(legacyUser, legacyCharacter).data;
  assert.equal(legacy.status, 'resting');
  assert.equal(legacy.stamina, 17);
  assert.equal(DB.getLogs(runningUser).filter(log => log.run_id === 'run-recover-running').length, 1);
  assert.equal(DB.getLogs(settlingUser).filter(log => log.run_id === 'run-recover-settling').length, 1);
});

test('server startup reconciles active runs before accepting requests', async () => {
  const userId = Number(DB.createUser('server-recovery-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '丑', role('丑')));
  DB.beginExpeditionRun({
    runId: 'run-server-recovery',
    roomId: 'R9',
    snapshot: { dungeon: { name: '沉钟殿' }, steps: [] },
    members: [{ userId, characterId, memberName: '丑' }],
  });

  const server = await startServer({ dbPath });
  try {
    assert.equal(DB.getExpeditionRun('run-server-recovery').status, 'interrupted');
    assert.equal(DB.getCharacter(userId, characterId).data.status, 'resting');
  } finally {
    await server.stop({ cleanup: false });
  }
});

test('settlement commits every character and shared log exactly once', () => {
  const userA = Number(DB.createUser('settlement-user-a', 'hash', 'salt'));
  const userB = Number(DB.createUser('settlement-user-b', 'hash', 'salt'));
  const charA = Number(DB.createCharacter(userA, '寅', role('寅')));
  const charB = Number(DB.createCharacter(userB, '卯', role('卯')));
  DB.beginExpeditionRun({
    runId: 'run-settlement',
    roomId: 'R10',
    snapshot: { dungeon: { name: '照月台' }, steps: [{ stepNo: 1, text: '月华照路。' }] },
    members: [
      { userId: userA, characterId: charA, memberName: '寅' },
      { userId: userB, characterId: charB, memberName: '卯' },
    ],
  });
  const dataA = DB.getCharacter(userA, charA).data;
  const dataB = DB.getCharacter(userB, charB).data;
  Object.assign(dataA, { status: 'resting', stamina: 60, gold: 25 });
  Object.assign(dataB, { status: 'resting', stamina: 60, gold: 25 });
  const input = {
    runId: 'run-settlement',
    characterWrites: [
      { userId: userA, characterId: charA, name: '寅', data: dataA },
      { userId: userB, characterId: charB, name: '卯', data: dataB },
    ],
    characterDeletes: [],
    participants: [
      { userId: userA, characterId: charA, memberName: '寅' },
      { userId: userB, characterId: charB, memberName: '卯' },
    ],
    log: {
      id: 1,
      run_id: 'run-settlement',
      party_name: '匹配小队R10',
      dungeon_name: '照月台',
      status: 'completed',
      created_at: new Date().toISOString(),
      result_summary: '月华照路。',
      settlement: { members: [] },
    },
    snapshot: { dungeon: { name: '照月台' }, steps: [{ stepNo: 1, text: '月华照路。' }] },
  };

  const first = DB.commitExpeditionSettlement(input);
  const second = DB.commitExpeditionSettlement(input);

  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'existing');
  assert.equal(second.logKey, first.logKey);
  assert.equal(DB.getExpeditionRun(input.runId).status, 'completed');
  assert.deepEqual(
    [DB.getCharacter(userA, charA), DB.getCharacter(userB, charB)]
      .map(character => ({ status: character.data.status, stamina: character.data.stamina, gold: character.data.gold })),
    [
      { status: 'resting', stamina: 60, gold: 25 },
      { status: 'resting', stamina: 60, gold: 25 },
    ],
  );
  assert.equal(DB.getLogs(userA).filter(log => log.run_id === input.runId).length, 1);
  assert.equal(DB.getLogs(userB).filter(log => log.run_id === input.runId).length, 1);
});

test('invalid settlement rolls back character writes log and lifecycle state', () => {
  const userId = Number(DB.createUser('settlement-rollback-user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '辰', role('辰')));
  DB.beginExpeditionRun({
    runId: 'run-settlement-rollback',
    roomId: 'R11',
    snapshot: { steps: [] },
    members: [{ userId, characterId, memberName: '辰' }],
  });
  const changed = DB.getCharacter(userId, characterId).data;
  Object.assign(changed, { status: 'resting', stamina: 99, gold: 999 });

  assert.throws(() => DB.commitExpeditionSettlement({
    runId: 'run-settlement-rollback',
    characterWrites: [
      { userId, characterId, name: '辰', data: changed },
      { userId, characterId: 999999, name: '不存在', data: role('不存在') },
    ],
    participants: [{ userId, characterId, memberName: '辰' }],
    log: { run_id: 'run-settlement-rollback', dungeon_name: '空庭', status: 'completed' },
    snapshot: { steps: [{ stepNo: 1 }] },
  }), /角色不存在/);

  const character = DB.getCharacter(userId, characterId).data;
  assert.equal(character.status, 'adventuring');
  assert.equal(character.stamina, 30);
  assert.equal(character.gold, undefined);
  assert.equal(DB.getExpeditionRun('run-settlement-rollback').status, 'running');
  assert.equal(DB.getLogs(userId).filter(log => log.run_id === 'run-settlement-rollback').length, 0);
  DB.failExpeditionRun({ runId: 'run-settlement-rollback', terminalStatus: 'failed', reason: 'test cleanup' });
});
