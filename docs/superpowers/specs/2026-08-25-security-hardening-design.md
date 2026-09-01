# Security Hardening Design

## Scope

Protect the online service before public deployment. This phase covers static-file exposure, AI credential handling, default administrator credentials, and unauthenticated AI endpoints.

## Decisions

- Static serving uses an explicit allowlist of browser-facing files. Database files, configuration files, source files, backups, and documentation are never served.
- AI credentials are read from `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` environment variables, with optional numeric tuning variables. The checked-in configuration contains no secret.
- Startup scripts no longer set a default administrator password. They fail with a clear message unless `ADMIN_PASSWORD` is provided by the environment.
- All AI routes require a valid player session. Requests are limited by body size, per-IP rate, and in-flight AI calls. Limits return `401`, `413`, or `429` without invoking the provider.
- Existing local development remains possible with environment variables; no new runtime dependency is introduced.

## Verification

- Static requests for `/ai.config.json`, `/tavern.db`, database backups, `/server.js`, and arbitrary `.md` files return `404`.
- `/api/ai/*` rejects missing authentication and accepts an authenticated request only when the provider is configured.
- Repeated AI requests hit the rate/concurrency guard without calling the provider.
- `npm test`, syntax checks, and dependency audit remain green apart from pre-existing integration failures documented separately.
