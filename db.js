/* ============================================================
   db.js · SQLite 持久化层（node:sqlite 内置模块，零原生依赖）
   表：users / sessions / characters / logs
   ============================================================ */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const AI_COMPANIONS = require('./ai-companions.js');
const { clearExpiredInjury } = require('./trait-system.js');
const { normalizeItemRarity, migrateRarity } = require('./loot-settlement.js');

// 兜底库名用 dnf.db，不沿用原游戏 xiuxian 的 tavern.db：.env 不入库，
// 缺失时若回落成 tavern.db，会在本项目目录下另建一个同名库，容易与原游戏混淆。
const DB_PATH = process.env.TAVERN_DB_PATH
  ? path.resolve(process.env.TAVERN_DB_PATH)
  : path.join(__dirname, 'dnf.db');
const db = new DatabaseSync(DB_PATH);

// 多请求/多进程测试与公网部署下减少锁等待，并确保关联约束按预期执行。
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    dungeon_name TEXT,
    status TEXT,
    created_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS log_participants (
    log_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    character_id INTEGER,
    member_name TEXT NOT NULL DEFAULT '',
    personal_data TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (log_id, user_id),
    FOREIGN KEY (log_id) REFERENCES logs(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_log_participants_user ON log_participants(user_id);
  CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    before_data TEXT NOT NULL,
    after_data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS character_creation_requests (
    user_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    character_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_id)
  );
  CREATE TABLE IF NOT EXISTS character_follows (
    follower_user_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_user_id, character_id)
  );
  CREATE TABLE IF NOT EXISTS ai_companion_cards (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS characters_unique_name_insert
  BEFORE INSERT ON characters
  WHEN EXISTS (SELECT 1 FROM characters WHERE name = NEW.name)
  BEGIN
    SELECT RAISE(ABORT, '角色名重复');
  END;
  CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id);
  CREATE INDEX IF NOT EXISTS idx_characters_updated_at ON characters(updated_at);
  CREATE INDEX IF NOT EXISTS idx_logs_user_created_at ON logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_character_follows_character ON character_follows(character_id);
`);

function migrateUserNickname() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(row => row.name);
  if (!columns.includes('nickname')) {
    db.exec('ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT \'\'');
  }
}
migrateUserNickname();

function migrateSharedLogs() {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE name='shared_logs_v1'").get()) { db.exec('COMMIT'); return; }
    const validUsers = new Set(db.prepare('SELECT id FROM users').all().map(row => Number(row.id)));
    const rows = db.prepare('SELECT id,user_id,data FROM logs ORDER BY id').all().map(row => ({ ...row, log: JSON.parse(row.data || '{}') }));
    const groups = new Map();
    for (const row of rows) {
      const key = row.log.run_id ? `run:${row.log.run_id}` : `row:${row.id}`;
      const group = groups.get(key) || []; group.push(row); groups.set(key, group);
    }
    const participant = db.prepare('INSERT OR IGNORE INTO log_participants(log_id,user_id,character_id,member_name,personal_data) VALUES(?,?,?,?,?)');
    for (const group of groups.values()) {
      const valid = group.filter(row => validUsers.has(Number(row.user_id)));
      if (!valid.length) { db.prepare(`DELETE FROM logs WHERE id IN (${group.map(() => '?').join(',')})`).run(...group.map(row => row.id)); continue; }
      const score = row => [row.log.settlement ? 1 : 0, row.log.summary_text ? 1 : 0, row.log.dg_snapshot?.steps?.length || 0, String(row.log.result_summary || '').length, row.id];
      valid.sort((a, b) => { const x=score(a), y=score(b); for(let i=0;i<x.length;i++) if(x[i]!==y[i]) return y[i]-x[i]; return 0; });
      const canonical = valid[0];
      const canonicalLog = { ...canonical.log, log_key: canonical.id };
      db.prepare('UPDATE logs SET user_id=?,dungeon_name=?,status=?,data=? WHERE id=?').run(canonical.user_id, canonicalLog.dungeon_name || '', canonicalLog.status || '', JSON.stringify(canonicalLog), canonical.id);
      for (const row of valid) participant.run(canonical.id, row.user_id, null, row.log.dg_snapshot?.party?.find(m => m.is_mine)?.name || '', JSON.stringify(row.log.settlement || {}));
      const duplicateIds = group.filter(row => row.id !== canonical.id).map(row => row.id);
      if (duplicateIds.length) db.prepare(`DELETE FROM logs WHERE id IN (${duplicateIds.map(() => '?').join(',')})`).run(...duplicateIds);
    }
    db.prepare("INSERT OR IGNORE INTO schema_migrations(name,applied_at) VALUES('shared_logs_v1',?)").run(Date.now());
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
}
migrateSharedLogs();
// 删除历史测试或已删除账号留下的无参与者孤儿日志。
db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT DISTINCT log_id FROM log_participants)').run();

function migrateExpeditionRuns() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS expedition_runs (
        run_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS expedition_run_members (
        run_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        member_name TEXT NOT NULL,
        stamina_charged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, user_id, character_id),
        FOREIGN KEY (run_id) REFERENCES expedition_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_expedition_runs_status ON expedition_runs(status);
      CREATE INDEX IF NOT EXISTS idx_expedition_run_members_character
        ON expedition_run_members(user_id, character_id);
    `);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(name,applied_at) VALUES('expedition_runs_v1',?)").run(Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
migrateExpeditionRuns();

function seedAiCompanionCards() {
  const now = Date.now();
  const validKeys = new Set(AI_COMPANIONS.DEFAULT_CARDS.map(card => card.key));
  const existing = db.prepare('SELECT key, is_default FROM ai_companion_cards').all()
    .reduce((map, row) => map.set(row.key, !!row.is_default), new Map());

  // 旧版虚构预设已从 ai-companions.js 移除，启动时同步清掉遗留行，
  // 仅保留仍在当前默认名单中的名片，避免后台继续展示已废弃角色。
  const removeStale = db.prepare('DELETE FROM ai_companion_cards WHERE key = ?');
  for (const key of existing.keys()) {
    if (!validKeys.has(key)) removeStale.run(key);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ai_companion_cards (key, name, data, is_default, updated_at, created_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `);
  const refreshDefault = db.prepare(`
    UPDATE ai_companion_cards
    SET name = ?, data = ?, is_default = 1, updated_at = ?
    WHERE key = ? AND is_default = 1
  `);
  for (const card of AI_COMPANIONS.DEFAULT_CARDS) {
    if (existing.has(card.key)) {
      if (existing.get(card.key)) refreshDefault.run(card.name, JSON.stringify(card), now, card.key);
    } else {
      insert.run(card.key, card.name, JSON.stringify(card), now, now);
    }
  }
}
seedAiCompanionCards();

function listAiCompanionCards() {
  return db.prepare(`
    SELECT key, name, data, is_default, updated_at, created_at
    FROM ai_companion_cards
    ORDER BY created_at ASC, key ASC
  `).all().map(row => ({
    key: row.key,
    name: row.name,
    data: JSON.parse(row.data),
    is_default: !!row.is_default,
    updated_at: row.updated_at,
    created_at: row.created_at,
  }));
}
function getAiCompanionCard(cardKey) {
  const row = db.prepare(`
    SELECT key, name, data, is_default, updated_at, created_at
    FROM ai_companion_cards
    WHERE key = ?
  `).get(String(cardKey || ''));
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    data: JSON.parse(row.data),
    is_default: !!row.is_default,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}
function getAiCompanionCardByName(name) {
  const row = db.prepare(`
    SELECT key, name, data, is_default, updated_at, created_at
    FROM ai_companion_cards
    WHERE name = ?
  `).get(String(name || ''));
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    data: JSON.parse(row.data),
    is_default: !!row.is_default,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}
function saveAiCompanionCard(cardKey, data) {
  const existing = getAiCompanionCard(cardKey);
  if (!existing) return null;
  const now = Math.max(Date.now(), existing.updated_at + 1);
  const merged = { ...existing.data, ...data, key: existing.key, name: existing.name };
  db.prepare(`
    UPDATE ai_companion_cards
    SET name = ?, data = ?, is_default = 0, updated_at = ?
    WHERE key = ?
  `).run(merged.name, JSON.stringify(merged), now, cardKey);
  return getAiCompanionCard(cardKey);
}
function resetAiCompanionCard(cardKey) {
  const fallback = AI_COMPANIONS.findCardByKey(cardKey);
  if (!fallback) return null;
  const now = Date.now();
  db.prepare(`
    INSERT INTO ai_companion_cards (key, name, data, is_default, updated_at, created_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      is_default = 1,
      updated_at = excluded.updated_at
  `).run(fallback.key, fallback.name, JSON.stringify(fallback), now, now);
  return getAiCompanionCard(cardKey);
}

// 历史 AI 文本曾以错误编码写入替换字符；读取时修复已知字段，避免旧存档继续显示乱码。
function repairCorruptedText(value, key = '') {
  if (typeof value === 'string') {
    if (value.includes('�')) {
      if (key === 'name') return '未知道具';
      const cleaned = value.replace(/�+/g, '');
      if (key === 'desc' || key === 'description') {
        return cleaned || '暂无描述（数据已修复）';
      }
      return cleaned;
    }
    return value
      .replace(/首次运�+/g, '首次运用金气')
      .replace(/暗红煞气凝�+纹/g, '暗红煞气凝成纹')
      .replace(/震�+邪祟/g, '震慑邪祟')
      .replace(/凝聚一道锋锐金刃，可近可远�+削铁如泥。/g,
        '凝聚一道锋锐金刃，可近可远，削铁如泥。');
  }
  if (Array.isArray(value)) return value.map(item => repairCorruptedText(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repairCorruptedText(v, k)]));
  return value;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;  // 会话 7 天

const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ADMIN_CHARACTER_FIELDS = new Set([
  'name', 'character_class', 'level', 'hp', 'max_hp', 'stamina', 'max_stamina',
  'strength', 'agility', 'intelligence', 'luck', 'gold', 'exp',
  'equipment', 'bag', 'skills', 'skillPool',
]);

function adminCharacterSnapshot(data) {
  return Object.fromEntries(
    Object.entries(data || {}).filter(([field]) => ADMIN_CHARACTER_FIELDS.has(field))
  );
}

/* ---------- users ---------- */
function createUser(username, passHash, salt, nickname = '') {
  const now = Date.now();
  const info = db.prepare('INSERT INTO users (username, pass_hash, salt, nickname, created_at) VALUES (?,?,?,?,?)')
    .run(username, passHash, salt, nickname, now);
  return info.lastInsertRowid;
}
function findUserByUsername(username) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return row || null;
}
function findUserById(id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row || null;
}
function updateUserCredentials(id, passHash, salt) {
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(passHash, salt, id);
}

/* ---------- 账号镜像（两个游戏共用账号） ----------
   设置 ACCOUNT_MIRROR_DB 指向另一个游戏的 SQLite 库后，本库可读取那边的 users 表：
   - 登录时本地没有该账号、或密码对不上，就在镜像库验证，匹配则补建/同步本地账号；
   - 注册时用户名在两个库里都不能重复（全局唯一）。
   只做只读 SELECT，绝不写镜像库；角色/日志等数据仍各自独立。 */
let _mirrorDb = null;
function mirrorDb() {
  const p = String(process.env.ACCOUNT_MIRROR_DB || '').trim();
  if (!p) return null;
  if (_mirrorDb) return _mirrorDb;
  try {
    _mirrorDb = new DatabaseSync(p);
  } catch (e) {
    console.warn('[db] 打开账号镜像库失败：', String(e && e.message || e).slice(0, 120));
    _mirrorDb = null;
  }
  return _mirrorDb;
}
/* 镜像库按用户名取账号；未配置或失败返回 null */
function mirrorFindUser(username) {
  const m = mirrorDb();
  if (!m) return null;
  try {
    return m.prepare('SELECT username, pass_hash, salt, nickname FROM users WHERE username = ?').get(username) || null;
  } catch (e) {
    console.warn('[db] 账号镜像查询失败：', String(e && e.message || e).slice(0, 120));
    return null;
  }
}
/* 用户名是否已在镜像库占用；未配置返回 null，查询失败按已占用处理（保全局唯一） */
function mirrorHasUsername(username) {
  const m = mirrorDb();
  if (!m) return null;
  try {
    return !!m.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  } catch (e) {
    console.warn('[db] 账号镜像查询失败：', String(e && e.message || e).slice(0, 120));
    return true;
  }
}

/* ---------- sessions ---------- */
function createSession(userId, token) {
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}
/* 校验 token → userId 或 null（自动清理过期会话） */
function sessionUserId(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row.user_id;
}
function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---------- admin sessions ---------- */
function createAdminSession(token) {
  const now = Date.now();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?,?,?)')
    .run(token, now, now + ADMIN_SESSION_TTL_MS);
  return token;
}
function adminSessionValid(token) {
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}
function deleteAdminSession(token) {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

/* ---------- characters ---------- */
function hydrateCharacterRow(row) {
  if (!row) return null;
  const data = repairCorruptedText(JSON.parse(row.data || '{}'));
  const version = Number(data.rarity_version || 1);
  let migrated = version < 2;
  const normalizeCollection = list => Array.isArray(list) ? list.map(item => {
    const next = normalizeItemRarity(item, version);
    if (JSON.stringify(next) !== JSON.stringify(item)) migrated = true;
    return next;
  }) : list;
  data.bag = normalizeCollection(data.bag);
  data.equipment = normalizeCollection(data.equipment);
  data.skills = Array.isArray(data.skills) ? data.skills.map(skill => { const next = { name: skill && skill.name, desc: skill && skill.desc || '' }; if (skill && skill.type) migrated = true; return next; }) : data.skills;
  data.skillPool = Array.isArray(data.skillPool) ? data.skillPool.map(skill => { const next = { name: skill && skill.name, desc: skill && skill.desc || '' }; if (skill && skill.type) migrated = true; return next; }) : data.skillPool;
  if (version < 2) { data.rarity_version = 2; migrated = true; }
  const injuryChanged = clearExpiredInjury(data);
  if (!migrated && !injuryChanged) return { row, data };
  const updatedAt = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const updated = db.prepare('UPDATE characters SET data = ?, updated_at = ? WHERE id = ? AND updated_at = ?')
    .run(JSON.stringify(data), updatedAt, row.id, row.updated_at);
  if (updated.changes === 1) return { row: { ...row, data: JSON.stringify(data), updated_at: updatedAt }, data };
  const latest = db.prepare('SELECT id, user_id, name, data, updated_at FROM characters WHERE id = ?').get(row.id);
  return latest ? hydrateCharacterRow(latest) : null;
}

function createCharacter(userId, name, data) {
  const now = Date.now();
  data = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) : {};
  data.rarity_version = 2;
  for (const key of ['bag', 'equipment']) if (Array.isArray(data[key])) data[key] = data[key].map(item => normalizeItemRarity(item, 2));
  for (const key of ['skills', 'skillPool']) if (Array.isArray(data[key])) data[key] = data[key].map(skill => ({ name: skill && skill.name, desc: skill && skill.desc || '' }));
  const info = db.prepare('INSERT INTO characters (user_id, name, data, updated_at) VALUES (?,?,?,?)')
    .run(userId, name, JSON.stringify(data), now);
  return info.lastInsertRowid;
}
function characterNameExists(name, excludeId = null) {
  const target = String(name || '').trim();
  if (!target) return false;
  const row = excludeId == null
    ? db.prepare('SELECT 1 AS found FROM characters WHERE name = ? LIMIT 1').get(target)
    : db.prepare('SELECT 1 AS found FROM characters WHERE name = ? AND id != ? LIMIT 1').get(target, excludeId);
  return !!row;
}
function createCharacterIdempotent(userId, requestId, name, data) {
  const normalized = String(requestId || '').trim();
  if (!normalized || normalized.length > 100) return { status: 'invalid_request_id' };
  const existing = db.prepare('SELECT character_id FROM character_creation_requests WHERE user_id = ? AND request_id = ?').get(userId, normalized);
  if (existing) return { status: 'existing', id: existing.character_id };
  db.exec('BEGIN IMMEDIATE');
  try {
    const again = db.prepare('SELECT character_id FROM character_creation_requests WHERE user_id = ? AND request_id = ?').get(userId, normalized);
    if (again) { db.exec('COMMIT'); return { status: 'existing', id: again.character_id }; }
    const id = createCharacter(userId, name, data);
    db.prepare('INSERT INTO character_creation_requests (user_id, request_id, character_id, created_at) VALUES (?,?,?,?)')
      .run(userId, normalized, id, Date.now());
    db.exec('COMMIT');
    return { status: 'created', id };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}
function getCharacters(userId) {
  return db.prepare('SELECT id, name, data, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC, id DESC').all(userId)
    .map(hydrateCharacterRow)
    .filter(Boolean)
    .map(({ row, data }) => ({ id: row.id, name: row.name, data, updated_at: row.updated_at }));
}
function getCharacter(userId, charId) {
  const row = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(charId, userId);
  const hydrated = hydrateCharacterRow(row);
  if (!hydrated) return null;
  return { id: hydrated.row.id, name: hydrated.row.name, data: hydrated.data, updated_at: hydrated.row.updated_at };
}
function saveCharacter(userId, charId, data, name) {
  const now = Date.now();
  data = repairCorruptedText(data);
  db.prepare('UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(data), name || data.name || '无名', now, charId, userId);
  return { updated_at: now };
}

function saveCharacterIfCurrent(userId, charId, expectedUpdatedAt, data, name) {
  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  data = repairCorruptedText(data);
  const result = db.prepare(
    'UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?'
  ).run(JSON.stringify(data), name || data.name || '无名', now, charId, userId, expectedUpdatedAt);
  return result.changes === 1 ? { updated_at: now } : null;
}

/* ---------- durable expedition lifecycle ---------- */
function expeditionRunData(row) {
  if (!row) return null;
  let snapshot = {};
  try { snapshot = JSON.parse(row.snapshot || '{}'); } catch (_) {}
  return {
    runId: row.run_id,
    roomId: row.room_id,
    status: row.status,
    snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function getExpeditionRun(runId) {
  return expeditionRunData(db.prepare('SELECT * FROM expedition_runs WHERE run_id = ?').get(String(runId || '')));
}

function getActiveExpeditionRuns() {
  return db.prepare("SELECT * FROM expedition_runs WHERE status IN ('starting','running','waiting_ai','settling') ORDER BY created_at, run_id")
    .all().map(expeditionRunData);
}

function beginExpeditionRun({ runId, roomId, snapshot = {}, members = [], staminaCost = 10 }) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedRoomId = String(roomId || '').trim();
  const charge = Math.max(0, Math.floor(Number(staminaCost) || 0));
  if (!normalizedRunId || !normalizedRoomId) throw new Error('副本运行编号无效');
  if (!Array.isArray(members) || !members.length) throw new Error('副本缺少真人成员');

  db.exec('BEGIN IMMEDIATE');
  try {
    const existingRow = db.prepare('SELECT * FROM expedition_runs WHERE run_id = ?').get(normalizedRunId);
    if (existingRow) {
      db.exec('COMMIT');
      return { status: 'existing', run: expeditionRunData(existingRow), characters: [] };
    }

    const loaded = [];
    const activeMembership = db.prepare(`
      SELECT er.run_id
      FROM expedition_run_members erm
      JOIN expedition_runs er ON er.run_id = erm.run_id
      WHERE erm.user_id = ? AND erm.character_id = ?
        AND er.status IN ('starting','running','waiting_ai','settling')
      LIMIT 1
    `);
    const loadCharacter = db.prepare('SELECT id,user_id,name,data,updated_at FROM characters WHERE id = ? AND user_id = ?');
    for (const member of members) {
      const userId = Number(member && member.userId);
      const characterId = Number(member && member.characterId);
      if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(characterId)) throw new Error('副本成员无效');
      if (activeMembership.get(userId, characterId)) throw new Error('角色已在其他副本中');
      const row = loadCharacter.get(characterId, userId);
      if (!row) throw new Error('副本角色不存在');
      const data = repairCorruptedText(JSON.parse(row.data || '{}'));
      clearExpiredInjury(data);
      if (Number(data.stamina || 0) < charge) throw new Error('精力不足');
      loaded.push({ member, row, data, userId, characterId });
    }

    const now = Date.now();
    const serializedSnapshot = JSON.stringify(snapshot || {});
    db.prepare(`
      INSERT INTO expedition_runs(run_id,room_id,status,snapshot,created_at,updated_at,finished_at)
      VALUES(?,?,'starting',?,?,?,NULL)
    `).run(normalizedRunId, normalizedRoomId, serializedSnapshot, now, now);
    const insertMember = db.prepare(`
      INSERT INTO expedition_run_members(run_id,user_id,character_id,member_name,stamina_charged)
      VALUES(?,?,?,?,?)
    `);
    const updateCharacter = db.prepare('UPDATE characters SET data=?,name=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?');
    const characters = [];
    for (const entry of loaded) {
      insertMember.run(
        normalizedRunId,
        entry.userId,
        entry.characterId,
        String(entry.member.memberName || entry.data.name || entry.row.name || ''),
        charge,
      );
      entry.data.status = 'adventuring';
      entry.data.stamina = Math.max(0, Number(entry.data.stamina || 0) - charge);
      entry.data.staminaTs = now;
      entry.data.hpTs = now;
      const updatedAt = Math.max(now, Number(entry.row.updated_at || 0) + 1);
      const updated = updateCharacter.run(
        JSON.stringify(entry.data),
        entry.data.name || entry.row.name || '无名',
        updatedAt,
        entry.characterId,
        entry.userId,
        entry.row.updated_at,
      );
      if (updated.changes !== 1) throw new Error('角色数据已更新，请重试');
      characters.push({ userId: entry.userId, characterId: entry.characterId, data: entry.data, updated_at: updatedAt });
    }
    db.prepare("UPDATE expedition_runs SET status='running',snapshot=?,updated_at=? WHERE run_id=? AND status='starting'")
      .run(serializedSnapshot, now, normalizedRunId);
    db.exec('COMMIT');
    return { status: 'started', run: getExpeditionRun(normalizedRunId), characters };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function checkpointExpeditionRun(runId, snapshot) {
  const result = db.prepare("UPDATE expedition_runs SET snapshot=?,updated_at=? WHERE run_id=? AND status='running'")
    .run(JSON.stringify(snapshot || {}), Date.now(), String(runId || ''));
  return result.changes === 1;
}

function setExpeditionRunState(runId, status, snapshot, expectedStatuses = ['running']) {
  const normalizedRunId = String(runId || '').trim();
  const normalizedStatus = String(status || '').trim();
  const allowedStatuses = new Set(['starting', 'running', 'waiting_ai', 'settling']);
  const expected = [...new Set((Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses])
    .map(value => String(value || '').trim())
    .filter(value => allowedStatuses.has(value)))];
  if (!normalizedRunId || !allowedStatuses.has(normalizedStatus) || !expected.length) return false;
  const placeholders = expected.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE expedition_runs
    SET status=?,snapshot=?,updated_at=?
    WHERE run_id=? AND status IN (${placeholders})
  `).run(normalizedStatus, JSON.stringify(snapshot || {}), Date.now(), normalizedRunId, ...expected);
  return result.changes === 1;
}

function failExpeditionRun({ runId, terminalStatus = 'failed', reason = '', log = null }) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) throw new Error('副本运行编号无效');
  if (!['failed', 'interrupted'].includes(terminalStatus)) throw new Error('副本终态无效');

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM expedition_runs WHERE run_id=?').get(normalizedRunId);
    if (!row) throw new Error('副本运行不存在');
    const current = expeditionRunData(row);
    if (!['starting', 'running', 'waiting_ai', 'settling'].includes(current.status)) {
      db.exec('COMMIT');
      return {
        status: 'existing',
        terminalStatus: current.status,
        restored: 0,
        refunded: 0,
        logKey: Number(current.snapshot && current.snapshot._lifecycle && current.snapshot._lifecycle.logKey) || null,
      };
    }

    const members = db.prepare(`
      SELECT run_id,user_id,character_id,member_name,stamina_charged
      FROM expedition_run_members
      WHERE run_id=?
      ORDER BY user_id,character_id
    `).all(normalizedRunId);
    const loadCharacter = db.prepare('SELECT id,user_id,name,data,updated_at FROM characters WHERE id=? AND user_id=?');
    const updateCharacter = db.prepare('UPDATE characters SET data=?,name=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?');
    const now = Date.now();
    let restored = 0;
    let refunded = 0;
    for (const member of members) {
      const character = loadCharacter.get(member.character_id, member.user_id);
      if (!character) continue;
      const data = repairCorruptedText(JSON.parse(character.data || '{}'));
      clearExpiredInjury(data);
      if (data.status !== 'adventuring') continue;
      const charge = Math.max(0, Number(member.stamina_charged || 0));
      data.status = 'resting';
      data.stamina = Math.min(Number(data.max_stamina || 100), Number(data.stamina || 0) + charge);
      data.staminaTs = now;
      data.hpTs = now;
      const updatedAt = Math.max(now, Number(character.updated_at || 0) + 1);
      const updated = updateCharacter.run(
        JSON.stringify(data),
        data.name || character.name || '无名',
        updatedAt,
        character.id,
        character.user_id,
        character.updated_at,
      );
      if (updated.changes !== 1) throw new Error('角色数据已更新，请重试');
      restored++;
      refunded += charge;
    }

    const participants = members.map(member => ({
      userId: member.user_id,
      characterId: member.character_id,
      memberName: member.member_name,
    }));
    const shared = log && participants.length
      ? insertSharedLog(participants, { ...log, run_id: normalizedRunId, status: 'failed', cancel_reason: reason || log.cancel_reason || '' })
      : null;
    const terminalSnapshot = {
      ...(current.snapshot || {}),
      _lifecycle: {
        terminalStatus,
        reason: String(reason || ''),
        logKey: shared ? shared.logKey : null,
        finishedAt: now,
      },
    };
    db.prepare(`
      UPDATE expedition_runs
      SET status=?,snapshot=?,updated_at=?,finished_at=?
      WHERE run_id=? AND status IN ('starting','running','waiting_ai','settling')
    `).run(terminalStatus, JSON.stringify(terminalSnapshot), now, now, normalizedRunId);
    db.exec('COMMIT');
    return { status: terminalStatus, restored, refunded, logKey: shared ? shared.logKey : null };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function commitExpeditionSettlement({
  runId,
  characterWrites = [],
  characterDeletes = [],
  participants = [],
  log,
  snapshot = {},
}) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) throw new Error('副本运行编号无效');
  if (!Array.isArray(characterWrites) || !Array.isArray(characterDeletes)) throw new Error('角色结算数据无效');
  if (!Array.isArray(participants) || !participants.length || !log) throw new Error('副本结算日志无效');

  db.exec('BEGIN IMMEDIATE');
  try {
    const runRow = db.prepare('SELECT * FROM expedition_runs WHERE run_id=?').get(normalizedRunId);
    if (!runRow) throw new Error('副本运行不存在');
    const run = expeditionRunData(runRow);
    if (!['running', 'settling'].includes(run.status)) {
      if (run.status !== 'starting') {
        db.exec('COMMIT');
        return {
          status: 'existing',
          terminalStatus: run.status,
          logKey: Number(run.snapshot && run.snapshot._lifecycle && run.snapshot._lifecycle.logKey) || null,
          updatedCharacters: [],
          deletedCharacters: [],
        };
      }
      throw new Error('副本不在可结算状态');
    }

    const memberExists = db.prepare(`
      SELECT 1 FROM expedition_run_members
      WHERE run_id=? AND user_id=? AND character_id=?
    `);
    const loadCharacter = db.prepare('SELECT id,user_id,name,data,updated_at FROM characters WHERE id=? AND user_id=?');
    const seen = new Set();
    const loadedWrites = characterWrites.map(write => {
      const userId = Number(write && write.userId);
      const characterId = Number(write && write.characterId);
      const key = `${userId}:${characterId}`;
      if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(characterId) || seen.has(key)) throw new Error('角色结算数据无效');
      seen.add(key);
      const row = loadCharacter.get(characterId, userId);
      if (!row) throw new Error('角色不存在');
      if (!memberExists.get(normalizedRunId, userId, characterId)) throw new Error('角色不属于当前副本');
      return { write, row, userId, characterId };
    });
    const loadedDeletes = characterDeletes.map(entry => {
      const userId = Number(entry && entry.userId);
      const characterId = Number(entry && entry.characterId);
      const key = `${userId}:${characterId}`;
      if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(characterId) || seen.has(key)) throw new Error('角色结算数据无效');
      seen.add(key);
      const row = loadCharacter.get(characterId, userId);
      if (!row) throw new Error('角色不存在');
      if (!memberExists.get(normalizedRunId, userId, characterId)) throw new Error('角色不属于当前副本');
      return { entry, row, userId, characterId };
    });

    const now = Date.now();
    if (run.status === 'running') {
      const transition = db.prepare("UPDATE expedition_runs SET status='settling',updated_at=? WHERE run_id=? AND status='running'")
        .run(now, normalizedRunId);
      if (transition.changes !== 1) throw new Error('副本状态已更新，请重试');
    }

    const updateCharacter = db.prepare('UPDATE characters SET data=?,name=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?');
    const updatedCharacters = [];
    for (const entry of loadedWrites) {
      const data = repairCorruptedText(entry.write.data || {});
      const updatedAt = Math.max(now, Number(entry.row.updated_at || 0) + 1);
      const result = updateCharacter.run(
        JSON.stringify(data),
        entry.write.name || data.name || entry.row.name || '无名',
        updatedAt,
        entry.characterId,
        entry.userId,
        entry.row.updated_at,
      );
      if (result.changes !== 1) throw new Error('角色数据已更新，请重试');
      updatedCharacters.push({ userId: entry.userId, characterId: entry.characterId, data, updated_at: updatedAt });
    }

    const deletedCharacters = [];
    for (const entry of loadedDeletes) {
      db.prepare('DELETE FROM logs WHERE user_id=? AND json_extract(data, \'$.characterId\')=?').run(entry.userId, entry.characterId);
      db.prepare('DELETE FROM character_follows WHERE character_id=?').run(entry.characterId);
      db.prepare('DELETE FROM admin_audit_logs WHERE character_id=?').run(entry.characterId);
      db.prepare('DELETE FROM character_creation_requests WHERE character_id=?').run(entry.characterId);
      const deleted = db.prepare('DELETE FROM characters WHERE id=? AND user_id=?').run(entry.characterId, entry.userId);
      if (deleted.changes !== 1) throw new Error('角色数据已更新，请重试');
      deletedCharacters.push({ userId: entry.userId, characterId: entry.characterId });
    }

    const shared = insertSharedLog(participants, { ...log, run_id: normalizedRunId });
    const terminalSnapshot = {
      ...(snapshot || {}),
      _lifecycle: { terminalStatus: 'completed', logKey: shared.logKey, finishedAt: now },
    };
    const completed = db.prepare(`
      UPDATE expedition_runs
      SET status='completed',snapshot=?,updated_at=?,finished_at=?
      WHERE run_id=? AND status='settling'
    `).run(JSON.stringify(terminalSnapshot), now, now, normalizedRunId);
    if (completed.changes !== 1) throw new Error('副本状态已更新，请重试');
    db.exec('COMMIT');
    return { status: 'completed', logKey: shared.logKey, updatedCharacters, deletedCharacters };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function interruptedRunLog(row, snapshot, reason) {
  const runtimeRoom = snapshot && snapshot.room;
  const dungeon = snapshot && (snapshot.dungeon || snapshot.dg || (runtimeRoom && runtimeRoom.dg)) || {};
  const steps = Array.isArray(snapshot && snapshot.steps)
    ? snapshot.steps
    : Array.isArray(dungeon.steps) ? dungeon.steps : [];
  const lastStep = steps.length ? steps[steps.length - 1] : null;
  return {
    id: 1,
    run_id: row.run_id,
    party_name: String(snapshot && snapshot.partyName || `匹配小队${row.room_id}`),
    dungeon_name: String(dungeon.name || snapshot && snapshot.dungeonName || '未命名副本'),
    status: 'failed',
    created_at: new Date().toISOString(),
    result_summary: String(lastStep && (lastStep.text || lastStep.result) || reason),
    cancel_reason: reason,
    dg_snapshot: snapshot || {},
    settlement: { members: [] },
  };
}

function recoverInterruptedExpeditions(options = {}) {
  const summary = { runs: 0, characters: 0, refunded: 0, logs: 0, legacyCharacters: 0 };
  const excluded = new Set((Array.isArray(options.excludeRunIds) ? options.excludeRunIds : [])
    .map(runId => String(runId || '').trim())
    .filter(Boolean));
  const activeRows = db.prepare(`
    SELECT * FROM expedition_runs
    WHERE status IN ('starting','running','waiting_ai','settling')
    ORDER BY created_at,run_id
  `).all();

  for (const row of activeRows) {
    if (excluded.has(String(row.run_id))) continue;
    let snapshot = {};
    let reason = '服务器重启，副本已中断';
    try {
      snapshot = JSON.parse(row.snapshot || '{}');
    } catch (_) {
      reason = '服务器重启，副本数据损坏，已安全中断';
      console.error(`[recovery] invalid snapshot run=${row.run_id}`);
    }
    try {
      const result = failExpeditionRun({
        runId: row.run_id,
        terminalStatus: 'interrupted',
        reason,
        log: interruptedRunLog(row, snapshot, reason),
      });
      if (result.status !== 'interrupted') continue;
      summary.runs++;
      summary.characters += result.restored;
      summary.refunded += result.refunded;
      if (result.logKey) summary.logs++;
    } catch (error) {
      console.error(`[recovery] failed run=${row.run_id}: ${error.message}`);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const orphans = db.prepare(`
      SELECT c.id,c.user_id,c.name,c.data,c.updated_at
      FROM characters c
      WHERE json_extract(c.data, '$.status') = 'adventuring'
        AND NOT EXISTS (
          SELECT 1
          FROM expedition_run_members erm
          JOIN expedition_runs er ON er.run_id = erm.run_id
          WHERE erm.user_id = c.user_id
            AND erm.character_id = c.id
            AND er.status IN ('starting','running','waiting_ai','settling')
        )
      ORDER BY c.id
    `).all();
    const updateCharacter = db.prepare('UPDATE characters SET data=?,name=?,updated_at=? WHERE id=? AND user_id=? AND updated_at=?');
    const now = Date.now();
    for (const character of orphans) {
      let data;
      try { data = repairCorruptedText(JSON.parse(character.data || '{}')); }
      catch (_) { continue; }
      clearExpiredInjury(data);
      data.status = 'resting';
      data.staminaTs = now;
      data.hpTs = now;
      const updatedAt = Math.max(now, Number(character.updated_at || 0) + 1);
      const result = updateCharacter.run(
        JSON.stringify(data),
        data.name || character.name || '无名',
        updatedAt,
        character.id,
        character.user_id,
        character.updated_at,
      );
      summary.legacyCharacters += result.changes;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }

  return summary;
}

/* ---------- admin characters ---------- */
function searchPlayers(query) {
  const like = `%${String(query || '').trim()}%`;
  return db.prepare(`
    SELECT u.id AS user_id, u.username, c.id AS character_id, c.name AS character_name
    FROM users u
    JOIN characters c ON c.user_id = u.id
    WHERE u.username LIKE ? OR c.name LIKE ?
    ORDER BY u.username ASC, c.name ASC
  `).all(like, like).map(row => ({
    userId: row.user_id,
    username: row.username,
    characterId: row.character_id,
    characterName: row.character_name,
  }));
}
function getCharacterAdmin(charId) {
  const row = db.prepare(`
    SELECT c.id, c.user_id, c.name, c.data, c.updated_at, u.username
    FROM characters c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(charId);
  if (!row) return null;
  const data = JSON.parse(row.data);
  delete data.rarity_version;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    name: row.name,
    data,
    updated_at: row.updated_at,
  };
}
function saveCharacterAdmin(charId, expectedUpdatedAt, data) {
  const existing = getCharacterAdmin(charId);
  if (!existing || existing.updated_at !== expectedUpdatedAt) return null;

  const nextData = { ...existing.data, ...adminCharacterSnapshot(data) };
  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  const result = db.prepare(
    'UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
  ).run(JSON.stringify(nextData), nextData.name || existing.name, now, charId, expectedUpdatedAt);
  return result.changes === 1 ? { updated_at: now } : null;
}

function saveCharacterAdminWithAudit(charId, expectedUpdatedAt, data) {
  db.exec('BEGIN IMMEDIATE');
  let transactionOpen = true;
  try {
    const existing = getCharacterAdmin(charId);
    if (!existing) {
      db.exec('ROLLBACK');
      transactionOpen = false;
      return { status: 'not_found' };
    }
    if (existing.updated_at !== expectedUpdatedAt) {
      db.exec('ROLLBACK');
      transactionOpen = false;
      return { status: 'conflict' };
    }

    const nextData = { ...existing.data, ...adminCharacterSnapshot(data) };
    const now = Math.max(Date.now(), expectedUpdatedAt + 1);
    const result = db.prepare(
      'UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
    ).run(JSON.stringify(nextData), nextData.name || existing.name, now, charId, expectedUpdatedAt);
    if (result.changes !== 1) {
      db.exec('ROLLBACK');
      transactionOpen = false;
      return { status: 'conflict' };
    }

    const updated = getCharacterAdmin(charId);
    addAdminAuditLog({
      characterId: charId,
      userId: existing.userId,
      before: existing.data,
      after: updated.data,
    });
    db.exec('COMMIT');
    transactionOpen = false;
    return { status: 'saved', character: updated };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}

/* ---------- admin audit logs ---------- */
function addAdminAuditLog({ characterId, userId, before, after }) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO admin_audit_logs (user_id, character_id, created_at, before_data, after_data)
    VALUES (?,?,?,?,?)
  `).run(userId, characterId, now, JSON.stringify(adminCharacterSnapshot(before)), JSON.stringify(adminCharacterSnapshot(after)));
  return info.lastInsertRowid;
}
function getAdminAuditLogs(charId) {
  return db.prepare(`
    SELECT id, user_id, character_id, created_at, before_data, after_data
    FROM admin_audit_logs
    WHERE character_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(charId).map(row => ({
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    created_at: row.created_at,
    before: JSON.parse(row.before_data),
    after: JSON.parse(row.after_data),
  }));
}

/* ---------- logs ---------- */
/* 为该用户分配下一个日志业务编号：从 1 开始递增，上限 99999（到顶后停留 99999） */
function nextLogSeq(userId) {
  const row = db.prepare("SELECT COALESCE(MAX(CAST(json_extract(data, '$.id') AS INTEGER)), 0) AS mx FROM logs WHERE user_id = ?").get(userId);
  const mx = row ? Number(row.mx) : 0;
  return Math.min(mx + 1, 99999);
}
function addLog(userId, log) {
  return addSharedLog([{ userId }], log).logKey;
}
function insertSharedLog(participants, log) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO logs (user_id, dungeon_name, status, created_at, data) VALUES (?,?,?,?,?)')
    .run(participants[0]?.userId || 0, log.dungeon_name || '', log.status || '', now, JSON.stringify(log));
  const logKey = Number(info.lastInsertRowid);
  // 数据库行主键是日志详情的唯一身份；业务展示编号可能在并发结算时重复。
  const canonical = { ...log, id: logKey, log_key: logKey };
  db.prepare('UPDATE logs SET data=? WHERE id=?').run(JSON.stringify(canonical), logKey);
  const insert = db.prepare('INSERT OR IGNORE INTO log_participants (log_id,user_id,character_id,member_name,personal_data) VALUES(?,?,?,?,?)');
  for (const p of participants || []) {
    if (!p || p.userId == null || !db.prepare('SELECT 1 FROM users WHERE id=?').get(p.userId)) continue;
    insert.run(logKey, p.userId, p.characterId || null, p.memberName || '', JSON.stringify(p.personalData || {}));
  }
  return { logKey, log: canonical };
}
function addSharedLog(participants, log) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = insertSharedLog(participants, log);
    db.exec('COMMIT');
    return result;
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
function getLogParticipants(logKey) {
  return db.prepare('SELECT log_id,user_id,character_id,member_name,personal_data FROM log_participants WHERE log_id=? ORDER BY user_id').all(logKey);
}
function getLogs(userId) {
  return db.prepare('SELECT l.id,l.data FROM logs l JOIN log_participants p ON p.log_id=l.id WHERE p.user_id = ? ORDER BY l.created_at DESC,l.id DESC').all(userId)
    .map(r => { const data = JSON.parse(r.data); const logKey = data.log_key || r.id; return { ...data, id: logKey, log_key: logKey }; });
}
function getAllLogs() {
  return db.prepare('SELECT id,data FROM logs ORDER BY created_at DESC,id DESC').all()
    .map(r => { const data = JSON.parse(r.data); const logKey = data.log_key || r.id; return { ...data, id: logKey, log_key: logKey }; });
}
function logSummaryData(log) {
  const snap = log.dg_snapshot || {};
  const settlement = log.settlement;
  return {
    id: log.log_key ?? log.id,
    log_key: log.log_key,
    run_id: log.run_id,
    party_name: log.party_name,
    dungeon_name: log.dungeon_name,
    status: log.status,
    created_at: log.created_at,
    summary_text: log.summary_text,
    result_summary: String(log.result_summary || '').slice(0, 150),
    death: !!log.death,
    special_event_theme: log.special_event_theme || '',
    is_favorited: !!log.is_favorited,
    verdict_reason: log.verdict_reason,
    items_used: log.items_used,
    cancel_reason: log.cancel_reason,
    dg_snapshot: {
      icon: snap.icon,
      name: snap.name,
      baseName: snap.baseName,
      isHidden: snap.isHidden,
      specialEvent: snap.specialEvent,
      party: Array.isArray(snap.party) ? snap.party.map(m => ({ name: m && m.name, is_mine: !!(m && m.is_mine) })) : [],
    },
    settlement: settlement ? {
      members: Array.isArray(settlement.members) ? settlement.members.map(m => ({ name: m && m.name, is_mine: !!(m && m.is_mine), praise: (m && m.praise) || 0 })) : [],
      itemCount: Array.isArray(settlement.items) ? settlement.items.length : 0,
    } : null,
  };
}
function getAllLogSummaries() {
  return db.prepare('SELECT id,data FROM logs ORDER BY created_at DESC,id DESC').all()
    .map(r => {
      const data = JSON.parse(r.data);
      return logSummaryData({ ...data, log_key: data.log_key || r.id });
    });
}
function getLogById(id) {
  const row = db.prepare('SELECT id,data FROM logs WHERE id=?').get(id);
  if (!row) return null;
  const data = JSON.parse(row.data);
  const logKey = data.log_key || row.id;
  return { ...data, id: logKey, log_key: logKey };
}
function publicCharacterData(row) {
  const hydrated = hydrateCharacterRow(row);
  if (!hydrated) return null;
  row = hydrated.row;
  const data = hydrated.data;
  delete data.rarity_version;
  // 公共角色卡片与“我的”使用同一套完整角色字段；不再单独维护容易漏字段的白名单。
  // 角色数据本身不包含密码、令牌等账号认证信息，可安全用于公开角色展示。
  const result = {
      ...data,
      id: row.id,
      name: row.name,
      character_class: data.character_class,
      level: data.level,
      exp: data.exp,
      hp: data.hp,
      max_hp: data.max_hp,
      stamina: data.stamina,
      max_stamina: data.max_stamina,
      strength: data.strength,
      agility: data.agility,
      intelligence: data.intelligence,
      luck: data.luck,
      gold: data.gold,
      personality: data.personality || '',
      status: data.status,
      cultivation: data.cultivation,
      injury: data.injury || null,
      title_frame: data.title_frame || '',
      latest_score: data.latest_score,
      praise_count: data.praise_count || 0,
      equipment: Array.isArray(data.equipment) ? data.equipment : [],
      bag: Array.isArray(data.bag) ? data.bag : [],
      skills: Array.isArray(data.skills) ? data.skills : [],
      skillPool: Array.isArray(data.skillPool) ? data.skillPool : [],
      equippedItems: Array.isArray(data.equippedItems) ? data.equippedItems : [],
      updated_at: row.updated_at,
  };
  // DNF60：特质属性已整体移除，公共角色不再携带 traits/traitDescs/root
  delete result.traits;
  delete result.traitDescs;
  delete result.root;
  return result;
}
function getPublicCharacters() {
  return db.prepare('SELECT id, user_id, name, data, updated_at FROM characters ORDER BY updated_at DESC').all().map(publicCharacterData).filter(Boolean);
}
function getAllCharacters() {
  return db.prepare('SELECT id, user_id, name, data, updated_at FROM characters').all()
    .map(hydrateCharacterRow)
    .filter(Boolean)
    .map(({ row, data }) => ({ id: row.id, user_id: row.user_id, name: row.name, data, updated_at: row.updated_at }));
}
function getPublicCharacterById(characterId) {
  const row = db.prepare('SELECT id, user_id, name, data, updated_at FROM characters WHERE id = ?').get(characterId);
  return row ? publicCharacterData(row) : null;
}

function getFollowedCharacterIds(userId) {
  return db.prepare('SELECT character_id FROM character_follows WHERE follower_user_id = ? ORDER BY created_at ASC, character_id ASC')
    .all(userId).map(row => Number(row.character_id));
}

function setCharacterFollow(userId, characterId, followed) {
  if (followed) {
    db.prepare('INSERT OR IGNORE INTO character_follows (follower_user_id, character_id, created_at) VALUES (?,?,?)')
      .run(userId, characterId, Date.now());
  } else {
    db.prepare('DELETE FROM character_follows WHERE follower_user_id = ? AND character_id = ?').run(userId, characterId);
  }
}

function getPublicCharactersPage(options = {}) {
  const requestedPageSize = Number.parseInt(options.pageSize, 10);
  const pageSize = Math.min(12, Math.max(1, Number.isFinite(requestedPageSize) ? requestedPageSize : 12));
  const requestedPage = Number.parseInt(options.page, 10);
  const pinnedCharacterId = Number.parseInt(options.pinnedCharacterId, 10);
  const pinnedCharacter = Number.isSafeInteger(pinnedCharacterId) ? getPublicCharacterById(pinnedCharacterId) : null;
  const followedCharacterIds = [...new Set((Array.isArray(options.followedCharacterIds) ? options.followedCharacterIds : [])
    .map(id => Number(id)).filter(Number.isSafeInteger))].slice(0, 500);
  const status = String(options.status || 'all');
  const q = String(options.q || '').trim();
  const sortColumns = {
    created_at: 'updated_at',
    level: "CAST(COALESCE(json_extract(data, '$.level'), 0) AS REAL)",
    name: 'name COLLATE NOCASE',
    strength: "CAST(COALESCE(json_extract(data, '$.strength'), 0) AS REAL)",
    agility: "CAST(COALESCE(json_extract(data, '$.agility'), 0) AS REAL)",
    intelligence: "CAST(COALESCE(json_extract(data, '$.intelligence'), 0) AS REAL)",
    luck: "CAST(COALESCE(json_extract(data, '$.luck'), 0) AS REAL)",
    gold: "CAST(COALESCE(json_extract(data, '$.gold'), 0) AS REAL)",
  };
  const sort = Object.hasOwn(sortColumns, options.sort) ? options.sort : 'created_at';
  const order = options.order === 'asc' ? 'ASC' : 'DESC';
  const where = [];
  const params = [];

  if (status !== 'all') {
    where.push("COALESCE(json_extract(data, '$.status'), '') = ?");
    params.push(status);
  }
  if (q) {
    where.push('name LIKE ? COLLATE NOCASE');
    params.push(`%${q}%`);
  }
  if (pinnedCharacter) {
    where.push('id <> ?');
    params.push(pinnedCharacter.id);
  }

  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const otherTotal = Number(db.prepare(`SELECT COUNT(*) AS total FROM characters${whereClause}`).get(...params).total);
  const total = otherTotal + (pinnedCharacter ? 1 : 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1));
  const pinFirstPage = !!pinnedCharacter && page === 1;
  const limit = pinFirstPage ? pageSize - 1 : pageSize;
  const offset = pinnedCharacter && page > 1 ? (page - 1) * pageSize - 1 : (page - 1) * pageSize;
  const prioritizeFollowed = page === 1 && followedCharacterIds.length;
  const followOrder = prioritizeFollowed
    ? `CASE WHEN id IN (${followedCharacterIds.map(() => '?').join(',')}) THEN 0 ELSE 1 END, `
    : '';
  const orderParams = prioritizeFollowed ? followedCharacterIds : [];
  const rows = db.prepare(`SELECT id, user_id, name, data, updated_at FROM characters${whereClause} ORDER BY ${followOrder}${sortColumns[sort]} ${order}, id ${order} LIMIT ? OFFSET ?`)
    .all(...params, ...orderParams, limit, offset);

  const publicRows = rows.map(publicCharacterData).filter(Boolean);
  const characters = pinFirstPage ? [pinnedCharacter, ...publicRows] : publicRows;

  return { characters, total, page, pageSize, pages };
}

function deleteCharacter(characterId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getCharacterAdmin(characterId);
    if (!existing) { db.exec('ROLLBACK'); return null; }
    db.prepare('DELETE FROM logs WHERE user_id = ? AND json_extract(data, \'$.characterId\') = ?').run(existing.userId, characterId);
    db.prepare('DELETE FROM character_follows WHERE character_id = ?').run(characterId);
    db.prepare('DELETE FROM admin_audit_logs WHERE character_id = ?').run(characterId);
    db.prepare('DELETE FROM character_creation_requests WHERE character_id = ?').run(characterId);
    db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
    db.exec('COMMIT');
    return existing;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = {
  db,
  repairCorruptedText,
  createUser, findUserByUsername, findUserById, updateUserCredentials,
  mirrorFindUser, mirrorHasUsername,
  createSession, sessionUserId, deleteSession,
  createAdminSession, adminSessionValid, deleteAdminSession,
  createCharacter, characterNameExists, createCharacterIdempotent, getCharacters, getCharacter, saveCharacter, saveCharacterIfCurrent,
  beginExpeditionRun, checkpointExpeditionRun, setExpeditionRunState, failExpeditionRun, commitExpeditionSettlement, recoverInterruptedExpeditions, getExpeditionRun, getActiveExpeditionRuns,
  searchPlayers, getCharacterAdmin, saveCharacterAdmin, saveCharacterAdminWithAudit, getAllCharacters,
  addLog, addSharedLog, getLogParticipants, getLogs, getAllLogs, getAllLogSummaries, getLogById, getPublicCharacters, getPublicCharacterById, getFollowedCharacterIds, setCharacterFollow, getPublicCharactersPage, deleteCharacter, nextLogSeq,
  addAdminAuditLog, getAdminAuditLogs,
  listAiCompanionCards, getAiCompanionCard, getAiCompanionCardByName, saveAiCompanionCard, resetAiCompanionCard,
  SESSION_TTL_MS, ADMIN_SESSION_TTL_MS,
};
