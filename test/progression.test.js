const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GE = require('../game-engine');

test('qi progression adds 20-30 max HP, distributes five total stat points, and restores HP', () => {
  const role = { level: 3, hp: 12, max_hp: 100, strength: 1, agility: 2, intelligence: 3, luck: 4 };
  const result = GE.applyLevelGrowth(role, { statIndexes: [0, 1, 2, 3, 0], hpGain: 20 });
  assert.equal(result.maxHpGain, 20);
  assert.equal(role.max_hp, 120);
  assert.equal(role.hp, 120);
  assert.deepEqual([role.strength, role.agility, role.intelligence, role.luck], [3, 3, 4, 5]);
});

test('breakthrough multiplies max HP by 1.5, distributes twenty total stat points, and restores HP', () => {
  const role = { level: 10, hp: 40, max_hp: 200, strength: 1, agility: 2, intelligence: 3, luck: 4 };
  GE.applyLevelGrowth(role, { breakthrough: true, statIndexes: Array.from({ length: 20 }, (_, index) => index % 4) });
  assert.equal(role.max_hp, 300);
  assert.equal(role.hp, 300);
  assert.deepEqual([role.strength, role.agility, role.intelligence, role.luck], [6, 7, 8, 9]);
});

test('foundation progression adds 30-50 max HP and distributes ten total stat points', () => {
  const role = { level: 11, hp: 1, max_hp: 300, strength: 1, agility: 2, intelligence: 3, luck: 4 };
  const result = GE.applyLevelGrowth(role, { statIndexes: [3, 3, 2, 2, 1, 1, 0, 0, 0, 0], hpGain: 50 });
  assert.equal(result.maxHpGain, 50);
  assert.equal(role.max_hp, 350);
  assert.equal(role.hp, 350);
  assert.deepEqual([role.strength, role.agility, role.intelligence, role.luck], [5, 4, 5, 6]);
});

test('foundation experience uses current level times 200 and applies foundation growth', () => {
  const role = { level: 11, exp: 2_100, hp: 1, max_hp: 300, strength: 1, agility: 2, intelligence: 3, luck: 4 };
  const levels = GE.applyExperience(role, 100, { statIndexes: Array(10).fill(0), hpGain: 30 });
  assert.deepEqual(levels, [12]);
  assert.equal(role.exp, 0);
  assert.equal(role.max_hp, 330);
  assert.equal(role.hp, 330);
  assert.equal(role.strength, 11);
});

test('experience carries only the remainder after each level requirement', () => {
  const role = { level: 1, exp: 0, hp: 1, max_hp: 100, strength: 1, agility: 1, intelligence: 1, luck: 1 };
  const levels = GE.applyExperience(role, 120, { statIndexes: Array(5).fill(0), hpGain: 20 });
  assert.deepEqual(levels, [2]);
  assert.equal(role.exp, 20);
});

test('foundation progression can level repeatedly and stops at foundation completion', () => {
  const role = { level: 13, exp: 5_100, hp: 1, max_hp: 400, strength: 1, agility: 2, intelligence: 3, luck: 4 };
  const levels = GE.applyExperience(role, 100, { statIndexes: Array(10).fill(1), hpGain: 50 });
  assert.deepEqual(levels, [14]);
  assert.equal(role.exp, 2_800);
  assert.equal(role.max_hp, 450);
  assert.equal(role.hp, 450);
  assert.equal(role.agility, 12);
});

test('level ten uses a 2000 exp threshold and advances without a job change', () => {
  assert.equal(GE.experienceNeeded(10), 2000);
  assert.equal(GE.canBreakthrough({ level: 10, exp: 1999 }), false);
  assert.equal(GE.canBreakthrough({ level: 10, exp: 2000 }), true);
  const role = { level: 10, exp: 0, hp: 100, max_hp: 100, strength: 1, agility: 1, intelligence: 1, luck: 1 };
  const levels = GE.applyExperience(role, 2240, { statIndexes: Array(10).fill(0), hpGain: 20 });
  assert.deepEqual(levels, [11]);
  assert.equal(role.exp, 240);
  assert.equal(role.level, 11);
  assert.equal(role.max_hp, 120);
  assert.equal(role.hp, 120);
  assert.equal(role.strength, 11);
});

test('dungeons do not auto schedule a job change trial for an eligible level ten', () => {
  const role = { level: 10, exp: 2000 };
  for (let i = 0; i < 50; i++) {
    const dg = GE.createDg(role, { short: true });
    assert.equal(dg.dungeon.breakthrough, false);
    assert.ok(!dg.plan.some(plan => plan.key === 'breakthrough'), 'dungeon must not contain a breakthrough stage');
  }

  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const normalizeSource = server.slice(server.indexOf('function normalizeAiSetup'), server.indexOf('async function aiDecideSetup'));
  const context = {};
  vm.createContext(context);
  vm.runInContext(normalizeSource, context);
  const parsed = context.normalizeAiSetup({ breakthrough: true }, { enemies: [], levelMin: 1, levelMax: 19 });
  assert.equal(parsed.breakthrough, false);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const clientNormalize = html.slice(html.indexOf('function normalizeAiSetupClient'), html.indexOf('function pickDungeon'));
  assert.doesNotMatch(clientNormalize, /breakthrough: !!\(setup && setup\.breakthrough\)/);
  assert.match(clientNormalize, /breakthrough: false/);
});

test('local level ten keeps the same unlocked progression and UI label', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const local = html.slice(html.indexOf('function applyLocalExperience'), html.indexOf('function showSettlementById'));
  const card = html.slice(html.indexOf('function advCardHTML'), html.indexOf('function renderMine'));
  assert.doesNotMatch(local, /if \(level === 10\) break;/);
  assert.match(local, /if \(level >= 14\)/);
  assert.match(card, /const expCap = lv >= 14;/);
});

test('online and local dungeon plans share the same 10 to 40 step range', () => {
  const role = { level: 1, exp: 0 };
  for (let i = 0; i < 100; i++) {
    const dg = GE.createDg(role, { short: true });
    const total = dg.plan.reduce((sum, stage) => sum + stage.steps, 0);
    assert.ok(total >= 10 && total <= 40, `unexpected plan length: ${total}`);
  }
});
