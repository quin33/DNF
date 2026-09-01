# Public Party Hall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy party forecast with a map-focused public party hall where players create, join, and lead parties into server-authoritative expeditions.

**Architecture:** Reuse the server's in-memory `ROOMS` map as the source of truth for waiting public parties. Add authenticated WebSocket room actions and `rooms_updated` broadcasts. The online client receives the room list and renders map cards, commands, and public party cards in the existing party tab.

**Tech Stack:** Node.js, `ws`, SQLite-backed player authentication, vanilla JavaScript, HTML templates, CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-18-public-party-hall-design.md`

## Global Constraints

- Remove the legacy "灵墟候车风向" module completely.
- Public room state remains in memory and is never persisted to SQLite.
- A room accepts one to four human members; leader start fills missing slots with AI.
- Only the room host can start or dissolve a waiting room.
- Players cannot simultaneously be in automatic matchmaking and a public room.
- Public room updates use authenticated WebSocket messages and existing toast errors.
- The project is not a Git repository; do not add commit commands or worktrees.

---

### Task 1: Define And Test Public Room WebSocket Contracts

**Files:**
- Modify: `test/admin-api.test.js`
- Modify: `server.js: room helpers, WebSocket request switch`

**Interfaces:**
- Consumes: authenticated `auth` WebSocket state (`ws._uid`) and `DB.getCharacter(userId, charId)`.
- Produces: `rooms_updated` with `{ type: 'rooms_updated', rooms: RoomPublic[] }`; `room_state` with `{ type: 'room_state', room: RoomPublic | null }`; `error` for rejected room actions.
- `RoomPublic`: `{ id: string, name: string, status: 'waiting', dungeon: string, host: number, party: PartyMemberPublic[] }`.

- [ ] **Step 1: Write failing room lifecycle integration tests**

```js
test('a player creates a map-backed public room and another player joins it', async () => {
  const host = await connectPlayerWebSocket(playerToken);
  const guest = await connectPlayerWebSocket(secondPlayerToken);
  host.send(JSON.stringify({ type: 'room_create', token: playerToken, charId: pushCharacterId, dungeon: '幽影洞窟' }));
  const created = await nextWebSocketMessageOfType(host, 'rooms_updated');
  assert.equal(created.rooms.length, 1);
  assert.equal(created.rooms[0].dungeon, '幽影洞窟');
  guest.send(JSON.stringify({ type: 'room_join', token: secondPlayerToken, roomId: created.rooms[0].id, charId: secondCharacterId }));
  const joined = await nextWebSocketMessageOfType(host, 'rooms_updated');
  assert.equal(joined.rooms[0].party.length, 2);
});
```

- [ ] **Step 2: Run the new lifecycle test to verify it fails**

Run: `node --test test/admin-api.test.js`

Expected: FAIL because `room_create` does not yet emit `rooms_updated`.

- [ ] **Step 3: Add room-list helpers in `server.js`**

```js
function waitingRoomsPublic() {
  return Array.from(ROOMS.values()).filter(room => room.status === 'waiting').map(roomStatePublic);
}
function broadcastRooms() {
  const payload = JSON.stringify({ type: 'rooms_updated', rooms: waitingRoomsPublic() });
  wss.clients.forEach(ws => { if (ws.readyState === 1 && typeof ws._uid === 'number') ws.send(payload); });
}
function roomForMember(ws) {
  return ws._roomId ? ROOMS.get(ws._roomId) : null;
}
```

- [ ] **Step 4: Implement `room_create`, `room_join`, `room_leave`, and `rooms` WebSocket actions**

```js
case 'room_create': {
  const user = authenticatedSocketUser(msg.token);
  const character = user && DB.getCharacter(user.id, Number(msg.charId));
  if (!character || roomForMember(ws) || MATCH_QUEUE.some(entry => entry.ws === ws)) return send({ type: 'error', error: '无法创建队伍' });
  if (!validDungeonName(msg.dungeon)) return send({ type: 'error', error: '地图不存在' });
  const room = { id: 'R' + roomSeq++, name: character.data.name + '的队伍', host: user.id, status: 'waiting', choice: msg.dungeon, party: [] };
  addMember(room, memberFromCharacter(user.id, character, ws));
  ws._roomId = room.id;
  ROOMS.set(room.id, room);
  broadcastRooms();
  return;
}
```

Implement `room_join` with waiting-state, capacity, duplicate, and membership checks. Implement `room_leave` using one shared `leaveWaitingRoom(ws, room)` helper that transfers `room.host` to the first remaining human member or deletes the room. `rooms` replies with `rooms_updated` only to the requesting socket.

- [ ] **Step 5: Run the lifecycle test to verify it passes**

Run: `node --test test/admin-api.test.js`

Expected: PASS for public room creation, map propagation, and membership broadcast.

### Task 2: Test And Implement Leader Start With AI Fill

**Files:**
- Modify: `test/admin-api.test.js`
- Modify: `server.js: start-room helpers and WebSocket request switch`

**Interfaces:**
- Consumes: `ROOMS` waiting room and `room.host`.
- Produces: `dungeon_started` with a four-member `snapshot.party`; `rooms_updated` without the started room.

- [ ] **Step 1: Write failing authorization and start tests**

```js
test('only the room host starts and missing members are filled with AI', async () => {
  const roomId = await createRoomWithHostAndGuest();
  guest.send(JSON.stringify({ type: 'room_start', token: secondPlayerToken, roomId }));
  assert.equal((await nextWebSocketMessageOfType(guest, 'error')).error, '只有队长可以开始探险');
  host.send(JSON.stringify({ type: 'room_start', token: playerToken, roomId }));
  const started = await nextWebSocketMessageOfType(host, 'dungeon_started');
  assert.equal(started.snapshot.party.length, 4);
  assert.equal(started.snapshot.party.filter(member => member.isNpc).length, 2);
});
```

- [ ] **Step 2: Run the start test to verify it fails**

Run: `node --test test/admin-api.test.js`

Expected: FAIL because `room_start` is not implemented.

- [ ] **Step 3: Implement `room_start` and `room_dissolve`**

```js
case 'room_start': {
  const room = ROOMS.get(String(msg.roomId || ''));
  if (!room || room.status !== 'waiting') return send({ type: 'error', error: '队伍不存在或已出发' });
  if (room.host !== ws._uid) return send({ type: 'error', error: '只有队长可以开始探险' });
  fillNpcs(room);
  broadcastRooms();
  startRoomRun(room, room.party.find(member => member.uid === room.host).char);
  return;
}
```

Add `room_dissolve` that checks `room.host === ws._uid`, clears `_roomId` for all humans, deletes the room, and calls `broadcastRooms()`. Update waiting-room disconnect cleanup to call `leaveWaitingRoom` and broadcast changes.

- [ ] **Step 4: Run the start test to verify it passes**

Run: `node --test test/admin-api.test.js`

Expected: PASS for leader-only start, four-member snapshot, and AI fill.

### Task 3: Build The Party Hall Client State And WebSocket Actions

**Files:**
- Modify: `online.js: WebSocket message handler, room actions, party rendering overlay`

**Interfaces:**
- Consumes: `rooms_updated`, `room_state`, `error`, `dungeon_started`.
- Produces: `window.publicRooms`, `createPublicRoom()`, `joinPublicRoom(roomId)`, `leavePublicRoom()`, `startPublicRoom(roomId)`, and `dissolvePublicRoom(roomId)`.

- [ ] **Step 1: Add a focused browser-free behavior test for room payload handling**

```js
test('public room broadcast preserves map, host, and party occupancy', () => {
  const state = normalizePublicRooms([{ id: 'R1', dungeon: '幽影洞窟', host: 7, party: [{ uid: 7, name: 'Host' }] }]);
  assert.deepEqual(state[0], { id: 'R1', dungeon: '幽影洞窟', host: 7, party: [{ uid: 7, name: 'Host' }] });
});
```

Extract `normalizePublicRooms` into a small CommonJS-exportable helper only if the browser file cannot be tested through an existing integration boundary. Otherwise, use the WebSocket integration test in Task 1 as the behavior test and do not add an artificial export.

- [ ] **Step 2: Add room state and incoming message handling**

```js
let publicRooms = [];
function setPublicRooms(rooms) {
  publicRooms = Array.isArray(rooms) ? rooms : [];
  if (document.querySelector('#tab-party')) renderParty();
}
// inside handleWsMsg
case 'rooms_updated': setPublicRooms(d.rooms); break;
```

On successful online login, send `{ type: 'rooms' }`. Add action functions that validate the selected role and map, ensure `wsReady`, then send the matching `room_*` request with `API.token` and `role._char_db_id`.

- [ ] **Step 3: Preserve mutual exclusion on the client**

```js
function canEnterPublicRoom() {
  return !window.matchQueue && !activeWsRun && !publicRooms.some(room => room.party.some(member => member.uid === API.user.id));
}
```

Use the guard before create or join. Keep server validation authoritative and show server errors through the existing `toastMsg` route.

- [ ] **Step 4: Manually verify WebSocket state refresh in a local browser**

Open two logged-in accounts, create a room in one, and confirm the other sees the new card without reloading. Join from the second account and confirm both cards show `2 / 4`.

### Task 4: Replace The Legacy Party UI With Map And Room Cards

**Files:**
- Modify: `index.html: renderParty()`
- Modify: `online.js: renderPartyOnline()`
- Modify: `style.css: party hall map and room card styles`

**Interfaces:**
- Consumes: `DUNGEON_POOL`, `matchDungeonChoice`, `publicRooms`, `API.user.id`, and room action functions from Task 3.
- Produces: no legacy `PARTY FORECAST · 灵墟候车风向` markup; accessible map cards and public party cards.

- [ ] **Step 1: Remove the legacy forecast heading and list**

```js
// Delete the complete block beginning with:
// <h3 class="col-title">PARTY FORECAST · 灵墟候车风向</h3>
// and ending with its enclosing </div> after DUNGEON_POOL.map(...).
```

- [ ] **Step 2: Render selectable map cards with complete map identity**

```js
const mapCards = DUNGEON_POOL.map(d => `
  <button class="party-map-card ${matchDungeonChoice === d.name ? 'selected' : ''}" onclick="selectMatchDungeon('${esc(d.name)}')">
    <span class="party-map-icon">${esc(d.icon)}</span>
    <span class="party-map-name">${esc(d.name)}</span>
    <span class="party-map-realm">${esc(d.level_desc)}</span>
    <span class="party-map-desc">${esc(d.desc || '未知灵墟')}</span>
    <span class="party-map-loot">${d.loot.length} 类战利品</span>
  </button>`).join('');
```

Place the map board above the automatic-match and create-party commands. Include a random-map button that calls `selectMatchDungeon(null)`.

- [ ] **Step 3: Render public room cards and commands**

```js
const cards = publicRooms.map(room => {
  const isHost = room.host === API.user.id;
  const isMember = room.party.some(member => member.uid === API.user.id);
  return `<article class="public-party-card">
    <div class="public-party-map">${esc(room.dungeon)}</div>
    <div class="public-party-members">${room.party.map(member => esc(member.name)).join('、')} · ${room.party.length} / 4</div>
    ${isHost ? `<button onclick="startPublicRoom('${room.id}')">开始探险</button><button onclick="dissolvePublicRoom('${room.id}')">解散队伍</button>`
      : isMember ? `<button onclick="leavePublicRoom()">离开队伍</button>`
      : `<button onclick="joinPublicRoom('${room.id}')">加入队伍</button>`}
  </article>`;
}).join('');
```

Add one `创建队伍` command below the selected map. Disable or hide actions when the player is in automatic matching, another room, or an active run.

- [ ] **Step 4: Add stable responsive styles**

```css
.party-map-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; }
.party-map-card { min-height:132px; text-align:left; border:1px solid var(--color-border); border-radius:6px; }
.public-party-card { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; border:1px solid var(--color-border); border-radius:6px; padding:12px; }
@media (max-width: 520px) { .public-party-card { grid-template-columns:1fr; } }
```

- [ ] **Step 5: Perform visual verification**

At desktop and 390px mobile widths, confirm map titles, realms, descriptions, loot labels, occupancy, and buttons fit without overlap. Confirm the selected map remains distinct and the create-party command is immediately below the map area.

### Task 5: Regression Verification And Service Reload

**Files:**
- Modify: `test/admin-api.test.js`
- Verify: `server.js`, `online.js`, `index.html`, `style.css`

**Interfaces:**
- Consumes: completed WebSocket room actions and client party hall.
- Produces: verified running server on port 8787.

- [ ] **Step 1: Run the full suite serially**

Run: `node --test --test-concurrency=1 test/*.test.js`

Expected: all tests pass. Serial execution is required because the existing test files share the same SQLite database.

- [ ] **Step 2: Restart the local service with the configured administrator environment**

Run the existing `启动后台.bat` after stopping only the known `node server.js` process on port 8787.

- [ ] **Step 3: Verify the running assets and flows**

Request `http://127.0.0.1:8787/online.js` and assert it includes `rooms_updated` and `createPublicRoom`. Request `http://127.0.0.1:8787/` and confirm status 200. In two browser sessions, create, join, and start a room with fewer than four humans.
