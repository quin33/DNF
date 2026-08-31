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

test('AI permanent traits enforce member, name, description, and duplicate constraints', () => {
  assert.equal(typeof GE.normalizeTraitGrant, 'function');
  const members = ['青璃真人'];
  const valid = GE.normalizeTraitGrant({
    member: '青璃真人',
    name: '绝境守心如铁',
    desc: '在本次探险中独自断后并护住同伴，因此今后遭遇强敌时更能稳住心神并提高防守表现。',
  }, members, []);

  assert.deepEqual(valid, {
    member: '青璃真人',
    name: '绝境守心如铁',
    desc: '在本次探险中独自断后并护住同伴，因此今后遭遇强敌时更能稳住心神并提高防守表现。',
  });
  assert.equal(GE.normalizeTraitGrant({ member: '陌生角色', name: '绝境守心如铁', desc: valid.desc }, members, []), null);
  assert.equal(GE.normalizeTraitGrant({ member: '青璃真人', name: '五字特质名', desc: valid.desc }, members, []), null);
  assert.equal(GE.normalizeTraitGrant({ member: '青璃真人', name: '这是一个超过十二个字的特质名称', desc: valid.desc }, members, []), null);
  assert.equal(GE.normalizeTraitGrant({ member: '青璃真人', name: '绝境守心如铁', desc: '这段描述不够二十个字。' }, members, []), null);
  assert.equal(GE.normalizeTraitGrant({ member: '青璃真人', name: '绝境守心如铁', desc: '经历与效果'.repeat(21) }, members, []), null);
  assert.equal(GE.normalizeTraitGrant({ member: '青璃真人', name: '绝境守心如铁', desc: valid.desc }, members, ['绝境守心如铁']), null);
});

test('AI injury decisions only grant a valid trait to a severe-injury candidate', () => {
  assert.equal(typeof GE.normalizeInjuryGrant, 'function');
  const decision = {
    member: '青璃真人',
    grant: true,
    name: '经脉震裂未愈',
    desc: '在本次探险中正面承受妖兽重击导致经脉受损，恢复前施展高强度功法时更容易力竭。',
  };

  assert.deepEqual(GE.normalizeInjuryGrant(decision, ['青璃真人'], []), {
    member: '青璃真人',
    name: '经脉震裂未愈',
    desc: decision.desc,
  });
  assert.equal(GE.normalizeInjuryGrant({ ...decision, grant: false }, ['青璃真人'], []), null);
  assert.equal(GE.normalizeInjuryGrant(decision, [], []), null);
  assert.equal(GE.normalizeInjuryGrant({ ...decision, name: '重伤' }, ['青璃真人'], []), null);
  assert.equal(GE.normalizeInjuryGrant({ ...decision, desc: '伤得很重。' }, ['青璃真人'], []), null);
});

test('expired injury cleanup removes the injury trait and description persistently', () => {
  const userId = Number(DB.createUser('expired_injury_user', 'hash', 'salt'));
  const injuryName = '经脉震裂未愈';
  const characterId = Number(DB.createCharacter(userId, '青璃真人', {
    name: '青璃真人',
    traits: ['木灵根', injuryName],
    traitDescs: { [injuryName]: '旧伤描述', 木灵根: '先天灵根' },
    injury: { name: injuryName, desc: '旧伤描述', expiresAt: Date.now() - 1_000 },
  }));

  const loaded = DB.getCharacter(userId, characterId);
  assert.equal(loaded.data.injury, null);
  assert.deepEqual(loaded.data.traits, ['木灵根']);
  assert.deepEqual(loaded.data.traitDescs, { 木灵根: '先天灵根' });

  const persisted = JSON.parse(DB.db.prepare('SELECT data FROM characters WHERE id = ?').get(characterId).data);
  assert.equal(persisted.injury, null);
  assert.deepEqual(persisted.traits, ['木灵根']);
  assert.deepEqual(persisted.traitDescs, { 木灵根: '先天灵根' });

  const secondRead = DB.getCharacter(userId, characterId);
  assert.equal(secondRead.data.injury, null);
  assert.deepEqual(secondRead.data.traits, ['木灵根']);
});

test('unexpired injuries remain unchanged during authoritative reads', () => {
  const userId = Number(DB.createUser('active_injury_user', 'hash', 'salt'));
  const injuryName = '经脉震裂未愈';
  const injury = { name: injuryName, desc: '仍在持续的伤势', expiresAt: Date.now() + 60_000 };
  const characterId = Number(DB.createCharacter(userId, '玄霄真人', {
    name: '玄霄真人',
    traits: ['金灵根', injuryName],
    traitDescs: { [injuryName]: injury.desc },
    injury,
  }));

  const loaded = DB.getCharacter(userId, characterId);
  assert.deepEqual(loaded.data.injury, injury);
  assert.ok(loaded.data.traits.includes(injuryName));
  assert.equal(loaded.data.traitDescs[injuryName], injury.desc);
});

test('settlement prompt requires detailed traits and uncommon AI injury judgment', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const prompt = server.slice(server.indexOf('const OUTCOME_PROMPT'), server.indexOf('const SCROLL_PROMPT'));
  const traitPrompt = server.slice(server.indexOf('const TRAIT_PROMPT'), server.indexOf('const LEARNED_SKILL_PROMPT'));
  assert.match(prompt, /描述.{0,20}20~100/);
  assert.match(prompt, /获取经历/);
  assert.match(prompt, /具体效果/);
  assert.match(prompt, /重伤候选/);
  assert.match(prompt, /低概率|少数情况|通常不要授予/);
  assert.match(prompt, /"injury"/);
  assert.doesNotMatch(prompt, /"name":"特质名"/);
  assert.doesNotMatch(traitPrompt, /"(?:断后英杰|百毒不侵|临危不乱|猎宝直觉)"/);
  assert.doesNotMatch(traitPrompt, /"name":"特质名"/);
});

test('local settlement consumes the AI injury decision and cleans its description on expiry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const aiOutcome = html.slice(html.indexOf('async function aiOutcome'), html.indexOf('async function aiExtractLoot'));
  const injuryHelpers = html.slice(html.indexOf('const INJURY_DURATION_MS'), html.indexOf('function extractLootNames'));
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function realmForLevel'));

  assert.match(aiOutcome, /party:/);
  assert.match(aiOutcome, /injury:\s*j\.injury \|\| null/);
  assert.match(injuryHelpers, /role\.injury\s*=\s*\{\s*name,\s*desc,/);
  assert.match(injuryHelpers, /delete role\.traitDescs\[injuryName\]/);
  assert.match(settlement, /aiVerdict\.injury/);
  assert.doesNotMatch(settlement, /pickInjuryFromStory\(dg\)/);
});

test('standalone AI trait route uses the shared trait validator', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = server.slice(server.indexOf("urlPath === '/api/ai/trait'"), server.indexOf("urlPath === '/api/ai/scroll'"));
  assert.match(route, /GE\.normalizeTraitGrant/);
  assert.doesNotMatch(route, /desc[^\n]*slice\(0,\s*60\)/);
});
