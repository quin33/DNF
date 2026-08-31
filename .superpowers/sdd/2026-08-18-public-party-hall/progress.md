# SDD ledger - plan: I:\DEEPSEEK\tavern_clone\docs\superpowers\plans\2026-08-18-public-party-hall.md

| Tasks | Shared surface | Dependency check |
| --- | --- | --- |
| 1 and 2 | `server.js` room helpers and WebSocket switch; `test/admin-api.test.js` | Task 2 consumes waiting-room lifecycle from Task 1; run sequentially. |
| 1 and 3 | `rooms_updated` contract | Task 3 consumes the contract produced by Task 1. |
| 3 and 4 | `online.js` party state and render overlay | Task 4 consumes client room actions from Task 3; run sequentially. |
| 1, 2, 3, and 4 | `ROOMS`, `publicRooms`, party page | No conflicting requirements; the spec requires server-authoritative rooms and client rendering only. |
| 5 | all changed files | Verification only; runs after implementation tasks. |

Ruling: Use the existing in-memory `ROOMS` map and do not introduce SQLite persistence - the specification explicitly requires ephemeral public rooms; the cost if wrong is that rooms disappear on server restart.

Task 1: fix round 1/5 opened - reviewer found cross-WebSocket duplicate membership, unauthenticated legacy HTTP room listing, and incomplete lifecycle coverage.
Task 1: fix round 1/5 complete (3 addressed, 0 open; scoped re-review clean).
Task 1: complete (no Git repository; review clean).
Task 2: fix round 1/5 opened - reviewer found completed runs retain room references and tests only cover two human starters.
Task 2: fix round 1/5 complete (2 addressed, 0 open; scoped re-review clean).
Task 2: complete (no Git repository; review clean).
Task 3: complete (no Git repository; review clean).
