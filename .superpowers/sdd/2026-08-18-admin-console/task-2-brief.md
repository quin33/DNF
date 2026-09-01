### Task 2: 管理员认证、校验与 HTTP API

**Files:**
- Modify: `server.js`
- Create: `test/admin-api.test.js`

Use Task 1 database helpers to implement administrator routes: `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/players`, `GET /api/admin/characters/:id`, `PUT /api/admin/characters/:id`, and `GET /api/admin/audit`.

Requirements:
- Password comes only from `process.env.ADMIN_PASSWORD`; no configured password means administrator access is denied.
- Login compares equal-length UTF-8 buffers with `crypto.timingSafeEqual`, creates a `newToken()` session, and returns a Bearer token.
- Every other `/api/admin/*` endpoint requires a valid administrator session; ordinary player sessions always receive `401`.
- Only these character fields may be updated: `name`, `character_class`, `level`, `hp`, `max_hp`, `stamina`, `max_stamina`, `strength`, `agility`, `intelligence`, `luck`, `gold`, `exp`, `traits`, `equipment`, `bag`, `skills`, `skillPool`.
- Reject unknown fields, non-finite and negative numeric fields, `hp > max_hp`, `stamina > max_stamina`, malformed arrays, overlong text, and inventory arrays over 100 items.
- Preserve unspecified existing fields. Use incoming `updated_at` for optimistic locking; return `409` for conflicts, `400` invalid input, `404` missing character, and `401` unauthorized.
- Successful updates create the Task 1 audit log from whitelist-only snapshots.
- Write `test/admin-api.test.js` first, run it red, then implement and run it green. Do not add dependencies or modify normal player APIs.
