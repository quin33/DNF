# 本机服务控制台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows 本机增加一个独立可视化控制台，能够查看并控制网页服务器进程，以及启用、停用、重载和检查远程 AI 服务。

**Architecture:** 新增独立的 `control-panel.js` 作为控制器，监听 `127.0.0.1:8790`，通过 `service-supervisor.js` 管理 `server.js` 子进程。控制器与受管 `server.js` 使用 Node IPC 同步 AI 运行时开关；控制台页面只访问控制器 API，不接触 API Key。

**Tech Stack:** Node.js 22+、原生 HTTP、原生 HTML/CSS/JavaScript、Node `child_process`、Node IPC、现有 SQLite/HTTP 服务，不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-31-local-service-control-console-design.md`

## Global Constraints

- 仅支持 Windows 本机运行，控制器绑定 `127.0.0.1`，不提供公网或局域网控制。
- 游戏服务继续运行在 `127.0.0.1:8787` 或 `PORT` 指定端口；控制器默认使用 `127.0.0.1:8790`。
- 禁止任意 Shell、任意路径和任意环境变量写入；只允许预定义服务操作。
- API Key、Bearer Token、密码不得写入前端响应或未脱敏日志。
- AI 状态优先级：控制器状态文件覆盖值 > `.env` 的 `AI_ENABLED` > 默认值 `true`。
- 运行时 AI 状态通过带单调递增版本号的 IPC 消息同步；未收到确认不得显示“已生效”。
- 所有危险操作必须二次确认；每项服务同一时间只能执行一个生命周期操作。
- 当前工作区不是 Git 仓库，执行时以测试和运行验收作为检查点，不执行虚构的提交命令。

---

### Task 1: 进程监督器

**Files:**
- Create: `service-supervisor.js`
- Test: `test/service-supervisor.test.js`

**Interfaces:**
- Consumes: `node:path`、`node:child_process.spawn`、`fetch`、Windows `taskkill`。
- Produces:
  - `createServiceSupervisor(options)`
  - `supervisor.start()` → `Promise<Status>`
  - `supervisor.stop()` → `Promise<Status>`
  - `supervisor.restart()` → `Promise<Status>`
  - `supervisor.getStatus()` → `Status`
  - `supervisor.getLogs({ service, level, limit })` → `Array<LogEntry>`
  - `supervisor.onStatus(listener)` → `() => void`

`Status` 至少包含 `{ state, pid, port, startedAt, healthAt, managed, exitCode, error }`；状态值固定为 `stopped | starting | running | stopping | restarting | crashed | error`。

- [ ] **Step 1: Write the failing tests**

在测试文件顶部定义 `createFakeProcess(options)` 夹具：返回 `{ pid: 4321, spawn, healthCheck, releaseStop }`；`spawn()` 返回带 `pid`、`stdout`、`stderr`、`on()`、`kill()` 和 `send()` 的假子进程，`healthCheck()` 按 `options.health` 顺序返回布尔值，`holdStop` 为真时由 `releaseStop()` 释放停止 Promise。夹具不得调用真实 `taskkill`。

```js
test('starts server, waits for health, and exposes managed pid', async () => {
  const fake = createFakeProcess({ health: [false, true] });
  const supervisor = createServiceSupervisor({ spawnImpl: fake.spawn, healthCheck: fake.healthCheck });
  const status = await supervisor.start();
  assert.equal(status.state, 'running');
  assert.equal(status.managed, true);
  assert.equal(status.pid, fake.pid);
});

test('rejects a second lifecycle operation while restarting', async () => {
  const fake = createFakeProcess({ holdStop: true });
  const supervisor = createServiceSupervisor({ spawnImpl: fake.spawn, healthCheck: fake.healthCheck });
  const first = supervisor.restart();
  await assert.rejects(() => supervisor.restart(), error => error.code === 'operation_in_progress');
  fake.releaseStop();
  await first;
});

test('does not kill an unknown process occupying the port', async () => {
  const supervisor = createServiceSupervisor({ port: 8787, findPortOwner: async () => ({ pid: 777 }) });
  await assert.rejects(() => supervisor.start(), error => error.code === 'port_occupied');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/service-supervisor.test.js`

Expected: FAIL because `service-supervisor.js` and `createServiceSupervisor` do not exist.

- [ ] **Step 3: Implement the supervisor state machine**

实现 `createServiceSupervisor({ rootDir, serverScript, port = 8787, host = '127.0.0.1', spawnImpl = spawn, healthCheck, findPortOwner, now = Date.now })`。启动时使用：

```js
spawnImpl(process.execPath, [serverScript], {
  cwd: rootDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
});
```

实现 `start/stop/restart` 串行锁；默认健康检查 30 次、每次间隔 250ms；停止先等待 3 秒，超时才调用 `taskkill /PID <pid> /T /F`。未知端口进程只报告 `port_occupied`，不得杀死。收集 stdout/stderr 脱敏后写入内存环形日志。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/service-supervisor.test.js`

Expected: all supervisor tests PASS。

- [ ] **Step 5: Run syntax verification**

Run: `node --check service-supervisor.js`

Expected: exit code 0。

### Task 2: 运行时状态与控制器 API

**Files:**
- Create: `control-runtime.js`
- Create: `control-panel.js`
- Create: `test/control-panel.test.js`

**Interfaces:**
- `control-runtime.js` produces:
  - `loadRuntimeState(filePath, env)` → `{ aiEnabled, version, updatedAt }`
  - `saveRuntimeState(filePath, state)` → `void`
  - `redact(value)` → `string`
- `control-panel.js` produces `createControlPanel(options)` with `start()` and `close()`。
- API 返回统一结构：`{ ok, operationId, status, message, updatedAt }`。

- [ ] **Step 1: Write failing tests for state precedence and redaction**

在测试文件中使用 `fs.mkdtempSync(path.join(os.tmpdir(), 'control-runtime-'))` 创建临时目录，令 `stateFile = path.join(tempDir, 'runtime-state.json')`；第二个断言前用 `fs.writeFileSync(stateFile, JSON.stringify({ aiEnabled: true, version: 4 }))` 写入持久化状态，不使用未定义的外部 helper。

```js
test('runtime state uses persisted override before env and default', () => {
  assert.equal(loadRuntimeState('missing.json', { AI_ENABLED: '0' }).aiEnabled, false);
  fs.writeFileSync(stateFile, JSON.stringify({ aiEnabled: true, version: 4 }));
  assert.equal(loadRuntimeState(stateFile, { AI_ENABLED: '0' }).aiEnabled, true);
});

test('redaction hides provider secrets and bearer tokens', () => {
  const safe = redact('AI_API_KEY=secret Bearer abc123 password=hello');
  assert.doesNotMatch(safe, /secret|abc123|hello/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/control-panel.test.js`

Expected: FAIL because runtime state helpers and the controller do not exist.

- [ ] **Step 3: Implement runtime state persistence**

状态文件只保存：

```json
{
  "aiEnabled": true,
  "version": 1,
  "updatedAt": 0,
  "lastOperation": null
}
```

使用临时文件写入后替换，避免控制器中途退出造成半写入；读取损坏文件时回退到 `.env`，并记录脱敏错误。

- [ ] **Step 4: Implement localhost controller API**

控制器默认监听 `127.0.0.1:8790`，路由固定为：

```text
GET  /api/control/health
GET  /api/control/status
GET  /api/control/logs
POST /api/control/server/start
POST /api/control/server/stop
POST /api/control/server/restart
POST /api/control/ai/toggle       { enabled: boolean }
POST /api/control/ai/reload
POST /api/control/ai/check
```

所有 POST 必须验证本机地址、会话令牌、Origin 和 CSRF 令牌。`server/*` 委托给 `service-supervisor`；AI 操作递增状态版本、写状态文件，并向受管子进程发送：

```js
child.send({ type: 'runtime_config', version, aiEnabled });
```

只有收到 `{ type: 'runtime_config_ack', version }` 才返回 `ok: true`；未接管的外部进程返回 `409 service_unmanaged`。

- [ ] **Step 5: Run focused tests**

Run: `node --test test/control-panel.test.js`

Expected: state precedence, redaction, auth, duplicate-operation and API response tests PASS。

- [ ] **Step 6: Run syntax verification**

Run: `node --check control-runtime.js; node --check control-panel.js`

Expected: exit code 0。

### Task 3: 游戏服务器接入 AI 运行时配置与 IPC

**Files:**
- Modify: `server.js:27-55, 534-590, 2127-2132`
- Test: `test/runtime-ai-control.test.js`

**Interfaces:**
- `server.js` produces `getRuntimeAiStatus()` → `{ enabled, configured, reachable, model, lastCheckedAt, lastError, version }`。
- `server.js` listens for `{ type: 'runtime_config', version, aiEnabled }` and sends `{ type: 'runtime_config_ack', version }`。
- `callLLM()` must reject before network access when `enabled === false`，错误码为 `ai_disabled`。

- [ ] **Step 1: Write failing tests**

测试文件顶部定义 `startHealthFixture()`：使用 `child_process.spawn(process.execPath, ['server.js'], { cwd: repoRoot, env: { ...process.env, PORT: String(port), TAVERN_LOAD_ENV: '0', AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })` 启动临时端口，轮询 `/api/health`，返回 `{ base, child, stop }`；`stop()` 必须终止子进程并等待 `exit`。

```js
test('disabled runtime AI rejects before provider access', async () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /ai_disabled/);
  assert.match(server, /process\.on\(['"]message['"]/);
});

test('health exposes runtime AI state without secrets', async () => {
  const fixture = await startHealthFixture();
  try {
    const response = await (await fetch(`${fixture.base}/api/health`)).json();
    assert.equal(typeof response.ai.enabled, 'boolean');
    assert.equal(response.ai.apiKey, undefined);
  } finally {
    await fixture.stop();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/runtime-ai-control.test.js`

Expected: FAIL because `server.js` currently has only startup-time `isConfigured` and no IPC runtime state.

- [ ] **Step 3: Implement runtime AI state**

将静态 `isConfigured` 拆为配置对象与运行时状态对象；启动时读取环境变量，默认 `enabled=true`。实现版本比较：当收到的 IPC `version` 不大于当前版本时忽略；成功应用后回传 ACK。`callLLM()` 先检查运行时开关，再检查配置完整性，确保停用时不创建 `fetch` 请求。

将 `/api/health` 扩展为：

```json
{
  "ok": true,
  "configured": true,
  "model": "deepseek-chat",
  "ai": {
    "enabled": true,
    "configured": true,
    "reachable": null,
    "model": "deepseek-chat",
    "lastCheckedAt": 0,
    "lastError": "",
    "version": 1
  }
}
```

不返回 `AI_API_KEY`、完整请求头或环境变量。

- [ ] **Step 4: Run focused tests**

Run: `node --test test/runtime-ai-control.test.js`

Expected: all runtime AI tests PASS。

- [ ] **Step 5: Run existing server tests**

Run: `node --test test/ai*.test.js test/security*.test.js`

Expected: existing AI/security tests remain PASS。

### Task 4: 控制台前端

**Files:**
- Create: `control-panel.html`
- Create: `control-panel.css`
- Create: `control-panel-ui.js`
- Test: `test/control-panel-ui.test.js`

**Interfaces:**
- 页面调用 `GET /api/control/status`、`GET /api/control/logs` 和固定 POST API。
- UI 状态对象字段与 `service-supervisor` 的 `Status`、AI 状态保持一致。
- 所有操作按钮暴露 `data-action`，供事件委托和测试使用。

- [ ] **Step 1: Write failing markup tests**

```js
test('control panel exposes server and AI operations', () => {
  const html = fs.readFileSync('control-panel.html', 'utf8');
  for (const action of ['server-start', 'server-stop', 'server-restart', 'ai-toggle', 'ai-reload', 'ai-check']) {
    assert.match(html, new RegExp(`data-action=["']${action}`));
  }
  assert.match(html, /127\.0\.0\.1:8787/);
  assert.match(html, /运行日志/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/control-panel-ui.test.js`

Expected: FAIL because the control panel files do not exist.

- [ ] **Step 3: Implement the UI**

使用紧凑运维布局：顶部总览、网页服务器卡片、AI 卡片、日志表格。按钮点击先显示确认层，再发送请求；操作进行中禁用同类按钮并显示固定状态文本。每 2 秒刷新状态，日志按服务和级别筛选。页面不渲染任何密钥字段，并使用 `textContent` 写入错误文本。

- [ ] **Step 4: Run UI tests**

Run: `node --test test/control-panel-ui.test.js`

Expected: markup and client action tests PASS。

- [ ] **Step 5: Run syntax verification**

Run: `node --check control-panel-ui.js`

Expected: exit code 0。

### Task 5: 启动入口与控制器集成

**Files:**
- Create: `启动控制台.bat`
- Modify: `启动游戏.bat`
- Modify: `启动后台.bat`
- Modify: `README.md`
- Modify: `DEPLOY.md`
- Test: `test/control-panel-integration.test.js`

**Interfaces:**
- `启动控制台.bat` 启动 `node control-panel.js`，控制器再负责启动 `server.js`。
- 直接运行 `node server.js` 仍可工作，但不具备控制台热切换能力。
- 控制台首页地址为 `http://127.0.0.1:8790`。

- [ ] **Step 1: Write failing integration tests**

在测试文件顶部定义 `startControllerFixture()`：申请两个临时端口，使用 `spawn(process.execPath, ['control-panel.js'], { cwd: repoRoot, env: { ...process.env, CONTROL_PANEL_PORT: String(controlPort), GAME_PORT: String(gamePort), CONTROL_PANEL_PASSWORD: 'test-password', TAVERN_LOAD_ENV: '0', AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '' }, stdio: ['ignore', 'ignore', 'pipe'] })` 启动控制器；轮询控制器 `/api/control/health`，返回 `{ base, child, stop }`。`stop()` 先请求受控服务停止，再终止控制器并等待两个进程的 `exit`，测试结束后确认临时端口均已释放。

```js
test('controller serves UI and starts a healthy game server', async t => {
  const fixture = await startControllerFixture();
  t.after(() => fixture.stop());
  assert.equal((await fetch(`${fixture.base}/api/control/health`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/`)).status, 200);
  const status = await (await fetch(`${fixture.base}/api/control/status`)).json();
  assert.equal(status.server.state, 'running');
});

test('server restart keeps controller reachable', async t => {
  const fixture = await startControllerFixture();
  t.after(() => fixture.stop());
  const response = await fetch(`${fixture.base}/api/control/server/restart`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${fixture.base}/api/control/health`)).status, 200);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/control-panel-integration.test.js`

Expected: FAIL because no controller entry point or launcher exists.

- [ ] **Step 3: Implement launcher integration**

`启动控制台.bat` 先检测 `8790`，已运行则直接打开页面；未运行则在最小化窗口启动控制器。`启动游戏.bat` 改为优先启动控制器并打开 `8790`，保留检测 `8787` 的兼容分支。README 和 DEPLOY 增加本机控制台入口、默认端口、AI 开关语义和“AI 重启=配置重载”的说明。

- [ ] **Step 4: Run integration tests**

Run: `node --test test/control-panel-integration.test.js`

Expected: controller, child server startup, restart and health checks PASS。

### Task 6: 全量验证与运行验收

**Files:**
- Modify: `server.js`, `service-supervisor.js`, `control-runtime.js`, `control-panel.js`, `control-panel-ui.js`, `启动控制台.bat`, `启动游戏.bat`, `启动后台.bat`, `README.md`, `DEPLOY.md`
- Test: `test/*.test.js`

- [ ] **Step 1: Run all syntax checks**

Run: `node --check server.js; node --check service-supervisor.js; node --check control-runtime.js; node --check control-panel.js; node --check control-panel-ui.js`

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: zero failed tests and no unhandled process left listening on `8787` or `8790` after teardown。

- [ ] **Step 3: Perform manual Windows acceptance**

1. Run `启动控制台.bat`。
2. Open `http://127.0.0.1:8790`。
3. Confirm server PID, port and health state。
4. Restart the game server and confirm the control panel stays available。
5. Disable AI and confirm `/api/health` reports `ai.enabled=false`。
6. Reload AI configuration and confirm the model name updates without exposing the API Key。
7. Stop the controller and verify it does not kill an unrelated process occupying another port。

- [ ] **Step 4: Final verification report**

Report exact test counts, syntax-check exit codes, controller URL, managed server PID behavior, and any residual limitations such as an externally started unmanaged `server.js` requiring one restart before IPC control is available。
