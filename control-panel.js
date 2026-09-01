'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createServiceSupervisor } = require('./service-supervisor');
const { loadRuntimeState, saveRuntimeState, redact } = require('./control-runtime');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const BODY_LIMIT = 32 * 1024;

function loadLocalEnv(rootDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  try {
    const text = fs.readFileSync(path.join(rootDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[control-env] 无法读取 .env：', error.message);
  }
  return env;
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

function createControlPanel(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const runtimeEnv = loadLocalEnv(rootDir, options.env || process.env);
  const host = options.host || '127.0.0.1';
  // 兜底端口必须是 DNF 自己的 8791/8788，不能沿用原游戏 xiuxian 的 8790/8787：
  // .env 不入库，缺失时回落到 8790/8787 会直接和原游戏的控制台与网页服务抢端口。
  const configuredPort = Number(options.port ?? runtimeEnv.CONTROL_PANEL_PORT ?? 8791);
  const gamePort = Number(options.gamePort ?? runtimeEnv.GAME_PORT ?? runtimeEnv.PORT ?? 8788);
  const password = String(options.password ?? runtimeEnv.CONTROL_PANEL_PASSWORD ?? '').trim();
  const stateFile = options.stateFile || path.join(rootDir, 'runtime-state.json');
  const supervisor = options.supervisor || createServiceSupervisor({
    rootDir,
    serverScript: path.join(rootDir, 'server.js'),
    port: gamePort,
  });
  const autoStart = options.autoStart !== false;
  const sessions = new Map();
  const operationLogs = [];
  let runtimeState = loadRuntimeState(stateFile, runtimeEnv);
  let server = null;
  let address = null;

  function log(level, message) {
    operationLogs.push({ at: Date.now(), service: 'control', level, message: redact(message).slice(0, 1000) });
    while (operationLogs.length > 500) operationLogs.shift();
  }

  function newSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, csrfToken, expiresAt: Date.now() + SESSION_TTL_MS };
  }

  function localOrigin(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return ['127.0.0.1', 'localhost'].includes(parsed.hostname);
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

  function statusPayload() {
    const serverStatus = supervisor.getStatus();
    return {
      controller: { state: 'running', host, port: address ? address.port : configuredPort },
      server: serverStatus,
      ai: { enabled: runtimeState.aiEnabled, version: runtimeState.version, updatedAt: runtimeState.updatedAt },
      updatedAt: Date.now(),
    };
  }

  function waitForAck(version, timeoutMs = 1500) {
    if (typeof supervisor.onMessage !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
      let done = false;
      const unsubscribe = supervisor.onMessage(message => {
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

  async function applyAiEnabled(enabled) {
    const next = { ...runtimeState, aiEnabled: !!enabled, version: runtimeState.version + 1, updatedAt: Date.now() };
    const ackPromise = waitForAck(next.version);
    const sent = supervisor.send?.({ type: 'runtime_config', version: next.version, aiEnabled: next.aiEnabled });
    if (!sent) throw Object.assign(new Error('网页服务未由控制器接管，无法热切换 AI'), { code: 'service_unmanaged' });
    if (!(await ackPromise)) throw Object.assign(new Error('网页服务未确认 AI 配置'), { code: 'runtime_ack_timeout' });
    runtimeState = next;
    saveRuntimeState(stateFile, runtimeState);
    log('info', `AI 已${next.aiEnabled ? '启用' : '停用'}，版本 ${next.version}`);
    return next;
  }

  async function syncAiStateAfterStart() {
    const nextVersion = Math.max(0, Number(runtimeState.version) || 0) + 1;
    const next = {
      ...runtimeState,
      version: nextVersion,
      updatedAt: Date.now(),
      lastOperation: { type: 'server_start_sync', at: Date.now() },
    };
    const ackPromise = waitForAck(nextVersion);
    const sent = supervisor.send?.({ type: 'runtime_config', version: nextVersion, aiEnabled: next.aiEnabled });
    if (!sent || !(await ackPromise)) {
      log('warn', '网页服务已启动，但 AI 运行状态未完成同步');
      return false;
    }
    runtimeState = next;
    saveRuntimeState(stateFile, runtimeState);
    return true;
  }

  async function handleAPI(req, res, pathname) {
    if (pathname === '/api/control/health' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, controller: 'running', server: supervisor.getStatus().state });
      return true;
    }
    if (pathname === '/api/control/login' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (error) { sendJSON(res, 400, { ok: false, error: error.message }); return true; }
      if (!password || !constantTimeEqual(body.password, password)) { sendJSON(res, 401, { ok: false, error: '控制台密码错误' }); return true; }
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
      const service = url.searchParams.get('service') || 'all';
      const level = url.searchParams.get('level') || 'all';
      const limit = Number(url.searchParams.get('limit') || 100);
      const logs = [...operationLogs, ...supervisor.getLogs({ service, level, limit })]
        .filter(entry => (service === 'all' || entry.service === service) && (level === 'all' || entry.level === level))
        .sort((a, b) => a.at - b.at)
        .slice(-Math.max(1, Math.min(500, limit)));
      sendJSON(res, 200, { ok: true, logs });
      return true;
    }

    const operation = {
      '/api/control/server/start': async () => {
        const result = await supervisor.start();
        await syncAiStateAfterStart();
        return result;
      },
      '/api/control/server/stop': () => supervisor.stop(),
      '/api/control/server/restart': () => supervisor.restart(),
    }[pathname];
    if (operation && req.method === 'POST') {
      try {
        const result = await operation();
        log('info', `${pathname} 完成`);
        sendJSON(res, 200, { ok: true, operationId: `op-${Date.now()}`, status: result, updatedAt: Date.now() });
      } catch (error) {
        log('error', `${pathname} 失败：${error.message}`);
        sendJSON(res, error.code === 'operation_in_progress' ? 409 : 500, { ok: false, code: error.code || 'operation_failed', error: error.message });
      }
      return true;
    }

    if (pathname === '/api/control/ai/toggle' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (typeof body.enabled !== 'boolean') { sendJSON(res, 400, { ok: false, error: 'enabled 必须是布尔值' }); return true; }
        const next = await applyAiEnabled(body.enabled);
        sendJSON(res, 200, { ok: true, operationId: `op-${Date.now()}`, status: next, updatedAt: next.updatedAt });
      } catch (error) {
        log('error', `AI 切换失败：${error.message}`);
        sendJSON(res, error.code === 'service_unmanaged' || error.code === 'runtime_ack_timeout' ? 409 : 500, { ok: false, code: error.code || 'ai_toggle_failed', error: error.message });
      }
      return true;
    }

    if (pathname === '/api/control/ai/reload' && req.method === 'POST') {
      try {
        const env = runtimeEnv;
        const next = await applyAiEnabled(runtimeState.aiEnabled);
        runtimeState = { ...next, updatedAt: Date.now(), lastOperation: { type: 'ai_reload', at: Date.now() } };
        saveRuntimeState(stateFile, runtimeState);
        sendJSON(res, 200, { ok: true, operationId: `op-${Date.now()}`, status: runtimeState, updatedAt: runtimeState.updatedAt, configured: !!(env.AI_BASE_URL && env.AI_MODEL && env.AI_API_KEY) });
      } catch (error) {
        sendJSON(res, 409, { ok: false, code: error.code || 'ai_reload_failed', error: error.message });
      }
      return true;
    }

    if (pathname === '/api/control/ai/check' && req.method === 'POST') {
      const serverStatus = supervisor.getStatus();
      const reachable = serverStatus.state === 'running';
      sendJSON(res, reachable ? 200 : 503, { ok: reachable, reachable, checkedAt: Date.now(), error: reachable ? '' : '网页服务未运行' });
      return true;
    }
    sendJSON(res, 404, { ok: false, error: '控制器接口不存在' });
    return true;
  }

  async function requestHandler(req, res) {
    const url = new URL(req.url, `http://${host}`);
    if (await handleAPI(req, res, url.pathname)) return;
    if (req.method !== 'GET') { sendJSON(res, 405, { ok: false, error: 'Method Not Allowed' }); return; }
    const file = url.pathname === '/' ? 'control-panel.html' : url.pathname.slice(1);
    const allowed = new Set(['control-panel.html', 'control-panel.css', 'control-panel-ui.js']);
    if (!allowed.has(file)) { sendJSON(res, 404, { ok: false, error: 'Not Found' }); return; }
    try {
      const content = fs.readFileSync(path.join(rootDir, file));
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(content);
    } catch (_) { sendJSON(res, 404, { ok: false, error: 'Not Found' }); }
  }

  return {
    start: async () => {
      if (server) return address;
      server = http.createServer((req, res) => { void requestHandler(req, res); });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, host, () => {
          server.removeListener('error', reject);
          const bound = server.address();
          address = { host: bound && bound.address ? bound.address : host, port: bound && bound.port ? bound.port : configuredPort };
          resolve();
        });
      });
      if (autoStart) {
        try { await supervisor.start(); } catch (error) { log('error', `游戏服务启动失败：${error.message}`); }
      }
      return address;
    },
    close: async () => {
      if (server) await new Promise(resolve => server.close(() => resolve()));
      server = null;
      address = null;
      await supervisor.close?.();
      sessions.clear();
    },
    getStatus: statusPayload,
    getSupervisor: () => supervisor,
  };
}

if (require.main === module) {
  const panel = createControlPanel();
  panel.start().then(address => {
    console.log(`本机服务控制台已启动：http://${address.host}:${address.port}`);
  }).catch(error => {
    console.error('[control-panel]', error.message);
    process.exitCode = 1;
  });
}

module.exports = { createControlPanel };
