(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = { token: '', csrfToken: '', poll: null, logPoll: null, busy: false };
  const loginPanel = $('#login-panel');
  const app = $('#app');

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
    if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败（${response.status}）`), { status: response.status, code: payload.code });
    return payload;
  }

  function setStatusDot(id, stateName) {
    const node = $(id);
    node.dataset.state = stateName;
  }

  function renderStatus(payload) {
    const server = payload.server || {};
    const ai = payload.ai || {};
    const serverState = server.state || 'unknown';
    $('#server-state').textContent = ({ running: '运行中', stopped: '已停止', starting: '启动中', stopping: '停止中' })[serverState] || '未知';
    $('#server-pid').textContent = server.pid || '—';
    $('#server-port').textContent = server.port || '—';
    $('#server-health').textContent = server.healthAt ? new Date(server.healthAt).toLocaleTimeString() : '未检查';
    setStatusDot('#server-dot', serverState === 'running' ? 'running' : serverState === 'stopped' ? 'stopped' : 'unknown');
    $('#ai-state').textContent = ai.enabled ? '已启用' : '已停用';
    $('#ai-toggle').checked = !!ai.enabled;
    $('#ai-toggle-label').textContent = ai.enabled ? '启用' : '停用';
    $('#ai-model').textContent = ai.model || '未设置';
    $('#ai-configured').textContent = ai.configured ? '已配置' : '未配置';
    setStatusDot('#ai-dot', ai.enabled ? 'enabled' : 'disabled');
    $('#last-updated').textContent = `更新于 ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
  }

  async function refreshStatus() {
    try { renderStatus((await request('/api/control/status')).status); }
    catch (error) { if (error.status === 401) showLogin(); else toast(error.message, 'error'); }
  }

  function renderLogs(logs) {
    const list = $('#log-list');
    if (!logs.length) { list.innerHTML = '<div class="empty-state">暂无符合条件的日志</div>'; return; }
    list.innerHTML = logs.map(entry => `<div class="log-entry"><span class="log-time">${new Date(entry.at || Date.now()).toLocaleString()}</span><span class="log-level" data-level="${entry.level || 'info'}">${entry.level || 'info'}</span><span class="log-message">${escapeHtml(entry.message || '')}</span></div>`).join('');
  }

  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  async function refreshLogs() {
    try {
      const params = new URLSearchParams({ service: $('#log-service').value, level: $('#log-level').value, limit: '120' });
      renderLogs((await request(`/api/control/logs?${params}`)).logs || []);
    } catch (error) { if (error.status === 401) showLogin(); else toast(error.message, 'error'); }
  }

  function setBusy(value) {
    state.busy = value;
    document.querySelectorAll('button, input, select').forEach(node => { if (node.id !== 'password') node.disabled = value; });
  }

  async function serverAction(action) {
    const labels = { start: '启动服务器', stop: '停止服务器', restart: '重启服务器' };
    if (!window.confirm(`确认${labels[action]}？`)) return;
    setBusy(true);
    try { await request(`/api/control/server/${action}`, { method: 'POST' }); toast(`${labels[action]}已完成`); await refreshStatus(); await refreshLogs(); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  }

  async function toggleAi(event) {
    const enabled = event.target.checked;
    if (!window.confirm(`确认${enabled ? '启用' : '停用'} AI 服务？`)) { event.target.checked = !enabled; return; }
    setBusy(true);
    try { await request('/api/control/ai/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }); toast(`AI 已${enabled ? '启用' : '停用'}`); await refreshStatus(); await refreshLogs(); }
    catch (error) { event.target.checked = !enabled; toast(error.message, 'error'); }
    finally { setBusy(false); }
  }

  async function aiOperation(path, label) {
    setBusy(true);
    try { await request(path, { method: 'POST' }); toast(`${label}已完成`); await refreshStatus(); await refreshLogs(); }
    catch (error) { toast(error.message, 'error'); }
    finally { setBusy(false); }
  }

  function showLogin() { state.token = ''; state.csrfToken = ''; app.hidden = true; loginPanel.hidden = false; $('#password').focus(); }
  function showApp(credentials) { state.token = credentials.token; state.csrfToken = credentials.csrfToken; loginPanel.hidden = true; app.hidden = false; refreshStatus(); refreshLogs(); }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#login-error').textContent = '';
    try { showApp(await request('/api/control/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) })); $('#password').value = ''; }
    catch (error) { $('#login-error').textContent = error.message; }
  });
  $('#refresh').addEventListener('click', refreshStatus);
  $('#ai-toggle').addEventListener('change', toggleAi);
  $('#ai-reload').addEventListener('click', () => aiOperation('/api/control/ai/reload', 'AI 配置重载'));
  $('#ai-check').addEventListener('click', () => aiOperation('/api/control/ai/check', 'AI 连接检查'));
  document.querySelectorAll('[data-server-action]').forEach(button => button.addEventListener('click', () => serverAction(button.dataset.serverAction)));
  $('#log-service').addEventListener('change', refreshLogs);
  $('#log-level').addEventListener('change', refreshLogs);
  state.poll = setInterval(refreshStatus, 5000);
  state.logPoll = setInterval(refreshLogs, 7000);
  request('/api/control/health').then(() => {}).catch(() => {});
})();
