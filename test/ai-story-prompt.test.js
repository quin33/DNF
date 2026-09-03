const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function buildPrompt(payload) {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = server.indexOf('function buildUserMessage');
  const source = server.slice(start, server.indexOf('\n/*', start));
  const context = {};
  require('node:vm').createContext(context);
  require('node:vm').runInContext(source + '\nthis.buildUserMessage = buildUserMessage;', context);
  return context.buildUserMessage(payload);
}

test('AI story prompt treats engine stages as narrative guidance instead of fixed chapters', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const systemPrompt = server.slice(server.indexOf('const SYSTEM_PROMPT'), server.indexOf('function buildUserMessage'));
  const userPrompt = server.slice(server.indexOf('function buildUserMessage'), server.indexOf('调用 LLM'));

  assert.match(systemPrompt, /阶段仅表示本步主要事件倾向/);
  assert.match(systemPrompt, /探索、交战、发现、追逐、撤退与休整可以自然穿插/);
  assert.doesNotMatch(systemPrompt, /整体副本日志由多步构成（入谷→探索→战斗→首领→搜刮→归途）/);
  assert.match(userPrompt, /叙事倾向/);
  assert.match(userPrompt, /无需把本步写成独立、封闭的固定章节/);
});

test('prompt documentation describes the same flexible narrative flow', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'xiuxian', 'ai_log_prompt.md'), 'utf8');

  assert.match(docs, /阶段是游戏机制提供的叙事倾向，而不是固定章节/);
  assert.match(docs, /开局任务与最终复命是仅有的固定结构锚点/);
  assert.doesNotMatch(docs, /按 入谷 → 探索 → 战斗 →（首领战）→ 搜刮 → 归途 的自然顺序展开/);
});

test('AI story prompt preserves a focus window and requires consequential character highlights', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const docs = fs.readFileSync(path.join(ROOT, 'xiuxian', 'ai_log_prompt.md'), 'utf8');

  assert.match(server, /【本段叙事焦点】/);
  assert.match(server, /连续焦点第/);
  assert.match(server, /关键选择或行动/);
  assert.match(server, /明确改变局面或带来结果/);
  assert.match(server, /不得无理由切换到其他角色的内心或主视角/);
  assert.match(docs, /同一角色连续保持 2~3 步叙事焦点/);
  assert.match(docs, /能力依据 → 关键选择或行动 → 明确结果/);
});

test('AI story prompt constrains each step to an explicit cast and bans decorative cameos', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const docs = fs.readFileSync(path.join(ROOT, 'xiuxian', 'ai_log_prompt.md'), 'utf8');

  assert.match(server, /【本步允许出场】/);
  assert.match(server, /【本步禁止主动出场】/);
  assert.match(server, /无功能出场/);
  assert.match(server, /不得主动出现、说话、行动、观察、回头/);
  assert.match(docs, /允许出场名单/);
  assert.match(docs, /无功能出场/);
  assert.match(docs, /不得主动出现、说话、行动、观察、回头/);
});

test('dynamic prompt lets AI choose direction while reporting authoritative state fields', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '枯骨林', party: [], stepNo: 12, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'boss', stage: 'boss', stageLabel: '首领', quest: { status: 'active', objective: '查清碑林执念' },
    encounter: { status: 'active', name: '守碑残魂' }, lastDecision: { phase: 'boss' }, nextHint: '碑文只显出半句',
  });

  assert.match(prompt, /AI 自行决定下一叙事方向/);
  assert.match(prompt, /任务状态：active/);
  assert.match(prompt, /遭遇状态：active/);
  assert.match(prompt, /最少 10 步，最多 40 步/);
  assert.match(prompt, /正常目标为 10.?25 步/);
  assert.match(prompt, /25 步是建议长度，不是强制结束点/);
  for (const field of ['text', 'phase', 'event', 'questStatus', 'encounterStatus', 'nextHint', 'continue']) assert.match(prompt, new RegExp(`"${field}"`));
  assert.match(prompt, /phase 只是建议/);
  assert.match(prompt, /正文确实解决/);
  assert.match(prompt, /只描述本步已经发生/);
  assert.doesNotMatch(prompt, /只输出正文/);
  assert.doesNotMatch(prompt, /共 40 步/);
});

test('passing the preferred 25-step target does not force an unfinished run to close', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '枯骨林', party: [], stepNo: 26, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'boss', stage: 'boss', quest: { status: 'active', objective: '解除执念' }, encounter: { status: 'active', name: '守碑残魂' },
  });
  assert.match(prompt, /已经超过建议的 25 步/);
  assert.match(prompt, /不得仅因超过建议长度就结束/);
  assert.match(prompt, /禁止新增地点、线索、敌人、任务目标或支线/);
  assert.match(prompt, /每一步都必须减少至少一项未决事项/);
  assert.match(prompt, /最多再用 3 步/);
  assert.doesNotMatch(prompt, /已进入最后两步/);
});

test('dynamic prompt starts converging before the 25-step target', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '枯骨林', party: [], stepNo: 20, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'explore', stage: 'explore', quest: { status: 'active', objective: '解除执念' }, encounter: { status: 'none', name: '' },
  });
  assert.match(prompt, /已进入目标区间的收束段/);
  assert.match(prompt, /不得为了补足角色高光而延长故事/);
  assert.match(prompt, /停止新增支线/);
});

test('dynamic prompt reserves the final two steps for resolving existing threads', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '枯骨林', party: [], stepNo: 39, minSteps: 10, maxSteps: 40,
    phase: 'boss', stage: 'boss', quest: { status: 'active', objective: '解除执念' }, encounter: { status: 'active', name: '守碑残魂' },
  });
  assert.match(prompt, /最后两步/);
  assert.match(prompt, /不得引入新的未闭合主线/);
  assert.match(prompt, /解决当前冲突或明确撤退/);
});

test('dynamic prompt restricts item use to actor-owned or explicitly loaned items', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '枯骨林', party: [], stepNo: 4, minSteps: 10, maxSteps: 40,
    phase: 'explore', stage: 'explore', stageLabel: '探索', quest: { status: 'active', objective: '查清异动' },
    encounter: { status: 'none', name: '' }, actor: '乙',
    itemUse: { name: '聚气丹', kind: 'pill', roll: 15, total: 15, success: true, ownerName: '甲', userName: '乙', loaned: true },
    availableItems: [{ name: '聚气丹', ownerName: '甲', userName: '乙', loaned: true }],
  });
  assert.match(prompt, /只能使用本步明确列出的道具/);
  assert.match(prompt, /明确借出/);
  assert.match(prompt, /不得擅自使用其他角色/);
  assert.match(prompt, /使用者、原持有人/);
});

test('story prompts keep DNF dungeon vocabulary and avoid xianxia wording', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const systemPrompt = server.slice(server.indexOf('const SYSTEM_PROMPT'), server.indexOf('function buildUserMessage'));
  const specialPrompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '洛兰', specialEvent: true, party: [], stepNo: 3, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'explore', stage: 'explore', stageLabel: '探索', quest: { status: 'active', objective: '清剿盘踞洞口的哥布林' },
    encounter: { status: 'none', name: '' },
  });
  const banned = /真元|灵光|掐诀|道友|同道|机缘|入谷|归途|破境|冲关|宝光|凶机/;

  assert.match(systemPrompt, /DNF|阿拉德/);
  assert.match(systemPrompt, /赫顿玛尔/);
  assert.match(systemPrompt, /任务板|冒险家公会/);
  assert.match(systemPrompt, /地下城/);
  assert.match(systemPrompt, /技能书|生命药水|魔力药水|职业/);
  assert.match(systemPrompt, /撤离回城/);
  assert.match(systemPrompt, /金币|报酬/);
  assert.match(specialPrompt, /副本出现异变|地图异动/);
  assert.doesNotMatch(systemPrompt, banned);
  assert.doesNotMatch(specialPrompt, banned);
});

test('special event prompt carries the active map template into the narrative', () => {
  const prompt = buildPrompt({
    flowMode: 'dynamic', dungeon: '洛兰', specialEvent: true,
    activeSpecialEvent: { name: '哥布林夜袭营啸', desc: '哥布林举着火把冲营而来，营栅外绿影攒动。' },
    party: [], stepNo: 3, minSteps: 10, preferredMaxSteps: 25, maxSteps: 40,
    phase: 'explore', stage: 'explore', stageLabel: '探索', quest: { status: 'active', objective: '调查异动' },
    encounter: { status: 'none', name: '' },
  });
  assert.match(prompt, /哥布林夜袭营啸/);
  assert.match(prompt, /哥布林举着火把冲营而来/);
  assert.match(prompt, /把这一异动贯穿始终/);
});

test('non-dynamic closing prompt frames the return as guild settlement', () => {
  const prompt = buildPrompt({
    dungeon: '洛兰', party: [], stepNo: 12, totalSteps: 12, stage: 'closing', stageLabel: '撤离回城',
  });
  const banned = /真元|灵光|掐诀|道友|同道|机缘|入谷|归途|破境|冲关|宝光|凶机/;

  assert.match(prompt, /叙事倾向：撤离回城/);
  assert.match(prompt, /回到赫顿玛尔向公会复命、领取任务报酬/);
  assert.doesNotMatch(prompt, banned);
});
