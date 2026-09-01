# DNF · 在线版部署指南

## 端口与实例隔离（重要）

本机同时跑着两个独立实例，端口、数据库、公网域名全部分开：

| 项目 | 目录 | 游戏服务 | 控制台 | 统一控制台 | 数据库 | 公网域名 |
| --- | --- | --- | --- | --- | --- | --- |
| 问道仙坊（原游戏） | `I:\DEEPSEEK\tavern_clone` | 8787 | 8790 | — | `tavern.db` | `xiuxiangame.dpdns.org` |
| DNF（本项目） | `I:\DEEPSEEK\DNF` | **8788** | **8791** | — | `dnf.db` | `dnf.xiuxiangame.dpdns.org` |
| **统一控制台** | `I:\DEEPSEEK\DNF` | — | — | **8792** | — | — |

改端口时必须三处同步：本项目 `.env`、四个 `启动*.bat`、以及 `%USERPROFILE%\.cloudflared\config.yml` 的 ingress 规则。

三条注意事项：

- **不要在同一个命令行窗口里先跑原游戏的脚本再跑 DNF 的脚本。** `server.js` 与 `control-panel.js` 读 `.env` 时只填补「尚未设置」的变量,系统环境变量优先级更高，所以窗口里残留的 `PORT` / `GAME_PORT` / `CONTROL_PANEL_PORT` 会盖掉 `.env`。DNF 的四个 `.bat` 已用 `setlocal` 隔离并显式钉死端口，双击运行不受影响；手工在同一窗口 `node server.js` 时才需留意。
- **cloudflared 是两个项目共用的同一条隧道。** 不要为了 DNF 去 `net stop cloudflared` 或重装隧道，那会同时断掉原游戏的公网访问。
- **统一控制台需要两个独立控制台都在运行才能正常工作。** 统一控制台只是聚合界面，通过 iframe 嵌入两个独立控制台（8790 和 8791），并通过各自的 REST API 实现批量操作。启动顺序：先启动两个独立控制台，再启动统一控制台。

## 管理后台

生产环境必须通过环境变量设置独立的 `ADMIN_PASSWORD` 后才会提供 `/admin`。不要将该密码写入 `ai.config.json`、前端文件或版本控制。后台会话有效期为 2 小时；管理员只能编辑角色数据，所有保存均记录审计日志。上线前与每次批量调整前都应备份 `dnf.db`。

在线版 = 单 Node 进程同时提供：静态页面 + AI 端点 + SQLite 持久化 + WebSocket 匹配/副本服务。
在线化已**整合进原本的 index.html**（首次访问弹登录/注册，无需跳转其他页面）。
启动（默认 8788 端口）：

```
cd I:\DEEPSEEK\DNF
node server.js            # 或设置环境变量 PORT=8080 改端口
```

## 本机服务控制台（Windows）

### 独立控制台

控制台与游戏服务分离运行：控制器监听 `127.0.0.1:8791`，网页服务默认监听 `127.0.0.1:8788`。控制器通过子进程 IPC 管理网页服务，并把 AI 的启用状态以版本号热同步到 `server.js`。

```powershell
$env:CONTROL_PANEL_PASSWORD = '请使用独立的高强度密码'
node control-panel.js
```

或双击 `启动控制台.bat`。打开 `http://127.0.0.1:8791` 后，可执行服务器启动/停止/重启、AI 启用/停用、配置重载、连接检查与日志筛选。仅本机使用，不应通过反向代理或公网暴露控制台端口。

### 统一控制台（同时管理问道仙坊和 DNF）

如果你同时运行了问道仙坊和 DNF 两个游戏，可以使用统一控制台在一个页面中管理两个游戏的服务。

**启动步骤：**

1. 先启动问道仙坊控制台（8790）：
   ```bash
   cd I:\DEEPSEEK\tavern_clone
   双击 启动控制台.bat
   ```

2. 再启动 DNF 控制台（8791）：
   ```bash
   cd I:\DEEPSEEK\DNF
   双击 启动控制台.bat
   ```

3. 最后启动统一控制台（8792）：
   ```bash
   cd I:\DEEPSEEK\DNF
   双击 启动统一控制台.bat
   ```

浏览器会自动打开 `http://127.0.0.1:8792`，你可以：
- **批量操作**：同时启动/重启/停止两个游戏的服务器
- **独立控制**：每个游戏都嵌入了完整的独立控制台界面，可单独操作
- **状态监控**：实时显示两个控制台的连接状态

详细使用说明见 [`统一控制台使用说明.md`](统一控制台使用说明.md)。

**架构：**
```
统一控制台 (8792)
├─ iframe: 问道仙坊控制台 (8790)
│   └─ 管理 问道仙坊游戏服务 (8787)
└─ iframe: DNF 控制台 (8791)
    └─ 管理 DNF 游戏服务 (8788)
```

批量操作通过直接调用各控制台的 REST API 实现（`/api/control/server/{action}`），不依赖 iframe 内部状态。

生产环境请在启动进程环境中设置配置，不要写入仓库：

```powershell
$env:ADMIN_PASSWORD = '长度足够且独立的管理员密码'
$env:AI_BASE_URL = 'https://api.deepseek.com/v1'
$env:AI_API_KEY = '新生成的 API Key'
$env:AI_MODEL = 'deepseek-chat'
$env:AI_MAX_TOKENS = '5000'
$env:AI_TEMPERATURE = '0.85'
node server.js
```

也可以复制 `.env.example` 为 `.env` 并填写一次。三个 Windows 启动脚本会自动读取该文件，因此服务器重启后无需重复输入；直接运行 `node server.js` 时请先设置环境变量。`.env` 不会被静态白名单提供，也不应提交到版本控制。

`ai.config.json` 仅保留空占位字段。旧版本或历史提交中的 API Key 应立即撤销并重新生成。静态服务采用白名单，不会对外提供 `server.js`、数据库、README 或 AI 配置文件。

- 游戏页面：http://localhost:8788/ （首次访问会弹登录/注册）

## 一、局域网联机（无需公网）

1. 防火墙放行 8788 端口（Windows Defender 防火墙 → 出入站规则 → 新增 TCP 8788）。
2. 同一局域网的伙伴用 **http://你电脑的局域网IP:8788** 访问（`ipconfig` 查 IPv4），各自注册账号。
3. 双方都在「小队」页点**单人匹配** → 服务端把他俩匹配进同一队伍 → 自动开本；若 2 分钟内人不满，服务端用 AI 道友补位开本。
   > 浏览器连 WS 会自动用同 host，无需改前端。

## 二、公网部署（对外开服）

### 方案 A：有公网 IP / 云服务器（推荐）
1. 把 `DNF` 目录上传到 VPS（或云服务器 Windows 实例直接跑）。
2. 装 Node.js（≥22，支持内置 `node:sqlite`）与 `npm`，在目录内 `npm install`（拉取 `ws`）。
3. 用反向代理暴露 8788（Nginx/Caddy），并配 HTTPS：

   **Nginx 示例**：
   ```nginx
   server {
     listen 443 ssl http2;
     server_name your.domain.com;
     ssl_certificate     /etc/letsencrypt/live/your.domain.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;

     location / {
       proxy_pass http://127.0.0.1:8788;
       proxy_http_version 1.1;
       # WebSocket 升级（房间实时剧情必需）
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```
   HTTPS 证书可用 Let's Encrypt（certbot）。前端 WS 会自动走 `wss://`（代码按 `location.protocol` 自动选 ws/wss）。

4. 后台常驻运行（生产）：
   - **Windows 服务器**：用 `pm2-windows-startup` 或 NSSM 把 `node server.js` 注册为系统服务开机自启。
   - **Linux VPS**：`npm i -g pm2 && pm2 start server.js --name dnf && pm2 save && pm2 startup`。

### 方案 B：无公网 IP（内网穿透，临时测试）
用 frp / ngrok / cloudflared 将本机 8788 端口穿透到公网（注意 `ws/wss` 需穿透 TCP，frp 隧道可同时代理 HTTP+WS）。

## 三、多副本并发与 AI 限流

- 每个副本每步调用一次 AI（`/api/ai/story`）。多个副本同时推进会并发打 AI 接口。
- 若 AI 服务有 RPM/QPS 限制，可：
  1. 限制同时进行副本数（`ROOMS` 上限 / 匹配队列并发）；
  2. 在 server.js 的 `callAIStory` 前加简单令牌桶（如每秒最多 N 次）排队。
- 当前每步 AI 约 15~45s；副本为完整设计（10~40 段），单局约 15 分钟~30 分钟（视段数）——生成时长不做缩短，与单机体验一致。

## 四、数据与安全

- 数据在 `dnf.db`（SQLite）：账号（密码 scrypt 加盐哈希）、会话、角色、日志。
- 备份：直接拷贝 `dnf.db`（停服或冷备更稳妥）。
- 上线前建议：调强密码策略、加登录限速（防爆破）、可选加注册验证码/邀请码。

## 五、架构一览

```
index.html + online.js（登录层 + 匹配/观看播放）
   ├─HTTP─→ /api/auth/* /api/me /api/character* /api/log /api/creation
   └─WS───→ /ws   （match_start/match_cancel / dungeon_started / step / settled 广播）
server.js = http 静态 + AI 端点 + SQLite(db.js) + 副本权威引擎(game-engine.js) + 匹配队列
```
