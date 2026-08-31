const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-shared-suite-'));
process.env.TAVERN_DB_PATH = path.join(suiteDir, 'suite.db');
test.after(() => {
  try { require('../db').db.close(); } catch (_) {}
  fs.rmSync(suiteDir, { recursive: true, force: true });
});

test('db module honors TAVERN_DB_PATH for isolated migrations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-shared-logs-'));
  const dbPath = path.join(dir, 'isolated.db');
  const result = spawnSync(process.execPath, ['-e', "require('./db').db.close()"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, TAVERN_DB_PATH: dbPath },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(dbPath), true, 'expected the configured database file to be created');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shared log APIs collapse one run and expose it to every participant', () => {
  const db = require('../db');
  assert.equal(typeof db.addSharedLog, 'function');
  assert.equal(typeof db.getLogParticipants, 'function');
  const users = [1, 2, 3, 4].map(i => Number(db.createUser(`shared-${process.pid}-${i}`, 'hash', 'salt')));
  const result = db.addSharedLog(users.map(userId => ({ userId, memberName: `m${userId}` })), {
    run_id: `test-${Date.now()}`, status: 'completed', party_name: '测试队', dungeon_name: '测试墟',
    result_summary: '完成任务', dg_snapshot: { party: users.map((_, i) => ({ name: `m${i + 1}` })), steps: [{ text: '踏入灵墟' }] },
    settlement: { members: users.map((_, i) => ({ name: `m${i + 1}`, praise: i })), items: [{ name: '灵石' }] },
  });
  assert.ok(result.logKey);
  assert.equal(db.getLogParticipants(result.logKey).length, 4);
  assert.equal(db.getLogs(users[0]).some(log => log.log_key === result.logKey), true);
  assert.equal(db.getLogs(users[3]).some(log => log.log_key === result.logKey), true);
  assert.equal(db.getAllLogs().filter(log => log.log_key === result.logKey).length, 1);
  assert.equal(typeof db.getAllLogSummaries, 'function');
  assert.equal(typeof db.getLogById, 'function');
  const summary = db.getAllLogSummaries().find(log => log.log_key === result.logKey);
  assert.equal(summary.settlement.members.length, 4);
  assert.equal(summary.settlement.itemCount, 1);
  assert.equal(summary.dg_snapshot.steps, undefined);
  assert.equal(summary.settlement.items, undefined);
  const full = db.getLogById(result.logKey);
  assert.equal(full.dg_snapshot.steps.length, 1);
  assert.equal(full.settlement.items.length, 1);
});

test('startup migration collapses duplicate run rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-migrate-'));
  const dbPath = path.join(dir, 'legacy.db');
  const seed = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.env.TAVERN_DB_PATH); d.exec('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,pass_hash TEXT,salt TEXT,created_at INTEGER); CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,dungeon_name TEXT,status TEXT,created_at INTEGER,data TEXT);'); d.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(1,'a','h','s',0); d.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(2,'b','h','s',0); const i=d.prepare('INSERT INTO logs(user_id,dungeon_name,status,created_at,data) VALUES(?,?,?,?,?)'); i.run(1,'x','failed',1,JSON.stringify({run_id:'r1',result_summary:'short'})); i.run(2,'x','completed',2,JSON.stringify({run_id:'r1',result_summary:'long story',summary_text:'sum',settlement:{}})); d.close()`], { env: { ...process.env, TAVERN_DB_PATH: dbPath }, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const run = spawnSync(process.execPath, ['-e', `const d=require('./db'); console.log(JSON.stringify({logs:d.getAllLogs(),parts:d.db.prepare('SELECT * FROM log_participants').all()})); d.db.close()`], { cwd: path.join(__dirname, '..'), env: { ...process.env, TAVERN_DB_PATH: dbPath }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(payload.logs.length, 1);
  assert.equal(payload.logs[0].summary_text, 'sum');
  assert.equal(payload.parts.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startup removes canonical logs that no longer have a valid participant', () => {
  const db = require('../db');
  const userId = Number(db.createUser(`orphan-${process.pid}`, 'hash', 'salt'));
  const shared = db.addSharedLog([{ userId }], { run_id: `orphan-${Date.now()}`, status: 'failed' });
  db.db.prepare('DELETE FROM users WHERE id=?').run(userId);
  db.db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT DISTINCT log_id FROM log_participants)').run();
  assert.equal(db.getAllLogs().some(log => log.log_key === shared.logKey), false);
});
