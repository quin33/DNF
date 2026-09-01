const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readAsset = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('server loads local AI environment by default while allowing explicit opt-out', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /if\s*\(process\.env\.TAVERN_LOAD_ENV\s*!==\s*['"]0['"]\)\s*loadLocalEnv\(\)/);
});

test('global text uses a slight positive letter spacing', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const body = styles.slice(styles.indexOf('body {'), styles.indexOf('::-webkit-scrollbar'));
  assert.match(styles, /--tracking:\s*0\.05em/);
  assert.match(body, /letter-spacing:\s*var\(--tracking\)/);
});

test('game text uses Microsoft YaHei Light as the primary font with Microsoft YaHei fallback', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /--font:\s*["']Microsoft YaHei Light["']/);
  assert.match(styles, /"Microsoft YaHei"/);
});

test('building cards use a theme-aware tinted surface that strengthens on hover', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const rootTheme = styles.slice(styles.indexOf(':root {'), styles.indexOf('/* ============ 白色仙侠风主题'));
  const lightTheme = styles.slice(styles.indexOf('[data-theme="light"]'), styles.indexOf('* { box-sizing'));
  const buildingStyles = styles.slice(styles.indexOf('/* ============ 建筑 ============ */'), styles.indexOf('.spirit-grid'));

  assert.match(rootTheme, /--building-card-bg:\s*color-mix\(in srgb, var\(--color-primary\) 8%, var\(--color-surface\)\)/);
  assert.match(rootTheme, /--building-card-hover-bg:\s*color-mix\(in srgb, var\(--color-primary\) 12%, var\(--color-surface\)\)/);
  assert.match(lightTheme, /--building-card-bg:\s*color-mix\(in srgb, var\(--color-primary\) 5%, var\(--color-surface\)\)/);
  assert.match(lightTheme, /--building-card-hover-bg:\s*color-mix\(in srgb, var\(--color-primary\) 9%, var\(--color-surface\)\)/);
  assert.match(buildingStyles, /\.build-card\s*\{[^}]*background:\s*var\(--building-card-bg\)/);
  assert.match(buildingStyles, /\.build-card:hover\s*\{[^}]*background:\s*var\(--building-card-hover-bg\)/);
});

test('night theme uses layered dark surfaces with accessible controls', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const rootTheme = styles.slice(styles.indexOf(':root {'), styles.indexOf('/* ============ 白色仙侠风主题'));

  assert.match(rootTheme, /--color-bg:\s*#0e1319/);
  assert.match(rootTheme, /--color-surface-raised:\s*#1c2732/);
  assert.match(rootTheme, /--color-border:\s*#2d3a47/);
  assert.match(rootTheme, /--color-primary:\s*#79b8ff/);
  assert.match(rootTheme, /--color-shadow:\s*#00000066/);
  assert.match(rootTheme, /color-scheme:\s*dark/);
  assert.match(styles, /\.modal-box[^{]*\{[^}]*background:\s*var\(--color-surface-raised\)/);
  assert.match(styles, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-primary\)/);
});

test('the game page has no legacy navigation shell and keeps the theme toggle', () => {
  const html = readAsset('index.html');
  assert.equal(html.includes('class="app-sidebar"'), false);
  assert.equal(html.includes('class="navbar-brand"'), false);
  assert.equal(html.includes('id="theme-toggle"'), true);
});

test('the current player is selected from the authenticated account characters', () => {
  const script = readAsset('online.js');
  assert.match(script, /D\.my_adventurer\s*=\s*chars\[0\]\s*\|\|\s*null/);
});

test('public character data includes a root field for other players', () => {
  const script = readAsset('online.js');
  assert.match(script, /traits:\s*Array\.isArray\(publicChar\.traits\)/);
});

test('online character creation can read the selected root from shared form state', () => {
  const html = readAsset('index.html');
  assert.match(html, /window\.charSel\s*=\s*charSel/);
});

test('online bootstrap hydrates the last server character before network refresh', () => {
  const script = readAsset('online.js');
  assert.match(script, /ROLE_CACHE_KEY/);
  assert.match(script, /hydrateCachedRole\(\)/);
  assert.match(script, /localStorage\.setItem\(ROLE_CACHE_KEY/);
});

test('refresh restores the selected tab and login keeps that active tab', () => {
  const html = readAsset('index.html');
  const online = readAsset('online.js');
  const afterLogin = online.slice(online.indexOf('async function afterLogin'), online.indexOf('async function loadOnlineRoles'));
  assert.match(html, /sessionStorage\.setItem\('dnf_active_tab', tab\)/);
  assert.match(html, /sessionStorage\.getItem\('dnf_active_tab'\)/);
  assert.doesNotMatch(afterLogin, /location\.hash\s*=\s*'mine'/);
  assert.doesNotMatch(afterLogin, /switchTab\('mine'\)/);
  assert.match(afterLogin, /renderActiveOnlineTab\(\)/);
});

test('online role bootstrap shows a loading state instead of the creation form before the role arrives', () => {
  const html = readAsset('index.html');
  const online = readAsset('online.js');
  const mine = html.slice(html.indexOf('function renderMine'), html.indexOf('/* ============================================================\n   创建角色'));
  const afterLogin = online.slice(online.indexOf('async function afterLogin'), online.indexOf('async function loadOnlineRoles'));

  assert.match(html, /window\.__onlineRoleLoading\s*=\s*!!localStorage\.getItem\('dnf_online_token'\)/);
  assert.match(mine, /if \(!me && window\.__onlineRoleLoading\)/);
  assert.match(mine, /mine-role-loading/);
  assert.match(afterLogin, /finally\s*\{\s*window\.__onlineRoleLoading\s*=\s*false;/);
});

test('online recreation deletes the current server character before resetting the view', () => {
  const script = readAsset('online.js');
  assert.match(script, /window\.deleteRole\s*=\s*async function/);
  assert.match(script, /api\('\/api\/character\/' \+ role\._char_db_id \+ '\/delete', \{ method: 'POST' \}/);
});

test('online WebSocket reconnects after an unexpected close and resumes active runs', () => {
  const script = readAsset('online.js');
  assert.match(script, /scheduleWsReconnect/);
  assert.match(script, /wsReconnectTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?connectWs\(\)/);
  assert.match(script, /dungeon_resumed/);
});

test('online reconnect resets only after auth and keeps waiting AI runs visible', () => {
  const script = readAsset('online.js');
  assert.doesNotMatch(script, /socket\.onopen\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,220}wsReconnectAttempt\s*=\s*0/);
  assert.match(script, /case 'authed':[\s\S]{0,260}wsReconnectAttempt\s*=\s*0/);
  assert.match(script, /case 'run_waiting_ai':\s*onRunWaitingAi\(d\)/);
  assert.match(script, /function onRunWaitingAi/);
  assert.doesNotMatch(script, /function onRunWaitingAi[\s\S]{0,220}activeDungeons\.splice/);
  assert.match(script, /api\('\/api\/expeditions\/active'\)/);
  assert.match(script, /wsSend\(\{\s*type:\s*'ping'/);
  assert.match(script, /case 'pong':\s*break/);
});

test('online client shows an immediate starting card while AI setup is pending', () => {
  const script = readAsset('online.js');
  assert.match(script, /case 'dungeon_starting':\s*onRunStarting\(d\)/);
  assert.match(script, /function onRunStarting/);
  assert.match(script, /function renderStartingCard/);
  assert.match(script, /else if \(startingRoom\) renderStartingCard\(\)/);
});

test('online step handling ignores duplicate step numbers after resume', () => {
  const script = readAsset('online.js');
  assert.match(script, /Number\(step\.no\)\s*<=\s*lastStepNo/);
});

test('online character refresh avoids global logs, hidden-page rendering, and overlapping polls', () => {
  const script = readAsset('online.js');
  const loadRoles = script.slice(script.indexOf('async function loadOnlineRoles'), script.indexOf('async function refreshOnlineRoles'));
  const refreshRoles = script.slice(script.indexOf('async function refreshOnlineRoles'), script.indexOf('function startPublicCharacterRefresh'));
  const poll = script.slice(script.indexOf('let publicCharacterRefreshTimer'), script.indexOf('async function createRoleOnline'));

  assert.doesNotMatch(loadRoles, /\/api\/public\/logs/);
  assert.match(refreshRoles, /renderActiveOnlineTab\(\)/);
  assert.doesNotMatch(refreshRoles, /Object\.values\(rs\)/);
  assert.match(poll, /let publicCharacterRefreshInFlight\s*=\s*false/);
  assert.match(poll, /if \(publicCharacterRefreshInFlight\) return;/);
  assert.match(poll, /publicCharacterRefreshInFlight\s*=\s*true[\s\S]*await refreshOnlineRoles\([^;]*\);[\s\S]*finally\s*\{\s*publicCharacterRefreshInFlight\s*=\s*false;/);
});

test('online login rerenders the current tab without rebuilding hidden pages', () => {
  const script = readAsset('online.js');
  const afterLogin = script.slice(script.indexOf('async function afterLogin'), script.indexOf('async function loadOnlineRoles'));

  assert.doesNotMatch(afterLogin, /renderAll\(\)/);
  assert.doesNotMatch(afterLogin, /Object\.values\(rs\)/);
  assert.doesNotMatch(afterLogin, /switchTab\('mine'\)/);
  assert.match(afterLogin, /renderActiveOnlineTab\(\)/);
});

test('online login loads public roles when the restored tab needs them', () => {
  const script = readAsset('online.js');
  const afterLogin = script.slice(script.indexOf('async function afterLogin'), script.indexOf('async function loadOnlineRoles'));

  assert.match(afterLogin, /document\.querySelector\('\.tab-content\.active'\)/);
  assert.match(afterLogin, /await window\.loadTabData\?\.\(activeTab\)/);
});

test('online tab entry lazily requests shared world data only for consumers that need it', () => {
  const html = readAsset('index.html');
  const script = readAsset('online.js');
  const loadRoles = script.slice(script.indexOf('async function loadOnlineRoles'), script.indexOf('const PUBLIC_CHARACTER_CACHE_MS'));
  const afterLogin = script.slice(script.indexOf('async function afterLogin'), script.indexOf('async function loadOnlineRoles'));
  const tabLoader = script.slice(script.indexOf('window.loadTabData'), script.indexOf('/* 覆盖 createRole'));

  assert.doesNotMatch(loadRoles, /\/api\/public\/characters/);
  assert.doesNotMatch(afterLogin, /requestPublicRooms\(\)/);
  assert.match(tabLoader, /tab\s*===\s*'adventurers'[\s\S]*ensurePublicCharacters\(\{\s*filters:/);
  assert.match(tabLoader, /tab\s*===\s*'party'[\s\S]*ensurePublicCharacters\(\{\s*filters:[\s\S]*requestPublicRooms\(\)/);
  assert.match(html, /window\.loadTabData\?\.\(tab\)/);
});

test('adventurer filters reset to the first server-loaded page and render page controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const adventurers = html.slice(html.indexOf('let advFilter'), html.indexOf('function renderParty'));
  const publicLoader = online.slice(online.indexOf('async function ensurePublicCharacters'), online.indexOf('function renderActiveOnlineTab'));

  assert.match(adventurers, /page:\s*1/);
  assert.match(adventurers, /Object\.assign\(advFilter, next, \{ page: 1 \}\)/);
  assert.match(adventurers, /requestAdvCharacterPage\(advFilter\)/);
  assert.match(adventurers, /advPagerHTML\(/);
  assert.match(publicLoader, /URLSearchParams/);
  assert.match(publicLoader, /normalizePublicCharacterFilters\(filters\)/);
  assert.match(publicLoader, /page:\s*String\(normalized\.page\)/);
  assert.match(publicLoader, /\/api\/public\/characters\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(adventurers, /list\.filter\(/);
  assert.doesNotMatch(adventurers, /list\.sort\(/);
});

test('adventurer page requests a first-page current-role pin without changing party pages', () => {
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const loader = online.slice(online.indexOf('async function ensurePublicCharacters'), online.indexOf('function renderActiveOnlineTab'));
  const tabLoader = online.slice(online.indexOf('window.loadTabData'), online.indexOf('let publicCharacterRefreshTimer'));

  assert.match(loader, /pin_current/);
  assert.match(tabLoader, /tab\s*===\s*'adventurers'[\s\S]*pinCurrent:\s*true/);
  assert.match(tabLoader, /tab\s*===\s*'party'[\s\S]*pinCurrent:\s*false/);
});

test('follow controls persist through the account API and refresh the current adventurer page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const followCard = html.slice(html.indexOf('function advCardHTML'), html.indexOf('function renderTavern'));
  const followLoader = online.slice(online.indexOf('function openPartyMemberDetail'), online.indexOf('/* ---------- 覆盖匹配 ----------'));

  assert.match(followCard, /toggleFollow\(this,\s*\$\{advIdArg\(adv\.id\)\}\)/);
  assert.match(online, /window\.toggleFollow\s*=\s*async function/);
  assert.match(online, /\/api\/public\/characters\/\' \+ id \+ \'\/follow/);
  assert.match(online, /window\.loadPublicCharacterPage\(window\.advFilter \|\| \{\}\)/);
  assert.match(online, /publicCharacterPageCache\.clear\(\)/);
});

test('follow controls update optimistically before the background page refresh completes', () => {
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const follow = online.slice(online.indexOf('window.toggleFollow'), online.indexOf('function renderActiveOnlineTab'));

  assert.match(follow, /classList\.toggle\('active',\s*followed\)/);
  assert.match(follow, /textContent\s*=\s*followed\s*\?\s*'已关注'\s*:\s*'☆ 关注'/);
  assert.match(follow, /window\.loadPublicCharacterPage\(window\.advFilter \|\| \{\}\)[\s\S]*\.then/);
  assert.doesNotMatch(follow, /await window\.loadPublicCharacterPage\(window\.advFilter \|\| \{\}\)/);
});

test('online log tab loads persisted logs and checks the shared log view state', () => {
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const loader = online.slice(online.lastIndexOf('window.loadTabData'), online.indexOf('let publicCharacterRefreshTimer'));
  const sync = online.slice(online.indexOf('const __renderLogsOrig'), online.indexOf('window.renderLogs = renderLogsSynced'));
  const logLoader = loader.slice(loader.indexOf("if (tab === 'logs')"), loader.indexOf('} catch (_)'));

  assert.match(logLoader, /scheduleLogsSync\(0\)/);
  assert.doesNotMatch(logLoader, /renderActiveOnlineTab\(\)/);
  assert.doesNotMatch(logLoader, /await\s+fetchServerLogs\(\)/);
  assert.match(sync, /typeof\s+logViewId\s*===\s*['"]undefined['"]/);
  assert.match(sync, /api\('\/api\/public\/logs'\)/);
  assert.match(sync, /_logSyncPromise/);
  assert.match(sync, /logsSignature/);
  assert.doesNotMatch(online, /window\.logViewId/);
  assert.match(online, /window\.loadExpeditionLogDetail\s*=\s*function/);
  assert.match(online, /\/api\/public\/logs\/' \+ encodeURIComponent\(key\)/);
  assert.match(online, /window\.logDetailCache\.set\(key, log\)/);
});

test('expedition log details render progressively and running logs update incrementally', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const detail = html.slice(html.indexOf('const LOG_STEP_CHUNK'), html.indexOf('function memberStatusPanelHTML'));
  const wsStep = online.slice(online.indexOf('function onWsStep'), online.indexOf('function onRunError'));

  assert.match(detail, /LOG_STEP_CHUNK\s*=\s*8/);
  assert.match(detail, /window\.logDetailCache\s*=\s*new Map\(\)/);
  assert.match(detail, /function hasFullLogDetail/);
  assert.match(detail, /function logDetailLoadingHTML/);
  assert.match(detail, /if \(window\.loadExpeditionLogDetail\) window\.loadExpeditionLogDetail\(logModalId\);/);
  assert.match(detail, /scheduleLogDetailSteps/);
  assert.match(detail, /insertAdjacentHTML/);
  assert.match(detail, /data-rendered/);
  assert.match(detail, /updateRunningLogDetail/);
  assert.match(detail, /window\.updateRunningLogDetail/);
  assert.match(wsStep, /updateRunningLogDetail\(run\)/);
  assert.doesNotMatch(wsStep, /renderLogDetailModal\(\)/);
});

test('public log list returns summaries and the detail endpoint returns full steps', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  assert.match(server, /logs:\s*DB\.getAllLogSummaries\(\)/);
  assert.match(server, /publicLogDetailMatch\s*=\s*urlPath\.match/);
  assert.match(server, /DB\.getLogById\(Number\(publicLogDetailMatch\[1\]\)\)/);
  assert.match(db, /function getAllLogSummaries/);
  assert.match(db, /function getLogById/);
});

test('running expedition log cards use the matching-party label instead of player names', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const runningRow = html.slice(html.indexOf('function runningRowHTML'), html.indexOf('function pageListHTML'));

  assert.match(runningRow, /lr-party">\$\{esc\('匹配小队'\)\}/);
  assert.doesNotMatch(runningRow, /dg\.party\.map\(m => m\.name\)/);
});

test('party member details load one selected character outside the current page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const partyDetails = online.slice(online.indexOf('function openPartyMemberDetail'), online.indexOf('/* ---------- 覆盖匹配 ----------'));
  const dossier = html.slice(html.indexOf('function renderAdvDetail'), html.indexOf('function advLogsOf'));

  assert.match(partyDetails, /api\('\/api\/public\/characters\/' \+ id\)/);
  assert.match(partyDetails, /window\.D\.adventurerDetails/);
  assert.match(dossier, /D\.adventurerDetails\?\.get\(Number\(advDetailId\)\)/);
});

test('adventurer profile renders equipped skills with the same list style as the skill pool', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const profile = html.slice(html.indexOf('function advTabProfile'), html.indexOf('function advTabCombat'));

  assert.match(profile, /skillListItemHTML/);
  assert.match(profile, /poolVisible/);
  assert.match(profile, /toggleAdvPoolExpand/);
  assert.match(profile, /未装备功法 \/ 术法/);
  assert.doesNotMatch(profile, /skill-grid|skill-slot/);
});

test('character detail bolds skill and item names', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-detail-body \.skill-name,\n\.adv-detail-body \.sc-name \{ font-weight: 700; \}/);
});

test('adventurer combat profile renders magic items and storage with the same card list style', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const combat = html.slice(html.indexOf('function advTabCombat'), html.indexOf('function advTabAssets'));

  assert.match(combat, /itemCardHTML/);
  assert.match(combat, /toggleAdvBagExpand/);
  assert.match(combat, /skill-pool-list/);
  assert.match(combat, /随身法宝/);
  assert.match(combat, /储物袋/);
  assert.doesNotMatch(combat, /equip-card|ec-head|ec-name|ec-desc|ec-act|collect-grid|collect-card|cc-head|cc-name|cc-desc|cc-act/);
});

test('forge material list uses the skill-pool style with bag-like filters and a five-item expand toggle', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const forge = html.slice(html.indexOf('function forgeModalHTML'), html.indexOf('function toggleForgeMat'));

  assert.match(forge, /skill-pool-item forge-mat/);
  assert.match(forge, /forgeMatExpanded/);
  assert.match(forge, /forgeMatFilter/);
  assert.match(forge, /forgeMatSort/);
  assert.match(forge, /forgeMatSearch/);
  assert.match(forge, /toggleForgeMats/);
  assert.match(forge, /renderForgeMats/);
  assert.match(forge, /slice\(0, 5\)/);
  assert.match(forge, /搜索名称/);
  assert.match(forge, /bchip forge-mat-chip/);
  assert.match(forge, /bag-sort/);
  assert.doesNotMatch(forge, /fm-name|fm-meta|fm-src|fm-qty|fm-desc/);
  assert.match(styles, /\.forge-mat-filter-bar/);
});

test('public character page cache expires entries and caps distinct search pages', () => {
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const cache = online.slice(online.indexOf('const PUBLIC_CHARACTER_CACHE_MS'), online.indexOf('function renderActiveOnlineTab'));

  assert.match(cache, /MAX_PUBLIC_CHARACTER_PAGE_CACHE\s*=\s*20/);
  assert.match(cache, /function prunePublicCharacterPageCache/);
  assert.match(cache, /now - cached\.fetchedAt >= PUBLIC_CHARACTER_CACHE_MS/);
  assert.match(cache, /publicCharacterPageCache\.size >= MAX_PUBLIC_CHARACTER_PAGE_CACHE/);
});

test('character expedition log list exposes a dedicated archive shell and controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(html, /adv-log-shell/);
  assert.match(html, /adv-log-hero/);
  assert.match(html, /adv-log-controls/);
  assert.match(html, /adv-log-row/);
  assert.match(styles, /\.adv-log-shell/);
  assert.match(styles, /\.adv-log-hero/);
  assert.match(styles, /\.adv-log-controls/);
});

test('backdrop closing character logs clears the character log context', () => {
  const source = fs.readFileSync('index.html', 'utf8');
  const handler = source.slice(source.indexOf("$('#modal-overlay').addEventListener('click'"), source.indexOf("document.addEventListener('keydown'"));
  assert.match(handler, /advLogsAdv\s*!==\s*null[\s\S]*closeAdvLogsModal\(\)/);
});

test('expedition log detail keeps a reading header and structured step list', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(html, /log-reading-header/);
  assert.match(html, /log-reading-intro/);
  assert.match(html, /log-step-list/);
  assert.match(styles, /\.log-reading-header/);
  assert.match(styles, /\.log-reading-intro/);
  assert.match(styles, /\.log-step-list/);
});

test('expedition log detail step whitespace aligns with the reading container', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.log-step-list \.log-detail-step \{ padding: 18px 38px 18px 0; \}/);
  assert.doesNotMatch(styles, /\.log-step-list \.lds-no \{ margin-left:/);
  assert.match(styles, /\.log-step-list \.log-detail-step \{ gap: 11px; padding: 18px 33px 18px 0; \}/);
});

test('expedition log list rows use a link cursor while text stays selectable', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row\s*\{[^}]*cursor:\s*pointer/);
  assert.match(styles, /\.adv-log-row \.lr-head[^}]*user-select:\s*text/);
});

test('expedition log detail uses text cursors on text nodes and default cursors on blank containers', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const cursorStart = styles.indexOf('.adv-log-row { cursor: pointer; }');
  const cursorEnd = styles.indexOf('@media (max-width: 640px)', cursorStart);
  const detailCursors = styles.slice(cursorStart, cursorEnd);

  assert.match(detailCursors, /\.log-detail \.log-detail-step[^}]*cursor:\s*default/);
  assert.match(detailCursors, /\.log-detail \.lds-body p[^}]*cursor:\s*text/);
  assert.match(detailCursors, /\.log-detail \.log-detail-title[^}]*cursor:\s*text/);
  assert.doesNotMatch(detailCursors, /\.log-detail-step[^}]*cursor:\s*pointer/);
});

test('expedition summary uses the available log-card width', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row \.lr-summary[^\{]*\{[^}]*max-width:\s*none/);
  assert.match(styles, /\.adv-log-row \.lr-summary[^\{]*\{[^}]*margin:\s*0/);
  assert.match(styles, /\.adv-log-row \.lr-summary[^\{]*\{[\s\S]*padding:\s*0[\s\S]*border:\s*0[\s\S]*border-radius:\s*0[\s\S]*background:\s*transparent/);
});

test('expedition log cards and detail steps avoid decorative arrows and connector lines', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.doesNotMatch(html, /class="lr-arrow"/);
  assert.doesNotMatch(html, /class="lr-emblem"/);
  assert.doesNotMatch(styles, /\.lr-emblem\s*\{/);
  assert.doesNotMatch(styles, /\.log-step-list \.lds-no::after/);
  assert.match(styles, /\.log-step-list \.lds-body p[^\{]*\{[^}]*max-width:\s*none/);
});

test('expedition log metadata aligns with the summary box edge', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row \.lr-meta[^\{]*\{[^}]*margin-left:\s*0/);
});

test('expedition log rows place status in the top-right and use the reference surface tone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(html, /lr-status-top/);
  assert.match(styles, /\.lr-status-top/);
  assert.match(styles, /\.adv-log-row[^\{]*\{[^}]*background:\s*#f[0-9a-f]{5,6}/i);
});

test('expedition log typography follows the reference hierarchy', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row \.lr-party[^\{]*\{[^}]*color:\s*#567493[^}]*font-size:\s*14px/);
  assert.match(styles, /\.adv-log-row \.lr-dungeon[^\{]*\{[^}]*color:\s*#000[^}]*font-size:\s*14px[^}]*font-weight:\s*500/);
  assert.match(styles, /\.log-detail \.ldm-dungeon[^\{]*\{[^}]*color:\s*#000/);
  assert.match(styles, /\.adv-log-row \.lr-summary[^\{]*\{[\s\S]*color:\s*#536f8c[\s\S]*font-size:\s*14px/);
  assert.match(styles, /\.adv-log-row \.lr-meta[^\{]*\{[^}]*color:\s*#5d7184[^}]*font-size:\s*14px/);
  assert.match(styles, /\.adv-log-row \.lr-id[^\{]*\{[^}]*color:\s*#5d7184[^}]*font-size:\s*inherit[^}]*font-weight:\s*400/);
});

test('expedition log cards are slightly narrower on desktop and full-width on mobile', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row[^\{]*\{[\s\S]*width:\s*calc\(100%\s*-\s*20px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*640px\)[\s\S]*\.adv-log-row\s*\{\s*width:\s*100%/);
});

test('expedition log status badges use the compact reference scale', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row \.lr-status-top[^\{]*\{[^}]*padding:\s*1px\s+8px[^}]*border-radius:\s*8px[^}]*font-size:\s*12px/);
});

test('special-event expedition cards use the reference red surface treatment', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.adv-log-row\.se-event[^\{]*\{[\s\S]*border:\s*1px\s+solid\s+#f85149[\s\S]*border-left-width:\s*4px/);
  assert.match(styles, /\.adv-log-row\.se-event[^\{]*\{[\s\S]*background:\s*linear-gradient\(112deg,\s*#fff1f1/);
  assert.match(styles, /\.adv-log-row\.se-event[^\{]*\{[\s\S]*box-shadow:\s*0\s+6px\s+16px\s+#f8514924/);
});
