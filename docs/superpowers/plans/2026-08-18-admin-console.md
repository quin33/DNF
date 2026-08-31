# 后台管理系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为游戏提供受独立管理员密码保护的后台页面，用于安全检索和编辑所有玩家的角色数据。

**Architecture:** 由 `server.js` 提供独立 `/admin` 静态页面与 `/api/admin/*` JSON API，`db.js` 管理管理员会话、角色查询、乐观锁保存和审计记录。`admin.html` 不直接操作 SQLite，仅通过管理员 Bearer 令牌调用 API。

**Tech Stack:** Node.js 内置 `http`、`crypto`、`node:sqlite`、原生 HTML/CSS/JavaScript、Node 内置测试运行器。

**Spec:** `docs/superpowers/specs/2026-08-18-admin-console-design.md`

## Global Constraints

- 管理员密码只读取 `ADMIN_PASSWORD` 环境变量，不写入数据库、配置文件或前端。
- 管理员会话有效期固定为 2 小时；普通玩家会话不得访问 `/api/admin/*`。
- 后台只修改角色白名单字段，不提供删除、账号密码、玩家会话或日志编辑功能。
- 所有保存使用参数化 SQL、服务端数据校验和 `updated_at` 乐观锁。
- 每次成功保存必须写入前后数据摘要审计日志。
- 不新增第三方运行时依赖。

---

### Task 1: 管理员会话与审计数据库层

**Files:**
- Modify: `db.js:18-41`
- Modify: `db.js:44-129`
- Create: `test/admin-db.test.js`

**Interfaces:**
- Produces: `createAdminSession(token)`, `adminSessionValid(token)`, `deleteAdminSession(token)`。
- Produces: `searchPlayers(query)`, `getCharacterAdmin(charId)`, `saveCharacterAdmin(charId, expectedUpdatedAt, data)`。
- Produces: `addAdminAuditLog({ characterId, userId, before, after })`, `getAdminAuditLogs(charId)`。

- [ ] **Step 1: Write the failing database tests**

```js
test('admin sessions expire after two hours', () => {
  DB.createAdminSession('token-a');
  assert.equal(DB.adminSessionValid('token-a'), true);
  DB.db.prepare('UPDATE admin_sessions SET expires_at = 0 WHERE token = ?').run('token-a');
  assert.equal(DB.adminSessionValid('token-a'), false);
});

test('admin save rejects an outdated character version', () => {
  const character = fixtureCharacter();
  const saved = DB.saveCharacterAdmin(character.id, character.updated_at - 1, character.data);
  assert.equal(saved, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/admin-db.test.js`

Expected: failure because the administrator tables and exported functions do not exist.

- [ ] **Step 3: Add SQLite tables and session helpers**

```js
const ADMIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function createAdminSession(token) {
  const now = Date.now();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?,?,?)')
    .run(token, now, now + ADMIN_SESSION_TTL_MS);
}

function adminSessionValid(token) {
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return false;
  return true;
}
```

Create `admin_sessions` and `admin_audit_logs` with `CREATE TABLE IF NOT EXISTS`; delete expired tokens when checked.

- [ ] **Step 4: Add player search, admin character lookup, and optimistic save**

```js
function saveCharacterAdmin(charId, expectedUpdatedAt, data) {
  const now = Date.now();
  const result = db.prepare(
    'UPDATE characters SET data = ?, name = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
  ).run(JSON.stringify(data), data.name, now, charId, expectedUpdatedAt);
  return result.changes === 1 ? { updated_at: now } : null;
}
```

Make `getCharacterAdmin` join the owning username. Make `searchPlayers` query usernames and character names with a parameterized `LIKE` value and return only list summaries.

- [ ] **Step 5: Record and read audit entries**

```js
function addAdminAuditLog({ characterId, userId, before, after }) {
  db.prepare('INSERT INTO admin_audit_logs (user_id, character_id, created_at, before_data, after_data) VALUES (?,?,?,?,?)')
    .run(userId, characterId, Date.now(), JSON.stringify(before), JSON.stringify(after));
}
```

Store only the white-listed role snapshot in `before_data` and `after_data`.

- [ ] **Step 6: Run database tests to verify they pass**

Run: `node --test test/admin-db.test.js`

Expected: session expiry, player lookup, version conflict, save, and audit assertions pass.

### Task 2: 管理员认证、校验与 HTTP API

**Files:**
- Modify: `server.js:48-65`
- Modify: `server.js:208-328`
- Modify: `server.js:406-585`
- Create: `test/admin-api.test.js`

**Interfaces:**
- Consumes: Task 1 database helpers.
- Produces: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/players`, `GET /api/admin/characters/:id`, `PUT /api/admin/characters/:id`, `GET /api/admin/audit`.
- Produces: `sanitizeAdminCharacter(input, existing)` that returns only valid white-listed role data or throws an input error.

- [ ] **Step 1: Write failing API tests**

```js
test('admin endpoints reject a player session', async () => {
  const response = await request('/api/admin/players', { authorization: 'Bearer player-token' });
  assert.equal(response.status, 401);
});

test('admin save ignores fields outside the character whitelist', async () => {
  const response = await adminRequest('PUT', '/api/admin/characters/1', {
    updated_at: 123,
    character: { name: '测试', user_id: 999, pass_hash: 'forbidden' },
  });
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `node --test test/admin-api.test.js`

Expected: failure because no administrator routes or authorization guard exist.

- [ ] **Step 3: Implement environment-only administrator authentication**

```js
function adminConfigured() { return Boolean(process.env.ADMIN_PASSWORD); }
function adminToken(req) { return bearerToken(req); }
function requireAdmin(req, res) {
  if (!adminConfigured() || !DB.adminSessionValid(adminToken(req))) {
    sendJSON(res, 401, { error: '无管理员权限' });
    return false;
  }
  return true;
}
```

Compare login passwords with `crypto.timingSafeEqual` after UTF-8 buffers are length-checked. Generate the session token with the existing `newToken()` helper.

- [ ] **Step 4: Implement character white-list validation**

```js
const ADMIN_CHARACTER_FIELDS = new Set([
  'name', 'character_class', 'level', 'hp', 'max_hp', 'stamina', 'max_stamina',
  'strength', 'agility', 'intelligence', 'luck', 'gold', 'exp',
  'traits', 'equipment', 'bag', 'skills', 'skillPool',
]);
```

Copy only these fields into a clone of the existing character. Reject unknown submitted fields, non-finite numbers, negative resource values, `hp > max_hp`, `stamina > max_stamina`, malformed arrays, oversized text, and more than 100 inventory entries.

- [ ] **Step 5: Register all protected routes and static admin page**

Add exact routing before generic static handling. Return `409` on an `updated_at` mismatch, `400` on invalid input, `404` for missing characters, and `401` for any failed administrator authorization. Serve `/admin` as `admin.html` only when `ADMIN_PASSWORD` is configured.

- [ ] **Step 6: Run API tests to verify they pass**

Run: `node --test test/admin-api.test.js`

Expected: login, authorization rejection, player search, safe save, invalid input rejection, conflict, and audit route assertions pass.

### Task 3: 独立后台页面

**Files:**
- Create: `admin.html`
- Create: `admin.css`
- Create: `admin.js`
- Modify: `server.js:32-46`
- Create: `test/admin-page.test.js`

**Interfaces:**
- Consumes: Task 2 REST API and Bearer administrator token.
- Produces: browser UI at `/admin` for search, role edit, save, logout, and audit viewing.

- [ ] **Step 1: Write the failing page-output test**

```js
test('admin page is served only when administrator access is configured', async () => {
  const response = await fetch('http://127.0.0.1:8787/admin');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="admin-login"/);
  assert.match(html, /id="player-search"/);
});
```

- [ ] **Step 2: Run the page test to verify it fails**

Run: `node --test test/admin-page.test.js`

Expected: failure because `/admin` and its login/search controls do not exist.

- [ ] **Step 3: Build the administration shell and login state**

Create a two-column operations page with a login screen, player search panel, role editor, audit list, logout button, loading state, and error messages. Store the administrator token only in `sessionStorage` under `tavern_admin_token`; clear it on logout and any `401` response.

- [ ] **Step 4: Build the role editor with explicit field groups**

Render basic identity, progression/resources, four attributes, traits, equipment, bag, skills, and skill pool. Use number inputs for scalar values and JSON textareas for arrays. Keep the server-provided `updated_at` value in memory and send it with every save request.

- [ ] **Step 5: Add client-side validation and change preview**

Reject invalid JSON arrays and non-numeric numeric fields before issuing `PUT`. Before saving, show a plain summary of modified fields. On `409`, preserve unsaved form content and display a reload action; on successful save, replace the form state and refresh audit entries.

- [ ] **Step 6: Run the page test to verify it passes**

Run: `node --test test/admin-page.test.js`

Expected: configured server returns the page containing the required management controls.

### Task 4: 集成回归与运行文档

**Files:**
- Modify: `package.json:6-10`
- Modify: `DEPLOY.md`
- Modify: `README.md`
- Modify: `test/app-shell.test.js` only if server startup fixture must include `ADMIN_PASSWORD`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: one command for all regression tests and deployment instructions for administrator setup.

- [ ] **Step 1: Add the complete test command**

Set the package test script to `node --test test/*.test.js` so the existing page/feed tests and all administrator tests run together.

- [ ] **Step 2: Document administrator setup and recovery**

Document `ADMIN_PASSWORD` configuration for PowerShell and production environments, `/admin` access, 2-hour expiry, lack of delete operations, and the requirement to back up `tavern.db` before administrative changes. Do not put an example real password in documentation.

- [ ] **Step 3: Run the full regression suite**

Run: `npm test`

Expected: all existing and administrator tests pass with no warnings.

- [ ] **Step 4: Run syntax and health checks**

Run: `node --check server.js`

Run: `node --check admin.js`

Run: `curl http://127.0.0.1:8787/api/health`

Expected: both scripts parse successfully and the existing health endpoint returns an `ok: true` response.

## Self-Review

- Spec coverage: Tasks 1-2 implement independent admin sessions, protected APIs, white-list validation, optimistic locking, and audit storage. Task 3 implements the required browser workflow. Task 4 supplies the requested setup and complete verification.
- Placeholder scan: no unassigned tasks or unspecified validation paths remain.
- Type consistency: API field names use the same `updated_at`, `character`, `characterId`, `ADMIN_PASSWORD`, and Bearer-token conventions across all tasks.
