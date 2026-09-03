'use strict';

/*
 * 站点网关：把两个游戏挂到同一个域名的两个子路径下。
 *
 *   https://xiuxiangame.dpdns.org/          → 导航首页（本进程渲染）
 *   https://xiuxiangame.dpdns.org/xiuxian/  → 127.0.0.1:8787
 *   https://xiuxiangame.dpdns.org/dnf/      → 127.0.0.1:8788
 *
 * 关键点是「剥前缀」：/dnf/api/me 转发给 8788 时改写成 /api/me，
 * 于是两个游戏的 server.js 与前端里 38 处 /api 绝对路径、以及硬编码的
 * /ws 都不用改。cloudflared 的 ingress 本身不支持重写路径，所以这一层
 * 必须由自己的进程来做。
 *
 * 两个游戏的前端资源引用都是不带前导斜杠的相对路径（href="style.css"），
 * 因此必须保证浏览器地址栏停在 /dnf/ 这种带尾斜杠的形式上，否则
 * style.css 会被解析到站点根目录。裸 /dnf 会 301 到 /dnf/。
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

// 与 server.js 相同的本地 .env 加载：网关独立启动（不经过统一控制台）时也能
// 读到 GATEWAY_AUTH_SECRET / GATEWAY_XIUXIAN_DB。必须在 require gateway-auth 之前
// 执行，否则该模块加载时密钥与库路径就已经定型；已设置的变量优先。
function loadLocalEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[gateway] 无法读取 .env：', error.message);
  }
}
if (process.env.TAVERN_LOAD_ENV !== '0') loadLocalEnv();

const gatewayAuth = require('./gateway-auth.js');

const DEFAULT_PORT = 8786;

const DEFAULT_SITES = [
  { prefix: 'xiuxian', name: '问道仙坊', port: 8787, tagline: '修仙问道，结庐山野' },
  { prefix: 'dnf', name: '地下城与勇士', port: 8788, tagline: '组队下副本，刀刀见血' },
];

// 逐跳首部不能透传，否则转发链上的连接语义会错乱。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function parseSites(env = process.env) {
  const raw = (env.GATEWAY_SITES || '').trim();
  if (!raw) return DEFAULT_SITES.map(site => ({ ...site }));
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GATEWAY_SITES 不是合法 JSON：${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('GATEWAY_SITES 必须是非空 JSON 数组');
  const seen = new Set();
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 项不是对象`);
    const prefix = String(item.prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!prefix) throw new Error(`第 ${index + 1} 项缺少 prefix`);
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error(`prefix「${prefix}」只能用字母、数字、下划线和连字符`);
    if (seen.has(prefix)) throw new Error(`prefix「${prefix}」重复`);
    seen.add(prefix);
    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`站点「${prefix}」的 port 无效：${item.port}`);
    return {
      prefix,
      name: String(item.name || prefix),
      port,
      tagline: String(item.tagline || ''),
      host: String(item.host || '127.0.0.1'),
    };
  });
}

// 把 /dnf/api/me 拆成 { site, rest: '/api/me' }；/dnf 与 /dnf/ 都算命中。
function matchSite(sites, pathname) {
  for (const site of sites) {
    const base = `/${site.prefix}`;
    if (pathname === base) return { site, rest: null };
    if (pathname.startsWith(`${base}/`)) return { site, rest: pathname.slice(base.length) || '/' };
  }
  return null;
}

function renderHome(sites) {
  const cards = sites.map(site => `
      <div class="card" data-game="${escapeHtml(site.prefix)}">
        <h2>${escapeHtml(site.name)}</h2>
        ${site.tagline ? `<p>${escapeHtml(site.tagline)}</p>` : ''}
        <span class="go">进入 &rarr;</span>
      </div>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>游戏站</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; font-family: system-ui, "Microsoft YaHei", sans-serif;
         background: #12141a; color: #e8e6e3; }
  nav { width: 200px; flex: none; padding: 28px 0; background: #0d0f13; border-right: 1px solid #23262e; }
  nav h1 { margin: 0 20px 20px; font-size: 15px; letter-spacing: .12em; color: #8b8f9a; font-weight: 600; }
  nav a { display: block; padding: 11px 20px; color: #c9ccd4; text-decoration: none; font-size: 14px;
          border-left: 3px solid transparent; }
  nav a:hover { background: #171a20; color: #fff; border-left-color: #d8a24a; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
         padding: 48px 28px; }
  main > h2 { margin: 0 0 6px; font-size: 26px; text-align: center; }
  main > p { margin: 0 0 32px; color: #8b8f9a; font-size: 14px; text-align: center; }
  .auth-box { width: min(100%, 420px); margin: 0 0 36px; padding: 24px; background: #191c23;
              border: 1px solid #23262e; border-radius: 12px; text-align: left; }
  .auth-box h3 { margin: 0 0 18px; font-size: 18px; }
  .auth-row { margin-bottom: 14px; }
  .auth-row label { display: block; margin-bottom: 6px; font-size: 13px; color: #8b8f9a; }
  .auth-row input { width: 100%; padding: 10px 12px; background: #0d0f13; border: 1px solid #23262e; border-radius: 8px;
                    color: #e8e6e3; font-size: 14px; }
  .auth-row input:focus { outline: none; border-color: #d8a24a; }
  .auth-row .auth-remember { display: flex; align-items: center; gap: 8px; margin: 0; color: #9aa0aa; cursor: pointer; }
  .auth-row .auth-remember input { width: 15px; height: 15px; flex: none; accent-color: #d8a24a; }
  .auth-remember-row { margin-top: -4px; }
  .auth-btns { display: flex; gap: 10px; margin-top: 18px; }
  .btn { padding: 10px 18px; background: #d8a24a; color: #0d0f13; border: none; border-radius: 999px; font-size: 14px;
         font-weight: 600; cursor: pointer; }
  .btn:hover { background: #e9b15b; }
  .btn.secondary { background: #23262e; color: #c9ccd4; }
  .btn.secondary:hover { background: #2d3139; }
  .error { color: #e76f51; font-size: 13px; margin-top: 8px; min-height: 20px; }
  .user-info { display: flex; align-items: center; gap: 12px; margin: 0 auto 28px; padding: 16px; background: #0d0f13;
               border: 1px solid #23262e; border-radius: 10px; }
  .user-info strong { color: #d8a24a; }
  .link-btn { background: none; border: none; color: #8b8f9a; text-decoration: underline; cursor: pointer; padding: 0; font-size: 13px; }
  .cards { width: 100%; display: flex; flex-wrap: wrap; justify-content: center; gap: 18px; }
  .card { width: 260px; max-width: 100%; padding: 22px; background: #191c23; border: 1px solid #23262e; border-radius: 10px;
          cursor: pointer; color: inherit; }
  .card:hover { border-color: #d8a24a; background: #1d212a; }
  .card h2 { margin: 0 0 8px; font-size: 19px; }
  .card p { margin: 0 0 16px; color: #8b8f9a; font-size: 13px; line-height: 1.6; }
  .go { color: #d8a24a; font-size: 13px; }
  .hidden { display: none; }
  @media (max-width: 640px) {
    body { flex-direction: column; }
    nav { width: auto; border-right: none; border-bottom: 1px solid #23262e; padding: 18px 0; }
    nav h1 { text-align: center; }
    nav a { text-align: center; }
    main { padding: 28px 16px; }
  }
</style>
</head>
<body>
<nav>
  <h1>游戏导航</h1>
${sites.map(s => `  <a href="/${escapeHtml(s.prefix)}/">${escapeHtml(s.name)}</a>`).join('\n')}
</nav>
<main>
  <h2>选择一个世界</h2>
  <p>统一账号，登录一次即可进入所有游戏。</p>

  <!-- 登录状态 -->
  <div id="user-section" class="hidden">
    <div class="user-info">
      <span>👤 <strong id="username-display"></strong></span>
      <button class="link-btn" onclick="logout()">退出</button>
    </div>
  </div>

  <!-- 登录/注册表单 -->
  <div id="auth-section" class="auth-box">
    <h3 id="auth-title">登录</h3>
    <div class="auth-row">
      <label>用户名</label>
      <input id="username" type="text" autocomplete="username" placeholder="3~32 字符（字母/数字/下划线）" maxlength="32">
    </div>
    <div class="auth-row">
      <label>密码</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="至少 6 位" maxlength="64">
    </div>
    <div class="auth-row auth-remember-row">
      <label class="auth-remember">
        <input id="remember-auth" type="checkbox" checked>
        <span>在本机保存账号和密码</span>
      </label>
    </div>
    <div class="error" id="auth-error"></div>
    <div class="auth-btns">
      <button class="btn" id="auth-btn" onclick="doAuth()">登录</button>
      <button class="btn secondary" onclick="toggleMode()">注册新账号</button>
    </div>
  </div>

  <div class="cards" id="game-cards">${cards}
  </div>
</main>

<script>
const API = { token: null, user: null, mode: 'login' };
const REMEMBER_KEY = 'gateway_saved_login';

function showError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

function restoreSavedCredentials() {
  const user = document.getElementById('username');
  const pass = document.getElementById('password');
  const remember = document.getElementById('remember-auth');
  if (!user || !pass || !remember) return;
  let saved = null;
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (_) {}
  user.value = saved && typeof saved.username === 'string' ? saved.username : '';
  pass.value = saved && typeof saved.password === 'string' ? saved.password : '';
  remember.checked = true;
}
function saveSavedCredentials(username, password) {
  const remember = document.getElementById('remember-auth');
  const enabled = !remember || remember.checked;
  try {
    if (!enabled || !username) {
      localStorage.removeItem(REMEMBER_KEY);
      return;
    }
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ username, password }));
  } catch (_) {}
}

function toggleMode() {
  API.mode = API.mode === 'login' ? 'register' : 'login';
  document.getElementById('auth-title').textContent = API.mode === 'login' ? '登录' : '注册新账号';
  document.getElementById('auth-btn').textContent = API.mode === 'login' ? '登录' : '注册';
  showError('');
}

async function doAuth() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showError('请输入用户名和密码');
    return;
  }

  try {
    const res = await fetch('/api/gateway/auth/' + API.mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || '操作失败');
      return;
    }

    API.token = data.token;
    API.user = data.user;
    sessionStorage.setItem('gateway_token', data.token);
    sessionStorage.setItem('gateway_user', JSON.stringify(data.user));
    saveSavedCredentials(username, password);

    showLoggedIn();
  } catch (err) {
    showError('网络错误，请重试');
  }
}

function showLoggedIn() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('user-section').classList.remove('hidden');
  document.getElementById('username-display').textContent = API.user.username;
}

function logout() {
  API.token = null;
  API.user = null;
  sessionStorage.removeItem('gateway_token');
  sessionStorage.removeItem('gateway_user');

  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('user-section').classList.add('hidden');
  restoreSavedCredentials();
  showError('');
}

function enterGame(prefix) {
  if (!API.token) {
    showError('请先登录');
    return;
  }

  // 带上一次性 token 进入游戏
  window.location.href = '/' + prefix + '/?auth_token=' + encodeURIComponent(API.token);
}

// 绑定游戏卡片点击事件
document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    const prefix = card.dataset.game;
    enterGame(prefix);
  });
});

// 初始化：检查是否已登录
(function init() {
  restoreSavedCredentials();
  const token = sessionStorage.getItem('gateway_token');
  const user = sessionStorage.getItem('gateway_user');

  if (token && user) {
    try {
      API.token = token;
      API.user = JSON.parse(user);
      showLoggedIn();
    } catch {
      // 数据损坏，清除
      sessionStorage.removeItem('gateway_token');
      sessionStorage.removeItem('gateway_user');
    }
  }
})();
</script>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function createGateway(options = {}, env = process.env) {
  const sites = options.sites ? parseSites({ GATEWAY_SITES: JSON.stringify(options.sites) }) : parseSites(env);
  const home = renderHome(sites);

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    // 网关认证 API
    if (pathname.startsWith('/api/gateway/auth/')) {
      if (pathname === '/api/gateway/auth/login' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req));
          const result = gatewayAuth.login(body.username || '', body.password || '');
          sendJSON(res, 200, result);
        } catch (error) {
          sendJSON(res, 401, { error: error.message || '登录失败' });
        }
        return;
      }

      if (pathname === '/api/gateway/auth/register' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req));
          const result = gatewayAuth.register(body.username || '', body.password || '', body.nickname || '');
          sendJSON(res, 200, result);
        } catch (error) {
          sendJSON(res, 400, { error: error.message || '注册失败' });
        }
        return;
      }

      if (pathname === '/api/gateway/auth/me' && req.method === 'GET') {
        try {
          const authHeader = req.headers['authorization'] || '';
          const match = authHeader.match(/^Bearer\s+(.+)$/i);
          const token = match ? match[1].trim() : '';
          const user = gatewayAuth.me(token);
          sendJSON(res, 200, { user });
        } catch (error) {
          sendJSON(res, 401, { error: error.message || '未登录' });
        }
        return;
      }

      if (pathname === '/api/gateway/auth/logout' && req.method === 'POST') {
        // 登出只需客户端清除 token，服务端无需处理
        sendJSON(res, 200, { ok: true });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(home);
      return;
    }

    const hit = matchSite(sites, pathname);
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><p>没有这个页面。<a href="/">回首页</a></p>');
      return;
    }

    // 裸 /dnf 必须跳到 /dnf/，否则页面里 href="style.css" 会落到站点根目录。
    if (hit.rest === null) {
      res.writeHead(301, { location: `/${hit.site.prefix}/` });
      res.end();
      return;
    }

    const search = req.url.slice(req.url.indexOf(pathname) + pathname.length);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }
    headers['x-forwarded-prefix'] = `/${hit.site.prefix}`;

    const upstream = http.request({
      host: hit.site.host,
      port: hit.site.port,
      method: req.method,
      path: hit.rest + search,
      headers,
    }, response => {
      const out = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
      }
      // 上游若把 302 指向 /login.html，要补回前缀，否则会跳出子路径。
      if (out.location && out.location.startsWith('/')) {
        out.location = `/${hit.site.prefix}${out.location}`;
      }
      res.writeHead(response.statusCode || 502, out);
      response.pipe(res);
    });

    upstream.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><p>${escapeHtml(hit.site.name)} 没有在运行（127.0.0.1:${hit.site.port}）。`
        + '请在统一控制台里启动它。<a href="/">回首页</a></p>');
    });

    req.pipe(upstream);
  });

  // WebSocket：手工转发 upgrade，剥前缀后正好命中上游的 /ws。
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    const hit = matchSite(sites, pathname);
    if (!hit || hit.rest === null) { socket.destroy(); return; }

    const search = req.url.slice(req.url.indexOf(pathname) + pathname.length);
    const upstream = net.connect(hit.site.port, hit.site.host, () => {
      const lines = [`GET ${hit.rest + search} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return { server, sites };
}

module.exports = { createGateway, parseSites, matchSite, renderHome, DEFAULT_PORT, DEFAULT_SITES };

if (require.main === module) {
  const host = process.env.GATEWAY_HOST || '0.0.0.0';
  const port = Number(process.env.GATEWAY_PORT || DEFAULT_PORT);
  try {
    const { server, sites } = createGateway();
    server.listen(port, host, () => {
      console.log(`[gateway] http://${host}:${port}`);
      for (const site of sites) console.log(`[gateway]   /${site.prefix}/ → 127.0.0.1:${site.port}  ${site.name}`);
    });
    const bye = () => { server.close(() => process.exit(0)); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  } catch (error) {
    console.error(`[gateway] 配置错误： ${error.message}`);
    process.exit(1);
  }
}
