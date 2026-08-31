# Shared Expedition Logs Design

## Goal

Store one canonical expedition log per multiplayer run. Every player can watch the same live run, and every human participant can read the same persisted log through a participant association instead of owning a duplicated copy.

The migration must consolidate existing duplicate rows without losing the most complete story, settlement results, or participant membership.

## Current Problems

- `settleRoom()` inserts one copy of the same run for every human player.
- Public reads fetch 200 database rows before deduplicating, so duplicate copies hide older unique runs.
- The business `log.id` is allocated per user and is not unique in the public list. Frontend lookups by `id` can open or favorite another user's log.
- Failed test users can leave orphan log rows because `logs.user_id` has no foreign key.

## Data Model

Keep `logs` as the canonical log table and add:

```sql
CREATE TABLE log_participants (
  log_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  character_id INTEGER,
  member_name TEXT NOT NULL DEFAULT '',
  personal_data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (log_id, user_id),
  FOREIGN KEY (log_id) REFERENCES logs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

`logs.id` becomes the stable global database identifier exposed as `log_key`. Existing JSON `id` remains only as a display number for legacy compatibility. New shared logs use the database row id as their displayed number after insertion.

The canonical log contains shared fields: `run_id`, party, dungeon, status, story, summary, verdict, steps, and the complete party settlement. Participant-specific information such as the viewer's character id and personal settlement can be stored in `log_participants.personal_data` when needed.

## Write Flow

On successful settlement:

1. Build one canonical log containing the complete story and all member results.
2. Insert it once with all human participant ids in one transaction.
3. Add one `log_participants` row per human participant.
4. Return the same `logId`/`logKey` to every participant result.

On technical failure, use the same one-log transaction: save the partial story once and associate every human participant.

The legacy authenticated `POST /api/log` route writes one canonical log associated with the authenticated user.

## Read Flow

- `GET /api/logs` joins `log_participants` and returns canonical logs for the authenticated user.
- `GET /api/public/logs` reads canonical `logs` rows directly. It no longer performs JavaScript run deduplication.
- Queries order by canonical `logs.created_at DESC, logs.id DESC` and do not truncate before uniqueness is established. The existing UI can paginate the complete returned collection.
- API output includes `log_key` from the database row id.

## Real-Time Visibility

- `dungeon_started`, `step`, `settled`, and `run_error` events are broadcast to every authenticated WebSocket client, not only members of the room.
- A non-participant can open the logs tab while a run is active and see its current snapshot and every subsequent step.
- When any authenticated player connects or refreshes, the server sends snapshots for all currently running dungeons, allowing non-participants to resume watching without joining the room.
- The client keeps one shared active-run entry per `run_id`; receiving a participant-specific settlement must not create duplicate local logs.
- Guests without an authenticated session are outside the current player model and do not receive private game events.

Frontend detail, favorite, live-completion, biography, and local lookup operations use `log_key`, with `run_id` and legacy `id` fallbacks for old local-only saves.

## Existing Data Migration

Run an idempotent transaction during database initialization:

1. Group rows with a non-empty `run_id` by `run_id`.
2. Choose one canonical row using this priority:
   - a completed settlement over a technical-failure copy;
   - more story steps and longer `result_summary`;
   - a populated summary and settlement;
   - newest database row as the final tie-breaker.
3. Merge participant membership from every duplicate row before deleting duplicates. Existing `user_id`, character ids recoverable from party/settlement data, and member names are retained.
4. Preserve the richest shared JSON fields on the canonical row. Keep the original creation time of the run where available.
5. Delete duplicate rows only after participant rows have been written successfully.
6. For legacy rows without `run_id`, keep one canonical row each and associate the original owner. They are not merged using heuristic text keys because accidental data loss is worse than leaving unrelated legacy entries separate.
7. Remove orphan rows whose original `user_id` no longer exists and which have no valid participant. This clears `FAST_MODE` test pollution.

The migration records completion in a `schema_migrations` table. Re-running startup is a no-op.

## Compatibility

- Existing single-player logs become canonical logs with one participant.
- Public viewing remains available without authentication.
- Personal logs include shared party settlement data, so all participants see the same story and result.
- Old browser-local logs continue working through the frontend fallback key.

## Error Handling

- Canonical log insertion and participant insertion are one transaction; neither is committed alone.
- Migration rolls back entirely on any error.
- Duplicate cleanup occurs only inside the successful migration transaction.
- Database foreign keys cascade participant cleanup when a canonical log or user is removed.

## Tests

- Migration combines duplicate rows for one `run_id` into one canonical row and retains every valid participant.
- Migration selects the richest copy and is idempotent.
- Migration removes orphan test logs without valid users.
- A four-player settlement inserts one log and four participant rows; each player's `/api/logs` response contains the same `log_key`.
- A multiplayer technical failure also inserts one shared log.
- A non-participant WebSocket client receives start, step, settlement, and error events for every active run.
- Reconnecting a non-participant receives snapshots for all active runs.
- Public logs contain one row per stored run and are not reduced by a pre-deduplication limit.
- Frontend source tests verify that detail/favorite operations use the global log key instead of the per-user display id.

## Out Of Scope

- Redesigning the log page UI.
- Changing AI outcome or settlement-timeout behavior.
- Adding server-side API pagination in this change; the canonical model first removes duplicate amplification and missing history.
