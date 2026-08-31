# Task 3 Report

## Scope

- Modified only `online.js` for public-party client state and WebSocket actions.
- Did not change party markup, styles, server APIs, or existing tests.

## Changes

- Added `publicRooms` state, exposed as `window.publicRooms`.
- Requests rooms after WebSocket authentication and applies `rooms_updated` broadcasts.
- Added `createPublicRoom`, `joinPublicRoom`, `leavePublicRoom`, `startPublicRoom`, and `dissolvePublicRoom` globals.
- Added client-side guards for active matchmaking, an active expedition, existing room membership, authentication, selected role, selected map, and WebSocket readiness.
- Preserved server authority and routed server errors through the existing toast function.

## Verification

- Browser tests are not present.
- `node --check online.js` completed successfully.
- Existing server integration tests were intentionally unchanged and passed with `node --test --test-concurrency=1 test/*.test.js`: 38 passed, 0 failed.
