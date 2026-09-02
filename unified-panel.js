'use strict';

/*
 * 统一控制台：单进程同时监管「问道仙坊」与「DNF」两套网页服务。
 *
 * 早先的做法是一个静态页靠 iframe 嵌入 8790/8791 两个子控制台，必须先手工把
 * 它们起起来。这里直接在本进程内为每个游戏建一个 service-supervisor，
 * 打开页面即可用，不依赖任何前置步骤。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createServiceSupervisor } = require('./service-supervisor');
const { loadRuntimeState, saveRuntimeState, redact, parseBoolean } = require('./control-runtime');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const BODY_LIMIT = 32 * 1024;
const DEFAULT_PORT = 8792;

// 读取某个游戏目录下的 .env。不写入 process.env：两个游戏各有一份
// AI_API_KEY / TAVERN_DB_PATH，混进本进程会互相污染。
function readEnvFile(rootDir) {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(rootDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[unified] 无法读取 ${rootDir}\\.env：${error.message}`);
  }
  return env;
}

// 把本目录 .env 里的 UNIFIED_* 灌进 process.env，否则双击启动时面板自身的
// 配置（端口/主机/密码/UNIFIED_GAMES）全部读不到。只取 UNIFIED_ 前缀：其余键是
// 两个游戏各自的 AI_API_KEY / TAVERN_DB_PATH，进了父进程就会被子进程继承。
// 与 server.js 一致，已设置的系统环境变量优先。
function loadPanelEnv(rootDir = __dirname) {
  const fileEnv = readEnvFile(rootDir);
  for (const [key, value] of Object.entries(fileEnv)) {
    // 面板自身配置：UNIFIED_* 与站点网关的 GATEWAY_*。游戏自己的键（PORT、
    // AI_API_KEY、TAVERN_DB_PATH…）由各自的 .env 单独读，不要搬进本进程。
    if (!key.startsWith('UNIFIED_') && !key.startsWith('GATEWAY_')) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

// 子进程的环境：从本进程 env 里剥掉所有游戏相关变量，再叠上该游戏自己的 .env。
// 否则 DNF 的 TAVERN_DB_PATH=./dnf.db 会被 xiuxian 子进程继承 —— server.js
// 只填补「尚未设置」的变量，继承来的值优先，且相对路径按各自 cwd 解析，
// 结果是问道仙坊悄悄连到一个 dnf.db 上。
const GAME_ENV_KEYS = [
  'PORT', 'GAME_PORT', 'CONTROL_PANEL_PORT', 'CONTROL_PANEL_PASSWORD',
  'ADMIN_PASSWORD', 'TAVERN_DB_PATH', 'DB_PATH', 'AI_ENABLED',
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_MAX_TOKENS', 'AI_TEMPERATURE',
];

// 去掉游戏专属键，防止一个游戏的 AI_API_KEY / TAVERN_DB_PATH 漏进另一个的子进程。
function baseChildEnv() {
  const base = { ...process.env };
  for (const key of GAME_ENV_KEYS) delete base[key];
  return base;
}

function buildChildEnv(game) {
  return { ...baseChildEnv(), ...game.env, PORT: String(game.gamePort), GAME_PORT: String(game.gamePort) };
}

function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(Object.assign(new Error('请求格式无效'), { code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 把 UNIFIED_GAMES 里的一项规整成内部 spec。对外字段用 id/dir/port/entry，
// 同时兼容内部写法 key/rootDir/fallbackPort，两种都能认。
function normalizeGameSpec(raw, index, dnfRoot) {
  if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 项不是对象`);
  const key = String(raw.id ?? raw.key ?? '').trim();
  if (!key) throw new Error(`第 ${index + 1} 项缺少 id`);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`id「${key}」只能用字母、数字、下划线和连字符`);
  const dir = raw.dir ?? raw.rootDir;
  if (!dir) throw new Error(`游戏「${key}」缺少 dir`);
  const port = Number(raw.port ?? raw.fallbackPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`游戏「${key}」的 port 无效：${raw.port ?? raw.fallbackPort}`);
  const entry = String(raw.entry || 'server.js');
  if (path.isAbsolute(entry) || entry.includes('..')) throw new Error(`游戏「${key}」的 entry 必须是目录内的相对路径`);
  return {
    key,
    name: String(raw.name || key),
    rootDir: path.resolve(dnfRoot, String(dir)),
    fallbackPort: port,
    entry,
  };
}

// 解析游戏清单。优先 options.games，其次 UNIFIED_GAMES（单行 JSON 数组），
// 最后回落到内置的「问道仙坊 + DNF」；xiuxian 目录另可用 XIUXIAN_ROOT 覆盖。
function resolveGames(options = {}, env = process.env) {
  const dnfRoot = options.rootDir || __dirname;
  if (Array.isArray(options.games) && options.games.length) {
    return options.games.map((raw, i) => normalizeGameSpec(raw, i, dnfRoot));
  }
  const configured = (env.UNIFIED_GAMES || '').trim();
  if (configured) {
    let parsed;
    try {
      parsed = JSON.parse(configured);
    } catch (error) {
      throw new Error(`UNIFIED_GAMES 不是合法 JSON：${error.message}`);
    }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('UNIFIED_GAMES 必须是非空 JSON 数组');
    const specs = parsed.map((raw, i) => normalizeGameSpec(raw, i, dnfRoot));
    const seen = new Set();
    for (const spec of specs) {
      if (seen.has(spec.key)) throw new Error(`UNIFIED_GAMES 里 id「${spec.key}」重复`);
      seen.add(spec.key);
    }
    return specs;
  }
  const xiuxianRoot = path.resolve(env.XIUXIAN_ROOT || path.join(dnfRoot, 'xiuxian'));
  return [
    { key: 'xiuxian', name: '问道仙坊', rootDir: xiuxianRoot, fallbackPort: 8787, entry: 'server.js' },
    { key: 'dnf', name: 'DNF', rootDir: dnfRoot, fallbackPort: 8788, entry: 'server.js' },
  ];
}

function createUnifiedPanel(options = {}) {
  const env = options.env || process.env;
  const host = options.host || env.UNIFIED_PANEL_HOST || '127.0.0.1';
  const configuredPort = Number(options.port ?? env.UNIFIED_PANEL_PORT ?? DEFAULT_PORT);
  const autoStart = options.autoStart !== undefined
    ? options.autoStart !== false
    : !/^(false|0|no|off)$/i.test(String(env.UNIFIED_AUTO_START || '').trim());
  const sessions = new Map();
  const operationLogs = [];
  let server = null;
  let address = null;

  function log(level, message, scope = 'unified') {
    operationLogs.push({ at: Date.now(), service: 'control', scope, level, message: redact(message).slice(0, 1000) });
    while (operationLogs.length > 500) operationLogs.shift();
  }

  // 每个游戏一套 supervisor + 独立 runtime-state.json。
  const games = resolveGames(options, env).map(spec => {
    const gameEnv = readEnvFile(spec.rootDir);
    const entryPath = path.join(spec.rootDir, spec.entry || 'server.js');
    const available = fs.existsSync(entryPath);
    const gamePort = Number(spec.gamePort ?? gameEnv.GAME_PORT ?? gameEnv.PORT ?? spec.fallbackPort);
    const game = {
      key: spec.key,
      name: spec.name,
      rootDir: spec.rootDir,
      env: gameEnv,
      gamePort,
      available,
      stateFile: path.join(spec.rootDir, 'runtime-state.json'),
      runtimeState: loadRuntimeState(path.join(spec.rootDir, 'runtime-state.json'), gameEnv),
      supervisor: null,
    };
    if (!available) {
      log('error', `${spec.name} 目录不可用：${entryPath} 不存在`, spec.key);
      return game;
    }
    game.supervisor = spec.supervisor || createServiceSupervisor({
      rootDir: spec.rootDir,
      serverScript: entryPath,
      port: gamePort,
      spawnEnv: buildChildEnv(game),
    });
    return game;
  });

  const gameByKey = new Map(games.map(game => [game.key, game]));

  // 站点网关：把 xiuxiangame.dpdns.org/dnf 这类路径前缀剥掉再转发给对应游戏。
  // 只在开启时才拉起，关掉就退回「一个游戏一个子域名」的老路子。
  const gatewayEnabled = /^(1|true|yes|on)$/i.test(String(env.UNIFIED_GATEWAY || '').trim());
  const panelRoot = options.rootDir || __dirname;
  const gatewayScript = path.join(panelRoot, 'site-gateway.js');
  const gateway = gatewayEnabled && fs.existsSync(gatewayScript)
    ? createServiceSupervisor({
      rootDir: panelRoot,
      serverScript: gatewayScript,
      // 变量名要跟 site-gateway.js 实际读的一致：GATEWAY_PORT / GATEWAY_HOST / GATEWAY_SITES。
      port: Number(env.GATEWAY_PORT || 8786),
      spawnEnv: {
        ...baseChildEnv(),
        GATEWAY_PORT: String(env.GATEWAY_PORT || 8786),
        GATEWAY_HOST: env.GATEWAY_HOST || '127.0.0.1',
        ...(env.GATEWAY_SITES ? { GATEWAY_SITES: env.GATEWAY_SITES } : {}),
      },
      // 网关没有 /api/health 端点，默认健康检查会一路 404，把刚拉起的网关
      // 当成启动失败强杀掉（health_timeout）。改打它的首页，200 即健康。
      healthCheck: async ({ host, port }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
          const response = await fetch(`http://${host}:${port}/`, { signal: controller.signal });
          return response.ok;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      },
    })
    : null;
  if (gatewayEnabled && !gateway) {
    log('error', `站点网关已开启但找不到 ${gatewayScript}`, 'unified');
  }

  // 网关的上游路由，供界面展示。复用 site-gateway.js 的解析逻辑，保证
  // 面板显示的前缀→端口与网关进程实际转发时看到的完全一致。
  let gatewaySites = [];
  try {
    gatewaySites = require('./site-gateway.js').parseSites(env);
  } catch (_) {
    gatewaySites = [];
  }

  function gatewayStatus() {
    const port = Number(env.GATEWAY_PORT || 8786);
    if (!gateway) {
      return {
        enabled: false,
        name: '站点网关',
        rootDir: gatewayScript,
        port,
        available: false,
        server: null,
        sites: [],
      };
    }
    return {
      enabled: true,
      name: '站点网关',
      rootDir: gatewayScript,
      port,
      available: true,
      server: gateway.getStatus(),
      sites: gatewaySites,
    };
  }

  function aiConfigured(game) {
    return !!(game.env.AI_BASE_URL && game.env.AI_MODEL && game.env.AI_API_KEY);
  }

  function gameStatus(game) {
    return {
      id: game.key,      // 对外用 id
      key: game.key,     // 向后兼容保留 key
      name: game.name,
      rootDir: game.rootDir,
      available: game.available,
      gamePort: game.gamePort,
      server: game.supervisor ? game.supervisor.getStatus() : { state: 'unavailable', pid: null, port: game.gamePort },
      ai: {
        enabled: !!game.runtimeState.aiEnabled,
        version: game.runtimeState.version,
        updatedAt: game.runtimeState.updatedAt,
        model: game.env.AI_MODEL || '',
        configured: aiConfigured(game),
      },
    };
  }

  function statusPayload() {
    return {
      controller: { state: 'running', host, port: address ? address.port : configuredPort },
      games: games.map(gameStatus),
      gateway: gatewayStatus(),
      updatedAt: Date.now(),
    };
  }

  // AI 热切换沿用现成的 runtime_config / runtime_config_ack IPC 握手。
  function waitForAck(game, version, timeoutMs = 1500) {
    if (!game.supervisor || typeof game.supervisor.onMessage !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
      let done = false;
      const unsubscribe = game.supervisor.onMessage(message => {
        if (!message || message.type !== 'runtime_config_ack' || Number(message.version) !== version) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(true);
      });
      const timer = setTimeout(() => {
        if (done) return;
        unsubscribe();
        resolve(false);
      }, timeoutMs);
    });
  }

  async function applyAiEnabled(game, enabled) {
    const next = {
      ...game.runtimeState,
      aiEnabled: !!enabled,
      version: (Number(game.runtimeState.version) || 0) + 1,
      updatedAt: Date.now(),
    };
    const ackPromise = waitForAck(game, next.version);
    const sent = game.supervisor?.send?.({ type: 'runtime_config', version: next.version, aiEnabled: next.aiEnabled });
    if (!sent) throw Object.assign(new Error('网页服务未由控制器接管，无法热切换 AI'), { code: 'service_unmanaged' });
    if (!(await ackPromise)) throw Object.assign(new Error('网页服务未确认 AI 配置'), { code: 'runtime_ack_timeout' });
    game.runtimeState = next;
    saveRuntimeState(game.stateFile, next);
    log('info', `AI 已${next.aiEnabled ? '启用' : '停用'}，版本 ${next.version}`, game.key);
    return next;
  }

  // 服务启动后把当前 AI 开关推给新子进程，否则重启会丢掉之前的停用状态。
  async function syncAiStateAfterStart(game) {
    const version = Math.max(0, Number(game.runtimeState.version) || 0) + 1;
    const next = { ...game.runtimeState, version, updatedAt: Date.now(), lastOperation: { type: 'server_start_sync', at: Date.now() } };
    const ackPromise = waitForAck(game, version);
    const sent = game.supervisor?.send?.({ type: 'runtime_config', version, aiEnabled: next.aiEnabled });
    if (!sent || !(await ackPromise)) {
      log('warn', '网页服务已启动，但 AI 运行状态未完成同步', game.key);
      return false;
    }
    game.runtimeState = next;
    saveRuntimeState(game.stateFile, next);
    return true;
  }

  async function serverAction(game, action) {
    if (!game.supervisor) throw Object.assign(new Error(`${game.name} 目录不可用`), { code: 'game_unavailable' });
    if (action === 'start') {
      const result = await game.supervisor.start();
      await syncAiStateAfterStart(game);
      return result;
    }
    if (action === 'stop') return game.supervisor.stop();
    if (action === 'restart') {
      const result = await game.supervisor.restart();
      await syncAiStateAfterStart(game);
      return result;
    }
    throw Object.assign(new Error('未知操作'), { code: 'unknown_action' });
  }

  function newSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessions.set(token, { csrfToken, expiresAt });
    return { token, csrfToken, expiresAt };
  }

  function localOrigin(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    try {
      return ['127.0.0.1', 'localhost'].includes(new URL(origin).hostname);
    } catch (_) { return false; }
  }

  function authenticated(req) {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    const session = match && sessions.get(match[1]);
    if (!session || session.expiresAt <= Date.now()) {
      if (match) sessions.delete(match[1]);
      return null;
    }
    if (!constantTimeEqual(req.headers['x-csrf-token'], session.csrfToken)) return null;
    return session;
  }

  // 统一密码：优先 UNIFIED_PANEL_PASSWORD，回落到 CONTROL_PANEL_PASSWORD，
  // 这样不必为统一控制台单独配一份。两者都看环境变量和本目录 .env 两处 ——
  // 认的是「面板自己的目录」，不是某个叫 dnf 的游戏，否则重配 UNIFIED_GAMES
  // 时回落会无声失效。
  const panelEnvFile = readEnvFile(options.rootDir || __dirname);
  const password = String(
    options.password
      ?? env.UNIFIED_PANEL_PASSWORD
      ?? env.CONTROL_PANEL_PASSWORD
      ?? panelEnvFile.UNIFIED_PANEL_PASSWORD
      ?? panelEnvFile.CONTROL_PANEL_PASSWORD
      ?? '',
  ).trim();

  async function batchAction(action) {
    const targets = games.filter(game => game.supervisor);
    const results = await Promise.allSettled(targets.map(game => serverAction(game, action)));
    return targets.map((game, index) => {
      const outcome = results[index];
      return {
        key: game.key,
        name: game.name,
        ok: outcome.status === 'fulfilled',
        error: outcome.status === 'rejected' ? String(outcome.reason?.message || outcome.reason) : '',
      };
    });
  }

  async function handleAPI(req, res, pathname) {
    if (pathname === '/api/control/health' && req.method === 'GET') {
      sendJSON(res, 200, {
        ok: true,
        controller: 'running',
        games: games.map(game => ({ key: game.key, state: game.supervisor ? game.supervisor.getStatus().state : 'unavailable' })),
        gateway: gateway ? gateway.getStatus().state : 'disabled',
      });
      return true;
    }
    if (pathname === '/api/control/login' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (error) { sendJSON(res, 400, { ok: false, error: error.message }); return true; }
      if (!password || !constantTimeEqual(body.password, password)) {
        sendJSON(res, 401, { ok: false, error: '控制台密码错误' });
        return true;
      }
      sendJSON(res, 200, { ok: true, ...newSession() });
      return true;
    }
    if (!pathname.startsWith('/api/control/')) return false;

    const session = authenticated(req);
    if (!session) { sendJSON(res, 401, { ok: false, error: '控制台未授权' }); return true; }
    if (!localOrigin(req)) { sendJSON(res, 403, { ok: false, error: '仅允许本机控制台请求' }); return true; }

    if (pathname === '/api/control/status' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, status: statusPayload() });
      return true;
    }

    if (pathname === '/api/control/logs' && req.method === 'GET') {
      const url = new URL(req.url, `http://${host}`);
      const scope = url.searchParams.get('game') || 'all';
      const level = url.searchParams.get('level') || 'all';
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 120)));
      const merged = [...operationLogs];
      for (const game of games) {
        if (!game.supervisor) continue;
        for (const entry of game.supervisor.getLogs({ level: 'all', limit: 500 })) {
          merged.push({ ...entry, scope: game.key });
        }
      }
      if (gateway) {
        for (const entry of gateway.getLogs({ level: 'all', limit: 500 })) {
          merged.push({ ...entry, scope: 'gateway' });
        }
      }
      const logs = merged
        .filter(entry => (scope === 'all' || entry.scope === scope) && (level === 'all' || entry.level === level))
        .sort((a, b) => a.at - b.at)
        .slice(-limit);
      sendJSON(res, 200, { ok: true, logs });
      return true;
    }

    // 批量：/api/control/all/server/{start|stop|restart}
    const batchMatch = pathname.match(/^\/api\/control\/all\/server\/(start|stop|restart)$/);
    if (batchMatch && req.method === 'POST') {
      const results = await batchAction(batchMatch[1]);
      const failed = results.filter(item => !item.ok);
      log('info', `批量${batchMatch[1]}：成功 ${results.length - failed.length}/${results.length}`);
      sendJSON(res, failed.length === results.length && results.length ? 500 : 200, {
        ok: failed.length === 0,
        results,
        status: statusPayload(),
        updatedAt: Date.now(),
      });
      return true;
    }

    // 网关：/api/control/gateway/server/{start|stop|restart}
    const gatewayMatch = pathname.match(/^\/api\/control\/gateway\/server\/(start|stop|restart)$/);
    if (gatewayMatch && req.method === 'POST') {
      try {
        if (!gateway) {
          throw Object.assign(new Error('站点网关未开启（请在 .env 设 UNIFIED_GATEWAY=true）'), { code: 'gateway_disabled' });
        }
        const result = await gateway[gatewayMatch[1]]();
        log('info', `站点网关 ${gatewayMatch[1]} 完成`, 'gateway');
        sendJSON(res, 200, { ok: true, status: result, updatedAt: Date.now() });
      } catch (error) {
        log('error', `站点网关 ${gatewayMatch[1]} 失败：${error.message}`, 'gateway');
        const conflict = error.code === 'operation_in_progress' || error.code === 'gateway_disabled';
        sendJSON(res, conflict ? 409 : 500, {
          ok: false, code: error.code || 'gateway_failed', error: error.message,
        });
      }
      return true;
    }

    const scoped = pathname.match(/^\/api\/control\/game\/([A-Za-z0-9_-]+)\/(.+)$/);
    if (scoped) {
      const game = gameByKey.get(scoped[1]);
      if (!game) { sendJSON(res, 404, { ok: false, error: '未知游戏' }); return true; }
      const rest = scoped[2];

      const actionMatch = rest.match(/^server\/(start|stop|restart)$/);
      if (actionMatch && req.method === 'POST') {
        try {
          const result = await serverAction(game, actionMatch[1]);
          log('info', `${game.name} ${actionMatch[1]} 完成`, game.key);
          sendJSON(res, 200, { ok: true, operationId: `op-${Date.now()}`, status: result, updatedAt: Date.now() });
        } catch (error) {
          log('error', `${game.name} ${actionMatch[1]} 失败：${error.message}`, game.key);
          // 目录不可用和操作冲突都是请求本身的问题，报 409；500 留给真正的服务端故障。
          const conflict = error.code === 'operation_in_progress' || error.code === 'game_unavailable';
          sendJSON(res, conflict ? 409 : 500, {
            ok: false, code: error.code || 'operation_failed', error: error.message,
          });
        }
        return true;
      }

      if (rest === 'ai/toggle' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          if (typeof body.enabled !== 'boolean') { sendJSON(res, 400, { ok: false, error: 'enabled 必须是布尔值' }); return true; }
          const next = await applyAiEnabled(game, body.enabled);
          sendJSON(res, 200, { ok: true, status: next, updatedAt: next.updatedAt });
        } catch (error) {
          log('error', `${game.name} AI 切换失败：${error.message}`, game.key);
          const conflict = error.code === 'service_unmanaged'
            || error.code === 'runtime_ack_timeout'
            || error.code === 'game_unavailable';
          sendJSON(res, conflict ? 409 : 500, {
            ok: false, code: error.code || 'ai_toggle_failed', error: error.message,
          });
        }
        return true;
      }

      if (rest === 'ai/reload' && req.method === 'POST') {
        try {
          game.env = readEnvFile(game.rootDir);
          const next = await applyAiEnabled(game, game.runtimeState.aiEnabled);
          game.runtimeState = { ...next, lastOperation: { type: 'ai_reload', at: Date.now() } };
          saveRuntimeState(game.stateFile, game.runtimeState);
          sendJSON(res, 200, { ok: true, status: game.runtimeState, configured: aiConfigured(game), updatedAt: Date.now() });
        } catch (error) {
          sendJSON(res, 409, { ok: false, code: error.code || 'ai_reload_failed', error: error.message });
        }
        return true;
      }

      if (rest === 'ai/check' && req.method === 'POST') {
        const reachable = game.supervisor?.getStatus().state === 'running';
        sendJSON(res, reachable ? 200 : 503, {
          ok: reachable, reachable, checkedAt: Date.now(), error: reachable ? '' : '网页服务未运行',
        });
        return true;
      }
    }

    sendJSON(res, 404, { ok: false, error: '控制器接口不存在' });
    return true;
  }

  async function requestHandler(req, res) {
    const url = new URL(req.url, `http://${host}`);
    if (await handleAPI(req, res, url.pathname)) return;
    if (req.method !== 'GET') { sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' }); return; }
    const file = url.pathname === '/' ? 'unified-control.html' : url.pathname.slice(1);
    const allowed = new Set(['unified-control.html', 'unified-control-ui.js', 'control-panel.css']);
    if (!allowed.has(file)) { sendJSON(res, 404, { ok: false, error: 'Not Found' }); return; }
    try {
      const content = fs.readFileSync(path.join(__dirname, file));
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(content);
    } catch (_) { sendJSON(res, 404, { ok: false, error: 'Not Found' }); }
  }

  return {
    start: async () => {
      if (server) return address;
      if (!password) {
        throw Object.assign(
          new Error('未设置统一控制台密码：请在 .env 里配置 UNIFIED_PANEL_PASSWORD 或 CONTROL_PANEL_PASSWORD'),
          { code: 'password_missing' },
        );
      }
      server = http.createServer((req, res) => { void requestHandler(req, res); });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, host, () => {
          server.removeListener('error', reject);
          const bound = server.address();
          address = {
            host: bound && bound.address ? bound.address : host,
            port: bound && bound.port ? bound.port : configuredPort,
          };
          resolve();
        });
      });
      if (autoStart) {
        // 打开即可用：两个游戏服务由本进程拉起，不需要任何前置步骤。
        // 串行启动，避免两次 netstat 探测和健康检查互相干扰。
        for (const game of games) {
          if (!game.supervisor) continue;
          try {
            await serverAction(game, 'start');
            log('info', `${game.name} 已自动启动（端口 ${game.gamePort}）`, game.key);
          } catch (error) {
            log('error', `${game.name} 自动启动失败：${error.message}`, game.key);
          }
        }
        // 网关放在游戏之后：它只做转发，上游先就绪能少几条连接失败日志。
        if (gateway) {
          try {
            await gateway.start();
            log('info', `站点网关已启动（端口 ${env.GATEWAY_PORT || 8786}）`, 'unified');
          } catch (error) {
            log('error', `站点网关启动失败：${error.message}`, 'unified');
          }
        }
      }
      return address;
    },
    close: async () => {
      if (server) await new Promise(resolve => server.close(() => resolve()));
      server = null;
      address = null;
      await gateway?.close?.();
      for (const game of games) await game.supervisor?.close?.();
      sessions.clear();
    },
    getStatus: statusPayload,
    getGames: () => games,
  };
}

if (require.main === module) {
  if (process.env.UNIFIED_LOAD_ENV !== '0') loadPanelEnv();

  let panel;
  try {
    // 配置错误（UNIFIED_GAMES 之类）在构造期就抛，这里兜住，只给一行人话而非堆栈。
    panel = createUnifiedPanel();
  } catch (error) {
    console.error('[unified] 配置错误：', error.message);
    process.exit(1);
  }

  panel.start().then(address => {
    console.log(`[unified] 统一控制台已启动：http://${address.host}:${address.port}`);
    for (const game of panel.getGames()) {
      const state = game.supervisor ? game.supervisor.getStatus().state : '目录不可用';
      console.log(`  - ${game.name}：${game.rootDir}（端口 ${game.gamePort}）→ ${state}`);
    }
  }).catch(error => {
    console.error('[unified]', error.message);
    process.exitCode = 1;
  });

  const shutdown = () => { panel.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createUnifiedPanel, resolveGames, buildChildEnv, loadPanelEnv, GAME_ENV_KEYS };




