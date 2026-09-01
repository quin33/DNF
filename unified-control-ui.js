(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = { token: '', csrfToken: '', poll: null, logPoll: null, rendered: false };
  const loginPanel = $('#login-panel');
  const app = $('#app');

  const SERVER_STATE_LABELS = {
    running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中',
    restarting: '重启中', crashed: '已崩溃', error: '异常', unavailable: '不可用',
  };
  const ACTION_LABELS = { start: '启动服务器', stop: '停止服务器', restart: '重启服务器' };
  const BATCH_LABELS = { start: '启动全部', stop: '停止全部', restart: '重启全部' };
  const GW_ACTION_LABELS = { start: '启动网关', stop: '停止网关', restart: '重启网关' };

  function toast(message, tone = 'info') {
    const node = $('#toast');
    node.textContent = message;
    node.dataset.tone = tone;
    node.dataset.show = 'true';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.dataset.show = 'false'; }, 3600);
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `请求失败（${response.status}）`), {
        status: response.status, code: payload.code,
      });
    }
    return payload;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // 首次拿到状态时按游戏建卡片，之后只更新数值，避免重绘打断交互。
  function buildGrid(games, gateway) {
    $('#game-grid').innerHTML = games.map(game => `
      <section class="game-block" data-game="${escapeHtml(game.key)}" data-available="${game.available}">
        <header>
          <h2>${escapeHtml(game.name)}</h2>
          <span class="where">${escapeHtml(game.rootDir)}</span>
        </header>
        <div class="status-grid">
          <article class="status-panel" data-tone="server">
            <div class="panel-topline">
              <span class="status-dot" data-field="server-dot"></span>
              <span data-field="server-state">检查中</span>
            </div>
            <h3>网页服务器</h3>
            <dl class="facts">
              <div><dt>进程</dt><dd data-field="server-pid">—</dd></div>
              <div><dt>端口</dt><dd data-field="server-port">—</dd></div>
              <div><dt>健康检查</dt><dd data-field="server-health">—</dd></div>
            </dl>
            <div class="actions">
              <button class="button" data-server-action="start" type="button">启动服务器</button>
              <button class="button" data-server-action="restart" type="button">重启服务器</button>
              <button class="button button-danger" data-server-action="stop" type="button">停止服务器</button>
            </div>
          </article>
          <article class="status-panel" data-tone="ai">
            <div class="panel-topline">
              <span class="status-dot" data-field="ai-dot"></span>
              <span data-field="ai-state">检查中</span>
            </div>
            <h3>AI 服务</h3>
            <dl class="facts">
              <div><dt>运行开关</dt><dd><label class="switch">
                <input type="checkbox" data-field="ai-toggle"><span class="switch-track"></span>
                <span data-field="ai-toggle-label">—</span>
              </label></dd></div>
              <div><dt>模型</dt><dd data-field="ai-model">—</dd></div>
              <div><dt>配置</dt><dd data-field="ai-configured">—</dd></div>
            </dl>
            <div class="actions">
              <button class="button" data-ai-action="reload" type="button">重载配置</button>
              <button class="button button-quiet" data-ai-action="check" type="button">检查连接</button>
            </div>
          </article>
        </div>
      </section>
    `).join('');

    const select = $('#log-game');
    select.innerHTML = '<option value="all">全部</option><option value="unified">控制台</option>'
      + (gateway && gateway.enabled ? '<option value="gateway">站点网关</option>' : '')
      + games.map(g => `<option value="${escapeHtml(g.key)}">${escapeHtml(g.name)}</option>`).join('');

    $('#game-grid').querySelectorAll('[data-server-action]').forEach(button => {
      button.addEventListener('click', () => {
        serverAction(button.closest('[data-game]').dataset.game, button.dataset.serverAction);
      });
    });
    $('#game-grid').querySelectorAll('[data-field="ai-toggle"]').forEach(input => {
      input.addEventListener('change', event => {
        toggleAi(input.closest('[data-game]').dataset.game, event);
      });
    });
    $('#game-grid').querySelectorAll('[data-ai-action]').forEach(button => {
      button.addEventListener('click', () => {
        aiOperation(button.closest('[data-game]').dataset.game, button.dataset.aiAction);
      });
    });
    state.rendered = true;
  }

  function renderStatus(payload) {
    const games = payload.games || [];
    if (!state.rendered) buildGrid(games, payload.gateway);
    for (const game of games) {
      const block = $(`[data-game="${game.key}"]`);
      if (!block) continue;
      const field = name => block.querySelector(`[data-field="${name}"]`);
      const server = game.server || {};
      const ai = game.ai || {};
      const serverState = game.available ? (server.state || 'unknown') : 'unavailable';

      field('server-state').textContent = SERVER_STATE_LABELS[serverState] || '未知';
      field('server-pid').textContent = server.pid || '—';
      field('server-port').textContent = server.port || game.gamePort || '—';
      field('server-health').textContent = server.healthAt
        ? new Date(server.healthAt).toLocaleTimeString() : '未检查';
      field('server-dot').dataset.state = serverState === 'running' ? 'running'
        : serverState === 'stopped' ? 'stopped' : 'unknown';

      field('ai-state').textContent = ai.enabled ? '已启用' : '已停用';
      const toggle = field('ai-toggle');
      if (document.activeElement !== toggle) toggle.checked = !!ai.enabled;
      toggle.disabled = !game.available || serverState !== 'running';
      field('ai-toggle-label').textContent = ai.enabled ? '启用' : '停用';
      field('ai-model').textContent = ai.model || '未设置';
      field('ai-configured').textContent = ai.configured ? '已配置' : '未配置';
      field('ai-dot').dataset.state = ai.enabled ? 'enabled' : 'disabled';

      block.querySelectorAll('button').forEach(button => { button.disabled = !game.available; });
    }
    renderGateway(payload.gateway);
    $('#last-updated').textContent = `更新于 ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
  }

  // 网关不是游戏，独立渲染。未开启时整块变暗并禁用按钮，只在 .env 打开 UNIFIED_GATEWAY 后可用。
  function renderGateway(gw) {
    const block = $('#gateway-block');
    if (!block || !gw) return;
    const field = name => block.querySelector(`[data-field="${name}"]`);
    const server = gw.server || {};
    field('gw-root').textContent = gw.rootDir || '—';
    field('gw-port').textContent = gw.port || '—';
    field('gw-sites').textContent = gw.enabled && gw.sites && gw.sites.length
      ? gw.sites.map(s => `/${s.prefix}/→${s.port}`).join('  ')
      : '—';
    field('gw-pid').textContent = server.pid || '—';
    field('gw-health').textContent = server.healthAt
      ? new Date(server.healthAt).toLocaleTimeString() : '未检查';

    const state = gw.enabled
      ? (gw.available ? (server.state || 'unknown') : 'unavailable')
      : 'disabled';
    field('gw-state').textContent = gw.enabled
      ? (SERVER_STATE_LABELS[state] || '未知')
      : '未启用';
    field('gw-dot').dataset.state = state === 'running' ? 'running'
      : state === 'stopped' ? 'stopped'
      : state === 'disabled' ? 'disabled' : 'unknown';

    block.dataset.available = String(gw.enabled);
    block.querySelectorAll('[data-gw-action]').forEach(button => {
      button.disabled = !gw.enabled;
    });
  }

  async function refreshStatus() {
    try { renderStatus((await request('/api/control/status')).status); }
    catch (error) { if (error.status === 401) showLogin(); else toast(error.message, 'error'); }
  }

  function renderLogs(logs) {
    const list = $('#log-list');
    if (!logs.length) { list.innerHTML = '<div class="empty-state">暂无符合条件的日志</div>'; return; }
    list.innerHTML = logs.map(entry => `<div class="log-entry">
      <span class="log-time">${new Date(entry.at || Date.now()).toLocaleString()}</span>
      <span class="log-level" data-level="${entry.level || 'info'}">${entry.level || 'info'}</span>
      <span class="log-message">${escapeHtml(entry.message || '')}</span>
    </div>`).join('');
  }

  async function refreshLogs() {
    try {
      const params = new URLSearchParams({
        game: $('#log-game').value, level: $('#log-level').value, limit: '120',
      });
      renderLogs((await request(`/api/control/logs?${params}`)).logs || []);
    } catch (error) { if (error.status === 401) showLogin(); else toast(error.message, 'error'); }
  }

  function setBusy(value) {
    document.querySelectorAll('button, select, input[type="checkbox"]').forEach(node => {
      node.disabled = value;
    });
    if (!value) refreshStatus();
  }

  async function serverAction(gameKey, action) {
    if (!window.confirm(`确认${ACTION_LABELS[action]}？`)) return;
    setBusy(true);
    try {
      await request(`/api/control/game/${gameKey}/server/${action}`, { method: 'POST' });
      toast(`${ACTION_LABELS[action]}已完成`);
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); await refreshLogs(); }
  }

  async function gatewayAction(action) {
    if (!window.confirm(`确认${GW_ACTION_LABELS[action]}？`)) return;
    setBusy(true);
    try {
      await request(`/api/control/gateway/server/${action}`, { method: 'POST' });
      toast(`${GW_ACTION_LABELS[action]}已完成`);
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); await refreshLogs(); }
  }

  async function batchAction(action) {    if (!window.confirm(`确认${BATCH_LABELS[action]}？`)) return;
    setBusy(true);
    try {
      const payload = await request(`/api/control/all/server/${action}`, { method: 'POST' });
      const failed = (payload.results || []).filter(item => !item.ok);
      if (!failed.length) toast(`${BATCH_LABELS[action]}已完成`);
      else toast(`部分失败：${failed.map(f => `${f.name}(${f.error})`).join('；')}`, 'error');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); await refreshLogs(); }
  }

  async function toggleAi(gameKey, event) {
    const enabled = event.target.checked;
    if (!window.confirm(`确认${enabled ? '启用' : '停用'} AI 服务？`)) {
      event.target.checked = !enabled;
      return;
    }
    setBusy(true);
    try {
      await request(`/api/control/game/${gameKey}/ai/toggle`, {
        method: 'POST', body: JSON.stringify({ enabled }),
      });
      toast(`AI 已${enabled ? '启用' : '停用'}`);
    } catch (error) { event.target.checked = !enabled; toast(error.message, 'error'); }
    finally { setBusy(false); await refreshLogs(); }
  }

  async function aiOperation(gameKey, action) {
    const label = action === 'reload' ? 'AI 配置重载' : 'AI 连接检查';
    setBusy(true);
    try {
      await request(`/api/control/game/${gameKey}/ai/${action}`, { method: 'POST' });
      toast(`${label}已完成`);
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); await refreshLogs(); }
  }

  function showLogin() {
    state.token = '';
    state.csrfToken = '';
    app.hidden = true;
    loginPanel.hidden = false;
    $('#password').focus();
  }

  function showApp(credentials) {
    state.token = credentials.token;
    state.csrfToken = credentials.csrfToken;
    loginPanel.hidden = true;
    app.hidden = false;
    refreshStatus();
    refreshLogs();
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#login-error').textContent = '';
    try {
      showApp(await request('/api/control/login', {
        method: 'POST', body: JSON.stringify({ password: $('#password').value }),
      }));
      $('#password').value = '';
    } catch (error) { $('#login-error').textContent = error.message; }
  });
  $('#refresh').addEventListener('click', refreshStatus);
  document.querySelectorAll('[data-batch-action]').forEach(button => {
    button.addEventListener('click', () => batchAction(button.dataset.batchAction));
  });
  document.querySelectorAll('[data-gw-action]').forEach(button => {
    button.addEventListener('click', () => gatewayAction(button.dataset.gwAction));
  });
  $('#log-game').addEventListener('change', refreshLogs);
  $('#log-level').addEventListener('change', refreshLogs);
  state.poll = setInterval(() => { if (!app.hidden) refreshStatus(); }, 5000);
  state.logPoll = setInterval(() => { if (!app.hidden) refreshLogs(); }, 7000);
})();
