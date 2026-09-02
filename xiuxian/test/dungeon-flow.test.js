const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDg,
  normalizeAiDecision,
  canEnterClosing,
  resolveNextPhase,
  applyAiDecision,
  aiStoryPayload,
  itemUseCheck,
  recordItemLoan,
  consumeItemUse,
  settleItemLoans,
  itemUseExplicitInText,
  recordItemLoansFromText,
} = require('../game-engine.js');

test('createDg initializes dynamic flow state independent of plan length', () => {
  const dg = createDg({ level: 1, exp: 0, name: '测试修士' }, { choice: '枯骨林' });
  assert.equal(dg.flowMode, 'dynamic');
  assert.equal(dg.minSteps, 10);
  assert.equal(dg.preferredMaxSteps, 25);
  assert.equal(dg.maxSteps, 40);
  assert.equal(dg.phase, 'opening');
  assert.equal(dg.quest.status, 'active');
  assert.equal(typeof dg.quest.objective, 'string');
  assert.equal(dg.encounter.status, 'none');
  assert.deepEqual(dg.lastDecision, {});
  assert.equal(dg.nextHint, '');
  assert.notEqual(dg.plan.reduce((sum, entry) => sum + entry.steps, 0), 0);
});

test('dynamic boss encounter remains active until AI resolves it before loot and closing', () => {
  const state = { flowMode: 'dynamic', totalStep: 10, minSteps: 10, maxSteps: 40, phase: 'boss', quest: { status: 'active' }, encounter: { status: 'none' } };
  applyAiDecision(state, { phase: 'boss', event: 'advance', questStatus: 'active', encounterStatus: 'active' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'boss', event: 'advance', questStatus: 'active', encounterStatus: 'active' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'boss', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'loot', event: 'advance', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'loot');
  applyAiDecision(state, { phase: 'closing', event: 'advance', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'closing');
});

test('dynamic flow forces continuation before minSteps and fails unresolved quest at maxSteps', () => {
  const early = { flowMode: 'dynamic', totalStep: 8, minSteps: 10, maxSteps: 40, phase: 'explore', quest: { status: 'completed' }, encounter: { status: 'none' } };
  applyAiDecision(early, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none', continue: false });
  assert.notEqual(early.phase, 'closing');
  const late = { flowMode: 'dynamic', totalStep: 40, minSteps: 10, maxSteps: 40, phase: 'explore', quest: { status: 'active' }, encounter: { status: 'none' } };
  applyAiDecision(late, { phase: 'explore', questStatus: 'active', encounterStatus: 'none' });
  assert.equal(late.quest.status, 'failed');
  assert.equal(late.phase, 'closing');
});

test('max step preserves an already completed quest and resolved encounter', () => {
  const state = base({ totalStep: 40, quest: { status: 'completed' }, encounter: { status: 'resolved' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved', continue: false });
  assert.equal(state.quest.status, 'completed');
  assert.equal(state.encounter.status, 'resolved');
  assert.equal(state.phase, 'closing');
  assert.equal(state.forcedTerminal, undefined);
});

test('active encounter cannot resolve and jump to loot in the same AI decision', () => {
  const state = base({ phase: 'boss', encounter: { status: 'active' } });
  applyAiDecision(state, { phase: 'loot', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'boss');
  assert.equal(state.encounter.status, 'resolved');
});

test('dynamic payload stage label follows current phase instead of legacy plan index', () => {
  const dg = createDg({ level: 1, exp: 0, name: '测试修士' }, { choice: '枯骨林' });
  dg.phase = 'boss';
  dg.party = [{ name: '测试修士', traits: [], equipment: [], skills: [] }];
  dg.focusPlan = [{ mode: 'focus', focusStep: 1, windowSize: 1 }];
  const payload = aiStoryPayload(dg, 'boss', dg.party[0], null, null, 'strength', 10, 0, 10, null, null);
  assert.equal(payload.stageLabel, '首领');
});

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
  assert.equal(normalizeAiDecision({ continue: 'no' }, { phase: 'explore' }).continue, true);
  assert.equal(normalizeAiDecision({ continue: 'no' }, { phase: 'explore', continue: false }).continue, false);
  assert.equal(normalizeAiDecision({ event: 'bad', questStatus: 'bad', encounterStatus: 'bad' }, { phase: 'explore' }).event, 'advance');
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

test('resolver normalizes malformed decision phases', () => {
  const state = base({ phase: 'battle' });
  assert.equal(resolveNextPhase(state, { phase: 'bogus' }), 'battle');
});

test('at maxSteps unresolved quest becomes failed and closes', () => {
  const state = base({ totalStep: 40, phase: 'explore', quest: { status: 'active' } });
  const decision = normalizeAiDecision({ phase: 'explore' }, { phase: 'explore' });
  const next = resolveNextPhase(state, decision);
  assert.equal(state.quest.status, 'active');
  assert.equal(next, 'closing');
});

test('at maxSteps forged success cannot override unresolved prior state', () => {
  const state = base({ totalStep: 40, quest: { status: 'active' }, encounter: { status: 'active' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.quest.status, 'failed');
  assert.equal(state.encounter.status, 'escaped');
  assert.equal(state.phase, 'closing');
});

test('at maxSteps malformed or missing encounter settles to escaped', () => {
  for (const encounter of [undefined, { status: 'bogus' }]) {
    const state = base({ totalStep: 40, quest: { status: 'completed' }, encounter });
    applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved' });
    assert.equal(state.encounter.status, 'escaped');
  }
});

test('at maxSteps missing quest settles to failed', () => {
  const state = base({ totalStep: 40, quest: undefined, encounter: { status: 'none' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'failed');
});

test('at maxSteps malformed prior quest cannot forge completion', () => {
  const state = base({ totalStep: 40, quest: { status: 'bogus' }, encounter: { status: 'none' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'failed');
});

test('applyAiDecision initializes missing quest and encounter containers', () => {
  const state = base(); delete state.quest; delete state.encounter;
  applyAiDecision(state, { phase: 'explore', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'completed');
  assert.equal(state.encounter.status, 'none');
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

test('itemUseCheck only considers the acting member own equipment and bag', () => {
  const dg = {
    party: [
      { id: 'a', name: '甲', equipment: [], bag: [] },
      { id: 'b', name: '乙', equipment: [{ name: '铁剑', kind: 'weapon', qty: 1 }], bag: [] },
    ],
    itemLoans: [],
  };
  const original = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(itemUseCheck(dg, 'battle', dg.party[0]), null);
  } finally {
    Math.random = original;
  }
});

test('recordItemLoan authorizes only the named borrower and exposes ownership metadata', () => {
  const lender = { id: 'a', name: '甲', bag: [{ name: '聚气丹', kind: 'pill', qty: 1 }] };
  const borrower = { id: 'b', name: '乙', bag: [] };
  const dg = { party: [lender, borrower], itemLoans: [] };
  recordItemLoan(dg, lender, borrower, lender.bag[0]);
  const original = Math.random;
  Math.random = () => 0;
  try {
    const use = itemUseCheck(dg, 'explore', borrower);
    assert.equal(use.item.name, '聚气丹');
    assert.equal(use.item.ownerId, 'a');
    assert.equal(use.item.userId, 'b');
    assert.equal(use.item.loaned, true);
    assert.equal(itemUseCheck(dg, 'explore', { id: 'c', name: '丙', bag: [] }), null);
  } finally {
    Math.random = original;
  }
});

test('loaned quantity is unavailable to the lender until it is returned', () => {
  const lender = { id: 'a', name: '甲', equipment: [{ name: '铁剑', kind: 'weapon', qty: 1 }], bag: [] };
  const borrower = { id: 'b', name: '乙', equipment: [], bag: [] };
  const dg = { party: [lender, borrower], itemLoans: [] };
  recordItemLoan(dg, lender, borrower, lender.equipment[0]);
  const original = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(itemUseCheck(dg, 'battle', lender), null);
    assert.equal(itemUseCheck(dg, 'battle', borrower).item.name, '铁剑');
  } finally {
    Math.random = original;
  }
});

test('consumeItemUse decrements the original owner inventory and records borrower usage', () => {
  const lender = { id: 'a', name: '甲', bag: [{ name: '聚气丹', kind: 'pill', qty: 2 }] };
  const borrower = { id: 'b', name: '乙', bag: [] };
  const dg = { party: [lender, borrower], itemLoans: [], consumed: [] };
  const loan = recordItemLoan(dg, lender, borrower, lender.bag[0]);
  const use = { item: { ...loan.item, ownerId: 'a', userId: 'b', loaned: true }, success: true };
  const result = consumeItemUse(dg, use, { explicitUse: true });
  assert.equal(result.consumed, true);
  assert.equal(lender.bag[0].qty, 1);
  assert.deepEqual(dg.consumed[0], { name: '聚气丹', ownerId: 'a', userId: 'b', qty: 1, loaned: true });
});

test('nonconsumable loan is not removed and settlement reports it for return', () => {
  const lender = { id: 'a', name: '甲', equipment: [{ name: '铁剑', kind: 'weapon', qty: 1 }] };
  const borrower = { id: 'b', name: '乙', equipment: [] };
  const dg = { party: [lender, borrower], itemLoans: [], consumed: [] };
  recordItemLoan(dg, lender, borrower, lender.equipment[0]);
  const result = settleItemLoans(dg);
  assert.deepEqual(result, [{ name: '铁剑', ownerId: 'a', userId: 'b', qty: 1 }]);
  assert.equal(lender.equipment[0].qty, 1);
  assert.equal(dg.itemLoans.length, 0);
});

test('consumables require explicit successful use text before inventory changes', () => {
  const actor = { id: 'a', name: '甲', bag: [{ name: '聚气丹', kind: 'pill', qty: 1 }] };
  const dg = { party: [actor], itemLoans: [], consumed: [] };
  const item = { ...actor.bag[0], ownerId: 'a', userId: 'a', owner: actor, source: 'bag' };
  assert.equal(itemUseExplicitInText('甲取出聚气丹，略作端详后又收了起来。', item, actor), false);
  assert.equal(itemUseExplicitInText('甲仰头服下聚气丹，药力随即散开。', item, actor), true);
  assert.equal(consumeItemUse(dg, { item, success: false }, { explicitUse: true }).consumed, false);
  assert.equal(consumeItemUse(dg, { item, success: true }, { explicitUse: false }).consumed, false);
  assert.equal(actor.bag[0].qty, 1);
});

test('failed or negated consumable attempts are not treated as explicit use', () => {
  const actor = { id: 'a', name: '甲', bag: [{ name: '镇魂符', kind: 'talisman', qty: 1 }] };
  const item = { ...actor.bag[0], ownerId: 'a', userId: 'a', owner: actor, source: 'bag' };
  assert.equal(itemUseExplicitInText('甲尝试激发镇魂符，但灵符未能生效。', item, actor), false);
  assert.equal(itemUseExplicitInText('甲取出镇魂符，却没有使用。', item, actor), false);
  assert.equal(itemUseExplicitInText('甲激发镇魂符，符火轰然燃起。', item, actor), true);
});

test('explicit lending text creates a future borrower authorization', () => {
  const lender = { id: 'a', name: '甲', bag: [{ name: '聚气丹', kind: 'pill', qty: 2 }] };
  const borrower = { id: 'b', name: '乙', bag: [] };
  const dg = { party: [lender, borrower], itemLoans: [] };
  const records = recordItemLoansFromText(dg, '甲从储物袋取出聚气丹，明确递给乙暂用。');
  assert.equal(records.length, 1);
  assert.equal(records[0].ownerId, 'a');
  assert.equal(records[0].userId, 'b');
  assert.equal(dg.itemLoans[0].name, '聚气丹');
  assert.equal(dg.itemLoans[0].loaned, true);
});

test('loan parsing treats character and item names as literal text', () => {
  const lender = { id: 'a', name: '甲(一)', bag: [{ name: '聚气丹+1', kind: 'pill', qty: 1 }] };
  const borrower = { id: 'b', name: '乙[二]', bag: [] };
  const dg = { party: [lender, borrower], itemLoans: [] };
  assert.equal(recordItemLoansFromText(dg, '甲(一)将聚气丹+1递给乙[二]暂用。').length, 1);
});

test('payload lists only actor-owned and explicitly loaned available items', () => {
  const dg = createDg({ level: 1, exp: 0, name: '甲' }, { choice: '枯骨林' });
  const actor = { id: 'a', name: '甲', traits: [], skills: [], equipment: [], bag: [{ name: '聚气丹', kind: 'pill', qty: 1 }] };
  const other = { id: 'b', name: '乙', traits: [], skills: [], equipment: [{ name: '铁剑', kind: 'weapon', qty: 1 }], bag: [] };
  dg.party = [actor, other];
  dg.focusPlan = [{ mode: 'focus', focusStep: 1, windowSize: 1 }];
  const payload = aiStoryPayload(dg, 'explore', actor, null, null, 'luck', 10, 0, 10, null, null);
  assert.deepEqual(payload.availableItems.map(item => item.name), ['聚气丹']);
  recordItemLoan(dg, other, actor, other.equipment[0]);
  const loanPayload = aiStoryPayload(dg, 'battle', actor, null, null, 'strength', 10, 0, 10, null, null);
  assert.deepEqual(loanPayload.availableItems.map(item => [item.name, item.ownerName, item.userName, item.loaned]), [
    ['聚气丹', '甲', '甲', false],
    ['铁剑', '乙', '甲', true],
  ]);
});
