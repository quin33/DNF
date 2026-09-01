# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent public leakage of project data and protect AI/provider credentials and spend.

**Architecture:** Keep the existing single Node process, but make configuration environment-driven, static serving allowlist-based, and AI routes pass through one authenticated/rate-limited guard.

**Tech Stack:** Node.js 22 CommonJS, native HTTP, SQLite, WebSocket, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-security-hardening-design.md`

## Global Constraints

- No new runtime dependency.
- Preserve existing browser-facing URLs and authenticated gameplay flows.
- Never serve database, configuration, source, backup, or documentation files.
- Never log or return API keys.

### Task 1: Environment configuration and safe launch scripts

**Files:**
- Modify: `server.js`
- Modify: `ai.config.json`
- Modify: `启动游戏.bat`
- Modify: `启动后台.bat`
- Modify: `启动公网游戏.bat`
- Modify: `README.md`
- Test: `test/security-hardening.test.js`

- [ ] Add tests asserting AI config is sourced from environment values and launch scripts do not contain `ADMIN_PASSWORD=admin`.
- [ ] Implement environment-first configuration with empty safe defaults.
- [ ] Replace checked-in secret config with a non-secret example object.
- [ ] Make scripts require externally supplied `ADMIN_PASSWORD` and document required AI variables.
- [ ] Run focused tests and syntax checks.

### Task 2: Restrict static files

**Files:**
- Modify: `server.js`
- Test: `test/security-hardening.test.js`

- [ ] Add HTTP integration assertions for protected paths.
- [ ] Add a static allowlist for page assets and explicit path normalization.
- [ ] Return `404` for all non-allowlisted files, including database backups and source files.
- [ ] Preserve `/`, `/admin`, `/admin.html`, and existing public assets.
- [ ] Run the focused HTTP tests.

### Task 3: Authenticate and limit AI routes

**Files:**
- Modify: `server.js`
- Test: `test/security-hardening.test.js`

- [ ] Add tests for unauthenticated rejection, body-size rejection, rate rejection, and concurrency rejection.
- [ ] Implement one guard using `authUser`, client IP, a short rate window, and an in-flight counter.
- [ ] Apply it consistently to all `/api/ai/*` routes before provider calls.
- [ ] Ensure guard failures do not call the provider and return generic errors.
- [ ] Run focused tests and the full suite.

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `DEPLOY.md`

- [ ] Document environment variables and safe startup requirements.
- [ ] Remove instructions that edit `ai.config.json` with a live key.
- [ ] Run `node --check`, `npm test`, and `npm audit --omit=dev`.
- [ ] Record any unrelated pre-existing integration failures without claiming a fully green suite.
