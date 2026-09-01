# Runtime Recovery And Test Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make expedition state crash-recoverable, remove environment and live-server dependencies from tests, and expose room start through a directly testable module.

**Architecture:** Add versioned SQLite lifecycle tables and transaction APIs around expedition start, checkpoints, failure recovery, and settlement. Extract room-start orchestration behind dependency injection, then migrate integration tests to unique temporary databases and random ports while preserving the existing HTTP/WebSocket contracts.

**Tech Stack:** Node.js CommonJS, `node:sqlite`, `node:test`, HTTP, WebSocket (`ws`), plain browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-30-runtime-recovery-and-test-isolation-design.md`

## Global Constraints

- Interrupted runs resolve as technical failures; exact AI narrative resumption is out of scope.
- SQLite remains the persistence engine and the server remains explicitly single-instance.
- Stamina charge, refund, log insertion, and settlement must be idempotent per `run_id`.
- Existing HTTP and WebSocket payloads remain compatible.
- Tests must not read or mutate repository `tavern.db`, load repository `.env`, or require port 8787.
- Production changes follow red-green-refactor; every new exported function receives focused coverage.
- This directory is not a Git repository, so commit steps are replaced by verification checkpoints and file summaries.

---

### Task 1: Hermetic Server Test Fixture

**Files:**
- Create: `test/helpers/server-fixture.js`
- Modify: `test/admin-page.test.js`
- Modify: `test/admin-api.test.js`
- Modify: `test/app-shell.test.js`

**Interfaces:**
- Produces: `makeTempDbPath(prefix) -> string`
- Produces: `cleanupDatabaseFiles(dbPath) -> Promise<void>`
- Produces: `startServer({ dbPath, env }) -> Promise<{ child, baseUrl, output, stop }>`
- Produces: `getFreePort() -> Promise<number>`

- [ ] **Step 1: Add a failing environment-isolation assertion**

  In `test/admin-page.test.js`, set a parent `ADMIN_PASSWORD`, start a child with `ADMIN_PASSWORD` explicitly absent and `TAVERN_LOAD_ENV=0`, then assert `/admin` is `404`. The test must start through the wished-for shared fixture.

  ```js
  test('admin page ignores repository and parent configuration when disabled', async () => {
    const server = await startServer({
      dbPath: makeTempDbPath('admin-page'),
      env: { ADMIN_PASSWORD: undefined, TAVERN_LOAD_ENV: '0' },
    });
    try {
      assert.equal((await fetch(`${server.baseUrl}/admin`)).status, 404);
    } finally {
      await server.stop();
    }
  });
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/admin-page.test.js`

  Expected: failure because `test/helpers/server-fixture.js` and its exported API do not exist.

- [ ] **Step 3: Implement the shared fixture**

  Use `os.tmpdir()` plus `crypto.randomUUID()` for database paths. Child environments must always include:

  ```js
  {
    ...process.env,
    PORT: String(port),
    TAVERN_DB_PATH: dbPath,
    TAVERN_LOAD_ENV: '0',
  }
  ```

  Apply explicit `undefined` overrides by deleting those keys before spawn. `stop()` must terminate the child, await exit, then remove the exact DB, WAL, and SHM paths with `fs.promises.rm(path, { force: true })`.

- [ ] **Step 4: Migrate admin page tests and verify GREEN**

  Replace the local `getFreePort`, `waitForServer`, `startServer`, and `stopServer` copies in `test/admin-page.test.js`. Run `node --test test/admin-page.test.js` and require zero failures.

- [ ] **Step 5: Isolate `admin-api.test.js` before importing DB**

  At the top of the file, create one unique DB path, set `process.env.TAVERN_DB_PATH` and `process.env.TAVERN_LOAD_ENV = '0'`, then require `../db`. Start the child against that same path so parent fixture writes are visible to the server. Register teardown to close the DB if supported and remove all three SQLite files after the child exits.

  Create a dedicated cultivation character instead of mutating `pushCharacterId`; room and matchmaking tests must retain an idle character fixture.

- [ ] **Step 6: Remove fixed-port app-shell dependencies**

  Replace HTTP reads of `/`, `/online.js`, and other static assets with `fs.readFileSync` for source-structure assertions. Keep actual static-serving security coverage in `test/security-hardening.test.js`.

- [ ] **Step 7: Run the affected tests**

  Run:

  ```powershell
  node --test test/admin-page.test.js test/admin-api.test.js test/app-shell.test.js
  ```

  Expected: environment and fixed-port failures are gone. Any remaining functional failure is recorded before Task 2 rather than hidden by shared state.

- [ ] **Step 8: Verification checkpoint**

  Record created/modified files and confirm no `*.db`, `*.db-wal`, or `*.db-shm` remains under `test/`.

### Task 2: Durable Expedition Lifecycle Schema

**Files:**
- Modify: `db.js`
- Create: `test/expedition-runs-db.test.js`

**Interfaces:**
- Produces: `getExpeditionRun(runId) -> ExpeditionRun | null`
- Produces: `getActiveExpeditionRuns() -> ExpeditionRun[]`
- Produces: `checkpointExpeditionRun(runId, snapshot) -> boolean`
- Produces: `beginExpeditionRun({ runId, roomId, snapshot, members, staminaCost }) -> { status, run, characters }`

- [ ] **Step 1: Write failing schema and start tests**

  Create a child-process database test so `TAVERN_DB_PATH` is set before loading `db.js`. Seed two users and characters, then call:

  ```js
  const result = DB.beginExpeditionRun({
    runId: 'run-1',
    roomId: 'R1',
    snapshot: { steps: [] },
    staminaCost: 10,
    members: [
      { userId: userA, characterId: charA, memberName: '甲' },
      { userId: userB, characterId: charB, memberName: '乙' },
    ],
  });
  ```

  Assert one running row exists, both characters are `adventuring`, and each lost exactly 10 stamina.

- [ ] **Step 2: Run and verify RED**

  Run: `node --test test/expedition-runs-db.test.js`

  Expected: failure because lifecycle tables and functions are missing.

- [ ] **Step 3: Add versioned lifecycle tables**

  Add `expedition_runs` and `expedition_run_members` with the schema from the design. Record migration name `expedition_runs_v1` in `schema_migrations`. Add indexes for `status` and `(user_id, character_id)`.

- [ ] **Step 4: Implement atomic begin**

  `beginExpeditionRun` uses `BEGIN IMMEDIATE`. It must:

  - return `{ status: 'existing', run }` for an existing `run_id`;
  - reject duplicate non-terminal membership through a query on both lifecycle tables;
  - validate character ownership and stamina for every member before any write;
  - insert run and member rows;
  - set `status = adventuring`, subtract the charge, reset recovery timestamps, and advance `updated_at` monotonically;
  - transition the row from `starting` to `running` before commit.

- [ ] **Step 5: Add rollback and idempotency tests**

  Test insufficient stamina on the second member and assert neither character changes and no run row remains. Call begin twice with the same `run_id` and assert stamina changes only once.

- [ ] **Step 6: Add checkpoint tests and implementation**

  Test that `checkpointExpeditionRun('run-1', { steps: [{ stepNo: 1 }] })` updates only a `running` row and returns `false` for terminal or missing rows.

- [ ] **Step 7: Run focused DB tests**

  Run: `node --test test/expedition-runs-db.test.js`

  Expected: all lifecycle start and checkpoint cases pass.

- [ ] **Step 8: Verification checkpoint**

  Run `node --check db.js` and confirm the migration can execute twice against the same temporary database without changing counts.

### Task 3: Failure Recovery And Startup Reconciliation

**Files:**
- Modify: `db.js`
- Modify: `test/expedition-runs-db.test.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `failExpeditionRun({ runId, terminalStatus, reason, log }) -> { status, restored, refunded, logKey }`
- Produces: `recoverInterruptedExpeditions() -> { runs, characters, refunded, logs, legacyCharacters }`

- [ ] **Step 1: Write a failing technical-failure test**

  Begin a run, call `failExpeditionRun` with `terminalStatus: 'failed'`, and assert:

  - characters return to `resting`;
  - exactly 10 stamina is refunded per recorded member;
  - one shared failed log is inserted;
  - the durable run becomes terminal;
  - repeating the call changes nothing and returns the same `logKey`.

- [ ] **Step 2: Run and verify RED**

  Run the focused DB test and confirm the missing recovery API is the failure reason.

- [ ] **Step 3: Refactor shared-log insertion for transaction reuse**

  Extract a private `insertSharedLog(participants, log)` that assumes an open transaction. Keep public `addSharedLog` as the existing transaction wrapper. The lifecycle failure and settlement APIs call the private helper so SQLite transactions are never nested.

- [ ] **Step 4: Implement idempotent failure recovery**

  Inside one transaction, load the run and members, short-circuit terminal rows, reset only characters still marked `adventuring`, refund the recorded charge with a max-stamina cap, insert the failed log once, and store `logKey`, reason, and terminal snapshot in `expedition_runs.snapshot`.

- [ ] **Step 5: Write startup recovery tests**

  Seed one `running` run, one `settling` run, one completed run, and one legacy orphan character with `status = adventuring`. Assert recovery interrupts the first two, ignores the completed row, refunds only recorded charges, resets the legacy character without refund, and is idempotent.

- [ ] **Step 6: Implement startup reconciliation**

  Iterate non-terminal durable runs and call the transaction recovery API with `terminalStatus: 'interrupted'`. Then reset legacy orphan characters not referenced by any active row. Isolate malformed snapshot JSON and use a generic reason.

- [ ] **Step 7: Wire reconciliation before listen**

  Call `DB.recoverInterruptedExpeditions()` after database initialization and before `server.listen`. Log only counts:

  ```text
  [recovery] runs=2 characters=3 refunded=30 logs=2 legacy=1
  ```

- [ ] **Step 8: Verify focused behavior**

  Run the DB tests twice and `node --check server.js`. Confirm the second recovery reports all zeroes.

### Task 4: Importable Room Start Orchestrator

**Files:**
- Create: `room-runner.js`
- Replace: `test/room-start-guard.test.js`
- Modify: `server.js`

**Interfaces:**
- Produces: `createRoomRunner(dependencies) -> { buildDungeonParty, startRoomRun }`
- Consumes: `beginRun({ room, dungeon, snapshot }) -> Promise<void> | void`

- [ ] **Step 1: Replace source extraction with a failing import test**

  Rewrite `test/room-start-guard.test.js` to `require('../room-runner')` and instantiate the factory with fakes. Keep the existing concurrent call assertion and add begin-call count:

  ```js
  assert.equal(events.created.length, 1);
  assert.equal(events.begun.length, 1);
  assert.equal(events.started.length, 1);
  ```

- [ ] **Step 2: Run and verify RED**

  Run: `node --test test/room-start-guard.test.js`

  Expected: module-not-found for `room-runner.js`.

- [ ] **Step 3: Implement the minimal factory**

  Move `buildDungeonParty` and the orchestration portion of `startRoomRun` into the new module. Keep setup fallback behavior. Set `room.status = 'starting'` before awaiting setup. Build the dungeon, assign party/focus state, call injected `beginRun`, then set both states to running, broadcast, and schedule.

  On begin failure, restore `room.status = 'waiting'`, call `onFailure(room, error, { beforeStart: true })`, and do not broadcast start.

- [ ] **Step 4: Wire production dependencies**

  In `server.js`, instantiate once with `GE`, `GC`, `aiDecideSetup`, a `DB.beginExpeditionRun` adapter, `broadcastAll`, `scheduleTick`, and `failRoomRun`. Keep `startRoomRun` as a local alias to minimize call-site churn.

- [ ] **Step 5: Run focused tests and syntax checks**

  Run:

  ```powershell
  node --test test/room-start-guard.test.js
  node --check room-runner.js
  node --check server.js
  ```

- [ ] **Step 6: Verification checkpoint**

  Confirm `test/room-start-guard.test.js` contains no `source.slice`, `vm.runInContext`, or dependency on the physical order of functions in `server.js`.

### Task 5: Runtime Checkpoints And Durable Failure Path

**Files:**
- Modify: `server.js`
- Modify: `test/admin-api.test.js`
- Modify: `test/expedition-runs-db.test.js`

**Interfaces:**
- Consumes: `DB.checkpointExpeditionRun`
- Consumes: `DB.failExpeditionRun`
- Produces: `durableRunSnapshot(room) -> plain JSON object`

- [ ] **Step 1: Add a failing WebSocket checkpoint test**

  Start a fast room, wait for `dungeon_started`, inspect the temporary DB, and assert a running lifecycle row exists with the correct human participant and initial stamina charge. For a unit-level checkpoint test, construct a room snapshot and assert one completed step is stored before the next tick is scheduled.

- [ ] **Step 2: Run and verify RED**

  Run the focused admin API and lifecycle tests. Confirm failure is due to missing server wiring, not fixture setup.

- [ ] **Step 3: Add a compact snapshot builder**

  Serialize only JSON-safe game state. Remove timers, WebSocket objects, and private cyclic references. Preserve the fields enumerated in the design, including partial steps and human member identifiers.

- [ ] **Step 4: Checkpoint before broadcasting a step**

  After applying the AI decision and incrementing step state, write the checkpoint. If it returns false or throws, stop the tick and route through technical failure. Broadcast `step` only after the checkpoint commits.

- [ ] **Step 5: Replace manual failure writes**

  Build the existing failed-log payload but pass it to `DB.failExpeditionRun`. Remove per-character refund saves and direct `DB.addSharedLog` from `failRoomRun`. Send notifications only after the durable transaction succeeds.

- [ ] **Step 6: Cover duplicate failure calls**

  Trigger two failure calls for the same room and assert one refund, one log, and one terminal event.

- [ ] **Step 7: Run focused integration tests**

  Run:

  ```powershell
  node --test test/expedition-runs-db.test.js test/room-start-guard.test.js test/admin-api.test.js
  ```

- [ ] **Step 8: Verification checkpoint**

  Query the temporary DB after a failed run and report lifecycle status, participant count, log count, and character stamina/status.

### Task 6: Atomic Settlement And Full Verification

**Files:**
- Modify: `db.js`
- Modify: `server.js`
- Modify: `test/expedition-runs-db.test.js`
- Modify: `test/admin-api.test.js`
- Modify only if expectations are obsolete: other failing tests

**Interfaces:**
- Produces: `commitExpeditionSettlement({ runId, characterWrites, characterDeletes, participants, log, snapshot }) -> { status, logKey, updatedCharacters, deletedCharacters }`

- [ ] **Step 1: Write failing settlement transaction tests**

  Begin a run and call the wished-for commit API with two character writes and one shared log. Assert all character changes, log insertion, and `completed` state commit together. Add a deliberately invalid character write and assert everything rolls back with the run still `running`.

- [ ] **Step 2: Run and verify RED**

  Run the lifecycle DB test and confirm the settlement API is missing.

- [ ] **Step 3: Implement the settlement transaction**

  Transition `running -> settling`, validate every write/delete before mutation, apply character writes with monotonic versions, perform character deletion cleanup, call private `insertSharedLog`, then transition to `completed` and commit. Existing terminal runs return their stored `logKey` without applying mutations again.

- [ ] **Step 4: Refactor `settleRoom` into calculation then commit**

  Preserve all AI calls and reward calculations. During the member loop, mutate in-memory role copies and collect:

  ```js
  characterWrites.push({ userId, characterId, name, data });
  characterDeletes.push({ userId, characterId });
  ```

  Do not call `DB.saveCharacter`, `DB.deleteCharacter`, or `DB.addSharedLog` inside the calculation loop. Submit one commit request after the log payload is complete. Emit character notifications and `settled` only after commit succeeds.

- [ ] **Step 5: Add restart-boundary regression coverage**

  Simulate an exception before commit and assert startup recovery refunds the original charge. Simulate an exception after commit by calling recovery and assert rewards and logs are not duplicated or refunded.

- [ ] **Step 6: Run all focused suites**

  Run:

  ```powershell
  node --test test/expedition-runs-db.test.js test/room-start-guard.test.js test/admin-api.test.js test/shared-logs-db.test.js
  ```

- [ ] **Step 7: Run the full test suite in a clean environment**

  Run:

  ```powershell
  $env:TAVERN_LOAD_ENV='0'
  Remove-Item Env:TAVERN_DB_PATH -ErrorAction SilentlyContinue
  npm test
  ```

  Expected: zero failed, cancelled, or skipped tests caused by this work. Tests create and clean their own database files.

- [ ] **Step 8: Run syntax and dependency verification**

  Run:

  ```powershell
  node --check db.js
  node --check room-runner.js
  node --check server.js
  node --check online.js
  npm audit --omit=dev
  ```

  Expected: all syntax checks exit 0 and audit reports zero known vulnerabilities.

- [ ] **Step 9: Verify on a copied development database**

  Copy `tavern.db` to an exact temporary path outside the repository root, set `TAVERN_DB_PATH` to the copy, disable `.env`, start the server once, and query:

  - lifecycle tables exist;
  - no non-terminal run remains after startup recovery;
  - no character is `adventuring` without a running lifecycle row;
  - existing logs and participant counts remain intact.

  Delete only the verified temporary copy after the server exits.

- [ ] **Step 10: Final self-review**

  Review changed files across correctness, readability, architecture, security, and performance. Confirm no unrelated frontend or game-balance changes, no raw secrets, no repository database mutations, and no source-extraction test was introduced.
