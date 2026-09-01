### Task 3: 独立后台页面

**Files:**
- Create: `admin.html`
- Create: `admin.css`
- Create: `admin.js`
- Modify: `server.js`
- Create: `test/admin-page.test.js`

Create a standalone `/admin` management UI consuming Task 2's REST API.

Requirements:
- The page includes login, player search, player/role list, role editor, audit list, logout, loading/error states.
- Store the admin Bearer token only in `sessionStorage` key `tavern_admin_token`; clear it on logout and all `401` responses.
- Render editable field groups: identity, progression/resources, four attributes, traits, equipment, bag, skills, and skill pool.
- Scalar data uses inputs; arrays use JSON textareas. Keep server `updated_at` and send it on every save.
- Reject invalid JSON arrays and numeric input client-side. Show a change summary before save. On `409`, retain edits and offer reload; after save, refresh data/audit.
- Serve `/admin` only when `ADMIN_PASSWORD` is configured; add required MIME types.
- Add and run `test/admin-page.test.js` in RED before page implementation, then GREEN. Do not add dependencies.
