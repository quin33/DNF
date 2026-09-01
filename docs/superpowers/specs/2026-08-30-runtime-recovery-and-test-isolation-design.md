# Runtime Recovery And Test Isolation Design

## Goal

Make the current single-process Node.js game server recover safely from process interruption, isolate automated tests from developer data and local configuration, and expose room-start orchestration through a directly testable module boundary.

This phase preserves the existing HTTP, WebSocket, frontend, SQLite, and AI behavior. It improves consistency and maintainability without rewriting the application or changing the player-facing game flow.

## Current Problems

- Room state, matchmaking state, and AI job state live only in process memory.
- Starting an expedition persists `adventuring` and deducts stamina before the run has a durable lifecycle record.
- A process exit before settlement loses the room while leaving characters in an authoritative in-progress state.
- Database initialization and migrations run as import-time side effects against `tavern.db` unless every caller configures the environment first.
- The server loads the repository `.env` by default, so child-process tests can inherit developer-only settings such as `ADMIN_PASSWORD`.
- Several tests share mutable database fixtures, depend on execution order, inspect source text, or contact a server already listening on port 8787.
- `startRoomRun` is not directly importable and its source-slice test breaks when a helper moves outside the selected text range.

## Scope

1. Add a durable expedition lifecycle and startup reconciliation.
2. Make expedition start, checkpoint, successful settlement, and technical failure idempotent at the database boundary.
3. Extract room-start orchestration into a focused CommonJS module with injected dependencies.
4. Give integration tests a unique SQLite file, random port, and disabled local `.env` loading.
5. Replace tests that depend on a pre-existing port-8787 server or source slicing in the room-start flow.
6. Restore the complete test suite to zero failures.

## Out Of Scope

- Resuming AI generation from the exact interrupted story position after a server restart.
- Persisting the public waiting-room list or matchmaking queue across restarts.
- Supporting multiple concurrent Node.js server instances.
- Rewriting the frontend, adopting a framework, or converting every script to ES modules.
- Replacing SQLite or `node:sqlite`.
- Refactoring all routes out of `server.js` in this phase.

## Recovery Semantics

An interrupted expedition is resolved as a technical failure, not resumed. This gives deterministic and explainable behavior while protecting character state.

The database stores one durable row per run:

```sql
CREATE TABLE expedition_runs (
  run_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE expedition_run_members (
  run_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  member_name TEXT NOT NULL,
  stamina_charged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, user_id, character_id),
  FOREIGN KEY (run_id) REFERENCES expedition_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

Valid lifecycle states are:

```text
starting -> running -> settling -> completed
starting -> interrupted
running  -> failed | interrupted
settling -> interrupted
```

Terminal rows remain available for diagnosis and idempotency. A later maintenance task may add retention cleanup; this phase does not delete lifecycle history automatically.

## Expedition Start

AI setup is resolved before authoritative resources are charged. Once setup and the dungeon object exist, one database transaction:

1. Inserts the `starting` run row and human participant rows.
2. Loads each participant character and verifies ownership.
3. Rejects a character already attached to another non-terminal run.
4. Deducts exactly 10 stamina and sets `status = adventuring`.
5. Stores the updated character JSON and versions.
6. Changes the durable run state to `running` with the initial snapshot.

If any participant cannot be updated, the transaction rolls back and nobody is charged. Retrying the same `run_id` returns the existing durable state instead of charging twice.

Only after this transaction commits does the server broadcast `dungeon_started` and schedule the first tick.

## Checkpoints

After each accepted dungeon step, the server writes a compact snapshot containing:

- dungeon identity and flow state;
- human and NPC party state required for failure reporting;
- completed story steps;
- accumulated damage, loot markers, item ownership, and member gains;
- the last update timestamp.

Checkpoint failure stops further ticks and enters the existing technical-failure path. The server must not continue an untracked authoritative expedition.

## Settlement And Failure Transactions

AI calls and result calculation occur outside database transactions. Once all final data is ready, one synchronous SQLite transaction commits the authoritative outcome.

Successful settlement transaction:

1. Verifies the run is still `running` and changes it to `settling`.
2. Applies all surviving character mutations and deletions.
3. Inserts the canonical shared expedition log and participants.
4. Changes the run to `completed` and stores the final snapshot.

Technical-failure or startup-recovery transaction:

1. Accepts only `starting`, `running`, or `settling` runs.
2. Restores every surviving human character to `resting` when it is still marked `adventuring`.
3. Refunds only the recorded `stamina_charged` value, capped by `max_stamina`.
4. Writes one shared failed log using the stored partial steps when participants still exist.
5. Changes the run to `failed` for an in-process error or `interrupted` for startup recovery.

Repeating either terminal operation is a no-op and returns the existing terminal result. This prevents duplicate rewards, duplicate refunds, and duplicate logs.

## Startup Reconciliation

Database migrations run before the HTTP server begins listening. Immediately afterward, startup reconciliation resolves every non-terminal `expedition_runs` row as `interrupted`.

Reconciliation completes before WebSocket connections are accepted. It reports counts for recovered runs, restored characters, refunded stamina, and generated failure logs. One malformed snapshot is isolated to its run and does not prevent other runs from recovering; the malformed row is marked interrupted with a generic cancellation reason.

Legacy characters already marked `adventuring` but not referenced by any durable non-terminal run are also reset to `resting`. Because their historical charge cannot be proved, this legacy-only cleanup does not refund stamina.

## Room Start Module

Create `room-runner.js` with a factory:

```js
function createRoomRunner({
  gameEngine,
  gameCreate,
  decideSetup,
  beginRun,
  broadcastStarted,
  scheduleTick,
  onFailure,
  logger,
}) {
  return { buildDungeonParty, startRoomRun };
}
```

`startRoomRun(room, hostCharacter)` owns the `waiting -> starting -> running` in-memory transition and delegates durable writes through `beginRun`. It returns the created dungeon or `null` when the room is no longer waiting.

The module must not import `server.js`, access global WebSocket clients, open the database, or start timers at module load. Unit tests import the factory directly and use explicit fakes for its dependencies.

## Database Boundary

Keep the existing `db.js` public API for compatibility, but add focused transaction functions for the expedition lifecycle. Migration and recovery functions are exported for isolated tests.

Import-time initialization remains for the production entry point during this phase, but tests must set `TAVERN_DB_PATH` before requiring `db.js`. A full database factory conversion is deferred because wrapping all 748 lines would make this phase unnecessarily large.

The new migration is named and idempotent through `schema_migrations`. Unversioned destructive cleanup must not be added to module import paths.

## Test Isolation

Create `test/helpers/server-fixture.js` that:

- allocates a free loopback port;
- creates a unique database path under the operating-system temporary directory;
- sets `TAVERN_LOAD_ENV=0`, `TAVERN_DB_PATH`, `PORT`, and optional `ROOM_FAST=1`;
- starts `server.js` and waits for `/api/health`;
- captures stdout and stderr for failure messages;
- stops the child and deletes the database, WAL, and SHM files during teardown.

Tests needing direct DB access set their unique `TAVERN_DB_PATH` before the first `require('../db')`. Tests must not use the repository `tavern.db`.

`app-shell.test.js` reads static files directly when testing source structure. HTTP static-serving behavior belongs in the server integration fixture and never assumes port 8787 is already occupied.

Each stateful integration test creates its own users and characters or explicitly resets its fixture. A cultivation test cannot leave the character used by room tests in a modified state.

## Error Handling

- A failed begin transaction leaves the room in `waiting` when safe to retry and sends a clear error to its members.
- A checkpoint failure invokes durable technical failure exactly once.
- Recovery never throws away the original snapshot; it stores the recovery reason in the terminal row.
- JSON parse errors in snapshots produce a generic interrupted log and are recorded to stderr without exposing snapshot content or credentials.
- Cleanup failures for temporary test files are reported after the child process has stopped.

## Tests

- Starting one run charges every human participant once and creates one durable running row.
- Retrying the same `run_id` does not charge stamina again.
- A participant update failure rolls back all character charges and the run row.
- Each dungeon step updates the durable snapshot.
- Successful settlement updates characters, inserts one shared log, and marks the run completed atomically.
- Technical failure refunds the recorded charge once and marks the run failed.
- Startup recovery resets characters, refunds recorded charges, writes one interrupted log, and is idempotent.
- Legacy orphan `adventuring` characters are reset without an unprovable refund.
- Room-start concurrency calls create and broadcast one dungeon.
- Server integration tests use unique database files and random ports.
- Admin-disabled tests remain disabled even when the repository `.env` defines `ADMIN_PASSWORD`.
- App-shell tests pass without a pre-existing process listening on port 8787.
- Full `npm test` completes with zero failures.

## Rollout

1. Back up `tavern.db` before first startup with the new migration.
2. Run migration and recovery tests against a copied production database.
3. Run the full automated suite with local `.env` loading disabled.
4. Start the development server and verify health, authentication, room creation, one short expedition, and canonical log visibility.
5. Inspect startup recovery counters; non-zero legacy orphan counts should be recorded before normal play resumes.

## Success Criteria

- A server restart cannot leave a durable-run participant permanently stuck in `adventuring`.
- Stamina charge, refund, and settlement are each applied at most once per run.
- Room-start logic is tested through imports rather than source extraction.
- Automated tests neither read nor mutate the repository database and do not depend on `.env` or port 8787.
- `npm test` reports zero failures without requiring an already running server.
