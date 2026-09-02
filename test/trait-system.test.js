const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dbPath = path.join(os.tmpdir(), `tavern-traits-${process.pid}-${crypto.randomUUID()}.db`);
process.env.TAVERN_DB_PATH = dbPath;

const DB = require('../db.js');
const GE = require('../game-engine.js');

test.after(() => {
  if (typeof DB.db.close === 'function') DB.db.close();
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
});

test('AI injury grants enforce member-in-candidates, name, and description constraints', () => {
  assert.equal(typeof GE.normalizeInjuryGrant, 'function');
  const candidates = ['青璃真人'];
  const valid = {
    member: '青璃真人',
    grant: true,
    name: '经脉震裂未愈',
    desc: '在本次探险中正面承受妖兽重击导致经脉受损，恢复前施展高强度功法时更容易力竭。',
  };

  assert.deepEqual(GE.normalizeInjuryGrant(valid, candidates), {
    member: '青璃真人',
    name: '经脉震裂未愈',
    desc: valid.desc,
  });
  assert.equal(GE.normalizeInjuryGrant({ ...valid, grant: false }, candidates), null);
  assert.equal(GE.normalizeInjuryGrant(valid, ['路人甲']), null);
  assert.equal(GE.normalizeInjuryGrant({ ...valid, name: '重伤' }, candidates), null);
  assert.equal(GE.normalizeInjuryGrant({ ...valid, name: '这是一个超过十二个字的临时受伤名称' }, candidates), null);
  assert.equal(GE.normalizeInjuryGrant({ ...valid, desc: '伤得很重。' }, candidates), null);
  assert.equal(GE.normalizeInjuryGrant({ ...valid, desc: '经历与效果'.repeat(21) }, candidates), null);
});

test('expired injuries are cleared, active injuries persist', () => {
  assert.equal(typeof GE.clearExpiredInjury, 'function');
  const expired = { injury: { name: '旧伤', desc: '旧伤描述', expiresAt: Date.now() - 1_000 } };
  assert.equal(GE.clearExpiredInjury(expired), true);
  assert.equal(expired.injury, null);

  const active = { injury: { name: '新伤', desc: '新伤描述', expiresAt: Date.now() + 60_000 } };
  assert.equal(GE.clearExpiredInjury(active), false);
  assert.ok(active.injury);

  assert.equal(GE.clearExpiredInjury(null), false);
  assert.equal(GE.clearExpiredInjury({}), false);
});

test('DB authoritative reads clear expired injury persistently', () => {
  const userId = Number(DB.createUser('expired_injury_user', 'hash', 'salt'));
  const characterId = Number(DB.createCharacter(userId, '青璃真人', {
    name: '青璃真人',
    injury: { name: '经脉震裂未愈', desc: '旧伤描述', expiresAt: Date.now() - 1_000 },
  }));

  const loaded = DB.getCharacter(userId, characterId);
  assert.equal(loaded.data.injury, null);

  const persisted = JSON.parse(DB.db.prepare('SELECT data FROM characters WHERE id = ?').get(characterId).data);
  assert.equal(persisted.injury, null);

  const secondRead = DB.getCharacter(userId, characterId);
  assert.equal(secondRead.data.injury, null);
});

test('unexpired injuries remain unchanged during authoritative reads', () => {
  const userId = Number(DB.createUser('active_injury_user', 'hash', 'salt'));
  const injury = { name: '经脉震裂未愈', desc: '仍在持续的伤势', expiresAt: Date.now() + 60_000 };
  const characterId = Number(DB.createCharacter(userId, '玄霄真人', { name: '玄霄真人', injury }));

  const loaded = DB.getCharacter(userId, characterId);
  assert.deepEqual(loaded.data.injury, injury);
});

test('settlement outcome prompt requires rare AI injury judgment and no traits', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const prompt = server.slice(server.indexOf('const OUTCOME_PROMPT'), server.indexOf('const SCROLL_PROMPT'));
  assert.match(prompt, /描述.{0,20}20~100/);
  assert.match(prompt, /重伤候选/);
  assert.match(prompt, /低概率|少数情况|通常不要授予/);
  assert.match(prompt, /"injury"/);
  assert.doesNotMatch(prompt, /"name":"特质名"/);
  assert.doesNotMatch(prompt, /特质/);
});

test('local settlement consumes the AI injury decision and cleans it on expiry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const aiOutcome = html.slice(html.indexOf('async function aiOutcome'), html.indexOf('async function aiExtractLoot'));
  const injuryHelpers = html.slice(html.indexOf('const INJURY_DURATION_MS'), html.indexOf('function cnNumToInt'));
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function applyLocalLevelGrowth'));

  assert.match(aiOutcome, /party:/);
  assert.match(aiOutcome, /injury:\s*j\.injury \|\| null/);
  assert.match(injuryHelpers, /role\.injury\s*=\s*\{\s*name,\s*desc,/);
  assert.match(injuryHelpers, /role\.injury\s*=\s*null/);
  assert.match(settlement, /aiVerdict\.injury/);
  assert.doesNotMatch(settlement, /pickInjuryFromStory\(dg\)/);
});

test('the standalone AI trait route and trait prompt are removed', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /api\/ai\/trait/);
  assert.doesNotMatch(server, /const TRAIT_PROMPT/);
  assert.doesNotMatch(server, /GE\.normalizeTraitGrant/);
});
