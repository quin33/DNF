const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const GE = require('../game-engine.js');

const source = fs.readFileSync('server.js', 'utf8');
const stepSource = source.slice(source.indexOf('async function dungeonStep'), source.indexOf('function parseAiStoryResponse'));
const parserSource = source.slice(source.indexOf('function parseAiStoryResponse'), source.indexOf('async function callAIStory'));
const snapshotSource = source.slice(source.indexOf('function roomStatePublic'), source.indexOf('function addMember'));

function makeDg(overrides = {}) {
  const actor = { id: 'p1', name: '测试修士', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], skills: [] };
  return {
    id: 'run-1', flowMode: 'dynamic', minSteps: 10, preferredMaxSteps: 25, maxSteps: 40, phase: 'explore',
    quest: { status: 'active', objective: '测试任务' }, encounter: { status: 'none', name: '' },
    lastDecision: {}, nextHint: '', plan: [{ key: 'opening', label: '入谷', steps: 1 }], planIdx: 0, stepIdx: 0,
    totalStep: 10, steps: [], party: [actor], focusPlan: [], memberGains: { p1: { acts: 0, rolls: [], damage: 0, crits: 0, fumbles: 0 } },
    dungeon: { name: '枯骨林', baseName: '枯骨林', lore: '', enemies: [], bosses: [], specialEvent: false },
    damage: 0, bossDrops: [], consumed: [],
    ...overrides,
  };
}

function createHarness(response, engine = GE) {
  const events = { broadcasts: [], scheduled: 0, settled: 0, payloads: [], extras: [] };
  const context = {
    GE: engine,
    callAIStory: async (payload, extra = '') => {
      events.payloads.push(payload);
      events.extras.push(extra);
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(payload) : response;
    },
    settleRoom: async () => { events.settled++; },
    scheduleTick: () => { events.scheduled++; },
    broadcastAll: message => events.broadcasts.push(message),
    DB: { checkpointExpeditionRun: () => true },
    durableRunSnapshot: room => ({ steps: room.dg.steps }),
    console,
  };
  vm.createContext(context);
  vm.runInContext(stepSource, context);
  return { step: context.dungeonStep, events };
}

function decision(phase = 'explore') {
  return { phase, questStatus: 'active', encounterStatus: 'none', continue: true };
}

function parseStory(content, fallback) {
  const context = { GE };
  vm.createContext(context);
  vm.runInContext(parserSource, context);
  return context.parseAiStoryResponse(content, fallback);
}

function makeSnapshot(dg) {
  const context = {};
  vm.createContext(context);
  vm.runInContext(snapshotSource, context);
  return context.runningSnapshot({
    id: 'room-1',
    status: 'running',
    party: dg.party.map(member => ({ ...member, charId: member.charId || member.id })),
    dg,
  });
}

test('plain text fallback advances the first opening step to explore', async () => {
  const dg = makeDg({ phase: 'opening', totalStep: 0 });
  const fallback = parseStory('宗门执事命众人入谷。', { phase: 'opening', questStatus: 'active', encounterStatus: 'none' });
  const { step, events } = createHarness(fallback);
  await step({ dg });
  assert.equal(dg.phase, 'explore');
  assert.equal(events.scheduled, 1);
});

test('prior active encounter blocks same-step resolve-and-loot and broadcasts normalized state', async () => {
  const dg = makeDg({ phase: 'boss', encounter: { status: 'active', name: '白骨将军' } });
  const response = { text: '首领败退，战局暂歇。', structured: true, decision: { phase: 'loot', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved', nextHint: '确认战场', continue: true } };
  const { step, events } = createHarness(response);
  await step({ dg });
  assert.equal(dg.phase, 'boss');
  assert.equal(dg.encounter.status, 'resolved');
  const message = events.broadcasts.at(-1).step;
  assert.equal(message.phase, 'boss');
  assert.equal(message.questStatus, 'completed');
  assert.equal(message.encounterStatus, 'resolved');
  assert.equal(message.continue, true);
});

test('continue false outside closing schedules another step while legal closing requires continue false', async () => {
  const nonClosing = makeDg();
  let harness = createHarness({ text: '继续探索。', structured: true, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: false } });
  await harness.step({ dg: nonClosing });
  assert.equal(harness.events.settled, 0);
  assert.equal(harness.events.scheduled, 1);

  const closingContinues = makeDg({ quest: { status: 'completed' }, encounter: { status: 'resolved' } });
  harness = createHarness({ text: '众人整点所得。', structured: true, decision: { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved', continue: true } });
  await harness.step({ dg: closingContinues });
  assert.equal(harness.events.settled, 0);
  assert.equal(harness.events.scheduled, 1);

  const closingStops = makeDg({ quest: { status: 'completed' }, encounter: { status: 'resolved' } });
  harness = createHarness({ text: '众人回宗复命。', structured: true, decision: { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved', continue: false } });
  await harness.step({ dg: closingStops });
  assert.equal(harness.events.settled, 1);
  assert.equal(harness.events.scheduled, 0);
});

test('below minSteps forces continue true for non-closing decisions and broadcasts it', async () => {
  const dg = makeDg({ totalStep: 7 });
  const harness = createHarness({ text: '线索仍未查清。', structured: true, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: false } });
  await harness.step({ dg });
  assert.equal(dg.lastDecision.continue, true);
  assert.equal(harness.events.broadcasts.at(-1).step.continue, true);
  assert.equal(harness.events.scheduled, 1);
});

test('dynamic focus is available in payload, persists on success, and rolls back on AI failure', async () => {
  const dg = makeDg();
  let harness = createHarness(payload => {
    assert.equal(payload.focus.actor, '测试修士');
    return { text: '山路幽深。', structured: true, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } };
  });
  await harness.step({ dg });
  assert.equal(dg.focusPlan.length, 1);

  const failed = makeDg();
  harness = createHarness(new Error('AI failure'));
  await assert.rejects(() => harness.step({ dg: failed }), /AI failure/);
  assert.equal(failed.focusPlan.length, 0);

  const empty = makeDg();
  harness = createHarness({ text: '', structured: true, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } });
  await assert.rejects(() => harness.step({ dg: empty }), /AI 返回空内容/);
  assert.equal(empty.focusPlan.length, 0);

  const payloadFailure = makeDg();
  const brokenEngine = {
    ...GE,
    aiStoryPayload() { throw new Error('payload failure'); },
  };
  harness = createHarness(null, brokenEngine);
  await assert.rejects(() => harness.step({ dg: payloadFailure }), /payload failure/);
  assert.equal(payloadFailure.focusPlan.length, 0);
});

test('max step marks unresolved dynamic run as forced failure before settlement', async () => {
  const dg = makeDg({ totalStep: 39, quest: { status: 'active' }, encounter: { status: 'active', name: '白骨将军' } });
  const { step, events } = createHarness({ text: '众人力竭撤离。', structured: true, decision: { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved', continue: false } });
  await step({ dg });
  assert.equal(dg.quest.status, 'failed');
  assert.equal(dg.encounter.status, 'escaped');
  assert.equal(dg.forcedTerminal, 'failed');
  assert.equal(events.settled, 1);
});

test('step 26 remains a soft overrun and continues when the current conflict is unresolved', async () => {
  const dg = makeDg({ totalStep: 25, phase: 'boss', quest: { status: 'active' }, encounter: { status: 'active', name: '白骨将军' } });
  const { step, events } = createHarness({ text: '众人合力压制白骨将军，冲突仍待最后一击。', structured: true, decision: { phase: 'boss', questStatus: 'active', encounterStatus: 'active', continue: true } });
  await step({ dg });
  assert.equal(dg.totalStep, 26);
  assert.equal(events.settled, 0);
  assert.equal(events.scheduled, 1);
});

test('new runs expose dynamic state and settlement uses forced terminal outcome', () => {
  assert.match(source, /flowMode: dg\.flowMode \|\| 'legacy'/);
  const fnSource = source.slice(source.indexOf('function resolveSettlementOk'), source.indexOf('async function settleRoom'));
  const context = { module: {}, exports: {}, console };
  vm.createContext(context);
  vm.runInContext(fnSource + '\nthis.resolveSettlementOk = resolveSettlementOk;', context);
  assert.equal(context.resolveSettlementOk({ forcedTerminal: 'failed' }, true), false);
  assert.equal(context.resolveSettlementOk({ forcedTerminal: null }, true), true);
});

test('snapshot without flowMode stays legacy and advances through its saved plan', async () => {
  const dg = makeDg({
    flowMode: undefined,
    totalStep: 0,
    phase: undefined,
    plan: [{ key: 'opening', label: '入谷', steps: 1, check: false }],
  });
  const harness = createHarness({ text: '众人循旧路线进入山谷。', structured: false, decision: {} });
  await harness.step({ dg });
  assert.equal(dg.planIdx, 1);
  assert.equal(harness.events.settled, 1);
  assert.equal(harness.events.scheduled, 0);

  const snapshot = makeSnapshot(dg);
  assert.equal(snapshot.flowMode, 'legacy');
});

test('dynamic running snapshot carries authoritative flow state for reconnecting clients', () => {
  const lastDecision = { phase: 'boss', event: 'advance', questStatus: 'active', encounterStatus: 'active', nextHint: '击破阵眼', continue: true };
  const dg = makeDg({
    totalStep: 17,
    phase: 'boss',
    quest: { status: 'active', objective: '解除碑林执念' },
    encounter: { status: 'active', name: '守碑残魂' },
    lastDecision,
    nextHint: '击破阵眼',
  });
  const snapshot = makeSnapshot(dg);
  assert.equal(snapshot.flowMode, 'dynamic');
  assert.equal(snapshot.minSteps, 10);
  assert.equal(snapshot.preferredMaxSteps, 25);
  assert.equal(snapshot.maxSteps, 40);
  assert.equal(snapshot.phase, 'boss');
  assert.deepEqual(snapshot.quest, dg.quest);
  assert.deepEqual(snapshot.encounter, dg.encounter);
  assert.deepEqual(snapshot.lastDecision, lastDecision);
  assert.equal(snapshot.nextHint, '击破阵眼');

  const authSource = source.slice(source.indexOf("case 'auth':"), source.indexOf("case 'match_start':"));
  assert.match(authSource, /runningSnapshot\(room\)/);
  assert.match(authSource, /type: 'dungeon_resumed'/);
});

test('#69175 unresolved deeper obsession and incomplete inscription cannot jump to loot or closing', () => {
  const dg = makeDg({
    totalStep: 13,
    phase: 'boss',
    quest: { status: 'active', objective: '查清碑林真正的执念' },
    encounter: { status: 'active', name: '守碑残魂' },
  });

  GE.applyAiDecision(dg, { phase: 'closing', event: 'advance', questStatus: 'active', encounterStatus: 'active', nextHint: '碑面只显出半句铭文', continue: false });
  assert.equal(dg.phase, 'boss');
  assert.equal(dg.quest.status, 'active');
  assert.equal(dg.encounter.status, 'active');

  GE.applyAiDecision(dg, { phase: 'loot', event: 'resolve', questStatus: 'active', encounterStatus: 'resolved', nextHint: '真正执念仍在更深处', continue: true });
  assert.equal(dg.phase, 'boss');
  assert.equal(dg.quest.status, 'active');
  assert.equal(dg.encounter.status, 'resolved');
});

test('dungeon step checks only the acting member items and consumes after explicit successful use text', async () => {
  const actor = { id: 'p2', name: '乙', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [{ name: '聚气丹', kind: 'pill', qty: 1 }], skills: [] };
  const first = { id: 'p1', name: '甲', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [], skills: [] };
  const make = () => makeDg({ totalStep: 12, party: [first, structuredClone(actor)], memberGains: { p1: { acts: 0, rolls: [], damage: 0 }, p2: { acts: 0, rolls: [], damage: 0 } } });

  const mentioned = make();
  let harness = createHarness({ text: '乙取出聚气丹看了看，最终仍将它收回储物袋。', structured: true, itemUse: null, heal: 25, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } });
  await harness.step({ dg: mentioned });
  assert.equal(mentioned.party[1].hp, 100);
  assert.equal(mentioned.party[1].bag[0].qty, 1);
  assert.deepEqual(mentioned.consumed, []);

  const used = make();
  used.party[1].hp = 60;
  harness = createHarness({ text: '乙仰头服下聚气丹，药力随即散入经脉。', structured: true, itemUse: { name: '聚气丹', success: true }, heal: 25, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } });
  await harness.step({ dg: used });
  assert.equal(used.party[1].hp, 85);
  assert.equal(used.party[1].bag.length, 0);
  assert.deepEqual(used.consumed[0], { name: '聚气丹', ownerId: 'p2', userId: 'p2', qty: 1, loaned: false });
});

test('dungeon step applies AI healing from a successful treatment skill', async () => {
  const actor = { id: 'p1', name: '甲', hp: 55, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [], skills: [{ name: '疗伤术' }] };
  const dg = makeDg({ party: [actor], memberGains: { p1: { acts: 0, rolls: [], damage: 0 } } });
  const harness = createHarness({ text: '甲施展疗伤术，柔和的灵光修复了伤口。', structured: true, skillUse: { name: '疗伤术', success: true }, heal: 30, decision: decision() });
  await harness.step({ dg });
  assert.equal(dg.party[0].hp, 85);
});

test('dungeon step heals from narrative recovery even when AI omits skillUse', async () => {
  const actor = { id: 'p1', name: '甲', hp: 55, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [], skills: [{ name: '疗伤术' }] };
  const dg = makeDg({ party: [actor], memberGains: { p1: { acts: 0, rolls: [], damage: 0 } } });
  const harness = createHarness({ text: '甲施展疗伤术，灵光覆上伤口，气血缓缓回升。', structured: true, heal: 30, decision: decision() });
  await harness.step({ dg });
  assert.equal(dg.party[0].hp, 85);
  assert.equal(dg.steps[0].healTargetName, '甲');
});

test('dungeon step records an explicit narrative loan for later use', async () => {
  const lender = { id: 'p1', name: '甲', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [{ name: '铁剑', kind: 'weapon', qty: 1 }], bag: [], skills: [] };
  const borrower = { id: 'p2', name: '乙', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [], skills: [] };
  const dg = makeDg({ totalStep: 10, party: [lender, borrower], itemLoans: [], memberGains: { p1: { acts: 0, rolls: [], damage: 0 }, p2: { acts: 0, rolls: [], damage: 0 } } });
  const engine = { ...GE, itemUseCheck: () => null };
  const harness = createHarness({ text: '甲将铁剑递给乙暂用，自己退后警戒。', structured: true, decision: { phase: 'explore', questStatus: 'active', encounterStatus: 'none', continue: true } }, engine);
  await harness.step({ dg });
  assert.equal(dg.itemLoans.length, 1);
  assert.equal(dg.itemLoans[0].ownerId, 'p1');
  assert.equal(dg.itemLoans[0].userId, 'p2');
});

test('item guard rewrites an unauthorized item use with ownership feedback', async () => {
  const owner = { id: 'p1', name: '测试修士', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [{ name: '净魂道铃', kind: 'misc', qty: 1 }], bag: [], skills: [] };
  const npc = { id: 'npc-1', name: '顾长风', hp: 100, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [], skills: [] };
  const dg = makeDg({ party: [owner, npc], itemLoans: [], itemRegistry: [] });
  const replies = [
    { text: '顾长风摇动净魂道铃，铃音清越。', structured: true, decision: decision() },
    { text: '测试修士摇动净魂道铃，铃音清越。', structured: true, decision: decision() },
  ];
  let calls = 0;
  const harness = createHarness(() => replies[Math.min(calls++, replies.length - 1)]);

  await harness.step({ dg });

  assert.equal(calls, 2);
  assert.match(harness.events.extras[1], /净魂道铃归测试修士所有/);
  assert.match(harness.events.extras[1], /顾长风/);
  assert.equal(dg.steps.length, 1);
  assert.match(dg.steps[0].text, /测试修士摇动净魂道铃/);
});

test('low HP no longer forces an AI recovery retry when no consumable is used', async () => {
  const actor = { id: 'p1', name: '甲', hp: 60, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [{ name: '疗伤丹', kind: 'pill', desc: '恢复气血', qty: 2 }], skills: [] };
  const dg = makeDg({ totalStep: 12, party: [actor], memberGains: { p1: { acts: 0, rolls: [], damage: 0 } } });
  const harness = createHarness({ text: '甲挥剑斩开石像，左臂被碎石划开一道血口。', structured: true, damage: 20, decision: decision() });

  await harness.step({ dg });

  assert.equal(harness.events.payloads.length, 1);
  assert.equal(harness.events.extras[0], '');
  assert.equal(dg.party[0].hp, 40);
  assert.equal(dg.party[0].bag[0].qty, 2);
  assert.deepEqual(dg.consumed, []);
});

test('AI-declared recovery pill use still heals and deducts in one call', async () => {
  const actor = { id: 'p1', name: '甲', hp: 60, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [{ name: '疗伤丹', kind: 'pill', desc: '恢复气血', qty: 2 }], skills: [] };
  const dg = makeDg({ totalStep: 12, party: [actor], memberGains: { p1: { acts: 0, rolls: [], damage: 0 } } });
  const harness = createHarness({ text: '甲取出一枚疗伤丹咽下，气血缓缓回升。', structured: true, itemUse: { name: '疗伤丹', success: true }, heal: 40, decision: decision() });

  await harness.step({ dg });

  assert.equal(harness.events.payloads.length, 1);
  assert.equal(dg.party[0].hp, 100);
  assert.equal(dg.party[0].bag[0].qty, 1);
  assert.deepEqual(dg.consumed[0], { name: '疗伤丹', ownerId: 'p1', userId: 'p1', qty: 1, loaned: false });
});

test('successful healing skill resolves low HP in a single call', async () => {
  const actor = { id: 'p1', name: '甲', hp: 55, max_hp: 100, level: 1, strength: 10, agility: 10, intelligence: 10, luck: 10, traits: [], equipment: [], bag: [{ name: '疗伤丹', kind: 'pill', desc: '恢复气血', qty: 1 }], skills: [{ name: '疗伤术' }] };
  const dg = makeDg({ party: [actor], memberGains: { p1: { acts: 0, rolls: [], damage: 0 } } });
  const harness = createHarness({ text: '甲施展疗伤术，灵光覆上伤口，气血缓缓回升。', structured: true, skillUse: { name: '疗伤术', success: true }, heal: 30, decision: decision() });

  await harness.step({ dg });

  assert.equal(harness.events.payloads.length, 1);
  assert.equal(dg.party[0].hp, 85);
  assert.equal(dg.party[0].bag[0].qty, 1);
  assert.deepEqual(dg.consumed, []);
});
