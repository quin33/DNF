# Task 2 Report: Leader Start With AI Fill

## Status

Complete. This task adds server-side WebSocket handling only. No client room state or UI was implemented.

## Changed Files

- `server.js`
  - Added authenticated `room_start` and `room_dissolve` handlers.
  - Restricted both actions to the waiting room host.
  - Filled started rooms to four members with AI, retained the running room for expedition execution, and broadcast an updated public waiting-room list after start.
  - Deleted dissolved rooms, cleared each human member's room association, and broadcast the updated waiting-room list.
  - Passed `room.choice` into the existing `GE.createDg` API so the selected public-room dungeon is used by the expedition.
  - Added `baseDungeon` to the existing `dungeon_started.snapshot` payload so clients can identify the selected base map when hidden-dungeon presentation changes the displayed name.
- `test/admin-api.test.js`
  - Added real WebSocket integration coverage for non-host start rejection, two-AI fill for a two-human party, start notification to both humans, selected dungeon propagation, waiting-list removal, non-host dissolve rejection, and host dissolve removal.
- `.superpowers/sdd/2026-08-18-public-party-hall/task-2-report.md`
  - This report.

## TDD Evidence

### RED

The new WebSocket tests were added before production handling existed. The first unrestricted run was:

```text
node --test test/admin-api.test.js
```

It failed as expected because `room_start` and `room_dissolve` were not implemented:

```text
only the room host starts and missing members are filled with AI
actual: '未知消息类型'
expected: '只有队长可以开始探险'

only the room host dissolves a waiting room
actual: '未知消息类型'
expected: '只有队长可以解散队伍'

# tests 26
# pass 24
# fail 2
```

The initial sandboxed attempt could not write the SQLite test data (`attempt to write a readonly database`), so the same test command was rerun with approved database-write access to obtain the behavioral RED result above.

### GREEN

After the minimal server implementation, the same command completed successfully:

```text
node --test test/admin-api.test.js

1..18
# tests 26
# suites 0
# pass 26
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2956.8878
```

The only output besides TAP was Node's existing experimental SQLite warning.

## Verification

```text
node --check server.js
```

Exited with code 0.

## Self-Review

- Both actions authenticate the supplied player session before inspecting or changing room state.
- The host check compares the authenticated user ID to `room.host`; non-hosts cannot start or dissolve a waiting room.
- `room_start` accepts one to four human members. `fillNpcs` only adds the missing number, so the party contains exactly four members at launch.
- A started room is marked `running` before `broadcastRooms`, and `waitingRoomsPublic` filters it out. The room remains in `ROOMS` solely for the existing server-authoritative expedition lifecycle.
- The selected room `choice` is supplied to the existing `createDg(hostChar, opts)` API; no game-engine API change was needed.
- `room_dissolve` clears human WebSocket room references before deleting the waiting room, preventing stale disconnect cleanup from mutating a deleted room.
- The scope excludes frontend state, rendering, markup, and styling as required.

## Concerns

- No frontend consumes `room_start` or `room_dissolve` yet; that is intentionally deferred to the later Public Party Hall client tasks.

## Fix Round: Test Ordering

The 1/2/3/4-human start matrix launches real server-authoritative expeditions. When it ran before the settlement/recreate-room regression, its background runs could delay the following expedition's terminal event. The matrix test was moved after the settlement/recreate-room test; no production logic changed in this round.

Verification command:

```text
node --test test/admin-api.test.js

# tests 28
# pass 28
# fail 0
# cancelled 0
# todo 0
# duration_ms 8813.78
```
