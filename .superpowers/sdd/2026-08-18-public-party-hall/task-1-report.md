# Task 1 Report: Public Room WebSocket Contracts

## Scope

Implemented only the public waiting-room lifecycle in `server.js` and its real WebSocket integration coverage in `test/admin-api.test.js`. No leader start/dissolve flow, client room state, party UI, or styling was changed.

## Changed Files

- `server.js`
  - Added authenticated room action helpers, dungeon validation, public waiting-room serialization, and authenticated `rooms` responses.
  - Added `room_create`, `room_join`, and `room_leave` request handlers.
  - Added `rooms_updated` broadcasts after creation, joins, and waiting-room leave/disconnect cleanup.
  - Waiting-room host ownership transfers to the first remaining human member when the host leaves.
- `test/admin-api.test.js`
  - Added a second real player fixture and token.
  - Added the real WebSocket lifecycle test for creation with `迷雾泽` and a second player joining.
- `.superpowers/sdd/2026-08-18-public-party-hall/task-1-report.md`
  - This report.

## TDD Evidence

1. Added the lifecycle integration test before changing `server.js`.
2. RED command: `node --test test/admin-api.test.js`
   - Initial sandbox run could not write the SQLite fixture database.
   - Elevated rerun reached the test and failed as intended: `WebSocket rooms_updated message was not received` for the new lifecycle test; the pre-existing tests passed.
3. Implemented the minimum room lifecycle handlers and helper functions.
4. GREEN command: `node --test test/admin-api.test.js`
   - Exit code `0`; `20` tests passed, `0` failed, `0` cancelled, `0` skipped.

## Self-Review

- `rooms_updated` exposes only waiting rooms and is sent only to authenticated WebSocket clients.
- `rooms` returns `rooms_updated` to its authenticated requester; create, join, and leave return `room_state` to the acting socket and broadcast the public list.
- Room creation and join validate an authenticated owner for the supplied character, prohibit queued sockets, validate a known dungeon, enforce waiting status and a four-human-member maximum, and prevent duplicate membership in the selected room.
- Leave and disconnect share the waiting-room cleanup path, delete empty rooms, transfer host ownership when required, and broadcast the updated list.
- Deferred intentionally: leader start, room dissolve, AI fill, run creation, and all client UI behavior belong to later plan tasks.

## Remaining Concerns

- This task validates the required create/join lifecycle. Authorization, full-capacity rejection, host start, and AI fill require the additional tests scheduled in Task 2.
- Public rooms are in-memory only and are cleared by a server restart, as required by the design.

## Fix Round: Review Findings

### Changes

- Added `roomForUser(uid)` and use it for public-room creation and joining, so a user cannot occupy a second waiting room from another WebSocket connection.
- Kept `GET /api/rooms` and required a valid Bearer player session before returning waiting-room data.
- Rejected `match_start` for a user already in a public waiting room, preserving mutual exclusion without silently removing the player from the room.
- Expanded real WebSocket coverage for both-recipient broadcasts, cross-connection duplicate create/join, unauthenticated and foreign-character input, full and duplicate rooms, public-room versus matchmaking exclusion, and host-disconnect leadership transfer.
- Made the WebSocket test helper wait for a matching payload so delayed prior broadcasts cannot satisfy a later lifecycle assertion.

### TDD Evidence

The new tests were added before this fix. Their RED run (`node --test test/admin-api.test.js`) failed as expected with:

```text
HTTP public room listing requires a player session: 200 !== 401
a player cannot occupy multiple waiting rooms through separate WebSockets: WebSocket error message was not received
room lifecycle rejects unauthenticated, foreign, full, duplicate, and queued memberships: WebSocket error message was not received
host disconnect transfers waiting-room ownership and broadcasts the updated room: host remained unchanged
```

### Final Test Command And Exact Result Summary

```text
node --test test/admin-api.test.js
1..16
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2960.6173
```

The Node runtime emitted its existing SQLite experimental-feature warning; no test failures occurred.

### Fix Round Self-Review

- `roomForUser` scans only `waiting` rooms, so it does not alter later running-room behavior reserved for Task 2.
- The HTTP endpoint preserves its response shape (`{ rooms }`) for authenticated consumers and no longer discloses waiting-room participants to unauthenticated callers.
- The lifecycle tests exercise the running HTTP server and real `ws` clients, rather than mocks.
- No `room_start`, `room_dissolve`, AI fill, client state, markup, or styling was added.

### Final Re-run Exact TAP Output

```text
TAP version 13
# (node:13600) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# Subtest: spawned server preserves player login sessions and character access
ok 1 - spawned server preserves player login sessions and character access
# Subtest: admin login denies missing configuration and wrong passwords, then creates a bearer session
ok 2 - admin login denies missing configuration and wrong passwords, then creates a bearer session
# Subtest: admin endpoints reject missing credentials and ordinary player sessions
ok 3 - admin endpoints reject missing credentials and ordinary player sessions
# Subtest: HTTP public room listing requires a player session
ok 4 - HTTP public room listing requires a player session
# Subtest: admin can search players and read a character with its owner and version
ok 5 - admin can search players and read a character with its owner and version
# Subtest: match queue broadcasts a two-minute countdown to the queued player
ok 6 - match queue broadcasts a two-minute countdown to the queued player
# Subtest: a player creates a map-backed public room and another player joins it
ok 7 - a player creates a map-backed public room and another player joins it
# Subtest: a player cannot occupy multiple waiting rooms through separate WebSockets
ok 8 - a player cannot occupy multiple waiting rooms through separate WebSockets
# Subtest: room lifecycle rejects unauthenticated, foreign, full, duplicate, and queued memberships
ok 9 - room lifecycle rejects unauthenticated, foreign, full, duplicate, and queued memberships
# Subtest: host disconnect transfers waiting-room ownership and broadcasts the updated room
ok 10 - host disconnect transfers waiting-room ownership and broadcasts the updated room
# Subtest: admin saves notify the owning player through WebSocket
ok 11 - admin saves notify the owning player through WebSocket
# Subtest: player saves with an outdated character version do not overwrite admin changes
ok 12 - player saves with an outdated character version do not overwrite admin changes
# Subtest: admin save updates only submitted whitelist fields and records safe audit snapshots
ok 13 - admin save updates only submitted whitelist fields and records safe audit snapshots
# Subtest: admin save rejects unknown fields, invalid numbers, invalid arrays, and oversized text or inventories
ok 14 - admin save rejects unknown fields, invalid numbers, invalid arrays, and oversized text or inventories
# Subtest: admin save returns conflict for a stale version and not found for a missing character
ok 15 - admin save returns conflict for a stale version and not found for a missing character
# Subtest: admin logout invalidates the current session
ok 16 - admin logout invalidates the current session
1..16
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2931.6917
```
