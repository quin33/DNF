'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');

const execFileAsync = promisify(execFile);

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function redact(text) {
  return String(text || '')
    .replace(/(AI_API_KEY|OPENAI_API_KEY|password|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

function defaultHealthCheck({ host, port, timeoutMs = 1000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`http://${host}:${port}/api/health`, { signal: controller.signal })
    .then(response => response.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

async function defaultFindPortOwner(port) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const wanted = new RegExp(`\\b(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]):${Number(port)}\\s+.*LISTENING\\s+(\\d+)`, 'i');
    const match = String(stdout).match(wanted);
    return match ? { pid: Number(match[1]) } : null;
  } catch (_) {
    return null;
  }
}

function createServiceSupervisor(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const serverScript = options.serverScript || path.join(rootDir, 'server.js');
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 8787);
  const spawnImpl = options.spawnImpl || spawn;
  const healthCheck = options.healthCheck || (ctx => defaultHealthCheck(ctx));
  const findPortOwner = options.findPortOwner || defaultFindPortOwner;
  const healthAttempts = Number.isInteger(options.healthAttempts) ? options.healthAttempts : 30;
  const healthIntervalMs = Number.isFinite(options.healthIntervalMs) ? options.healthIntervalMs : 250;
  const stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) ? options.stopTimeoutMs : 3000;
  const now = options.now || Date.now;
  const maxLogs = Number.isInteger(options.maxLogs) ? options.maxLogs : 500;
  const listeners = new Set();
  const messageListeners = new Set();
  const logs = [];
  let child = null;
  let operation = null;
  let status = {
    state: 'stopped', pid: null, port, startedAt: null, healthAt: null,
    managed: false, exitCode: null, error: '', updatedAt: now(),
  };

  function pushLog(level, message) {
    const entry = { at: now(), service: 'server', level, message: redact(message).slice(0, 1000) };
    logs.push(entry);
    while (logs.length > maxLogs) logs.shift();
    return entry;
  }

  function emitStatus() {
    status = { ...status, updatedAt: now() };
    const snapshot = { ...status };
    listeners.forEach(listener => {
      try { listener(snapshot); } catch (_) {}
    });
    return snapshot;
  }

  function setState(state, extra = {}) {
    status = { ...status, state, ...extra };
    return emitStatus();
  }

  function wait(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
  }

  async function waitForHealth() {
    for (let attempt = 0; attempt < healthAttempts; attempt++) {
      if (await healthCheck({ host, port, attempt })) return true;
      await wait(healthIntervalMs);
    }
    return false;
  }

  function bindChild(processHandle) {
    processHandle.stdout?.on('data', chunk => pushLog('info', String(chunk)));
    processHandle.stderr?.on('data', chunk => pushLog('error', String(chunk)));
    processHandle.on?.('message', message => {
      messageListeners.forEach(listener => {
        try { listener(message); } catch (_) {}
      });
    });
    processHandle.on?.('error', error => {
      pushLog('error', error.message || String(error));
      setState('error', { error: String(error.message || error), exitCode: null });
    });
    processHandle.on?.('exit', (code, signal) => {
      const wasCurrent = child === processHandle;
      if (!wasCurrent) return;
      child = null;
      if (status.state === 'stopping' || status.state === 'restarting') return;
      setState('crashed', { pid: null, managed: false, exitCode: code, error: signal ? `signal:${signal}` : '' });
    });
  }

  function withOperation(name, task) {
    if (operation) return Promise.reject(createError('operation_in_progress', `操作进行中：${operation}`));
    operation = name;
    return Promise.resolve().then(task).finally(() => { operation = null; });
  }

  async function startInternal() {
    if (status.state === 'running' && child) return { ...status };
    const owner = await findPortOwner(port);
    if (owner && (!child || Number(owner.pid) !== Number(child.pid))) {
      setState('error', { error: `端口 ${port} 已被进程 ${owner.pid} 占用`, managed: false });
      throw createError('port_occupied', `端口 ${port} 已被其他进程占用`);
    }
    setState('starting', { error: '', exitCode: null });
    const processHandle = spawnImpl(process.execPath, [serverScript], {
      cwd: rootDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child = processHandle;
    bindChild(processHandle);
    const startedAt = now();
    status = { ...status, pid: processHandle.pid || null, managed: true, startedAt };
    emitStatus();
    if (!(await waitForHealth())) {
      await stopProcess(processHandle, true);
      setState('error', { pid: null, managed: false, error: '服务启动后健康检查超时' });
      throw createError('health_timeout', '服务启动后健康检查超时');
    }
    return setState('running', { healthAt: now(), pid: processHandle.pid || null, managed: true, error: '' });
  }

  function waitForExit(processHandle, timeoutMs) {
    if (!processHandle || !processHandle.on) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      processHandle.once?.('exit', () => finish(true));
      if (processHandle.exitCode != null) finish(true);
    });
  }

  async function stopProcess(processHandle, force = false) {
    if (!processHandle) return true;
    try { processHandle.kill?.(); } catch (_) {}
    if (force) {
      await forceKill(processHandle.pid);
      return true;
    }
    const exited = await waitForExit(processHandle, stopTimeoutMs);
    if (exited) return true;
    await forceKill(processHandle.pid);
    return true;
  }

  async function forceKill(pid) {
    if (!pid) return;
    if (process.platform !== 'win32') return;
    try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
  }

  async function stopInternal() {
    if (!child) return setState('stopped', { pid: null, managed: false, error: '' });
    const processHandle = child;
    setState('stopping', { error: '' });
    await stopProcess(processHandle);
    if (child === processHandle) child = null;
    return setState('stopped', { pid: null, managed: false, error: '' });
  }

  async function restartInternal() {
    setState('restarting', { error: '' });
    await stopInternal();
    return startInternal();
  }

  return {
    start: () => withOperation('start', startInternal),
    stop: () => withOperation('stop', stopInternal),
    restart: () => withOperation('restart', restartInternal),
    getStatus: () => ({ ...status }),
    getLogs: ({ service = 'all', level = 'all', limit = 100 } = {}) => logs
      .filter(entry => (service === 'all' || entry.service === service) && (level === 'all' || entry.level === level))
      .slice(-Math.max(1, Math.min(500, Number(limit) || 100))),
    onStatus: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    onMessage: listener => { messageListeners.add(listener); return () => messageListeners.delete(listener); },
    send: message => {
      if (!child || typeof child.send !== 'function' || !status.managed) return false;
      child.send(message);
      return true;
    },
    getChild: () => child,
    appendLog: (level, message) => pushLog(level, message),
    close: async () => { if (child) await stopInternal(); listeners.clear(); },
  };
}

module.exports = { createServiceSupervisor, redact, defaultHealthCheck, defaultFindPortOwner };
