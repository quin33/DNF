const test = require('node:test');
const assert = require('node:assert/strict');

const GE = require('../game-engine.js');

function makeDungeon(totalMiddleSteps = 12) {
  return {
    dungeon: { name: '测试灵墟', baseName: '测试灵墟', enemies: [], bosses: [] },
    party: [
      { id: 'a', name: '甲' },
      { id: 'b', name: '乙' },
      { id: 'c', name: '丙' },
      { id: 'd', name: '丁' },
    ],
    plan: [
      { key: 'opening', steps: 1 },
      { key: 'explore', steps: totalMiddleSteps },
      { key: 'closing', steps: 1 },
    ],
    planIdx: 1,
    totalStep: 1,
    steps: [],
  };
}

test('narrative focus keeps one actor for two or three steps before rotating', () => {
  const plan = GE.buildNarrativeFocusPlan(makeDungeon(12));
  const focused = plan.filter(step => step.mode === 'focus');
  const windows = [];

  for (const step of focused) {
    const last = windows[windows.length - 1];
    if (!last || last.windowId !== step.windowId) windows.push({ windowId: step.windowId, actorIndex: step.actorIndex, steps: [step] });
    else last.steps.push(step);
  }

  assert.ok(windows.length >= 4);
  assert.deepEqual(windows.slice(0, 4).map(window => window.actorIndex), [0, 1, 2, 3]);
  for (const window of windows) {
    assert.ok(window.steps.length === 2 || window.steps.length === 3);
    assert.ok(window.steps.every(step => step.actorIndex === window.actorIndex));
    assert.ok(window.steps.slice(0, -1).every(step => step.supportIndex === (window.actorIndex + 1) % 4));
    assert.equal(window.steps.at(-1).highlight, true);
    assert.equal(window.steps.at(-1).supportIndex, null);
  }
});

test('narrative focus gives every party member a high-light payoff in a minimum run', () => {
  const plan = GE.buildNarrativeFocusPlan(makeDungeon(8));
  const highlights = plan.filter(step => step.highlight);

  assert.deepEqual(highlights.map(step => step.actorIndex), [0, 1, 2, 3]);
  assert.ok(plan.find(step => step.stageKey === 'opening' && step.mode === 'group'));
  assert.ok(plan.find(step => step.stageKey === 'closing' && step.mode === 'group'));
});

test('long expeditions keep every focus window within three steps', () => {
  const plan = GE.buildNarrativeFocusPlan(makeDungeon(30));
  const counts = new Map();
  for (const step of plan.filter(entry => entry.mode === 'focus')) counts.set(step.windowId, (counts.get(step.windowId) || 0) + 1);

  assert.ok(counts.size > 4);
  assert.ok([...counts.values()].every(size => size === 2 || size === 3));
});

test('opening and closing remain group scenes outside the focus windows', () => {
  const plan = GE.buildNarrativeFocusPlan(makeDungeon(8));

  assert.equal(plan[0].mode, 'group');
  assert.equal(plan.at(-1).mode, 'group');
  assert.equal(plan[0].highlight, false);
  assert.equal(plan.at(-1).highlight, false);
});

test('breakthrough focus is pinned to the player whose settlement can advance', () => {
  const dg = makeDungeon(6);
  dg.plan.splice(-1, 0, { key: 'breakthrough', steps: 2 });
  const breakthrough = GE.buildNarrativeFocusPlan(dg).filter(step => step.stageKey === 'breakthrough');

  assert.equal(breakthrough.length, 2);
  assert.ok(breakthrough.every(step => step.actorIndex === 0));
  assert.ok(breakthrough.every(step => step.supportIndex === null && step.support2Index === null));
  assert.deepEqual(breakthrough.map(step => step.focusStep), [1, 2]);
  assert.deepEqual(breakthrough.map(step => step.highlight), [false, true]);
});

test('focus payload exposes only the current cast as allowed story characters', () => {
  const dg = makeDungeon(4);
  dg.focusPlan = GE.buildNarrativeFocusPlan(dg);
  const payload = GE.aiStoryPayload(dg, 'explore', dg.party[0], dg.party[1], dg.party[2], 'intelligence', 12, 2, 14, null, null);

  assert.deepEqual(payload.allowedCharacters, ['甲', '乙', '丙']);
  assert.deepEqual(payload.forbiddenCharacters, ['丁']);
});

test('dynamic focus keeps two-step windows and gives every member a highlight by step nine', () => {
  const dg = makeDungeon(0);
  dg.flowMode = 'dynamic';
  dg.focusPlan = [];

  const opening = GE.appendDynamicNarrativeFocus(dg, 'opening');
  assert.equal(opening.mode, 'group');
  assert.equal(opening.highlight, false);

  for (let totalStep = 1; totalStep <= 8; totalStep++) {
    dg.totalStep = totalStep;
    GE.appendDynamicNarrativeFocus(dg, totalStep >= 6 ? 'boss' : 'explore');
  }

  const focused = dg.focusPlan.slice(1);
  assert.deepEqual(focused.map(entry => entry.actorIndex), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(focused.map(entry => entry.focusStep), [1, 2, 1, 2, 1, 2, 1, 2]);
  assert.deepEqual(focused.filter(entry => entry.highlight).map(entry => entry.actorIndex), [0, 1, 2, 3]);
  assert.ok(focused.every(entry => entry.windowSize === 2));
  assert.ok(focused.filter(entry => entry.highlight).every(entry => entry.supportIndex === null && entry.support2Index === null));
});
