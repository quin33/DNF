# Task 1: Add Pure Decision and Settlement Guards

## Context

This is the foundation of the AI-driven dungeon flow. Implement only pure decision normalization and guard functions in `game-engine.js`, plus focused tests in `test/dungeon-flow.test.js`. Do not change `server.js`, `index.html`, prompts, or runtime stepping yet.

## Global Constraints

- New flow uses minimum 10 and maximum 40 steps.
- Quest statuses: `active`, `completed`, `failed`, `retreated`.
- Encounter statuses: `none`, `active`, `resolved`, `escaped`.
- Allowed phases: `opening`, `explore`, `encounter`, `battle`, `boss`, `loot`, `rest`, `retreat`, `closing`.
- Allowed events: `advance`, `resolve`, `fail`, `retreat`.
- Invalid AI control fields must use safe fallbacks and must not trigger early settlement.
- Active encounters block `loot` and `closing`; active quests block `closing`.
- Before step 10, `closing` is illegal. At step 40, unresolved work must become failed/retreated rather than successful.
- Do not add dependencies.

## Required Interfaces

Implement and export:

```js
normalizeAiDecision(raw, fallback)
canEnterClosing(state, decision)
resolveNextPhase(state, decision)
applyAiDecision(state, decision)
```

`normalizeAiDecision()` returns exactly:

```js
{
  phase,
  event,
  questStatus,
  encounterStatus,
  nextHint,
  continue
}
```

`applyAiDecision()` mutates the supplied dungeon state consistently, updates `quest.status`, `encounter.status`, `phase`, `lastDecision`, and `nextHint`, then returns the normalized decision. Do not increment `totalStep`; runtime stepping owns that later.

## TDD Requirements

Create `test/dungeon-flow.test.js` first and verify RED before editing production code. Cover:

1. Invalid phase falls back to `fallback.phase`.
2. Missing statuses fall back to safe active statuses unless a valid fallback supplies otherwise.
3. `nextHint` is converted to a trimmed bounded string.
4. `continue` is normalized to a boolean with safe continuation by default.
5. Closing before `minSteps` is rejected.
6. Closing with active quest is rejected.
7. Closing with active encounter is rejected.
8. Completed, failed, and retreated quests can close after `minSteps` when encounter is resolved/escaped/none.
9. Active encounter rejects `loot` and preserves the current conflict phase.
10. At `maxSteps`, unresolved quest becomes failed and the next phase is closing.
11. `applyAiDecision()` updates only the decision-owned state fields and stores the normalized decision.

Use Node's built-in `node:test` and `node:assert/strict`, requiring the real `game-engine.js` module.

## Verification

Run:

```powershell
node --test test/dungeon-flow.test.js
node --check game-engine.js
```

Write the full report to:

`.superpowers/sdd/2026-08-26-ai-driven-dungeon-flow/task-1-report.md`

Include RED and GREEN command output, files changed, self-review, and concerns. This workspace has no Git repository; do not attempt commits or destructive rollback. Do not dispatch subagents.
