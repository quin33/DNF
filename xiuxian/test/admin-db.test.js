const assert = require('node:assert/strict');
const test = require('node:test');

const DB = require('../db');

const suffix = `admin-db-${process.pid}-${Date.now()}`;
const username = `player-${suffix}`;
const characterData = {
  name: `Admin Fixture ${suffix}`,
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
  traits: [{ name: 'Steady' }],
  equipment: [{ slot: 'weapon', name: 'Sword' }],
  bag: [{ name: 'Potion', count: 2 }],
  skills: [{ name: 'Slash' }],
  skillPool: [{ name: 'Guard' }],
  hidden: 'must not be exposed or audited',
};

let userId;
let characterId;

test.before(() => {
  userId = Number(DB.createUser(username, 'hash', 'salt'));
  characterId = Number(DB.createCharacter(userId, characterData.name, characterData));
});

test.after(() => {
  DB.db.exec('DROP TRIGGER IF EXISTS fail_admin_audit_insert');
  DB.db.prepare('DELETE FROM admin_sessions WHERE token LIKE ?').run(`${suffix}%`);
  DB.db.prepare('DELETE FROM admin_audit_logs WHERE character_id = ?').run(characterId);
  DB.db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
  DB.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

test('admin sessions expire after two hours and remove expired records when checked', () => {
  const token = `${suffix}-token`;
  const realNow = Date.now;
  const createdAt = 1_000_000;

  try {
    Date.now = () => createdAt;
    DB.createAdminSession(token);
    assert.equal(DB.adminSessionValid(token), true);
    const session = DB.db.prepare('SELECT created_at, expires_at FROM admin_sessions WHERE token = ?').get(token);
    assert.equal(session.expires_at - session.created_at, 2 * 60 * 60 * 1000);

    Date.now = () => createdAt + 2 * 60 * 60 * 1000;
    assert.equal(DB.adminSessionValid(token), false);
    assert.equal(DB.db.prepare('SELECT token FROM admin_sessions WHERE token = ?').get(token), undefined);
  } finally {
    Date.now = realNow;
  }
});

test('admin player search returns only matching player and character summaries', () => {
  const results = DB.searchPlayers(username);

  assert.deepEqual(results, [{
    userId,
    username,
    characterId,
    characterName: characterData.name,
  }]);
  assert.deepEqual(DB.searchPlayers(characterData.name), results);
});

test('admin character lookup includes the owning username', () => {
  const character = DB.getCharacterAdmin(characterId);

  assert.equal(character.username, username);
  assert.equal(character.id, characterId);
  assert.deepEqual(character.data, { ...characterData, consumableSlots: [] });
});

test('admin save updates a matching version and rejects an outdated version', () => {
  const character = DB.getCharacterAdmin(characterId);
  const changed = { ...character.data, level: 9, hidden: 'still forbidden' };

  const saved = DB.saveCharacterAdmin(characterId, character.updated_at, changed);
  assert.ok(saved);
  assert.notEqual(saved.updated_at, character.updated_at);
  assert.equal(DB.getCharacterAdmin(characterId).data.level, 9);
  assert.equal(DB.getCharacterAdmin(characterId).data.hidden, characterData.hidden);

  assert.equal(DB.saveCharacterAdmin(characterId, character.updated_at, changed), null);
});

test('transactional admin save returns the committed after snapshot stored in its audit row', () => {
  const before = DB.getCharacterAdmin(characterId);
  const saved = DB.saveCharacterAdminWithAudit(characterId, before.updated_at, {
    ...before.data,
    hp: 44,
  });

  assert.equal(saved.status, 'saved');
  assert.equal(saved.character.data.hp, 44);
  assert.notEqual(saved.character.updated_at, before.updated_at);

  const [audit] = DB.getAdminAuditLogs(characterId);
  assert.deepEqual(audit.after, Object.fromEntries(
    Object.entries(saved.character.data).filter(([field]) => field !== 'hidden')
  ));
  assert.equal(audit.before.hp, before.data.hp);
});

test('transactional admin save rolls back the character update when audit insertion fails', () => {
  const before = DB.getCharacterAdmin(characterId);
  const auditCountBefore = DB.getAdminAuditLogs(characterId).length;
  DB.db.exec(`
    CREATE TEMP TRIGGER fail_admin_audit_insert
    BEFORE INSERT ON admin_audit_logs
    WHEN NEW.character_id = ${characterId}
    BEGIN
      SELECT RAISE(ABORT, 'forced audit failure');
    END;
  `);

  try {
    assert.throws(
      () => DB.saveCharacterAdminWithAudit(characterId, before.updated_at, {
        ...before.data,
        gold: 999,
      }),
      /forced audit failure/
    );
  } finally {
    DB.db.exec('DROP TRIGGER IF EXISTS fail_admin_audit_insert');
  }

  const after = DB.getCharacterAdmin(characterId);
  assert.equal(after.updated_at, before.updated_at);
  assert.deepEqual(after.data, before.data);
  assert.equal(DB.getAdminAuditLogs(characterId).length, auditCountBefore);
});

test('admin audit logs retain only whitelisted before and after role snapshots', () => {
  const before = { ...characterData, pass_hash: 'forbidden' };
  const after = { ...characterData, level: 10, user_id: 999 };

  DB.addAdminAuditLog({ characterId, userId, before, after });

  const [log] = DB.getAdminAuditLogs(characterId);
  assert.equal(log.characterId, characterId);
  assert.equal(log.userId, userId);
  assert.equal(log.before.name, characterData.name);
  assert.equal(log.after.level, 10);
  assert.equal(log.before.pass_hash, undefined);
  assert.equal(log.after.user_id, undefined);
});
