# Task 2 Report: AI-driven dynamic dungeon flow

## Scope
Implemented dynamic state initialization for newly created online dungeons and server-side AI decision-driven stepping. Legacy `plan` metadata remains on snapshots for compatibility but is not used to terminate runs marked `flowMode: 'dynamic'`.

## RED
Added focused tests in `test/dungeon-flow.test.js` and `test/dungeon-flow-integration.test.js` covering dynamic state fields, boss resolution gating, minimum-step closing rejection, max-step failure, snapshot exposure, AI parser behavior, and decision application order. The first focused run failed on the missing `flowMode` field as expected.

## GREEN
- `createDg()` now initializes `flowMode: 'dynamic'`, `minSteps: 10`, `maxSteps: 40`, `phase: 'opening'`, quest/encounter containers, `lastDecision`, and `nextHint`; quest objective is derived from dungeon lore/name.
- `aiStoryPayload()` carries phase, quest/encounter state, bounds, decision metadata, and dynamic progress.
- `server.js` snapshots expose dynamic state; `dungeonStep()` uses dynamic phase selection, appends focus entries per generated step, parses structured AI decisions with plain-text fallback, applies normalized decisions before settlement/scheduling, enforces closing and max-step guards, and keeps legacy plan stepping unchanged for legacy snapshots.
- AI story payloads now carry dynamic state; existing prompt text remains unchanged for Task 3.

## Verification
- `node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js` — 22/22 passed.
- `node --check server.js` — passed.
- `node --check game-engine.js` — passed.
- Existing source-shape/regression checks remain green, including feed, progression, narrative-focus, replacement-character, and narrative-cap assertions.

## Concerns
- Full integration execution of a live AI-backed room was not run because it requires configured external AI credentials; tests validate source contracts and pure state transitions.
- Dynamic focus windows are intentionally one generated step at a time; richer multi-step focus scheduling remains a later refinement.

## Fix Round 1

- Plain-text AI fallback after the opening step now advances to `explore`.
- Prior active encounters cannot resolve and jump directly to `loot`/`closing` in one decision; the conflict phase is retained for that step.
- Max-step runs set `forcedTerminal: 'failed'`; settlement resolves final `ok` through this authoritative state so outcome AI cannot forge success.
- Dynamic focus entries are pushed before payload construction and rolled back when AI generation fails, preventing ghost focus records.
- `continue` is honored at runtime: non-closing `continue: false` still schedules another step; legal closing settles only with `continue: false`.
- WebSocket step events now include normalized `phase`, `questStatus`, `encounterStatus`, and `continue`.
- Dynamic payload stage labels map from the current phase instead of static legacy plan indices.

Fix verification: focused dynamic/integration suite passes 27/27; syntax checks for `server.js` and `game-engine.js` pass; targeted feed regression checks pass 69/69.

## Fix Round 2

- `forcedTerminal` is now set only when the pre-decision quest or encounter is unresolved; completed/failed/retreated plus resolved/escaped states remain successful at step 40.
- Any decision before `minSteps` is forced to `continue: true`, including non-closing phases, while illegal early closing remains phase-gated.
- Dynamic focus rollback now covers the full post-payload step pipeline (empty text, loot parsing, stage effects, state application, broadcast, settlement, and scheduling failures), not just AI request rejection.

Fix round 2 verification: `node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js` passes 29/29; `node --test test/feed.test.js test/progression.test.js test/narrative-focus.test.js` passes 83/83; both syntax checks pass.

No Git repository.
