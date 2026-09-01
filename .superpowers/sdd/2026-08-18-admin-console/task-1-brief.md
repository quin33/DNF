### Task 1: 管理员会话与审计数据库层

**Files:**
- Modify: `db.js`
- Create: `test/admin-db.test.js`

Implement `admin_sessions` and `admin_audit_logs` in SQLite. Export `createAdminSession(token)`, `adminSessionValid(token)`, `deleteAdminSession(token)`, `searchPlayers(query)`, `getCharacterAdmin(charId)`, `saveCharacterAdmin(charId, expectedUpdatedAt, data)`, `addAdminAuditLog({ characterId, userId, before, after })`, and `getAdminAuditLogs(charId)`.

Requirements:
- Administrator sessions expire after exactly two hours and expired records are removed when checked.
- Player searches are parameterized and return player/role summaries only.
- Admin character lookup includes the owner username.
- Saves use `updated_at` optimistic locking and return `null` on a version mismatch.
- Audit entries retain white-listed before/after role snapshots.
- Add `test/admin-db.test.js` before production code. Verify the test fails before implementation, then passes after.
- Do not add runtime dependencies or alter normal-player functions.
