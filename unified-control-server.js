'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8792;
const HOST = '127.0.0.1';

// 简单的静态文件服务器，只服务统一控制台 HTML
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/unified-control.html') {
    const html = fs.readFileSync(path.join(__dirname, 'unified-control.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 代理 control-panel.css 请求到 DNF 控制台
  if (req.url === '/control-panel.css') {
    try {
      const css = fs.readFileSync(path.join(__dirname, 'control-panel.css'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(css);
    } catch {
      res.writeHead(404);
      res.end('CSS not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error('==========================================');
    console.error(`  端口 ${PORT} 已被占用，统一控制台未启动。`);
    console.error('  排查：netstat -ano | findstr :' + PORT);
    console.error('==========================================');
    process.exit(1);
  }
  console.error('[unified-control] 启动失败：', error.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[unified-control] 统一控制台运行在 http://${HOST}:${PORT}`);
  console.log('  需要同时启动两个游戏的控制台:');
  console.log('    - 问道仙坊控制台: http://127.0.0.1:8790');
  console.log('    - DNF 控制台: http://127.0.0.1:8791');
});
