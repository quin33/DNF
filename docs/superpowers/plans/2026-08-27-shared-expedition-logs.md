# Shared Expedition Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one canonical log per expedition while every authenticated player can watch every active expedition in real time.

**Architecture:** Add a participant join table and an idempotent legacy migration around the existing SQLite layer. Settlement and failure paths create one canonical log transactionally, personal history joins through participants, public history reads canonical rows, and the browser uses a globally unique `log_key`.

**Tech Stack:** Node.js, `node:sqlite`, built-in `node:test`, HTTP/WebSocket server, browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-27-shared-expedition-logs-design.md`

## Global Constraints

- One database row per multiplayer `run_id`.
- Every authenticated WebSocket client receives active-run start, step, settlement, and failure events.
- Existing duplicate data must be migrated transactionally and idempotently.
- Preserve the richest available story, summary, settlement, and valid participant membership.
- Do not alter AI outcome or timeout behavior in this change.

---

### Task 1: Canonical Log Schema And Migration

**Files:**
- Modify: `db.js`
- Create: `test/shared-logs-db.test.js`

**Interfaces:**
- Produces: `addSharedLog(participants, log) -> { logKey, log }`
- Produces: `getLogs(userId) -> Log[]` with `log_key`
- Produces: `getAllLogs() -> Log[]` with one row per canonical log
- Produces: `migrateSharedLogs()` invoked during database initialization

- [ ] Write a database test that inserts two legacy rows with the same `run_id`, different owners, and different completeness; reload migration code and assert one `logs` row remains, both users exist in `log_participants`, and the richer JSON survives.
- [ ] Run `node --test test/shared-logs-db.test.js`; verify it fails because `log_participants` and canonical migration do not exist.
- [ ] Add `schema_migrations` and `log_participants` tables with foreign keys and indexes.
- [ ] Implement the migration inside one explicit transaction. Rank duplicate candidates by completed settlement, step count, story length, populated summary/settlement, then row id. Insert valid participant links before deleting duplicate rows; associate non-duplicate legacy rows with their valid owner; delete orphan rows with no valid user.
- [ ] Add a second test that runs migration twice and asserts row counts and participant memberships remain unchanged.
- [ ] Run the focused database test and verify both cases pass.

### Task 2: Shared Database Write And Read APIs

**Files:**
- Modify: `db.js`
- Modify: `test/shared-logs-db.test.js`

**Interfaces:**
- Consumes: `log_participants(log_id, user_id, character_id, member_name, personal_data)`
- Produces: `addSharedLog([{ userId, characterId, memberName, personalData }], log)`
- Produces: API-shaped log objects containing `log_key`

- [ ] Add a failing test that calls `addSharedLog` for four users and asserts one `logs` row, four participant rows, the same `log_key` from every personal query, and one public row.
- [ ] Run the focused test and verify the old per-user API cannot satisfy it.
- [ ] Implement `addSharedLog` as one transaction: insert the canonical row, set JSON display `id` and `log_key` from the row id, update stored JSON, then insert unique valid participants.
- [ ] Replace `getLogs(userId)` with a participant join and replace `getAllLogs()` with direct canonical-row reads. Remove pre-deduplication `LIMIT 200` and JavaScript run deduplication.
- [ ] Keep `addLog(userId, log)` as a compatibility wrapper over `addSharedLog` for the authenticated legacy endpoint.
- [ ] Run `node --test test/shared-logs-db.test.js` and verify all focused cases pass.

### Task 3: One Shared Log Per Settlement Or Failure

**Files:**
- Modify: `server.js`
- Modify: `test/admin-api.test.js`
- Modify: `test/feed.test.js`

**Interfaces:**
- Consumes: `DB.addSharedLog(participants, log)`
- Produces: identical `logId` and `logKey` in every human participant result

- [ ] Change the multiplayer API test expectation so four participants receive the same `log_key`, personal history returns that same canonical log, public history contains it once, and the database contains one row for the run.
- [ ] Add a failure-path test using `ROOM_FAST=1` that asserts one failed log row and all valid human participant links.
- [ ] Run the focused API tests and verify they fail against the per-player insertion loops.
- [ ] In `settleRoom`, build one shared settlement containing all member results, insert once, associate every human member, and attach the returned key to every result.
- [ ] In `failRoomRun`, build one partial failed log and associate every valid human member in one call.
- [ ] Update `POST /api/log` to use the compatibility shared write path.
- [ ] Update source-structure assertions in `test/feed.test.js` to require a single shared insert rather than personal copies.
- [ ] Run `node --test test/admin-api.test.js test/feed.test.js` and verify the focused suite passes.

### Task 4: Global Frontend Log Identity

**Files:**
- Modify: `index.html`
- Modify: `online.js`
- Modify: `test/app-shell.test.js`
- Modify: `test/feed.test.js`

**Interfaces:**
- Produces: `logKey(log)` returning `log.log_key`, then `run_id`, then legacy `id`
- Consumes: server `log_key` and settlement `logKey`

- [ ] Add source/behavior tests proving two logs with the same legacy `id` can be independently opened and favorited through distinct `log_key` values.
- [ ] Run the frontend-focused tests and verify lookups still rely on `id`.
- [ ] Add one key helper and route row clicks, modal lookup, detail view, favorites, biography links, and live-completion through it.
- [ ] Escape/encode string keys safely in inline handlers, or pass them via element datasets where existing patterns make that safer.
- [ ] Update online settlement handling to use the shared `logKey`, avoid inserting a second local log for the same run, and refresh canonical logs after settlement.
- [ ] Extend search to include `summary_text` and step text while touching the lookup flow.
- [ ] Run `node --test test/app-shell.test.js test/feed.test.js` and verify all cases pass.

### Task 5: Real-Time Public Watching Regression Coverage

**Files:**
- Modify: `test/admin-api.test.js`
- Modify: `test/app-shell.test.js`
- Modify: `server.js` only if tests expose a gap
- Modify: `online.js` only if tests expose a gap

**Interfaces:**
- Consumes: `broadcastAll`, `runningSnapshot`, authenticated WebSocket `auth`
- Produces: one active client entry per `run_id` for participants and non-participants

- [ ] Add a WebSocket integration test with a room participant and an unrelated authenticated observer. Assert both receive `dungeon_started`, `step`, and terminal events.
- [ ] Add a reconnect test asserting an unrelated authenticated observer receives `dungeon_resumed` snapshots for all active rooms.
- [ ] Run the focused tests. If they already pass, retain them as regression coverage without changing production broadcasting.
- [ ] If a gap appears, minimally adjust authentication replay or client active-run deduplication and rerun until green.

### Task 6: Migration Verification On A Database Copy

**Files:**
- Create temporarily during verification: `test/tmp/shared-log-migration.db`
- Do not modify: `tavern.db` until automated migration checks pass

**Interfaces:**
- Consumes: the production migration function with a configurable/test database path
- Produces: before/after verification counts

- [ ] Copy `tavern.db` to the test temporary directory and run the real migration against the copy.
- [ ] Assert canonical rows have unique non-empty `run_id` values, except intentionally separate legacy rows without `run_id`.
- [ ] Assert every participant references an existing user and canonical log.
- [ ] Compare counts: expected canonical run groups plus retained legacy rows equals migrated log rows; no valid participant is lost.
- [ ] Open representative migrated logs, including user `1111` recent runs, and compare story length, steps, status, summary, and settlement against the richest source copies.
- [ ] Delete the temporary database after recording results.

### Task 7: Full Verification

**Files:**
- Verify all modified files

- [ ] Run `npm test` and require zero failures.
- [ ] Run a syntax check with `node --check db.js` and `node --check server.js`.
- [ ] Start the server against the migrated development database, connect two authenticated clients, and verify both see the same active run and final canonical log.
- [ ] Query SQLite and report total canonical logs, participant links, duplicate non-empty `run_id` count, and orphan participant count.
- [ ] Review the final diff for unrelated changes and confirm the production database backup exists before allowing the startup migration to modify it.
