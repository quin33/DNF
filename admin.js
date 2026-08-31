(() => {
  'use strict';

  const TOKEN_KEY = 'tavern_admin_token';
  const TEXT_FIELDS = ['name', 'character_class'];
  const NUMBER_FIELDS = [
    'level', 'exp', 'gold', 'hp', 'max_hp', 'stamina', 'max_stamina',
    'strength', 'agility', 'intelligence', 'luck',
  ];
  const ARRAY_FIELDS = ['traits', 'equipment', 'bag', 'skills', 'skillPool'];
  const FIELD_LABELS = {
    name: '角色名',
    character_class: '境界 / 职业',
    level: '等级',
    exp: '经验',
    gold: '灵石',
    hp: '当前气血',
    max_hp: '气血上限',
    stamina: '当前精力',
    max_stamina: '精力上限',
    strength: '力量',
    agility: '敏捷',
    intelligence: '悟性',
    luck: '机缘',
    traits: '特质',
    equipment: '随身法宝',
    bag: '储物袋',
    skills: '已学功法',
    skillPool: '功法池',
  };
  const COMPANION_TEXT_FIELDS = ['name', 'title', 'gender', 'personality', 'character_class', 'title_frame'];
  const COMPANION_NUMBER_FIELDS = [
    'level', 'exp', 'gold', 'hp', 'max_hp', 'stamina', 'max_stamina',
    'strength', 'agility', 'intelligence', 'luck',
  ];
  const COMPANION_ARRAY_FIELDS = ['traits', 'equipment', 'bag', 'skills', 'skillPool'];
  const COMPANION_JSON_FIELDS = ['traitDescs'];
  const COMPANION_LONG_TEXT_FIELDS = ['bio', 'status'];
  const COMPANION_FIELD_LABELS = {
    ...FIELD_LABELS,
    title: '称号',
    gender: '性别',
    personality: '性格',
    title_frame: '卡框变体',
    status: '状态',
    bio: '人物小传',
    traitDescs: '特质描述',
  };

  const elements = {
    loginView: document.querySelector('#admin-login'),
    loginForm: document.querySelector('#login-form'),
    password: document.querySelector('#admin-password'),
    loginButton: document.querySelector('#login-button'),
    loginError: document.querySelector('#login-error'),
    console: document.querySelector('#admin-console'),
    sessionActions: document.querySelector('#session-actions'),
    logout: document.querySelector('#logout-button'),
    searchForm: document.querySelector('#search-form'),
    search: document.querySelector('#player-search'),
    searchButton: document.querySelector('#search-button'),
    playerResults: document.querySelector('#player-results'),
    playerListState: document.querySelector('#player-list-state'),
    resultCount: document.querySelector('#result-count'),
    workspaceTitle: document.querySelector('#workspace-title'),
    workspaceOwner: document.querySelector('#workspace-owner'),
    versionLabel: document.querySelector('#version-label'),
    statusMessage: document.querySelector('#status-message'),
    statusText: document.querySelector('#status-text'),
    reload: document.querySelector('#reload-character'),
    editorState: document.querySelector('#editor-state'),
    editor: document.querySelector('#character-editor'),
    dirtyState: document.querySelector('#dirty-state'),
    saveButton: document.querySelector('#save-character'),
    deleteButton: document.querySelector('#delete-character'),
    auditSection: document.querySelector('#audit-section'),
    auditList: document.querySelector('#audit-list'),
    refreshAudit: document.querySelector('#refresh-audit'),
    saveDialog: document.querySelector('#save-dialog'),
    changeSummary: document.querySelector('#change-summary'),
    confirmSave: document.querySelector('#confirm-save'),
    modePlayers: document.querySelector('#mode-players'),
    modeCompanions: document.querySelector('#mode-companions'),
    playersNavigator: document.querySelector('#players-navigator'),
    companionsNavigator: document.querySelector('#companions-navigator'),
    playersWorkspace: document.querySelector('#players-workspace'),
    companionsWorkspace: document.querySelector('#companions-workspace'),
    companionResults: document.querySelector('#companion-results'),
    companionCount: document.querySelector('#companion-count'),
    companionListState: document.querySelector('#companion-list-state'),
    companionTitle: document.querySelector('#companion-title'),
    companionSubtitle: document.querySelector('#companion-subtitle'),
    companionVersion: document.querySelector('#companion-version'),
    companionStatus: document.querySelector('#companion-status'),
    companionStatusText: document.querySelector('#companion-status-text'),
    companionEditorState: document.querySelector('#companion-editor-state'),
    companionEditor: document.querySelector('#companion-editor'),
    companionDirty: document.querySelector('#companion-dirty'),
    companionSave: document.querySelector('#save-companion'),
    companionReset: document.querySelector('#reset-companion'),
  };

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    selectedId: null,
    character: null,
    pendingCharacter: null,
    pendingCompanion: null,
    searchSequence: 0,
    adminMode: 'players',
    companions: [],
    selectedCompanionKey: null,
    companion: null,
  };

  class RequestError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  function setAuthenticated(authenticated) {
    elements.loginView.hidden = authenticated;
    elements.console.hidden = !authenticated;
    elements.sessionActions.hidden = !authenticated;
    if (!authenticated) {
      state.selectedId = null;
      state.character = null;
      state.pendingCharacter = null;
      state.companions = [];
      state.selectedCompanionKey = null;
      state.companion = null;
      elements.editor.hidden = true;
      elements.auditSection.hidden = true;
      elements.companionEditor.hidden = true;
      elements.companionEditorState.hidden = false;
      elements.statusMessage.hidden = true;
      elements.companionStatus.hidden = true;
      elements.password.value = '';
    }
  }

  function switchAdminMode(mode) {
    state.adminMode = mode === 'companions' ? 'companions' : 'players';
    const companions = state.adminMode === 'companions';
    elements.modePlayers.classList.toggle('is-active', !companions);
    elements.modeCompanions.classList.toggle('is-active', companions);
    elements.playersNavigator.hidden = companions;
    elements.playersWorkspace.hidden = companions;
    elements.companionsNavigator.hidden = !companions;
    elements.companionsWorkspace.hidden = !companions;
    if (companions && !state.companions.length) loadCompanions();
  }

  function clearToken(message) {
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthenticated(false);
    if (message) {
      elements.loginError.textContent = message;
      elements.loginError.hidden = false;
    }
    elements.password.focus();
  }

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch {
      throw new RequestError('无法连接服务器，请检查网络后重试。', 0);
    }

    let payload = null;
    const text = await response.text();
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = null; }
    }

    if (response.status === 401) {
      clearToken('管理员会话已失效，请重新登录。');
      throw new RequestError('管理员会话已失效', 401);
    }
    if (!response.ok) {
      throw new RequestError(payload && payload.error ? payload.error : `请求失败（${response.status}）`, response.status);
    }
    return payload;
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.label;
  }

  function showStatus(message, type = 'success', reload = false) {
    elements.statusText.textContent = message;
    elements.statusMessage.className = `status-message${type === 'error' ? ' is-error' : ''}${type === 'conflict' ? ' is-conflict' : ''}`;
    elements.reload.hidden = !reload;
    elements.statusMessage.hidden = false;
  }

  function hideStatus() {
    elements.statusMessage.hidden = true;
    elements.reload.hidden = true;
  }

  function formatValue(value, arrayField) {
    if (arrayField) return `${Array.isArray(value) ? value.length : 0} 项`;
    if (value === '' || value === null || value === undefined) return '空';
    return String(value);
  }

  function changedFields(before, after) {
    return [...TEXT_FIELDS, ...NUMBER_FIELDS, ...ARRAY_FIELDS].filter(field => (
      JSON.stringify(before[field]) !== JSON.stringify(after[field])
    ));
  }

  function collectCharacter() {
    const next = {};
    TEXT_FIELDS.forEach(field => {
      const value = elements.editor.elements[field].value.trim();
      if (!value) throw new Error(`${FIELD_LABELS[field]}不能为空`);
      next[field] = value;
    });

    NUMBER_FIELDS.forEach(field => {
      const raw = elements.editor.elements[field].value.trim();
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < 0) {
        throw new Error(`${FIELD_LABELS[field]}必须是非负有限数字`);
      }
      next[field] = value;
    });

    if (next.hp > next.max_hp) throw new Error('当前气血不能超过气血上限');
    if (next.stamina > next.max_stamina) throw new Error('当前精力不能超过精力上限');

    ARRAY_FIELDS.forEach(field => {
      const raw = elements.editor.elements[field].value.trim();
      let value;
      try { value = JSON.parse(raw); }
      catch { throw new Error(`${FIELD_LABELS[field]}不是有效的 JSON`); }
      if (!Array.isArray(value)) throw new Error(`${FIELD_LABELS[field]}必须是 JSON 数组`);
      next[field] = value;
    });
    return next;
  }

  function updateDirtyState() {
    if (!state.character) return;
    try {
      const next = collectCharacter();
      const count = changedFields(state.character.data, next).length;
      elements.dirtyState.textContent = count ? `${count} 个字段已修改` : '尚无待保存变更';
    } catch {
      elements.dirtyState.textContent = '表单包含待修正内容';
    }
  }

  function fillEditor(character) {
    const data = character.data;
    TEXT_FIELDS.forEach(field => { elements.editor.elements[field].value = data[field] ?? ''; });
    NUMBER_FIELDS.forEach(field => { elements.editor.elements[field].value = data[field] ?? 0; });
    ARRAY_FIELDS.forEach(field => {
      elements.editor.elements[field].value = JSON.stringify(Array.isArray(data[field]) ? data[field] : [], null, 2);
    });

    elements.workspaceTitle.textContent = data.name || character.name || `角色 #${character.id}`;
    elements.workspaceOwner.textContent = `玩家 ${character.username} · 角色编号 ${character.id}`;
    elements.versionLabel.textContent = `版本 ${character.updated_at}`;
    elements.versionLabel.hidden = false;
    elements.editor.hidden = false;
    elements.editorState.hidden = true;
    elements.auditSection.hidden = false;
    elements.dirtyState.textContent = '尚无待保存变更';
  }

  function renderPlayerResults(players) {
    elements.playerResults.replaceChildren();
    elements.resultCount.textContent = String(players.length);
    elements.playerListState.textContent = players.length ? `找到 ${players.length} 个角色` : '没有找到匹配的玩家或角色。';

    players.forEach(player => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-result';
      button.dataset.characterId = String(player.characterId);
      button.setAttribute('aria-current', String(player.characterId === state.selectedId));

      const names = document.createElement('span');
      const characterName = document.createElement('strong');
      characterName.textContent = player.characterName;
      const username = document.createElement('small');
      username.textContent = player.username;
      names.append(characterName, username);

      const id = document.createElement('code');
      id.textContent = `#${player.characterId}`;
      button.append(names, id);
      button.addEventListener('click', () => loadCharacter(player.characterId));
      elements.playerResults.append(button);
    });
  }

  async function searchPlayers() {
    const sequence = ++state.searchSequence;
    setButtonBusy(elements.searchButton, true, '搜索中');
    elements.playerListState.textContent = '正在读取玩家列表…';
    try {
      const payload = await request(`/api/admin/players?q=${encodeURIComponent(elements.search.value.trim())}`);
      if (sequence !== state.searchSequence) return;
      renderPlayerResults(Array.isArray(payload.players) ? payload.players : []);
    } catch (error) {
      if (error.status !== 401 && sequence === state.searchSequence) {
        elements.playerListState.textContent = error.message;
        elements.playerResults.replaceChildren();
        elements.resultCount.textContent = '0';
      }
    } finally {
      if (sequence === state.searchSequence) setButtonBusy(elements.searchButton, false, '搜索中');
    }
  }

  function auditSummary(entry) {
    const fields = Object.keys({ ...(entry.before || {}), ...(entry.after || {}) }).filter(field => (
      JSON.stringify(entry.before && entry.before[field]) !== JSON.stringify(entry.after && entry.after[field])
    ));
    if (!fields.length) return '记录已保存，未检测到字段差异。';
    return fields.map(field => FIELD_LABELS[field] || field).join('、');
  }

  function renderAudit(logs) {
    elements.auditList.replaceChildren();
    if (!logs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-list';
      empty.textContent = '暂无管理修改记录。';
      elements.auditList.append(empty);
      return;
    }

    logs.forEach(log => {
      const entry = document.createElement('article');
      entry.className = 'audit-entry';
      const time = document.createElement('time');
      time.dateTime = new Date(log.created_at).toISOString();
      time.textContent = new Date(log.created_at).toLocaleString('zh-CN', { hour12: false });
      const detail = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `修改记录 #${log.id}`;
      const summary = document.createElement('p');
      summary.textContent = `变更字段：${auditSummary(log)}`;
      detail.append(title, summary);
      entry.append(time, detail);
      elements.auditList.append(entry);
    });
  }

  async function loadAudit() {
    if (!state.selectedId) return;
    elements.auditList.innerHTML = '<p class="empty-list">正在读取审计记录…</p>';
    try {
      const payload = await request(`/api/admin/audit?characterId=${encodeURIComponent(state.selectedId)}`);
      renderAudit(Array.isArray(payload.logs) ? payload.logs : []);
    } catch (error) {
      if (error.status !== 401) {
        elements.auditList.innerHTML = '';
        const message = document.createElement('p');
        message.className = 'empty-list error-text';
        message.textContent = error.message;
        elements.auditList.append(message);
      }
    }
  }

  async function loadCharacter(characterId) {
    state.selectedId = Number(characterId);
    state.character = null;
    hideStatus();
    elements.editor.hidden = true;
    elements.auditSection.hidden = true;
    elements.editorState.hidden = false;
    elements.editorState.querySelector('strong').textContent = '正在读取角色档案';
    elements.editorState.querySelector('p').textContent = '正在同步角色数据与版本信息。';
    document.querySelectorAll('.player-result').forEach(button => {
      button.setAttribute('aria-current', String(Number(button.dataset.characterId) === state.selectedId));
    });

    try {
      const payload = await request(`/api/admin/characters/${encodeURIComponent(state.selectedId)}`);
      state.character = payload.character;
      fillEditor(payload.character);
      await loadAudit();
    } catch (error) {
      if (error.status !== 401) {
        elements.editorState.querySelector('strong').textContent = '无法打开角色档案';
        elements.editorState.querySelector('p').textContent = error.message;
        showStatus(error.message, 'error');
      }
    }
  }

  function showChangePreview(next) {
    const fields = changedFields(state.character.data, next);
    if (!fields.length) {
      showStatus('没有检测到需要保存的变更。');
      return;
    }

    state.pendingCharacter = next;
    elements.changeSummary.replaceChildren();
    fields.forEach(field => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = FIELD_LABELS[field] || field;
      const detail = document.createElement('span');
      const isArray = ARRAY_FIELDS.includes(field);
      detail.textContent = `${formatValue(state.character.data[field], isArray)} → ${formatValue(next[field], isArray)}`;
      item.append(title, detail);
      elements.changeSummary.append(item);
    });
    elements.saveDialog.showModal();
  }

  async function saveCharacter() {
    if (!state.character || !state.pendingCharacter) return;
    setButtonBusy(elements.confirmSave, true, '保存中');
    try {
      await request(`/api/admin/characters/${encodeURIComponent(state.character.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          updated_at: state.character.updated_at,
          character: state.pendingCharacter,
        }),
      });
      elements.saveDialog.close();
      state.pendingCharacter = null;
      await loadCharacter(state.selectedId);
      await searchPlayers();
      showStatus('角色档案已保存，审计记录已刷新。');
    } catch (error) {
      if (error.status === 409) {
        elements.saveDialog.close();
        state.pendingCharacter = null;
        showStatus('角色已被其他操作更新。当前编辑内容仍保留，请重新加载后核对。', 'conflict', true);
      } else if (error.status !== 401) {
        showStatus(error.message, 'error');
      }
    } finally {
      setButtonBusy(elements.confirmSave, false, '保存中');
    }
  }

  async function deleteCharacter() {
    if (!state.character || !confirm(`确定删除角色“${state.character.name}”吗？此操作不可恢复。`)) return;
    setButtonBusy(elements.deleteButton, true, '删除中');
    try {
      await request(`/api/admin/characters/${encodeURIComponent(state.character.id)}/delete`, { method: 'POST', body: JSON.stringify({}) });
      state.selectedId = null;
      state.character = null;
      elements.editor.hidden = true;
      elements.auditSection.hidden = true;
      elements.editorState.hidden = false;
      elements.editorState.querySelector('strong').textContent = '请选择角色';
      elements.editorState.querySelector('p').textContent = '角色已删除。';
      await searchPlayers();
      showStatus('角色已删除');
    } catch (error) {
      if (error.status !== 401) showStatus(error.message, 'error');
    } finally {
      setButtonBusy(elements.deleteButton, false, '删除角色');
    }
  }

  /* ---------- AI 队友名片 ---------- */
  function showCompanionStatus(message, type = 'success') {
    elements.companionStatusText.textContent = message;
    elements.companionStatus.className = `status-message${type === 'error' ? ' is-error' : ''}${type === 'conflict' ? ' is-conflict' : ''}`;
    elements.companionStatus.hidden = false;
  }

  function companionChangedFields(before, after) {
    return [...COMPANION_TEXT_FIELDS, ...COMPANION_NUMBER_FIELDS, ...COMPANION_ARRAY_FIELDS, ...COMPANION_JSON_FIELDS, ...COMPANION_LONG_TEXT_FIELDS].filter(field => (
      JSON.stringify(before[field]) !== JSON.stringify(after[field])
    ));
  }

  function collectCompanion() {
    const next = {};
    COMPANION_TEXT_FIELDS.forEach(field => {
      if (field === 'name') {
        next[field] = state.companion ? state.companion.data.name : '';
        return;
      }
      const value = elements.companionEditor.elements[field].value.trim();
      if (!value) throw new Error(`${COMPANION_FIELD_LABELS[field]}不能为空`);
      next[field] = value;
    });
    COMPANION_NUMBER_FIELDS.forEach(field => {
      const raw = elements.companionEditor.elements[field].value.trim();
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < 0) {
        throw new Error(`${COMPANION_FIELD_LABELS[field]}必须是非负有限数字`);
      }
      next[field] = value;
    });
    COMPANION_LONG_TEXT_FIELDS.forEach(field => {
      next[field] = elements.companionEditor.elements[field].value.trim();
    });
    if (next.hp > next.max_hp) throw new Error('当前气血不能超过气血上限');
    if (next.stamina > next.max_stamina) throw new Error('当前精力不能超过精力上限');
    COMPANION_ARRAY_FIELDS.forEach(field => {
      let value;
      try { value = JSON.parse(elements.companionEditor.elements[field].value.trim()); }
      catch { throw new Error(`${COMPANION_FIELD_LABELS[field]}不是有效的 JSON`); }
      if (!Array.isArray(value)) throw new Error(`${COMPANION_FIELD_LABELS[field]}必须是 JSON 数组`);
      next[field] = value;
    });
    COMPANION_JSON_FIELDS.forEach(field => {
      let value;
      try { value = JSON.parse(elements.companionEditor.elements[field].value.trim()); }
      catch { throw new Error(`${COMPANION_FIELD_LABELS[field]}不是有效的 JSON`); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${COMPANION_FIELD_LABELS[field]}必须是 JSON 对象`);
      }
      next[field] = value;
    });
    return next;
  }

  function updateCompanionDirty() {
    if (!state.companion) return;
    try {
      const next = collectCompanion();
      const count = companionChangedFields(state.companion.data, next).length;
      elements.companionDirty.textContent = count ? `${count} 个字段已修改` : '尚无待保存变更';
    } catch {
      elements.companionDirty.textContent = '表单包含待修正内容';
    }
  }

  function fillCompanionEditor(card) {
    const data = card.data;
    [...COMPANION_TEXT_FIELDS, ...COMPANION_NUMBER_FIELDS, ...COMPANION_LONG_TEXT_FIELDS].forEach(field => {
      const input = elements.companionEditor.elements[field];
      if (!input) return;
      input.value = data[field] ?? (COMPANION_NUMBER_FIELDS.includes(field) ? 0 : '');
    });
    COMPANION_ARRAY_FIELDS.forEach(field => {
      elements.companionEditor.elements[field].value = JSON.stringify(Array.isArray(data[field]) ? data[field] : [], null, 2);
    });
    COMPANION_JSON_FIELDS.forEach(field => {
      elements.companionEditor.elements[field].value = JSON.stringify(
        data[field] && typeof data[field] === 'object' && !Array.isArray(data[field]) ? data[field] : {}, null, 2
      );
    });
    elements.companionTitle.textContent = data.name || card.name || '未命名名片';
    elements.companionSubtitle.textContent = `预设名片 ${card.key} · ${card.is_default ? '默认档案' : '已修改'}`;
    elements.companionVersion.textContent = `版本 ${card.updated_at}`;
    elements.companionVersion.hidden = false;
    elements.companionEditor.hidden = false;
    elements.companionEditorState.hidden = true;
    elements.companionDirty.textContent = '尚无待保存变更';
  }

  function renderCompanionResults() {
    const cards = state.companions || [];
    elements.companionResults.replaceChildren();
    elements.companionCount.textContent = String(cards.length);
    elements.companionListState.textContent = cards.length ? `共 ${cards.length} 张预设名片` : '名片库为空。';
    cards.forEach(card => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'player-result';
      button.dataset.companionKey = card.key;
      button.setAttribute('aria-current', String(card.key === state.selectedCompanionKey));
      const names = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = card.data.name || card.name || '未命名';
      const meta = document.createElement('small');
      meta.textContent = `${card.data.character_class || '练气一层'} · ${card.data.gender || ''}${card.is_default ? '' : ' · 已修改'}`;
      names.append(name, meta);
      const id = document.createElement('code');
      id.textContent = `#${card.key}`;
      button.append(names, id);
      button.addEventListener('click', () => loadCompanion(card.key));
      elements.companionResults.append(button);
    });
  }

  async function loadCompanions() {
    elements.companionListState.textContent = '正在读取名片库…';
    try {
      const payload = await request('/api/admin/ai-companions');
      state.companions = Array.isArray(payload.cards) ? payload.cards : [];
      renderCompanionResults();
    } catch (error) {
      if (error.status !== 401) {
        elements.companionListState.textContent = error.message;
        elements.companionResults.replaceChildren();
        elements.companionCount.textContent = '0';
      }
    }
  }

  async function loadCompanion(key) {
    state.selectedCompanionKey = key;
    state.companion = null;
    elements.companionEditor.hidden = true;
    elements.companionEditorState.hidden = false;
    elements.companionEditorState.querySelector('strong').textContent = '正在读取名片';
    elements.companionEditorState.querySelector('p').textContent = '正在同步名片数据与版本信息。';
    document.querySelectorAll('[data-companion-key]').forEach(button => {
      button.setAttribute('aria-current', String(button.dataset.companionKey === key));
    });
    try {
      const payload = await request(`/api/admin/ai-companions/${encodeURIComponent(key)}`);
      state.companion = payload.card;
      const existing = state.companions.find(card => card.key === key);
      if (existing) Object.assign(existing, payload.card);
      fillCompanionEditor(payload.card);
    } catch (error) {
      if (error.status !== 401) {
        elements.companionEditorState.querySelector('strong').textContent = '无法打开名片';
        elements.companionEditorState.querySelector('p').textContent = error.message;
        showCompanionStatus(error.message, 'error');
      }
    }
  }

  function showCompanionPreview(next) {
    const fields = companionChangedFields(state.companion.data, next);
    if (!fields.length) {
      showCompanionStatus('没有检测到需要保存的变更。');
      return;
    }
    state.pendingCompanion = next;
    elements.changeSummary.replaceChildren();
    fields.forEach(field => {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = COMPANION_FIELD_LABELS[field] || field;
      const detail = document.createElement('span');
      const isArray = COMPANION_ARRAY_FIELDS.includes(field);
      const before = state.companion.data[field];
      const after = next[field];
      detail.textContent = `${isArray ? `${Array.isArray(before) ? before.length : 0} 项` : (before ?? '空')} → ${isArray ? `${Array.isArray(after) ? after.length : 0} 项` : (after ?? '空')}`;
      item.append(title, detail);
      elements.changeSummary.append(item);
    });
    elements.saveDialog.showModal();
  }

  async function saveCompanion() {
    if (!state.companion || !state.pendingCompanion) return;
    setButtonBusy(elements.companionSave, true, '保存中');
    try {
      await request(`/api/admin/ai-companions/${encodeURIComponent(state.selectedCompanionKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ card: state.pendingCompanion }),
      });
      elements.saveDialog.close();
      state.pendingCompanion = null;
      await loadCompanion(state.selectedCompanionKey);
      await loadCompanions();
      showCompanionStatus('名片已保存，新的匹配将使用更新后的档案。');
    } catch (error) {
      if (error.status !== 401) showCompanionStatus(error.message, 'error');
    } finally {
      setButtonBusy(elements.companionSave, false, '保存中');
    }
  }

  async function resetCompanion() {
    const card = state.companion;
    if (!card || !confirm(`确定将「${card.data.name || card.name}」恢复为默认名片吗？`)) return;
    setButtonBusy(elements.companionReset, true, '恢复中');
    try {
      await request(`/api/admin/ai-companions/${encodeURIComponent(state.selectedCompanionKey)}/reset`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadCompanion(state.selectedCompanionKey);
      await loadCompanions();
      showCompanionStatus('名片已恢复默认。');
    } catch (error) {
      if (error.status !== 401) showCompanionStatus(error.message, 'error');
    } finally {
      setButtonBusy(elements.companionReset, false, '恢复中');
    }
  }

  elements.loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    elements.loginError.hidden = true;
    setButtonBusy(elements.loginButton, true, '验证中');
    try {
      const payload = await request('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: elements.password.value }),
      });
      state.token = payload.token;
      sessionStorage.setItem(TOKEN_KEY, state.token);
      elements.password.value = '';
      setAuthenticated(true);
      elements.search.focus();
      await searchPlayers();
    } catch (error) {
      if (error.status !== 401) {
        elements.loginError.textContent = error.message;
        elements.loginError.hidden = false;
      }
    } finally {
      setButtonBusy(elements.loginButton, false, '验证中');
    }
  });

  elements.logout.addEventListener('click', async () => {
    try { await request('/api/admin/logout', { method: 'POST' }); }
    catch (error) { if (error.status !== 401) console.error(error); }
    finally { clearToken(); }
  });

  elements.searchForm.addEventListener('submit', event => {
    event.preventDefault();
    searchPlayers();
  });

  elements.editor.addEventListener('input', updateDirtyState);
  elements.editor.addEventListener('submit', event => {
    event.preventDefault();
    hideStatus();
    try { showChangePreview(collectCharacter()); }
    catch (error) { showStatus(error.message, 'error'); }
  });
  elements.confirmSave.addEventListener('click', () => {
    if (state.pendingCompanion) saveCompanion();
    else saveCharacter();
  });
  elements.deleteButton.addEventListener('click', deleteCharacter);
  elements.reload.addEventListener('click', () => loadCharacter(state.selectedId));
  elements.refreshAudit.addEventListener('click', loadAudit);

  elements.modePlayers.addEventListener('click', () => switchAdminMode('players'));
  elements.modeCompanions.addEventListener('click', () => switchAdminMode('companions'));
  elements.companionEditor.addEventListener('input', updateCompanionDirty);
  elements.companionEditor.addEventListener('submit', event => {
    event.preventDefault();
    try { showCompanionPreview(collectCompanion()); }
    catch (error) { showCompanionStatus(error.message, 'error'); }
  });
  elements.companionSave.addEventListener('click', saveCompanion);
  elements.companionReset.addEventListener('click', resetCompanion);

  setAuthenticated(Boolean(state.token));
  if (state.token) searchPlayers();
})();
