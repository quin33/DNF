'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseBoolean(value, fallback = true) {
  if (value === true || value === false) return value;
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return fallback;
}

function loadRuntimeState(filePath, env = process.env) {
  const fallback = {
    aiEnabled: parseBoolean(env.AI_ENABLED, true),
    version: 0,
    updatedAt: 0,
    lastOperation: null,
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return {
      ...fallback,
      aiEnabled: parseBoolean(parsed.aiEnabled, fallback.aiEnabled),
      version: Number.isSafeInteger(parsed.version) && parsed.version >= 0 ? parsed.version : fallback.version,
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : fallback.updatedAt,
      lastOperation: parsed.lastOperation && typeof parsed.lastOperation === 'object' ? parsed.lastOperation : null,
    };
  } catch (_) {
    return fallback;
  }
}

function saveRuntimeState(filePath, state) {
  const next = {
    aiEnabled: parseBoolean(state && state.aiEnabled, true),
    version: Number.isSafeInteger(state && state.version) && state.version >= 0 ? state.version : 0,
    updatedAt: Number.isFinite(Number(state && state.updatedAt)) ? Number(state.updatedAt) : Date.now(),
    lastOperation: state && state.lastOperation && typeof state.lastOperation === 'object' ? state.lastOperation : null,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function redact(value) {
  return String(value || '')
    .replace(/(AI_API_KEY|OPENAI_API_KEY|password|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

module.exports = { loadRuntimeState, saveRuntimeState, redact, parseBoolean };

