'use strict';

function textLength(value) {
  return Array.from(String(value || '')).length;
}

function normalizeTraitGrant(entry, allowedMembers = [], existingTraits = []) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const member = String(entry.member || '').trim();
  const name = String(entry.name || '').replace(/\s+/g, '').trim();
  const desc = String(entry.desc || '').replace(/[\r\n]+/g, ' ').trim();
  if (!allowedMembers.map(value => String(value || '').trim()).includes(member)) return null;
  if (textLength(name) < 6 || textLength(name) > 12) return null;
  if (textLength(desc) < 20 || textLength(desc) > 100) return null;
  if (existingTraits.map(value => String(value || '').trim()).includes(name)) return null;
  return { member, name, desc };
}

function normalizeInjuryGrant(entry, severeInjuryCandidates = [], existingTraits = []) {
  if (!entry || entry.grant !== true) return null;
  return normalizeTraitGrant(entry, severeInjuryCandidates, existingTraits);
}

function clearExpiredInjury(role, now = Date.now()) {
  if (!role || !role.injury) return false;
  const expiresAt = Number(role.injury.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
  const injuryName = String(role.injury.name || '').trim();
  if (Array.isArray(role.traits) && injuryName) {
    role.traits = role.traits.filter(name => name !== injuryName);
  }
  if (role.traitDescs && typeof role.traitDescs === 'object' && injuryName) {
    delete role.traitDescs[injuryName];
  }
  role.injury = null;
  return true;
}

module.exports = { normalizeTraitGrant, normalizeInjuryGrant, clearExpiredInjury };
