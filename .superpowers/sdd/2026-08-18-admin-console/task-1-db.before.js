/* ============================================================
   db.js · SQLite 持久化层（node:sqlite 内置模块，零原生依赖）
   表：users / sessions / characters / logs
   ============================================================ */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'tavern.db');
const db = new DatabaseSync(DB_PATH);

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
`);

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;  // 会话 7 天

/* ---------- users ---------- */
function createUser(username, passHash, salt) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?,?,?,?)')
    .run(username, passHash, salt, now);
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

/* ---------- characters ---------- */
function createCharacter(userId, name, data) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO characters (user_id, name, data, updated_at) VALUES (?,?,?,?)')
    .run(userId, name, JSON.stringify(data), now);
  return info.lastInsertRowid;
}
function getCharacters(userId) {
  return db.prepare('SELECT id, name, data, updated_at FROM characters WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
    .map(r => ({ id: r.id, name: r.name, data: JSON.parse(r.data), updated_at: r.updated_at }));
}
function getCharacter(userId, charId) {
  const row = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(charId, userId);
  if (!row) return null;
  return { id: row.id, name: row.name, data: JSON.parse(row.data), updated_at: row.updated_at };
}
function saveCharacter(userId, charId, data, name) {
  const now = Date.now();
  db.prepare('UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(data), name || data.name || '无名', now, charId, userId);
}

/* ---------- logs ---------- */
/* 为该用户分配下一个日志业务编号：从 1 开始递增，上限 99999（到顶后停留 99999） */
function nextLogSeq(userId) {
  const row = db.prepare("SELECT COALESCE(MAX(CAST(json_extract(data, '$.id') AS INTEGER)), 0) AS mx FROM logs WHERE user_id = ?").get(userId);
  const mx = row ? Number(row.mx) : 0;
  return Math.min(mx + 1, 99999);
}
function addLog(userId, log) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO logs (user_id, dungeon_name, status, created_at, data) VALUES (?,?,?,?,?)')
    .run(userId, log.dungeon_name || '', log.status || '', now, JSON.stringify(log));
  return info.lastInsertRowid;
}
function getLogs(userId) {
  return db.prepare('SELECT data FROM logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(userId)
    .map(r => JSON.parse(r.data));
}

module.exports = {
  db,
  createUser, findUserByUsername, findUserById,
  createSession, sessionUserId, deleteSession,
  createCharacter, getCharacters, getCharacter, saveCharacter,
  addLog, getLogs, nextLogSeq,
  SESSION_TTL_MS,
};
