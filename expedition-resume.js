'use strict';

const SNAPSHOT_VERSION = 2;
const OMITTED_RUNTIME_FIELDS = new Set(['ws', '_timer', 'timer', '_curEnemy']);

function cloneSerializable(value, ancestors = new Set()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return undefined;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map(entry => cloneSerializable(entry, nextAncestors)).filter(entry => entry !== undefined);
  }

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (OMITTED_RUNTIME_FIELDS.has(key)) continue;
    const cloned = cloneSerializable(entry, nextAncestors);
    if (cloned !== undefined) output[key] = cloned;
  }
  return output;
}

function serializeDurableRoom(room, retryState = null) {
  if (!room || !room.dg) return {};
  return {
    schemaVersion: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    room: cloneSerializable(room),
    retry: retryState ? cloneSerializable(retryState) : null,
  };
}

function isRestorableSnapshot(snapshot) {
  const room = snapshot && snapshot.room;
  const dg = room && room.dg;
  return !!(
    snapshot
    && snapshot.schemaVersion === SNAPSHOT_VERSION
    && room
    && typeof room.id === 'string'
    && Array.isArray(room.party)
    && dg
    && typeof dg.id === 'string'
    && Array.isArray(dg.party)
    && Array.isArray(dg.steps)
    && Array.isArray(dg.plan)
    && dg.dungeon
    && typeof dg.dungeon === 'object'
  );
}

function clearLiveMemberState(members) {
  for (const member of members || []) {
    if (!member || typeof member !== 'object') continue;
    member.ws = null;
    member.online = false;
  }
}

function hydrateDurableRoom(run) {
  if (!run || !isRestorableSnapshot(run.snapshot)) return null;
  const room = cloneSerializable(run.snapshot.room);
  room.id = String(run.roomId || room.id);
  room.status = String(run.status || room.status || 'running');
  room._timer = null;
  room._failureRecorded = false;
  room._aiRetry = run.snapshot.retry ? cloneSerializable(run.snapshot.retry) : null;
  room.dg.id = String(run.runId || room.dg.id);
  room.dg.status = room.status;
  room.dg._curEnemy = null;
  room.dg.timer = null;
  clearLiveMemberState(room.party);
  clearLiveMemberState(room.dg.party);
  return room;
}

function classifyAiFailure(error) {
  if (!error || error.aiFailure !== true) return { resumable: false, longDelay: false };
  const status = Number(error.status || 0);
  const longDelay = ['ai_disabled', 'ai_unconfigured', 'ai_auth'].includes(String(error.code || ''))
    || status === 401
    || status === 403;
  return { resumable: true, longDelay };
}

function retryDelay(attempt, longDelay = false) {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = longDelay ? 60000 : 5000;
  const cap = longDelay ? 15 * 60 * 1000 : 5 * 60 * 1000;
  return Math.min(cap, base * (2 ** Math.min(normalizedAttempt - 1, 10)));
}

module.exports = {
  SNAPSHOT_VERSION,
  classifyAiFailure,
  hydrateDurableRoom,
  isRestorableSnapshot,
  retryDelay,
  serializeDurableRoom,
};
