/* ============================================================
   问道仙坊 · AI 探险日志服务（联机版：HTTP + WebSocket + SQLite）
   ------------------------------------------------------------
   启动：  node server.js
   访问：  http://localhost:8787        → 首页（首次弹登录，登录后联机游玩）
   配置：  通过 AI_BASE_URL / AI_API_KEY / AI_MODEL 等环境变量注入
   依赖：  ws（WebSocket） + node:sqlite（内置）
   说明：  页面每次探险的每一步会调用 /api/ai/story，AI 生成该步叙事。
           登录后角色存服务器，单人匹配与副本由服务端权威推进。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const DB = require('./db.js');
const GC = require('./game-create.js');
const GE = require('./game-engine.js');
const TI = require('./taixu-insight.js');
const AI_COMPANIONS = require('./ai-companions.js');
const { createRoomRunner } = require('./room-runner.js');
const {
  classifyAiFailure,
  hydrateDurableRoom,
  retryDelay,
  serializeDurableRoom,
} = require('./expedition-resume.js');
const {
  extractSpiritStoneEvents,
  splitSpiritStones,
  totalSpiritStones: sumSpiritStones,
  isValidLootName,
  normalizeLootItems,
  buildLootAudit,
} = require('./loot-settlement.js');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

// 本机部署可将密钥保存到项目根目录的 .env；系统环境变量优先。
function loadLocalEnv() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[env] 无法读取 .env：', error.message);
  }
}
if (process.env.TAVERN_LOAD_ENV !== '0') loadLocalEnv();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const CONFIG = {
  baseURL: String(process.env.AI_BASE_URL || '').trim(),
  apiKey: String(process.env.AI_API_KEY || '').trim(),
  model: String(process.env.AI_MODEL || '').trim(),
  maxTokens: envNumber('AI_MAX_TOKENS', 5000),
  temperature: Number.isFinite(Number(process.env.AI_TEMPERATURE)) ? Number(process.env.AI_TEMPERATURE) : 0.85,
};
const isConfigured = !!(CONFIG.baseURL && CONFIG.apiKey && CONFIG.model && !String(CONFIG.apiKey).includes('在这里填入') && !String(CONFIG.apiKey).startsWith('sk-在这里'));
function parseRuntimeBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return fallback;
}
const runtimeAiState = {
  enabled: parseRuntimeBoolean(process.env.AI_ENABLED, true),
  version: 0,
  updatedAt: Date.now(),
};
function getRuntimeAiStatus() {
  return {
    enabled: runtimeAiState.enabled,
    configured: isConfigured,
    version: runtimeAiState.version,
    updatedAt: runtimeAiState.updatedAt,
    model: CONFIG.model || null,
  };
}
process.on('message', message => {
  if (!message || message.type !== 'runtime_config') return;
  const version = Number(message.version);
  if (!Number.isSafeInteger(version) || Number(message.version) <= runtimeAiState.version) return;
  runtimeAiState.enabled = parseRuntimeBoolean(message.aiEnabled, runtimeAiState.enabled);
  runtimeAiState.version = version;
  runtimeAiState.updatedAt = Date.now();
  if (typeof process.send === 'function') {
    process.send({ type: 'runtime_config_ack', version });
  }
});
const AI_MAX_BODY_BYTES = 512 * 1024;
const AI_RATE_WINDOW_MS = 60 * 1000;
const AI_RATE_LIMIT = 30;
const AI_MAX_IN_FLIGHT = 4;
const AUTH_RATE_WINDOW_MS = 60 * 1000;
const AUTH_RATE_LIMIT = 60;
const LOGIN_USER_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_USER_RATE_LIMIT = 15;
let aiInFlight = 0;

/* 通用限流器：按 key 计数滑窗，定时清理过期条目并限制总桶数，避免内存无限增长 */
function createRateLimiter({ windowMs, max, name = 'limiter', maxBuckets = 20000 }) {
  const buckets = new Map();
  const cleanupMs = Math.max(1000, Math.floor(windowMs / 4));
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rest] of buckets) {
      if (now - rest.startedAt >= windowMs) buckets.delete(key);
    }
    if (buckets.size > maxBuckets) {
      const entries = Array.from(buckets.entries()).sort((a, b) => a[1].startedAt - b[1].startedAt);
      const excess = buckets.size - maxBuckets;
      for (let i = 0; i < excess; i++) buckets.delete(entries[i][0]);
    }
  }, cleanupMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    name,
    check(key) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= windowMs) {
        bucket = { startedAt: now, count: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      const allowed = bucket.count <= max;
      const retryAfter = allowed ? 0 : Math.max(0, bucket.startedAt + windowMs - now);
      return { allowed, count: bucket.count, retryAfter };
    },
    size() { return buckets.size; },
  };
}
const aiLimiter = createRateLimiter({ windowMs: AI_RATE_WINDOW_MS, max: AI_RATE_LIMIT, name: 'ai', maxBuckets: 20000 });
const authIpLimiter = createRateLimiter({ windowMs: AUTH_RATE_WINDOW_MS, max: AUTH_RATE_LIMIT, name: 'auth-ip', maxBuckets: 20000 });
const loginUserLimiter = createRateLimiter({ windowMs: LOGIN_USER_RATE_WINDOW_MS, max: LOGIN_USER_RATE_LIMIT, name: 'login-user', maxBuckets: 20000 });
const TAIXU_INSIGHT_DURATION_MS = 60 * 60 * 1000;
const TAIXU_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const taixuInsightJobs = new Map();
const FORGE_JOB_TTL_MS = 15 * 60 * 1000;
const forgeJobs = new Map();
const FORGE_STAMINA_COST = 20;
const FORGE_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const FORGE_RARITY_ALIASES = { '普通': 'common', '稀有': 'rare', '珍贵': 'epic', '史诗': 'epic', '传说': 'legendary', '神话': 'mythic' };
function normalizeForgeRarity(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = FORGE_RARITY_ALIASES[raw] || raw;
  return FORGE_RARITIES.includes(normalized) ? normalized : 'common';
}
function forgeRarityUpgrade(baseRarity) {
  const baseIndex = Math.max(0, FORGE_RARITIES.indexOf(normalizeForgeRarity(baseRarity)));
  const upgraded = Math.random() < 0.5;
  return FORGE_RARITIES[Math.min(FORGE_RARITIES.length - 1, baseIndex + (upgraded ? 1 : 0))];
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/* ============================================================
   账号鉴权：scrypt 密码哈希 + 会话 token
   ============================================================ */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
/* 常量时间比较两段 hex 哈希，避免侧信道 */
function hashEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
/* 从 Authorization: Bearer xxx 取 token */
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
function authUser(req) {
  const uid = DB.sessionUserId(bearerToken(req));
  return uid ? DB.findUserById(uid) : null;
}

function clientAddress(req) {
  const trustProxy = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));
  const raw = trustProxy && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : (req.socket && req.socket.remoteAddress) || '';
  return String(raw).replace(/^::ffff:/, '') || 'unknown';
}

function requireAiAccess(req, res) {
  if (!authUser(req)) {
    sendJSON(res, 401, { error: '未登录' });
    return false;
  }
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > AI_MAX_BODY_BYTES) {
    sendJSON(res, 413, { error: 'AI 请求体过大' });
    return false;
  }
  const rate = aiLimiter.check(clientAddress(req));
  if (!rate.allowed) {
    sendJSON(res, 429, { error: 'AI 请求过于频繁，请稍后重试' });
    return false;
  }
  if (aiInFlight >= AI_MAX_IN_FLIGHT) {
    sendJSON(res, 429, { error: 'AI 服务繁忙，请稍后重试' });
    return false;
  }
  aiInFlight++;
  req._releaseAi = () => {
    if (!req._releaseAi) return;
    req._releaseAi = null;
    aiInFlight = Math.max(0, aiInFlight - 1);
  };
  res._releaseAi = req._releaseAi;
  return true;
}

const ADMIN_CHARACTER_FIELDS = new Set([
  'name', 'character_class', 'level', 'hp', 'max_hp', 'stamina', 'max_stamina',
  'strength', 'agility', 'intelligence', 'luck', 'gold', 'exp',
  'traits', 'equipment', 'bag', 'skills', 'skillPool',
]);
const ADMIN_NUMERIC_FIELDS = new Set([
  'level', 'hp', 'max_hp', 'stamina', 'max_stamina',
  'strength', 'agility', 'intelligence', 'luck', 'gold', 'exp',
]);
const ADMIN_TEXT_FIELDS = new Set(['name', 'character_class']);
const ADMIN_ARRAY_FIELDS = new Set(['traits', 'equipment', 'bag', 'skills', 'skillPool']);
const ADMIN_TEXT_MAX_LENGTH = 1000;
const ADMIN_IDENTITY_MAX_LENGTH = 100;
const ADMIN_ARRAY_MAX_ITEMS = 100;

const COMPANION_FIELDS = new Set([
  ...ADMIN_CHARACTER_FIELDS,
  'gender', 'personality', 'title', 'title_frame', 'bio', 'traitDescs', 'status',
]);
const COMPANION_TEXT_FIELDS = new Set([
  'name', 'character_class', 'gender', 'personality', 'title', 'title_frame', 'bio',
]);
const COMPANION_OBJECT_FIELDS = new Set(['traitDescs']);

// 玩家自动保存只允许提交非经济、非战斗的资料字段；资源与状态必须由服务端领域操作修改。
const PLAYER_MUTABLE_CHARACTER_FIELDS = new Set([
  'name', 'gender', 'personality', 'title', 'background',
]);
const AUTHORITATIVE_CHARACTER_FIELDS = new Set([
  'level', 'hp', 'max_hp', 'stamina', 'max_stamina', 'strength', 'agility',
  'intelligence', 'luck', 'gold', 'exp', 'breakthroughBonus', 'injury',
]);
const SERVER_LIBRARY_BOOKS = new Map([
  ['tuna', { name: '吐纳诀', type: '功法', elem: '无', tier: '黄阶', price: 50, stock: 20, desc: '最基础的呼吸吐纳之法，引天地灵气入体，稳固根基，气脉绵长。' }],
  ['yufeng', { name: '御风诀', type: '功法', elem: '无', tier: '玄阶', price: 60, stock: 18, desc: '运气于足底，身轻如燕，步法迅捷，探路逃遁皆有妙用。' }],
  ['wood_shield', { name: '木盾术', type: '术法', elem: '木灵根', tier: '黄阶', price: 70, stock: 16, desc: '催生灵力凝成一面青木盾，可挡寻常刀剑与爪牙。' }],
  ['fireball', { name: '火球术', type: '术法', elem: '火灵根', tier: '玄阶', price: 80, stock: 15, desc: '凝聚一团赤焰火球掷向敌手，爆裂灼烧，炼气期术法的招牌。' }],
  ['water_arrow', { name: '水箭术', type: '术法', elem: '水灵根', tier: '地阶', price: 80, stock: 15, desc: '凝水成箭，破空无声，阴湿之地威力更盛。' }],
  ['gold_blade', { name: '金刃术', type: '术法', elem: '金灵根', tier: '天阶', price: 80, stock: 15, desc: '凝聚一道锋锐金刃，可近可远，削铁如泥。' }],
  ['lianxi', { name: '敛息术', type: '功法', elem: '无', tier: '玄阶', price: 90, stock: 12, desc: '收敛气息灵机，隐于暗处，修士探索阴地必备之技。' }],
  ['qingmu', { name: '青木长生功', type: '功法', elem: '木灵根', tier: '天阶', price: 320, stock: 8, desc: '筑基级木系功法，吐纳青木生气，绵绵不绝，伤势恢复极快。' }],
  ['xuanbing', { name: '玄冰真气', type: '功法', elem: '水灵根', tier: '地阶', price: 320, stock: 8, desc: '筑基级水系功法，引水灵凝寒成冰，真气过处寒气逼人。' }],
  ['zixiao', { name: '紫霄雷法', type: '术法', elem: '雷灵根', tier: '天阶', price: 420, stock: 6, desc: '筑基级雷系术法，引紫霄天雷为己用，一击之威惊动四野。' }],
  ['yujian', { name: '御剑术·初窥', type: '术法', elem: '金灵根', tier: '地阶', price: 450, stock: 5, desc: '剑修入门秘录，御使飞剑千里取敌，初窥门径已非凡俗可比。' }],
]);
const serverLibraryStock = new Map([...SERVER_LIBRARY_BOOKS].map(([code, book]) => [code, book.stock]));

const CULTIVATION_HALF_HOUR_MS = 30 * 60 * 1000;
const CULTIVATION_HOUR_MS = 60 * 60 * 1000;
const BREAKTHROUGH_DURATION_MS = 2 * CULTIVATION_HOUR_MS;

function cultivationRealmForLevel(level) {
  if (level <= 10) return '练气' + (level === 1 ? '一层' : ['二', '三', '四', '五', '六', '七', '八', '九', '十'][level - 2] + '层');
  if (level === 11) return '筑基前期';
  if (level === 12) return '筑基中期';
  if (level === 13) return '筑基后期';
  return '筑基圆满';
}

function applyCultivationExp(role, amount) {
  const levels = GE.applyExperience(role, amount);
  if (levels.length) role.character_class = cultivationRealmForLevel(role.level);
  return levels;
}

function settleCultivation(role, now = Date.now(), randomFn = Math.random) {
  const state = role && role.cultivation;
  if (!state || !Number.isFinite(Number(state.endsAt))) return { changed: false, event: null };
  if (state.mode === 'cultivate') {
    const through = Math.min(now, Number(state.endsAt));
    const last = Number(state.lastSettledAt || state.startedAt || through);
    const intervals = Math.max(0, Math.floor((through - last) / CULTIVATION_HALF_HOUR_MS));
    let changed = false;
    if (intervals > 0) {
      applyCultivationExp(role, intervals * 50);
      state.lastSettledAt = last + intervals * CULTIVATION_HALF_HOUR_MS;
      changed = true;
    }
    if (now >= Number(state.endsAt)) {
      delete role.cultivation;
      role.status = 'resting';
      return { changed: true, event: { type: 'cultivation_completed', expAwarded: intervals * 50 } };
    }
    return { changed, event: null };
  }
  if (state.mode === 'breakthrough' && now >= Number(state.endsAt)) {
    const chance = Math.min(1, 0.5 + Number(role.breakthroughBonus || 0));
    delete role.cultivation;
    role.status = 'resting';
    if (randomFn() < chance) {
      role.level = 11;
      role.exp = 0;
      GE.applyLevelGrowth(role, { breakthrough: true });
      role.character_class = '筑基前期';
      role.breakthroughBonus = 0;
      return { changed: true, event: { type: 'breakthrough_success', chance } };
    }
    role.exp = 0;
    role.breakthroughBonus = Number(role.breakthroughBonus || 0) + 0.1;
    return { changed: true, event: { type: 'breakthrough_failed', chance, bonus: role.breakthroughBonus } };
  }
  return { changed: false, event: null };
}

function cultivationStartBlocked(role) {
  if (role.cultivation) return '角色正在闭关';
  if (role.status === 'insighting' || role.taixuInsight) return '角色正在太虚幻境参悟';
  if (['in_party', 'adventuring'].includes(role.status)) return '角色当前无法闭关';
  return '';
}

function characterBusyReason(role) {
  if (!role) return '';
  if (role.status === 'insighting' || role.taixuInsight) return '角色正在太虚幻境参悟';
  if (role.status === 'adventuring') return '角色正在探险';
  if (role.cultivation) return '角色正在闭关';
  if (role.status === 'in_party') return '角色正在队伍中';
  return '';
}

// 装备与功法调整只在实际探险期间锁定；闭关、参悟、组队等待等状态仍可整理战备。
function equipmentActionBusyReason(role) {
  if (role && role.status === 'adventuring') return '角色正在探险';
  return '';
}

/* 与单机版一致：精力每分钟回复 1 点，气血每 3 分钟回复 1 点，封顶上限，离线时间也累计。 */
function settlePassiveRecovery(role, now = Date.now()) {
  if (!role) return false;
  const hadStaminaTs = role.staminaTs != null && role.staminaTs !== '' && Number.isFinite(Number(role.staminaTs));
  const hadHpTs = role.hpTs != null && role.hpTs !== '' && Number.isFinite(Number(role.hpTs));
  const staminaTsBefore = role.staminaTs;
  const hpTsBefore = role.hpTs;
  if (!hadStaminaTs) role.staminaTs = now;
  if (!hadHpTs) role.hpTs = now;
  const staminaChanged = GE.regenerateStamina(role, now);
  const hpChanged = GE.regenerateHp(role, now);
  const staminaTsChanged = hadStaminaTs && role.staminaTs !== staminaTsBefore;
  const hpTsChanged = hadHpTs && role.hpTs !== hpTsBefore && role.status !== 'adventuring';
  return staminaChanged || hpChanged || staminaTsChanged || hpTsChanged;
}

class AdminInputError extends Error {}

function adminConfigured() {
  return typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length > 0;
}

function adminPasswordMatches(password) {
  if (!adminConfigured() || typeof password !== 'string') return false;
  const actual = Buffer.from(password, 'utf8');
  const expected = Buffer.from(process.env.ADMIN_PASSWORD, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requireAdmin(req, res) {
  if (!adminConfigured() || !DB.adminSessionValid(bearerToken(req))) {
    sendJSON(res, 401, { error: '无管理员权限' });
    return false;
  }
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAdminNestedValue(value, depth = 0) {
  if (depth > 6) throw new AdminInputError('角色数据嵌套过深');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > ADMIN_TEXT_MAX_LENGTH) throw new AdminInputError('角色文本过长');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new AdminInputError('角色数值无效');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > ADMIN_ARRAY_MAX_ITEMS) throw new AdminInputError('角色数组项目过多');
    value.forEach(item => validateAdminNestedValue(item, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      if (key.length > ADMIN_IDENTITY_MAX_LENGTH) throw new AdminInputError('角色字段名过长');
      validateAdminNestedValue(item, depth + 1);
    });
    return;
  }
  throw new AdminInputError('角色数据结构无效');
}

function sanitizeAdminCharacter(input, existing) {
  if (!isPlainObject(input)) throw new AdminInputError('缺少角色数据');
  const unknown = Object.keys(input).find(field => !ADMIN_CHARACTER_FIELDS.has(field));
  if (unknown) throw new AdminInputError('包含不允许修改的字段');

  const next = { ...existing };
  for (const [field, value] of Object.entries(input)) {
    if (ADMIN_TEXT_FIELDS.has(field)) {
      if (typeof value !== 'string' || !value.trim() || value.length > ADMIN_IDENTITY_MAX_LENGTH) {
        throw new AdminInputError('角色文本无效');
      }
    } else if (ADMIN_NUMERIC_FIELDS.has(field)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new AdminInputError('角色数值无效');
      }
    } else if (ADMIN_ARRAY_FIELDS.has(field)) {
      if (!Array.isArray(value) || value.length > ADMIN_ARRAY_MAX_ITEMS) {
        throw new AdminInputError('角色数组无效');
      }
      value.forEach(item => {
        const validTrait = field === 'traits' && typeof item === 'string' && item.trim();
        const validObject = isPlainObject(item) && typeof item.name === 'string' && item.name.trim();
        if (!validTrait && !validObject) throw new AdminInputError('角色数组项目无效');
        validateAdminNestedValue(item);
      });
    }
    next[field] = value;
  }

  if (typeof next.hp === 'number' && typeof next.max_hp === 'number' && next.hp > next.max_hp) {
    throw new AdminInputError('气血不能超过上限');
  }
  if (typeof next.stamina === 'number' && typeof next.max_stamina === 'number' && next.stamina > next.max_stamina) {
    throw new AdminInputError('精力不能超过上限');
  }
  return next;
}

function sanitizeAdminCompanion(input, existing) {
  if (!isPlainObject(input)) throw new AdminInputError('缺少名片数据');
  const unknown = Object.keys(input).find(field => !COMPANION_FIELDS.has(field));
  if (unknown) throw new AdminInputError('包含不允许修改的字段');

  const next = { ...existing };
  for (const [field, value] of Object.entries(input)) {
    if (COMPANION_TEXT_FIELDS.has(field)) {
      if (typeof value !== 'string') throw new AdminInputError('名片文本无效');
      if (field === 'gender' && !['男', '女'].includes(value)) throw new AdminInputError('性别仅支持男/女');
      if (field !== 'bio' && field !== 'traitDescs') {
        if (!value.trim()) throw new AdminInputError('名片文本不能为空');
        if (value.length > (field === 'character_class' ? ADMIN_IDENTITY_MAX_LENGTH : 200)) {
          throw new AdminInputError('名片文本过长');
        }
      } else if (value.length > ADMIN_TEXT_MAX_LENGTH) {
        throw new AdminInputError('名片文本过长');
      }
    } else if (ADMIN_NUMERIC_FIELDS.has(field)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new AdminInputError('名片数值无效');
      }
    } else if (ADMIN_ARRAY_FIELDS.has(field)) {
      if (!Array.isArray(value) || value.length > ADMIN_ARRAY_MAX_ITEMS) {
        throw new AdminInputError('名片数组无效');
      }
      value.forEach(item => {
        const validTrait = field === 'traits' && typeof item === 'string' && item.trim();
        const validObject = isPlainObject(item) && typeof item.name === 'string' && item.name.trim();
        if (!validTrait && !validObject) throw new AdminInputError('名片数组项目无效');
        validateAdminNestedValue(item);
      });
    } else if (COMPANION_OBJECT_FIELDS.has(field)) {
      if (!isPlainObject(value)) throw new AdminInputError('名片对象字段无效');
      validateAdminNestedValue(value);
    }
    next[field] = value;
  }

  if (typeof next.hp === 'number' && typeof next.max_hp === 'number' && next.hp > next.max_hp) {
    throw new AdminInputError('气血不能超过上限');
  }
  if (typeof next.stamina === 'number' && typeof next.max_stamina === 'number' && next.stamina > next.max_stamina) {
    throw new AdminInputError('精力不能超过上限');
  }
  if (next.name && String(next.name).trim() !== String(existing.name || '').trim()) {
    throw new AdminInputError('预设名片名称不可修改');
  }
  return next;
}

/* ============================================================
   AI 提示词（整合世界观 / 结构 / 叙事 / 装备 / 技能 / 判定）
   ============================================================ */
const SYSTEM_PROMPT = `你是《问道仙坊》的探险日志作家，一名修仙志怪小说作者。游戏世界观：天地灵气枯竭后，修仙者聚居在洞天福地，经「灵墟」（上古战场破碎空间）探险求道；修仙体系参考：炼气、筑基、金丹、元婴、化神、炼虚、合体、大乘、渡劫。可提及功法、法宝、丹药、阵法、符箓、灵兽、禁制、心魔、天劫等元素；角色四维为体魄/身法/神识/气运；货币为灵石。**修士皆隶属宗门，灵墟探险多为宗门派发的任务——每次进入副本都是受宗门差遣，任务完成须回宗门复命并领取报酬。**

叙事规则：
1. 使用古风仙侠文笔，兼有白话叙事，画面感强，节奏张弛有度。
2. 战斗描写要符合境界与法宝特性，避免一刀999或无脑碾压；若敌人境界高于队伍，需体现苦战、智取或撤退。
3. 角色融入：每名角色的性格（重诺/好奇/莽撞/明哲/高傲/仗义/孤僻/狡诈）、灵根、特质、境界体现在言行与战斗方式中。**代词严格按角色性别**：男用「他/他的」，女用「她/她的」，绝不错用（队伍信息中每名成员都标注了性别）。**称呼规则：角色名是一个完整的代号，一体不可拆分——凡称呼角色（含道友/师兄/姑娘/兄台等任何称谓或直接提及）必须使用其完整全名，禁止任何形式的省略、缩写、截取部分字符或昵称化（例如"魔法少女早苗酱"不得写作"早苗酱"或"酱"，"唐三"不得写作"唐"），每次提及都必须写全名；不得依据角色名推断性别、身份、来历或性格等任何信息，这些一律以【队伍】标注为准。**
9. **特质即经历与能力依据**：每名角色的特质是过往经历凝成的能力，**生成剧情时必须在合适时机让特质因果性地发挥作用**——不是偶然提一句，而是"因有某特质→事件随之发生"：如「辨别灵草（初级）」的修士在探索中更容易发现灵草药草、能识别毒草（找到灵草的机会增加）；「灵觉敏锐/听风辨位」者先察觉危险与伏击；「断后英杰」者在队伍遇险时挺身断后；「寻宝直觉/气运缠身」者更易发现暗格秘藏；「百毒不侵」者出入瘴毒之地更有底气。特质未直接相关的场景不必强用，但特质相关的机会要明显增多。
4. 四名队员必须有差异化的表现：依据其性格、功法和法宝分配高光时刻，避免一人独揽。副本会为角色安排连续焦点窗口；同一角色应在窗口内保持叙事焦点，不得无理由切换到其他角色的内心或主视角。每一步都有明确的【本步允许出场】名单与【本步禁止主动出场】名单：默认只写允许出场角色；名单外角色不得主动出现、说话、行动、观察、回头、站立、描写心理或承担镜头收尾。未授权角色只有在其已经发生的物理因果直接影响当前事件时，才可短暂出现，并且必须写出具体作用；不得为了让所有人露脸而添加无功能出场。高光时刻应集中于单一角色，必须形成“特质/技能/装备或性格依据 → 关键选择或行动 → 明确改变局面或带来结果”的完整因果链，不能只写“参与攻击”或被顺带点名。每名角色都应至少获得一次这样的个人高光；高光段中其他角色只作必要的反应或协助，不要抢走焦点。若某角色未出场，不要强行提及。
5. 技能优先：角色的功法/术法是叙事最高优先级——只要本步判定选定了技能（见【本步技能】），就必须围绕它的施展来写：**严格按照技能描述（desc）演绎其效果**（不得发明描述之外的机制），功法偏修炼蓄势、术法偏攻防应变；判定成功则写得势如破竹、灵光迸发，判定失败则如实写施法受挫、灵光未聚。未选中技能时，也可在合适时机自然带出角色的功法术法。
6. 结合副本背景：敌人、场景、战利品必须与副本背景设定一致，敌人与首领的**修为（【此间生灵】/【深处首领】中已标注，如练气三层、筑基初期）要在战斗描写中自然体现**——修为高的敌人出手更沉、威压更强。**战利品类型不限**：武器、防具、丹药、符箓、材料、杂物、功法术法卷轴等皆可，只要与副本故事设定自洽即可（例如古战场可出残兵锈甲与军功之物，药镇废墟可出药炉丹方），不要凭空出现与副本无关的物品。**战利品全程自然分配**：战斗获胜可缴获、探索途中可发现、搜刮时可拾取，各阶段按剧情合理出现，不要集中堆在某一阶段；获得灵石时在正文写明具体数量（如"得了三十块灵石"），数量合理（几十到几百）。**凡本步获得道具，必须在段落最后另起一行输出标记：**【获得：道具名1、道具名2】（只写本步获得的，一次最多两三件；本步没有获得道具就不要输出该标记）。道具名可自由创造（简洁 4~12 字，不得输出 3 字及以下的简称、货币或“无”）。
6b. **道具归属红线**：所有道具以【物品归属】为准，谁持有就是谁的；不得把他人道具写成由非持有人取出、使用、携带或展示。队友使用前必须由原持有人明确写出“借给/递给/交给/暂借”的交接动作，且交接句必须同时出现原持有人、使用者与道具完整名称；借出但未消耗的非消耗道具使用完毕应归还原持有人。道具名必须与【物品归属】完全一致，不得缩写。
7. 成败由你直接判定：本步没有骰子。依据剧情张力、敌人修为、角色状态与叙事因果，自然决定成功或受挫，并让正文明确体现结果（成功则势如破竹，失败则险象环生），不要播报骰子或判定数字。
8. **宗门任务设定**：本次探险是宗门派发的任务——开局阶段必须尽早交代任务由来：由宗门长辈/执事差遣，结合副本背景说明任务目的（如调查异动、寻回失物、清剿妖兽、取回传承等），队伍受命出发；收尾阶段必须描写**回到宗门复命、领取任务报酬**（写明报酬灵石数量），收束故事。
9. **遇险可逃（由 AI 依据剧情判断）**：队伍遇到危险时（战斗失利、敌人过强、首领凶威、身负重伤、灵光将尽等），**由剧情自然决定是否逃跑**——玩家不干预。**当局面已无胜算（判定大失败、多人重伤昏迷、修为被敌人碾压等）时，应写队伍逃跑/撤退的剧情**，逃跑不一定成功——成功则队伍仓皇脱身保住性命但**任务失败**（归途如实写向宗门复命请罪、无报酬或仅少量抚恤）；失败则被追上付出代价（负伤、损失道具、死战到底）。**凡描写逃跑，必须明确写出逃跑的成与败，不得含糊**；逃跑后任务即告失败，最终成败以【深处首领】与归途剧情走向为准。若局面尚有转机，也可选择死战翻盘——成败由最终剧情判定。
10. **突破试炼（练气十层 → 筑基前期）**：当【当前进度】为「突破」阶段（见【突破试炼】标注），说明队伍中有角色修为已至练气十层满（灵机盈满），正面临突破筑基的关隘。**本阶段必须围绕该角色（主角）安排一场突破试炼**：可召唤天劫淬体、心魔问心、道基重铸、斩我明道等（贴合其灵根与修行路数），凶险与机缘并存——**试炼成败由你直接决定**：本步成功则突破成功（灵台清明、道基稳固、踏入筑基）；失败则功亏一篑（气血翻涌、受创，修为仍停留练气十层，待下次再寻机缘）。叙事要写出「临界、冲关、成败」的过程。

阶段仅表示本步主要事件倾向和游戏机制上下文，不是必须照搬到正文的固定章节。探索、交战、发现、追逐、撤退与休整可以自然穿插，对话和线索揭示也可交错或在同一步中融合；以前文因果、当前事件和检定结果为准，避免为了凑阶段而重复或硬转场。没有首领或搜刮事件时，不要强行制造对应桥段。连续焦点第 1~3 步应保持同一角色的叙事焦点，除非事件因果确实要求切换；焦点窗口的最后一步通常是该角色的高光收束，务必写出“依据 → 行动 → 结果”，不要只让角色露脸。动态副本不预先分配探索、战斗、首领、搜刮或归途步数，由你根据已经发生的剧情选择下一方向；正常叙事目标为 10~25 步。第 20 步起进入收束段：停止新增地点、线索、敌人、任务目标或支线，把已经出现的因果转化为解决、失败或撤退；不得为了补足角色高光、轮换焦点或展示更多能力而延长故事。25 步不是强制结束点，确有未决冲突时可以继续，但超过 25 步后的内容只能直接解决已有事项，不得再扩写世界或制造下一层谜团，并应在最多 3 步内完成或明确撤退。任务或遭遇尚未解决时不得跳到搜刮或收尾，首领只有在正文确实解决、击退或逃脱后才能标记为已解决。第 40 步是引擎硬上限，最后两步不得引入新的未闭合主线。**每步不超过 250 字，不设最低字数**——短促有力的句子、寥寥数语的转折同样自然，长度完全随叙事节奏起伏，切忌每段都凑成齐整的长段。你现在只负责其中一步。`;

function buildUserMessage(b) {
  const lines = [];
  const dynamic = b.flowMode === 'dynamic';
  lines.push(`【副本】${b.dungeon}${b.isHidden ? '（隐藏副本，原名 ' + b.baseDungeon + '）' : ''}`);
  if (b.specialEvent) lines.push('【特殊事件】本局触发异象：副本整体凶险更甚（敌人修为更高、机关更险），但机缘亦更丰厚——剧情中应烘托出异象骤生、凶机并现的氛围，战利品与报酬可以更丰。');
  if (b.lore) lines.push(`【背景】${b.lore}`);
  if (b.enemies && b.enemies.length) lines.push(`【此间生灵】${b.enemies.map(e => e.name + '（' + (e.realm || '修为不明') + '）：' + e.desc).join('；')}`);
  if (b.bosses && b.bosses.length) lines.push(`【深处首领】${b.bosses.map(x => x.name + '（' + (x.realm || '修为不明') + '）：' + x.desc).join('；')}`);
  lines.push('【队伍】');
  (b.party || []).forEach(m => {
    const sk = (m.skills || []).map(s => `${s.name}（${s.tier || '黄阶'}·${s.type || '功法'}：${s.desc || '无描述'}）`).join('、') || '无';
    const items = (m.items || []).map(i => `${i.name}（${i.kind || '杂物'}：${i.desc || '无描述'}，持有人：${i.ownerName || m.name || '未知'}）`).join('，') || '无';
    lines.push(`· ${m.name}（${m.gender || '男'}·${m.realm}·${m.root}·性格${m.personality}）｜特质：${(m.traits || []).join('、')}｜功法术法：${sk}｜携带：${items}`);
  });
  if (Array.isArray(b.ownedItems) && b.ownedItems.length) {
    lines.push(`【物品归属】${b.ownedItems.map(item => `${item.name}（${item.ownerName || '未知'}持有）`).join('；')}`);
  }
  if (dynamic) {
    const quest = b.quest || {};
    const encounter = b.encounter || {};
    const preferredMaxSteps = Number(b.preferredMaxSteps == null ? 25 : b.preferredMaxSteps);
    lines.push(`【当前进度】第 ${b.stepNo} 步 · 正常目标为 ${b.minSteps}~${preferredMaxSteps} 步 · 安全边界：最少 ${b.minSteps} 步，最多 ${b.maxSteps} 步 · 当前阶段：${b.phase || b.stage || 'explore'}`);
    lines.push(`【篇幅规则】${preferredMaxSteps} 步是建议长度，不是强制结束点；只有任务、遭遇与已有伏笔均已妥善解决时才可自然收尾。第 ${b.maxSteps} 步为硬上限。`);
    lines.push(`【任务状态】任务状态：${quest.status || 'active'}；目标：${quest.objective || '完成宗门差遣'}`);
    lines.push(`【遭遇状态】遭遇状态：${encounter.status || 'none'}${encounter.name ? '；当前对象：' + encounter.name : ''}`);
    if (b.nextHint) lines.push(`【待续线索】${b.nextHint}`);
    if (b.lastDecision && Object.keys(b.lastDecision).length) lines.push(`【上步决策】${JSON.stringify(b.lastDecision)}`);
    lines.push('【流程决策】不按预设阶段顺序推进，由 AI 自行决定下一叙事方向。phase 只是建议，引擎会拒绝不合法的搜刮或收尾；任务、首领或其他危险未解决时应继续当前冲突、转入休整或明确撤退。encounterStatus 只有在正文确实解决、击退或逃脱当前遭遇后才能写 resolved/escaped。questStatus、encounterStatus 与 continue 只描述本步已经发生或明确决定的状态，不得预告未来结果。');
    lines.push('【道具权限】只能使用本步明确列出的道具。默认仅可使用本步主角自身携带的装备或背包物品；不得擅自使用其他角色的道具，也不得让其他角色持有、取出或展示他人道具。只有正文明确写出原持有人将道具借给/递给/交给/暂借使用者时，才允许队友使用，并必须保持“使用者、原持有人、道具、数量”的对应关系。非消耗道具借出后使用完毕应归还原持有人；丹药、符箓等一次性道具只有正文明确服用、激发或消耗后才扣除。道具名必须与【物品归属】完全一致，不得缩写。');
    if (Array.isArray(b.availableItems) && b.availableItems.length) lines.push(`【本步可用道具】${b.availableItems.map(i => `${i.name}（${i.userName || b.actor || '当前角色'}使用，原持有人：${i.ownerName || i.userName || b.actor || '当前角色'}${i.loaned ? '，已明确借出' : '，自有'}）`).join('；')}`);
    if (Number(b.stepNo) >= Math.max(Number(b.minSteps), preferredMaxSteps - 5) && Number(b.stepNo) <= preferredMaxSteps) lines.push('【收束段】已进入目标区间的收束段。停止新增支线，不得新增地点、线索、敌人、任务目标或更深一层谜团；本步必须推动已有任务或遭遇接近完成。不得为了补足角色高光而延长故事，尚未获得高光的角色可在解决现有冲突时自然贡献，不另开事件。');
    if (Number(b.stepNo) > preferredMaxSteps && Number(b.stepNo) < Number(b.maxSteps) - 1) lines.push(`【超出建议篇幅】已经超过建议的 ${preferredMaxSteps} 步，但不得仅因超过建议长度就结束。现在禁止新增地点、线索、敌人、任务目标或支线；每一步都必须减少至少一项未决事项。优先在本步直接解决当前遭遇，并把任务标记为 completed、failed 或 retreated；若本步确实无法完成，nextHint 只能填写最后一个已有障碍，最多再用 3 步解决或明确撤退，不得继续 explore 或制造后续谜团。`);
    if (Number(b.stepNo) >= Number(b.maxSteps) - 5 && Number(b.stepNo) < Number(b.maxSteps) - 1) lines.push('【紧急收束】距离硬上限不足五步。本步必须让当前遭遇 resolved/escaped，并让任务 completed/failed/retreated；无法合理成功时立即写明确撤退或失败，不得继续保持 active。');
    if (Number(b.stepNo) >= Number(b.maxSteps) - 1) lines.push('【最后两步】已进入最后两步，不得引入新的未闭合主线；必须解决当前冲突或明确撤退，并为合法收尾做好准备。');
  } else {
    lines.push(`【当前进度】第 ${b.stepNo} 步 / 共 ${b.totalSteps} 步 · 叙事倾向：${b.stageLabel || b.stage}（仅供参考，可与相邻事件自然融合）`);
  }
  if (b.focus) lines.push(`【本段叙事焦点】${b.focus.actor || b.actor || '当前角色'}（连续焦点第 ${b.focus.step || 1}/${b.focus.size || 1} 步）${b.focus.highlight ? '；本步为高光收束：必须写出“特质/技能/装备或性格依据 → 关键选择或行动 → 明确改变局面或带来结果”' : '；保持该角色的内心、判断与行动连续，不得无理由切换到其他角色的主视角'}`);
  if (b.allowedCharacters && b.allowedCharacters.length) lines.push(`【本步允许出场】${b.allowedCharacters.join('、')}`);
  if (b.forbiddenCharacters && b.forbiddenCharacters.length) lines.push(`【本步禁止主动出场】${b.forbiddenCharacters.join('、')}`);
  if (b.stage === 'breakthrough' || b.stageLabel === '突破') lines.push('【突破试炼】本步为突破试炼（练气十层 → 筑基前期）：围绕主角安排突破关隘（天劫/心魔/道基重铸等），成败按本步判定（success 见【检定】）自然收束。');
  if (b.actor) lines.push(`【本步主角】${b.actor}${b.support ? '（与 ' + b.support + (b.support2 ? '、' + b.support2 : '') + ' 配合）' : ''}：本步成败、受伤与收获由你依据剧情直接判定，不要模拟骰子。`);
  if (b.enemy) lines.push(`【当前敌人】${b.enemy.name}：${b.enemy.desc || ''}`);
  if (b.actor) {
    const actorInfo = (b.party || []).find(member => member.name === b.actor) || (b.party || [])[0];
    const skillList = (actorInfo && Array.isArray(actorInfo.skills) ? actorInfo.skills : []).map(s => `${s.name}（${s.tier || '黄阶'}·${s.type || '功法'}）`).join('、');
    if (skillList) lines.push(`【本步可用技能】${skillList}`);
  }
  if (b.skillUse) {
    const em = b.skillUse.elemMod || 0;
    const emTxt = em > 0 ? '此技能与施法者灵根同属，施展得心应手、威力增益' : '';
    lines.push(`【本步技能】${b.skillUse.name}（${b.skillUse.type}）：是否使用及成败由你直接判定${emTxt ? '（' + emTxt + '）' : ''}。技能描述：${b.skillUse.desc || '无'}。若使用，本步必须围绕施展此技能展开，严格按描述演绎其效果。`);
  }
  if (b.itemUse) {
    lines.push(`【装备判定】${b.itemUse.name}（${b.itemUse.kind}）${b.itemUse.loaned ? `由${b.itemUse.ownerName || '原持有人'}明确借给${b.itemUse.userName || b.actor || '使用者'}` : `由${b.itemUse.ownerName || b.actor || '使用者'}本人持有`}：是否使用及成败由你直接判定，不使用或失败则正文如实写未能奏效。`);
  }
  if (b.context) lines.push(`【前文衔接】\n${b.context}`);
  if (b.stepNo === 1) lines.push('【开局】这是本次探险的第一步（入谷）：请交代这是宗门派发的任务——由宗门长辈/执事差遣，结合副本背景说明任务目的（调查异动/寻回失物/清剿妖兽等），描写队伍受命出发，营造任务感。');
  if (!dynamic && b.stepNo >= b.totalSteps) lines.push('【收尾】这是本次探险的最后一步（归途）：请描写队伍**回到宗门复命、领取任务报酬**（写明报酬灵石数量），回顾得失，收束故事，留有余韵。');
  if (dynamic) {
    lines.push('\n请严格输出单个 JSON 对象，不要代码围栏或额外文字：');
    lines.push('{"text":"本步正文，不超过250字","outcome":"crit|good|mid|bad|fumble","damage":12,"heal":0,"itemUse":null,"skillUse":null,"loot":[{"name":"道具名","qty":1,"rarity":"common"}],"phase":"opening|explore|encounter|battle|boss|loot|rest|retreat|closing","event":"advance|resolve|fail|retreat","questStatus":"active|completed|failed|retreated","encounterStatus":"none|active|resolved|escaped","nextHint":"下一步应承接的已出现线索，简短填写","continue":true}');
    lines.push('heal 仅用于成功使用恢复类丹药或成功施展治疗技能且正文明确生效的情况，恢复量必须为正整数；否则填 0，且最终气血不会超过上限。');
    lines.push('text 写本步实际发生的剧情；outcome 是这一步的定性结果，damage 是本步对主角实际扣除的气血（无则为 0），damage 是唯一扣血依据，服务端不会根据 bad/fumble 或阶段另行补伤害；正文明确写主角实际受伤时 damage 必须为正整数，若只是闪避、险些命中或敌人受伤则填 0；itemUse/skillUse 只有本步正文中实际使用且可用时才填写，否则为 null；loot 是本步明确获得的道具及数量、稀有度，同时必须在正文末尾写【获得：道具名】；phase 只是建议；控制字段必须与 text 中已经发生的事实一致。只有任务已完成、失败或明确撤退，且当前遭遇不再 active 时，才可建议 phase=closing 并设置 continue=false。');
  } else {
    if (Array.isArray(b.availableItems) && b.availableItems.length) lines.push(`【本步可用道具】${b.availableItems.map(i => `${i.name}（${i.userName || b.actor || '当前角色'}使用，原持有人：${i.ownerName || i.userName || b.actor || '当前角色'}${i.loaned ? '，已明确借出' : '，自有'}）`).join('；')}`);
    lines.push('\n请严格输出单个 JSON 对象，不要代码围栏或额外文字：');
    lines.push('{"text":"本步正文，不超过250字","outcome":"crit|good|mid|bad|fumble","damage":0,"heal":0,"itemUse":null,"skillUse":null,"loot":[]}');
    lines.push('heal 仅用于成功使用恢复类丹药或成功施展治疗技能且正文明确生效的情况，恢复量必须为正整数；否则填 0，且最终气血不会超过上限。');
    lines.push('text 写本步实际发生的剧情；outcome 是这一步的定性结果，damage 是本步对主角实际扣除的气血（无则为 0），damage 是唯一扣血依据，服务端不会根据 bad/fumble 或阶段另行补伤害；正文明确写主角实际受伤时 damage 必须为正整数，若只是闪避、险些命中或敌人受伤则填 0；itemUse/skillUse 只有本步正文中实际使用且可用时才填写，否则为 null；loot 是本步明确获得的道具及数量、稀有度，同时必须在正文末尾写【获得：道具名】。阶段只是叙事倾向，无需把本步写成独立、封闭的固定章节；允许与前后事件自然交错，衔接前文。');
  }
  return lines.join('\n');
}

/* ============================================================
   调用 LLM（OpenAI 兼容 /chat/completions）
   ============================================================ */
function fastRoomLlmResponse(systemPrompt) {
  if (systemPrompt === SETUP_PROMPT) return JSON.stringify({ hidden: false, specialEvent: false, breakthrough: false, enemies: [] });
  if (systemPrompt === SUMMARY_PROMPT) return '众修士稳步穿过险地，勘明路径后平安归返。';
  if (systemPrompt === OUTCOME_PROMPT) return JSON.stringify({ ok: true, reason: '队伍完成探索并安全返回', statBuffs: [], traits: [], injury: null, scroll: null });
  if (systemPrompt === EXTRACT_LOOT_PROMPT || systemPrompt === LEARNED_SKILL_PROMPT) return '[]';
  if (systemPrompt === DEATH_SUMMARY_PROMPT) return JSON.stringify({ overall: '', roles: [] });
  return null;
}

async function callLLM(userMsg, systemPrompt = SYSTEM_PROMPT, maxLength = 300) {
  if (!runtimeAiState.enabled) {
    const error = new Error('AI 服务当前已停用');
    error.code = 'ai_disabled';
    throw error;
  }
  if (process.env.ROOM_FAST === '1') {
    const fastResponse = fastRoomLlmResponse(systemPrompt);
    if (fastResponse !== null) return fastResponse;
  }
  if (!isConfigured) {
    const error = new Error('AI 未配置：请设置 AI_BASE_URL、AI_API_KEY、AI_MODEL 环境变量');
    error.aiFailure = true;
    error.code = 'ai_unconfigured';
    throw error;
  }
  const url = CONFIG.baseURL.replace(/\/+$/, '') + '/chat/completions';
  let lastErr = null;
  // 失败自动重试：空内容错误（推理模型思考过长截断）最多试 4 次，其他错误最多试 2 次
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + CONFIG.apiKey,
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
          ],
          temperature: CONFIG.temperature ?? 0.85,
          max_tokens: CONFIG.maxTokens ?? 5000,
          stream: false,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error && (j.error.message || j.error)) || `HTTP ${r.status}`;
        const error = new Error(String(msg).slice(0, 300));
        error.status = r.status;
        error.aiFailure = true;
        throw error;
      }
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (!text) throw new Error('AI 返回空内容（思考过长被截断，重试中）');
      if (text.includes('�')) throw new Error('AI 返回乱码（重试中）');
      // 字数控制：单步截断至 300 字（保留完整句子）
      if (maxLength && text.length > maxLength) {
        const cut = text.slice(0, maxLength);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        return lastDot > 100 ? cut.slice(0, lastDot + 1) : cut;
      }
      return text;
    } catch (e) {
      lastErr = e;
      const isEmpty = /空内容/.test(String(e.message || e));
      if (!isEmpty && attempt >= 1) break;  // 非空内容错误最多试 2 次
      console.warn(`[ai] 第 ${attempt + 1} 次调用失败：${e.name === 'AbortError' ? '超时(240s)' : String(e.message || e).slice(0, 160)}`);
      await new Promise(r => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  const failure = lastErr || new Error('AI 服务调用失败');
  failure.aiFailure = true;
  throw failure;
}

function scheduleTaixuInsightJob(job) {
  taixuInsightJobs.set(job.id, job);
  const timer = setTimeout(() => taixuInsightJobs.delete(job.id), TAIXU_JOB_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void runTaixuInsightJob(job);
}

function scheduleTaixuInsightFinalization(job) {
  const state = job && job.endsAt ? job : null;
  if (!state || job.finalizeScheduled) return;
  job.finalizeScheduled = true;
  const delay = Math.max(0, Number(state.endsAt) - Date.now());
  const timer = setTimeout(() => finalizeTaixuInsightJob(job), delay + 25);
  if (typeof timer.unref === 'function') timer.unref();
}

function finalizeTaixuInsightJob(job, now = Date.now()) {
  if (!job || job.finalizing) return null;
  job.finalizing = true;
  try {
    const current = DB.getCharacter(job.userId, job.charId);
    if (!current) return null;
    const role = current.data;
    const state = role.taixuInsight;
    if (!state || state.jobId !== job.id) return null;
    if (Number(state.endsAt) > now) return { status: 'pending', remainingMs: Number(state.endsAt) - now };

    if (state.phase !== 'ready' || !state.skill) {
      role.status = 'resting';
      delete role.taixuInsight;
      role.taixuInsightNotice = { jobId: job.id, ok: false, error: '太虚幻境参悟未能在一小时内完成', completedAt: now };
      const saved = DB.saveCharacterIfCurrent(job.userId, job.charId, current.updated_at, role, role.name);
      if (!saved) return null;
      notifyCharacterUpdated(job.userId, job.charId, saved.updated_at);
      job.status = 'failed';
      job.finished_at = now;
      job.error = '太虚幻境参悟未能在一小时内完成';
      return { status: 'failed', error: job.error };
    }

    role.skills = Array.isArray(role.skills) ? role.skills : [];
    role.skillPool = Array.isArray(role.skillPool) ? role.skillPool : [];
    const storage = role.skills.length < GE.MAX_SKILLS ? 'equipped' : 'pool';
    (storage === 'equipped' ? role.skills : role.skillPool).push(state.skill);
    role.taixuInsightAt = now;
    role.status = 'resting';
    role.taixuInsightNotice = { jobId: job.id, ok: true, skill: state.skill, storage, completedAt: now };
    delete role.taixuInsight;
    const saved = DB.saveCharacterIfCurrent(job.userId, job.charId, current.updated_at, role, role.name);
    if (!saved) return null;
    notifyCharacterUpdated(job.userId, job.charId, saved.updated_at);
    job.status = 'completed';
    job.finished_at = now;
    job.result = { ok: true, skill: state.skill, storage, character: role, updated_at: saved.updated_at, cost: TI.TAIXU_INSIGHT_COST };
    return { status: 'completed', result: job.result };
  } finally {
    job.finalizing = false;
  }
}

async function runTaixuInsightJob(job) {
  job.status = 'running';
  job.started_at = Date.now();
  try {
    let role = JSON.parse(JSON.stringify(job.roleSnapshot || {}));
    role.skills = Array.isArray(role.skills) ? role.skills : [];
    role.skillPool = Array.isArray(role.skillPool) ? role.skillPool : [];
    const knownNames = new Set([...role.skills, ...role.skillPool].map(entry => entry && entry.name).filter(Boolean));
    let skill = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !skill; attempt++) {
      try {
        const prompt = TI.buildTaixuInsightPrompt(role, job.type, job.goal);
        const retryNote = attempt && lastError ? `\n前次结果无效：${String(lastError.message || lastError).slice(0, 80)}。请重新生成不同名称。` : '';
        const raw = await callLLM(prompt + retryNote, TI.TAIXU_INSIGHT_SYSTEM_PROMPT, 1200);
        skill = TI.parseTaixuInsight(raw, job.type, knownNames);
      } catch (error) {
        lastError = error;
      }
    }
    if (!skill) throw new Error('太虚幻境未能参悟出可用能力，请稍后重试');

    // AI 生成期间只暂存结果；角色必须等满一小时参悟时间后才能获得技能。
    const latestCharacter = DB.getCharacter(job.userId, job.charId);
    if (!latestCharacter) throw new Error('角色不存在');
    role = latestCharacter.data;
    const state = role.taixuInsight;
    if (!state || state.jobId !== job.id || role.status !== 'insighting') throw new Error('太虚幻境参悟任务已失效');
    const latestKnownNames = new Set([...(role.skills || []), ...(role.skillPool || [])].map(entry => entry && entry.name).filter(Boolean));
    if (latestKnownNames.has(skill.name)) throw new Error('角色数据已更新，请重试');
    state.phase = 'ready';
    state.skill = skill;
    state.readyAt = Date.now();
    const saved = DB.saveCharacterIfCurrent(job.userId, job.charId, latestCharacter.updated_at, role, role.name);
    if (!saved) throw new Error('角色数据已更新，请重试');
    notifyCharacterUpdated(job.userId, job.charId, saved.updated_at);
    job.status = 'ready';
    job.endsAt = state.endsAt;
    job.result = { skill, endsAt: state.endsAt };
    scheduleTaixuInsightFinalization(job);
    if (Date.now() >= Number(state.endsAt)) finalizeTaixuInsightJob(job);
  } catch (error) {
    job.status = 'failed';
    job.finished_at = Date.now();
    job.error = String(error && error.message || error || '太虚幻境参悟失败').slice(0, 200);
    const current = DB.getCharacter(job.userId, job.charId);
    if (current && current.data.taixuInsight && current.data.taixuInsight.jobId === job.id) {
      current.data.status = 'resting';
      delete current.data.taixuInsight;
      current.data.taixuInsightNotice = { jobId: job.id, ok: false, error: job.error, completedAt: Date.now() };
      const saved = DB.saveCharacterIfCurrent(job.userId, job.charId, current.updated_at, current.data, current.data.name);
      if (saved) notifyCharacterUpdated(job.userId, job.charId, saved.updated_at);
    }
    console.warn('[taixu-insight]', job.error);
  }
}

function recoverAllTaixuInsights() {
  const now = Date.now();
  for (const character of DB.getAllCharacters()) {
    const state = character.data && character.data.taixuInsight;
    if (!state || !state.jobId) continue;
    let job = taixuInsightJobs.get(state.jobId);
    if (!job) {
      job = { id: state.jobId, userId: character.user_id, charId: character.id, roleSnapshot: character.data, type: state.type, goal: state.goal, endsAt: state.endsAt, status: state.phase || 'running' };
      if (state.phase === 'running') scheduleTaixuInsightJob(job);
      else taixuInsightJobs.set(job.id, job);
    }
    job.endsAt = state.endsAt;
    if (Number(state.endsAt) <= now) finalizeTaixuInsightJob(job, now);
    else if (state.phase === 'ready') scheduleTaixuInsightFinalization(job);
  }
}

async function generateForgeResult(materials) {
  const mats = (materials || []).slice(0, 3).map(m => `${m.name}（${m.kind || '杂物'}·品质${({ common: '普通', rare: '稀有', epic: '珍贵', legendary: '传说' })[normalizeForgeRarity(m.rarity)] || '普通'}：${m.desc || '无描述'}）`).join('、');
  if (!mats) throw new Error('材料为空');
  let parsed = null;
  let parseError = null;
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    try {
      const raw = await callLLM('投入材料：' + mats + '\n请判断合理性并炼器。', FORGE_PROMPT, 1200);
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      parsed = JSON.parse(jsonStr);
    } catch (e) { parseError = e; }
  }
  if (!parsed) throw new Error('AI 返回格式异常，请稍后重试');
  if (typeof parsed.success !== 'boolean') throw new Error('AI 未返回可用的成败判定');
  const process = String(parsed.process || '炼器大师引火熔合两件材料，灵力交织后塑成一件新的法器。').slice(0, 100);
  if (parsed.success) {
    if (!parsed.item || !parsed.item.name) throw new Error('AI 未返回可用的法器');
    const it = parsed.item;
    const highestRarity = (materials || []).reduce((best, material) => {
      const rarity = normalizeForgeRarity(material.rarity);
      return FORGE_RARITIES.indexOf(rarity) > FORGE_RARITIES.indexOf(best) ? rarity : best;
    }, 'common');
    const rarity = forgeRarityUpgrade(highestRarity);
    const itemName = String(it.name || '').replace(/ +/g, '').trim() || '新炼法器';
    const itemDesc = String(it.desc || '新炼成的法器').replace(/ +/g, '').trim() || '两件材料融合炼成的法器。';
    return { ok: true, process, item: { name: itemName.slice(0, 12), desc: itemDesc.slice(0, 200), kind: ['武器', '防具', '法宝', '工具'].includes(it.kind) ? it.kind : '法宝', rarity: normalizeForgeRarity(it.rarity || rarity) } };
  }
  return { ok: false, process, reason: String(parsed.reason || '两件材料属性冲突，灵力无法相融，炉火失衡未能成器').replace(/ +/g, '').slice(0, 100), item: { name: '未定型法器', desc: '材料冲突，炼制失败，未形成可用法器。', kind: '法宝', rarity: 'common' } };
}

async function runForgeJob(job) {
  job.status = 'running';
  job.started_at = Date.now();
  try {
    const generated = await generateForgeResult(job.materials);
    const character = DB.getCharacter(job.userId, job.charId);
    if (!character) throw new Error('角色不存在');
    settlePassiveRecovery(character.data);
    if (Number(character.data.stamina || 0) < FORGE_STAMINA_COST) throw new Error('精力不足（需 ≥ 20）');
    const role = character.data;
    const consumed = [];
    const materialEntries = [];
    for (const material of job.materials) {
      const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
      const found = list.find(entry => entry && entry.name === material.name && Number(entry.qty || 1) > 0);
      if (!found) throw new Error(`材料不存在：${String(material.name || '')}`);
      consumed.push(found.name);
      materialEntries.push({ entry: found, submitted: material });
    }
    if (!Array.isArray(role.bag)) role.bag = [];
    const existingOutput = role.bag.find(entry => entry && entry.name === String(generated.item.name).slice(0, 24));
    if (generated.ok && !existingOutput && role.bag.length >= 100) throw new Error('储物袋已满，无法收纳炼器产物');
    role.stamina = Math.max(0, Number(role.stamina || 0) - FORGE_STAMINA_COST);
    const lost = [];
    if (!generated.ok) {
      job.materials.forEach(material => {
        if (Math.random() < 0.5) {
          const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
          const found = list.find(entry => entry && entry.name === material.name);
          if (found) { found.qty = (found.qty || 1) - 1; if (found.qty <= 0) list.splice(list.indexOf(found), 1); lost.push(material.name); }
        }
      });
    } else {
      job.materials.forEach(material => {
        const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
        const found = list.find(entry => entry && entry.name === material.name);
        if (found) { found.qty = (found.qty || 1) - 1; if (found.qty <= 0) list.splice(list.indexOf(found), 1); }
      });
      const item = { name: String(generated.item.name).slice(0, 24), desc: String(generated.item.desc || '新炼成的法器').slice(0, 200), kind: generated.item.kind, qty: 1, rarity: normalizeForgeRarity(generated.item.rarity) };
      const existing = role.bag.find(entry => entry && entry.name === item.name);
      if (existing) { existing.qty = (existing.qty || 1) + 1; existing.desc = item.desc; existing.kind = item.kind; existing.rarity = item.rarity; }
      else role.bag.push(item);
      generated.item = item;
    }
    const saved = DB.saveCharacterIfCurrent(job.userId, job.charId, character.updated_at, role, role.name);
    if (!saved) throw new Error('角色数据已更新，请重试');
    notifyCharacterUpdated(job.userId, job.charId, saved.updated_at);
    job.status = 'completed';
    job.finished_at = Date.now();
    job.result = { ...generated, character: role, updated_at: saved.updated_at, consumed, lost };
  } catch (error) {
    job.status = 'failed';
    job.finished_at = Date.now();
    job.error = String(error && error.message || error || '炼器失败').slice(0, 200);
    console.warn('[forge-job]', job.error);
  }
}

function scheduleForgeJob(job) {
  forgeJobs.set(job.id, job);
  const timer = setTimeout(() => forgeJobs.delete(job.id), FORGE_JOB_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  void runForgeJob(job);
}

/* ============================================================
   HTTP 服务
   ============================================================ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > 2e6) {
        tooLarge = true;
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
  if (typeof res._releaseAi === 'function') res._releaseAi();
}

async function readAdminBody(req) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!isPlainObject(body)) throw new AdminInputError('请求 JSON 无效');
    return body;
  } catch (error) {
    if (error instanceof AdminInputError) throw error;
    throw new AdminInputError('请求 JSON 无效');
  }
}

async function handleAdminAPI(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const urlPath = requestUrl.pathname;

  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    if (!adminConfigured()) {
      sendJSON(res, 401, { error: '无管理员权限' });
      return;
    }
    const body = await readAdminBody(req);
    if (!adminPasswordMatches(body.password)) {
      sendJSON(res, 401, { error: '无管理员权限' });
      return;
    }
    const token = DB.createAdminSession(newToken());
    sendJSON(res, 200, { token });
    return;
  }

  if (!requireAdmin(req, res)) return;

  if (req.method === 'POST' && urlPath === '/api/admin/logout') {
    DB.deleteAdminSession(bearerToken(req));
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/admin/players') {
    sendJSON(res, 200, { players: DB.searchPlayers(requestUrl.searchParams.get('q') || '') });
    return;
  }

  const characterMatch = urlPath.match(/^\/api\/admin\/characters\/(\d+)(\/delete)?$/);
  if (characterMatch) {
    const characterId = Number(characterMatch[1]);
    const existing = DB.getCharacterAdmin(characterId);
    if (!existing) {
      sendJSON(res, 404, { error: '角色不存在' });
      return;
    }

    if (req.method === 'GET') {
      sendJSON(res, 200, { character: existing });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readAdminBody(req);
      if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) {
        throw new AdminInputError('角色版本无效');
      }
      const nextData = sanitizeAdminCharacter(body.character, existing.data);
      const saved = DB.saveCharacterAdminWithAudit(characterId, body.updated_at, nextData);
      if (saved.status === 'not_found') {
        sendJSON(res, 404, { error: '角色不存在' });
        return;
      }
      if (saved.status === 'conflict') {
        sendJSON(res, 409, { error: '角色已被其他操作更新' });
        return;
      }
      notifyCharacterUpdated(saved.character.userId, saved.character.id, saved.character.updated_at);
      sendJSON(res, 200, { ok: true, character: saved.character });
      return;
    }

    if (req.method === 'DELETE' || (req.method === 'POST' && characterMatch[2] === '/delete')) {
      const deleted = DB.deleteCharacter(characterId);
      if (!deleted) {
        sendJSON(res, 404, { error: '角色不存在' });
        return;
      }
      notifyCharacterUpdated(deleted.userId, characterId, null);
      sendJSON(res, 200, { ok: true, characterId });
      return;
    }

    sendJSON(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/admin/audit') {
    const rawCharacterId = requestUrl.searchParams.get('characterId') || '';
    if (!/^\d+$/.test(rawCharacterId)) throw new AdminInputError('角色编号无效');
    const characterId = Number(rawCharacterId);
    if (!DB.getCharacterAdmin(characterId)) {
      sendJSON(res, 404, { error: '角色不存在' });
      return;
    }
    sendJSON(res, 200, { logs: DB.getAdminAuditLogs(characterId) });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/admin/ai-companions') {
    sendJSON(res, 200, { cards: DB.listAiCompanionCards() });
    return;
  }

  const companionMatch = urlPath.match(/^\/api\/admin\/ai-companions\/([^/]+)(\/reset)?$/);
  if (companionMatch) {
    const cardKey = decodeURIComponent(companionMatch[1]);
    const existing = DB.getAiCompanionCard(cardKey);
    if (!existing) {
      sendJSON(res, 404, { error: '名片不存在' });
      return;
    }

    if (req.method === 'GET') {
      sendJSON(res, 200, { card: existing });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readAdminBody(req);
      if (!isPlainObject(body.card)) throw new AdminInputError('缺少名片数据');
      const nextData = sanitizeAdminCompanion(body.card, existing.data);
      const saved = DB.saveAiCompanionCard(cardKey, nextData);
      if (!saved) {
        sendJSON(res, 404, { error: '名片不存在' });
        return;
      }
      notifyAiCompanionsUpdated();
      sendJSON(res, 200, { ok: true, card: saved });
      return;
    }

    if (req.method === 'POST' && companionMatch[2] === '/reset') {
      const reset = DB.resetAiCompanionCard(cardKey);
      if (!reset) {
        sendJSON(res, 404, { error: '名片不存在' });
        return;
      }
      notifyAiCompanionsUpdated();
      sendJSON(res, 200, { ok: true, card: reset });
      return;
    }

    sendJSON(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  sendJSON(res, 404, { error: '未知 API 路径' });
}

function serveStatic(res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/online' || p === '/login' || p === '/login.html') p = '/index.html';
  p = path.posix.normalize('/' + p.replace(/^\/+/, ''));
  const adminPaths = new Set(['/admin', '/admin.html', '/admin.css', '/admin.js']);
  if (adminPaths.has(p) && !adminConfigured()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  if (p === '/admin') p = '/admin.html';
  const publicAssets = new Set(['/index.html', '/style.css', '/data.js', '/online.js', '/game-engine.js', '/game-create.js', '/taixu-insight.js', '/ai-companions.js', '/loot-settlement.js', '/site-nav.js']);
  if (!publicAssets.has(p) && !adminPaths.has(p)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const file = path.resolve(ROOT, '.' + p);
  // 防目录穿越
  if (path.relative(ROOT, file).startsWith('..' + path.sep) || path.isAbsolute(path.relative(ROOT, file))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handleAuthAPI(req, res, urlPath) {
  // 返回 true 表示已处理（外层据此停止后续路由），false 表示未命中
  // ---------- 注册 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/register') {
    const body = JSON.parse(await readBody(req));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const nickname = String(body.nickname || '').trim().slice(0, 10);
    if (!authIpLimiter.check('register:' + clientAddress(req)).allowed) { sendJSON(res, 429, { error: '注册请求过于频繁，请稍后重试' }); return true; }
    if (username.length < 3 || username.length > 32) { sendJSON(res, 400, { error: '用户名需 3~32 字符' }); return true; }
    if (!/^[A-Za-z0-9_]+$/.test(username)) { sendJSON(res, 400, { error: '用户名仅限字母、数字、下划线' }); return true; }
    if (password.length < 6 || password.length > 64) { sendJSON(res, 400, { error: '密码需至少 6 位' }); return true; }
    if (DB.findUserByUsername(username) || DB.mirrorHasUsername(username)) { sendJSON(res, 409, { error: '用户名已存在' }); return true; }
    const salt = makeSalt();
    const uid = DB.createUser(username, hashPassword(password, salt), salt, nickname);
    const token = DB.createSession(uid, newToken());
    sendJSON(res, 200, { token, user: { id: uid, username, nickname } });
    return true;
  }
  // ---------- 登录 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/login') {
    const body = JSON.parse(await readBody(req));
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const loginKey = clientAddress(req);
    const loginIpOk = authIpLimiter.check('login:' + loginKey).allowed;
    const loginUserOk = loginUserLimiter.check('login:' + loginKey + ':' + username.toLowerCase()).allowed;
    if (!loginIpOk || !loginUserOk) { sendJSON(res, 429, { error: '登录尝试过于频繁，请稍后重试' }); return true; }
    let u = DB.findUserByUsername(username);
    if (!u || !hashEquals(hashPassword(password, u.salt), u.pass_hash)) {
      // 本地没有、或密码对不上：查镜像库（另一个游戏）。匹配则补建/同步本地账号，
      // 这样注册一次两边都能登录，改密码也能双向传播。角色数据仍各自独立。
      const mirror = DB.mirrorFindUser(username);
      if (mirror && hashEquals(hashPassword(password, mirror.salt), mirror.pass_hash)) {
        if (u) {
          DB.updateUserCredentials(u.id, mirror.pass_hash, mirror.salt);
          u = { ...u, pass_hash: mirror.pass_hash, salt: mirror.salt };
        } else {
          const uid = DB.createUser(username, mirror.pass_hash, mirror.salt, String(mirror.nickname || '').slice(0, 10));
          u = DB.findUserById(uid);
        }
      }
    }
    if (!u || !hashEquals(hashPassword(password, u.salt), u.pass_hash)) { sendJSON(res, 401, { error: '用户名或密码错误' }); return true; }
    const token = DB.createSession(u.id, newToken());
    sendJSON(res, 200, { token, user: { id: u.id, username: u.username, nickname: u.nickname || '' } });
    return true;
  }
  // ---------- 登出 ----------
  if (req.method === 'POST' && urlPath === '/api/auth/logout') {
    DB.deleteSession(bearerToken(req));
    sendJSON(res, 200, { ok: true });
    return true;
  }
  // ---------- 验证网关 token ----------
  if (req.method === 'POST' && urlPath === '/api/auth/verify-gateway-token') {
    try {
      const body = JSON.parse(await readBody(req));
      const gatewayToken = String(body.token || '').trim();

      if (!gatewayToken) {
        sendJSON(res, 400, { error: '缺少 token' });
        return true;
      }

      // 验证网关签发的 JWT token
      const secret = process.env.GATEWAY_AUTH_SECRET || '';
      if (!secret || secret.length < 32) {
        console.error('[auth] GATEWAY_AUTH_SECRET 未配置或长度不足');
        sendJSON(res, 500, { error: '服务器配置错误' });
        return true;
      }

      // 简易 JWT 验证
      const parts = gatewayToken.split('.');
      if (parts.length !== 3) {
        sendJSON(res, 401, { error: 'token 格式错误' });
        return true;
      }

      const [header, body64, signature] = parts;
      const expectedSig = crypto.createHmac('sha256', secret)
        .update(`${header}.${body64}`)
        .digest('base64url');

      // 常量时间比较签名
      const sigBufA = Buffer.from(signature, 'utf8');
      const sigBufB = Buffer.from(expectedSig, 'utf8');
      if (sigBufA.length !== sigBufB.length || !crypto.timingSafeEqual(sigBufA, sigBufB)) {
        sendJSON(res, 401, { error: 'token 签名无效' });
        return true;
      }

      const payload = JSON.parse(Buffer.from(body64, 'base64url').toString('utf8'));

      // 检查过期时间
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        sendJSON(res, 401, { error: 'token 已过期' });
        return true;
      }

      // 检查类型
      if (payload.type !== 'gateway_auth') {
        sendJSON(res, 401, { error: 'token 类型错误' });
        return true;
      }

      const username = String(payload.username || '').trim();
      if (!username) {
        sendJSON(res, 401, { error: 'token 数据无效' });
        return true;
      }

      // 查找或创建本地账号
      let u = DB.findUserByUsername(username);

      if (!u) {
        // 检查镜像库
        const mirror = DB.mirrorFindUser(username);
        if (mirror) {
          // 从镜像库同步账号
          const uid = DB.createUser(username, mirror.pass_hash, mirror.salt, String(mirror.nickname || '').slice(0, 10));
          u = DB.findUserById(uid);
        }
      }

      if (!u) {
        sendJSON(res, 404, { error: '账号不存在' });
        return true;
      }

      // 签发游戏专属 session token
      const sessionToken = DB.createSession(u.id, newToken());

      sendJSON(res, 200, {
        token: sessionToken,
        user: {
          id: u.id,
          username: u.username,
          nickname: u.nickname || ''
        }
      });
      return true;
    } catch (error) {
      console.error('[auth] 验证网关 token 失败:', error);
      sendJSON(res, 500, { error: '服务器错误' });
      return true;
    }
  }
  // ---------- 当前用户 ----------
  if (req.method === 'GET' && urlPath === '/api/me') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const chars = DB.getCharacters(u.id).map(c => ({ id: c.id, name: c.name, updated_at: c.updated_at }));
    sendJSON(res, 200, { user: { id: u.id, username: u.username, nickname: u.nickname || '' }, characters: chars });
    return true;
  }
  // ---------- 房间列表（HTTP） ----------
  if (req.method === 'GET' && urlPath === '/api/rooms') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    sendJSON(res, 200, { rooms: waitingRoomsPublic() });
    return true;
  }
  // ---------- 创建表单数据 ----------
  if (req.method === 'GET' && urlPath === '/api/creation') {
    sendJSON(res, 200, { data: GC.creationData() });
    return true;
  }
  // ---------- 角色：按表单服务端生成创建 ----------
  if (req.method === 'POST' && urlPath === '/api/character/create') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 12) { sendJSON(res, 400, { error: '角色名需 1~12 字' }); return true; }
    if (DB.characterNameExists(name)) { sendJSON(res, 409, { error: '角色名重复' }); return true; }
    const requestId = String(body.creation_request_id || '').trim();
    if (!requestId) { sendJSON(res, 400, { error: '缺少创建请求编号' }); return true; }
    if (DB.getCharacters(u.id).length >= 6) { sendJSON(res, 400, { error: '角色数量已达上限（6）' }); return true; }
    const char = GC.createCharacterObject({
      name, rootKey: body.root, gender: body.gender, pers: body.pers,
      itemKeys: Array.isArray(body.items) ? body.items : [],
    });
    const result = DB.createCharacterIdempotent(u.id, requestId, char.name, char);
    if (result.status === 'invalid_request_id') { sendJSON(res, 400, { error: '创建请求编号无效' }); return true; }
    if (result.status === 'existing') {
      const existing = DB.getCharacter(u.id, result.id);
      sendJSON(res, 200, { id: existing.id, character: existing.data, duplicate: true });
      return true;
    }
    sendJSON(res, 200, { id: result.id, character: char });
    return true;
  }
  // ---------- 通用角色：创建/读取/保存 ----------
  if (req.method === 'POST' && urlPath === '/api/character') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    const data = body.character || null;
    if (!data || !data.name) { sendJSON(res, 400, { error: '缺少角色数据' }); return true; }
    if (DB.characterNameExists(data.name)) { sendJSON(res, 409, { error: '角色名重复' }); return true; }
    if (DB.getCharacters(u.id).length >= 6) { sendJSON(res, 400, { error: '角色数量已达上限（6）' }); return true; }
    const id = DB.createCharacter(u.id, data.name, data);
    sendJSON(res, 200, { id, character: data });
    return true;
  }
  const playerCharacterMatch = urlPath.match(/^\/api\/character\/(\d+)(\/delete)?$/);
  if (playerCharacterMatch && (req.method === 'DELETE' || (req.method === 'POST' && playerCharacterMatch[2] === '/delete'))) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const characterId = Number(playerCharacterMatch[1]);
    const existing = DB.getCharacter(u.id, characterId);
    if (!existing) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    const busy = characterBusyReason(existing.data);
    if (busy) { sendJSON(res, 409, { error: busy, code: 'character_busy' }); return true; }
    const deleted = DB.deleteCharacter(characterId);
    notifyCharacterUpdated(u.id, characterId, null);
    sendJSON(res, 200, { ok: true, characterId: deleted.id });
    return true;
  }
  const cultivationMatch = urlPath.match(/^\/api\/character\/(\d+)\/(cultivation\/start|cultivation\/exit|breakthrough\/start)$/);
  if (cultivationMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(cultivationMatch[1]);
    const action = cultivationMatch[2];
    const body = JSON.parse(await readBody(req));
    if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) {
      sendJSON(res, 400, { error: '角色版本无效' }); return true;
    }
    const character = DB.getCharacter(u.id, charId);
    if (!character) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    settlePassiveRecovery(character.data);
    const settled = settleCultivation(character.data);
    let expected = character.updated_at;
    if (settled.changed) {
      const saved = DB.saveCharacterIfCurrent(u.id, charId, expected, character.data, character.data.name);
      if (!saved) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
      expected = saved.updated_at;
      character.updated_at = expected;
      notifyCharacterUpdated(u.id, charId, expected);
    }
    if (body.updated_at !== expected) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    const now = Date.now();
    let event = null;
    if (action === 'cultivation/start') {
      const hours = Number(body.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) { sendJSON(res, 400, { error: '修炼时长需为 1 至 24 整小时' }); return true; }
      const blocked = cultivationStartBlocked(character.data);
      if (blocked) { sendJSON(res, 400, { error: blocked }); return true; }
      const cost = hours * 100;
      if (Number(character.data.gold || 0) < cost) { sendJSON(res, 400, { error: '灵石不足' }); return true; }
      character.data.gold -= cost;
      character.data.status = 'cultivating';
      character.data.cultivation = { mode: 'cultivate', startedAt: now, endsAt: now + hours * CULTIVATION_HOUR_MS, lastSettledAt: now, spentGold: cost };
      event = { type: 'cultivation_started', hours, cost };
    } else if (action === 'cultivation/exit') {
      if (!character.data.cultivation || character.data.cultivation.mode !== 'cultivate') { sendJSON(res, 400, { error: '当前未在闭关修炼' }); return true; }
      const exitResult = settleCultivation(character.data, now);
      delete character.data.cultivation;
      character.data.status = 'resting';
      event = { type: 'cultivation_exited', expAwarded: exitResult.event ? exitResult.event.expAwarded : 0 };
    } else {
      const blocked = cultivationStartBlocked(character.data);
      if (blocked) { sendJSON(res, 400, { error: blocked }); return true; }
      if (!GE.canBreakthrough(character.data)) { sendJSON(res, 400, { error: '需达到练气十层圆满（2000 经验）' }); return true; }
      character.data.status = 'breaking_through';
      character.data.cultivation = { mode: 'breakthrough', startedAt: now, endsAt: now + BREAKTHROUGH_DURATION_MS, lastSettledAt: now, spentGold: 0 };
      event = { type: 'breakthrough_started', chance: Math.min(1, 0.5 + Number(character.data.breakthroughBonus || 0)) };
    }
    const saved = DB.saveCharacterIfCurrent(u.id, charId, expected, character.data, character.data.name);
    if (!saved) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    notifyCharacterUpdated(u.id, charId, saved.updated_at);
    sendJSON(res, 200, { character: character.data, updated_at: saved.updated_at, event });
    return true;
  }
  const taixuInsightJobMatch = urlPath.match(/^\/api\/character\/(\d+)\/taixu-insight\/([A-Za-z0-9-]+)$/);
  if (taixuInsightJobMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(taixuInsightJobMatch[1]);
    let job = taixuInsightJobs.get(taixuInsightJobMatch[2]);
    if (!job) {
      const character = DB.getCharacter(u.id, charId);
      const state = character && character.data && character.data.taixuInsight;
      const notice = character && character.data && character.data.taixuInsightNotice;
      if (notice && notice.jobId === taixuInsightJobMatch[2] && notice.ok) {
        sendJSON(res, 200, { ...notice, status: 'completed', jobId: notice.jobId, character: character.data, updated_at: character.updated_at });
        return true;
      }
      if (state && state.jobId === taixuInsightJobMatch[2]) {
        job = { id: state.jobId, userId: u.id, charId, endsAt: state.endsAt, status: state.phase || 'running' };
        taixuInsightJobs.set(job.id, job);
      }
    }
    if (!job || job.userId !== u.id || job.charId !== charId) { sendJSON(res, 404, { error: '参悟任务不存在或已过期' }); return true; }
    if (job.status === 'ready') {
      const character = DB.getCharacter(u.id, charId);
      const state = character && character.data && character.data.taixuInsight;
      if (state && Number(state.endsAt) <= Date.now()) finalizeTaixuInsightJob(job);
    }
    if (job.status === 'completed') {
      sendJSON(res, 200, { ...job.result, status: 'completed', jobId: job.id });
    } else if (job.status === 'failed') {
      sendJSON(res, 200, { ok: false, status: 'failed', jobId: job.id, error: job.error || '太虚幻境参悟失败' });
    } else {
      const character = DB.getCharacter(u.id, charId);
      const state = character && character.data && character.data.taixuInsight;
      sendJSON(res, 200, { ok: true, status: job.status, phase: state && state.phase || job.status, jobId: job.id, endsAt: state && state.endsAt || job.endsAt, remainingMs: state ? Math.max(0, Number(state.endsAt) - Date.now()) : 0 });
    }
    return true;
  }
  const taixuInsightMatch = urlPath.match(/^\/api\/character\/(\d+)\/taixu-insight$/);
  if (taixuInsightMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(taixuInsightMatch[1]);
    const body = JSON.parse(await readBody(req));
    if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) { sendJSON(res, 400, { error: '角色版本无效' }); return true; }
    const type = String(body.type || '').trim();
    const goal = String(body.goal || '').trim();
    if (!TI.VALID_TYPES.has(type)) { sendJSON(res, 400, { error: '参悟类型只能是功法或术法' }); return true; }
    if (!goal || goal.length > 100) { sendJSON(res, 400, { error: '期望目标需为 1 至 100 字' }); return true; }
    const character = DB.getCharacter(u.id, charId);
    if (!character) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    settlePassiveRecovery(character.data);
    if (character.updated_at !== body.updated_at) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    const role = character.data;
    const busy = characterBusyReason(role);
    if (busy) { sendJSON(res, 409, { error: busy, code: 'character_busy' }); return true; }
    role.skills = Array.isArray(role.skills) ? role.skills : [];
    role.skillPool = Array.isArray(role.skillPool) ? role.skillPool : [];
    const access = TI.validateTaixuInsightAccess(role, Date.now());
    if (!access.ok) { sendJSON(res, 400, { error: access.error, remainingMs: access.remainingMs }); return true; }
    const now = Date.now();
    const jobId = crypto.randomUUID();
    role.status = 'insighting';
    role.taixuInsight = { jobId, type, goal, startedAt: now, endsAt: now + TAIXU_INSIGHT_DURATION_MS, phase: 'running' };
    delete role.taixuInsightNotice;
    const started = DB.saveCharacterIfCurrent(u.id, charId, character.updated_at, role, role.name);
    if (!started) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    const job = {
      id: jobId,
      userId: u.id,
      charId,
      type,
      goal,
      roleSnapshot: JSON.parse(JSON.stringify(role)),
      status: 'pending',
      created_at: Date.now(),
      endsAt: now + TAIXU_INSIGHT_DURATION_MS,
    };
    scheduleTaixuInsightJob(job);
    notifyCharacterUpdated(u.id, charId, started.updated_at);
    sendJSON(res, 202, { ok: true, status: 'pending', jobId: job.id, started_at: now, endsAt: job.endsAt, remainingMs: TAIXU_INSIGHT_DURATION_MS, character: role, updated_at: started.updated_at });
    return true;
  }
  const forgeJobMatch = urlPath.match(/^\/api\/character\/(\d+)\/forge\/([A-Za-z0-9-]+)$/);
  if (forgeJobMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'GET') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(forgeJobMatch[1]);
    const job = forgeJobs.get(forgeJobMatch[2]);
    if (!job || job.userId !== u.id || job.charId !== charId) { sendJSON(res, 404, { error: '炼器任务不存在或已过期' }); return true; }
    if (job.status === 'completed') sendJSON(res, 200, { ...job.result, status: 'completed', jobId: job.id });
    else if (job.status === 'failed') sendJSON(res, 200, { ok: false, status: 'failed', jobId: job.id, error: job.error || '炼器失败' });
    else sendJSON(res, 200, { ok: true, status: job.status, jobId: job.id });
    return true;
  }
  const forgeMatch = urlPath.match(/^\/api\/character\/(\d+)\/forge$/);
  if (forgeMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(forgeMatch[1]);
    const body = JSON.parse(await readBody(req));
    if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) { sendJSON(res, 400, { error: '角色版本无效' }); return true; }
    const materials = Array.isArray(body.materials) ? body.materials.slice(0, 2) : [];
    if (materials.length !== 2) { sendJSON(res, 400, { error: '炼器需要两件材料' }); return true; }
    const itemInput = body.item && typeof body.item === 'object' ? body.item : null;
    if (!itemInput) {
      const character = DB.getCharacter(u.id, charId);
      if (!character) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
      settlePassiveRecovery(character.data);
      if (character.updated_at !== body.updated_at) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
      const busy = characterBusyReason(character.data);
      if (busy) { sendJSON(res, 409, { error: busy, code: 'character_busy' }); return true; }
      if (Number(character.data.stamina || 0) < FORGE_STAMINA_COST) { sendJSON(res, 400, { error: '精力不足（需 ≥ 20）' }); return true; }
      const job = { id: crypto.randomUUID(), userId: u.id, charId, materials, roleUpdatedAt: body.updated_at, status: 'pending', created_at: Date.now() };
      scheduleForgeJob(job);
      sendJSON(res, 202, { ok: true, status: 'pending', jobId: job.id });
      return true;
    }
    if (!itemInput || !String(itemInput.name || '').trim()) { sendJSON(res, 400, { error: '缺少炼器产物' }); return true; }
    const character = DB.getCharacter(u.id, charId);
    if (!character) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    settlePassiveRecovery(character.data);
    if (character.updated_at !== body.updated_at) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    const busy = characterBusyReason(character.data);
    if (busy) { sendJSON(res, 409, { error: busy, code: 'character_busy' }); return true; }
    if (Number(character.data.stamina || 0) < FORGE_STAMINA_COST) { sendJSON(res, 400, { error: '精力不足（需 ≥ 20）' }); return true; }
    const role = character.data;
    const consumed = [];
    const materialEntries = [];
    for (const material of materials) {
      const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
      const found = list.find(entry => entry && entry.name === material.name && Number(entry.qty || 1) > 0);
      if (!found) { sendJSON(res, 400, { error: `材料不存在：${String(material.name || '')}` }); return true; }
      consumed.push(found.name);
      materialEntries.push({ entry: found, submitted: material });
    }
    if (!Array.isArray(role.bag)) role.bag = [];
    const existingOutput = role.bag.find(entry => entry && entry.name === String(itemInput.name).slice(0, 24));
    if (itemInput.success !== false && !existingOutput && role.bag.length >= 100) {
      sendJSON(res, 400, { error: '储物袋已满，无法收纳炼器产物' });
      return true;
    }
    role.stamina = Math.max(0, Number(role.stamina || 0) - FORGE_STAMINA_COST);
    if (itemInput.success === false) {
      const lost = [];
      materials.forEach(material => {
        if (Math.random() < 0.5) {
          const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
          const found = list.find(entry => entry && entry.name === material.name);
          if (found) { found.qty = (found.qty || 1) - 1; if (found.qty <= 0) list.splice(list.indexOf(found), 1); lost.push(material.name); }
        }
      });
      const failedSaved = DB.saveCharacterIfCurrent(u.id, charId, character.updated_at, role, role.name);
      if (!failedSaved) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
      notifyCharacterUpdated(u.id, charId, failedSaved.updated_at);
      sendJSON(res, 200, { ok: false, character: role, updated_at: failedSaved.updated_at, consumed, lost, process: String(body.process || '').slice(0, 100), reason: String(body.reason || '炉火失衡，未能成器').slice(0, 100), item: itemInput });
      return true;
    }
    materials.forEach(material => {
      const list = material.src === 'equip' ? (role.equipment || []) : (role.bag || []);
      const found = list.find(entry => entry && entry.name === material.name);
      if (found) { found.qty = (found.qty || 1) - 1; if (found.qty <= 0) list.splice(list.indexOf(found), 1); }
    });
    const highestRarity = materialEntries.map((material, index) => normalizeForgeRarity(material.entry.rarity || materials[index].rarity)).reduce((best, rarity) => {
      return FORGE_RARITIES.indexOf(rarity) > FORGE_RARITIES.indexOf(best) ? rarity : best;
    }, 'common');
    const item = { name: String(itemInput.name).slice(0, 24), desc: String(itemInput.desc || '新炼成的法器').slice(0, 200), kind: ['武器', '防具', '法宝', '工具'].includes(itemInput.kind) ? itemInput.kind : '法宝', qty: 1, rarity: normalizeForgeRarity(itemInput.rarity) };
    const existing = role.bag.find(entry => entry && entry.name === item.name);
    if (existing) { existing.qty = (existing.qty || 1) + 1; existing.desc = item.desc; existing.kind = item.kind; existing.rarity = item.rarity; }
    else role.bag.push(item);
    const saved = DB.saveCharacterIfCurrent(u.id, charId, character.updated_at, role, role.name);
    if (!saved) { sendJSON(res, 409, { error: '角色数据已更新，请重试' }); return true; }
    notifyCharacterUpdated(u.id, charId, saved.updated_at);
    sendJSON(res, 200, {
      ok: true,
      character: role,
      updated_at: saved.updated_at,
      item,
      consumed,
      process: String(body.process || '').slice(0, 100)
    });
    return true;
  }
  const characterActionMatch = urlPath.match(/^\/api\/character\/(\d+)\/action$/);
  if (characterActionMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method Not Allowed' }); return true; }
    const charId = Number(characterActionMatch[1]);
    const body = JSON.parse(await readBody(req));
    if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) { sendJSON(res, 400, { error: '角色版本无效' }); return true; }
    const current = DB.getCharacter(u.id, charId);
    if (!current) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    if (current.updated_at !== body.updated_at) { sendJSON(res, 409, { error: '角色数据已更新，请重试', code: 'character_conflict' }); return true; }
      settlePassiveRecovery(current.data);
      const action = String(body.action || '');
      const role = current.data;
    const busy = ['inventory_equip', 'inventory_unequip', 'skill_equip', 'skill_unequip'].includes(action)
      ? equipmentActionBusyReason(role)
      : characterBusyReason(role);
    if (busy) { sendJSON(res, 400, { error: busy, code: 'character_busy' }); return true; }
    role.bag = Array.isArray(role.bag) ? role.bag : [];
    role.equipment = Array.isArray(role.equipment) ? role.equipment : [];
    role.skills = Array.isArray(role.skills) ? role.skills : [];
    role.skillPool = Array.isArray(role.skillPool) ? role.skillPool : [];
    if (action === 'inventory_equip' || action === 'inventory_unequip') {
      const from = action === 'inventory_equip' ? role.bag : role.equipment;
      const to = action === 'inventory_equip' ? role.equipment : role.bag;
      const max = action === 'inventory_equip' ? 5 : 100;
      const index = Number(body.index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= from.length) { sendJSON(res, 400, { error: '物品位置无效' }); return true; }
      if (to.length >= max) { sendJSON(res, 400, { error: action === 'inventory_equip' ? '随身法宝已满' : '储物袋已满' }); return true; }
      to.push(from.splice(index, 1)[0]);
    } else if (action === 'skill_equip' || action === 'skill_unequip') {
      const from = action === 'skill_equip' ? role.skillPool : role.skills;
      const to = action === 'skill_equip' ? role.skills : role.skillPool;
      const index = Number(body.index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= from.length) { sendJSON(res, 400, { error: '功法位置无效' }); return true; }
      if (action === 'skill_equip' && to.length >= 5) { sendJSON(res, 400, { error: '功法栏已满' }); return true; }
      to.push(from.splice(index, 1)[0]);
    } else if (action === 'library_buy') {
      const code = String(body.code || '');
      const book = SERVER_LIBRARY_BOOKS.get(code);
      if (!book) { sendJSON(res, 400, { error: '功法不存在' }); return true; }
      if ([...role.skills, ...role.skillPool].some(skill => skill && skill.name === book.name)) { sendJSON(res, 400, { error: '已拥有该功法' }); return true; }
      const stock = Number(serverLibraryStock.get(code) || 0);
      if (stock <= 0) { sendJSON(res, 400, { error: '已售罄' }); return true; }
      if (Number(role.gold || 0) < book.price) { sendJSON(res, 400, { error: '灵石不足' }); return true; }
      const skill = { name: book.name, type: book.type, elem: book.elem, tier: book.tier, desc: book.desc };
      role.gold = Number(role.gold || 0) - book.price;
      (role.skills.length < 5 ? role.skills : role.skillPool).push(skill);
      serverLibraryStock.set(code, stock - 1);
    } else {
      sendJSON(res, 400, { error: '未知角色操作' }); return true;
    }
    const saved = DB.saveCharacterIfCurrent(u.id, charId, current.updated_at, role, role.name);
    if (!saved) { sendJSON(res, 409, { error: '角色数据已更新，请重试', code: 'character_conflict' }); return true; }
    notifyCharacterUpdated(u.id, charId, saved.updated_at);
    sendJSON(res, 200, { ok: true, action, character: role, updated_at: saved.updated_at });
    return true;
  }
  const charMatch = urlPath.match(/^\/api\/character\/(\d+)$/);
  if (charMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const charId = Number(charMatch[1]);
    if (req.method === 'GET') {
      const c = DB.getCharacter(u.id, charId);
      if (!c) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
      // 读取接口只计算当前展示状态，不在后台刷新时写库或推进版本号。
      settlePassiveRecovery(c.data);
      const settled = settleCultivation(c.data);
      const running = findRunningRoomMember(u.id, charId);
      if (running) {
        c.data.status = 'adventuring';
        c.data.stamina = running.stamina;
        c.data.hp = running.hp;
        c.data.max_hp = running.max_hp || c.data.max_hp;
        c.data.equipment = running.equipment || c.data.equipment;
        c.data.bag = running.bag || c.data.bag;
        c.data.skills = running.skills || c.data.skills;
      }
      sendJSON(res, 200, { id: c.id, character: c.data, updated_at: c.updated_at });
      return true;
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const data = body.character || null;
      if (!data) { sendJSON(res, 400, { error: '缺少角色数据' }); return true; }
      if (!Number.isSafeInteger(body.updated_at) || body.updated_at < 0) {
        sendJSON(res, 400, { error: 'Missing valid character version' }); return true;
      }
      const current = DB.getCharacter(u.id, charId);
      if (!current) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
      if (body.updated_at !== current.updated_at) {
        sendJSON(res, 409, { error: 'Character data has changed; synchronizing', code: 'character_conflict' }); return true;
      }
      const busy = characterBusyReason(current.data);
      if (busy) { sendJSON(res, 409, { error: busy, code: 'character_busy' }); return true; }
      settlePassiveRecovery(current.data);
      for (const field of AUTHORITATIVE_CHARACTER_FIELDS) {
        // 闭关页面会提交其本地计时快照，服务端随后在读取时结算；仅允许该专用同步场景。
        if (field === 'exp' && current.data.cultivation && data.cultivation) continue;
        if (Object.prototype.hasOwnProperty.call(data, field) && JSON.stringify(data[field]) !== JSON.stringify(current.data[field])) {
          sendJSON(res, 400, { error: '角色经济与战斗字段只能由服务端操作' }); return true;
        }
      }
      const nextData = { ...current.data };
      for (const field of PLAYER_MUTABLE_CHARACTER_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(data, field)) nextData[field] = data[field];
      }
      const dataName = String(nextData.name || current.data.name || '无名');
      // 页面切换或延迟自动保存可能携带旧的“休息”状态，不能覆盖服务端正在推进的副本状态。
      const running = findRunningRoomMember(u.id, charId);
      if (running) {
        nextData.status = 'adventuring';
        nextData.stamina = running.stamina;
        nextData.hp = running.hp;
        nextData.max_hp = running.max_hp || nextData.max_hp;
      }
      const saved = DB.saveCharacterIfCurrent(u.id, charId, body.updated_at, nextData, dataName);
      if (!saved) {
        sendJSON(res, 409, { error: 'Character data has changed; synchronizing', code: 'character_conflict' }); return true;
      }
      notifyCharacterUpdated(u.id, charId, saved.updated_at);
      sendJSON(res, 200, { ok: true, character: nextData, updated_at: saved.updated_at });
      return true;
    }
    sendJSON(res, 405, { error: 'Method Not Allowed' });
    return true;
  }
  // ---------- 日志：添加/列表 ----------
  if (req.method === 'POST' && urlPath === '/api/log') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const body = JSON.parse(await readBody(req));
    if (!body.log) { sendJSON(res, 400, { error: '缺少日志' }); return true; }
    DB.addLog(u.id, body.log);
    sendJSON(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/logs') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    sendJSON(res, 200, { logs: DB.getLogs(u.id) });
    return true;
  }
  const publicLogDetailMatch = urlPath.match(/^\/api\/public\/logs\/(\d+)$/);
  if (req.method === 'GET' && publicLogDetailMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const log = DB.getLogById(Number(publicLogDetailMatch[1]));
    if (!log) { sendJSON(res, 404, { error: '日志不存在' }); return true; }
    sendJSON(res, 200, { log });
    return true;
  }
  return false;  // 非账号 API，交给后续路由
}

/* 道具描述生成：为每件新获得的战利品编写修仙风格描述（严格 JSON 输出） */
const LOOT_PROMPT = `你是《问道仙坊》的宝物文案作者。为给定列表中的每件道具编写一段 15~40 字的修仙风格描述：点明材质、来历或用途，语言凝练有古意，贴合道具名。严格只输出一个 JSON 数组，不要任何解释或标记，格式：[{"name":"道具名","desc":"描述"}]，数组必须包含输入的全部道具名，顺序不限。`;

/* 探险总结生成：为整篇探险日志写一段 ≤200 字的总结 */
const SUMMARY_PROMPT = `你是《问道仙坊》的日志编者。请只根据本局提供的完整探险段落，写一段本局独有的总结，不超过 150 字。必须引用本局实际发生的至少一个具体事件、角色行动、敌人或收获；不得只根据副本名、固定背景或模板作答。每局措辞和内容都应随日志变化。语言凝练，带仙侠韵味，只输出总结正文，不要标题，不要解释。`;

const DEATH_SUMMARY_PROMPT = `你是《问道仙坊》的执事史官。请通读本局完整探险日志，只依据日志中实际发生的内容，分析死亡角色的具体死因。
严格只输出一个 JSON 对象，不要代码围栏或额外文字：
{"overall":"对本局死亡角色共同遭遇/结局的总结，100字以内","roles":[{"name":"死亡角色完整姓名","reason":"结合全文说明该角色为何死亡，100字以内"}]}
要求：overall 和每条 reason 都必须不超过 100 个汉字；不得臆造日志未出现的事件；roles 只填写输入名单中的死亡角色，每个角色恰好一条；若多人死亡，分别说明各自最后导致死亡的行动、伤势、敌人或环境因素。`;

/* 探险成败判定：AI 通读整篇日志后，依据最终剧情走向判定本次探险是成功还是失败 */
const OUTCOME_PROMPT = `你是《问道仙坊》的执事长老。阅读这篇探险日志的完整剧情，判断这次探险的最终结果：
1. **成功**：队伍达成了任务目标或至少全身而退（即使中途有波折、受伤、损失道具，只要最终完成任务或顺利撤离）；
2. **失败**：剧情明确以任务失败、队伍溃败/团灭、被逐出副本、核心目标未达成且付出惨重代价告终；**队伍在途中逃跑/撤退脱身同样视为失败**（未完成任务，哪怕保住了性命）。
注意：仅凭单次受挫、一次大失败、或某段描写凶险，不构成失败；必须以全文的最终结局为准。
同时决定本局结算中的成长与机缘：
1. statBuffs：依据每位成员在本局中的实际表现，自行决定是否获得 1 点属性成长以及加在哪一项（体魄/身法/神识/气运）；没有则留空数组。不要随机补发，成员必须有明确的成长理由。
2. traits：只授予**本局极其突出、无法忽视的单个高光事件**（如独自断后救下同门、破敌致命一击、寻得关键天材地宝、识破致命禁制等）对应的成员。唯有某位成员确有独一无二的高光表现时才授予；**若没有任何突出的唯一表现，traits 必须为空数组**。严禁因参加探险、凑数、或为了让成员有所收获而授予——特质只奖励英雄事迹，绝不作为参与奖励。特质名必须为 6~12 字，描述必须为 20~100 字且同时详细说明获取经历与未来探险中的具体效果，不得与已有特质重复。
3. injury：只能从输入列出的“重伤候选”中选择至多一人判断是否获得临时受伤特质。通常不要授予，仅在剧情明确支持且伤势会形成持续影响的少数情况下低概率授予；不授予时为 null。授予时 grant 必须为 true，名称必须为 6~12 字，描述必须为 20~100 字并详细说明受伤经历与伤势效果。
4. scroll：依据本局是否明确获得功法/术法传承或卷轴，自行决定是否掉落卷轴；没有则 null，有则给出类型。
严格只输出一个 JSON 对象，不要任何解释或标记：
{"ok":true,"reason":"简短理由","statBuffs":[{"member":"角色完整姓名","attribute":"体魄"}],"traits":[{"member":"角色完整姓名","name":"绝境守心如铁","desc":"包含获取经历与具体效果的详细描述"}],"injury":{"member":"重伤候选中的角色完整姓名","grant":true,"name":"经脉震裂未愈","desc":"包含受伤经历与具体效果的详细描述"},"scroll":null}
或
{"ok":false,"reason":"简短理由","statBuffs":[],"traits":[],"injury":null,"scroll":null}`;

/* 功法/术法卷轴生成：10% 概率的稀有战利品（严格 JSON 输出） */
const SCROLL_PROMPT = `你是《问道仙坊》的藏经阁执事。创作一部{type}卷轴——不是功法本体，而是记载修炼之法的卷轴（拓本/残卷/秘录皆可）。要求：
1. 起一个简洁贴切的名字（2~12 字，如"《青木养气诀》残卷""御风术·拓本""庚金炼体要旨"）；
2. 写一段 15~40 字的描述：来历、内容、价值；
3. 卷轴名与描述都要有修仙韵味，风格与《问道仙坊》一致。
严格只输出一个 JSON 对象，不要任何解释或标记：{"name":"卷轴名","desc":"描述"}`;

/* 炼器：AI 综合材料属性自行判断成败，并生成对应的完整叙事。 */
const FORGE_PROMPT = `你是《问道仙坊》的器道宗师，执掌炼器坊。请综合两件材料的名称、描述、种类、品质、五行/属性关联、炼器常理与组合契合度，自行判断本次炼器成功或失败。
1. **合理性判断**（符合修仙世界观与炼器常理）：材料带有品质（普通/稀有/珍贵/传说），高品质材料（稀有及以上）炼成的法器应相应更珍奇，可在描述中体现品质带来的不凡之处；
   - 合理的组合：金属/矿石/兽骨/妖皮/灵木/灵植/符箓/法宝残片等炼器材料之间相互熔炼组合（如"铁剑+灵骨碎片"→骨铁兵刃、"兽皮+骨笛"→皮骨法器）；
   - 不合理的组合：丹药/食物/货币/活物等不宜入炉之物，或风马牛不相及的材料拼凑（如"聚气丹+罗盘"），判为不合理并说明理由。
2. 只有判断成功时才生成法器：产物必须契合两件材料特性，起名 2~10 字，写 50~200 字详细描述（包括材质、来历、外观、核心能力、适用场景或限制），kind 为"武器/防具/法宝/工具"之一，并给出合理品质。
3. 成功时 process 写结合、淬炼、定型及产物形成的完整流程，100 字以内；失败时 process 写炉火变化、材料冲突或失控、最终未成器的完整过程，100 字以内；reason 写具体失败原因，50 字以内。失败流程和理由不得出现成功、成器、定型完成或获得法器等成功结局。
严格只输出一个 JSON 对象，不要任何解释或标记：
{"success":true,"item":{"name":"法器名","desc":"详细描述","kind":"武器","rarity":"rare"},"process":"与成败一致的炼器流程","reason":"失败原因；成功时为空"}`;

/* 战利品提取：从探险日志全文中语义提取角色们获得的道具（AI 理解剧情，能区分"获得"与"提及"），并为每件写描述 */
const EXTRACT_LOOT_PROMPT = `你是《问道仙坊》的结算师。只根据带有“第N段”编号的探险日志全文，找出本局剧情中**明确写出获得动作**的全部道具（包括击败首领后明确获得的首领遗物）。战利品必须来自剧情中明确发生的获得动作，例如"获得/捞到/捡到/摸出/拾起/拾得/搜刮到/缴获/寻得/翻出/收下/取走/到手/得"；不得根据副本名称、固定掉落表、首领配置或常识自行补充未在剧情中获得的物品。注意排除：
1. 只是被提及/使用/携带的装备与工具（如"催动避瘴珠""摸了摸兽皮囊""提着灵锄"——这不是获得）；
2. 消耗掉的使用物（丹药、符箓等）；
3. 灵石等货币。
输出名称统一为 4~12 字；原文道具名不足 4 字时，按物品特征补足为完整名称（如“残箭”→“残箭杆”），不得输出 3 字及以下的简称、货币或“无”。
**必须穷尽列举**：只要出现获得动作指向的物品，即使一句话带过、即使只有一枚/半张，也要列出（例："拾起一枚幽绿磷骨珠""弯腰捡起半张兽皮"都要列入）。不设掉落件数、数量或稀有度预算，剧情没有明确获得任何道具时允许输出空数组。
为每件道具填写：
- name：该段原文中的道具名（4~12 字）；canonicalName：同一实体在全文中的统一名称（4~12 字），别名必须统一；
- desc：15~40 字修仙风格描述；qty：数量按剧情中的实际数量，默认 1；稀有度只能是 common/rare/epic/legendary；
- owner：剧情明确写出最终拿取、收下或持有者时填队伍成员完整姓名；集体保管、无人明确取得或无法判断时填空字符串；
- sourceStep：首次明确获得所在的段落编号；entityId：同一实体稳定且简短的标识；
- sameAsStep：若本条只是后文再次提到此前已获得的同一实体，填写首次获得段落编号，此时不得当作新掉落；若是新的获得事件则填 null。
严格只输出一个 JSON 数组，不要任何解释或标记；每个对象单独占一行，格式：
[{"name":"青白古剑","canonicalName":"殉剑古剑","desc":"描述","qty":1,"rarity":"epic","owner":"洛清欢","sourceStep":12,"entityId":"sword-1","sameAsStep":null},
{"name":"殉剑古剑","canonicalName":"殉剑古剑","desc":"描述","qty":1,"rarity":"epic","owner":"洛清欢","sourceStep":18,"entityId":"sword-1","sameAsStep":12}]
兼容要求：旧格式的 name/desc/qty/rarity 仍可使用。没有获得任何道具时输出 []。`;

/* 特质颁发：AI 结合剧情为成员颁发新特质（名字 + 描述） */
const TRAIT_PROMPT = `你是《问道仙坊》的宗门藏经阁执事。修士「{member}」刚完成一次灵墟探险，请根据他/她在剧情中的实际表现（英勇断后、临危不乱、中毒负伤、寻宝发现、击杀强敌、辨识药草等）为其颁发一个新特质：
1. 特质名 6~12 字，可带熟练度后缀（初级/中级/高级），如"辨别灵草（初级）""绝境断后英杰""百毒侵身不倒""临危守心不乱""灵墟猎宝直觉"，要贴合剧情行为，不要与已有特质重复（已有：{existing}）；
2. 写一段 20~100 字的详细描述：必须同时说明因何具体经历获得、体现何种能力，以及未来探险中该特质会如何发挥具体效果。
严格只输出一个 JSON 对象，不要任何解释或标记：{"name":"绝境守心如铁","desc":"在本次探险中独自断后并护住同伴，因此今后遭遇强敌时更能稳住心神并提高防守表现。"}`;

const LEARNED_SKILL_PROMPT = `你是《问道仙坊》的藏经阁执事。根据探险日志，提取队员在本局中**明确新领悟、学会或获得传承而掌握**的功法/术法。不要把原本已经会、仅仅施展、只是提及、获得卷轴但未领悟的技能算入。技能必须归属给队伍中的真实成员。每项给出 2~20 字技能名、功法或术法类型、黄阶/玄阶/地阶/天阶品阶与 10~120 字描述。没有则输出 []。严格只输出 JSON 数组，不要解释：[{"member":"角色完整姓名","name":"技能名","type":"功法或术法","tier":"黄阶","desc":"技能描述"}]`;

/* AI 开本判定：由 AI 决定隐藏副本/特殊事件/突破试炼与敌人数量、修为 */
const SETUP_PROMPT = `你是《问道仙坊》的开局推演师。根据副本背景、队伍修为与角色特质，决定本次探险的局势：
1. hidden：是否触发隐藏凶地（首领盘踞、名称改变、凶险加倍）；normal：false。
2. specialEvent：是否触发特殊异象（整体难度与机缘上调）；normal：false。
3. breakthrough：仅当队伍中有练气十层圆满的角色时可为 true，否则必须 false。
4. enemies：从给定【此间生灵】中自行选择本局将遭遇的敌人，普通 0~3 种、特殊事件 0~4 种；必须使用给定名称，不得自造；为每种敌人指定合理修为（练气一层~十层，特殊事件可至筑基初期/中期）。
严格只输出一个 JSON 对象，不要任何解释或标记：
{"hidden":false,"specialEvent":false,"breakthrough":false,"enemies":[{"name":"敌人名","realm":"练气三层"}]}`;

function parseSetupJson(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const st = s.indexOf('{'), en = s.lastIndexOf('}');
  if (st >= 0 && en > st) s = s.slice(st, en + 1);
  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 开本判定格式无效');
  return parsed;
}

function normalizeAiSetup(parsed, payload = {}) {
  const pool = Array.isArray(payload.enemies) ? payload.enemies : [];
  const seen = new Set();
  const enemies = (Array.isArray(parsed.enemies) ? parsed.enemies : []).map(entry => {
    const name = String(entry && entry.name || '').replace(/\s+/g, '').trim();
    const src = pool.find(x => String(x.name || '').trim() === name);
    if (!src || seen.has(name)) return null;
    const realm = String(entry && entry.realm || '').trim();
    const validRealm = /^(练气[一二三四五六七八九十]+层|筑基(初期|前期|中期|后期))$/.test(realm);
    seen.add(name);
    return { ...src, realm: validRealm ? realm : '练气一层' };
  }).filter(Boolean);
  const specialEvent = parsed.specialEvent === true;
  return {
    isHidden: parsed.hidden === true,
    specialEvent,
    breakthrough: parsed.breakthrough === true && payload.breakthroughEligible !== false,
    enemies: enemies.slice(0, specialEvent ? 4 : 3),
  };
}

async function aiDecideSetup(payload = {}) {
  const body = {
    dungeon: String(payload.dungeon && (payload.dungeon.name || payload.dungeon) || ''),
    lore: String(payload.dungeon && payload.dungeon.lore || ''),
    enemies: Array.isArray(payload.dungeon && payload.dungeon.enemies) ? payload.dungeon.enemies : [],
    bosses: Array.isArray(payload.dungeon && payload.dungeon.bosses) ? payload.dungeon.bosses : [],
    role: payload.role || {},
    breakthroughEligible: !!(payload.role && GE.canBreakthrough && GE.canBreakthrough(payload.role)),
  };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLLM('副本：' + body.dungeon + '\n【此间生灵】' + body.enemies.map(e => e.name + '：' + e.desc).join('；') + '\n【深处首领】' + body.bosses.map(b => b.name + '（' + (b.realm || '修为不明') + '）').join('；') + '\n【角色】' + (body.role.name || '') + '（' + (body.role.character_class || '练气一层') + '·' + ((body.role.traits || [])[0] || '') + '）\n' + (body.breakthroughEligible ? '【突破】该角色已至练气十层圆满，可触发突破试炼。' : ''), SETUP_PROMPT, 1200);
      return normalizeAiSetup(parseSetupJson(raw), body);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('AI 开本判定失败');
}

/* 容错解析 AI 的道具 JSON：AI 输出可能被截断（推理模型 token 占用）——
   先整段解析；失败则逐行正则提取 {"name":...,"desc":...} 片段，保住已生成的道具 */
function parseLootJsonLoose(raw) {
  let s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  // 1) 整段解析
  const st = s.indexOf('['), en = s.lastIndexOf(']');
  if (st >= 0 && en > st) {
    try {
      const arr = JSON.parse(s.slice(st, en + 1));
      if (Array.isArray(arr)) {
        return arr.filter(entry => entry && typeof entry === 'object'
          && isValidLootName(String(entry && entry.name || '').replace(/\s+/g, '').trim()));
      }
    } catch (e) { /* 截断，走逐行提取 */ }
  }
  // 2) 提取已经闭合的完整对象，兼容新旧字段顺序与扩展审计字段。
  const out = [];
  const objectRe = /\{[^{}]*\}/g;
  let objectMatch;
  while ((objectMatch = objectRe.exec(s))) {
    try {
      const entry = JSON.parse(objectMatch[0]);
      const name = String(entry && entry.name || '').trim();
      if (isValidLootName(name)) out.push(entry);
    } catch (e) { /* 忽略未闭合或格式损坏的片段 */ }
  }
  if (out.length) return out;
  // 3) 兼容最早期仅含 name/desc 的非完整片段。
  const re = /\{"name"\s*:\s*"([^"]+)",\s*"desc"\s*:\s*"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(s))) {
    const name = (m[1] || '').trim();
    if (isValidLootName(name) && !out.some(x => x.name === name)) {
      out.push({ name, desc: (m[2] || '').trim() });
    }
  }
  return out.length ? out : null;
}

function trimChineseSummary(value, max = 100) {
  return String(value || '').replace(/[\r\n]+/g, '').trim().slice(0, max);
}

function parseDeathSummary(raw, deadNames) {
  let text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const st = text.indexOf('{'), en = text.lastIndexOf('}');
  if (st >= 0 && en > st) text = text.slice(st, en + 1);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('AI 死亡总结格式无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI 死亡总结格式无效');
  const names = Array.from(new Set((deadNames || []).map(name => String(name || '').trim()).filter(Boolean)));
  const inputRoles = Array.isArray(parsed.roles) ? parsed.roles : [];
  const byName = new Map(inputRoles.map(entry => [String(entry && entry.name || '').trim(), entry]));
  const roles = names.map(name => {
    const entry = byName.get(name);
    const reason = trimChineseSummary(entry && entry.reason, 100);
    if (!reason) throw new Error('AI 未返回完整死亡角色死因');
    return { name, reason };
  });
  const overall = trimChineseSummary(parsed.overall, 100);
  if (!overall) throw new Error('AI 未返回死亡角色总结');
  return { overall, roles };
}

function fallbackDeathSummary(deadNames, dungeonName) {
  const names = Array.from(new Set((deadNames || []).map(name => String(name || '').trim()).filter(Boolean)));
  return {
    overall: `本局有${names.length}名角色在「${String(dungeonName || '灵墟')}」中因气血耗尽陨落。`.slice(0, 100),
    roles: names.map(name => ({ name, reason: `角色「${name}」在探险中气血归零，道消身殒。`.slice(0, 100) })),
  };
}

async function generateDeathSummary(storyText, dungeonName, deadNames) {
  const names = Array.from(new Set((deadNames || []).map(name => String(name || '').trim()).filter(Boolean)));
  if (!names.length) return { overall: '', roles: [] };
  const raw = await callLLM(
    `副本：${String(dungeonName || '灵墟')}\n死亡角色名单：${names.join('、')}\n\n探险日志全文（必须以此为唯一依据）：\n${String(storyText || '').slice(0, 12000)}`,
    DEATH_SUMMARY_PROMPT,
    2500,
  );
  return parseDeathSummary(raw, names);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const urlPath = requestUrl.pathname;
  if (urlPath.startsWith('/api/admin')) {
    try {
      await handleAdminAPI(req, res);
    } catch (error) {
      if (error instanceof AdminInputError) {
        sendJSON(res, 400, { error: error.message });
      } else {
        console.error('[admin-api]', String(error.message || error).slice(0, 200));
        sendJSON(res, 500, { error: '服务器错误' });
      }
    }
    return;
  }
  const publicCharacterFollowMatch = urlPath.match(/^\/api\/public\/characters\/(\d+)\/follow$/);
  if (req.method === 'POST' && publicCharacterFollowMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const characterId = Number(publicCharacterFollowMatch[1]);
    const body = JSON.parse(await readBody(req));
    if (typeof body.followed !== 'boolean') { sendJSON(res, 400, { error: '关注状态无效' }); return true; }
    if (!DB.getPublicCharacterById(characterId)) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    if (DB.getCharacter(u.id, characterId)) { sendJSON(res, 400, { error: '不能关注自己的角色' }); return true; }
    DB.setCharacterFollow(u.id, characterId, body.followed);
    sendJSON(res, 200, { characterId, is_followed: body.followed });
    return true;
  }
  const publicCharacterMatch = urlPath.match(/^\/api\/public\/characters\/(\d+)$/);
  if (req.method === 'GET' && publicCharacterMatch) {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const character = DB.getPublicCharacterById(Number(publicCharacterMatch[1]));
    if (!character) { sendJSON(res, 404, { error: '角色不存在' }); return true; }
    settlePassiveRecovery(character);
    const followed = DB.getFollowedCharacterIds(u.id).includes(character.id);
    const running = findRunningRoomMember(null, character.id);
    const liveCharacter = !running ? { ...character, is_followed: followed } : { ...character, is_followed: followed, status: 'adventuring', stamina: running.stamina, hp: running.hp, max_hp: running.max_hp || character.max_hp, equipment: running.equipment || character.equipment, bag: running.bag || character.bag, skills: running.skills || character.skills };
    sendJSON(res, 200, { character: liveCharacter });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/public/characters') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const pinCurrent = requestUrl.searchParams.get('pin_current') === '1';
    const currentCharacter = pinCurrent ? DB.getCharacters(u.id)[0] : null;
    const followedCharacterIds = DB.getFollowedCharacterIds(u.id);
    const followedCharacterSet = new Set(followedCharacterIds);
    const pageResult = DB.getPublicCharactersPage({
      page: requestUrl.searchParams.get('page'),
      pageSize: 12,
      status: requestUrl.searchParams.get('status'),
      sort: requestUrl.searchParams.get('sort'),
      order: requestUrl.searchParams.get('order'),
      q: requestUrl.searchParams.get('q'),
      pinnedCharacterId: currentCharacter && currentCharacter.id,
      followedCharacterIds,
    });
    const characters = pageResult.characters.map(character => {
      settlePassiveRecovery(character);
      const running = findRunningRoomMember(null, character.id);
      if (!running) return { ...character, is_followed: followedCharacterSet.has(character.id) };
      return { ...character, is_followed: followedCharacterSet.has(character.id), status: 'adventuring', stamina: running.stamina, hp: running.hp, max_hp: running.max_hp || character.max_hp, equipment: running.equipment || character.equipment, bag: running.bag || character.bag, skills: running.skills || character.skills };
    });
    sendJSON(res, 200, { ...pageResult, characters });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/public/logs') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    sendJSON(res, 200, { logs: DB.getAllLogSummaries() });
    return true;
  }
  if (req.method === 'GET' && urlPath === '/api/expeditions/active') {
    const u = authUser(req);
    if (!u) { sendJSON(res, 401, { error: '未登录' }); return true; }
    const runs = DB.getActiveExpeditionRuns().map(run => ({
      runId: run.runId,
      roomId: run.roomId,
      status: run.status,
      snapshot: durableClientSnapshot(run),
      updatedAt: run.updatedAt,
    }));
    sendJSON(res, 200, { runs });
    return true;
  }
  // 账号 / 角色 / 日志 / 房间 API（联机版）
  if (urlPath.startsWith('/api/auth') || urlPath.startsWith('/api/me') || urlPath.startsWith('/api/character') || urlPath.startsWith('/api/log') || urlPath.startsWith('/api/public/') || urlPath === '/api/creation' || urlPath === '/api/rooms') {
    try {
      const handled = await handleAuthAPI(req, res, urlPath);
      if (handled === true) return;
      sendJSON(res, 404, { error: '未知 API 路径' });
      return;
    } catch (e) {
      console.error('[api]', String(e.message || e).slice(0, 200));
      sendJSON(res, 500, { error: String(e.message || e) });
      return;
    }
  }
  function storyOwnershipDg(body) {
    const party = (Array.isArray(body && body.party) ? body.party : []).map(member => ({
      uid: member && member.uid,
      id: member && member.id,
      charId: member && member.charId,
      name: member && member.name,
      equipment: Array.isArray(member && member.equipment) ? member.equipment : (Array.isArray(member && member.items) ? member.items : []),
      bag: Array.isArray(member && member.bag) ? member.bag : [],
    }));
    return { party, itemLoans: [], itemRegistry: [] };
  }
  function validateStoryOwnership(body, rawText) {
    const text = String(rawText || '');
    const dg = storyOwnershipDg(body);
    const lootNames = GE.parseLootMarkers(text);
    const cleanText = text.replace(/【获得：[^】]*】/g, '').trim();
    const actorName = body && (body.actor || ((body.party || [])[0] || {}).name);
    const actor = (dg.party || []).find(member => member.name === actorName) || (dg.party || [])[0] || null;
    const violations = GE.validateStepItemUsage(dg, cleanText, { actor, lootNames });
    return { cleanText, lootNames, violations };
  }
  function validateStoryAiResult(body, result) {
    const violations = [];
    const actorInfo = (body && body.party || []).find(member => member.name === (body && body.actor)) || (body && body.party || [])[0] || null;
    if (result.itemUse && result.itemUse.name && actorInfo) {
      const ownedNames = new Set([...(actorInfo.items || []), ...(actorInfo.equipment || []), ...(actorInfo.bag || [])].map(item => item && item.name));
      if (!ownedNames.has(result.itemUse.name)) {
        violations.push({ item: result.itemUse.name, owner: actorInfo.name, user: actorInfo.name, sentence: 'AI 选择的道具不在本步可用道具中' });
      }
    }
    if (result.skillUse && result.skillUse.name && actorInfo && !(actorInfo.skills || []).some(skill => skill.name === result.skillUse.name)) {
      violations.push({ item: result.skillUse.name, owner: actorInfo.name, user: actorInfo.name, sentence: 'AI 选择的技能不在该角色已学技能中' });
    }
    return violations;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/story') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      let violations = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const generated = await callAIStory(body, attempt > 0 ? GE.itemGuardFeedback(violations) : '');
        violations = [...validateStoryOwnership(body, generated.text).violations, ...validateStoryAiResult(body, generated)];
        if (!violations.length) {
          sendJSON(res, 200, {
            text: generated.text, outcome: generated.outcome, damage: generated.damage, heal: generated.heal,
            itemUse: generated.itemUse, skillUse: generated.skillUse, loot: generated.loot,
            structured: generated.structured,
          });
          return;
        }
      }
      sendJSON(res, 422, { error: '道具归属校验未通过：\n' + GE.itemGuardFeedback(violations) });
    } catch (e) {
      console.error('[ai/story]', String(e.message || e).slice(0, 300));
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/loot') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const items = Array.isArray(body.items)
        ? body.items.map(String).map(name => name.replace(/\s+/g, '').trim().slice(0, 12)).filter(isValidLootName)
        : [];
      if (!items.length) { sendJSON(res, 400, { error: 'items 为空' }); return; }
      const raw = await callLLM('道具列表：' + items.join('、'), LOOT_PROMPT);
      // 容错解析：去 ```json 包裹，截取首个 [ ... ] 段
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = jsonStr.indexOf('['), end = jsonStr.lastIndexOf(']');
      if (start >= 0 && end > start) jsonStr = jsonStr.slice(start, end + 1);
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('AI 返回非数组');
      const out = [];
      const seen = new Set();
      parsed.forEach(x => {
        if (x && x.name && x.desc && !seen.has(x.name)) { seen.add(x.name); out.push({ name: String(x.name), desc: String(x.desc) }); }
      });
      sendJSON(res, 200, { items: out });
    } catch (e) {
      console.error('[ai/loot]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/setup') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const setup = await aiDecideSetup(body);
      sendJSON(res, 200, setup);
    } catch (e) {
      console.error('[ai/setup]', String(e && e.message || e).slice(0, 200));
      sendJSON(res, 500, { error: String(e && e.message || e).slice(0, 200) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/summary') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 8000);
      const dungeon = String(body.dungeon || '灵墟');
      const raw = await callLLM(`副本：${dungeon}\n\n探险日志全文：\n${logText}`, SUMMARY_PROMPT);
      // 150 字以内截断（保留完整句子）
      let text = raw.trim();
      if (text.length > 150) {
        const cut = text.slice(0, 150);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        text = lastDot > 60 ? cut.slice(0, lastDot + 1) : cut;
      }
      sendJSON(res, 200, { text });
    } catch (e) {
      console.error('[ai/summary]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/death-summary') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 12000);
      const dungeon = String(body.dungeon || '灵墟');
      const deadNames = Array.isArray(body.roles) ? body.roles.map(name => String(name || '').trim()).filter(Boolean).slice(0, 12) : [];
      const result = await generateDeathSummary(logText, dungeon, deadNames);
      sendJSON(res, 200, result);
    } catch (e) {
      console.error('[ai/death-summary]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/outcome') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 12000);
      const party = (Array.isArray(body.party) ? body.party : []).map(member => ({
        name: String(member && member.name || '').trim(),
        hp: Number(member && member.hp || 0),
        max_hp: Math.max(1, Number(member && member.max_hp || 100)),
        traits: Array.isArray(member && member.traits) ? member.traits.map(String) : [],
      })).filter(member => member.name);
      const memberNames = party.map(member => member.name);
      const severeInjuryCandidates = party
        .filter(member => member.hp > 0 && member.hp <= Math.floor(member.max_hp * 0.1))
        .map(member => member.name);
      const rosterText = party.map(member => `${member.name}（已有特质：${member.traits.join('、') || '无'}）`).join('；') || '未提供';
      const raw = await callLLM(
        `队伍成员：${rosterText}\n重伤候选：${severeInjuryCandidates.join('、') || '无'}\n\n探险日志全文：\n${logText}`,
        OUTCOME_PROMPT,
        2000,
      );
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.ok !== 'boolean') throw new Error('AI 未返回可用的判定');
      const traits = [];
      const grantedMembers = new Set();
      const grantedNames = new Set();
      for (const entry of Array.isArray(parsed.traits) ? parsed.traits : []) {
        const member = party.find(candidate => candidate.name === String(entry && entry.member || '').trim());
        const normalized = GE.normalizeTraitGrant(entry, memberNames, member ? member.traits : []);
        if (!normalized || grantedMembers.has(normalized.member) || grantedNames.has(normalized.name)) continue;
        traits.push(normalized);
        grantedMembers.add(normalized.member);
        grantedNames.add(normalized.name);
      }
      const injuryMember = party.find(member => member.name === String(parsed.injury && parsed.injury.member || '').trim());
      const injuryExisting = injuryMember
        ? [...injuryMember.traits, ...traits.filter(trait => trait.member === injuryMember.name).map(trait => trait.name)]
        : [];
      const injury = GE.normalizeInjuryGrant(parsed.injury, severeInjuryCandidates, injuryExisting);
      sendJSON(res, 200, {
        ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 120),
        statBuffs: Array.isArray(parsed.statBuffs) ? parsed.statBuffs : [],
        traits,
        injury,
        scroll: parsed.scroll || null,
      });
    } catch (e) {
      console.error('[ai/outcome]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/extract_loot') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const logText = String(body.log || '').slice(0, 12000);
      // 战利品提取是结构化 JSON，不能套用单段剧情 300 字限制，否则多件道具会被截断。
      const raw = await callLLM('探险日志全文：\n' + logText, EXTRACT_LOOT_PROMPT, 2000);
      const parsed = parseLootJsonLoose(raw);
      if (!Array.isArray(parsed)) throw new Error('AI 未返回可解析的道具列表');
      const out = normalizeLootItems(parsed);
      sendJSON(res, 200, { items: out });
    } catch (e) {
      console.error('[ai/extract_loot]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/trait') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const member = String(body.member || '修士').slice(0, 20);
      const logText = String(body.log || '').slice(0, 12000);
      const existing = Array.isArray(body.existing) ? body.existing.map(String) : [];
      const raw = await callLLM('探险日志全文：\n' + logText, TRAIT_PROMPT.replace('{member}', member).replace('{existing}', existing.join('、') || '无'));
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      const trait = GE.normalizeTraitGrant({ ...parsed, member }, [member], existing);
      if (!trait) throw new Error('AI 未返回符合规则的特质');
      sendJSON(res, 200, { name: trait.name, desc: trait.desc });
    } catch (e) {
      console.error('[ai/trait]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/scroll') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const type = body.type === '术法' ? '术法' : '功法';
      const raw = await callLLM('请创作一部' + type + '卷轴。', SCROLL_PROMPT.replace('{type}', type));
      // 容错解析：去 ```json 包裹，截取首个 { ... } 段
      let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
      if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !parsed.name) throw new Error('AI 未返回可用的卷轴');
      sendJSON(res, 200, { name: String(parsed.name).slice(0, 16), desc: String(parsed.desc || '来历不明的修炼卷轴').slice(0, 80) });
    } catch (e) {
      console.error('[ai/scroll]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/ai/forge') {
    if (!requireAiAccess(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const mats = (body.materials || []).slice(0, 3).map(m => `${m.name}（${m.kind || '杂物'}·品质${({ common: '普通', rare: '稀有', epic: '珍贵', legendary: '传说' })[normalizeForgeRarity(m.rarity)] || '普通'}：${m.desc || '无描述'}）`).join('、');
      if (!mats) { sendJSON(res, 400, { error: '材料为空' }); return; }
      let parsed = null;
      let parseError = null;
      for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
        try {
          // 炼器返回的是结构化 JSON，不能使用叙事接口的 250 字截断，否则会截断 JSON。
          const raw = await callLLM('投入材料：' + mats + '\n请判断合理性并炼器。', FORGE_PROMPT, 1200);
          // 容错解析：去 ```json 包裹，截取首个 { ... } 段
          let jsonStr = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
          const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
          if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          parseError = e;
        }
      }
      if (!parsed) throw new Error('AI 返回格式异常，请稍后重试');
      if (!parsed || typeof parsed.success !== 'boolean') throw new Error('AI 未返回可用的成败判定');
      if (parsed.success && (!parsed.item || !parsed.item.name)) throw new Error('AI 未返回可用的法器');
      const process = String(parsed.process || '炼器大师引火熔合两件材料，灵力交织后塑成一件新的法器。').slice(0, 100);
      if (parsed.success) {
        const it = parsed.item || {};
        const highestRarity = (body.materials || []).reduce((best, material) => {
          const rarity = normalizeForgeRarity(material.rarity);
          return FORGE_RARITIES.indexOf(rarity) > FORGE_RARITIES.indexOf(best) ? rarity : best;
        }, 'common');
        const rarity = forgeRarityUpgrade(highestRarity);
        const itemName = String(it.name || '').replace(/ +/g, '').trim() || '新炼法器';
        const itemDesc = String(it.desc || '新炼成的法器').replace(/ +/g, '').trim() || '两件材料融合炼成的法器。';
        sendJSON(res, 200, { ok: true, process, item: { name: itemName.slice(0, 12), desc: itemDesc.slice(0, 200), kind: ['武器', '防具', '法宝', '工具'].includes(it.kind) ? it.kind : '法宝', rarity: normalizeForgeRarity(it.rarity || rarity) } });
      } else {
        const failureProcess = String(parsed.process || `炉火在淬炼${mats}时骤然失衡，灵力冲突使材料崩散，最终未能成器。`).slice(0, 100);
        sendJSON(res, 200, { ok: false, process: failureProcess, reason: String(parsed.reason || '两件材料属性冲突，灵力无法相融，炉火失衡未能成器').replace(/ +/g, '').slice(0, 100), item: { name: '未定型法器', desc: '材料冲突，炼制失败，未形成可用法器。', kind: '法宝', rarity: 'common' } });
      }
    } catch (e) {
      console.error('[ai/forge]', e.message);
      sendJSON(res, 500, { error: String(e.message || e) });
    }
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/health') {
    sendJSON(res, 200, { ok: true, configured: isConfigured, model: CONFIG.model || null, ai: getRuntimeAiStatus() });
    return;
  }
  if (req.method === 'GET') { serveStatic(res, urlPath); return; }
  res.writeHead(405); res.end('Method Not Allowed');
});

/* ============================================================
   WebSocket + 房间/匹配 · 联机副本（服务端权威推进）
   ============================================================ */
const ROOMS = new Map();
let roomSeq = 1;

function findRunningRoomMember(uid, charId) {
  for (const room of ROOMS.values()) {
    if (!room || !room.dg || !['running', 'waiting_ai', 'settling'].includes(room.status)) continue;
    const member = (room.dg.party || []).find(m => !m.isNpc
      && (uid == null || Number(m.uid) === Number(uid))
      && (charId == null || Number(m.charId) === Number(charId)));
    if (member) return member;
  }
  return null;
}

function getNpcCardByName(name) {
  const stored = DB.getAiCompanionCardByName(name);
  if (stored) return stored;
  const fallback = AI_COMPANIONS.findCardByName(name);
  return fallback ? { name: fallback.name, data: fallback } : null;
}

function makeNpcMember(name) {
  const card = getNpcCardByName(name);
  const npc = card ? GE.genNpc(card.name, card.data) : GE.genNpc(name);
  return {
    ...npc,
    uid: null,
    name: npc.name,
    char: npc,
    ws: null,
    isNpc: true,
    character_class: npc.character_class || '',
    matched: true,
  };
}

function npcPublicCard(member) {
  const data = (member && (member.char || member)) || {};
  const runtimeFields = new Set([
    'id', 'ws', 'isNpc', 'is_npc', 'is_mine', 'uid', 'charId', 'matched',
    'hpTs', 'staminaTs',
  ]);
  return Object.fromEntries(
    Object.entries(data).filter(([field]) => !runtimeFields.has(field))
  );
}

function roomStatePublic(room) {
  return {
    id: room.id,
    name: room.name || '房间' + room.id,
    status: room.status || 'waiting',
    dungeon: room.choice || (room.dg ? room.dg.dungeon.name : null),
    description: room.description || '',
    created_at: room.createdAt || Date.now(),
    host: room.host,
    party: (room.party || []).map(m => m ? {
      uid: m.uid || null, name: m.name, charId: m.charId || null, isNpc: !!m.isNpc,
      realm: m.character_class || m.realm || '', online: !m.isNpc ? !!m.ws : true,
      card: m.isNpc ? npcPublicCard(m) : undefined,
    } : null).filter(Boolean),
  };
}
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  (room.party || []).forEach(m => { if (m && m.ws && m.ws.readyState === 1 && m.ws !== except) m.ws.send(s); });
}
function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && typeof ws._uid === 'number') ws.send(s);
  });
}
function runningSnapshot(room) {
  const dg = room && room.dg;
  if (!dg) return null;
  return {
    id: dg.id,
    runId: dg.id,
    logNumber: dg.logNumber != null ? Number(dg.logNumber) : null,
    status: room.status,
    startedAt: dg.startedAt,
    dungeon: dg.dungeon,
    baseDungeon: dg.dungeon.baseName,
    planLabels: dg.plan.map(p => ({ key: p.key, label: p.label })),
    party: roomStatePublic(room).party,
    dgParty: dg.party.map(m => ({
      uid: m.uid || null,
      charId: m.charId || null,
      name: m.name,
      hp: m.hp,
      max_hp: m.max_hp || 100,
      isNpc: !!m.isNpc,
      card: m.isNpc ? npcPublicCard(m) : undefined,
    })),
    steps: dg.steps || [],
    totalStep: dg.totalStep || 0,
    flowMode: dg.flowMode || 'legacy', minSteps: dg.minSteps, preferredMaxSteps: dg.preferredMaxSteps, maxSteps: dg.maxSteps,
    phase: dg.phase, quest: dg.quest, encounter: dg.encounter, lastDecision: dg.lastDecision, nextHint: dg.nextHint,
  };
}
function durableRunSnapshot(room) {
  const payload = serializeDurableRoom(room, room && room._aiRetry);
  const client = runningSnapshot(room);
  return { ...payload, ...(client || {}), client };
}
function durableClientSnapshot(run) {
  if (run && run.snapshot && run.snapshot.client) {
    const pendingLogNumber = Number(run.snapshot._lifecycle && run.snapshot._lifecycle.pendingLogNumber);
    return {
      ...run.snapshot.client,
      logNumber: Number(run.snapshot.client.logNumber) || (pendingLogNumber > 0 ? pendingLogNumber : null),
    };
  }
  const snapshot = run && run.snapshot || {};
  const room = snapshot.room;
  const dg = room && room.dg;
  if (!room || !dg) return snapshot;
  const party = Array.isArray(room.party) ? room.party : [];
  return {
    id: dg.id,
    runId: dg.id,
    logNumber: Number(dg.logNumber || (snapshot._lifecycle && snapshot._lifecycle.pendingLogNumber)) || null,
    status: run.status || room.status || 'running',
    startedAt: dg.startedAt,
    dungeon: dg.dungeon,
    baseDungeon: dg.dungeon && dg.dungeon.baseName,
    planLabels: (dg.plan || []).map(p => ({ key: p.key, label: p.label })),
    party: party.map(member => ({
      uid: member && member.uid || null,
      charId: member && member.charId || null,
      name: member && member.name,
      isNpc: !!(member && member.isNpc),
      card: member && member.isNpc ? npcPublicCard(member) : undefined,
    })).filter(entry => entry.name),
    dgParty: (dg.party || []).map(member => ({
      uid: member && member.uid || null,
      charId: member && member.charId || null,
      name: member && member.name,
      hp: member && member.hp,
      max_hp: member && member.max_hp || 100,
      isNpc: !!(member && member.isNpc),
      card: member && member.isNpc ? npcPublicCard(member) : undefined,
    })).filter(entry => entry.name),
    steps: dg.steps || [],
    totalStep: dg.totalStep || 0,
    flowMode: dg.flowMode || 'legacy',
    minSteps: dg.minSteps,
    preferredMaxSteps: dg.preferredMaxSteps,
    maxSteps: dg.maxSteps,
    phase: dg.phase,
    quest: dg.quest,
    encounter: dg.encounter,
    lastDecision: dg.lastDecision,
    nextHint: dg.nextHint,
  };
}
function addMember(room, m) { room.party.push(m); }
function waitingRoomsPublic() {
  return Array.from(ROOMS.values()).filter(room => room.status === 'waiting').map(roomStatePublic);
}
function broadcastRooms() {
  const payload = JSON.stringify({ type: 'rooms_updated', rooms: waitingRoomsPublic() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && typeof ws._uid === 'number') ws.send(payload);
  });
}
function roomForMember(ws) { return ws._roomId ? ROOMS.get(ws._roomId) : null; }
function roomForUser(uid) {
  return Array.from(ROOMS.values()).find(room => (
    room.status === 'waiting' && room.party.some(member => member.uid === uid)
  )) || null;
}
function authenticatedSocketUser(ws, token) {
  const uid = token ? DB.sessionUserId(token) : null;
  if (!uid || ws._uid !== uid) return null;
  return DB.findUserById(uid);
}
function validDungeonName(name) {
  return typeof name === 'string' && GE.DUNGEON_POOL.some(dungeon => dungeon.name === name);
}
function memberFromCharacter(uid, character, ws) {
  return {
    uid,
    name: character.data.name,
    charId: Number(character.id),
    char: character.data,
    ws,
    isNpc: false,
    character_class: character.data.character_class || '',
  };
}
function toPublic(uid) {
  const u = DB.findUserById(uid);
  return { uid, username: u ? u.username : '?' };
}

/* ---------- 服务端权威副本推进 ---------- */
const TICK_MS = process.env.ROOM_FAST === '1' ? 50 : 3500;
function fillNpcs(room) {
  const target = 4;
  while ((room.party || []).length < target) {
    const used = new Set((room.party || []).map(member => member && member.name));
    const available = GE.NPC_NAME_POOL.filter(name => !used.has(name));
    const name = available.length ? available[Math.floor(Math.random() * available.length)] : `无名修士${room.party.length + 1}`;
    addMember(room, makeNpcMember(name));
  }
}
const { startRoomRun } = createRoomRunner({
  GE,
  GC,
  aiDecideSetup,
  beginRun: ({ room, dungeon }) => {
    if (process.env.ROOM_FAST === '1') {
      dungeon.minSteps = 1;
      dungeon.preferredMaxSteps = 1;
      dungeon.maxSteps = 1;
    }
    const result = DB.beginExpeditionRun({
      runId: dungeon.id,
      roomId: room.id,
      snapshot: durableRunSnapshot(room),
      staminaCost: 10,
      members: dungeon.party
        .filter(member => !member.isNpc && member.uid && member.charId)
        .map(member => ({ userId: member.uid, characterId: member.charId, memberName: member.name })),
    });
    const pendingLogNumber = Number(
      result.logNumber
      || (result.run && result.run.snapshot && result.run.snapshot._lifecycle && result.run.snapshot._lifecycle.pendingLogNumber),
    );
    dungeon.logNumber = Number.isSafeInteger(pendingLogNumber) && pendingLogNumber > 0 ? pendingLogNumber : null;
    for (const character of result.characters || []) {
      const member = dungeon.party.find(candidate => (
        candidate.uid === character.userId && candidate.charId === character.characterId
      ));
      if (member) {
        member.status = character.data.status;
        member.stamina = character.data.stamina;
        member.staminaTs = character.data.staminaTs;
        member.hpTs = character.data.hpTs;
      }
      notifyCharacterUpdated(character.userId, character.characterId, character.updated_at);
    }
  },
  broadcastStarting: room => broadcastAll({
    type: 'dungeon_starting',
    roomId: room.id,
    status: 'starting',
    room: roomStatePublic(room),
  }),
  broadcastAll,
  scheduleTick,
  runningSnapshot,
  onFailure: async (room, error) => {
    const message = String(error && error.message || error || '无法开始探险').slice(0, 200);
    broadcastAll({ type: 'dungeon_start_failed', roomId: room.id, error: message });
    for (const member of room.party || []) {
      if (member.ws && member.ws.readyState === 1) member.ws.send(JSON.stringify({ type: 'error', error: message }));
    }
    broadcastRooms();
  },
  console,
});
function scheduleTick(room) {
  if (room.status !== 'running' || !room.dg) return;
  if (room._timer) return;
  room._timer = setTimeout(async () => {
    room._timer = null;
    if (room.status !== 'running' || !room.dg) return;
    try { await dungeonStep(room); } catch (e) {
      console.error('[run] 步骤失败:', e.message);
      if (classifyAiFailure(e).resumable) await pauseRoomForAi(room, e);
      else await failRoomRun(room, e);
    }
  }, TICK_MS);
}
function clearRoomTimer(room) {
  if (room && room._timer) { clearTimeout(room._timer); room._timer = null; }
  if (room && room._aiRetryTimer) { clearTimeout(room._aiRetryTimer); room._aiRetryTimer = null; }
}
async function pauseRoomForAi(room, error) {
  if (!room || !room.dg || room.status === 'finished' || room.status === 'error') return false;
  clearRoomTimer(room);
  const previousState = room.status === 'settling' ? 'settling' : 'running';
  const current = room._aiRetry || {};
  const attempt = Math.max(1, Number(current.attempt || 0) + 1);
  const policy = classifyAiFailure(error);
  const delay = retryDelay(attempt, policy.longDelay);
  const retry = {
    attempt,
    nextRetryAt: Date.now() + delay,
    lastError: String(error && error.message || error || 'AI 服务暂时不可用').slice(0, 200),
    resumeState: previousState,
  };
  room._aiRetry = retry;
  room.status = 'waiting_ai';
  if (room.dg) room.dg.status = 'waiting_ai';
  if (!DB.setExpeditionRunState(room.dg.id, 'waiting_ai', durableRunSnapshot(room), ['running', 'settling', 'waiting_ai'])) {
    room.status = previousState;
    if (room.dg) room.dg.status = previousState;
    return false;
  }
  broadcastAll({ type: 'run_waiting_ai', runId: room.dg.id, retryAt: retry.nextRetryAt, attempt, error: retry.lastError, snapshot: runningSnapshot(room) });
  scheduleAiRetry(room, delay);
  return true;
}
function scheduleAiRetry(room, delay = 0) {
  if (!room || room.status !== 'waiting_ai' || !room.dg || room._aiRetryTimer) return;
  const wait = Math.max(0, Number(delay) || 0);
  room._aiRetryTimer = setTimeout(() => {
    room._aiRetryTimer = null;
    void resumeWaitingRoom(room);
  }, wait);
  if (typeof room._aiRetryTimer.unref === 'function') room._aiRetryTimer.unref();
}
async function resumeWaitingRoom(room) {
  if (!room || room.status !== 'waiting_ai' || !room.dg) return false;
  const resumeState = room._aiRetry && room._aiRetry.resumeState === 'settling' ? 'settling' : 'running';
  room.status = resumeState;
  room.dg.status = resumeState;
  if (!DB.setExpeditionRunState(room.dg.id, resumeState, durableRunSnapshot(room), ['waiting_ai'])) {
    room.status = 'waiting_ai';
    room.dg.status = 'waiting_ai';
    return false;
  }
  if (resumeState === 'settling') {
    try { await settleRoom(room); return true; }
    catch (error) {
      if (classifyAiFailure(error).resumable) await pauseRoomForAi(room, error);
      else await failRoomRun(room, error);
      return false;
    }
  }
  scheduleTick(room);
  return true;
}
async function failRoomRun(room, error) {
  if (!room || room._failureRecorded) return;
  room._failureRecorded = true;
  const dg = room.dg;
  clearRoomTimer(room);
  const message = String(error && error.message || error || 'AI 叙事生成失败').slice(0, 200);
  const storyText = dg ? dg.steps.map(s => `第${s.stepNo}段：${s.rawText || s.text || ''}`).join('\n') : '';
  if (dg) {
    const diedAny = (dg.party || []).some(m => !m.isNpc && (Number(m.hp || 0) <= 0 || m.isDead));
    const deadNames = (dg.party || []).filter(m => Number(m.hp || 0) <= 0 || m.isDead).map(m => m.name).filter(Boolean);
    let deathFallback = fallbackDeathSummary(deadNames, dg.dungeon.name);
    if (deadNames.length && storyText) {
      try { deathFallback = await generateDeathSummary(storyText, dg.dungeon.name, deadNames); }
      catch (summaryError) { console.warn('[death-summary] 失败结算无法生成 AI 死因，使用保底文案：', summaryError && summaryError.message ? summaryError.message : summaryError); }
    }
    const participants = (dg.party || []).filter(m => !m.isNpc && m.uid).map(m => ({ userId: m.uid, characterId: m.charId, memberName: m.name }));
    const failure = DB.failExpeditionRun({
      runId: dg.id,
      terminalStatus: 'failed',
      reason: message,
      log: participants.length ? {
        id: DB.nextLogSeq(participants[0].userId), run_id: dg.id,
        log_number: dg.logNumber || undefined,
        party_name: '匹配小队' + room.id, dungeon_name: dg.dungeon.name,
        status: 'failed', result_summary: storyText, created_at: new Date().toISOString(),
        is_favorited: false, death: diedAny,
        summary_text: '', death_summary: diedAny ? deathFallback.overall : '', cancel_reason: message,
        dg_snapshot: { icon: dg.dungeon.icon, name: dg.dungeon.name, baseName: dg.dungeon.baseName, isHidden: !!dg.dungeon.isHidden, specialEvent: !!dg.dungeon.specialEvent, steps: dg.steps, party: dg.party.map(x => ({ name: x.name, is_mine: !x.isNpc })) },
        settlement: { exp: 0, items: [], traits: [], damage: dg.damage || 0, levelUp: [], consumed: [], returned: [], members: (dg.party || []).map(m => ({ name: m.name, is_mine: !m.isNpc, fate: (Number(m.hp || 0) <= 0 || m.isDead) ? '阵亡' : '健康', death_reason: (Number(m.hp || 0) <= 0 || m.isDead) ? (deathFallback.roles.find(x => x.name === m.name) || {}).reason || '' : '', score: 0, gold: 0, damage: (dg.memberGains[m.uid || m.id] || {}).damage || 0, loot: [], newTraits: [], newSkills: [], praise: 0 })) },
      } : null,
    });
    if (failure.status === 'failed') {
      for (const participant of participants) {
        const character = DB.getCharacter(participant.userId, participant.characterId);
        if (character) notifyCharacterUpdated(participant.userId, participant.characterId, character.updated_at);
      }
    }
  }
  room.status = 'error';
  broadcastAll({ type: 'run_error', runId: dg && dg.id, error: 'AI 生成失败，已重试仍未得到有效内容', detail: message, snapshot: dg ? runningSnapshot(room) : null });
  room.party.forEach(member => { if (!member.isNpc && member.ws) member.ws._roomId = null; });
  if (ROOMS.get(room.id) === room) ROOMS.delete(room.id);
}
async function dungeonStep(room) {
  const dg = room.dg;
  const dynamic = dg.flowMode === 'dynamic';
  const plan = dynamic ? null : dg.plan[dg.planIdx];
  if (!dynamic && !plan) { await settleRoom(room); return; }
  const stageKey = dynamic ? (dg.phase || 'explore') : plan.key;
  if (!dynamic && (!dg.focusPlan || dg.focusPlan.length !== dg.plan.reduce((sum, entry) => sum + entry.steps, 0))) dg.focusPlan = GE.buildNarrativeFocusPlan(dg);
  const focus = dynamic
    ? GE.dynamicNarrativeFocus(dg, stageKey)
    : (dg.focusPlan[dg.totalStep] || { actorIndex: dg.totalStep % dg.party.length, supportIndex: null, support2Index: null, highlight: false });
  const actor = dg.party[focus.actorIndex] || dg.party[0];
  const support = focus.supportIndex == null ? null : dg.party[focus.supportIndex] || null;
  const support2 = focus.support2Index == null ? null : dg.party[focus.support2Index] || null;
  if (stageKey === 'battle') dg._curEnemy = dg.dungeon.enemies[Math.max(0, dg.stepIdx % Math.max(1, dg.dungeon.enemies.length))];
  else if (stageKey === 'boss') dg._curEnemy = dg.dungeon.bosses[dg.stepIdx] || dg.dungeon.bosses[0];
  else dg._curEnemy = null;
  let roll = 0, mod = 0, total = 0, attrKey = '', realmB = 0;
  const needsCheck = dynamic ? !['opening', 'closing', 'rest', 'retreat'].includes(stageKey) : plan.check;
  const resolveAiItemUse = (dg, actor, entry) => {
    if (!entry || !entry.name) return null;
    const avail = (GE.availableItemsForActor(dg, actor) || []).find(item => item.name === entry.name);
    if (!avail) return null;
    const owner = (dg.party || []).find(member => String(member.uid || member.id || '') === String(avail.ownerId || '')) || actor;
    return { item: { ...avail, owner, qty: 1 }, roll: null, total: null, success: entry.success === true };
  };
  const resolveAiSkillUse = (actor, entry) => {
    if (!entry || !entry.name) return null;
    const skill = (actor.skills || []).find(s => s.name === entry.name);
    if (!skill) return null;
    return { name: skill.name, type: skill.type || '功法', tier: GE.skillTier(skill), elemMod: GE.elemMatchMod(actor, skill), success: entry.success === true };
  };
  let dynamicFocusAdded = false;
  if (dynamic) {
    dg.focusPlan = dg.focusPlan || [];
    dg.focusPlan.push(focus);
    dynamicFocusAdded = true;
  }
  let payload, j, rawText = '', cleanText = '', outcome, stepRec, lootNames = [], violations = [];
  try {
    payload = GE.aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, null, null);
    for (let attempt = 0; attempt < 2; attempt++) {
      j = await callAIStory(payload, attempt > 0 ? GE.itemGuardFeedback(violations) : '');
      const text = j && j.text ? String(j.text) : '';
      if (!text) throw new Error('AI 返回空内容');
      rawText = String(text).trim();
      cleanText = rawText.replace(/【获得：[^】]*】/g, '').trim();
      lootNames = GE.parseLootMarkers(text);
      const aiLootNames = GE.recordAiLoot(dg, actor, j.loot || []);
      lootNames = [...new Set([...lootNames, ...aiLootNames])];
      violations = GE.validateStepItemUsage(dg, cleanText, { actor, lootNames });
      if (!violations.length) break;
      if (attempt === 1) throw new Error('道具归属校验未通过：\n' + GE.itemGuardFeedback(violations));
    }
    if (lootNames.length) {
      GE.registerLootOwnership(dg, actor, lootNames);
      if (!dg.gainedLoot) dg.gainedLoot = [];
      lootNames.forEach(n => { if (!dg.gainedLoot.some(x => x.name === n)) dg.gainedLoot.push(n); });
    }
    const aiStep = GE.normalizeAiStepResult(j, { outcome: needsCheck ? 'mid' : 'good' });
    outcome = aiStep.outcome;
    const itemUse = resolveAiItemUse(dg, actor, aiStep.itemUse);
    const skillUse = resolveAiSkillUse(actor, aiStep.skillUse);
    const itemExplicit = itemUse && itemUse.success && GE.itemUseExplicitInText(cleanText, itemUse.item, actor);
    const healAllowed = !!((itemExplicit && ['pill', 'talisman'].includes(String(itemUse.item.kind || '').toLowerCase())) || (skillUse && skillUse.success));
    GE.applyStageEffects(dg, stageKey, actor, total, outcome, aiStep.damage, aiStep.heal, healAllowed);
    if (typeof GE.recordItemLoansFromText === 'function') GE.recordItemLoansFromText(dg, cleanText);
    if (itemExplicit && typeof GE.consumeItemUse === 'function') {
      GE.consumeItemUse(dg, itemUse, { explicitUse: true, actor });
    }
    stepRec = {
      stage: stageKey, actor: actor.name, attr: '', roll: 0, mod: 0, total: 0, outcome, text: cleanText, rawText,
      stepNo: dg.totalStep + 1, enemy: dg._curEnemy ? dg._curEnemy.name : '', realmB: 0, src: 'ai', aiDamage: aiStep.damage, aiHeal: aiStep.heal,
      itemUse: itemUse ? { name: itemUse.item.name, success: itemUse.success, ownerId: itemUse.item.ownerId || null, userId: itemUse.item.userId || null, ownerName: itemUse.item.owner ? itemUse.item.owner.name : null, userName: actor.name, loaned: !!itemUse.item.loaned } : null,
      skillUse: skillUse ? { name: skillUse.name, type: skillUse.type, tier: skillUse.tier, elemMod: skillUse.elemMod || 0, success: skillUse.success } : null,
    };
  } catch (error) {
    if (dynamicFocusAdded) dg.focusPlan.pop();
    throw error;
  }
  try {
  dg.steps.push(stepRec);
  const g = dg.memberGains[actor.uid || actor.id];
  if (g) { g.acts++; if (needsCheck) { if (outcome === 'crit') g.crits++; if (outcome === 'fumble') g.fumbles++; } }
  if (support && cleanText.includes(support.name)) { const sg = dg.memberGains[support.uid || support.id]; if (sg) sg.acts++; }
  if (support2 && cleanText.includes(support2.name)) { const sg2 = dg.memberGains[support2.uid || support2.id]; if (sg2) sg2.acts++; }
  dg.totalStep++;
  if (!dynamic) { dg.stepIdx++; if (dg.stepIdx >= plan.steps) { dg.stepIdx = 0; dg.planIdx++; } }
  let decision = j.decision || {};
  if (dynamic) {
    const fallbackPhase = dg.totalStep > 0 && dg.phase === 'opening' ? 'explore' : dg.phase;
    decision = GE.normalizeAiDecision(decision, { phase: fallbackPhase, questStatus: dg.quest && dg.quest.status, encounterStatus: dg.encounter && dg.encounter.status, nextHint: dg.nextHint });
    if (!j.structured && dg.phase === 'opening') decision = { ...decision, phase: 'explore' };
    if (dg.totalStep < dg.minSteps) decision = { ...decision, phase: decision.phase === 'closing' ? dg.phase : decision.phase, continue: true };
    decision = GE.applyAiDecision(dg, decision);
  }
  if (!DB.checkpointExpeditionRun(dg.id, durableRunSnapshot(room))) {
    throw new Error('副本检查点写入失败');
  }
  broadcastAll({
    type: 'step',
    runId: dg.id,
    step: {
      no: stepRec.stepNo, stage: stepRec.stage, stageLabel: dynamic ? stageKey : plan.label, actor: stepRec.actor, text: stepRec.text,
      roll, mod, total, success: outcome !== 'bad' && outcome !== 'fumble',
      itemUse: stepRec.itemUse, skillUse: stepRec.skillUse, enemy: stepRec.enemy,
      partyHp: dg.party.map(m => ({ name: m.name, hp: m.hp || 0, max_hp: m.max_hp || 100 })),
      phase: dg.phase, questStatus: dg.quest && dg.quest.status, encounterStatus: dg.encounter && dg.encounter.status,
      continue: dynamic ? decision.continue : true,
    },
  });
  if (dynamic) {
    if (dg.phase === 'closing' && decision.continue === false && GE.canEnterClosing(dg, dg.lastDecision || {})) { await settleRoom(room); return; }
    if (dg.totalStep >= dg.maxSteps) { await settleRoom(room); return; }
  } else if (!dg.plan[dg.planIdx]) { await settleRoom(room); return; }
  scheduleTick(room);
  } catch (error) {
    if (dynamicFocusAdded) dg.focusPlan.pop();
    throw error;
  }
}

function parseAiStoryResponse(content, fallback = {}) {
  const raw = String(content || '').trim();
  const fallbackOutcome = fallback.needsCheck === false ? 'good' : 'mid';
  const defaultStep = { outcome: fallbackOutcome, damage: 0, heal: 0, itemUse: null, skillUse: null, loot: [] };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) { try { parsed = JSON.parse(fenced[1]); } catch {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text: raw, decision: GE.normalizeAiDecision({}, fallback), structured: false, ...defaultStep };
  const text = String(parsed.text || parsed.content || '').trim() || raw;
  const decision = GE.normalizeAiDecision(parsed, fallback);
  const aiStep = GE.normalizeAiStepResult(parsed, { outcome: fallbackOutcome });
  return { text, decision, structured: true, outcome: aiStep.outcome, damage: aiStep.damage, heal: aiStep.heal, itemUse: aiStep.itemUse, skillUse: aiStep.skillUse, loot: aiStep.loot };
}
async function callAIStory(payload, extraInstruction = '') {
  if (process.env.ROOM_FAST === '1') {
    return {
      text: '众人勘明前路，化解沿途险阻后从容归返。',
      decision: {
        phase: 'closing',
        event: 'resolve',
        questStatus: 'completed',
        encounterStatus: 'resolved',
        nextHint: '',
        continue: false,
      },
      structured: true,
      outcome: 'good',
      damage: 0,
      itemUse: null,
      skillUse: null,
      loot: [],
    };
  }
  if (!isConfigured) {
    const error = new Error('AI 未配置');
    error.aiFailure = true;
    error.code = 'ai_unconfigured';
    throw error;
  }
  const url = CONFIG.baseURL.replace(/\/+$/, '') + '/chat/completions';
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 240000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey },
        body: JSON.stringify({ model: CONFIG.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(payload) + (extraInstruction ? '\n\n' + extraInstruction : '') }], temperature: CONFIG.temperature ?? 0.85, max_tokens: CONFIG.maxTokens ?? 5000, stream: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const error = new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
        error.status = r.status;
        error.aiFailure = true;
        throw error;
      }
      const rawContent = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (!rawContent) throw new Error('AI 返回空内容');
      let text = rawContent;
      if (text.includes('\uFFFD')) throw new Error('AI 返回乱码（重试中）');
      const parsed = parseAiStoryResponse(text, { phase: payload.phase || payload.stage || 'explore', questStatus: payload.quest && payload.quest.status, encounterStatus: payload.encounter && payload.encounter.status, nextHint: payload.nextHint, needsCheck: payload.needsCheck });
      text = parsed.text;
      // 联机副本单步同样限制为 300 字，保留完整句子避免截断在句中
      const maxLength = 300;
      if (text.length > maxLength) {
        const cut = text.slice(0, maxLength);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        return {
          text: lastDot > 100 ? cut.slice(0, lastDot + 1) : cut, decision: parsed.decision, structured: parsed.structured,
          outcome: parsed.outcome, damage: parsed.damage, heal: parsed.heal, itemUse: parsed.itemUse, skillUse: parsed.skillUse, loot: parsed.loot,
        };
      }
      return { text, decision: parsed.decision, structured: parsed.structured, outcome: parsed.outcome, damage: parsed.damage, heal: parsed.heal, itemUse: parsed.itemUse, skillUse: parsed.skillUse, loot: parsed.loot };
    } catch (e) {
      lastError = e;
      if (attempt === 0) {
        console.warn(`[ai-story] 第 1 次调用失败，准备重试：${e.name === 'AbortError' ? '超时(240s)' : String(e.message || e).slice(0, 160)}`);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const failure = lastError || new Error('AI 叙事生成失败');
  failure.aiFailure = true;
  if (!failure.code && !isConfigured) failure.code = 'ai_unconfigured';
  throw failure;
}
function resolveSettlementOk(dg, aiOk) {
  return dg && dg.forcedTerminal === 'failed' ? false : aiOk;
}
/* 副本道具结算：一次性道具从原持有人库存扣除；明确借出但未消耗的道具记录归还。 */
function settleDungeonItems(dg, roleMap) {
  const consumed = [];
  const returned = [];
  const byId = roleMap && typeof roleMap.get === 'function' ? roleMap : new Map();
  const memberById = new Map((dg.party || []).flatMap(member => [
    [member.uid, member], [member.id, member], [member.charId, member],
  ].filter(([key]) => key != null)));
  const findRole = id => byId.get(id) || byId.get(String(id));
  const display = (id, role) => (role && role.name) || (memberById.get(id) && memberById.get(id).name) || '';
  const records = Array.isArray(dg.consumed) ? dg.consumed : [];
  const consumedByKey = new Map();
  for (const record of records) {
    if (!record || !record.name || record.ownerId == null) continue;
    const owner = findRole(record.ownerId);
    const qtyWanted = Math.max(1, Number(record.qty || 1));
    let qtyLeft = qtyWanted;
    let source = record.src === 'bag' ? 'bag' : record.src === 'equip' ? 'equipment' : null;
    const lists = source ? [source] : ['equipment', 'bag'];
    for (const listName of lists) {
      const list = owner && Array.isArray(owner[listName]) ? owner[listName] : [];
      const index = list.findIndex(entry => entry && entry.name === record.name && Number(entry.qty || 1) > 0);
      if (index < 0) continue;
      const entry = list[index];
      const available = Math.max(1, Number(entry.qty || 1));
      const used = Math.min(available, qtyLeft);
      const remain = available - used;
      if (remain > 0) entry.qty = remain;
      else list.splice(index, 1);
      qtyLeft -= used;
      source = listName;
      if (qtyLeft <= 0) break;
    }
    const actual = qtyWanted - qtyLeft;
    if (actual <= 0) continue;
    const item = {
      name: String(record.name), qty: actual, ownerId: record.ownerId, userId: record.userId == null ? record.ownerId : record.userId,
      ownerName: display(record.ownerId, owner), userName: display(record.userId, findRole(record.userId)),
    };
    consumed.push(item);
    const key = `${item.name}|${item.ownerId}|${item.userId}`;
    consumedByKey.set(key, (consumedByKey.get(key) || 0) + actual);
  }
  const loans = Array.isArray(dg.itemLoans) ? dg.itemLoans : (Array.isArray(dg.loans) ? dg.loans : []);
  for (const loan of loans) {
    if (!loan || !loan.loaned || !loan.name || loan.ownerId == null) continue;
    const key = `${loan.name}|${loan.ownerId}|${loan.userId == null ? '' : loan.userId}`;
    const qty = Math.max(1, Number(loan.qty || 1));
    const used = consumedByKey.get(key) || 0;
    const remain = Math.max(0, qty - used);
    if (!remain) continue;
    returned.push({
      name: String(loan.name), qty: remain, ownerId: loan.ownerId, userId: loan.userId == null ? null : loan.userId,
      ownerName: display(loan.ownerId, findRole(loan.ownerId)), userName: display(loan.userId, findRole(loan.userId)),
    });
  }
  return { consumed, returned };
}
async function settleRoom(room) {
  const dg = room.dg;
  room.status = 'settling';
  let storyText = dg.steps.map(s => `第${s.stepNo}段：${s.rawText || s.text || ''}`).join('\n');
  const spiritStoneEvents = extractSpiritStoneEvents(dg.steps);
  const totalSpiritStones = sumSpiritStones(spiritStoneEvents);
  const spiritStoneShares = splitSpiritStones(totalSpiritStones, (dg.party || []).map(member => ({ id: member.uid || member.id })));
  const runSignature = `${room.id}-${dg.startedAt || Date.now()}-${dg.steps.length}-${storyText.length}`;
  const deadNames = (dg.party || [])
    .filter(member => Number(member.hp || 0) <= 0 || member.isDead)
    .map(member => member.name)
    .filter(Boolean);
  const settlementMembers = (dg.party || []).map(member => ({
    name: String(member.name || '').trim(),
    traits: Array.isArray(member.traits) ? member.traits.map(String) : [],
  })).filter(member => member.name);
  const settlementMemberNames = settlementMembers.map(member => member.name);
  const severeInjuryCandidates = (dg.party || [])
    .filter(member => !member.isNpc && !member.isDead && Number(member.hp || 0) > 0
      && Number(member.hp || 0) <= Math.floor(Number(member.max_hp || 100) * 0.1))
    .map(member => member.name);
  const outcomeRoster = settlementMembers
    .map(member => `${member.name}（已有特质：${member.traits.join('、') || '无'}）`)
    .join('；');
  // 并行的 AI 结算（对齐单机版 Promise.all）：总结 + 成败判定 + 战利品提取
  const [summaryRaw, outcomeRaw, lootRaw, learnedSkillsRaw, deathSummary] = await Promise.all([
    callLLM(`本局编号：${runSignature}\n副本：${dg.dungeon.name}\n\n探险日志全文（必须以此为唯一依据）：\n${storyText.slice(0, 8000)}`, SUMMARY_PROMPT),
    callLLM(`队伍成员：${outcomeRoster || '未提供'}\n重伤候选：${severeInjuryCandidates.join('、') || '无'}\n\n探险日志全文：\n${storyText.slice(0, 12000)}`, OUTCOME_PROMPT, 2000),
    // 战利品提取是结构化 JSON，使用独立长度上限，避免多段明确获得记录被截断。
    callLLM('探险日志全文：\n' + storyText.slice(0, 12000), EXTRACT_LOOT_PROMPT, 2000),
    callLLM('队伍成员：' + dg.party.filter(member => !member.isNpc).map(member => member.name).join('、') + '\n\n探险日志全文：\n' + storyText.slice(0, 12000), LEARNED_SKILL_PROMPT, 2000),
    deadNames.length ? generateDeathSummary(storyText, dg.dungeon.name, deadNames).catch(error => {
      console.warn('[death-summary] AI 生成失败，使用保底文案：', error && error.message ? error.message : error);
      return fallbackDeathSummary(deadNames, dg.dungeon.name);
    }) : Promise.resolve({ overall: '', roles: [] }),
  ]);
  // 探险总结：150 字以内截断，并保留完整句子（避免切到句中导致不完整）
  let summaryText = String(summaryRaw || '').trim();
  if (!summaryText) throw new Error('AI 未返回探险总结');
  if (summaryText.length > 150) {
    const cut = summaryText.slice(0, 150);
    const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
    summaryText = lastDot > 60 ? cut.slice(0, lastDot + 1) : cut;
  }
  let aiOk = null;
  let outcomeParsed = null;
  try {
    let jsonStr = String(outcomeRaw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
    if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
    const parsed = JSON.parse(jsonStr);
    outcomeParsed = parsed;
    if (typeof parsed.ok === 'boolean') aiOk = parsed.ok;
  } catch (e) { throw new Error('AI 成败判定格式无效'); }
  if (aiOk === null) throw new Error('AI 未返回有效成败判定');
  const ok = resolveSettlementOk(dg, aiOk);
  // AI 语义提取战利品（区分"获得"与"提及"，写描述）；失败回退剧情标记
  let lootAssign = [];
  const parsedLoot = parseLootJsonLoose(lootRaw);
  if (parsedLoot === null) throw new Error('AI 战利品提取格式无效');
  lootAssign = normalizeLootItems(parsedLoot
    .filter(x => isValidLootName(String(x && x.name || '').replace(/ +/g, '').trim().slice(0, 12)))
    .map(x => {
      const name = String(x.name).replace(/ +/g, '').trim().slice(0, 12);
      const desc = String(x.desc || '').replace(/ +/g, '').trim().slice(0, 100);
      if (!name || !desc) throw new Error('AI 战利品缺少名称或描述');
      const aiEntry = (dg.aiLoot || []).find(item => item.name === name);
      const qty = Math.max(1, Math.round(Number(x.qty) || (aiEntry && aiEntry.qty) || 1));
      const rarity = ['common', 'rare', 'epic', 'legendary'].includes(x.rarity) ? x.rarity : (aiEntry && ['common', 'rare', 'epic', 'legendary'].includes(aiEntry.rarity) ? aiEntry.rarity : 'common');
      return {
        ...x,
        name,
        canonicalName: String(x.canonicalName || name).replace(/ +/g, '').trim().slice(0, 12),
        desc,
        qty,
        rarity,
      };
    }));
  let scrollItem = null;
  const scrollType = outcomeParsed && outcomeParsed.scroll && (outcomeParsed.scroll.type === '术法' ? '术法' : '功法');
  if (scrollType) {
    const raw = await callLLM('请创作一部' + scrollType + '卷轴。', SCROLL_PROMPT.replace('{type}', scrollType));
    let jsonStr = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const st = jsonStr.indexOf('{'), en = jsonStr.lastIndexOf('}');
    if (st >= 0 && en > st) jsonStr = jsonStr.slice(st, en + 1);
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.name) scrollItem = { name: String(parsed.name).slice(0, 16), desc: String(parsed.desc || '来历不明的修炼卷轴').slice(0, 80), qty: 1, rarity: 'rare' };
  }
  if (scrollItem && !lootAssign.some(item => item.name === scrollItem.name)) lootAssign.push(scrollItem);
  const ATTR_KEYS = { 体魄: 'strength', 身法: 'agility', 神识: 'intelligence', 气运: 'luck' };
  const ATTR_LABELS = { strength: '体魄', agility: '身法', intelligence: '神识', luck: '气运' };
  const statBuffsByMember = new Map();
  (Array.isArray(outcomeParsed && outcomeParsed.statBuffs) ? outcomeParsed.statBuffs : []).forEach(entry => {
    const memberName = String(entry && entry.member || '').trim();
    const attribute = ATTR_KEYS[String(entry && entry.attribute || '').trim()];
    if (memberName && attribute) statBuffsByMember.set(memberName, attribute);
  });
  const traitByMember = new Map();
  (Array.isArray(outcomeParsed && outcomeParsed.traits) ? outcomeParsed.traits : []).forEach(entry => {
    const memberName = String(entry && entry.member || '').trim();
    const member = settlementMembers.find(candidate => candidate.name === memberName);
    const normalized = GE.normalizeTraitGrant(entry, settlementMemberNames, member ? member.traits : []);
    if (normalized && !traitByMember.has(normalized.member)) traitByMember.set(normalized.member, normalized);
  });
  const injuryMemberName = String(outcomeParsed && outcomeParsed.injury && outcomeParsed.injury.member || '').trim();
  const injuryMember = settlementMembers.find(member => member.name === injuryMemberName);
  const injuryExisting = injuryMember
    ? [...injuryMember.traits, ...(traitByMember.has(injuryMemberName) ? [traitByMember.get(injuryMemberName).name] : [])]
    : [];
  const aiInjury = GE.normalizeInjuryGrant(outcomeParsed && outcomeParsed.injury, severeInjuryCandidates, injuryExisting);
  // 每件战利品只分配给一名成员；按行动、判定、暴击和伤害计算贡献权重。
  const lootMembers = dg.party.map(m => {
    const g = dg.memberGains[m.uid || m.id] || {};
    const rolls = Array.isArray(g.rolls) ? g.rolls : [];
    const avg = rolls.length ? rolls.reduce((a, b) => a + b, 0) / rolls.length : 10;
    return { id: m.uid || m.id, name: m.name, merit: Math.max(1, (g.acts || 0) + (avg - 10) * 0.4 + (g.crits || 0) * 2 - (g.fumbles || 0) * 1.5 + (g.damage || 0) / 30) };
  });
  const lootByMember = GE.assignLoot(lootAssign, lootMembers);
  const lootAudit = buildLootAudit(lootByMember);
  const expBase = 15 + dg.steps.length * 8 + lootAssign.length * 12 + (dg.breakthrough && dg.breachSuccess ? 60 : 0);
  const exp = dg.dungeon.specialEvent ? Math.round(expBase * 1.5) : expBase;
  const results = [];
  const settledPlayers = [];
  const characterWrites = [];
  const characterDeletes = [];
  const roleById = new Map();
  const charactersByMember = new Map();
  for (const member of dg.party || []) {
    if (member.isNpc || !member.uid || !member.charId) continue;
    const character = DB.getCharacter(member.uid, member.charId);
    if (character) {
      settlePassiveRecovery(character.data);
      charactersByMember.set(`${member.uid}:${member.charId}`, character);
      roleById.set(member.uid, character.data), roleById.set(member.charId, character.data);
    }
  }
  const itemSettlement = settleDungeonItems(dg, roleById);
  const partyMembers = new Set(dg.party.filter(member => !member.isNpc).map(member => member.name));
  const learnedSkillsByMember = new Map();
  for (const skill of GE.parseLearnedSkills(learnedSkillsRaw)) {
    if (!partyMembers.has(skill.member)) continue;
    const list = learnedSkillsByMember.get(skill.member) || [];
    list.push(skill);
    learnedSkillsByMember.set(skill.member, list);
  }
  for (const m of dg.party) {
    const g = dg.memberGains[m.uid || m.id] || { damage: 0, crits: 0, fumbles: 0 };
    const hpNow = m.hp || 0;
    const spiritStoneShare = spiritStoneShares[m.uid || m.id] || 0;
    const memberRes = {
      uid: m.uid || null, charId: m.charId || null,
      name: m.name, isNpc: !!m.isNpc, isMine: !m.isNpc, loot: [], lootItems: [], exp: 0, hpFinal: hpNow,
      fate: (hpNow <= 0 || m.isDead) ? '阵亡' : (hpNow <= (m.max_hp || 100) * 0.35 ? '受伤' : '健康'),
      score: 5, damage: g.damage || 0, gold: spiritStoneShare, newTraits: [], newSkills: [], praise: 0,
    };
    if (m.isNpc) {
      // AI 队友结算时可分到战利品：仅用于结算界面展示，不进入其储物袋（NPC 无持久化背包）。
      const npcLoot = lootByMember[m.uid || m.id] || [];
      memberRes.loot = npcLoot.map(x => x.name);
      memberRes.lootItems = npcLoot.map(x => ({ name: x.name, desc: x.desc || '', qty: Math.max(1, Number(x.qty || 1)), rarity: x.rarity || 'common' }));
      results.push(memberRes);
      continue;
    }
    const char = charactersByMember.get(`${m.uid}:${m.charId}`);
    if (!char) { results.push(memberRes); continue; }
    const role = char.data;
    if (hpNow <= 0 || m.isDead) {
      memberRes.fate = '阵亡';
      memberRes.score = 0;
      characterDeletes.push({ userId: m.uid, characterId: m.charId });
      settledPlayers.push({ uid: m.uid, memberRes, goldGain: spiritStoneShare, damage: g.damage });
      results.push(memberRes);
      continue;
    }
    settlePassiveRecovery(role);
    const statAttr = statBuffsByMember.get(m.name);
    if (statAttr) {
      role[statAttr] = Number(role[statAttr] || 10) + 1;
      memberRes.statBuffs = [ATTR_LABELS[statAttr] + '+1'];
    }
    const aiTrait = traitByMember.get(m.name);
    if (aiTrait && !(role.traits || []).includes(aiTrait.name)) {
      role.traits = role.traits || [];
      role.traitDescs = role.traitDescs || {};
      role.traits.push(aiTrait.name);
      role.traitDescs[aiTrait.name] = aiTrait.desc;
      memberRes.newTraits = [aiTrait];
    }
    // 道具消耗已在整队结算前按原持有人扣除；此处沿用同一对象保存。
    let leveledUp = false;
    memberRes.newSkills = GE.applyLearnedSkills(role, learnedSkillsByMember.get(m.name) || []);
    if (dg.breakthrough && dg.breachSuccess && role.level === 10) { role.level = 11; role.exp = 0; role.character_class = '筑基前期'; GE.applyLevelGrowth(role, { breakthrough: true }); leveledUp = true; }
    else {
      const levels = GE.applyExperience(role, exp);
      if (levels.length) {
        role.character_class = cultivationRealmForLevel(role.level);
        leveledUp = true;
      }
    }
    const assignedLoot = lootByMember[m.uid || m.id] || [];
    const myLoot = assignedLoot;
    myLoot.forEach(it => {
      const qty = Math.max(1, Number(it.qty || 1));
      const existing = (role.bag || []).find(b => b.name === it.name);
      if (existing) existing.qty = (existing.qty || 1) + qty;
      else role.bag.push({ name: it.name, desc: it.desc || '', qty, rarity: it.rarity || 'common' });
    });
    const goldGain = spiritStoneShare;
    role.gold = (role.gold || 0) + goldGain;
    memberRes.loot = myLoot.map(x => x.name);
    memberRes.lootItems = myLoot.map(x => ({ name: x.name, desc: x.desc || '', qty: Math.max(1, Number(x.qty || 1)), rarity: x.rarity || 'common' }));
    memberRes.exp = exp;
    memberRes.gold = goldGain;
    memberRes.score = Math.max(5, Math.min(9.5, +(5 + (g.rolls && g.rolls.length ? g.rolls.reduce((a,b)=>a+b,0)/g.rolls.length * 0.16 : 0) + (g.crits||0) * 0.3 - (g.fumbles||0) * 0.5).toFixed(1)));
    // 临时受伤特质只接受 AI 对重伤候选人的低频明确授予，持续 3 小时。
    if (aiInjury && aiInjury.member === m.name) {
      role.injury = { name: aiInjury.name, desc: aiInjury.desc, expiresAt: Date.now() + 3 * 3600 * 1000 };
      role.traits = Array.isArray(role.traits) ? role.traits : [];
      role.traitDescs = role.traitDescs && typeof role.traitDescs === 'object' ? role.traitDescs : {};
      if (!role.traits.includes(aiInjury.name)) role.traits.push(aiInjury.name);
      role.traitDescs[aiInjury.name] = aiInjury.desc;
      memberRes.newTraits.push(aiInjury);
    }
    // 结算完成：状态恢复为休息，精力回复 +30（封顶上限），气血/精力时间戳复位（与单机版一致）
    role.status = 'resting';
    role.stamina = Math.min(role.max_stamina || 100, (role.stamina || 0) + 30);
    role.staminaTs = Date.now();
    role.hpTs = Date.now();
    // 结算后气血并入真实结算值（服务端权威，m.hp 为冒险中扣血后的值）
    if (!leveledUp) role.max_hp = m.max_hp || role.max_hp || 100;
    role.hp = leveledUp ? role.max_hp : Math.min(m.hp > 0 ? m.hp : 1, role.max_hp);
    characterWrites.push({ userId: m.uid, characterId: m.charId, name: role.name, data: role });
    settledPlayers.push({ uid: m.uid, memberRes, goldGain, damage: g.damage });
    results.push(memberRes);
  }
  const deathReasonByName = new Map((deathSummary.roles || []).map(entry => [entry.name, entry.reason]));
  const memberStatuses = results.map(r => ({ name: r.name, is_mine: r.isMine, score: r.score, gold: r.gold, fate: r.fate, damage: r.damage, loot: r.lootItems, statBuffs: r.statBuffs || [], newTraits: r.newTraits, newSkills: r.newSkills, praise: 0, death_reason: r.fate === '阵亡' ? (deathReasonByName.get(r.name) || fallbackDeathSummary([r.name], dg.dungeon.name).roles[0].reason) : '' }));
  const anyDeath = results.some(r => r.fate === '阵亡');
  const participants = settledPlayers.map(settled => ({ userId: settled.uid, characterId: dg.party.find(m => m.uid === settled.uid)?.charId, memberName: settled.memberRes.name, personalData: { exp: settled.memberRes.exp, gold: settled.goldGain, items: settled.memberRes.lootItems, damage: settled.damage } }));
  const log = {
    id: DB.nextLogSeq(participants[0]?.userId || 0), run_id: dg.id, party_name: '匹配小队' + room.id, dungeon_name: dg.dungeon.name,
    log_number: dg.logNumber || undefined,
    status: anyDeath ? 'failed' : (ok ? 'completed' : 'failed'), result_summary: storyText, created_at: new Date().toISOString(),
    is_favorited: false, death: anyDeath,
    summary_text: summaryText || '', death_summary: anyDeath ? deathSummary.overall : '',
    special_event_theme: dg.dungeon.specialEvent ? '特殊事件' : '',
    dg_snapshot: { icon: dg.dungeon.icon, name: dg.dungeon.name, baseName: dg.dungeon.baseName, isHidden: !!dg.dungeon.isHidden, specialEvent: !!dg.dungeon.specialEvent, steps: dg.steps, party: dg.party.map(x => ({ name: x.name, is_mine: !x.isNpc })) },
    settlement: {
      exp,
      totalSpiritStones,
      spiritStoneEvents,
      lootAudit,
      members: memberStatuses,
      consumed: itemSettlement.consumed,
      returned: itemSettlement.returned,
    },
  };
  const committed = DB.commitExpeditionSettlement({
    runId: dg.id,
    characterWrites,
    characterDeletes,
    participants,
    log,
    snapshot: durableRunSnapshot(room),
  });
  for (const character of committed.updatedCharacters || []) {
    notifyCharacterUpdated(character.userId, character.characterId, character.updated_at);
  }
  for (const character of committed.deletedCharacters || []) {
    notifyCharacterDeleted(character.userId, character.characterId);
  }
  for (const settled of settledPlayers) settled.memberRes.logId = committed.logKey;
  for (const settled of settledPlayers) settled.memberRes.logNumber = committed.logNumber || committed.logKey;
  room.status = 'finished';
    broadcastAll({ type: 'settled', runId: dg.id, ok, summary: summaryText || '', death_summary: anyDeath ? deathSummary.overall : '', death_reasons: memberStatuses.filter(member => member.fate === '阵亡').map(member => ({ name: member.name, reason: member.death_reason })), exp, dungeon: dg.dungeon.name, results, consumed: itemSettlement.consumed, returned: itemSettlement.returned, verdict: dg.breakthrough ? (dg.breachSuccess ? 'breakthrough_ok' : 'breakthrough_fail') : (ok ? 'completed' : 'failed') });
  room.party.forEach(member => { if (!member.isNpc && member.ws) member.ws._roomId = null; });
  if (ROOMS.get(room.id) === room) ROOMS.delete(room.id);
}
function leaveRoomCleanup(ws, room) {
  if (!room) return;
  const idx = (room.party || []).findIndex(m => m.ws === ws);
  if (idx >= 0) room.party.splice(idx, 1);
  ws._roomId = null;
  if (room.status === 'waiting') {
    if (!room.party.length) ROOMS.delete(room.id);
    else {
      if (!room.party.some(member => member.uid === room.host)) room.host = room.party[0].uid;
      broadcast(room, { type: 'member_left', party: roomStatePublic(room).party });
    }
    broadcastRooms();
  }
}

/* ---------- 匹配队列：单人匹配 → 攒真人/等 2 分钟 AI 补位开本 ---------- */
const MATCH_QUEUE = [];
const MATCH_TARGET = 4;
const MATCH_MIN_REAL = 2;
const MATCH_TIMEOUT_MS = 2 * 60 * 1000;
let matchSeq = 1;
function matchPublic(m) {
  return { uid: m.uid, name: m.char ? m.char.name : '?', realm: m.char ? (m.char.character_class || '练气一层') : '', charId: m.charId, joinedAt: m.joinedAt, isAI: false };
}
function matchRemainingMs() {
  const first = MATCH_QUEUE.find(m => !m._isAI);
  return first ? Math.max(0, MATCH_TIMEOUT_MS - (Date.now() - first.joinedAt)) : 0;
}
function matchStatePayload() {
  return { type: 'match_state', queued: MATCH_QUEUE.length, remainingMs: matchRemainingMs(), members: MATCH_QUEUE.map(matchPublic) };
}
function broadcastMatches() {
  const payload = matchStatePayload();
  MATCH_QUEUE.forEach(w => { if (w.ws.readyState === 1) w.ws.send(JSON.stringify(payload)); });
}
function tryStartMatch() {
  if (!MATCH_QUEUE.length) return;
  const now = Date.now();
  const real = MATCH_QUEUE.filter(m => !m._isAI);
  const waited = now - (real[0] ? real[0].joinedAt : now);
  const forceAfterTimeout = MATCH_QUEUE.length === 1 && waited >= MATCH_TIMEOUT_MS;
  const shouldStart = MATCH_QUEUE.length >= MATCH_MIN_REAL || forceAfterTimeout;
  if (!shouldStart) return;
  const room = { id: 'M' + (matchSeq++), name: '匹配小队_' + matchSeq, host: real[0] ? real[0].uid : null, party: [], status: 'waiting', createdAt: Date.now(), dg: null };
  MATCH_QUEUE.forEach(m => {
    room.party.push({ uid: m.uid, name: m.char.name, charId: m.charId, char: m.char, ws: m.ws, isNpc: false, character_class: m.char.character_class, matched: true });
    if (m.ws) m.ws._roomId = room.id;
  });
  while (room.party.length < MATCH_TARGET) {
    const used = new Set(room.party.map(member => member && member.name));
    const available = GE.NPC_NAME_POOL.filter(name => !used.has(name));
    const name = available.length ? available[Math.floor(Math.random() * available.length)] : `无名修士${room.party.length + 1}`;
    room.party.push(makeNpcMember(name));
  }
  MATCH_QUEUE.length = 0;
  const hostChar = room.party.find(p => p.uid === room.host) || room.party[0];
  void startRoomRun(room, hostChar ? hostChar.char : null).catch(e => void failRoomRun(room, e));
}
setInterval(() => { tryStartMatch(); if (MATCH_QUEUE.length) broadcastMatches(); }, 1000);

const wss = new WebSocketServer({ server, path: '/ws' });
function notifyCharacterUpdated(userId, characterId, updatedAt) {
  const message = JSON.stringify({ type: 'character_updated', characterId, updated_at: updatedAt });
  const publicMessage = JSON.stringify({ type: 'public_characters_updated', characterId, updated_at: updatedAt });
  wss.clients.forEach(ws => {
    if (ws.readyState !== 1 || !ws._uid) return;
    if (ws._uid === userId) ws.send(message);
    else ws.send(publicMessage);
  });
}
function notifyCharacterDeleted(userId, characterId) {
  const message = JSON.stringify({ type: 'character_deleted', characterId });
  const publicMessage = JSON.stringify({ type: 'public_characters_updated', characterId, updated_at: null });
  wss.clients.forEach(ws => {
    if (ws.readyState !== 1 || !ws._uid) return;
    if (ws._uid === userId) ws.send(message);
    else ws.send(publicMessage);
  });
}

function notifyAiCompanionsUpdated() {
  const message = JSON.stringify({ type: 'ai_companions_updated', updated_at: Date.now() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(message);
  });
}
function recoverAllPassiveStats() {
  const now = Date.now();
  for (const character of DB.getAllCharacters()) {
    try {
      if (Number((character.data && character.data.hp) || 0) <= 0) {
        DB.deleteCharacter(character.id);
        notifyCharacterDeleted(character.user_id, character.id);
        continue;
      }
      if (settlePassiveRecovery(character.data, now)) {
        DB.saveCharacter(character.user_id, character.id, character.data, character.data.name);
      }
    } catch (error) {
      console.error('[recovery]', `角色 ${character.id} 被动回复失败：`, String(error.message || error).slice(0, 200));
    }
  }
}
recoverAllPassiveStats();
setInterval(recoverAllPassiveStats, 60 * 1000);
wss.on('connection', (ws, req) => {
  ws._roomId = null;
  ws._uid = null;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handleWS(ws, req, msg);
  });
  ws.on('close', () => {
    const mi = MATCH_QUEUE.findIndex(m => m.ws === ws);
    if (mi >= 0) { MATCH_QUEUE.splice(mi, 1); broadcastMatches(); }
    const room = ROOMS.get(ws._roomId);
    if (!room) return;
    if (['running', 'waiting_ai', 'settling'].includes(room.status)) {
      const idx = (room.party || []).findIndex(m => m.ws === ws);
      if (idx >= 0) { room.party[idx].ws = null; room.party[idx].online = false; }
      broadcast(room, { type: 'member_left', party: roomStatePublic(room).party });
    } else {
      leaveRoomCleanup(ws, room);
    }
  });
});

async function handleWS(ws, req, msg) {
  const send = d => { if (ws.readyState === 1) ws.send(JSON.stringify(d)); };
  switch (msg.type) {
    case 'auth': {
      const u = msg.token ? (DB.sessionUserId(msg.token) ? DB.findUserById(DB.sessionUserId(msg.token)) : null) : null;
      ws._uid = u ? u.id : 'guest-' + Math.random().toString(36).slice(2, 8);
      send({ type: 'authed', uid: ws._uid, username: u ? u.username : '游客' });
      // 刷新页面后重新绑定自己参与的副本；同时把所有进行中的副本同步给该玩家，供旁观实时观看。
      if (u) {
        for (const room of ROOMS.values()) {
          if (!['running', 'waiting_ai', 'settling'].includes(room.status) || !room.dg) continue;
          const member = (room.party || []).find(m => Number(m.uid) === Number(u.id));
          if (member) { member.ws = ws; member.online = true; ws._roomId = room.id; }
          const snapshot = runningSnapshot(room);
          if (snapshot) {
            send({ type: 'dungeon_resumed', runId: snapshot.runId, snapshot });
            if (room.status === 'waiting_ai') send({ type: 'run_waiting_ai', runId: snapshot.runId, retryAt: room._aiRetry && room._aiRetry.nextRetryAt, attempt: room._aiRetry && room._aiRetry.attempt || 0, error: room._aiRetry && room._aiRetry.lastError || '' });
          }
        }
      }
      return;
    }
    case 'ping': {
      send({ type: 'pong', at: msg.at == null ? Date.now() : msg.at });
      return;
    }
    case 'match_start': {
      const u = msg.token ? (DB.sessionUserId(msg.token) ? DB.findUserById(DB.sessionUserId(msg.token)) : null) : null;
      if (!u || !msg.charId) { send({ type: 'error', error: '请先登录并选择角色' }); return; }
      const c = DB.getCharacter(u.id, Number(msg.charId));
      if (!c) { send({ type: 'error', error: '角色不存在' }); return; }
      settlePassiveRecovery(c.data);
      const settlement = settleCultivation(c.data);
      if (settlement.changed) DB.saveCharacter(u.id, c.id, c.data, c.data.name);
      const busy = characterBusyReason(c.data);
      if (busy) { send({ type: 'error', error: busy }); return; }
      if (c.data.cultivation) { send({ type: 'error', error: '闭关期间不可匹配探险' }); return; }
      if (MATCH_QUEUE.some(m => m.uid === u.id)) { send({ type: 'error', error: '已在匹配队列中' }); return; }
      if (roomForUser(u.id)) { send({ type: 'error', error: '已在公开队伍中' }); return; }
      ws._uid = u.id;
      MATCH_QUEUE.push({ ws, token: msg.token, uid: u.id, charId: Number(c.id), char: c.data, choice: msg.choice || null, joinedAt: Date.now() });
      broadcastMatches();
      send({ type: 'match_enqueued', position: MATCH_QUEUE.length, remainingMs: matchRemainingMs() });
      return;
    }
    case 'match_cancel': {
      const idx = MATCH_QUEUE.findIndex(m => m.ws === ws);
      if (idx >= 0) MATCH_QUEUE.splice(idx, 1);
      send({ type: 'match_cancelled' });
      broadcastMatches();
      return;
    }
    case 'match_state': {
      send(matchStatePayload());
      return;
    }
    case 'rooms': {
      if (!authenticatedSocketUser(ws, msg.token)) { send({ type: 'error', error: '请先登录' }); return; }
      send({ type: 'rooms_updated', rooms: waitingRoomsPublic() });
      return;
    }
    case 'room_create': {
      const user = authenticatedSocketUser(ws, msg.token);
      const character = user && DB.getCharacter(user.id, Number(msg.charId));
      if (character) {
        settlePassiveRecovery(character.data);
        const settlement = settleCultivation(character.data);
        if (settlement.changed) DB.saveCharacter(user.id, character.id, character.data, character.data.name);
      }
      const busy = character && characterBusyReason(character.data);
      if (!character || roomForMember(ws) || roomForUser(user.id) || MATCH_QUEUE.some(entry => entry.uid === user.id)) {
        send({ type: 'error', error: '无法创建队伍' });
        return;
      }
      if (busy) { send({ type: 'error', error: busy }); return; }
      if (character.data.cultivation) { send({ type: 'error', error: '闭关期间不可创建队伍' }); return; }
      if (!validDungeonName(msg.dungeon)) { send({ type: 'error', error: '地图不存在' }); return; }
      const description = String(msg.description || '').trim();
      if (description.length > 100) { send({ type: 'error', error: '小队描述不能超过 100 字' }); return; }
      const room = {
        id: 'R' + roomSeq++,
        name: character.data.name + '的队伍',
        host: user.id,
        status: 'waiting',
        choice: msg.dungeon,
        description,
        party: [],
        createdAt: Date.now(),
      };
      addMember(room, memberFromCharacter(user.id, character, ws));
      ws._roomId = room.id;
      ROOMS.set(room.id, room);
      send({ type: 'room_state', room: roomStatePublic(room) });
      broadcastRooms();
      return;
    }
    case 'room_join': {
      const user = authenticatedSocketUser(ws, msg.token);
      const room = ROOMS.get(String(msg.roomId || ''));
      const character = user && DB.getCharacter(user.id, Number(msg.charId));
      if (character) {
        settlePassiveRecovery(character.data);
        const settlement = settleCultivation(character.data);
        if (settlement.changed) DB.saveCharacter(user.id, character.id, character.data, character.data.name);
      }
      const busy = character && characterBusyReason(character.data);
      if (!user || !character || !room || room.status !== 'waiting' || roomForMember(ws) || roomForUser(user.id)
        || MATCH_QUEUE.some(entry => entry.uid === user.id) || room.party.length >= 4
        || room.party.some(member => member.uid === user.id)) {
        send({ type: 'error', error: '无法加入队伍' });
        return;
      }
      if (busy) { send({ type: 'error', error: busy }); return; }
      if (character.data.cultivation) { send({ type: 'error', error: '闭关期间不可加入队伍' }); return; }
      addMember(room, memberFromCharacter(user.id, character, ws));
      ws._roomId = room.id;
      send({ type: 'room_state', room: roomStatePublic(room) });
      broadcastRooms();
      return;
    }
    case 'room_leave': {
      const user = authenticatedSocketUser(ws, msg.token);
      const room = roomForMember(ws);
      if (!user || !room || room.status !== 'waiting') { send({ type: 'error', error: '无法离开队伍' }); return; }
      leaveRoomCleanup(ws, room);
      send({ type: 'room_state', room: null });
      return;
    }
    case 'room_start': {
      const user = authenticatedSocketUser(ws, msg.token);
      const room = ROOMS.get(String(msg.roomId || ''));
      if (!user || !room || room.status !== 'waiting') { send({ type: 'error', error: '队伍不存在或已出发' }); return; }
      if (room.host !== user.id) { send({ type: 'error', error: '只有队长可以开始探险' }); return; }
      const host = room.party.find(member => member.uid === room.host);
      if (!host || !host.char) { send({ type: 'error', error: '队长角色不存在' }); return; }
      fillNpcs(room);
      void startRoomRun(room, host.char).catch(e => void failRoomRun(room, e));
      broadcastRooms();
      return;
    }
    case 'room_dissolve': {
      const user = authenticatedSocketUser(ws, msg.token);
      const room = ROOMS.get(String(msg.roomId || ''));
      if (!user || !room || room.status !== 'waiting') { send({ type: 'error', error: '队伍不存在或已出发' }); return; }
      if (room.host !== user.id) { send({ type: 'error', error: '只有队长可以解散队伍' }); return; }
      room.party.forEach(member => { if (member.ws) member.ws._roomId = null; });
      ROOMS.delete(room.id);
      send({ type: 'room_state', room: null });
      broadcastRooms();
      return;
    }
    default:
      send({ type: 'error', error: '未知消息类型' });
  }
}

function restorePersistedExpeditions() {
  const restoredIds = [];
  for (const run of DB.getActiveExpeditionRuns()) {
    const room = hydrateDurableRoom(run);
    if (!room || !['running', 'waiting_ai', 'settling'].includes(run.status)) continue;
    const persistedLogNumber = Number(
      (run.snapshot && run.snapshot._lifecycle && run.snapshot._lifecycle.pendingLogNumber)
      || (room.dg && room.dg.logNumber),
    );
    if (Number.isSafeInteger(persistedLogNumber) && persistedLogNumber > 0) room.dg.logNumber = persistedLogNumber;
    if (run.status === 'settling') {
      room.status = 'waiting_ai';
      room.dg.status = 'waiting_ai';
      room._aiRetry = {
        attempt: Math.max(0, Number(room._aiRetry && room._aiRetry.attempt || 0)),
        nextRetryAt: Date.now(),
        lastError: room._aiRetry && room._aiRetry.lastError || '服务器重启后继续结算',
        resumeState: 'settling',
      };
      DB.setExpeditionRunState(run.runId, 'waiting_ai', durableRunSnapshot(room), ['settling']);
    }
    ROOMS.set(room.id, room);
    restoredIds.push(run.runId);
    if (room.status === 'running') scheduleTick(room);
    else {
      const retryAt = Number(room._aiRetry && room._aiRetry.nextRetryAt || Date.now());
      scheduleAiRetry(room, Math.max(0, retryAt - Date.now()));
    }
  }
  return restoredIds;
}

const restoredRunIds = restorePersistedExpeditions();
const recovery = DB.recoverInterruptedExpeditions({ excludeRunIds: restoredRunIds });
recoverAllTaixuInsights();
setInterval(recoverAllTaixuInsights, 5000);
console.log(
  `[recovery] runs=${recovery.runs} characters=${recovery.characters} refunded=${recovery.refunded} logs=${recovery.logs} legacy=${recovery.legacyCharacters}`,
);

module.exports = {
  restorePersistedExpeditions,
};

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('  问道仙坊 · AI 探险日志服务已启动（联机版）');
  console.log('  页面：  http://localhost:' + PORT);
  console.log('  AI 配置：' + (isConfigured ? CONFIG.model + ' @ ' + CONFIG.baseURL : '未配置（将使用本地叙事引擎）'));
  console.log('==========================================');
});
