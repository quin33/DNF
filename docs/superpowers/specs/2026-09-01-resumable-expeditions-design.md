# Resumable Expeditions Design

## Goal

Keep an online expedition alive when the browser disconnects, the AI provider is temporarily unavailable, or the web server restarts. Only explicit cancellation, corrupt durable state, or a confirmed permanent configuration error may end the run without settlement.

## State Model

Runs use `starting`, `running`, `waiting_ai`, `settling`, and terminal `completed`, `failed`, `interrupted` states. Temporary AI failures move a run to `waiting_ai`; successful retry returns it to the state recorded in the durable snapshot.

## Durable Snapshot

The database snapshot stores a versioned private runtime object containing the room, the complete serializable dungeon state, the next operation, retry metadata, and the last error. WebSocket objects, timers, and transient enemy pointers are excluded and reconstructed.

Each successful story step is checkpointed before it is broadcast. Therefore a restart resumes at the next uncommitted step. A settlement restart may recompute AI output, but the existing transactional settlement commit remains the single authority for rewards.

## AI Retry

Transient network errors, timeouts, HTTP 408/409/425/429, and HTTP 5xx responses are retried in the background with bounded exponential backoff. The room remains registered and the character remains `adventuring`. Authentication and invalid configuration errors pause the run with a longer retry interval and a visible message rather than immediately failing it.

## Server Restart

At startup the server hydrates versioned snapshots into in-memory rooms before accepting normal play. Restorable runs are scheduled from their last checkpoint. Legacy or damaged snapshots continue through the existing safe interruption and stamina-refund path.

## Client Recovery

The browser reconnects indefinitely with jitter and resets its retry counter only after WebSocket authentication succeeds. Heartbeat traffic detects half-open connections. An authenticated HTTP active-run endpoint provides a fallback snapshot when WebSocket delivery is delayed. Temporary states keep the run card visible and show `正在重新连接` or `等待 AI 服务恢复`.

## Consistency

Only one timer may advance a room at once. Step application checks the expected durable step number before checkpointing. Settlement remains transactional and idempotent by `run_id`; repeated completion attempts return the existing terminal result rather than awarding rewards twice.

