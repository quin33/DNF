# Public Party Hall Design

## Goal

Replace the "Party Forecast" module with a focused online party hall. Players can choose a dungeon map, enter automatic matchmaking, or create and join public parties. A party leader may begin an expedition at any time; empty seats are filled with AI allies up to four total members.

## Scope

- Remove the legacy "灵墟候车风向" list.
- Present available maps as selectable, informative cards.
- Add public party creation, listing, joining, leaving, and leader-start actions.
- Keep automatic matchmaking as a separate action in the same hall.
- Synchronize party cards and membership through WebSocket messages.

## User Experience

The party page begins with a compact map board. Each card shows the dungeon icon, name, recommended realm, description, and loot count. Selecting a card supplies that map choice to either matchmaking or a newly created party.

Below the map board are two commands: "单人匹配" and "创建队伍". Matchmaking keeps its existing two-minute queue and countdown. Creating a party immediately makes a public card. Cards show the map, leader, member avatars/names, and occupancy such as `2 / 4`.

Other eligible online players see new and changed cards in real time and can select "加入队伍". The creator alone sees "开始探险" and "解散队伍". Starting creates the existing server-authoritative expedition; any remaining seats are populated by AI allies. A member can leave before the run. A party is removed from the public list when it starts, is dissolved, or has no human members.

## Server Model

Reuse the existing in-memory `ROOMS` map for waiting public parties. A waiting room records:

- room id, display name, host user id, selected dungeon name, creation time, and waiting status;
- human members with user id, character id, character data, WebSocket reference, and realm;
- no persistent database state.

WebSocket requests require a valid authenticated user and an owned character id.

| Request | Authority | Effect |
| --- | --- | --- |
| `room_create` | authenticated player | Validates no existing queue/room membership, creates a waiting room, and broadcasts the room list. |
| `room_join` | authenticated player | Validates the room is waiting, has space, and does not already contain the player; then broadcasts membership and room list. |
| `room_leave` | member | Removes the player; deletes an empty room or transfers leadership to the first remaining human member. |
| `room_start` | room host | Verifies waiting state, fills to four with AI, removes the room from the public list, and starts the existing expedition. |
| `rooms` | authenticated player | Returns the current waiting-room list. |

The server broadcasts `rooms_updated` after every room membership or lifecycle change. Existing `dungeon_started` messages continue to drive expedition playback.

## Client State And Rendering

`online.js` owns a `publicRooms` array populated on login, on `rooms_updated`, and after a room action. The party renderer draws:

1. map selection cards;
2. the automatic match action and its active queue card;
3. the public-party creation command;
4. public party cards, with command availability based on current user id and membership.

Creating/joining/leaving/starting sends a WebSocket request only after connection authentication. The client reports server errors through the existing toast pattern. Any incoming room update re-renders the party page when visible.

## Validation And Error Handling

- A player cannot be in automatic matchmaking and a public room simultaneously.
- A player cannot join a full, running, missing, or already joined room.
- Only the current host can start or dissolve a room.
- Start succeeds with one to four human members; the server fills only missing seats with AI.
- Disconnect cleanup follows the same leave logic and broadcasts the resulting room list.
- The selected map must exist in the server dungeon pool; invalid values fall back to the existing server map selection behavior only for automatic matchmaking, while public room creation rejects invalid map choices.

## Tests

Integration tests exercise real WebSocket clients against a temporary server:

- a map-backed public room is visible after creation;
- another player joins and both clients receive the updated occupancy;
- only the leader starts a room;
- starting with fewer than four humans adds AI members and sends `dungeon_started` to human members;
- a non-leader start and an over-capacity join are rejected;
- the existing automatic matchmaking countdown remains intact.
