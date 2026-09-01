# AI 驱动副本流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消副本阶段步数预分配，让 AI 按当前剧情决定下一叙事方向，同时由引擎强制执行最小/最大步数、任务收束与结算安全边界。

**Architecture:** 新副本使用“AI 决策 + 引擎约束”的状态机。每步 AI 返回正文与结构化决策字段；`game-engine.js` 提供纯函数完成字段规范化、阶段转换和收束判定，`server.js` 保持联机状态权威，`index.html` 同步单机流程。旧进行中快照继续使用旧 `plan`，避免恢复行为改变。

**Tech Stack:** Node.js、内置 `node:test`、SQLite 持久化、原生浏览器 JavaScript、OpenAI 兼容 `/chat/completions` 接口。

**Spec:** [docs/superpowers/specs/2026-08-26-ai-driven-dungeon-flow-design.md](I:/DEEPSEEK/tavern_clone/docs/superpowers/specs/2026-08-26-ai-driven-dungeon-flow-design.md)

## Global Constraints

- 新副本不得预先分配探索、战斗、首领、搜刮和归途的阶段步数。
- `10` 步前不得结束，`40` 步时必须结束。
- 任务未完成、失败或明确撤退前不得进入归途。
- 当前首领/危险仍 active 时不得进入搜刮或归途。
- AI 控制字段无效时保留正文，使用安全降级值，不自动重试。
- 保留角色连续焦点、允许出场名单、禁止主动出场名单和高光机制。
- 联机和单机使用相同的决策字段与收束语义。
- 旧的进行中快照继续按旧 `plan` 恢复；新状态机只用于新建副本。
- 不新增第三方依赖，不修改无关的既有失败测试。

## File Map

- Modify: `game-engine.js` — 新副本状态、AI 决策纯函数、阶段/收束安全边界、动态焦点支持。
- Modify: `server.js` — 联机 AI 响应解析、权威状态推进、WebSocket 状态广播、结算入口。
- Modify: `index.html` — 单机 AI/本地降级流程与状态展示同步。
- Modify: `xiuxian/ai_log_prompt.md` — 文档提示词和结构化响应契约。
- Modify: `test/narrative-focus.test.js` — 动态步数下的焦点回归。
- Modify: `test/ai-story-prompt.test.js` — 新提示词和响应契约回归。
- Create: `test/dungeon-flow.test.js` — 纯函数和状态机边界测试。
- Create: `test/dungeon-flow-integration.test.js` — #69175 类悬念未闭合场景与最大步数集成测试。

### Task 1: Add Pure Decision and Settlement Guards

**Files:**
- Modify: `game-engine.js` — 增加决策常量、`normalizeAiDecision(raw, fallback)`、`canEnterClosing(state, decision)`、`resolveNextPhase(state, decision)`、`applyAiDecision(state, decision)`。
- Create: `test/dungeon-flow.test.js` — 覆盖字段规范化、阶段转换、最小/最大步数和归途门禁。

**Interfaces:**
- `normalizeAiDecision(raw, fallback) -> { phase, event, questStatus, encounterStatus, nextHint, continue }`
- `canEnterClosing(state, decision) -> boolean`
- `resolveNextPhase(state, decision) -> string`
- `applyAiDecision(state, decision) -> normalizedDecision`

- [ ] **Step 1: Write failing tests for the pure decision contract**

  Add tests that assert:

  ```js
  const d = GE.normalizeAiDecision({ phase: 'invalid' }, { phase: 'explore' });
  assert.equal(d.phase, 'explore');
  assert.equal(d.questStatus, 'active');
  assert.equal(d.encounterStatus, 'active');
  
  assert.equal(GE.canEnterClosing({
    totalStep: 8,
    minSteps: 10,
    quest: { status: 'active' },
    encounter: { status: 'resolved' },
  }, { phase: 'closing' }), false);
  
  assert.equal(GE.canEnterClosing({
    totalStep: 10,
    minSteps: 10,
    quest: { status: 'completed' },
    encounter: { status: 'resolved' },
  }, { phase: 'closing' }), true);
  
  assert.equal(GE.resolveNextPhase({
    totalStep: 12,
    maxSteps: 40,
    quest: { status: 'active' },
    encounter: { status: 'active' },
    phase: 'boss',
  }, { phase: 'closing' }), 'boss');
  ```

- [ ] **Step 2: Run the focused test to verify it fails for missing functions**

  Run: `node --test test/dungeon-flow.test.js`

  Expected: FAIL because the new decision helpers are not yet exported.

- [ ] **Step 3: Implement the minimal pure helpers**

  In `game-engine.js`:

  - Define allowed phases: `opening`, `explore`, `encounter`, `battle`, `boss`, `loot`, `rest`, `retreat`, `closing`.
  - Define allowed events: `advance`, `resolve`, `fail`, `retreat`.
  - Normalize invalid/missing values to the supplied fallback and safe statuses.
  - Reject `closing` when `totalStep < minSteps`, `quest.status === 'active'`, or `encounter.status === 'active'`.
  - Force a terminal decision at `totalStep >= maxSteps`; unresolved objectives become failed/retreated rather than successful.
  - Keep `nextHint` bounded to a short string and never use it as authoritative state.
  - Export all four helpers.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test test/dungeon-flow.test.js`

  Expected: all pure decision and settlement guard tests pass.

- [ ] **Step 5: Run syntax checks**

  Run: `node --check game-engine.js`

  Expected: exit code `0`.

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

### Task 3: Preserve Legacy Snapshot Recovery and WebSocket Semantics

**Files:**
- Modify: `server.js` — running snapshot serialization, resume handling, step/settled messages.
- Modify: `test/dungeon-flow-integration.test.js` — legacy snapshot and client-facing payload assertions.

**Interfaces:**
- `runningSnapshot(room)` includes `phase`, `quest`, `encounter`, `minSteps`, `maxSteps`, `lastDecision`, and `nextHint`.
- WebSocket `step` message includes normalized `phase`, `questStatus`, `encounterStatus`, and `continue`.
- Old snapshots with `plan` continue through the old path; new snapshots use dynamic state.

- [ ] **Step 1: Write failing compatibility tests**

  Cover:

  - Old snapshot with `plan`, `planIdx`, and `stepIdx` is not forced through dynamic fields.
  - New snapshot resumes with its current phase and quest/encounter status.
  - Clients receive normalized state fields without deciding settlement locally.

- [ ] **Step 2: Run tests to verify the compatibility assertions fail**

  Run: `node --test test/dungeon-flow-integration.test.js`

- [ ] **Step 3: Implement snapshot versioning/feature detection**

  - Add a boolean or version marker such as `flowMode: 'dynamic' | 'legacy'` to new snapshots.
  - When restoring a snapshot without `flowMode`, infer `legacy` if `plan` and `planIdx/stepIdx` exist.
  - Serialize dynamic state without deleting legacy fields needed by existing clients.
  - Ensure settlement and error paths clear room bindings exactly as before.

- [ ] **Step 4: Run focused integration tests**

  Run: `node --test test/dungeon-flow-integration.test.js`

  Expected: legacy and dynamic snapshot tests pass.

### Task 4: Synchronize Single-Player Flow and Focus Scheduling

**Files:**
- Modify: `index.html` — dynamic local stepping, response parsing, safety guards, local fallback behavior, running snapshot persistence.
- Modify: `test/narrative-focus.test.js` — focus behavior when steps are appended dynamically.
- Modify: `test/dungeon-flow.test.js` — local/online semantic parity assertions.

**Interfaces:**
- Single-player state mirrors server fields: `flowMode`, `minSteps`, `maxSteps`, `phase`, `quest`, `encounter`, `lastDecision`, `nextHint`.
- Local response normalization uses the same field names and status meanings as `game-engine.js`.

- [ ] **Step 1: Write failing parity and dynamic-focus tests**

  Assert that:

  - Local runs can stay in `boss` for an arbitrary number of generated steps until resolution.
  - A closing request before step 10 is rejected locally.
  - Focus windows remain 2~3 steps as steps are appended, and a late-added step gets a valid focus entry.
  - Local fallback text without control fields never bypasses min/max guards.

- [ ] **Step 2: Run tests to verify failure**

  Run: `node --test test/narrative-focus.test.js test/dungeon-flow.test.js`

- [ ] **Step 3: Implement the browser-side state machine**

  - Mirror the pure guard logic in the existing inline script using the same allowed values.
  - Replace `planIdx/stepIdx` termination for new local runs with dynamic phase state.
  - Keep legacy `plan` handling for old `activeDungeons` saved in localStorage.
  - Persist the new state after every step via the existing `saveRuns()` path.
  - Keep local fallback generation limited to正文; missing decision fields use safe continuation.
  - Broadcast/render the current phase and statuses without making the browser authoritative for settlement.

- [ ] **Step 4: Run browser syntax and focused tests**

  Run:

  ```powershell
  node --test test/narrative-focus.test.js test/dungeon-flow.test.js
  node -e "const fs=require('fs'),vm=require('vm'); const html=fs.readFileSync('index.html','utf8'); const start=html.indexOf('<script>')+8; const end=html.indexOf('</script>',start); new vm.Script(html.slice(start,end),{filename:'index.html'}); console.log('index inline script syntax ok');"
  ```

  Expected: focused tests pass and the inline script parses.

### Task 5: Update Prompts, Response Contract, and Regression Coverage

**Files:**
- Modify: `server.js` — `SYSTEM_PROMPT`, `buildUserMessage()`, and AI response instructions.
- Modify: `xiuxian/ai_log_prompt.md` — documented response schema and dynamic-flow rules.
- Modify: `test/ai-story-prompt.test.js` — prompt contract assertions.
- Modify: `test/dungeon-flow-integration.test.js` — #69175 regression sequence.

**Interfaces:**
- Prompt input includes current state fields and explicit next-step constraints.
- Prompt output contract is a JSON object with `text`, `phase`, `event`, `questStatus`, `encounterStatus`, `nextHint`, `continue`.

- [ ] **Step 1: Write failing prompt and regression tests**

  Add assertions that:

  - Prompt no longer describes preallocated phase counts or mandatory phase order.
  - Prompt requires continuing unresolved boss/quest conflicts.
  - Prompt forbids new unresolved mainlines in the final two steps.
  - Prompt includes the structured response fields.
  - A simulated `#69175` sequence cannot transition from unresolved boss exposition directly to `loot` or `closing`.

- [ ] **Step 2: Run tests to verify failure**

  Run: `node --test test/ai-story-prompt.test.js test/dungeon-flow-integration.test.js`

- [ ] **Step 3: Update the server prompt and documentation**

  - Replace fixed-stage wording with “AI chooses next direction from current state”.
  - Explain that `phase` is a suggestion and the engine may reject illegal transitions.
  - Instruct the AI to mark `encounterStatus=resolved` only when the text actually resolves the encounter.
  - Require `questStatus` and `continue` to describe the current step, not future events.
  - Retain explicit cast controls and no decorative cameos.

- [ ] **Step 4: Run prompt and regression tests**

  Run: `node --test test/ai-story-prompt.test.js test/dungeon-flow-integration.test.js`

  Expected: all new prompt and #69175 regression assertions pass.

### Task 6: End-to-End Verification and Service Restart

**Files:**
- Modify: none unless verification exposes a defect.
- Test: all focused tests, then the existing full suite.

- [ ] **Step 1: Run the complete focused suite**

  Run:

  ```powershell
  node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js test/ai-story-prompt.test.js test/narrative-focus.test.js
  node --check server.js
  node --check game-engine.js
  node -e "const fs=require('fs'),vm=require('vm'); const html=fs.readFileSync('index.html','utf8'); const start=html.indexOf('<script>')+8; const end=html.indexOf('</script>',start); new vm.Script(html.slice(start,end),{filename:'index.html'}); console.log('index inline script syntax ok');"
  ```

  Expected: focused tests pass and all syntax checks exit `0`.

- [ ] **Step 2: Run the existing full suite and record baseline failures**

  Run: `npm test`

  Expected: report actual pass/fail counts. Do not claim the full suite is green if the known SQLite/WebSocket/admin failures remain.

- [ ] **Step 3: Restart the game service**

  - Stop the process listening on port `8787`.
  - Start `node server.js` in the background from `I:\DEEPSEEK\tavern_clone`.
  - Query `http://127.0.0.1:8787/api/health`.

  Expected health response contains `"ok":true` and the configured model name.

- [ ] **Step 4: Perform a final requirement audit**

  Check each item in the design spec:

  - no preallocated stage counts for new runs;
  - unresolved boss/quest blocks loot/closing;
  - min/max step guards work;
  - legacy snapshots recover;
  - online/local semantics match;
  - prompt and docs describe the new contract;
  - no automatic violation detection/retry was added for decorative cameos.

## Verification Notes

- The first implementation pass must preserve old `plan` snapshots rather than silently migrating them.
- Any change to `callAIStory()` response parsing must retain the existing empty-response, replacement-character, timeout, and network error handling.
- A successful end-to-end claim requires fresh command output from Task 6; prior test runs are not sufficient.
