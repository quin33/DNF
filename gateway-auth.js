'use strict';

/* ============================================================
   gateway-auth.js · 网关统一登录/注册
   ------------------------------------------------------------
   被 site-gateway.js 调用，在两个游戏的 SQLite 库上验证账号，
   校验通过后签发 JWT，供游戏端 /api/auth/verify-gateway-token 换取
   游戏自己的 session token。

   对外接口（与 site-gateway.js 的用法一一对应）：
     login(username, password)        → { token, user }，失败抛错
     register(username, password, nickname) → { token, user }，失败抛错
     me(token)                        → { username, nickname }，失败抛错

   密码哈希与 db.js / server.js 完全一致：scryptSync(pw, salt, 64).hex，
   因此网关上验证过的账号，游戏端拿同一账号库也能通过。
   ============================================================ */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 密钥 / 有效期在模块加载时读一次即可；三个进程都要配同一个 GATEWAY_AUTH_SECRET。
const SECRET = process.env.GATEWAY_AUTH_SECRET || '';
const TOKEN_EXPIRE = Number(process.env.GATEWAY_SESSION_EXPIRE) || 3600;

// 两个游戏库的路径。DNF 库优先用 GATEWAY_DNF_DB，其次沿 .env.example 里的
// DNF_DB_PATH / TAVERN_DB_PATH，最后落到本目录的 dnf.db。
// 问道仙坊库同理优先 GATEWAY_XIUXIAN_DB（unified-panel 只把 GATEWAY_* 前缀的
// 变量转发给网关进程，所以网关侧用这个前缀），其次 XIUXIAN_DB_PATH。
const resolvePath = p => (p ? path.resolve(String(p)) : '');
const DNF_DB_PATH = resolvePath(process.env.GATEWAY_DNF_DB || process.env.DNF_DB_PATH || process.env.TAVERN_DB_PATH || path.join(__dirname, 'dnf.db'));
const XIUXIAN_DB_PATH = resolvePath(process.env.GATEWAY_XIUXIAN_DB || process.env.XIUXIAN_DB_PATH || '');

// ---------- 密码哈希（与 server.js / db.js 保持一致） ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
// pass_hash 存的是十六进制串，按 hex 解码成等长 Buffer 再做常量时间比较。
function hashEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

// ---------- 简易 JWT（HMAC-SHA256），与 server.js 的验证实现对称 ----------
function signJWT(payload) {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const bodyB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${headerB64}.${bodyB64}`).digest('base64url');
  return `${headerB64}.${bodyB64}.${sig}`;
}
function verifyJWT(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token 格式错误');
  const [headerB64, bodyB64, signature] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${headerB64}.${bodyB64}`).digest('base64url');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('token 签名无效');
  const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token 已过期');
  if (payload.type !== 'gateway_auth') throw new Error('token 类型错误');
  return payload;
}
function ensureSecret() {
  if (!SECRET || SECRET.length < 32) {
    throw new Error('GATEWAY_AUTH_SECRET 未配置或长度不足 32 字符');
  }
}
function issueToken(username, nickname) {
  const payload = {
    username,
    nickname: nickname || '',
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRE,
    nonce: crypto.randomBytes(16).toString('hex'),
    type: 'gateway_auth',
  };
  return signJWT(payload);
}

// ---------- 数据库访问 ----------
// 每次调用开一个新连接，用完即关：网关进程不常驻连接，避免与两个游戏的长连接
// 抢句柄、也避免库里 WAL 增长。写在锁竞争上交给 SQLite 的 busy_timeout。
function dbExists(p) {
  return !!p && fs.existsSync(p);
}
// 列出两个库里「存在」的连接。register 需要写，login/me 只读即可。
function availableDbs() {
  const list = [];
  if (dbExists(DNF_DB_PATH)) list.push({ key: 'dnf', dbPath: DNF_DB_PATH });
  if (dbExists(XIUXIAN_DB_PATH)) list.push({ key: 'xiuxian', dbPath: XIUXIAN_DB_PATH });
  if (!list.length) throw new Error('无法访问任何游戏数据库');
  return list;
}
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// 任一库命中即返回（DNF 优先）。
function findUser(username) {
  for (const { dbPath } of availableDbs()) {
    let db = null;
    try {
      db = openDb(dbPath);
      const row = db.prepare('SELECT username, pass_hash, salt, nickname FROM users WHERE username = ?').get(username);
      if (row) return { username: row.username, pass_hash: row.pass_hash, salt: row.salt, nickname: row.nickname || '' };
    } catch (error) {
      console.warn(`[gateway-auth] 查询 ${dbPath} 失败：${error.message}`);
    } finally {
      if (db) db.close();
    }
  }
  return null;
}

// 两个库里都不能占用（全局唯一）。
function usernameExists(username) {
  for (const { dbPath } of availableDbs()) {
    let db = null;
    try {
      db = openDb(dbPath);
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return true;
    } catch (error) {
      // 查询失败按已占用处理，宁可拒绝也不放行重复名。
      console.warn(`[gateway-auth] 检查 ${dbPath} 失败：${error.message}`);
      return true;
    } finally {
      if (db) db.close();
    }
  }
  return false;
}

// 在两个库里都插入同一个账号。至少成功一个库才算注册成功；
// 其余库失败只告警，不整体回滚 —— 失败侧的游戏会在用户首次登录时
// 通过 ACCOUNT_MIRROR_DB 自动补建同名账号。
function createUser(username, passHash, salt, nickname) {
  const available = availableDbs();
  let okCount = 0;
  const failures = [];
  for (const { key, dbPath } of available) {
    let db = null;
    try {
      db = openDb(dbPath);
      db.prepare('INSERT INTO users (username, pass_hash, salt, nickname, created_at) VALUES (?,?,?,?,?)')
        .run(username, passHash, salt, nickname, Date.now());
      okCount++;
    } catch (error) {
      failures.push(`${key}: ${error.message}`);
    } finally {
      if (db) db.close();
    }
  }
  if (!okCount) {
    throw new Error('所有数据库创建用户失败：' + failures.join('；'));
  }
  if (failures.length) {
    console.warn('[gateway-auth] 部分数据库创建用户失败：', failures.join('；'));
  }
}

// ---------- 对外接口 ----------
function login(username, password) {
  ensureSecret();
  const user = findUser(String(username || '').trim());
  if (!user || !hashEquals(hashPassword(password, user.salt), user.pass_hash)) {
    throw new Error('用户名或密码错误');
  }
  return {
    token: issueToken(user.username, user.nickname),
    user: { username: user.username, nickname: user.nickname },
  };
}

function register(username, password, nickname = '') {
  ensureSecret();
  const uname = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,32}$/.test(uname)) {
    throw new Error('用户名需 3~32 位，仅限字母、数字、下划线');
  }
  if (String(password || '').length < 6 || String(password).length > 64) {
    throw new Error('密码需 6~64 位');
  }
  if (usernameExists(uname)) {
    throw new Error('用户名已存在');
  }
  const nick = String(nickname || '').trim().slice(0, 10);
  const salt = makeSalt();
  createUser(uname, hashPassword(password, salt), salt, nick);
  // 注册成功即视为已登录，直接签发 token。
  return login(uname, password);
}

function me(token) {
  ensureSecret();
  const payload = verifyJWT(token);
  return { username: payload.username, nickname: payload.nickname || '' };
}

module.exports = {
  login,
  register,
  me,
  signJWT,
  verifyJWT,
  hashPassword,
  hashEquals,
  makeSalt,
  DNF_DB_PATH,
  XIUXIAN_DB_PATH,
};
