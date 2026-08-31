# 聚灵台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server-authoritative 聚灵台 facility for timed cultivation and breakthrough progression.

**Architecture:** Persist an optional `cultivation` object and a numeric `breakthroughBonus` within each existing character data JSON object. Add pure server helpers to settle elapsed time, evolve EXP, and finalize breakthroughs; HTTP endpoints call those helpers and save with optimistic concurrency. The browser renders the facility and refreshes server data after every action while a local visual timer counts down.

**Tech Stack:** Node.js HTTP server, SQLite character storage through `db.js`, browser JavaScript/HTML/CSS, WebSocket notifications, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-08-19-juling-platform-design.md`

## Global Constraints

- Cultivation duration is whole hours only, from 1 through 24.
- Charge 100 spirit stones per selected cultivation hour when it starts; early exit never refunds the charge.
- Award 50 EXP for each complete 30-minute interval and retain incomplete intervals until a later settlement.
- A level-10 character's EXP cannot exceed 1000 through cultivation.
- Breakthrough requires `level === 10 && exp >= 1000`, lasts exactly two hours, and cannot be ended early.
- Breakthrough success chance is `min(1, 0.5 + breakthroughBonus)`; each failure clears EXP and adds 0.1, success clears the bonus.
- Server-side state is authoritative; clients may only display countdowns and must not determine rewards or breakthrough results.
- Do not add dependencies or a periodic process-wide scan; settle on character reads and 聚灵台 actions.

---

### Task 1: Server-Side Cultivation Domain Helpers

**Files:**
- Modify: `server.js: before handleAuthAPI`
- Test: `test/admin-api.test.js: add focused HTTP tests near character API coverage`

**Interfaces:**
- Produces `settleCultivation(role, now, randomFn)` returning `{ changed, event }` where `event` is `null`, `{ type: 'cultivation_completed', expAwarded }`, `{ type: 'breakthrough_success', chance }`, or `{ type: 'breakthrough_failed', chance, bonus }`.
- Produces `applyCultivationExp(role, amount)` which updates EXP, level, realm, HP, and max HP with the same level-1-to-10 thresholds already used by online room settlement.
- Consumes `role.cultivation` and `role.breakthroughBonus`; preserves all unrelated role fields.

- [ ] **Step 1: Write failing cultivation settlement tests**

```js
test('cultivation settlement grants only complete half-hours and is idempotent', async () => {
  const before = DB.getCharacterAdmin(characterId);
  const start = Date.now() - 61 * 60 * 1000;
  const role = {
    ...before.data,
    exp: 0,
    cultivation: { mode: 'cultivate', startedAt: start, endsAt: start + 3 * 3600_000, lastSettledAt: start, spentGold: 300 },
  };
  const seeded = await adminRequest('PUT', `/api/admin/characters/${characterId}`, {
    updated_at: before.updated_at, character: role,
  });
  assert.equal(seeded.status, 200);

  const first = await playerRequest('GET', `/api/character/${characterId}`);
  assert.equal(first.body.character.exp, 100);
  const second = await playerRequest('GET', `/api/character/${characterId}`);
  assert.equal(second.body.character.exp, 100);
});
```

- [ ] **Step 2: Run the new settlement test and verify it fails**

Run: `node --test test/admin-api.test.js --test-name-pattern="cultivation settlement"`

Expected: FAIL because the current character read does not settle `cultivation`.

- [ ] **Step 3: Implement the pure settlement and EXP helpers**

```js
function applyCultivationExp(role, amount) {
  role.exp = Number(role.exp || 0) + amount;
  while (role.level < 10 && role.exp >= role.level * 100) {
    role.exp -= role.level * 100;
    role.level += 1;
    role.max_hp = Number(role.max_hp || 100) + 10;
    role.character_class = realmForLevel(role.level);
    role.hp = Math.min(Number(role.hp || 0) + 40, role.max_hp);
  }
  if (role.level >= 10) role.exp = Math.min(role.exp, 1000);
}

function settleCultivation(role, now = Date.now(), randomFn = Math.random) {
  // Process completed half-hours once, then finish cultivation or resolve a due breakthrough once.
}
```

Use server-local `realmForLevel` mapping or a small equivalent helper instead of relying on browser globals. For a cultivation completion, settle through `min(now, endsAt)`, then delete `role.cultivation` and restore `role.status = 'resting'`. For breakthrough completion, delete `role.cultivation` before evaluating the roll so a second call cannot repeat it. In test-only startup, parse `CULTIVATION_RANDOM` as a number from 0 through 1 and pass `() => configuredValue` to settlement; production leaves it unset and uses `Math.random`.

- [ ] **Step 4: Run the focused server test and verify it passes**

Run: `node --test test/admin-api.test.js --test-name-pattern="cultivation settlement"`

Expected: PASS.

- [ ] **Step 5: Commit the completed helper and test changes**

Project currently has no Git repository. Record this task as complete in this plan instead of running a Git commit.

### Task 2: Authorized 聚灵台 API and Party Mutual Exclusion

**Files:**
- Modify: `server.js: handleAuthAPI character route section and room WebSocket handlers`
- Modify: `test/admin-api.test.js: character API and room tests`

**Interfaces:**
- Consumes `settleCultivation(role, now, randomFn)` from Task 1.
- Produces authenticated routes:
  - `POST /api/character/:id/cultivation/start` with `{ updated_at, hours }`
  - `POST /api/character/:id/cultivation/exit` with `{ updated_at }`
  - `POST /api/character/:id/breakthrough/start` with `{ updated_at }`
- Every successful mutation returns `{ character, updated_at, event }` and calls `notifyCharacterUpdated(userId, characterId, updated_at)`.

- [ ] **Step 1: Write failing API and mutual-exclusion tests**

```js
test('cultivation start charges upfront and rejects invalid hours or insufficient gold', async () => {
  const current = await playerRequest('GET', `/api/character/${characterId}`);
  const started = await playerRequest('POST', `/api/character/${characterId}/cultivation/start`, {
    updated_at: current.body.updated_at, hours: 3,
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.character.gold, current.body.character.gold - 300);
  assert.equal(started.body.character.status, 'cultivating');
  assert.equal(started.body.character.cultivation.mode, 'cultivate');
});

test('breakthrough failure stacks bonus and success clears it at a capped chance', async () => {
  // Test server starts with CULTIVATION_RANDOM=0.99.
  // Seed level 10 / exp 1000, resolve a due attempt, and verify failure: exp 0 and bonus +0.1.
  // Repeat to 0.5 bonus, then resolve one due attempt at 100% chance and verify level 11 and cleared bonus.
});

test('cultivating character cannot create or join a public room', async () => {
  // Start cultivation, send room_create and room_join over the existing authenticated WebSocket helpers,
  // then assert each receives an error and no room membership changes.
});
```

- [ ] **Step 2: Run the focused API tests and verify they fail**

Run: `node --test test/admin-api.test.js --test-name-pattern="cultivation start|breakthrough failure|cultivating character"`

Expected: FAIL with unknown API route or missing state validation.

- [ ] **Step 3: Implement API validation, saves, and WebSocket restrictions**

```js
function cultivationBlockedReason(role) {
  if (role.cultivation) return '角色正在闭关';
  if (role.status === 'in_party' || role.status === 'adventuring') return '角色当前无法闭关';
  return '';
}

function saveSettledCharacter(userId, characterId, record) {
  const changed = settleCultivation(record.data);
  if (!changed.changed) return record;
  const saved = DB.saveCharacter(userId, characterId, record.data, record.data.name);
  notifyCharacterUpdated(userId, characterId, saved.updated_at);
  return { ...record, data: record.data, updated_at: saved.updated_at };
}
```

Validate ownership, current version, integer duration range, gold, idle eligibility, and level/EXP breakthrough eligibility on every request. Update the test `startServer` helper to launch with `CULTIVATION_RANDOM: '0.99'`; production startup remains unchanged. Before every public room create/join/start handler, load the requested character, settle it, and reject `cultivating` or `breaking_through` roles with a Chinese error message. Before starting cultivation or breakthrough, reject any character in a waiting room in addition to its stored status.

- [ ] **Step 4: Run the focused API tests and verify they pass**

Run: `node --test test/admin-api.test.js --test-name-pattern="cultivation start|breakthrough failure|cultivating character"`

Expected: PASS.

- [ ] **Step 5: Commit the completed API and test changes**

Project currently has no Git repository. Record this task as complete in this plan instead of running a Git commit.

### Task 3: Character Reads, Client Synchronization, and Building Data

**Files:**
- Modify: `server.js: GET /api/character/:id route`
- Modify: `data.js: buildings array`
- Modify: `online.js: refreshOnlineRoles and public-room action entry points`
- Modify: `index.html: statusText and renderBuilding`
- Test: `test/admin-api.test.js: character read completion and WebSocket notification tests`

**Interfaces:**
- Consumes Task 1 `settleCultivation` and Task 2 save/notification helper.
- Produces a persisted `GET /api/character/:id` view whose returned character has all due cultivation or breakthrough completion applied.
- Produces building data `{ code: 'spirit_platform', name: '聚灵台', icon: '☯', category: '修炼', status: 'built' }` and calls `openSpiritPlatformModal()` from its card.

- [ ] **Step 1: Write failing character-read and status tests**

```js
test('a character read finalizes a completed breakthrough exactly once and notifies the owner', async () => {
  // Seed a due breakthrough with level 10, exp 1000, breakthroughBonus 0.5,
  // and use the test server's CULTIVATION_RANDOM=0.99 to force the 100% success case.
  // GET the character twice, assert level 11 / 筑基前期 / cleared bonus in both responses,
  // and assert one character_updated message for the saved transition.
});
```

- [ ] **Step 2: Run the focused completion test and verify it fails**

Run: `node --test test/admin-api.test.js --test-name-pattern="character read finalizes"`

Expected: FAIL because character reads currently only return stored JSON.

- [ ] **Step 3: Settle on reads and prevent stale client writes**

```js
if (req.method === 'GET') {
  const record = DB.getCharacter(u.id, charId);
  const settled = saveSettledCharacter(u.id, charId, record);
  sendJSON(res, 200, { id: settled.id, character: settled.data, updated_at: settled.updated_at });
  return true;
}
```

Add `cultivating` and `breaking_through` to the global status-text mapping. In `online.js`, make room creation/join/start surface a server rejection without optimistically changing the local role. Preserve incoming `cultivation` and `breakthroughBonus` during normal `saveRole` traffic; on conflict, retain the existing `refreshOnlineRoles()` path.

- [ ] **Step 4: Run the focused completion test and syntax checks**

Run: `node --test test/admin-api.test.js --test-name-pattern="character read finalizes"`

Run: `node --check server.js; node --check online.js`

Expected: test PASS and both syntax checks exit 0.

- [ ] **Step 5: Commit the completed synchronization changes**

Project currently has no Git repository. Record this task as complete in this plan instead of running a Git commit.

### Task 4: 聚灵台 Modal, Countdown, and Responsive Styling

**Files:**
- Modify: `index.html: facility modal functions after the Library modal and renderBuilding`
- Modify: `online.js: expose authenticated 聚灵台 API actions and rerender hooks`
- Modify: `style.css: facility modal and active-countdown styles`
- Test: `test/app-shell.test.js: static shell assertions for 聚灵台 hooks`

**Interfaces:**
- Consumes the Task 2 API endpoints and returned `{ character, updated_at, event }` shape.
- Produces global browser functions `openSpiritPlatformModal()`, `renderSpiritPlatformModal()`, `startCultivation()`, `exitCultivationEarly()`, and `startBreakthrough()`.
- `renderSpiritPlatformModal()` must only calculate display values from `D.my_adventurer.cultivation`; it may not grant EXP or decide success.

- [ ] **Step 1: Write failing frontend shell assertions**

```js
test('game shell contains the spirit platform facility hooks', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /openSpiritPlatformModal/);
  assert.match(html, /闭关修炼/);
  assert.match(html, /闭关突破/);
  assert.match(html, /需达到练气十层圆满/);
});
```

- [ ] **Step 2: Run the frontend shell test and verify it fails**

Run: `node --test test/app-shell.test.js --test-name-pattern="spirit platform"`

Expected: FAIL because the facility hook and labels do not exist.

- [ ] **Step 3: Implement modal controls and countdown rendering**

```js
function canBreakthrough(role) {
  return Number(role.level) === 10 && Number(role.exp) >= 1000;
}

function cultivationRemainingMs(role, now = Date.now()) {
  return Math.max(0, Number(role.cultivation?.endsAt || 0) - now);
}
```

Place the 聚灵台 card directly after 藏经阁 in the filtered building ordering. Implement 1-to-24 hour stepper controls using increment/decrement buttons, show `hours * 100` spirit stones, and submit through `window.OnlineGame` API helpers. Lock the breakthrough card when `canBreakthrough` is false; its click handler must show `toastMsg('需达到练气十层圆满')` and must not call the server. For active cultivation show countdown, next half-hour settlement time, and early-exit button. For active breakthrough show countdown and no exit button. After every successful endpoint response, replace `D.my_adventurer`, update `_char_updated_at`, then rerender building, mine, adventurers, and party views.

Add responsive CSS using grid/flex constraints so the facility controls, countdown, and Chinese labels wrap without overlap at narrow widths.

- [ ] **Step 4: Run shell test and manual browser acceptance checks**

Run: `node --test test/app-shell.test.js --test-name-pattern="spirit platform"`

Manual check at `http://127.0.0.1:8787/`:
1. Open 建筑 and confirm 聚灵台 is adjacent to 藏经阁.
2. Confirm 1-hour cultivation shows 100 灵石 and starts only when funds are sufficient.
3. Confirm a non-maxed character sees a locked breakthrough action and the required toast.
4. Confirm cultivation displays an early-exit action; breakthrough does not.
5. Confirm narrow viewport text and controls do not overlap.

Expected: automated test PASS and each manual check succeeds.

- [ ] **Step 5: Commit the completed UI changes**

Project currently has no Git repository. Record this task as complete in this plan instead of running a Git commit.

### Task 5: Full Regression and Service Restart

**Files:**
- Modify: `docs/superpowers/plans/2026-08-19-juling-platform.md: mark completed checklist items`

**Interfaces:**
- Consumes all prior tasks.
- Produces a restarted local service exposing the new facility at `http://127.0.0.1:8787/`.

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`

Expected: all existing admin, public-room, UI shell, and new 聚灵台 tests pass.

- [ ] **Step 2: Check production source syntax**

Run: `node --check server.js; node --check online.js`

Expected: both commands exit 0.

- [ ] **Step 3: Restart the local game service**

Run: `启动后台.bat`

Expected: the server starts without an address-in-use error and `http://127.0.0.1:8787/` loads.

- [ ] **Step 4: Verify a live account flow**

Use a development account with sufficient spirit stones to start a 1-hour cultivation, refresh the page, and confirm the countdown and `修炼中` state persist. Use a seeded level-10/1000-EXP test account to confirm breakthrough UI locking/unlocking and status persistence. Do not wait two real hours; use the tested server fixture path for terminal outcomes.

- [ ] **Step 5: Record verification outcome**

Update this plan with the exact test count and any manual test constraints. Project currently has no Git repository, so no Git commit is performed.
