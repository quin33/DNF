'use strict';

/* DNF60：特质（permanent traits）已整体移除，本模块仅保留「临时受伤」这一独立状态：
   injury 不与 traits/traitDescs 耦合，只作为角色身上的独立状态与倒计时。 */

function textLength(value) {
  return Array.from(String(value || '')).length;
}

/* 受伤授予：仅接受 AI 对「重伤候选」的低频明确授予（grant === true）。 */
function normalizeInjuryGrant(entry, severeInjuryCandidates = []) {
  if (!entry || entry.grant !== true) return null;
  const member = String(entry.member || '').trim();
  const name = String(entry.name || '').replace(/\s+/g, '').trim();
  const desc = String(entry.desc || '').replace(/[\r\n]+/g, ' ').trim();
  if (!severeInjuryCandidates.map(value => String(value || '').trim()).includes(member)) return null;
  if (textLength(name) < 6 || textLength(name) > 12) return null;
  if (textLength(desc) < 20 || textLength(desc) > 100) return null;
  return { member, name, desc };
}

/* 到期清理：只移除 role.injury，不再触碰 traits/traitDescs。 */
function clearExpiredInjury(role, now = Date.now()) {
  if (!role || !role.injury) return false;
  const expiresAt = Number(role.injury.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
  role.injury = null;
  return true;
}

module.exports = { normalizeInjuryGrant, clearExpiredInjury };
