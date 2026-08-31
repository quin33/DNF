# SDD ledger — plan: docs/superpowers/plans/2026-08-26-ai-driven-dungeon-flow.md

## Environment

- Repository check: `NO_GIT_REPO`.
- Ruling: Use task-scoped reports, copied before/after source snapshots, focused tests, and independent reviewers instead of worktrees, commits, and Git diff packages. This preserves review isolation but loses commit-level rollback; if wrong, recovery must use the stored snapshots or manual patches.

## Preflight Interface Scan

| Tasks | Shared file/interface | Finding |
|---|---|---|
| 1 / 2 | `game-engine.js` decision helpers | Clean: Task 1 produces pure helpers consumed by Task 2. |
| 1 / 4 | decision semantics mirrored in `index.html` | Risk: browser duplication can drift; Task 4 parity tests are mandatory. |
| 1 / 5 | decision field names in prompt contract | Clean: Task 5 must use Task 1's exact field names. |
| 2 / 3 | `server.js`, dynamic state and snapshots | Clean: Task 3 serializes the state Task 2 owns. |
| 2 / 4 | online/local phase transitions | Risk: two runtime implementations; parity assertions must compare exact allowed values and guards. |
| 2 / 5 | `callAIStory()` parser and prompt JSON | Clean: Task 5 documents and asserts the parser contract introduced by Task 2. |
| 2 / 6 | service behavior and restart | Clean: Task 6 verifies Task 2 through health and tests. |
| 3 / 4 | legacy `plan` recovery | Clean: both paths must retain legacy feature detection. |
| 3 / 6 | WebSocket/resume verification | Clean: Task 6 full suite records existing WebSocket baseline failures separately. |
| 4 / 5 | `index.html` request payload and prompt contract | Clean: Task 5 assertions cover the same field names used by Task 4. |
| 4 / 6 | browser syntax and focused tests | Clean. |
| 5 / 6 | prompt and #69175 regression tests | Clean. |
| 1 | tests vs helper implementation | Clean: tests describe real pure behavior. |
| 2 | dynamic flow vs legacy compatibility | Ruling: New runs set `flowMode: 'dynamic'`; existing snapshots without that marker remain legacy. This may leave old runs with the original narrative flaw, but avoids corrupting in-progress saves. |
| 3 | client fields vs server authority | Clean: client displays status but does not choose settlement. |
| 4 | local fallback vs structured decisions | Ruling: Plain-text fallback keeps the current phase and active statuses until a guard forces terminal failure at max steps. This can make fallback runs less varied, but cannot falsely complete. |
| 5 | JSON output vs prose length trimming | Risk: structured JSON must be parsed before trimming only the `text` field. |
| 6 | known unrelated suite failures | Clean: report actual counts; do not repair unrelated SQLite/WebSocket/admin tests. |

## Task Status

Task 1: fix round 1/5 opened — reviewer found max-step forged-success risk, `resolveNextPhase` mutation, and incomplete malformed-field coverage.
Task 1: fix round 1/5 (3 addressed, 3 boundary issues open — invalid truthy phase bypasses normalization; missing/invalid max-step encounter can remain active; malformed continue ignores valid fallback).
Task 1: fix round 2/5 (3 addressed, 1 open — malformed prior quest status at maxSteps).
Task 1: fix round 3/5 (1 addressed, 0 open; final review ADDRESSED).
Task 1: complete (No Git repository; 16/16 focused tests; review clean after 3 fix rounds).
Task 2: fix round 1/5 opened — runtime fallback can stay opening; same-step encounter resolution bypasses prior-state gate; max-step forced failure can be overridden by settlement AI; focus appended after payload; continue field unused.
Task 2: Ruling: `buildUserMessage()` dynamic-state wording and JSON response instructions remain Task 5 scope because the plan explicitly assigns prompt contract changes there; Task 2 must carry the fields in payload and parse responses, but does not need to edit prompt text. Cost if wrong: until Task 5 completes, live AI will usually use the safe plain-text fallback instead of structured decisions.
Task 2: fix round 1/5 completed — implementation report claims 7 runtime issues fixed; scoped re-review pending.
Task 2: fix round 1/5 (7 addressed, 1 blocker open — maxSteps incorrectly forces already-completed runs to failed; minSteps continue normalization also incomplete).
Task 2: fix round 2/5 (2 addressed, 1 open — payload construction can still leave ghost focus).
Task 2: fix round 3/5 (payload construction rollback addressed; scoped re-review APPROVE).
Task 2: complete (No Git repository; 29/29 focused tests; server.js and game-engine.js syntax checks pass).
Task 3: complete (legacy snapshots without flowMode remain on plan-based stepping; dynamic snapshots and WebSocket resume fields verified by 9/9 integration tests).
Task 4: skipped by product decision (single-player mode is deprecated; do not modify index.html local dungeon flow).
Task 5: complete (dynamic prompt contract, flexible flow rules, final-two-step guard, decorative-cameo constraints, and #69175 regression covered; focused suite passes).
Task 6: complete (focused suite 45/45; full suite 223 pass / 13 pre-existing failures; syntax checks pass; service restarted on port 8787 and /api/health returned ok=true).
