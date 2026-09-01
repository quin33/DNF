# Task 1 Review Package

## Changed implementation
    granted.push({ ...saved, storage });
  }
  return granted;
}

/* AI 决策纯函数与收束门禁 */
const AI_PHASES = ['opening', 'explore', 'encounter', 'battle', 'boss', 'loot', 'rest', 'retreat', 'closing'];
const AI_EVENTS = ['advance', 'resolve', 'fail', 'retreat'];
const AI_QUEST_STATUSES = ['active', 'completed', 'failed', 'retreated'];
const AI_ENCOUNTER_STATUSES = ['none', 'active', 'resolved', 'escaped'];

function normalizeAiDecision(raw, fallback = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const fb = fallback && typeof fallback === 'object' ? fallback : {};
  const pickValid = (value, list, def) => list.includes(value) ? value : (list.includes(fb[value === input.phase ? 'phase' : '']) ? fb[value === input.phase ? 'phase' : ''] : def);
  const phase = AI_PHASES.includes(input.phase) ? input.phase : (AI_PHASES.includes(fb.phase) ? fb.phase : 'explore');
  const event = AI_EVENTS.includes(input.event) ? input.event : (AI_EVENTS.includes(fb.event) ? fb.event : 'advance');
  const questStatus = AI_QUEST_STATUSES.includes(input.questStatus) ? input.questStatus : (AI_QUEST_STATUSES.includes(fb.questStatus) ? fb.questStatus : 'active');
  const encounterStatus = AI_ENCOUNTER_STATUSES.includes(input.encounterStatus) ? input.encounterStatus : (AI_ENCOUNTER_STATUSES.includes(fb.encounterStatus) ? fb.encounterStatus : 'active');
  const hint = input.nextHint !== undefined ? input.nextHint : fb.nextHint;
  const nextHint = String(hint == null ? '' : hint).trim().slice(0, 240);
  const continueValue = input.continue !== undefined ? input.continue : fb.continue;
  return { phase, event, questStatus, encounterStatus, nextHint, continue: continueValue === undefined ? true : !!continueValue };
}

function canEnterClosing(state = {}, decision = {}) {
  const minSteps = Number(state.minSteps == null ? 10 : state.minSteps);
  const totalStep = Number(state.totalStep || 0);
  if (totalStep < minSteps || decision.phase !== 'closing') return false;
  const questStatus = state.quest && state.quest.status || decision.questStatus;
  const encounterStatus = state.encounter && state.encounter.status || decision.encounterStatus;
  if (questStatus === 'active' || encounterStatus === 'active') return false;
  return ['none', 'resolved', 'escaped'].includes(encounterStatus) && ['completed', 'failed', 'retreated'].includes(questStatus);
}

function resolveNextPhase(state = {}, decision) {
  const d = decision && decision.phase ? decision : normalizeAiDecision(decision, { phase: state.phase || 'explore' });
  const current = state.phase || 'explore';
  const maxSteps = Number(state.maxSteps == null ? 40 : state.maxSteps);
  if (Number(state.totalStep || 0) >= maxSteps) {
    if (state.quest && state.quest.status === 'active') state.quest.status = 'failed';
    if (state.encounter && state.encounter.status === 'active') state.encounter.status = 'escaped';
    return 'closing';
  }
  const encounterStatus = state.encounter && state.encounter.status;
  if (encounterStatus === 'active' && (d.phase === 'loot' || d.phase === 'closing')) return current;
  if (d.phase === 'closing' && !canEnterClosing(state, d)) return current;
  return d.phase;
}

function applyAiDecision(state, decision) {
  if (!state || typeof state !== 'object') return normalizeAiDecision(decision);
  const normalized = normalizeAiDecision(decision, { phase: state.phase || 'explore', questStatus: state.quest && state.quest.status, encounterStatus: state.encounter && state.encounter.status, nextHint: state.nextHint });
  if (state.quest && AI_QUEST_STATUSES.includes(normalized.questStatus)) state.quest.status = normalized.questStatus;
  if (state.encounter && AI_ENCOUNTER_STATUSES.includes(normalized.encounterStatus)) state.encounter.status = normalized.encounterStatus;
  const nextPhase = resolveNextPhase(state, normalized);
  state.phase = nextPhase;
  state.lastDecision = normalized;
  state.nextHint = normalized.nextHint;
  return normalized;
}

/* 生成 NPC 陪跑角色（单人/缺员补位） */
function genNpc(name) {
  const rand = () => 1 + Math.floor(Math.random() * 20);
  return {
    id: 'npc-' + Math.random().toString(36).slice(2, 8), name: name || pick(NPC_NAME_POOL), is_npc: true, is_mine: false,
    gender: Math.random() < 0.5 ? '男' : '女', hp: 100 + Math.floor(Math.random() * 60), max_hp: 160, stamina: 100, max_stamina: 100, hpTs: Date.now(),
    level: 1 + Math.floor(Math.random() * 3),
    strength: rand(), agility: rand(), intelligence: rand(), luck: rand(),
    gold: 0, character_class: '练气' + QI_LAYER[1 + Math.floor(Math.random() * 10)] + '层',
    personality: pick(GC.PERS_LIST), traits: ['初入仙途'], equipment: [], bag: [], skills: [],
    exp: 0, status: 'idle',
  };
}

/* 创建房间 dg（开本）；联机与单机共用默认长度 */
function createDg(hostChar, opts = {}) {
  const isHidden = Math.random() < 0.1;
  const specialEvent = Math.random() < 0.1;
  const breakthrough = canBreakthrough(hostChar) && Math.random() < 0.1;
  const base = (opts.choice && DUNGEON_POOL.find(d => d.name === opts.choice)) || pickDungeon(hostChar);
  const enemies = rollEnemies(base, specialEvent);
  const bosses = (base.bosses || []).map((b, i) => ({ ...b, realm: i === 1 ? '筑基中期' : '筑基初期' }));
  const dungeon = { ...base, name: isHidden ? (base.hiddenName || base.name) : base.name, desc: isHidden ? (base.hiddenDesc || base.desc) : base.desc, isHidden, baseName: base.name, enemies, bosses, specialEvent, breakthrough };
  return {
    id: 'dg' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    dungeon, party: [], plan: buildPlan(isHidden, enemies.length, specialEvent, breakthrough),
    planIdx: 0, stepIdx: 0, totalStep: 0, steps: [], damage: 0, deaths: [],
    status: 'waiting', startedAt: Date.now(), timer: null, memberGains: {},
    bossDrops: [], _curEnemy: null, gains: {}, consumed: [], breachSuccess: false, localUsed: false, source: 'online',
  };
}

/* AI 请求体构造（与单机 generateStep 载荷一致） */
function aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse) {
  const focus = (dg.focusPlan || [])[dg.totalStep] || null;
  const cast = focus && focus.mode === 'group' ? (dg.party || []) : [actor, support, support2].filter(Boolean);
  const allowedCharacters = [...new Set(cast.map(member => member && member.name).filter(Boolean))];
  const forbiddenCharacters = [...new Set((dg.party || []).map(member => member && member.name).filter(Boolean))].filter(name => !allowedCharacters.includes(name));
  return {
    dungeon: dg.dungeon.name, baseDungeon: dg.dungeon.baseName || dg.dungeon.name, isHidden: !!dg.dungeon.isHidden,
    specialEvent: !!dg.dungeon.specialEvent, breakthrough: !!dg.dungeon.breakthrough,
    lore: dg.dungeon.lore || '', enemies: dg.dungeon.enemies || [], bosses: dg.dungeon.bosses || [],
    stage: stageKey, stageLabel: (dg.plan[dg.planIdx] || {}).label || stageKey,
    roll, mod, total, actor: actor.name,
    support: support ? support.name : null, support2: support2 ? support2.name : null, attr: attrKey,
    focus: focus ? { actor: actor.name, step: focus.focusStep, size: focus.windowSize, highlight: !!focus.highlight, mode: focus.mode } : null,
    allowedCharacters, forbiddenCharacters,
    stepNo: dg.totalStep + 1, totalSteps: dg.plan.reduce((a, p) => a + p.steps, 0),
    enemy: dg._curEnemy ? { name: dg._curEnemy.name, realm: dg._curEnemy.realm || '', desc: dg._curEnemy.desc || '' } : null,
    itemUse: itemUse ? { name: itemUse.item.name, desc: itemUse.item.desc || '', kind: itemUse.item.kind || 'misc', roll: itemUse.roll, total: itemUse.total, success: itemUse.success } : null,
    skillUse: skillUse ? { name: skillUse.name, type: skillUse.type, tier: skillUse.tier || '黄阶', elem: skillUse.elem || '', elemMod: skillUse.elemMod || 0, desc: skillUse.desc || '', roll: skillUse.roll, total: skillUse.total, success: skillUse.success } : null,
    party: dg.party.map(m => ({
      name: m.name, gender: m.gender || '男', realm: m.character_class || '', root: (m.traits && m.traits[0]) || '',
      personality: m.personality || '', traits: m.traits || [],
      skills: (m.skills || []).map(s => ({ name: s.name, type: s.type || '', tier: skillTier(s), desc: s.desc || '' })),
      items: (m.equipment || []).map(i => ({ name: i.name, kind: i.kind || 'misc', desc: i.desc || '', qty: i.qty || 1 })),
    })),
    context: dg.steps.slice(-5).map(s => s.text).join('\n'),
  };
}

module.exports = {
  DUNGEON_POOL, STAGE_ATTR, ATTR_NAME, QI_LAYER, SKILL_TIERS, MAX_SKILLS, NPC_NAME_POOL, BREAKTHROUGH_EXP,
  rollD20, pick, skillTier, itemBonus, traitBonus, realmBonus, realmDiffMod, elemMatchMod,
  rollEnemies, pickDungeon, buildPlan, buildNarrativeFocusPlan, itemUseCheck, skillUseCheck, parseLootMarkers, extractGold,
  applyStageEffects, genNpc, createDg, aiStoryPayload, addTrait, regenerateHp, assignLoot, hasDuplicateCharacterName, experienceNeeded, canBreakthrough,
  applyLevelGrowth, applyExperience, parseLearnedSkills, applyLearnedSkills,
  normalizeAiDecision, canEnterClosing, resolveNextPhase, applyAiDecision,
};

## Tests
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAiDecision,
  canEnterClosing,
  resolveNextPhase,
  applyAiDecision,
} = require('../game-engine.js');

const base = (overrides = {}) => ({
  totalStep: 10,
  minSteps: 10,
  maxSteps: 40,
  phase: 'explore',
  quest: { status: 'active' },
  encounter: { status: 'none' },
  nextHint: '',
  ...overrides,
});

test('invalid phase falls back to fallback.phase', () => {
  const d = normalizeAiDecision({ phase: 'bogus' }, { phase: 'battle' });
  assert.equal(d.phase, 'battle');
});

test('missing statuses use safe active defaults unless fallback supplies valid values', () => {
  const d = normalizeAiDecision({}, { phase: 'explore', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(d.questStatus, 'completed');
  assert.equal(d.encounterStatus, 'resolved');
  const safe = normalizeAiDecision({}, { phase: 'explore' });
  assert.equal(safe.questStatus, 'active');
  assert.equal(safe.encounterStatus, 'active');
});

test('nextHint is trimmed and bounded', () => {
  const d = normalizeAiDecision({ nextHint: '  hello ' + 'x'.repeat(500) }, { phase: 'explore' });
  assert.equal(d.nextHint.length, 240);
  assert.equal(d.nextHint.startsWith('hello'), true);
});

test('continue is boolean with safe continuation default', () => {
  assert.equal(normalizeAiDecision({}, { phase: 'explore' }).continue, true);
  assert.equal(normalizeAiDecision({ continue: 0 }, { phase: 'explore' }).continue, false);
});

test('closing before minSteps is rejected', () => {
  const state = base({ totalStep: 9 });
  const decision = normalizeAiDecision({ phase: 'closing' }, { phase: 'closing' });
  assert.equal(canEnterClosing(state, decision), false);
});

test('closing with active quest or encounter is rejected', () => {
  const state = base({ totalStep: 10 });
  assert.equal(canEnterClosing(state, normalizeAiDecision({ phase: 'closing' }, {})), false);
  assert.equal(canEnterClosing({ ...state, quest: { status: 'completed' }, encounter: { status: 'active' } }, normalizeAiDecision({ phase: 'closing' }, {})), false);
});

test('resolved quest and encounter can close after minSteps', () => {
  const state = base({ quest: { status: 'completed' }, encounter: { status: 'resolved' } });
  assert.equal(canEnterClosing(state, normalizeAiDecision({ phase: 'closing' }, {})), true);
  for (const qs of ['failed', 'retreated']) {
    assert.equal(canEnterClosing({ ...state, quest: { status: qs }, encounter: { status: 'none' } }, normalizeAiDecision({ phase: 'closing' }, {})), true);
  }
});

test('active encounter rejects loot and preserves current conflict phase', () => {
  const state = base({ phase: 'battle', encounter: { status: 'active' } });
  const decision = normalizeAiDecision({ phase: 'loot' }, { phase: 'battle' });
  assert.equal(resolveNextPhase(state, decision), 'battle');
});

test('at maxSteps unresolved quest becomes failed and closes', () => {
  const state = base({ totalStep: 40, phase: 'explore', quest: { status: 'active' } });
  const decision = normalizeAiDecision({ phase: 'explore' }, { phase: 'explore' });
  const next = resolveNextPhase(state, decision);
  assert.equal(state.quest.status, 'failed');
  assert.equal(next, 'closing');
});

test('applyAiDecision updates decision-owned fields and stores normalized decision', () => {
  const state = base({ phase: 'explore', quest: { status: 'active' }, encounter: { status: 'none' } });
  const d = applyAiDecision(state, { phase: 'loot', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved', nextHint: ' next ' });
  assert.equal(d.phase, 'loot');
  assert.equal(state.phase, 'loot');
  assert.equal(state.quest.status, 'completed');
  assert.equal(state.encounter.status, 'resolved');
  assert.equal(state.lastDecision, d);
  assert.equal(state.nextHint, 'next');
  assert.equal(state.totalStep, 10);
});
