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

const DEFAULT_PORT = 8786;

const DEFAULT_SITES = [
  { prefix: 'xiuxian', name: '问道仙坊', port: 8787, tagline: '修仙问道，结庐山野' },
  { prefix: 'dnf', name: 'DNF', port: 8788, tagline: '组队下副本，刀刀见血' },
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
      <a class="card" href="/${escapeHtml(site.prefix)}/">
        <h2>${escapeHtml(site.name)}</h2>
        ${site.tagline ? `<p>${escapeHtml(site.tagline)}</p>` : ''}
        <span class="go">进入 &rarr;</span>
      </a>`).join('');
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
  main { flex: 1; padding: 56px 40px; }
  main > h2 { margin: 0 0 6px; font-size: 26px; }
  main > p { margin: 0 0 32px; color: #8b8f9a; font-size: 14px; }
  .cards { display: flex; flex-wrap: wrap; gap: 18px; }
  .card { width: 260px; padding: 22px; background: #191c23; border: 1px solid #23262e; border-radius: 10px;
          text-decoration: none; color: inherit; }
  .card:hover { border-color: #d8a24a; background: #1d212a; }
  .card h2 { margin: 0 0 8px; font-size: 19px; }
  .card p { margin: 0 0 16px; color: #8b8f9a; font-size: 13px; line-height: 1.6; }
  .go { color: #d8a24a; font-size: 13px; }
  @media (max-width: 640px) {
    body { flex-direction: column; }
    nav { width: auto; border-right: none; border-bottom: 1px solid #23262e; padding: 18px 0; }
    main { padding: 32px 20px; }
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
  <p>两个游戏账号与存档相互独立。</p>
  <div class="cards">${cards}
  </div>
</main>
</body>
</html>`;
}

function createGateway(options = {}, env = process.env) {
  const sites = options.sites ? parseSites({ GATEWAY_SITES: JSON.stringify(options.sites) }) : parseSites(env);
  const home = renderHome(sites);

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request');
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
