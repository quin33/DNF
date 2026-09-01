'use strict';

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function parseChineseNumber(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of text) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, char)) {
      number = number * 10 + CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (!unit) return 0;
    if (unit < 10000) {
      section += (number || 1) * unit;
      number = 0;
    } else {
      section = (section + number) || 1;
      total += section * unit;
      section = 0;
      number = 0;
    }
  }
  return total + section + number;
}

function normalizeContext(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。、“”‘’：:；！？!?、（）()「」『』]/g, '')
    .slice(-80);
}

function extractSpiritStoneEvents(steps) {
  const events = [];
  const seenInStep = new Set();
  const pattern = /(?:(\d{1,6}|[零〇一二两三四五六七八九十百千万]+)\s*(?:块|枚|颗|个)?\s*(?:下品|中品|上品)?\s*灵石|灵石\s*[：:×xX*]?\s*(\d{1,6}|[零〇一二两三四五六七八九十百千万]+))/g;
  for (const step of Array.isArray(steps) ? steps : []) {
    const text = String(step && (step.rawText || step.text) || '');
    if (!text) continue;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const rawAmount = match[1] || match[2];
      const amount = parseChineseNumber(rawAmount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const context = text.slice(Math.max(0, match.index - 110), Math.min(text.length, match.index + match[0].length + 50));
      if (!/(获得|得到|捡|拾|取|拿|收|酬|赐|奖励|报酬|赏|内有|裹着|袋囊|储囊|搜刮|发现|翻出|得了|得)/.test(context)) continue;
      const stepNo = Number(step.stepNo || 0);
      const dedupeKey = `${stepNo}|${amount}|${normalizeContext(context)}`;
      if (seenInStep.has(dedupeKey)) continue;
      seenInStep.add(dedupeKey);
      events.push({
        amount,
        sourceStep: stepNo || null,
        actor: String(step.actor || '').trim(),
        text: match[0],
      });
    }
  }
  return events;
}

function splitSpiritStones(total, members) {
  const party = Array.isArray(members) ? members.filter(member => member && member.id !== undefined && member.id !== null) : [];
  const amount = Math.max(0, Math.floor(Number(total) || 0));
  if (!party.length) return {};
  const base = Math.floor(amount / party.length);
  const remainder = amount % party.length;
  return Object.fromEntries(party.map((member, index) => [member.id, base + (index < remainder ? 1 : 0)]));
}

function totalSpiritStones(events) {
  return (Array.isArray(events) ? events : []).reduce((sum, event) => sum + Math.max(0, Math.floor(Number(event && event.amount) || 0)), 0);
}

function formatStorySteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step, index) => {
    const stepNo = positiveStep(step && step.stepNo) || index + 1;
    const story = String(step && (step.rawText || step.text) || '').trim();
    return `第${stepNo}段：${story}`;
  }).join('\n');
}

function cleanLootName(value, max = 12) {
  return String(value || '').replace(/\s+/g, '').trim().slice(0, max);
}

const PSEUDO_LOOT_RE = /灵石|钱|金锭|银锭|铜板/;

function rawLootName(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function isPseudoLootName(value) {
  const name = rawLootName(value);
  return !name || name === '无' || PSEUDO_LOOT_RE.test(name);
}

function isValidLootName(value) {
  if (isPseudoLootName(value)) return false;
  const len = Array.from(rawLootName(value)).length;
  return len >= 4 && len <= 12;
}

function canonicalLootKey(value) {
  return cleanLootName(value, 40)
    .replace(/[《》〈〉「」『』【】()[\]（）]/g, '')
    .toLowerCase();
}

function positiveStep(value) {
  const step = Math.floor(Number(value));
  return Number.isFinite(step) && step > 0 ? step : null;
}

function normalizeLootQty(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty <= 0) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.round(qty)));
}

function normalizeLootItems(items) {
  const normalized = [];
  const byEntity = new Map();
  const bySourceStep = new Map();
  const legacyByCanonical = new Map();

  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const originalName = cleanLootName(raw.name);
    const canonicalName = cleanLootName(raw.canonicalName || originalName);
    if (isPseudoLootName(originalName) || !isValidLootName(canonicalName)) continue;

    const sourceStep = positiveStep(raw.sourceStep);
    const sameAsStep = positiveStep(raw.sameAsStep);
    const entityId = String(raw.entityId || '').trim().slice(0, 80);
    const owner = String(raw.owner || '').trim().slice(0, 40);
    const canonicalKey = canonicalLootKey(canonicalName);
    const candidates = sameAsStep ? (bySourceStep.get(sameAsStep) || []) : [];
    let target = entityId ? byEntity.get(entityId) : null;
    let mergeReason = target ? `entityId:${entityId}` : '';

    if (!target && sameAsStep) {
      target = candidates.find(item => item._canonicalKey === canonicalKey)
        || (candidates.length === 1 ? candidates[0] : null);
      if (target) mergeReason = `sameAsStep:${sameAsStep}`;
    }
    if (!target && sourceStep) {
      target = (bySourceStep.get(sourceStep) || []).find(item => item._canonicalKey === canonicalKey) || null;
      if (target) mergeReason = `same-source-step:${sourceStep}`;
    }
    if (!target && !sourceStep && !sameAsStep && !entityId) {
      target = legacyByCanonical.get(canonicalKey) || null;
      if (target) mergeReason = 'legacy-duplicate';
    }

    const source = {
      sourceStep,
      sameAsStep,
      entityId: entityId || null,
      originalName,
      owner: owner || null,
    };
    const aliases = Array.from(new Set([
      ...(Array.isArray(raw.aliases) ? raw.aliases.map(name => cleanLootName(name)).filter(Boolean) : []),
      originalName,
      canonicalName,
    ]));
    const sourceSteps = Array.from(new Set([
      ...(Array.isArray(raw.sourceSteps) ? raw.sourceSteps.map(positiveStep).filter(Boolean) : []),
      ...(sourceStep ? [sourceStep] : []),
    ]));
    const sources = Array.isArray(raw.sources) && raw.sources.length ? raw.sources.map(entry => ({ ...entry })) : [source];
    const inheritedReasons = Array.isArray(raw.mergeReasons)
      ? raw.mergeReasons.map(String).filter(Boolean)
      : (raw.mergeReason && raw.mergeReason !== 'unique' ? [String(raw.mergeReason)] : []);
    if (target) {
      target.qty = Math.max(target.qty, normalizeLootQty(raw.qty));
      if (!target.owner && owner) target.owner = owner;
      for (const alias of aliases) if (!target.aliases.includes(alias)) target.aliases.push(alias);
      for (const step of sourceSteps) if (!target.sourceSteps.includes(step)) target.sourceSteps.push(step);
      const sourceKeys = new Set(target.sources.map(entry => JSON.stringify(entry)));
      for (const entry of sources) {
        const key = JSON.stringify(entry);
        if (!sourceKeys.has(key)) { target.sources.push(entry); sourceKeys.add(key); }
      }
      for (const reason of [...inheritedReasons, mergeReason]) {
        if (reason && !target.mergeReasons.includes(reason)) target.mergeReasons.push(reason);
      }
      target.mergeReason = target.mergeReasons.join('; ');
      continue;
    }

    const item = {
      name: canonicalName,
      canonicalName,
      desc: String(raw.desc || '来历不明的宝物').trim().slice(0, 100),
      qty: normalizeLootQty(raw.qty),
      rarity: ['common', 'rare', 'epic', 'legendary'].includes(raw.rarity) ? raw.rarity : 'common',
      owner: owner || null,
      sourceStep,
      sameAsStep,
      entityId: entityId || null,
      aliases,
      sourceSteps,
      sources,
      mergeReasons: inheritedReasons,
      mergeReason: inheritedReasons.join('; ') || 'unique',
    };
    Object.defineProperty(item, '_canonicalKey', { value: canonicalKey, enumerable: false });
    normalized.push(item);
    if (entityId) byEntity.set(entityId, item);
    if (sourceSteps.length) {
      for (const step of sourceSteps) {
        const list = bySourceStep.get(step) || [];
        if (!list.includes(item)) list.push(item);
        bySourceStep.set(step, list);
      }
    } else if (!sameAsStep && !entityId) {
      legacyByCanonical.set(canonicalKey, item);
    }
  }

  return normalized;
}

function memberMatchesOwner(member, owner) {
  const target = String(owner || '').trim();
  if (!target || !member) return false;
  return [member.id, member.uid, member.name]
    .some(value => value !== undefined && value !== null && String(value).trim() === target);
}

function assignLoot(items, members, random = Math.random) {
  const eligible = (Array.isArray(members) ? members : [])
    .filter(member => member && member.id !== undefined && member.id !== null);
  const assigned = Object.fromEntries(eligible.map(member => [member.id, []]));
  for (const item of Array.isArray(items) ? items : []) {
    if (!eligible.length) break;
    let winner = eligible.find(member => memberMatchesOwner(member, item && item.owner));
    let assignmentReason = 'story-owner';
    if (!winner) {
      assignmentReason = 'merit-weighted';
      const weights = eligible.map(member => Math.max(1, Number(member.merit || 1)) / (assigned[member.id].length + 1));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * total;
      winner = eligible[eligible.length - 1];
      for (let i = 0; i < eligible.length; i++) {
        roll -= weights[i];
        if (roll <= 0) { winner = eligible[i]; break; }
      }
    }
    assigned[winner.id].push({
      ...item,
      qty: normalizeLootQty(item && item.qty),
      finalOwnerId: winner.id,
      finalOwner: String(winner.name || winner.id),
      assignmentReason,
    });
  }
  return assigned;
}

function buildLootAudit(assigned) {
  const audit = [];
  for (const list of Object.values(assigned || {})) {
    for (const item of Array.isArray(list) ? list : []) {
      audit.push({
        name: item.name,
        canonicalName: item.canonicalName || item.name,
        aliases: Array.isArray(item.aliases) ? item.aliases : [item.name],
        qty: normalizeLootQty(item.qty),
        owner: item.owner || null,
        finalOwnerId: item.finalOwnerId,
        finalOwner: item.finalOwner,
        assignmentReason: item.assignmentReason,
        sourceSteps: Array.isArray(item.sourceSteps) ? item.sourceSteps : [],
        sources: Array.isArray(item.sources) ? item.sources : [],
        mergeReason: item.mergeReason || 'unique',
      });
    }
  }
  return audit;
}

const LootSettlement = {
  parseChineseNumber,
  extractSpiritStoneEvents,
  splitSpiritStones,
  totalSpiritStones,
  formatStorySteps,
  cleanLootName,
  isPseudoLootName,
  isValidLootName,
  normalizeLootItems,
  assignLoot,
  buildLootAudit,
};

if (typeof module !== 'undefined' && module.exports) module.exports = LootSettlement;
if (typeof window !== 'undefined') window.LootSettlement = LootSettlement;
