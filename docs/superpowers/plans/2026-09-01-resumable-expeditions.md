# Resumable Expeditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume expeditions after temporary AI outages, browser disconnects, and server restarts without premature failure or duplicate settlement.

**Architecture:** Persist a complete versioned runtime snapshot in `expedition_runs`, hydrate it on startup, and turn transient AI failure into a resumable `waiting_ai` state. Keep rewards protected by the existing transactional settlement boundary and add client heartbeat plus an HTTP active-run fallback.

**Tech Stack:** Node.js, SQLite, WebSocket, browser JavaScript, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-01-resumable-expeditions-design.md`

## Global Constraints

- Do not add dependencies.
- Keep legacy snapshots on the safe interruption and refund path.
- Never apply one story step or settlement reward more than once.
- Temporary AI or transport failures must not produce a failed expedition log.

---

### Task 1: Durable Runtime Snapshots

**Files:**
- Modify: `server.js`
- Modify: `db.js`
- Test: `test/expedition-resume.test.js`

**Interfaces:**
- Produces: `serializeDurableRoom(room)`, `hydrateDurableRoom(run)`, `recoverInterruptedExpeditions({ excludeRunIds })`

- [ ] Write tests proving complete runtime fields survive serialization and legacy snapshots remain interruptible.
- [ ] Run `node --test test/expedition-resume.test.js` and verify failure.
- [ ] Implement versioned serialization, hydration, and recovery exclusions.
- [ ] Re-run the focused tests and verify success.

### Task 2: Startup Resume Worker

**Files:**
- Modify: `server.js`
- Test: `test/expedition-resume.test.js`

**Interfaces:**
- Consumes: `hydrateDurableRoom(run)`
- Produces: `restorePersistedExpeditions()`

- [ ] Write an integration test that starts a server with a durable running snapshot and observes it remain active.
- [ ] Verify the test fails because startup currently interrupts the run.
- [ ] Rebuild rooms before startup recovery, schedule eligible runs, and interrupt only unrestoreable rows.
- [ ] Verify resumed and legacy recovery tests pass.

### Task 3: Resumable AI Failure

**Files:**
- Modify: `server.js`
- Modify: `db.js`
- Test: `test/expedition-resume.test.js`

**Interfaces:**
- Produces: `classifyAiFailure(error)`, `pauseRoomForAi(room, error)`, `resumeWaitingRoom(room)`

- [ ] Write tests proving transient failures checkpoint `waiting_ai` and later retry without a failed log.
- [ ] Verify the tests fail against `failRoomRun`.
- [ ] Add retry metadata, exponential retry scheduling, and state transitions.
- [ ] Verify permanent corruption still uses the terminal failure path.

### Task 4: Client Reconnect UX and HTTP Fallback

**Files:**
- Modify: `server.js`
- Modify: `online.js`
- Test: `test/app-shell.test.js`
- Test: `test/expedition-resume.test.js`

**Interfaces:**
- Produces: `GET /api/expeditions/active`, WebSocket `run_waiting_ai`, heartbeat `ping/pong`

- [ ] Write tests for authenticated active-run snapshots, heartbeat, authenticated reconnect reset, and preserved run cards.
- [ ] Verify the tests fail.
- [ ] Implement the endpoint and reconnect UI behavior.
- [ ] Run focused tests and verify success.

### Task 5: Full Verification

**Files:**
- Test: `test/expedition-resume.test.js`

- [ ] Run `node --check server.js`, `node --check db.js`, and `node --check online.js`.
- [ ] Run `node --test test/expedition-resume.test.js test/app-shell.test.js test/expedition-runs-db.test.js`.
- [ ] Run `npm test` and verify zero failures.
- [ ] Review restart, retry, idempotency, authentication, and legacy recovery behavior.
