const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('index.html', 'utf8');
const styles = fs.readFileSync('style.css', 'utf8');
const match = source.match(/function addFeedBatch\([\s\S]*?\n}\n(?=\/\* 兼容既有调用)/);

test('a forge operation records material consumption and output in one feed entry', () => {
  assert.ok(match, 'addFeedBatch must exist to record an operation as one feed entry');

  const context = {
    D: { my_feed: [] },
    FEED_MAX: 100,
    fmtTimeFull: () => '2026-08-18 19:26',
    saveFeed: () => {},
    document: { getElementById: () => null },
    renderMine: () => {},
  };
  vm.createContext(context);
  vm.runInContext(match[0], context);

  context.addFeedBatch('⚔️', '炼器坊', '炼器成功', [
    { delta: '-1 铁剑', color: 'common' },
    { delta: '-1 暗红骨书', color: 'common' },
    { delta: '+1 血阵铁兵', color: 'rare' },
  ]);

  assert.equal(context.D.my_feed.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.D.my_feed[0].changes)), [
    { delta: '-1 铁剑', color: 'common' },
    { delta: '-1 暗红骨书', color: 'common' },
    { delta: '+1 血阵铁兵', color: 'rare' },
  ]);
});

test('mine layout keeps the adventurer card above a full-width activity feed', () => {
  assert.match(styles, /:root\s*\{[\s\S]*?--color-bg:\s*#0e1319/);
  assert.match(styles, /\[data-theme="light"\]\s*\{[\s\S]*?--color-bg:\s*#ffffff/);
  assert.match(source, /adv-card[^`]*statusClass/, 'adventurer cards should derive a status class');
  assert.match(source, /mine-layout[^`]*adv-grid[^`]*advCardHTML\(me\)[^`]*feed-list/, 'mine page should reuse the adventurer grid sizing for the card');
  assert.doesNotMatch(source, /<div class="mine-card-col" style="flex:1\.4">/, 'activity feed should not remain in a side column');
});

test('historical corrupted character text has a repair path', () => {
  const dbSource = fs.readFileSync('db.js', 'utf8');
  assert.match(dbSource, /repairCorruptedText/);
  assert.match(dbSource, /首次运用金气/);
  assert.match(dbSource, /削铁如泥/);
});

test('party board exposes the reference recruitment sections', () => {
  assert.match(source, /普通小队/);
  assert.match(source, /我的小队/);
  assert.match(source, /地图候车风向/);
  assert.match(source, /我收到的邀请/);
});

test('log modal uses a narrower fixed header with a scrolling body', () => {
  const styles = fs.readFileSync('style.css', 'utf8');
  assert.match(styles, /\.modal-box\.log-modal[\s\S]*max-width:\s*900px/);
  assert.match(styles, /\.modal-box\.log-modal[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.modal-box\.log-modal \.log-detail-toolbar[\s\S]*position:\s*sticky/);
  assert.match(styles, /\.modal-box\.log-modal \.log-detail[\s\S]*overflow-y:\s*auto/);
});

test('AI companions recover one HP every three minutes while idle', () => {
  const GE = require('../game-engine');
  const ally = { hp: 40, max_hp: 100, hpTs: 0, status: 'idle' };
  assert.equal(GE.regenerateHp(ally, 179999), false);
  assert.equal(ally.hp, 40);
  assert.equal(GE.regenerateHp(ally, 180000), true);
  assert.equal(ally.hp, 41);
  assert.equal(ally.hpTs, 180000);
});

test('player stamina recovers one point per elapsed minute and caps at maximum', () => {
  const GE = require('../game-engine');
  const role = { stamina: 8, max_stamina: 100, staminaTs: 0, status: 'resting' };
  assert.equal(GE.regenerateStamina(role, 181000), true);
  assert.equal(role.stamina, 11);
  assert.equal(role.staminaTs, 180000);

  const full = { stamina: 99, max_stamina: 100, staminaTs: 0, status: 'resting' };
  assert.equal(GE.regenerateStamina(full, 120000), true);
  assert.equal(full.stamina, 100);
  assert.equal(full.staminaTs, 120000);
});

test('online server persists passive stamina and HP recovery for all characters', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const db = fs.readFileSync('db.js', 'utf8');
  assert.match(db, /function getAllCharacters/);
  assert.match(server, /function settlePassiveRecovery/);
  assert.match(server, /GE\.regenerateStamina\(role, now\)/);
  assert.match(server, /setInterval\(recoverAllPassiveStats, 60 \* 1000\)/);
});

test('loot assignment gives each item to one weighted member only', () => {
  const GE = require('../game-engine');
  const members = [{ id: 'p', merit: 10 }, { id: 'a', merit: 1 }];
  const assigned = GE.assignLoot([{ name: '宝物甲' }, { name: '宝物乙' }], members, () => 0);
  assert.equal(assigned.p.length + assigned.a.length, 2);
  assert.equal(new Set([...assigned.p, ...assigned.a].map(i => i.name)).size, 2);
});

test('character names are rejected when an exact name already exists', () => {
  const GE = require('../game-engine');
  assert.equal(GE.hasDuplicateCharacterName('柳烟', [{ name: '柳烟' }]), true);
  assert.equal(GE.hasDuplicateCharacterName('柳烟', [{ name: '柳烟子' }]), false);
});

test('public and personal party sections share a clickable party card renderer', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /function partyRoomCardHTML/);
  assert.match(online, /openPartyMemberDetail/);
  assert.match(online, /data-party-member/);
  assert.match(online, /my-party-card-host/);
});

test('public party cards use a three-column responsive grid', () => {
  const styles = fs.readFileSync('style.css', 'utf8');
  assert.match(styles, /\.public-party-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(styles, /\.public-party-card\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.public-party-actions\s*\{[\s\S]*flex-direction:\s*row/);
});

test('my party cards share the public party card grid and dimensions', () => {
  assert.match(styles, /#my-party-card-host\s*\{[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(styles, /#my-party-card-host \.public-party-card\s*\{[\s\S]*width:\s*100%/);
});

test('running expedition keeps an already-open log modal on settlement', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const settlement = online.slice(online.indexOf('async function onRunSettled'), online.indexOf('/* ============================================================\n     启动', online.indexOf('async function onRunSettled')));
  assert.match(settlement, /typeof window\.completeRunningLogModal === 'function'/);
  assert.match(settlement, /D\.logs\s*=\s*\[log,/);
});

test('settlement keeps the running log modal open and switches it to the completed log', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const settlement = online.slice(online.indexOf('async function onRunSettled'), online.indexOf('/* ============================================================\n     启动', online.indexOf('async function onRunSettled')));
  assert.match(html, /window\.completeRunningLogModal\s*=\s*function/);
  assert.match(html, /String\(logModalId\) !== 'run' \+ runId/);
  assert.match(settlement, /window\.completeRunningLogModal\(runningRunId, log\.id\)/);
  assert.ok(settlement.indexOf('window.completeRunningLogModal(runningRunId, log.id)') < settlement.lastIndexOf('window.activeDungeons.splice'));
});

test('online settlement summary prompt is tied to each run narrative', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(settlement, /storyText\s*=\s*dg\.steps\.map\(s => `第\$\{s\.stepNo/);
  assert.match(settlement, /runSignature/);
  assert.match(server, /不得只根据副本名/);
});

test('public and personal expedition history use one canonical shared log', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const db = fs.readFileSync('db.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  const publicLogs = db.slice(db.indexOf('function getAllLogs'), db.indexOf('function getPublicCharacters'));
  assert.match(settlement, /run_id:\s*dg\.id/);
  assert.match(settlement, /DB\.commitExpeditionSettlement\(\{/);
  assert.match(publicLogs, /SELECT id,data FROM logs/);
  assert.doesNotMatch(publicLogs, /new Set|seenRuns|LIMIT 200/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS log_participants/);
});

test('single-step expedition narrative hard cap is 300 characters', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const storyCall = server.slice(server.indexOf('async function callLLM'));
  assert.match(storyCall, /maxLength\s*=\s*300/);
  assert.match(storyCall, /text\.slice\(0,\s*maxLength\)/);
  const onlineStoryCall = server.slice(server.indexOf('async function callAIStory'), server.indexOf('function localFallbackText'));
  assert.match(onlineStoryCall, /text\.slice\(0,\s*maxLength\)/);
});

test('online expedition keeps the squad card and refreshes the running log list', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /if \(activeWsRun\) renderSquadCard\(\);/);
  const step = online.slice(online.indexOf('function onWsStep'), online.indexOf('async function onRunSettled'));
  assert.match(step, /renderLogs\(\)/);
  assert.match(online, /activeDungeons\.push\(dg\)/);
  assert.match(source, /tab === 'party' && typeof window\.renderParty === 'function' \? window\.renderParty : renderers\[tab\]/);
});

test('online expedition error refreshes the persisted failure log immediately', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const fn = online.slice(online.indexOf('function onRunError'), online.indexOf('async function onRunSettled'));
  assert.match(fn, /fetchServerLogs\(\)/);
  assert.match(fn, /renderLogs\(\)/);
});

test('mine and adventurer views use one shared full-detail character card', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /function advCardHTML\(adv\)/);
  const mine = html.slice(html.indexOf('function renderMine'), html.indexOf('function renderAdventurers'));
  const adventurers = html.slice(html.indexOf('function renderAdvList'), html.indexOf('function renderParty'));
  assert.match(mine, /advCardHTML\(me\)/);
  assert.match(adventurers, /list\.map\(advCardHTML\)/);
  for (const field of ['hp', 'max_hp', 'stamina', 'max_stamina', 'equipment', 'bag', 'skills']) {
    assert.match(html.slice(html.indexOf('function advCardHTML'), html.indexOf('function renderMine')), new RegExp('adv\\.' + field));
  }
});

test('public character payload includes the same live state fields as mine cards', () => {
  const db = fs.readFileSync('db.js', 'utf8');
  const fn = db.slice(db.indexOf('function publicCharacterData'), db.indexOf('function getPublicCharacters'));
  for (const field of ['hp', 'max_hp', 'stamina', 'max_stamina']) assert.match(fn, new RegExp(field + ': data\\.' + field));
  for (const field of ['equipment', 'bag', 'skills']) assert.match(fn, new RegExp(field + ': Array\\.isArray\\(data\\.' + field));
});

test('online expedition status is persisted at start and restored on AI failure', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const db = fs.readFileSync('db.js', 'utf8');
  const runner = fs.readFileSync('room-runner.js', 'utf8');
  assert.match(runner, /await beginRun\(/);
  assert.match(server, /DB\.beginExpeditionRun\(\{/);
  const begin = db.slice(db.indexOf('function beginExpeditionRun'), db.indexOf('function checkpointExpeditionRun'));
  assert.match(begin, /status = 'adventuring'/);
  assert.match(begin, /stamina = Math\.max\(0/);
  const failure = db.slice(db.indexOf('function failExpeditionRun'), db.indexOf('function commitExpeditionSettlement'));
  assert.match(failure, /status = 'resting'/);
  assert.match(failure, /stamina = Math\.min/);
});

test('character refresh and stale autosaves cannot replace an active expedition status', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /function findRunningRoomMember\(/);
  const publicRoute = server.slice(server.indexOf("urlPath === '/api/public/characters'"), server.indexOf("urlPath === '/api/public/logs'"));
  assert.match(publicRoute, /findRunningRoomMember/);
  const charRoute = server.slice(server.indexOf("if \(req\.method === 'GET'\) \{", server.indexOf('const charMatch')), server.indexOf("// ---------- 日志：添加/列表 ----------"));
  assert.match(charRoute, /findRunningRoomMember/);
  assert.match(charRoute, /status\s*=\s*'adventuring'/);
});

test('online expedition resumes after refresh from the server snapshot', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(online, /case 'dungeon_resumed': onRunResumed\(d\.snapshot(?:, d\.runId)?\)/);
  assert.match(online, /function onRunResumed\(snapshot(?:, runId(?:, status)?)?\)/);
  assert.match(server, /type: 'dungeon_resumed'/);
  assert.match(server, /!?\['running', 'waiting_ai', 'settling'\]\.includes\(room\.status\) \|\| !room\.dg/);
});

test('public character data keeps the shared running status visible to every viewer', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.doesNotMatch(server, /function publicCharactersForViewer\(uid\)/);
  const route = server.slice(server.indexOf("urlPath === '/api/public/characters'"), server.indexOf("urlPath === '/api/public/logs'"));
  assert.match(route, /DB\.getPublicCharactersPage\(\{/);
});

test('running expedition events are broadcast to all authenticated viewers with a stable run id', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const runner = fs.readFileSync('room-runner.js', 'utf8');
  assert.match(server, /function broadcastAll\(msg\)/);
  const runSource = server.slice(server.indexOf('async function dungeonStep'), server.indexOf('function leaveRoomCleanup'));
  assert.match(runner, /broadcastAll\(\{ type: 'dungeon_started'/);
  assert.match(runner, /runId:\s*dungeon\.id/);
  assert.match(runner, /broadcastStarting/);
  assert.match(server, /dungeon_starting/);
  assert.match(server, /dungeon_start_failed/);
  assert.match(runSource, /broadcastAll\(\{\s*type: 'step'/);
  assert.match(runSource, /broadcastAll\(\{ type: 'settled'/);
  assert.match(server, /broadcastAll\(\{ type: 'run_error'/);
});

test('websocket authentication resumes every running expedition for a viewer', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const auth = server.slice(server.indexOf("case 'auth'"), server.indexOf("case 'match_start'"));
  assert.match(auth, /for \(const room of ROOMS\.values\(\)\)/);
  assert.match(auth, /runningSnapshot\(room\)/);
  assert.doesNotMatch(auth, /if \(!member\) continue/);
});

test('active-run HTTP fallback also serves viewers who are not participants', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.slice(
    server.indexOf("urlPath === '/api/expeditions/active'"),
    server.indexOf("// 账号 / 角色 / 日志 / 房间 API（联机版）"),
  );
  assert.doesNotMatch(route, /\.filter\(run\s*=>/);
  assert.match(route, /DB\.getActiveExpeditionRuns\(\)\.map/);
});

test('online client tracks remote running expeditions by server run id', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /function findActiveRun\(runId\)/);
  assert.match(online, /onWsStep\(d\.step, d\.runId\)/);
  assert.match(online, /onRunSettled\(d\)/);
  assert.match(online, /snapshot\.id/);
  assert.match(online, /function findActiveRun\(runId\)[\s\S]*activeDungeons \|\| \[\]\)\.find/);
});

test('closing the log overlay clears the live log modal state', () => {
  assert.match(source, /if \(logModalId !== null\) closeLogModal\(\);[\s\S]*else closeModal\(\);/);
  assert.match(source, /function closeLogModal\(\)[\s\S]*logModalId = null;[\s\S]*clearInterval\(logModalTimer\)/);
});

test('log detail defaults to 16px and hides comments and D20 badges', () => {
  assert.match(source, /let logFont = 16/);
  assert.match(source, /function rollBadgeHTML\(st\) \{\s*return '';\s*\}/);
  assert.doesNotMatch(source, /onclick="addLogComment\(/);
  assert.doesNotMatch(source, /step-comment/);
  assert.doesNotMatch(source, /D20 \$\{sk\.roll\}/);
});

test('log detail hides skill and spell badges', () => {
  assert.match(source, /function skillBadgeHTML\(st\) \{\s*return '';\s*\}/);
});

test('loot settlement requires AI-provided item descriptions', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /String\(x\.desc \|\| ''\)\.replace\(\/ \+\/g, ''\)/);
  assert.match(server, /if \(!name \|\| !desc\) throw/);
  assert.doesNotMatch(server, /lootDescFallback/);
});

test('online expedition writes each loot item as its own sourced feed entry', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  const settlement = online.slice(online.indexOf('async function onRunSettled'), online.indexOf('/* ============================================================\n     启动', online.indexOf('async function onRunSettled')));
  assert.match(settlement, /window\.addFeedItem/);
  assert.match(settlement, /loot\.forEach|loot\.map/);
  assert.doesNotMatch(settlement, /window\.addFeedBatch\(/);
});

test('legacy grouped feed entries are normalized into item-first sourced entries', () => {
  assert.match(source, /normalizeFeedEntries/);
  assert.match(source, /entry\.changes\.forEach/);
  assert.match(source, /feed-source/);
});

test('item feed rows place rarity and quantity beside the item name', () => {
  assert.match(source, /feed-item-qty/);
  assert.match(source, /RARITY_NAME\[f\.color\]/);
  assert.match(source, /feedIsItemEntry\(f\)/);
});

test('currency feed rows place the amount beside the currency name', () => {
  assert.match(source, /feedIsCurrencyEntry\(f\)/);
  assert.match(source, /feed-currency-qty/);
});

test('online settlement reads only the loot assigned to the current member', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /const lootByMember = GE\.assignLoot\(lootAssign, lootMembers\)/);
  assert.match(server, /const assignedLoot = lootByMember\[m\.uid \|\| m\.id\] \|\| \[\]/);
  assert.match(server, /const myLoot = assignedLoot;/);
});

test('failed online expeditions keep every assigned loot item', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(settlement, /const myLoot = assignedLoot;/);
  assert.doesNotMatch(settlement, /assignedLoot\.filter\(x => x\.rarity === 'rare'\)/);
});

test('online loot quantity and rarity are decided by AI expedition extraction', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(server, /数量按剧情中的实际数量/);
  assert.match(server, /稀有度只能是 common\/rare\/epic\/legendary/);
  assert.doesNotMatch(settlement, /rollLootRarity\(/);
  assert.match(settlement, /const rarity = \['common', 'rare', 'epic', 'legendary'\]\.includes\(x\.rarity\)/);
  assert.doesNotMatch(server, /dg\.bossDrops\.forEach\(b => lootAssign/);
});

test('settlement does not append a separate loot distribution story', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.doesNotMatch(server, /LOOT_DISTRIBUTION_PROMPT/);
  assert.doesNotMatch(settlement, /lootDistributionFacts|lootDistributionText|loot_distribution/);
});

test('online loot extraction only settles items explicitly obtained in the story', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(server, /必须来自剧情中明确发生的获得动作/);
  assert.doesNotMatch(settlement, /dg\.bossDrops\.forEach\(b => lootAssign\.push/);
  assert.doesNotMatch(settlement, /if \(!lootAssign\.some\(x => x\.name === b\.name\)\) lootAssign\.push/);
});

test('forge success persists the generated item through the online save hook', () => {
  const forge = source.slice(source.indexOf('async function doForge'), source.indexOf('function consumeForgeMat'));
  assert.match(forge, /bagAdd\(role, item\)/);
  assert.match(forge, /window\.saveRole\(\)/);
});

test('online expedition never persists local fallback narrative after AI failure', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const step = server.slice(server.indexOf('async function dungeonStep'), server.indexOf('async function callAIStory'));
  assert.doesNotMatch(step, /localFallbackText/);
  assert.match(step, /await callAIStory\(payload/);
  assert.match(server, /function failRoomRun\(room/);
});

test('online story requests retry transient AI failures with a timeout', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const fn = server.slice(server.indexOf('async function callAIStory'), server.indexOf('async function settleRoom'));
  assert.match(fn, /AbortController/);
  assert.match(fn, /setTimeout\(\(\) => ctrl\.abort\(\), 240000\)/);
  assert.match(fn, /for \(let attempt = 0; attempt < 3/);
});

test('AI settlement requests use the same four minute timeout', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const fn = server.slice(server.indexOf('async function callLLM'), server.indexOf('function parseAiJson'));
  assert.match(fn, /setTimeout\(\(\) => ctrl\.abort\(\), 240000\)/);
});

test('online expedition keeps raw AI text for loot auditing while exposing cleaned text', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const step = server.slice(server.indexOf('async function dungeonStep'), server.indexOf('async function callAIStory'));
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.match(step, /rawText/);
  assert.match(settlement, /s\.rawText \|\| s\.text/);
});

test('settlement does not fabricate summary or outcome when AI settlement calls fail', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  assert.doesNotMatch(settlement, /const concrete = dg\.steps/);
  assert.doesNotMatch(settlement, /const ok = aiOk !== null \? aiOk : !hasFumble/);
  assert.match(settlement, /if \(aiOk === null\) throw/);
});

test('single-player settlement never falls back to local summary outcome loot or traits', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const settlement = html.slice(html.indexOf('async function settleDungeon'), html.indexOf('function realmForLevel'));
  assert.match(html, /const AI_MODE\s*=\s*'remote'/);
  assert.doesNotMatch(settlement, /aiOutcome\(storyText\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(settlement, /aiExtractLoot\(storyText\)[\s\S]{0,500}else\s*\{/);
  assert.doesNotMatch(settlement, /TRAIT_POOL\[Math\.floor/);
  assert.doesNotMatch(settlement, /来历不明的宝物/);
  assert.doesNotMatch(settlement, /bossDrops\.forEach/);
  assert.match(settlement, /catch \(e\) \{[\s\S]*cancelDungeon\(dg/);
});

test('single-player AI settlement helpers reject invalid AI responses instead of returning local defaults', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const helpers = html.slice(html.indexOf('async function aiLootDescs'), html.indexOf('function addTraitWithDesc'));
  assert.match(helpers, /throw new Error/);
  assert.doesNotMatch(helpers, /return null;[\s\S]*AI 不可用/);
});

test('empty AI loot arrays are valid while malformed loot items are rejected', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.slice(server.indexOf("urlPath === '/api/ai/extract_loot'"), server.indexOf("urlPath === '/api/ai/trait'"));
  assert.doesNotMatch(route, /!Array\.isArray\(parsed\) \|\| !parsed\.length/);
  const html = fs.readFileSync('index.html', 'utf8');
  const helper = html.slice(html.indexOf('async function aiExtractLoot'), html.indexOf('async function aiGrantTrait'));
  assert.match(helper, /if \(!item\.name \|\| !item\.desc\) throw/);
});

test('loot extraction uses a structured-response length limit instead of the 300-character story limit', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const settlement = server.slice(server.indexOf('async function settleRoom'), server.indexOf('function leaveRoomCleanup'));
  const route = server.slice(server.indexOf("urlPath === '/api/ai/extract_loot'"), server.indexOf("urlPath === '/api/ai/trait'"));
  assert.match(settlement, /EXTRACT_LOOT_PROMPT,\s*2000/);
  assert.match(route, /EXTRACT_LOOT_PROMPT,\s*2000/);
});

test('HTTP request bodies decode split UTF-8 chunks without replacement characters', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const fn = server.slice(server.indexOf('function readBody'), server.indexOf('function sendJSON'));
  assert.match(fn, /const chunks = \[\]/);
  assert.match(fn, /Buffer\.concat\(chunks\)\.toString\('utf8'\)/);
});

test('online story rejects replacement characters before persisting AI text', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const fn = server.slice(server.indexOf('async function callAIStory'), server.indexOf('function localFallbackText'));
  assert.match(fn, /text\.includes\(['"](?:\\uFFFD|�)['"]\)/);
  assert.match(fn, /AI 返回乱码/);
});

test('recent activity uses a compact toolbar and single-row ledger entries', () => {
  assert.match(source, /feed-toolbar/);
  assert.match(source, /feed-filter/);
  assert.match(source, /feed-load-more/);
  assert.match(styles, /\.feed-item\s*\{[\s\S]*border-radius:\s*0/);
  assert.doesNotMatch(source, /<span class="feed-icon">/);
  assert.match(styles, /\.feed-item\s*\{[\s\S]*padding:\s*8px 16px/);
});

test('expedition loot creates one sourced activity entry per item', () => {
  assert.match(source, /function addFeedItem/);
  assert.match(source, /myLoot\.forEach\([\s\S]*addFeedItem/);
  assert.match(source, /feed-source/);
});

test('forge activity keeps materials, result, status, cost, and description together', () => {
  assert.match(source, /kind:\s*'forge'/);
  assert.match(source, /forgeMaterials/);
  assert.match(source, /forgeResult/);
  assert.match(source, /feed-forge-recipe/);
});

test('forge materials and result use rarity-colored names', () => {
  assert.match(source, /forgeMaterials:\s*inputMats\.map\(m => \(\{ name: m\.name, rarity:/);
  assert.match(source, /forgeResult:\s*\{ name: item\.name, rarity:/);
  assert.match(source, /itemColor\(m\)/);
  assert.match(source, /itemColor\(r\)/);
});

test('forge keeps generated item metadata and refuses a full bag', () => {
  assert.match(source, /function bagAdd\(role, item\)[\s\S]*kind: item\.kind/);
  assert.match(source, /const added = bagAdd\(role, item\)/);
  assert.match(source, /if \(!added\)[\s\S]*储物袋已满/);
});

test('online forge commits materials, stamina, and item through the server', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(server, /forgeMatch = urlPath\.match\(\/\^\\\/api\\\/character/);
  assert.match(server, /forgeMatch[\s\S]*forge/);
  assert.match(server, /saveCharacterIfCurrent\(u\.id, charId/);
  assert.match(online, /\/api\/character\/.*\/forge/);
  assert.match(source, /role\._char_db_id && typeof window\.forgeOnline/);
  assert.match(source, /炼器失败也会消耗本次精力/);
});

test('online forge runs as an asynchronous server job that survives client disconnects', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const online = fs.readFileSync('online.js', 'utf8');
  const source = fs.readFileSync('index.html', 'utf8');

  assert.match(server, /forgeJobMatch/);
  assert.match(server, /scheduleForgeJob/);
  assert.match(server, /status:\s*'pending'/);
  assert.match(server, /runForgeJob/);
  assert.match(online, /forge.*jobId|jobId.*forge/);
  assert.match(online, /setTimeout/);
  assert.match(online, /forgeInFlight/);
  assert.match(online, /taixuInsightInFlight \|\| forgeInFlight/);
  assert.match(source, /window\.forgeOnline\(\{[\s\S]*materials/);
});

test('forge outcome is decided by AI and has no server success roll', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const forgeRoute = server.slice(server.indexOf('const forgeMatch'), server.indexOf('const charMatch'));
  assert.doesNotMatch(forgeRoute, /Math\.random\(\) < 0\.8/);
  assert.doesNotMatch(forgeRoute, /successRate:\s*0\.8/);
  assert.match(server, /typeof parsed\.success !== 'boolean'/);
  assert.match(server, /if \(parsed\.success\)/);
});

test('successful forge accepts AI-rationalized rarity and keeps detailed descriptions', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const forgeRoute = server.slice(server.indexOf('const forgeMatch'), server.indexOf('const charMatch'));
  assert.doesNotMatch(forgeRoute, /const forgeSuccess/);
  assert.match(server, /slice\(0, 200\)/);
  assert.match(server, /it\.rarity \|\| rarity/);
  assert.match(source, /rarity:\s*res\.item\.rarity/);
});

test('online forge preserves submitted material rarity when legacy stored materials lack rarity', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const forgeRoute = server.slice(server.indexOf('const forgeMatch'), server.indexOf('const charMatch'));
  assert.match(forgeRoute, /normalizeForgeRarity/);
  assert.match(forgeRoute, /materialEntries\.map/);
  assert.match(forgeRoute, /materials\[index\]\.rarity/);
});

test('online forge validates output capacity before consuming materials', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const forgeRoute = server.slice(server.indexOf('const forgeMatch'), server.indexOf('const charMatch'));
  assert.match(forgeRoute, /储物袋已满[\s\S]*materials\.forEach/);
  assert.match(forgeRoute, /material\.src === 'equip'/);
});

test('corrupted item names and descriptions receive generic repair fallbacks', () => {
  const dbSource = fs.readFileSync('db.js', 'utf8');
  assert.match(dbSource, /value\.includes\('�'\)/);
  assert.match(dbSource, /key === 'name'/);
  assert.match(dbSource, /未知道具/);
  assert.match(dbSource, /getPublicCharacters[\s\S]*repairCorruptedText/);
});

test('skill descriptions keep readable text when only replacement characters are corrupted', () => {
  const db = require('../db');
  const repaired = db.repairCorruptedText({
    skills: [{ name: '庚金护体罡', desc: '以庚�之气护住经脉，抵御冲击。' }],
  });
  assert.equal(repaired.skills[0].desc, '以庚之气护住经脉，抵御冲击。');
  assert.doesNotMatch(repaired.skills[0].desc, /暂无描述/);
});

test('learned skills containing replacement characters are rejected before persistence', () => {
  const engine = fs.readFileSync('game-engine.js', 'utf8');
  assert.match(engine, /name\.includes\('�'\)/);
  assert.match(engine, /desc\.includes\('�'\)/);
});

test('LLM responses containing replacement characters are retried instead of persisted', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /text\.includes\('\\uFFFD'\)/);
  assert.match(server, /AI 返回乱码/);
});

test('forge AI returns an operation process for both outcomes', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /process/);
  assert.match(server, /parsed\.process/);
  assert.match(server, /failureProcess/);
  assert.match(server, /failureProcess/);
});

test('forge AI keeps structured JSON intact instead of applying the narrative text limit', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const forgeRoute = server.slice(server.indexOf("urlPath === '/api/ai/forge'"), server.indexOf("urlPath === '/api/ai/forge'") + 2600);
  assert.match(forgeRoute, /callLLM\([\s\S]*FORGE_PROMPT,\s*1200\)/);
  assert.match(server, /itemDesc\.slice\(0, 200\)/);
  assert.match(server, /失败时 process 写炉火变化/);
});

test('forge success and failure share the screenshot-style result dialog', () => {
  assert.match(source, /function showForgeResultDialog/);
  assert.match(source, /forge-result-dialog/);
  assert.match(source, /forge-result-summary/);
  assert.match(source, /forge-result-process/);
  assert.match(source, /showForgeResultDialog\(\{[\s\S]*ok:\s*true/);
  assert.match(source, /showForgeResultDialog\(\{[\s\S]*ok:\s*false/);
  assert.doesNotMatch(source, /!result\.ok \? `<section class="forge-result-reason"/);
  assert.match(source, /status: '失败'/);
  assert.match(source, /description: res\.process/);
});
