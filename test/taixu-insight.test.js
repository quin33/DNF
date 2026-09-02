const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const TI = require('../taixu-insight');

test('taixu insight accepts a valid skill and preserves the selected type', () => {
  const result = TI.parseTaixuInsight(
    '{"name":"烈焰冲击","type":"物理技","elem":"火","desc":"缠上斗气的一拳，撕开魔物护甲，久用会加速体力消耗。"}',
    '物理技',
    new Set(['火球术'])
  );

  assert.deepEqual(result, {
    name: '烈焰冲击',
    type: '物理技',
    elem: '火',
    desc: '缠上斗气的一拳，撕开魔物护甲，久用会加速体力消耗。',
  });
});

test('taixu insight preserves generated descriptions up to 250 characters', () => {
  assert.match(TI.TAIXU_INSIGHT_SYSTEM_PROMPT, /描述[^\n]{0,40}200\s*字以内/);
  const result = TI.parseTaixuInsight(JSON.stringify({
    name: '长篇护体诀', type: '物理技', elem: '火', desc: '护'.repeat(300),
  }), '物理技', new Set());
  assert.equal(result.desc.length, 250);
});

test('taixu insight rejects invalid or duplicate AI results', () => {
  assert.throws(
    () => TI.parseTaixuInsight('{"name":"雷诀","type":"魔法技","desc":"护体"}', '物理技', new Set()),
    /类型/
  );
  assert.throws(
    () => TI.parseTaixuInsight('{"name":"火球术","type":"魔法技","desc":"聚火伤敌"}', '魔法技', new Set(['火球术'])),
    /重复/
  );
  assert.throws(
    () => TI.parseTaixuInsight('{"name":"破�诀","type":"物理技","desc":"护体"}', '物理技', new Set()),
    /乱码/
  );
});

test('taixu prompt derives the character state from the authoritative skill list', () => {
  const prompt = TI.buildTaixuInsightPrompt({
    name: '云岚',
    character_class: '狂战士',
    skills: [{ name: '崩山击', type: '物理技', desc: '奋力一击震荡大地。' }],
    skillPool: [{ name: '怒气爆发', type: '魔法技', desc: '积蓄怒气爆发周身。' }],
  }, '物理技', '护体并在低血量时反击');

  assert.doesNotMatch(prompt, /【特质】/);
  for (const expected of ['狂战士', '崩山击', '怒气爆发', '护体并在低血量时反击', '必须降格']) {
    assert.match(prompt, new RegExp(expected));
  }
});

test('taixu prompt keeps player goals from dictating generated names', () => {
  const prompt = TI.buildTaixuInsightPrompt({
    name: '云岚',
    character_class: '狂战士',
  }, '物理技', '一定要生成强力技能并命名为烈焰真经');

  const instructions = `${TI.TAIXU_INSIGHT_SYSTEM_PROMPT}\n${prompt}`;
  assert.match(instructions, /期望功能方向（仅影响效果）/);
  assert.match(instructions, /名称/);
  assert.match(instructions, /自行决定|独立判断|不得.*影响/);
});

test('taixu access is currently free while retaining a cooldown check', () => {
  assert.deepEqual(TI.TAIXU_INSIGHT_COST, { gold: 0, stamina: 0, cooldownMs: 0 });
  assert.deepEqual(
    TI.validateTaixuInsightAccess({ gold: 0, stamina: 0 }, Date.now()),
    { ok: true, error: '', remainingMs: 0 }
  );
});

test('server exposes an authoritative taixu insight route with versioned save', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const start = server.indexOf('const taixuInsightMatch');
  const end = server.indexOf('const forgeMatch', start);
  const route = server.slice(start, end);

  assert.match(route, /\/taixu-insight/);
  assert.match(route, /body\.updated_at/);
  assert.match(route, /DB\.getCharacter/);
  assert.match(server, /TI\.buildTaixuInsightPrompt/);
  assert.match(server, /for \(let attempt = 0; attempt < 3/);
  assert.match(server, /DB\.saveCharacterIfCurrent/);
  assert.match(server, /role\.skills\.length < GE\.MAX_SKILLS/);
  assert.doesNotMatch(route, /body\.(root|traits|skills|character_class)/);
});

test('taixu insight is submitted as an asynchronous job with a status endpoint', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const start = server.indexOf('const taixuInsightMatch');
  const end = server.indexOf('const forgeMatch', start);
  const route = server.slice(start, end);

  assert.match(route, /status:\s*'pending'/);
  assert.match(server, /runTaixuInsightJob/);
  assert.match(server, /taixuInsightJobMatch/);
  assert.match(server, /status === 'completed'/);
});

test('character GET can settle display state without persisting a new version', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.slice(server.indexOf("if (req.method === 'GET')", server.indexOf('const charMatch')), server.indexOf("if (req.method === 'POST')", server.indexOf('const charMatch')));
  assert.match(route, /settleCultivation\(c\.data\)/);
  assert.doesNotMatch(route, /saveCharacter|notifyCharacterUpdated/);
});

test('taixu route validates input before mutating the authoritative role', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.slice(server.indexOf('const taixuInsightMatch'), server.indexOf('const forgeMatch'));

  assert.match(route, /goal\.length > 100/);
  assert.match(server, /TI\.validateTaixuInsightAccess/);
  assert.ok(server.indexOf('if (!skill)') < server.indexOf('.push(skill)'));
  assert.match(server, /storage = role\.skills\.length < GE\.MAX_SKILLS \? 'equipped' : 'pool'/);
});

test('online client posts taixu requests and refreshes the authoritative role', () => {
  const online = fs.readFileSync('online.js', 'utf8');

  assert.match(online, /window\.taixuInsight\s*=\s*async function/);
  assert.match(online, /\/taixu-insight/);
  assert.match(online, /updated_at:\s*role\._char_updated_at/);
  assert.match(online, /Object\.assign\(role, result\.character/);
  assert.match(online, /renderBuilding\(\)/);
});

test('online taixu insight polls the asynchronous job until completion', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const start = online.indexOf('window.taixuInsight = async function');
  const end = online.indexOf('window.matchTick', start);
  const insight = online.slice(start, end);

  assert.match(insight, /taixu-insight.*accepted\.jobId/);
  assert.match(insight, /status/);
  assert.match(insight, /setTimeout/);
});

test('online taixu insight retries once after a background character update conflict', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const start = online.indexOf('window.taixuInsight = async function');
  const end = online.indexOf('window.matchTick', start);
  const insight = online.slice(start, end);

  assert.match(insight, /for \(let attempt = 0; attempt < 2/);
  assert.match(insight, /角色数据已更新/);
  assert.match(insight, /await refreshOnlineRoles\(\)/);
  assert.match(online, /if \(taixuInsightInFlight\) break/);
});

test('online taixu insight pauses autosaves while the AI request is in flight', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /function saveRoleOnline\(\)\s*\{\s*if \(taixuInsightInFlight \|\| forgeInFlight\) return;/);
  assert.match(online, /taixuInsightInFlight = true;[\s\S]*clearTimeout\(_saveTimer\)/);
});

test('taixu settlement rebases onto the latest character snapshot after AI generation', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /const latestCharacter = DB\.getCharacter\(job\.userId, job\.charId\)/);
  assert.match(server, /saveCharacterIfCurrent\(job\.userId, job\.charId, latestCharacter\.updated_at/);
});

test('online mode does not persist passive stamina or HP regeneration', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const stamina = html.slice(html.indexOf('function regenerateStamina'), html.indexOf('function regenerateHp'));
  const hp = html.slice(html.indexOf('function regenerateHp'), html.indexOf('function regenerateAiHp'));
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /window\.__onlineMode\s*=\s*true/);
  assert.match(stamina, /if \(!window\.__onlineMode\) saveRole\(\)/);
  assert.match(hp, /if \(!window\.__onlineMode\) saveRole\(\)/);
});

test('building page exposes taixu realm type selection and a 100 character goal', () => {
  const data = fs.readFileSync('data.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');

  assert.match(data, /code:\s*'taixu_realm'/);
  assert.match(html, /FEATURED_BUILDING_CODES\s*=\s*new Set\(\[[^\]]*'taixu_realm'[^\]]*\]\)/);
  assert.match(html, /data-tab="building"[\s\S]*?<span class="tab-task-count">\$\{FEATURED_BUILDING_CODES\.size\}<\/span>/);
  assert.match(html, /filter\(b\s*=>\s*FEATURED_BUILDING_CODES\.has\(b\.code\)\)/);
  assert.match(html, /openTaixuRealmModal/);
  assert.match(html, /data-taixu-type="物理技"/);
  assert.match(html, /data-taixu-type="魔法技"/);
  assert.match(html, /maxlength="100"/);
  assert.match(html, /id="taixu-goal-count"/);
  const modal = html.slice(html.indexOf('function openTaixuRealmModal'), html.indexOf('function setTaixuType'));
  assert.doesNotMatch(modal, /class="taixu-context"/);
  assert.doesNotMatch(modal, /<small>修士<\/small>|<small>境界<\/small>|<small>灵根<\/small>|<small>特质<\/small>/);
});

test('taixu modal validates trimmed input and exposes loading and result states', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('function openTaixuRealmModal');
  const end = html.indexOf('/* ============================================================\n   铁匠铺', start);
  const taixu = html.slice(start, end);

  assert.match(taixu, /String\(.*\.value \|\| ''\)\.trim\(\)/);
  assert.match(taixu, /正在观想觉醒万象/);
  assert.match(taixu, /renderTaixuInsightResult/);
  assert.match(taixu, /技能库/);
});

test('taixu result renders the complete returned description without a display clamp', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('function renderTaixuInsightResult');
  const end = html.indexOf('async function submitTaixuInsight', start);
  const render = html.slice(start, end);

  assert.match(render, /<p>\$\{esc\(skill\.desc\)\}<\/p>/);
  assert.doesNotMatch(render, /skill\.desc\.slice|line-clamp|max-height/);
});

test('successful taixu insight writes one sourced recent activity entry', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('async function submitTaixuInsight');
  const end = html.indexOf('/* ============================================================\n   铁匠铺', start);
  const submit = html.slice(start, end);

  assert.match(submit, /addFeedItem/);
  assert.match(submit, /觉醒祭坛 · 领悟/);
  assert.doesNotMatch(submit, /result\.skill\.tier/);
  assert.ok(submit.indexOf('await window.taixuInsight') < submit.indexOf('addFeedItem'));
  assert.match(html, /f\.kind === 'insight'/);
});

test('successful taixu insight hands off to the dedicated result dialog', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('async function submitTaixuInsight');
  const end = html.indexOf('/* ============================================================\n   铁匠铺', start);
  const submit = html.slice(start, end);

  assert.match(submit, /renderTaixuInsightSuccess\(result\)/);
  assert.doesNotMatch(submit, /button\.textContent = '结束参悟'/);
  assert.doesNotMatch(submit, /button\.onclick = closeModal/);
});

test('successful taixu insight opens a dedicated result dialog with complete skill details', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const start = html.indexOf('async function submitTaixuInsight');
  const end = html.indexOf('/* ============================================================\n   铁匠铺', start);
  const submit = html.slice(start, end);

  assert.match(html, /function renderTaixuInsightSuccess/);
  assert.match(html, /taixu-success-dialog/);
  assert.match(html, /taixu-success-storage/);
  assert.match(html, /renderTaixuInsightSuccess\(result\)/);
  assert.match(submit, /result\.skill\.name/);
  assert.match(submit, /result\.skill\.desc/);
  assert.match(submit, /result\.storage === 'equipped'/);
  assert.match(html, /onclick="closeModal\(\)">确认<\/button>/);
});

test('taixu insight persists a one-hour busy state before background generation', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /const TAIXU_INSIGHT_DURATION_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(server, /role\.status\s*=\s*'insighting'/);
  assert.match(server, /role\.taixuInsight\s*=\s*\{/);
  assert.match(server, /endsAt:\s*now\s*\+\s*TAIXU_INSIGHT_DURATION_MS/);
  assert.match(server, /phase:\s*'running'/);
});

test('taixu busy state blocks player mutations while allowing status polling', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /function characterBusyReason\(/);
  assert.match(server, /角色正在觉醒祭坛顿悟/);
  assert.match(server, /characterBusyReason\(current\.data\)/);
  assert.match(server, /characterBusyReason\(character\.data\)/);
  assert.match(server, /case 'match_start':[\s\S]*?characterBusyReason\(c\.data\)/);
  assert.match(server, /case 'room_create':[\s\S]*?characterBusyReason\(character\.data\)/);
  assert.match(server, /case 'room_join':[\s\S]*?characterBusyReason\(character\.data\)/);
});

test('taixu insight recovers persisted jobs and finalizes exactly once', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /function finalizeTaixuInsightJob\(/);
  assert.match(server, /function recoverAllTaixuInsights\(/);
  assert.match(server, /setInterval\(recoverAllTaixuInsights/);
  assert.match(server, /taixuInsightNotice/);
  assert.match(server, /if \(state\.phase !== 'ready' \|\| !state\.skill\)/);
  assert.match(server, /delete role\.taixuInsight/);
});

test('online taixu insight shows a persisted countdown and polls through the one-hour window', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(html, /领悟中/);
  assert.match(html, /taixu-insight-countdown/);
  assert.match(online, /remainingMs/);
  assert.match(online, /TAIXU_INSIGHT_POLL_MS|poll < 800/);
  assert.match(online, /taixuInsightNotice/);
});
