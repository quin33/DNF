### Task 2: Replace Preallocated Plans for New Server Runs

**Files:**
- Modify: `game-engine.js` — make `createDg()` initialize dynamic state while retaining legacy `plan` only for compatibility metadata.
- Modify: `server.js` — change new-run stepping, AI response parsing, state application, and terminal decision flow.
- Modify: `test/dungeon-flow.test.js` — assert new runs do not use phase step counts.
- Modify: `test/dungeon-flow-integration.test.js` — server-side state transition scenarios.

**Interfaces:**
- New `dg` state fields: `minSteps`, `maxSteps`, `phase`, `quest`, `encounter`, `lastDecision`, `nextHint`.
- `callAIStory(payload) -> { text, decision }` where `decision` is the normalized structure from Task 1.
- `dungeonStep(room)` applies exactly one AI decision and schedules or settles the next step.

- [ ] **Step 1: Write failing tests for dynamic new-run state**

  Add tests asserting:

  - `GE.createDg()` returns `minSteps === 10`, `maxSteps === 40`, `phase === 'opening'`, and quest/encounter state.
  - A new run does not rely on a fixed sum of `plan[*].steps` to determine completion.
  - A sequence of AI decisions `boss(active) -> boss(active) -> boss(resolve) -> loot -> closing` remains in `boss` until resolution and only then reaches `closing`.
  - A sequence that asks for `closing` at step 8 is forced to continue.
  - A sequence that reaches step 40 with `quest.status === 'active'` settles as failed/retreated.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run: `node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js`

  Expected: FAIL because new runs still advance through preallocated `plan` stages.

- [ ] **Step 3: Implement dynamic state initialization and decision application**

  In `createDg()`:

  - Initialize `minSteps: 10`, `maxSteps: 40`, `phase: 'opening'`, `quest.status: 'active'`, `encounter.status: 'none'`.
  - Derive the quest objective from dungeon lore/name without inventing a second objective source.
  - Initialize an empty `lastDecision` and `nextHint`.
  - Keep legacy `plan` only as a compatibility marker for old snapshots; do not use it to terminate newly created runs.

  In `server.js`:

  - Update the AI request payload to include current phase, quest status/objective, encounter status/name, `minSteps`, `maxSteps`, and the last decision hint.
  - Require the AI response parser to read `{ text, phase, event, questStatus, encounterStatus, nextHint, continue }` while accepting plain text as a safe fallback.
  - Apply the normalized decision before scheduling the next step.
  - Keep the first opening scene as an engine-prompted step, but do not create a fixed sequence after it.
  - Keep the current actor/focus information independent from phase length; append focus entries as steps are actually generated.

- [ ] **Step 4: Add authoritative transition rules in `dungeonStep()`**

  Implement this order:

  1. Build payload from current state and recent context.
  2. Generate and persist one step.
  3. Normalize and apply AI decision.
  4. Reject illegal `loot`/`closing` transitions when an encounter is active.
  5. If below `minSteps`, force `continue=true`.
  6. If terminal state is legal, call `settleRoom()`.
  7. If at `maxSteps`, mark unresolved state failed and call `settleRoom()`.
  8. Otherwise schedule the next tick.

- [ ] **Step 5: Run focused tests and syntax checks**

  Run:

  ```powershell
  node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js
  node --check server.js
  node --check game-engine.js
  ```

  Expected: new dynamic-flow tests pass and both files parse successfully.


