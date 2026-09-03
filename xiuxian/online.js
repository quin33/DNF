/* ============================================================
   online.js · 在线模式覆盖层（追加脚本，晚于主脚本加载）
   将原本地 localStorage 单机版改为：登录认证 + 服务端角色 +
   服务端匹配 + 服务端权威副本（客户端纯观看）。
   覆盖的全局函数在第一个 script 中声明的同名函数之上生效。
   ============================================================ */
(function () {
  window.__onlineMode = true;
  const TOKEN_KEY = 'xiuxian_online_token';
  const ROLE_CACHE_KEY = 'xiuxian_role_cache_v1';
  // D 在首个 script 中是局部 const，需要暴露到 window 供 online overlay 使用
  if (!window.D) window.D = window.TAVERN_DATA;
  const API = { token: localStorage.getItem(TOKEN_KEY) || '', user: null, chars: [] };
  let taixuInsightInFlight = false;
  let forgeInFlight = false;
  let authMode = 'login';
  const npcCardCache = new Map();  // name -> AI 队友名片（服务端下发）
  window.__npcCardCache = npcCardCache;

  function findNpcCardByName(name) {
    const cached = npcCardCache.get(String(name || ''));
    if (cached) return cached;
    const defaults = (window.AI_COMPANION_CARDS && window.AI_COMPANION_CARDS.DEFAULT_CARDS) || [];
    return defaults.find(card => card.name === String(name || '')) || null;
  }
  function registerNpcCard(card, runtime = {}) {
    if (!card || !card.name) return null;
    const view = {
      ...card,
      id: card.id || ('npc-' + card.name),
      is_npc: true,
      is_mine: false,
      _char_db_id: null,
      _from_npc_card: true,
    };
    if (Number.isFinite(Number(runtime.hp))) view.hp = Number(runtime.hp);
    if (Number.isFinite(Number(runtime.max_hp))) view.max_hp = Number(runtime.max_hp);
    npcCardCache.set(card.name, view);
    return view;
  }
  function registerNpcCardsFromParty(party) {
    (Array.isArray(party) ? party : []).forEach(member => {
      if (member && member.isNpc && member.card) registerNpcCard(member.card, member);
    });
  }

  function hydrateCachedRole() {
    if (!API.token) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ROLE_CACHE_KEY) || 'null');
      if (!cached || !cached._char_db_id) return;
      window.D.my_adventurer = { ...cached, is_mine: true, _from_cache: true };
      window.D.adventurers = [window.D.my_adventurer];
      if (window.renderMine) renderMine();
      if (window.renderAdventurers) renderAdventurers();
    } catch (_) {}
  }
  hydrateCachedRole();

  /* ---------- 基础请求 ---------- */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (API.token) headers['Authorization'] = 'Bearer ' + API.token;
    const r = await fetch(path, { headers, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  /* 角色对象 id 可能来自服务端 number；统一存 role._char_db_id 供上传 */
  let _saveTimer = null;
  function debounceSaveRole() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => uploadRole(), 600);
  }
  async function uploadRole() {
    const role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id || !API.token) return;
    try {
      const saved = await api('/api/character/' + role._char_db_id, { method: 'POST', body: { character: role, updated_at: role._char_updated_at } });
      Object.assign(role, saved.character || {}, { _char_db_id: role._char_db_id, _char_updated_at: saved.updated_at, is_mine: true });
    } catch (e) {
      if (e.message.includes('Character data has changed')) await refreshOnlineRoles();
    }
  }

  async function onlineCharacterAction(action, payload = {}) {
    const role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id) throw new Error('角色尚未与服务器同步');
    if (role.status === 'adventuring') throw new Error('角色正在探险');
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    const result = await api('/api/character/' + role._char_db_id + '/action', {
      method: 'POST', body: { action, updated_at: role._char_updated_at, ...payload },
    });
    Object.assign(role, result.character || {}, { _char_db_id: role._char_db_id, _char_updated_at: result.updated_at, is_mine: true });
    const match = (window.D.adventurers || []).find(a => Number(a._char_db_id || a.id) === Number(role._char_db_id));
    if (match && match !== role) Object.assign(match, role);
    if (window.renderMine) renderMine();
    if (window.renderAdventurers) renderAdventurers();
    if (window.renderParty) renderParty();
    return result;
  }

  /* ============================================================
     登录 / 注册层
     ============================================================ */
  function showAuthLayer() {
    let overlay = $('#auth-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'auth-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:linear-gradient(160deg,#0f1a2b,#1e2f46);display:flex;align-items:center;justify-content:center;padding:20px;';
      overlay.innerHTML = `
        <style>
          .ol-auth-card{width:min(92vw,420px);background:#fff;border:1px solid #dfe4ec;border-radius:14px;padding:22px 22px 18px;box-shadow:0 24px 70px #0008;color:#1c2333;box-sizing:border-box}
          .ol-auth-brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;color:#1c2333;margin-bottom:14px}
          .ol-auth-brand-mark{width:30px;height:30px;border-radius:8px;background:#2f6fed;color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px}
          .ol-auth-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#eef1f6;border-radius:10px;padding:4px;margin-bottom:16px}
          .ol-auth-tab{border:0;background:transparent;padding:9px 10px;border-radius:8px;font-size:14px;color:#6b7280;cursor:pointer}
          .ol-auth-tab.is-active{background:#fff;color:#1c2333;font-weight:600;box-shadow:0 1px 4px #0001}
          .ol-auth-field{margin-bottom:12px}
          .ol-auth-field label{display:block;font-size:13px;font-weight:600;color:#30394a;margin-bottom:6px}
          .ol-auth-field input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d4dae3;border-radius:8px;background:#f7f9fc;color:#1c2333;font-size:14px}
          .ol-auth-field input:focus{outline:none;border-color:#2f6fed;background:#fff;box-shadow:0 0 0 3px #2f6fed22}
          .ol-auth-hint{margin:5px 0 0;font-size:12px;color:#8a94a3}
          .ol-auth-err{min-height:18px;margin:2px 0 8px;font-size:12.5px;color:#c0392b}
          .ol-auth-submit{width:100%;padding:11px;border:0;border-radius:8px;background:#2f6fed;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
          .ol-auth-submit:hover{background:#245bd0}
          .ol-auth-foot{margin:12px 0 0;text-align:center;font-size:12px;color:#8a94a3}
        </style>
        <div class="ol-auth-card">
          <div class="ol-auth-brand"><span class="ol-auth-brand-mark">⚔️</span><span>问道仙坊</span></div>
          <div class="ol-auth-tabs" role="tablist">
            <button class="ol-auth-tab is-active" data-mode="login" type="button" role="tab">登录</button>
            <button class="ol-auth-tab" data-mode="register" type="button" role="tab">注册</button>
          </div>
          <div class="ol-auth-field">
            <label for="ol-user">用户名</label>
            <input id="ol-user" maxlength="32" autocomplete="username" placeholder="请输入用户名">
            <p class="ol-auth-hint" id="ol-user-hint">3-32 字符，字母数字下划线</p>
          </div>
          <div class="ol-auth-field" id="ol-nick-field" hidden>
            <label for="ol-nick">昵称（选填）</label>
            <input id="ol-nick" maxlength="10" autocomplete="nickname" placeholder="请输入昵称">
            <p class="ol-auth-hint">最长 10 字符，支持中文</p>
          </div>
          <div class="ol-auth-field">
            <label for="ol-pass">密码</label>
            <input id="ol-pass" type="password" maxlength="64" autocomplete="current-password" placeholder="请输入密码">
            <p class="ol-auth-hint" id="ol-pass-hint">至少 6 位密码</p>
          </div>
          <div class="ol-auth-field" id="ol-confirm-field" hidden>
            <label for="ol-confirm">确认密码</label>
            <input id="ol-confirm" type="password" maxlength="64" autocomplete="new-password" placeholder="再次输入密码">
            <p class="ol-auth-hint">再次输入密码</p>
          </div>
          <div id="ol-err" class="ol-auth-err"></div>
          <button id="ol-submit" class="ol-auth-submit" type="button">登录</button>
          <p class="ol-auth-foot" id="ol-auth-foot">登录后角色将保存在服务器</p>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelectorAll('.ol-auth-tab').forEach(btn => btn.addEventListener('click', () => switchAuthMode(btn.dataset.mode)));
      overlay.querySelector('#ol-submit').addEventListener('click', doAuth);
      ['ol-user', 'ol-pass', 'ol-nick', 'ol-confirm'].forEach(id => {
        const input = overlay.querySelector('#' + id);
        if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
      });
    }
    overlay.style.display = 'flex';
    switchAuthMode('login');
  }
  function switchAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const register = authMode === 'register';
    document.querySelectorAll('.ol-auth-tab').forEach(btn => btn.classList.toggle('is-active', btn.dataset.mode === authMode));
    const nickField = $('#ol-nick-field');
    const confirmField = $('#ol-confirm-field');
    const submit = $('#ol-submit');
    const err = $('#ol-err');
    const userHint = $('#ol-user-hint');
    const passHint = $('#ol-pass-hint');
    if (nickField) nickField.hidden = !register;
    if (confirmField) confirmField.hidden = !register;
    if (submit) submit.textContent = register ? '注册' : '登录';
    if (err) err.textContent = '';
    if (userHint) userHint.textContent = register ? '3-32 字符，字母数字下划线' : '输入已注册的用户名';
    if (passHint) passHint.textContent = register ? '至少 6 位密码' : '输入你的密码';
    const pass = $('#ol-pass');
    if (pass) pass.setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  }
  function hideAuthLayer() { const o = $('#auth-overlay'); if (o) o.style.display = 'none'; }

  async function doAuth() {
    const u = $('#ol-user').value.trim();
    const p = $('#ol-pass').value;
    const nickname = $('#ol-nick') ? $('#ol-nick').value.trim() : '';
    const confirmP = $('#ol-confirm') ? $('#ol-confirm').value : '';
    const errEl = $('#ol-err');
    if (authMode === 'register') {
      if (!/^[A-Za-z0-9_]{3,32}$/.test(u)) { errEl.textContent = '用户名需 3-32 字符，仅限字母、数字、下划线'; return; }
      if (nickname.length > 10) { errEl.textContent = '昵称不能超过 10 个字符'; return; }
      if (p.length < 6 || p.length > 64) { errEl.textContent = '密码至少 6 位'; return; }
      if (p !== confirmP) { errEl.textContent = '两次输入的密码不一致'; return; }
    } else {
      if (!u || !p) { errEl.textContent = '请输入用户名和密码'; return; }
    }
    try {
      const body = { username: u, password: p };
      if (authMode === 'register') body.nickname = nickname;
      const j = await api('/api/auth/' + (authMode === 'register' ? 'register' : 'login'), { method: 'POST', body });
      API.token = j.token;
      API.user = j.user;
      localStorage.setItem(TOKEN_KEY, j.token);
      window.__onlineRoleLoading = true;
      hideAuthLayer();
      await afterLogin();
    } catch (e) { errEl.textContent = e.message; }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    API.token = ''; API.user = null; API.chars = [];
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_CACHE_KEY);
    closeWs();
    window.D.my_adventurer = null;
    window.D.adventurers = [];
    window.location.reload();
  }
  window.logoutOnline = logout;

  /* 登录后：拉取全部角色 → 填充 D → 重渲染 */
  async function afterLogin() {
    const fixedLogout = $('#online-logout');
    if (fixedLogout) fixedLogout.hidden = false;
    try {
      await loadOnlineRoles();
    } finally {
      window.__onlineRoleLoading = false;
    }
    startPublicCharacterRefresh();
    connectWs();
    scheduleActiveRunSync();
    const nn = $('#nav-nick');
    if (nn) nn.textContent = API.user ? (API.user.nickname || API.user.username) : '道友';
    const bal = $('#nav-balance');
    if (bal) bal.textContent = (window.D.my_adventurer ? window.D.my_adventurer.gold : 0) + '';
    const T = window.D && window.D.tavern;
    if (T) T.subtitle = '在线修仙 · 已登录：' + (API.user ? API.user.username : '');
    const activePanel = document.querySelector('.tab-content.active');
    const activeTab = activePanel && activePanel.id.replace('tab-', '');
    if (activeTab === 'adventurers' || activeTab === 'party') await window.loadTabData?.(activeTab);
    renderActiveOnlineTab();
    showTaixuInsightNotice();
  }

  function showTaixuInsightNotice() {
    const role = window.D && window.D.my_adventurer;
    const notice = role && role.taixuInsightNotice;
    if (!notice || !notice.jobId) return;
    const key = 'xiuxian_taixu_notice_' + notice.jobId;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    setTimeout(() => {
      if (notice.ok && notice.skill && window.renderTaixuInsightSuccess) renderTaixuInsightSuccess({ ...notice, character: role, updated_at: role._char_updated_at });
      else if (!notice.ok) toastMsg(notice.error || '太虚幻境参悟失败');
    }, 0);
  }

  /* 覆盖 loadRole：从服务端加载全部角色 */
  async function loadOnlineRoles() {
    const D = window.D;
    const me = await api('/api/me');
    API.user = me.user;
    const chars = (await Promise.all((me.characters || []).map(async c => {
      try { const d = await api('/api/character/' + c.id); return { ...d.character, _char_db_id: c.id, _char_updated_at: d.updated_at, is_mine: true }; } catch (e) { return null; }
    }))).filter(Boolean);
    // 将服务端角色 id 并入（兼容原逻辑的本地 id 引用）
    chars.forEach(c => { if (!c.id && c._char_db_id) c.id = c._char_db_id; });
    API.chars = chars;
    // 我的角色优先落入页面，不等待公共角色和日志接口。
    D.my_adventurer = chars[0] || null;
    if (D.my_adventurer) {
      try { localStorage.setItem(ROLE_CACHE_KEY, JSON.stringify(D.my_adventurer)); } catch (_) {}
    }
    if (D.my_adventurer) {
      D.my_adventurer.is_mine = true;
      // 储物袋/功法等字段补全
      if (!Array.isArray(D.my_adventurer.bag)) D.my_adventurer.bag = [];
      if (!Array.isArray(D.my_adventurer.skillPool)) D.my_adventurer.skillPool = [];
      if (!Array.isArray(D.my_adventurer.skills)) D.my_adventurer.skills = [];
      if (!Array.isArray(D.my_adventurer.equipment)) D.my_adventurer.equipment = [];
      if (!D.my_adventurer.staminaTs) D.my_adventurer.staminaTs = Date.now();
      if (!D.my_adventurer.hpTs) D.my_adventurer.hpTs = Date.now();
    }
    // 登录只保留本人角色；公共角色在冒险者/小队页首次进入时再加载。
    const ownIds = new Set(chars.map(c => Number(c._char_db_id || c.id)));
    const publicCache = (D.adventurers || []).filter(a => !ownIds.has(Number(a._char_db_id || a.id)));
    D.adventurers = [...chars, ...publicCache];
    // 动态（feed）本地保留新角色初始；在线下由服务端结算产生
    D.my_feed = D.my_feed || [];
  }

  const PUBLIC_CHARACTER_CACHE_MS = 15_000;
  const MAX_PUBLIC_CHARACTER_PAGE_CACHE = 20;
  const publicCharacterPageCache = new Map();
  const publicCharacterRequests = new Map();
  let publicCharacterRequestId = 0;

  function normalizePublicCharacterFilters(filters = {}) {
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    return {
      page,
      status: filters.status || 'all',
      sort: filters.sort || 'created_at',
      order: filters.order === 'asc' ? 'asc' : 'desc',
      q: String(filters.q || '').trim(),
    };
  }

  function publicCharacterViewModel(publicChar) {
    const mine = (API.chars || []).find(character => Number(character._char_db_id || character.id) === Number(publicChar.id));
    if (mine) return { ...publicChar, ...mine, is_mine: true };
    return {
      ...publicChar,
      traits: Array.isArray(publicChar.traits) ? publicChar.traits : (publicChar.root ? [publicChar.root] : []),
      _char_db_id: publicChar.id,
      _char_updated_at: publicChar.updated_at,
      is_mine: false,
    };
  }

  function applyPublicCharacterPage(response) {
    const publicChars = Array.isArray(response.characters) ? response.characters : [];
    window.D.adventurers = publicChars.map(publicCharacterViewModel);
    window.D.adventurerPage = {
      total: Number(response.total) || 0,
      page: Number(response.page) || 1,
      pageSize: Number(response.pageSize) || 12,
      pages: Math.max(1, Number(response.pages) || 1),
    };
  }

  function prunePublicCharacterPageCache(now = Date.now()) {
    for (const [key, cached] of publicCharacterPageCache) {
      if (now - cached.fetchedAt >= PUBLIC_CHARACTER_CACHE_MS) publicCharacterPageCache.delete(key);
    }
    while (publicCharacterPageCache.size >= MAX_PUBLIC_CHARACTER_PAGE_CACHE) {
      publicCharacterPageCache.delete(publicCharacterPageCache.keys().next().value);
    }
  }

  async function ensurePublicCharacters({ force = false, filters = window.advFilter || {}, pinCurrent = false } = {}) {
    if (!API.token) return;
    const normalized = normalizePublicCharacterFilters(filters);
    const params = new URLSearchParams({
      page: String(normalized.page),
      status: normalized.status,
      sort: normalized.sort,
      order: normalized.order,
      q: normalized.q,
      pin_current: pinCurrent && normalized.page === 1 ? '1' : '0',
    });
    const key = params.toString();
    const requestId = ++publicCharacterRequestId;
    prunePublicCharacterPageCache();
    const cached = publicCharacterPageCache.get(key);
    if (!force && cached && Date.now() - cached.fetchedAt < PUBLIC_CHARACTER_CACHE_MS) {
      if (requestId === publicCharacterRequestId) applyPublicCharacterPage(cached.response);
      return cached.response;
    }
    let request = publicCharacterRequests.get(key);
    if (!request) {
      request = api(`/api/public/characters?${params.toString()}`).then(response => {
        prunePublicCharacterPageCache();
        publicCharacterPageCache.set(key, { response, fetchedAt: Date.now() });
        return response;
      }).finally(() => publicCharacterRequests.delete(key));
      publicCharacterRequests.set(key, request);
    }
    try {
      const response = await request;
      if (requestId === publicCharacterRequestId) applyPublicCharacterPage(response);
      return response;
    } catch (error) {
      throw error;
    }
  }

  window.loadPublicCharacterPage = async function loadPublicCharacterPage(filters) {
    return ensurePublicCharacters({ filters, pinCurrent: true });
  };

  window.toggleFollow = async function toggleFollow(btn, id) {
    const previousFollowed = btn.classList.contains('active');
    const followed = !previousFollowed;
    btn.disabled = true;
    btn.classList.toggle('active', followed);
    btn.textContent = followed ? '已关注' : '☆ 关注';
    try {
      await api('/api/public/characters/' + id + '/follow', {
        method: 'POST',
        body: { followed },
      });
      const localCharacter = (window.D.adventurers || []).find(character => Number(character.id || character._char_db_id) === Number(id));
      if (localCharacter) localCharacter.is_followed = followed;
      btn.disabled = false;
      publicCharacterPageCache.clear();
      window.loadPublicCharacterPage(window.advFilter || {})
        .then(() => { if (window.renderAdventurers) renderAdventurers(); })
        .catch(error => { toastMsg(error.message || '关注状态刷新失败'); });
    } catch (error) {
      btn.classList.toggle('active', previousFollowed);
      btn.textContent = previousFollowed ? '已关注' : '☆ 关注';
      toastMsg(error.message || '关注操作失败');
      btn.disabled = false;
    }
  };

  function renderActiveOnlineTab() {
    const activeTab = document.querySelector('.tab-content.active');
    const tab = activeTab && activeTab.id.replace('tab-', '');
    const render = {
      tavern: window.renderTavern,
      activity: window.renderActivity,
      building: window.renderBuilding,
      mine: window.renderMine,
      adventurers: window.renderAdventurers,
      party: window.renderParty,
      logs: window.renderLogs,
    }[tab];
    if (typeof render === 'function') render();
  }

  async function refreshOnlineRoles({ includePublicCharacters = false } = {}) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    await loadOnlineRoles();
    if (includePublicCharacters) await ensurePublicCharacters({
      force: true,
      filters: window.advFilter || {},
      pinCurrent: !!document.querySelector('#tab-adventurers.active'),
    });
    renderActiveOnlineTab();
  }

  function isPublicCharacterConsumerActive() {
    return !!document.querySelector('#tab-adventurers.active, #tab-party.active');
  }

  window.loadTabData = async function loadTabData(tab) {
    try {
      if (tab === 'adventurers') {
        await ensurePublicCharacters({ filters: window.advFilter || {}, pinCurrent: true });
        renderActiveOnlineTab();
      }
      if (tab === 'party') {
        await ensurePublicCharacters({ filters: { page: 1, status: 'all', sort: 'created_at', order: 'desc', q: '' }, pinCurrent: false });
        requestPublicRooms();
        renderActiveOnlineTab();
      }
      if (tab === 'logs') {
        scheduleLogsSync(0);
      }
    } catch (_) {
      // 页面保留已有缓存内容；下次切入时会重试。
    }
  };

  let publicCharacterRefreshTimer = null;
  let publicCharacterRefreshInFlight = false;
  function startPublicCharacterRefresh() {
    if (publicCharacterRefreshTimer) return;
    publicCharacterRefreshTimer = setInterval(async () => {
      if (!API.token || !document.querySelector('#tab-adventurers.active')) return;
      if (publicCharacterRefreshInFlight) return;
      publicCharacterRefreshInFlight = true;
      try {
        await refreshOnlineRoles({ includePublicCharacters: true });
      } catch (_) {
        // 定时刷新失败不打断玩家当前操作，下一轮继续尝试同步。
      } finally {
        publicCharacterRefreshInFlight = false;
      }
    }, 10_000);
  }

  /* 覆盖 createRole：服务端生成并入库 */
  async function createRoleOnline() {
    if (createRoleOnline.busy) return;
    const D = window.D;
    const name = ($('#rc-name') && $('#rc-name').value || '').trim();
    if (!name) { toastMsg('请输入角色名'); return; }
    if (name.length > 12) { toastMsg('角色名不能超过 12 字'); return; }
    if ((D.adventurers || []).some(character => character && character.name === name)) { toastMsg('角色名重复'); return; }
    const selCount = document.querySelectorAll('#rc-item-list .item-check.on, .item-card.on').length;
    if (window.charSel && window.charSel.items && window.charSel.items.size !== 2 && !selCount) {
      // 兼容新创建表单/旧表单选择项
    }
    const itemKeys = [];
    if (window.charSel && window.charSel.items) for (const k of window.charSel.items) itemKeys.push(k);
    const submitButton = document.querySelector('#rc-submit, #create-role, [onclick="createRole()"]');
    createRoleOnline.busy = true;
    if (submitButton) submitButton.disabled = true;
    try {
      const creation_request_id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const j = await api('/api/character/create', {
        method: 'POST',
        body: {
          creation_request_id,
          name,
          root: (window.charSel && window.charSel.root) || 'jin',
          gender: (window.charSel && window.charSel.gender) || '男',
          pers: (window.charSel && window.charSel.pers) || '重诺',
          items: itemKeys.length === 2 ? itemKeys : ['iron_sword', 'condense_pill'],
        },
      });
      await loadOnlineRoles();
      if (window.renderMine) renderMine();
      if (window.renderAdventurers) renderAdventurers();
      if (window.renderTavern) renderTavern();
      toastMsg('🎉 角色「' + j.character.name + '」创建成功，已存入服务器！');
    } catch (e) { toastMsg(e.message === '角色名重复' ? '角色名重复' : '创建失败：' + e.message); }
    finally {
      createRoleOnline.busy = false;
      if (submitButton) submitButton.disabled = false;
    }
  }

  /* 覆盖 saveRole：防抖上传 */
  function saveRoleOnline() {
    if (taixuInsightInFlight || forgeInFlight) return;
    debounceSaveRole();
  }

  window.forgeOnline = async function forgeOnline(payload) {
    const role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id) throw new Error('角色尚未与服务器同步');
    if (role.status === 'insighting' || role.taixuInsight) throw new Error('角色正在太虚幻境参悟');
    if (!payload || !payload.item) {
      forgeInFlight = true;
      try {
        const accepted = await api('/api/character/' + role._char_db_id + '/forge', {
          method: 'POST',
          body: { materials: payload && payload.materials || [], updated_at: role._char_updated_at },
        });
        if (!accepted.jobId) throw new Error('炼器任务创建失败');
        for (let poll = 0; poll < 600; poll++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const status = await api('/api/character/' + role._char_db_id + '/forge/' + encodeURIComponent(accepted.jobId));
          if (status.status === 'completed') {
            const merged = status.character || {};
            Object.assign(role, merged, { _char_db_id: role._char_db_id, _char_updated_at: status.updated_at, is_mine: true });
            const match = (window.D.adventurers || []).find(a => Number(a._char_db_id || a.id) === Number(role._char_db_id));
            if (match && match !== role) Object.assign(match, role);
            return status;
          }
          if (status.status === 'failed') throw new Error(status.error || '炼器失败');
        }
        throw new Error('炼器等待超时，请稍后查看角色状态');
      } finally {
        forgeInFlight = false;
      }
    }
    const result = await api('/api/character/' + role._char_db_id + '/forge', {
      method: 'POST',
      body: { ...payload, updated_at: role._char_updated_at },
    });
    const merged = result.character || {};
    Object.assign(role, merged, { _char_db_id: role._char_db_id, _char_updated_at: result.updated_at, is_mine: true });
    const match = (window.D.adventurers || []).find(a => Number(a._char_db_id || a.id) === Number(role._char_db_id));
    if (match && match !== role) Object.assign(match, role);
    return result;
  };

  /* ============================================================
     匹配 + 服务端副本播放（WS）
     ============================================================ */
  let ws = null, wsReady = false;
  let wsReconnectTimer = null, wsReconnectAttempt = 0, wsIntentionalClose = false, wsHeartbeatTimer = null;
  let wsLastPongAt = 0;
  let activeWsRun = null;   // 在线副本播放状态
  let startingRoom = null;  // 已点击开本、AI 尚未返回前的占位状态
  let publicRooms = [];
  let activeRunSyncTimer = null, activeRunSyncInFlight = false;

  function setPublicRooms(rooms) {
    publicRooms = Array.isArray(rooms) ? rooms : [];
    window.publicRooms = publicRooms;
    registerNpcCardsFromParty(publicRooms.flatMap(room => room.party || []));
    if (document.querySelector('#tab-party.active')) renderParty();
  }

  function requestPublicRooms() {
    if (wsReady && API.token) wsSend({ type: 'rooms', token: API.token });
  }
  async function syncActiveExpeditions() {
    if (!API.token) return;
    try {
      const body = await api('/api/expeditions/active');
      if (!API.token) return;
      const runs = Array.isArray(body && body.runs) ? body.runs : [];
      const remoteIds = new Set(runs.map(entry => String(entry && entry.runId || '')));
      for (const entry of runs) {
        if (!entry || !entry.runId || !entry.snapshot) continue;
        onRunResumed(entry.snapshot, entry.runId, entry.status);
      }
      const knownRuns = (window.activeDungeons || []).slice();
      let changed = false;
      for (const run of knownRuns) {
        const runId = String(run && (run.runId || run.id) || '');
        if (!runId || remoteIds.has(runId)) continue;
        const index = (window.activeDungeons || []).indexOf(run);
        if (index >= 0) window.activeDungeons.splice(index, 1);
        if (run === activeWsRun) {
          activeWsRun = null;
          window.matchQueue = null;
          if (squadCardEl) {
            try { squadCardEl.remove(); } catch (_) {}
            squadCardEl = null;
          }
        }
        changed = true;
      }
      if (changed) {
        try { renderParty(); } catch (_) {}
        renderLogs();
        void fetchServerLogs();
      }
    } catch (_) {}
  }
  function scheduleActiveRunSync() {
    if (!API.token || activeRunSyncTimer) return;
    const hasActiveRun = !!(window.activeDungeons && window.activeDungeons.length);
    activeRunSyncTimer = setTimeout(async () => {
      activeRunSyncTimer = null;
      if (activeRunSyncInFlight) {
        scheduleActiveRunSync();
        return;
      }
      activeRunSyncInFlight = true;
      try {
        await syncActiveExpeditions();
      } finally {
        activeRunSyncInFlight = false;
        scheduleActiveRunSync();
      }
    }, hasActiveRun ? 5000 : 15000);
  }
  function scheduleWsReconnect() {
    if (wsReconnectTimer || wsIntentionalClose || !API.token) return;
    const delay = Math.min(10000, 1000 * (2 ** Math.min(wsReconnectAttempt++, 3)));
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWs();
    }, delay);
  }
  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    wsIntentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // 页面头部的引导脚本已包装 fetch 补前缀，WebSocket 得自己带上。
    const socket = new WebSocket(proto + '://' + location.host + (window.__basePath || '') + '/ws');
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      wsReady = true;
      wsLastPongAt = Date.now();
      if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = setInterval(() => {
        if (!wsReady || !ws || ws.readyState !== 1) return;
        wsSend({ type: 'ping', at: Date.now() });
        if (Date.now() - wsLastPongAt > 75000) {
          wsReady = false;
          const stale = ws;
          ws = null;
          clearInterval(wsHeartbeatTimer);
          wsHeartbeatTimer = null;
          try { stale.close(); } catch (_) {}
          scheduleWsReconnect();
        }
      }, 30000);
      socket.send(JSON.stringify({ type: 'auth', token: API.token }));
    };
    socket.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (_) { return; } handleWsMsg(d); };
    socket.onclose = () => {
      if (ws !== socket) return;
      wsReady = false;
      if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
      ws = null;
      scheduleWsReconnect();
    };
    socket.onerror = () => {};
  }
  function closeWs() {
    wsIntentionalClose = true;
    if (activeRunSyncTimer) { clearTimeout(activeRunSyncTimer); activeRunSyncTimer = null; }
    activeRunSyncInFlight = false;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    try { if (ws) ws.close(); } catch (e) {}
    ws = null; wsReady = false;
  }
  function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function handleWsMsg(d) {
    switch (d.type) {
      case 'authed':
        wsReconnectAttempt = 0;
        if (document.querySelector('#tab-party.active')) requestPublicRooms();
        void syncActiveExpeditions();
        break;
      case 'pong': wsLastPongAt = Date.now(); break;
      case 'rooms_updated': setPublicRooms(d.rooms); break;
      case 'room_state': break;
      case 'ai_companions_updated': {
        npcCardCache.clear();
        registerNpcCardsFromParty(publicRooms.flatMap(room => room.party || []));
        if (activeWsRun) registerNpcCardsFromParty(activeWsRun.party);
        break;
      }
      case 'character_updated':
        if (taixuInsightInFlight) break;
        refreshOnlineRoles().then(() => {
          if (d.updated_at != null) toastMsg('角色数据已由后台更新');
        });
        break;
      case 'character_deleted':
        if (taixuInsightInFlight) break;
        refreshOnlineRoles()
          .then(() => toastMsg('角色已阵亡，永久删除'))
          .catch(() => {});
        break;
      case 'public_characters_updated':
        if (taixuInsightInFlight) break;
        refreshOnlineRoles({ includePublicCharacters: isPublicCharacterConsumerActive() }).catch(() => {});
        break;
      case 'match_state': renderMatchState(d); break;
      case 'match_enqueued': renderMatchState({ ...(window.__olMatch || {}), queued: d.position, remainingMs: d.remainingMs, members: window.__olMatchMembers || [] }); break;
      case 'match_cancelled': window.matchQueue = null; renderParty(); break;
      case 'dungeon_starting': onRunStarting(d); break;
      case 'dungeon_started': onRunStarted(d.snapshot, d.runId); break;
      case 'dungeon_start_failed': onRunStartFailed(d); break;
      case 'dungeon_resumed': onRunResumed(d.snapshot, d.runId); break;
      case 'step': onWsStep(d.step, d.runId); break;
      case 'settled': onRunSettled(d); break;
      case 'run_waiting_ai': onRunWaitingAi(d); break;
      case 'run_error': onRunError(d); break;
      case 'error': toastMsg(d.error || '操作失败'); break;
    }
  }

  /* 顶栏加「退出登录」 */
  function addNavActions() {
    const fixedLogout = $('#online-logout');
    if (fixedLogout) { fixedLogout.hidden = false; return; }
    const hu = $('#nav-nick');
    if (!hu) return;
    const box = document.createElement('span');
    box.style.cssText = 'display:inline-flex;gap:8px;align-items:center';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = '退出';
    btn.onclick = logout;
    box.appendChild(btn);
    const parent = hu.parentElement;
    if (parent && !parent.querySelector('.ol-logout')) {
      box.classList.add('ol-logout');
      parent.appendChild(box);
    }
  }

  /* 在线匹配状态渲染：注入 .ol-matchbar 到小队页 event-header 之后
     参与者显示完整的角色名 + 修为境界（圆角标签排版，参考招募板成员卡） */
  function renderMatchState(d) {
    window.__olMatch = d;
    const el = $('#tab-party');
    if (!el) return;
    // 删除原单机版渲染出的旧匹配条（.match-status 且非 .ol-matchbar），避免与新联机条重复
    el.querySelectorAll('.match-status').forEach(n => { if (!n.classList.contains('ol-matchbar')) n.remove(); });
    const members = (d && d.members) || window.__olMatchMembers || [];
    // 服务端广播的是整个队列（含自己）；剔除自己避免重复显示
    const meName = window.D.my_adventurer ? window.D.my_adventurer.name : '你';
    const others = members.filter(m => m.name !== meName);
    others.forEach(member => { if (member && member.card) registerNpcCard(member.card); });
    window.__olMatchMembers = others;
    const me = window.D.my_adventurer;
    const mineTag = me ? { name: me.name, realm: me.character_class || '练气一层', isNpc: false } : { name: '你', realm: '', isNpc: false };
    const total = 4;
    const remainingSeconds = Math.ceil(Math.max(0, Number(d && d.remainingMs) || 0) / 1000);
    const countdown = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
    // 参与者列表：自己 + 队列中的其他（真）人
    const tags = [mineTag, ...others.slice(0, total - 1).map(m => ({ name: m.name, realm: m.realm || '练气一层', isNpc: !!m.isAI || !!m.isNpc, card: m.card }))].slice(0, total);
    const slots = tags.map((t, i) => `
      <span class="ol-match-tag ${i === 0 ? 'mine' : ''}" title="${esc(t.name)} · ${esc(t.realm)}" ${i > 0 && t.isNpc ? `style="cursor:pointer" onclick="openPartyMemberDetail('',${JSON.stringify(t.name)},'1','')"` : ''}>
        <span class="omt-name">${esc(t.name)}</span>
        <span class="omt-realm">${t.realm ? esc(t.realm) : '练气一层'}</span>
      </span>`).join('')
      + Array.from({ length: total - tags.length }, () => '<span class="ol-match-tag wait"><span class="omt-name">?</span></span>').join('');
    const old = el.querySelector('.ol-matchbar');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 'match-status ol-matchbar';
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px;flex-direction:column;align-items:stretch;';
    bar.innerHTML = `
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span class="match-pulse">⏳</span>
        <span>匹配中… 已集齐 <b>${tags.length} / ${total}</b> 人</span>
        <span class="ol-match-countdown" aria-label="匹配倒计时">剩余 <b>${countdown}</b></span>
        <span class="match-wait-hint" style="font-size:12px;color:var(--color-text-secondary)">等待道友加入（2 分钟未满则 AI 道友补位即开）</span>
        <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="cancelMatch()">取消匹配</button>
      </div>
      <div class="match-members" style="display:flex;gap:8px;flex-wrap:wrap">${slots}</div>`;
    const target = el.querySelector('.party-match-section') || el.querySelector('.event-header');
    if (target) target.appendChild(bar); else el.prepend(bar);
  }

  /* 覆盖 renderParty：复用本地 UI，匹配时注入在线状态条；探险中注入"我的小队"卡片 */
  const __renderPartyOrig = window.renderParty;  // 覆盖前捕获原函数
  function renderPartyOnline() {
    __renderPartyOrig();
    renderPublicPartyCards();
    if (window.matchQueue && window.matchQueue.online) {
      renderMatchState(window.__olMatch || { members: window.__olMatchMembers || [] });
    }
    // 探险中：重绘后重新注入"我的小队"卡片（renderParty 每次重绘会覆盖掉）
    if (activeWsRun) renderSquadCard();
    else if (startingRoom) renderStartingCard();
  }
  window.renderParty = renderPartyOnline;
  // 主页面的标签渲染器在 online.js 加载前已缓存原始 renderParty，切回小队页时同步替换为在线包装函数。
  if (window.renderers) window.renderers.party = renderPartyOnline;

  function renderPublicPartyCards() {
    const list = document.querySelector('#public-party-list');
    const count = document.querySelector('#public-party-count');
    if (!list) return;
    const uid = API.user && API.user.id;
    const rooms = Array.isArray(publicRooms) ? publicRooms : [];
    if (count) count.textContent = `${rooms.length} 支队伍`;
    const topCount = document.querySelector('#public-party-count-top');
    if (topCount) topCount.textContent = String(rooms.length);
    const myRoom = rooms.find(room => Array.isArray(room.party) && room.party.some(member => Number(member.uid) === Number(uid)));
    const myHost = document.querySelector('#my-party-card-host');
    if (myHost) myHost.innerHTML = myRoom
      ? partyRoomCardHTML(myRoom, { mine: true })
      : '<div class="my-party-placeholder">尚未进入副本或公开小队。选择地图后开始匹配，或创建一支公开队伍。</div>';
    if (!rooms.length) {
      list.innerHTML = '<div class="public-party-empty">暂无公开队伍，选择地图后创建第一支队伍。</div>';
      return;
    }
    list.innerHTML = rooms.map(room => partyRoomCardHTML(room)).join('');
  }

  function partyRoomCardHTML(room, options = {}) {
      const party = Array.isArray(room.party) ? room.party : [];
      const uid = API.user && API.user.id;
      const isHost = uid != null && Number(room.host) === Number(uid);
      const isMember = uid != null && party.some(member => Number(member.uid) === Number(uid));
      const leader = party.find(member => Number(member.uid) === Number(room.host)) || party[0] || {};
      const members = party.map(member => `<button type="button" class="public-party-member ${Number(member.uid) === Number(room.host) ? 'leader' : ''}" data-party-member data-char-id="${esc(member.charId || '')}" data-name="${esc(member.name || '')}" data-is-npc="${member.isNpc ? '1' : ''}" data-card="${member.isNpc && member.card ? esc(JSON.stringify(member.card)) : ''}" onclick="event.stopPropagation();openPartyMemberDetail(this.dataset.charId,this.dataset.name,this.dataset.isNpc,this.dataset.card)" title="查看角色详情">${Number(member.uid) === Number(room.host) ? '★ ' : ''}${esc(member.name || '未知道友')} <small>${esc(member.realm || '')}</small></button>`).join('');
      const actions = isHost
        ? `<button class="btn btn-success btn-sm" onclick="startPublicRoom('${esc(room.id)}')">开始探险</button><button class="btn btn-danger btn-sm" onclick="dissolvePublicRoom('${esc(room.id)}')">解散</button>`
        : isMember
          ? '<button class="btn btn-sm" onclick="leavePublicRoom()">离开队伍</button>'
          : `<button class="btn btn-primary btn-sm" onclick="joinPublicRoom('${esc(room.id)}')">加入队伍</button>`;
      const roomId = room.id || room.roomId || '未知';
      const stateLabel = room.status === 'running' ? '探险中' : '等人中';
      const levelLabel = room.level_desc || room.levelDesc || '推荐等级待定';
      const createdLabel = room.created_at ? fmtTimeFull(room.created_at) : '';
      return `<article class="public-party-card${options.mine ? ' is-mine' : ''}">
        <div class="public-party-main">
          <div class="public-party-head"><strong>公开小队 #${esc(roomId)}</strong><span class="public-party-state">🗡️ ${stateLabel}</span></div>
          <div class="public-party-map"><span>🗺️ ${esc(room.dungeon || '未知灵墟')}</span><b>${esc(levelLabel)}</b></div>
          <div class="public-party-meta"><span>👥 ${party.length} 人（4 人起成团，最多 6 人）</span><span>⌛ ${esc(createdLabel)} 创建</span></div>
          ${room.description ? `<p class="public-party-description">${esc(room.description)}</p>` : ''}
          <div class="public-party-members">${members}</div>
        </div>
        <div class="public-party-actions">${actions}</div>
      </article>`;
  }

  function openPartyMemberDetail(charId, name, isNpc, cardJSON) {
    if (isNpc || !charId) {
      let card = null;
      try { if (cardJSON) card = JSON.parse(cardJSON); } catch (_) { card = null; }
      card = card || findNpcCardByName(name);
      const view = card ? registerNpcCard(card) : null;
      if (view && window.openAdvDetail) { window.openAdvDetail(view.id); return; }
      showPartyMemberUnavailable(name);
      return;
    }
    const id = Number(charId);
    const adv = (window.D.adventurers || []).find(character =>
      (Number.isFinite(id) && Number(character._char_db_id || character.id) === id) || character.name === name
    );
    if (adv && window.openAdvDetail) { window.openAdvDetail(adv.id); return; }
    if (Number.isFinite(id)) {
      api('/api/public/characters/' + id).then(response => {
        if (!response.character) throw new Error('角色不存在');
        const detailCache = window.D.adventurerDetails || (window.D.adventurerDetails = new Map());
        const character = publicCharacterViewModel(response.character);
        detailCache.set(Number(character.id), character);
        if (window.openAdvDetail) window.openAdvDetail(character.id);
      }).catch(() => showPartyMemberUnavailable(name));
      return;
    }
    showPartyMemberUnavailable(name);
  }

  function showPartyMemberUnavailable(name) {
    const box = document.querySelector('#modal-box');
    if (!box) return;
    box.classList.remove('log-modal');
    box.innerHTML = `<button class="modal-close" onclick="closeModal()">✕</button><h3 class="modal-title">${esc(name || '未知道友')}</h3><div class="hall-hint">该角色的详细资料暂未同步，可稍后刷新后重试。</div>`;
    showModal();
  }
  window.openPartyMemberDetail = openPartyMemberDetail;

  /* ---------- 覆盖匹配 ---------- */
  function startMatchOnline() {
    const role = window.D.my_adventurer;
    if (!role) { toastMsg('请先创建角色'); switchTab('mine'); return; }
    if (role.status === 'insighting' || role.taixuInsight) { toastMsg('角色正在太虚幻境参悟'); return; }
    if (window.matchQueue) { toastMsg('已在匹配队列中'); return; }
    if (isInPublicRoom()) { toastMsg('已在公开队伍中'); return; }
    if (activeWsRun) { toastMsg('正在探险中'); return; }
    if ((role.stamina || 0) < 10) { toastMsg('精力不足（进入副本需 10 精力）'); return; }
    if (!role._char_db_id) { toastMsg('角色尚未与服务器同步'); return; }
    connectWs();
    // 立即入队（等 onopen 后发）
    const trySend = () => {
      if (wsReady) {
        wsSend({ type: 'match_start', token: API.token, charId: role._char_db_id, choice: matchDungeonChoice || null });
        window.matchQueue = { online: true, role, members: [{ name: role.name }], target: 4, npcs: [] };
        renderParty();
      } else setTimeout(trySend, 300);
    };
    trySend();
  }
  function cancelMatchOnline() {
    wsSend({ type: 'match_cancel' });
    window.matchQueue = null;
    const role = window.D.my_adventurer;
    renderParty();
  }

  /* ---------- 公开队伍 ---------- */
  function isInPublicRoom() {
    const uid = API.user && API.user.id;
    return uid != null && publicRooms.some(room => Array.isArray(room.party) && room.party.some(member => member.uid === uid));
  }

  function roomActionRole() {
    const role = window.D.my_adventurer;
    if (!role || !role._char_db_id) { toastMsg('请先选择已同步的角色'); return null; }
    if (!API.user || !API.token) { toastMsg('请先登录'); return null; }
    if (!wsReady) { connectWs(); toastMsg('正在连接服务器，请稍后重试'); return null; }
    return role;
  }

  function canEnterPublicRoom() {
    const role = window.D.my_adventurer;
    if (role && (role.status === 'insighting' || role.taixuInsight)) { toastMsg('角色正在太虚幻境参悟'); return false; }
    if (window.matchQueue) { toastMsg('已在匹配队列中'); return false; }
    if (activeWsRun) { toastMsg('正在探险中'); return false; }
    if (isInPublicRoom()) { toastMsg('已在公开队伍中'); return false; }
    return true;
  }

  function createPublicRoom() {
    const role = roomActionRole();
    if (!role || !canEnterPublicRoom()) return;
    const dungeon = matchDungeonChoice;
    if (!dungeon) { toastMsg('请先选择地图'); return; }
    const description = (document.querySelector('#public-party-description')?.value || '').trim();
    if (description.length > 100) { toastMsg('小队描述不能超过 100 字'); return; }
    wsSend({ type: 'room_create', token: API.token, charId: role._char_db_id, dungeon, description });
  }

  function joinPublicRoom(roomId) {
    const role = roomActionRole();
    if (!role || !canEnterPublicRoom()) return;
    if (!roomId) { toastMsg('队伍不存在'); return; }
    wsSend({ type: 'room_join', token: API.token, roomId, charId: role._char_db_id });
  }

  function leavePublicRoom() {
    if (!roomActionRole()) return;
    if (!isInPublicRoom()) { toastMsg('未加入公开队伍'); return; }
    wsSend({ type: 'room_leave', token: API.token });
  }

  function startPublicRoom(roomId) {
    if (!roomActionRole()) return;
    if (!isInPublicRoom() || !roomId) { toastMsg('队伍不存在'); return; }
    wsSend({ type: 'room_start', token: API.token, roomId });
  }

  function dissolvePublicRoom(roomId) {
    if (!roomActionRole()) return;
    if (!isInPublicRoom() || !roomId) { toastMsg('队伍不存在'); return; }
    wsSend({ type: 'room_dissolve', token: API.token, roomId });
  }

  /* ---------- 在线副本播放 ---------- */
  let squadCardEl = null;  // 小队页的"我的小队"探险中卡片
  function findActiveRun(runId) {
    const id = String(runId == null ? '' : runId);
    return (window.activeDungeons || []).find(run => String(run.id) === id || String(run.runId) === id) || null;
  }
  function viewerOwnsRun(snapshot) {
    const role = window.D && window.D.my_adventurer;
    const uid = API.user && API.user.id;
    const charId = role && role._char_db_id;
    return !!((snapshot && snapshot.dgParty || []).some(member =>
      (uid != null && member.uid != null && Number(member.uid) === Number(uid)) ||
      (charId != null && member.charId != null && Number(member.charId) === Number(charId))
    ));
  }
  function viewerOwnsResult(result) {
    const role = window.D && window.D.my_adventurer;
    const uid = API.user && API.user.id;
    return !!(result && !result.isNpc && (
      (uid != null && result.uid != null && Number(result.uid) === Number(uid)) ||
      (role && role._char_db_id != null && result.charId != null && Number(result.charId) === Number(role._char_db_id))
    ));
  }
  function viewerOwnsRoom(room) {
    const role = window.D && window.D.my_adventurer;
    const uid = API.user && API.user.id;
    const charId = role && role._char_db_id;
    return !!((room && room.party || []).some(member =>
      (uid != null && member.uid != null && Number(member.uid) === Number(uid)) ||
      (charId != null && member.charId != null && Number(member.charId) === Number(charId))
    ));
  }
  function renderSquadCard(_snapshot) {
    if (!activeWsRun) return;
    const el = $('#tab-party');
    if (!el) return;
    const snapshot = _snapshot || {};
    const dgParty = activeWsRun.party && activeWsRun.party.length ? activeWsRun.party.map(p => ({ name: p.name, hp: p.hp, max_hp: p.max_hp || 100, isNpc: !!p.isNpc, isMine: !!p.isMine })) : ((snapshot.dgParty || []).map(p => ({ name: p.name, hp: p.hp, max_hp: p.max_hp || 100, isNpc: !!p.isNpc, isMine: !!p.isMine })));
    const members = dgParty.length ? dgParty : (activeWsRun ? (activeWsRun.party || []) : []);
    const d = activeWsRun ? activeWsRun.dungeon : (snapshot.dungeon || {});
    const waiting = activeWsRun.status === 'waiting_ai';
    // 移除旧的探险中卡片（若存在）
    const old = el.querySelector('.ol-squad-card');
    if (old) old.remove();
    const card = document.createElement('div');
    card.className = 'ol-squad-card mine-card';
    card.style.cssText = 'border:1px solid var(--color-primary);border-radius:8px;padding:14px 16px;margin-top:0;background:color-mix(in srgb,var(--color-primary) 7%,var(--color-surface));cursor:pointer;transition:border-color .15s';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:800;font-size:15px">我的小队</span>
        <span class="tag-badge" style="color:var(--color-primary);border-color:var(--color-primary)">${waiting ? '🔁 等待 AI' : '⛏️ 探险中'}</span>
        <span class="sp" style="flex:1"></span>
        <span style="font-size:12px;color:var(--color-text-secondary)">${esc(activeWsRun ? activeWsRun.party.map(m=>m.name).join('、') : '')}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        <span>📍 ${esc(d.name || '')}</span>
        <span class="dungeon-lv">${esc(d.level_desc || '炼气')}</span>
        <span class="sp" style="flex:1"></span>
        <span style="font-size:12px;color:var(--color-primary);font-weight:700">${members.length} / 4 人</span>
      </div>
      <div class="ol-squad-members" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${members.map(m => `
        <span class="ol-squad-member" style="font-size:12px;padding:3px 10px;border:1px solid var(--color-border);border-radius:999px;background:var(--color-bg)">
          ${esc(m.name)}<em style="font-style:normal;color:${m.hp <= Math.floor((m.max_hp||1)*0.35) ? 'var(--color-danger)' : 'var(--color-text-secondary)'};margin-left:4px">HP ${m.hp}/${m.max_hp}</em>
        </span>`).join('')}</div>
      <div style="margin-top:8px;font-size:11.5px;color:var(--color-text-secondary)">${waiting ? 'AI 服务暂不可用，副本将自动恢复' : '点击查看本次冒险详情（AI 实时生成剧情）→'}</div>`;
    card.onclick = openRunModal;
    const target = el.querySelector('.my-party-section');
    const placeholder = target && target.querySelector('.my-party-placeholder');
    if (placeholder) placeholder.replaceWith(card);
    else if (target) target.appendChild(card);
    else el.prepend(card);
    squadCardEl = card;
  }
  function renderStartingCard() {
    if (!startingRoom) return;
    const el = $('#tab-party');
    if (!el) return;
    const room = startingRoom;
    const old = el.querySelector('.ol-starting-card');
    if (old) old.remove();
    const members = Array.isArray(room.party) ? room.party : [];
    const card = document.createElement('div');
    card.className = 'ol-squad-card mine-card ol-starting-card';
    card.style.cssText = 'border:1px solid var(--color-primary);border-radius:8px;padding:14px 16px;margin-top:0;background:color-mix(in srgb,var(--color-primary) 7%,var(--color-surface));';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:800;font-size:15px">我的小队</span>
        <span class="tag-badge" style="color:var(--color-primary);border-color:var(--color-primary)">开本中</span>
        <span class="sp" style="flex:1"></span>
        <span style="font-size:12px;color:var(--color-text-secondary)">${esc(members.map(m => m && m.name || '').filter(Boolean).join('、'))}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        <span>📍 ${esc(room.dungeon || '未知灵墟')}</span>
        <span class="sp" style="flex:1"></span>
        <span style="font-size:12px;color:var(--color-primary);font-weight:700">${members.length} / 4 人</span>
      </div>
      <div class="ol-squad-members" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${members.map(m => `<span class="ol-squad-member" style="font-size:12px;padding:3px 10px;border:1px solid var(--color-border);border-radius:999px;background:var(--color-bg)">${esc(m.name || '未知道友')}<em style="font-style:normal;color:var(--color-text-secondary);margin-left:4px">${esc(m.realm || '')}</em></span>`).join('')}</div>
      <div style="margin-top:8px;font-size:11.5px;color:var(--color-text-secondary)">AI 正在推演副本局势，即将进入冒险</div>`;
    const target = el.querySelector('.my-party-section');
    const placeholder = target && target.querySelector('.my-party-placeholder');
    if (placeholder) placeholder.replaceWith(card);
    else if (target) target.appendChild(card);
    else el.prepend(card);
  }
  function updateSquadCard() {
    if (!squadCardEl || !activeWsRun) return;
    const members = activeWsRun.party || [];
    const box = squadCardEl.querySelector('.ol-squad-members');
    if (box) box.innerHTML = members.map(m => `
      <span class="ol-squad-member" style="font-size:12px;padding:3px 10px;border:1px solid var(--color-border);border-radius:999px;background:var(--color-bg)">
        ${esc(m.name)}<em style="font-style:normal;color:${m.hp <= Math.floor((m.max_hp||1)*0.35) ? 'var(--color-danger)' : 'var(--color-text-secondary)'};margin-left:4px">HP ${m.hp}/${m.max_hp}</em>
      </span>`).join('');
  }
  function openRunModal() {
    if (!activeWsRun) return;
    // 用主脚本的 openLogModal 打开"进行中副本"详情弹窗（实时刷新）
    try { if (window.openLogModal) window.openLogModal('run' + activeWsRun.id); } catch (e) {}
  }
  function onRunStarted(snapshot, runId) {
    const D = window.D;
    startingRoom = null;
    if (!snapshot) return null;
    const stableId = snapshot.id || snapshot.runId || runId || ('ol' + Date.now());
    const existing = findActiveRun(stableId);
    if (existing) return existing;
    const mine = viewerOwnsRun(snapshot);
    const dgParty = (snapshot.dgParty || []).map(p => ({ uid: p.uid || null, charId: p.charId || null, name: p.name, hp: p.hp, max_hp: p.max_hp || 100, isNpc: !!p.isNpc, isMine: mine && !p.isNpc, card: p.card }));
    registerNpcCardsFromParty(snapshot.dgParty || []);
    const dg = {
      id: stableId, runId: stableId, isMineRun: mine,
      logNumber: Number(snapshot.logNumber) || null,
      dungeon: snapshot.dungeon, party: dgParty.length ? dgParty.map(p => ({ uid: p.uid, charId: p.charId, name: p.name, hp: p.hp, max_hp: p.max_hp, is_mine: p.isMine, isNpc: p.isNpc, card: p.card })) : (snapshot.party || []).map(p => ({ uid: p.uid || null, charId: p.charId || null, name: p.name, is_mine: mine && !p.isNpc, isNpc: !!p.isNpc, card: p.isNpc ? p.card : undefined })),
      steps: [], plan: (snapshot.planLabels || []).map((p, i) => ({ key: p.key, label: p.label })), planIdx: 0, stepIdx: 0, totalStep: 0,
      status: snapshot.status || 'running', startedAt: snapshot.startedAt || Date.now(), bossDrops: [], _char_db_id: mine && window.D.my_adventurer && window.D.my_adventurer._char_db_id,
    };
    window.activeDungeons = window.activeDungeons || [];
    window.activeDungeons.push(dg);
    if (mine) {
      activeWsRun = dg;
      window.matchQueue = null;  // 副本开始，清除匹配状态（移除匹配条）
      const role = D.my_adventurer;
      if (role) { role.stamina = Math.max(0, (role.stamina || 0) - 10); role.status = 'adventuring'; }
      toastMsg('⚔️ 队伍已集结，即将进入「' + dg.dungeon.name + '」');
      try { renderMine(); } catch (e) {}
    }
    try { renderParty(); } catch (e) {}
    try { renderLogs(); } catch (e) {}
    if (mine) renderSquadCard(snapshot);  // renderParty 会重绘小队页，须在它之后再插入卡片
    return dg;
  }
  function onRunStarting(d) {
    const room = d && d.room;
    if (!room || !viewerOwnsRoom(room)) return;
    if (activeWsRun) return;
    startingRoom = room;
    window.matchQueue = null;
    try { renderParty(); } catch (e) {}
  }
  function onRunStartFailed(d) {
    if (!startingRoom) return;
    if (d && d.roomId != null && String(d.roomId) !== String(startingRoom.id)) return;
    startingRoom = null;
    try { renderParty(); } catch (e) {}
  }
  function onRunResumed(snapshot, runId, status) {
    const dg = onRunStarted(snapshot, runId);
    if (!dg) return;
    if (snapshot.logNumber != null) dg.logNumber = Number(snapshot.logNumber) || dg.logNumber;
    const localSteps = Array.isArray(dg.steps) ? dg.steps : [];
    const incomingSteps = Array.isArray(snapshot.steps) ? snapshot.steps : [];
    const maxStepNo = steps => steps.reduce((max, item) => Math.max(max, Number(item && item.stepNo) || 0), 0);
    const incomingMax = maxStepNo(incomingSteps);
    const localMax = maxStepNo(localSteps);
    const prevStatus = dg.status;
    const prevStepCount = dg.steps.length;
    const prevTotal = dg.totalStep;
    if (incomingMax >= localMax) {
      dg.status = status || snapshot.status || dg.status;
      dg.startedAt = snapshot.startedAt || dg.startedAt;
      dg.steps = incomingSteps.slice();
      dg.totalStep = Math.max(Number(snapshot.totalStep) || 0, incomingSteps.length);
      if (incomingMax > localMax && Array.isArray(snapshot.dgParty) && snapshot.dgParty.length) {
        const byName = new Map(snapshot.dgParty.map(member => [member && member.name, member]));
        dg.party = (dg.party || []).map(member => {
          const remote = byName.get(member && member.name);
          if (!remote) return member;
          return {
            ...member,
            uid: remote.uid ?? member.uid,
            charId: remote.charId ?? member.charId,
            hp: remote.hp ?? member.hp,
            max_hp: remote.max_hp || member.max_hp,
            isNpc: !!remote.isNpc,
            card: remote.card || member.card,
          };
        });
      }
    }
    const changed = dg.status !== prevStatus || dg.steps.length !== prevStepCount || dg.totalStep !== prevTotal || incomingMax > localMax;
    if (changed) {
      if (dg.isMineRun) renderSquadCard(snapshot);
      renderLogs();
    }
  }
  function onWsStep(step, runId) {
    const run = findActiveRun(runId) || (runId == null ? activeWsRun : null);
    if (!run || !step) return;
    if (run.status !== 'running') {
      run.status = 'running';
      if (run === activeWsRun) { try { renderSquadCard(); } catch (e) {} }
    }
    const lastStepNo = run.steps.reduce((max, item) => Math.max(max, Number(item && item.stepNo) || 0), 0);
    if (Number.isFinite(Number(step.no)) && Number(step.no) <= lastStepNo) return;
    const st = {
      stage: step.stage, actor: step.actor, attr: '', roll: step.roll || 0, mod: step.mod || 0, total: step.total || 0,
      outcome: (step.success !== false ? 'good' : 'bad'), text: step.text || '', stepNo: step.no,
      enemy: step.enemy || '', realmB: step.realmB || 0, src: 'ai',
      itemUse: step.itemUse || null,
      skillUse: step.skillUse ? { name: step.skillUse.name, type: step.skillUse.type, tier: step.skillUse.tier, elemMod: step.skillUse.elemMod || 0, success: step.skillUse.success, roll: step.roll, total: step.total } : null,
    };
    run.steps.push(st);
    run.totalStep++;
    if (step.partyHp) { run.party = step.partyHp.map(h => ({ name: h.name, hp: h.hp, max_hp: h.max_hp, is_mine: run.party.find(x => x.name === h.name) ? run.party.find(x => x.name === h.name).is_mine : false, isNpc: !!(run.party.find(x => x.name === h.name)||{}).isNpc })); }
    // 实时更新小队页卡的成员 HP
    if (run === activeWsRun) { try { updateSquadCard(); } catch (e) {} }
    // 同步刷新日志列表中的“进行中”条目，但不主动打开日志弹窗。
    try { if (typeof window.renderLogs === 'function') window.renderLogs(); } catch (e) {}
    // 若正打开"进行中副本"详情弹窗，则实时刷新弹窗内容
    try {
      const mbox = $('#modal-box');
      if (mbox && mbox.innerText.includes('（进行中）') && typeof window.updateRunningLogDetail === 'function') window.updateRunningLogDetail(run);
    } catch (e) {}
  }
  function onRunWaitingAi(d) {
    const run = findActiveRun(d && d.runId) || activeWsRun;
    if (run) {
      const wasWaiting = run.status === 'waiting_ai';
      run.status = 'waiting_ai';
      if (run === activeWsRun) {
        if (!wasWaiting) toastMsg('AI 服务暂时不可用，副本已暂停并自动等待恢复');
        try { renderSquadCard(); } catch (e) {}
      }
    } else if (d && d.snapshot) {
      const resumed = onRunResumed(d.snapshot, d.runId, 'waiting_ai');
      if (resumed && resumed.isMineRun) {
        toastMsg('AI 服务暂时不可用，副本已暂停并自动等待恢复');
      }
    }
    try { renderParty(); renderLogs(); } catch (e) {}
  }
  function onRunError(d) {
    startingRoom = null;
    const run = findActiveRun(d && d.runId) || activeWsRun;
    if (run) {
      const index = (window.activeDungeons || []).indexOf(run);
      if (index >= 0) window.activeDungeons.splice(index, 1);
      if (run === activeWsRun) { activeWsRun = null; window.matchQueue = null; }
    }
    toastMsg('副本异常：' + ((d && d.error) || ''));
    try { renderParty(); renderLogs(); } catch (e) {}
    // 服务端会把已生成的前文写入失败日志，收到异常广播后立即拉取，避免列表继续显示旧状态。
    void fetchServerLogs();
  }
  async function onRunSettled(d) {
    const D = window.D;
    startingRoom = null;
    const run = findActiveRun(d && d.runId) || activeWsRun;
    const mineRun = run && run === activeWsRun && run.isMineRun;
    const runningRunId = mineRun ? run.id : null;
    if (run) run.status = 'finished';
    if (!mineRun) {
      if (run) {
        const index = (window.activeDungeons || []).indexOf(run);
        if (index >= 0) window.activeDungeons.splice(index, 1);
      }
      try { renderLogs(); } catch (e) {}
      return;
    }
    // 刷新服务端角色数据（经验/灵石/战利品已结算）
    await loadOnlineRoles();
    if (window.renderMine) renderMine();
    if (window.renderAdventurers) renderAdventurers();
    if (window.renderTavern) renderTavern();
    // 构建终局日志并展示（members 来自服务端广播，含完整结算信息）
    const my = D.my_adventurer;
    const results = d.results || [];
    const deathReasonByName = new Map((d.death_reasons || []).map(entry => [String(entry && entry.name || '').trim(), String(entry && entry.reason || '').trim().slice(0, 100)]));
    const members = results.map(r => ({
      name: r.name, is_mine: viewerOwnsResult(r), score: r.score != null ? r.score : 5,
      fate: r.fate || '健康', damage: r.damage || 0, gold: r.gold || 0,
      loot: r.lootItems && r.lootItems.length ? r.lootItems : (r.loot || []).map(n => ({ name: n, qty: 1 })),
      newTraits: r.newTraits || [], praise: 0, death_reason: r.fate === '阵亡' ? (deathReasonByName.get(r.name) || `角色「${r.name}」在探险中气血归零，道消身殒。`.slice(0, 100)) : '',
    }));
    // 日志编号：优先用服务端分配的本局日志 id（001 起递增）
    const myRes = (d.results || []).find(viewerOwnsResult);
    const logKeyValue = myRes && myRes.logId != null ? String(myRes.logId) : ('run:' + String(d.runId || (run && run.id) || Date.now()));
    const logId = myRes && myRes.logId != null ? myRes.logId : nextLogId();
    const logNumber = myRes && myRes.logNumber != null ? myRes.logNumber : (run && run.logNumber);
    const ownDied = !!(myRes && myRes.fate === '阵亡');
    const anyDeath = results.some(result => result.fate === '阵亡');
    const log = {
      id: logId, log_key: logKeyValue, log_number: logNumber != null ? Number(logNumber) : undefined, run_id: d.runId || (run && run.id) || '', party_name: '匹配小队 (在线)', dungeon_name: d.dungeon || '',
      status: ownDied ? 'failed' : (d.ok ? 'completed' : 'failed'), result_summary: (d.summary || ''), created_at: new Date().toISOString(),
      death: anyDeath, summary_text: d.summary || '', death_summary: d.death_summary || '', special_event_theme: '',
      verdict_reason: ownDied ? '角色气血归零，道消身殒' : (d.verdict === 'breakthrough_ok' ? '突破试炼成功，踏入筑基前期' : (d.verdict === 'breakthrough_fail' ? '突破试炼失败' : '')),
      dg_snapshot: { icon: run ? run.dungeon.icon : '⚔️', name: d.dungeon || '', steps: run ? run.steps : [], party: (run ? run.party : []).map(x => ({ name: x.name, is_mine: !!x.is_mine })) },
      settlement: {
        exp: d.exp || 0,
        items: (d.results || []).flatMap(r => r.lootItems || []),
        damage: run ? run.steps.reduce((a, s) => a + 0, 0) : 0,
        members,
        consumed: d.consumed || [],
        returned: d.returned || [],
      },
    };
    const mine = (d.results || []).find(viewerOwnsResult);
    if (mine) {
      if (mine.fate === '阵亡') {
        if (typeof window.showDeathDialog === 'function') {
          window.showDeathDialog(mine.name || (my && my.name) || '角色', d.dungeon || '灵墟', logKey(log), log.death_summary);
        }
      } else {
        toastMsg(d.ok ? ('✨ 探险胜利！获得经验 +' + (mine.exp || d.exp || 0)) : '💔 探险受挫，望道友莫灰心');
        if (d.verdict === 'breakthrough_ok') toastMsg('⚡ 突破筑基前期！');
      }
    }
    // 最近动态：每项战利品单独记录，名称在左、来源作为小字显示。
    try {
      const myGold = mine ? (mine.gold || 0) : 0;
      const loot = mine && mine.lootItems || [];
      if (typeof window.addFeedItem === 'function') {
        loot.forEach(it => window.addFeedItem('⚔️', it.name || '未知道具', `探险获得 · ${d.dungeon || '灵墟'}`, `+${it.qty || 1}`, it.rarity || ''));
        if (myGold > 0) window.addFeedItem('💰', '灵石', `探险结算收益 · ${d.dungeon || '灵墟'}`, `+${myGold}.00`, '#ffc107');
        if (d.verdict === 'breakthrough_ok') window.addFeedItem('⚡', '突破成功', `探险结算 · ${d.dungeon || '灵墟'}`, '筑基前期', '#f0883e');
      }
      if (typeof window.saveFeed === 'function') window.saveFeed();
    } catch (e) { /* 动态失败不影响结算 */ }
    // 仅保存结算日志，不强制打断用户当前界面；用户可从“探险日志”主动打开详情。
    D.logs = [log, ...(D.logs || []).filter(existing => logKey(existing) !== logKey(log))];
    if (window.logDetailCache) window.logDetailCache.set(logKey(log), log);
    if (typeof logViewId !== 'undefined') logViewId = null;
    if (runningRunId && typeof window.completeRunningLogModal === 'function') {
      window.completeRunningLogModal(runningRunId, logKey(log));
    }
    if (run) { const i = (window.activeDungeons || []).indexOf(run); if (i >= 0) window.activeDungeons.splice(i, 1); }
    activeWsRun = null;
    window.matchQueue = null;
    // 移除小队页的"探险中"卡片
    if (squadCardEl) { try { squadCardEl.remove(); } catch (e) {} squadCardEl = null; }
    const pc = $('#tab-party .ol-squad-card');
    if (pc) { try { pc.remove(); } catch (e) {} }
    try { renderParty(); } catch (e) {}
    renderLogs();
    window.dispatchEvent(new CustomEvent('ol-settled'));
  }

  /* ============================================================
     启动
     ============================================================ */
  (async function init() {
    const D = window.D;
    const TA = window.TAVERN_DATA;

    // 1. 检查 URL 中的网关 token（优先）
    const urlParams = new URLSearchParams(window.location.search);
    const gatewayToken = urlParams.get('auth_token');

    if (gatewayToken) {
      console.log('[auth] 检测到网关 token，正在验证...');
      try {
        const resp = await fetch('/api/auth/verify-gateway-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: gatewayToken })
        });

        if (!resp.ok) {
          const errData = await resp.json();
          throw new Error(errData.error || '网关 token 验证失败');
        }

        const data = await resp.json();
        API.token = data.token;
        localStorage.setItem(TOKEN_KEY, data.token);
        console.log('[auth] 网关 token 验证成功，已登录:', data.user.username);

        // 清除 URL 中的 auth_token 参数（避免刷新时重复验证）
        urlParams.delete('auth_token');
        const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, '', newUrl);
      } catch (error) {
        console.error('[auth] 网关 token 验证失败:', error.message);
        // 验证失败，清除 URL 参数并继续正常登录流程
        urlParams.delete('auth_token');
        const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, '', newUrl);
      }
    }

    // 2. 正常登录流程
    // 顶栏用户名
    // 无 token 或 token 失效 → 弹登录
    if (!API.token) { showAuthLayer(); return; }
    try {
      await afterLogin();
      addNavActions();
    } catch (e) {
      // 登录失效
      localStorage.removeItem(TOKEN_KEY);
      API.token = '';
      showAuthLayer();
    }
    connectWs();  // 常驻 WS（匹配/副本实时）
  })();

  /* ---------- 覆盖到 window（后加载生效） ---------- */
  window.loadRole = function onlineLoadRole() { /* 由 afterLogin 异步加载，无需同步占位 */ };
  window.saveRole = saveRoleOnline;
  window.onlineCharacterAction = onlineCharacterAction;
  window.buyLibraryBookOnline = code => onlineCharacterAction('library_buy', { code });
  window.createRole = createRoleOnline;
  window.deleteRole = async function deleteRoleOnline() {
    const role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id) return;
    if (!confirm('确定删除当前角色，重新开始创建？')) return;
    try {
      await api('/api/character/' + role._char_db_id + '/delete', { method: 'POST' });
      localStorage.removeItem('xiuxian_role');
      window.D.adventurers = (window.D.adventurers || []).filter(a => Number(a._char_db_id || a.id) !== Number(role._char_db_id));
      window.D.my_adventurer = null;
      await loadOnlineRoles();
      renderMine();
      renderAdventurers();
      toastMsg('角色已删除，可以重新创建');
    } catch (e) { toastMsg(e.message || '删除角色失败'); }
  };
  window.startMatch = startMatchOnline;
  window.cancelMatch = cancelMatchOnline;
  window.publicRooms = publicRooms;
  window.createPublicRoom = createPublicRoom;
  window.joinPublicRoom = joinPublicRoom;
  window.leavePublicRoom = leavePublicRoom;
  window.startPublicRoom = startPublicRoom;
  window.dissolvePublicRoom = dissolvePublicRoom;
  window.spiritPlatformAction = async function spiritPlatformAction(action, payload = {}) {
    const role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id) { toastMsg('请先创建角色'); return; }
    if (role.status === 'insighting' || role.taixuInsight) { toastMsg('角色正在太虚幻境参悟'); return; }
    try {
      const result = await api('/api/character/' + role._char_db_id + '/' + action, {
        method: 'POST', body: { updated_at: role._char_updated_at, ...payload },
      });
      Object.assign(role, result.character, { _char_db_id: role._char_db_id, _char_updated_at: result.updated_at, is_mine: true });
      const match = (window.D.adventurers || []).find(a => a._char_db_id === role._char_db_id);
      if (match && match !== role) Object.assign(match, role);
      if (window.renderMine) renderMine();
      if (window.renderAdventurers) renderAdventurers();
      if (window.renderParty) renderParty();
      if (window.renderBuilding) renderBuilding();
      if (window.renderSpiritPlatformModal) renderSpiritPlatformModal();
      const messages = { cultivation_started: '已开始闭关修炼', cultivation_exited: '已提前出关', breakthrough_started: '已开始闭关突破' };
      toastMsg(messages[result.event && result.event.type] || '操作成功');
    } catch (e) { toastMsg(e.message || '操作失败'); }
  };
  window.taixuInsight = async function taixuInsight(type, goal) {
    let role = window.D && window.D.my_adventurer;
    if (!role || !role._char_db_id) throw new Error('请先创建角色');
    taixuInsightInFlight = true;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    let result = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      role = window.D && window.D.my_adventurer;
      if (!role || !role._char_db_id) throw new Error('请先创建角色');
      try {
        const accepted = await api('/api/character/' + role._char_db_id + '/taixu-insight', {
          method: 'POST',
          body: { type, goal, updated_at: role._char_updated_at },
        });
        if (!accepted.jobId) throw new Error('太虚幻境未创建参悟任务');
        if (accepted.character) {
          Object.assign(role, accepted.character, { _char_db_id: role._char_db_id, _char_updated_at: accepted.updated_at, is_mine: true });
          if (window.renderMine) renderMine();
          if (window.renderBuilding) renderBuilding();
          if (window.renderTaixuInsightProgress) renderTaixuInsightProgress();
        }
        for (let poll = 0; poll < 800; poll++) {
          await new Promise(resolve => setTimeout(resolve, poll === 0 ? 1000 : 5000));
          const status = await api('/api/character/' + role._char_db_id + '/taixu-insight/' + encodeURIComponent(accepted.jobId));
          if (status.status === 'completed') { result = status; break; }
          if (status.status === 'failed') throw new Error(status.error || '太虚幻境参悟失败');
        }
        if (!result) throw new Error('太虚幻境参悟等待超时，请稍后查看角色状态');
        break;
      } catch (error) {
        if (attempt !== 0 || !String(error && error.message || '').includes('角色数据已更新')) {
          taixuInsightInFlight = false;
          throw error;
        }
        await refreshOnlineRoles();
      }
    }
    taixuInsightInFlight = false;
    Object.assign(role, result.character, {
      _char_db_id: role._char_db_id,
      _char_updated_at: result.updated_at,
      is_mine: true,
    });
    const match = (window.D.adventurers || []).find(a => Number(a._char_db_id || a.id) === Number(role._char_db_id));
    if (match && match !== role) Object.assign(match, role);
    try { localStorage.setItem(ROLE_CACHE_KEY, JSON.stringify(role)); } catch (_) {}
    if (window.renderMine) renderMine();
    if (window.renderAdventurers) renderAdventurers();
    if (window.renderBuilding) renderBuilding();
    return result;
  };
  window.matchTick = function matchTickOnline() { /* 服务端驱动，本地不再 tick */ };
  window.restoreRuns = function restoreRunsOnline() { /* 在线无本地恢复 */ };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && API.token) void syncActiveExpeditions();
  });

  /* ---------- 探险日志与服务器同步：先渲染本地数据，再后台单次拉取 ---------- */
  const __renderLogsOrig = window.renderLogs;
  let _logSyncTimer = null, _logSyncPromise = null, _lastLogSync = 0;
  const LOG_SYNC_MIN_MS = 3000;
  const isLogListView = () => typeof logViewId === 'undefined' || logViewId === null;
  const logsSignature = logs => (logs || []).map(l => [
    logKey(l),
    l.status || '',
    l.created_at || '',
    (l.party_name || '').slice(0, 40),
    (l.dungeon_name || '').slice(0, 40),
    String(l.summary_text || '').slice(0, 40),
    String(l.result_summary || '').slice(0, 40),
    l.dg_snapshot && Array.isArray(l.dg_snapshot.steps) ? l.dg_snapshot.steps.length : 0
  ].join('|')).join('\n');
  function renderLogList() {
    __renderLogsOrig();
    // 有进行中副本时，移除主脚本可能显示的空提示文字（"暂无/没有匹配的探险日志"）
    if ((window.activeDungeons || []).length) {
      const empty = $('#tab-logs .empty');
      if (empty) empty.remove();
    }
  }
  async function fetchServerLogs() {
    if (!API.token) return false;
    if (_logSyncPromise) return _logSyncPromise;
    const prevSignature = logsSignature(window.D.logs);
    _logSyncPromise = (async () => {
      try {
        const lj = await api('/api/public/logs');
        if (!lj.logs) return false;
        const changed = logsSignature(lj.logs) !== prevSignature;
        window.D.logs = lj.logs;
        if (changed && isLogListView()) renderLogList();
        return changed;
      } catch (e) {
        return false;
      }
    })();
    try {
      return await _logSyncPromise;
    } finally {
      _logSyncPromise = null;
    }
  }
  const _logDetailFetches = new Map();
  window.loadExpeditionLogDetail = function loadExpeditionLogDetail(id) {
    const key = String(id);
    const inFlight = _logDetailFetches.get(key);
    if (inFlight) return inFlight;
    const request = api('/api/public/logs/' + encodeURIComponent(key))
      .then(j => {
        const log = j && j.log;
        if (!log) throw new Error('日志不存在');
        if (window.logDetailCache) window.logDetailCache.set(key, log);
        if (typeof window.refreshLogUI === 'function') window.refreshLogUI();
        return log;
      })
      .catch(e => {
        try { if (typeof window.toastMsg === 'function') window.toastMsg('加载日志详情失败：' + (e.message || '')); } catch (_) {}
        return null;
      })
      .finally(() => {
        _logDetailFetches.delete(key);
      });
    _logDetailFetches.set(key, request);
    return request;
  };
  function scheduleLogsSync(delay = 200) {
    if (delay === 0) {
      if (_logSyncTimer) {
        clearTimeout(_logSyncTimer);
        _logSyncTimer = null;
      }
      _lastLogSync = Date.now();
      _logSyncTimer = setTimeout(async () => {
        _logSyncTimer = null;
        await fetchServerLogs();
      }, 0);
      return;
    }
    if (_logSyncTimer) return;
    const now = Date.now();
    if (now - _lastLogSync < LOG_SYNC_MIN_MS) return;
    _lastLogSync = now;
    _logSyncTimer = setTimeout(async () => {
      _logSyncTimer = null;
      await fetchServerLogs();
    }, delay);
  }
  function renderLogsSynced() {
    renderLogList();
    if (isLogListView()) scheduleLogsSync(200);
  }
  window.renderLogs = renderLogsSynced;
  // 结算后 1.5 秒同步一次（服务端刚写入）
  window.addEventListener('ol-settled', () => {
    setTimeout(async () => {
      await fetchServerLogs();
    }, 1500);
  });

  window.addEventListener('pagehide', () => { if (window.pageClosing !== undefined) window.pageClosing = true; });
})();
