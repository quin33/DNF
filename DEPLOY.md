# DNF · 在线版部署指南

## 端口与实例隔离（重要）

本机同时跑着两个独立实例，端口、数据库、公网域名全部分开：

| 项目 | 目录 | 游戏服务 | 控制台 | 统一控制台 | 数据库 | 公网地址 |
| --- | --- | --- | --- | --- | --- | --- |
| 问道仙坊（原游戏） | `I:\DEEPSEEK\tavern_clone` | 8787 | 8790 | — | `tavern.db` | `xiuxiangame.dpdns.org/xiuxian/` |
| DNF（本项目） | `I:\DEEPSEEK\DNF` | **8788** | **8791** | — | `dnf.db` | `xiuxiangame.dpdns.org/dnf/` |
| **站点网关** | `I:\DEEPSEEK\DNF` | — | — | **8786** | — | `xiuxiangame.dpdns.org`（主域名指这里） |
| **统一控制台** | `I:\DEEPSEEK\DNF` | — | — | **8792** | — | — |

两个游戏现在挂在同一个域名的两个子路径下，由站点网关（`site-gateway.js`）分发：

```
xiuxiangame.dpdns.org/          → 导航首页（网关自己渲染）
xiuxiangame.dpdns.org/xiuxian/  → 8787
xiuxiangame.dpdns.org/dnf/      → 8788
```

网关的职责就是**剥掉 `/dnf` 这层前缀再转发**，所以两个游戏的 `server.js` 完全不用感知自己挂在哪个路径下。这一步只能由网关做 —— cloudflared 的 ingress 不支持重写路径。旧的 `dnf.xiuxiangame.dpdns.org` 仍保留直连 8788，老书签不会失效。

同域名带来一个必须注意的后果：**localStorage 按源隔离，不按路径隔离。** 两个游戏在同一个域名下共享同一份 localStorage，所以 DNF 的 13 个键全部改成了 `dnf_` 前缀。往任一侧新增 localStorage 键时，键名必须带上各自的前缀，否则会互相顶掉对方的登录态和角色数据。

**账号是两边共用的**（角色仍各自独立）：每个游戏的 `.env` 里 `ACCOUNT_MIRROR_DB` 指向另一个游戏的 SQLite 库。登录时本地没有该账号，就去镜像库验证密码并自动补建；注册时用户名在两个库里都不得重复；任一侧改密码会双向同步。镜像只做只读校验，绝不写对方的库。不想共用就把 `ACCOUNT_MIRROR_DB` 删掉，两边即退回各自注册。

管理服务有两条路，按需选一条，不要同时开：

- **统一控制台（8792）** —— 一个页面管两个游戏，自己拉起游戏服务。日常推荐，详见下文。
- **各自的独立控制台（8790 / 8791）** —— 每个游戏一个页面，沿用原来的方式。

改端口时必须三处同步：本项目 `.env`（含 `GATEWAY_PORT` 与 `GATEWAY_SITES`）、四个 `启动*.bat`、以及 `%USERPROFILE%\.cloudflared\config.yml` 的 ingress 规则。网关端口和游戏端口分别在 `.env` 与 ingress 里各出现一次，漏改一处主域名就会 502。

三条注意事项：

- **不要在同一个命令行窗口里先跑原游戏的脚本再跑 DNF 的脚本。** `server.js` 与 `control-panel.js` 读 `.env` 时只填补「尚未设置」的变量,系统环境变量优先级更高，所以窗口里残留的 `PORT` / `GAME_PORT` / `CONTROL_PANEL_PORT` 会盖掉 `.env`。DNF 的四个 `.bat` 已用 `setlocal` 隔离并显式钉死端口，双击运行不受影响；手工在同一窗口 `node server.js` 时才需留意。
- **cloudflared 是两个项目共用的同一条隧道。** 不要为了 DNF 去 `net stop cloudflared` 或重装隧道，那会同时断掉原游戏的公网访问。
- **统一控制台自己会拉起两个游戏服务，不需要前置步骤。** 它在本进程内为每个游戏建一个 supervisor 直接管子进程，与 8790 / 8791 无关。因此不要同时再运行 `启动控制台.bat` 或 `启动游戏.bat`，那会启动第二个 DNF 游戏服务、抢同一个 8788 端口。两套二选一。

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

一个页面管两个游戏，一个密码登录。双击 `启动统一控制台.bat` 即可，浏览器会自动打开 `http://127.0.0.1:8792`。

没有前置步骤 —— 统一控制台在本进程内为每个游戏建一个 supervisor，直接把两个游戏服务拉起来。相应地，**不要同时再运行 `启动控制台.bat` / `启动游戏.bat`**，否则会有第二个 DNF 服务来抢 8788。

**密码**取自环境变量，按 `UNIFIED_PANEL_PASSWORD` → `CONTROL_PANEL_PASSWORD` 顺序回退。已经设过 `CONTROL_PANEL_PASSWORD` 就直接可用；两者都没设时进程拒绝启动。会话 8 小时。

**配置**全在 `.env`（系统环境变量优先，便于临时覆盖）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UNIFIED_PANEL_PORT` | `8792` | 面板端口 |
| `UNIFIED_PANEL_HOST` | `127.0.0.1` | 监听地址，保持本机 |
| `UNIFIED_PANEL_PASSWORD` | — | 回退到 `CONTROL_PANEL_PASSWORD` |
| `UNIFIED_AUTO_START` | `true` | 启动时自动拉起游戏服务 |
| `UNIFIED_GAMES` | 问道仙坊 + DNF | 管哪几个游戏，单行 JSON 数组 |
| `UNIFIED_GATEWAY` | `false` | 是否一并拉起站点网关 |
| `GATEWAY_PORT` | `8786` | 网关端口，cloudflared 主域名指向它 |
| `GATEWAY_HOST` | `127.0.0.1` | 网关监听地址 |
| `GATEWAY_SITES` | 问道仙坊 + DNF | 路径前缀与后端端口，单行 JSON 数组 |

增删游戏或改路径只改 `UNIFIED_GAMES`，无需动代码。每项含 `id` / `name` / `dir` / `port`，可选 `entry`（默认 `server.js`）。目录不存在的游戏会在界面标出并禁用按钮，不影响其他游戏。

功能：批量启动/重启/停止；每个游戏独立启停、独立 AI 开关、配置重载与连接自检；状态 5 秒一刷；日志按游戏筛选。详细说明见 [`统一控制台使用说明.md`](统一控制台使用说明.md)。

**架构：**
```
unified-panel.js (8792)
├─ supervisor: 问道仙坊 → node server.js (8787)  cwd=tavern_clone
├─ supervisor: DNF      → node server.js (8788)  cwd=DNF
└─ supervisor: 站点网关  → node site-gateway.js (8786)   仅 UNIFIED_GATEWAY=true 时

cloudflared ──→ 8786 网关 ──┬─ /xiuxian/ → 8787
                            └─ /dnf/     → 8788
```

网关和游戏一样受面板管，关掉面板会一并关掉。**`UNIFIED_GATEWAY` 默认关闭，而 cloudflared 的主域名指向 8786** —— 部署时这两处必须同时生效，只改一处的话主域名会 502。

两个子进程各自用**干净的环境变量**启动，只注入 `PORT` 和自己的 `cwd`，各读自己目录里的 `.env`。这一点是必要的：`server.js` 只填补尚未设置的变量，继承来的值优先级更高，所以若把父进程环境整体传下去，DNF 的 `TAVERN_DB_PATH=./dnf.db` 会在问道仙坊的目录里解析，让它悄悄写进一个 `dnf.db`；`AI_API_KEY` 同理会串台。关掉统一控制台会一并关掉两个游戏服务。

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
