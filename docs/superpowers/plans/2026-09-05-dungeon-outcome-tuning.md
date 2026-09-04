# DNF Dungeon Outcome And Injury Tuning Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dungeon event outcomes authoritative rolls driven by level, attributes, equipped skills, and equipment, while reducing repetitive forced injury.

**Architecture:** Add one authoritative action-check resolver and one damage-control layer to the existing DNF game engine. The server rolls the outcome before requesting AI narrative, passes the fixed result to the AI, and refuses AI attempts to change it. Forced damage floors are reduced, removed from `mid`, and limited once per encounter/stage.

**Tech Stack:** Node.js, `node:test`, existing `game-engine.js`, `server.js`, `loot-settlement.js` utilities.

**Spec:** This plan implements the agreed design: remove standalone level-crush damage reduction; let level affect success checks; let equipment and equipped skills add check modifiers; lower injury frequency.

## Global Constraints

- Modify the DNF root implementation only: `game-engine.js` and `server.js`.
- Do not modify `xiuxian/` in this task; it is a separate game implementation.
- Do not commit; leave changes in the working tree for review.
- Do not change public HTTP APIs or database schemas.
- Preserve existing AI item-ownership validation and healing rules.
- The AI may narrate the action, but must not decide the success tier for checked stages.
- No new npm dependencies.

## File Structure

- Modify `game-engine.js`
  - Add action-check helpers and export them.
  - Replace broad per-step damage floors with lower, per-encounter/stage floors.
  - Clamp AI damage by outcome.
- Modify `server.js`
  - Pre-roll action checks in `dungeonStep`.
  - Pass real check data into `aiStoryPayload`.
  - Force the AI outcome to the server roll.
  - Record real roll metadata in `stepRec`.
- Create `test/action-check.test.js`
  - Unit-test modifier caps, fixed outcome mapping, damage clamping, and injury-frequency guard.

## Rules Summary

### Action Check

For checked stages (`battle`, `boss`, `encounter`, `explore`, `loot`, `breakthrough`):

```text
total = d20
      + attribute modifier
      + level modifier
      + equipment modifier
      + equipped-skill modifier
```

- Attribute modifier: use the best attribute for the stage; `floor((value - 10) / 2)`, clamped to `-2..+5`.
  - `explore` / `loot`: intelligence or luck.
  - `battle` / `boss`: strength or agility.
  - `encounter`: strength or agility.
  - `breakthrough`: intelligence or luck.
- Level modifier: `clamp(actor.level - opponentLevel, -5, +6)`.
  - Opponent level is the current enemy/boss level, otherwise the dungeon `levelMax`.
- Equipment modifier: only `actor.equipment`, capped at `+6`.
  - Rarity ranks: `common=0`, `advanced=1`, `rare=2`, `artifact=3`, `epic=4`, `legendary=5`, `mythic=6`.
  - Stage-fit weights: main fit adds rarity rank plus 1; partial fit adds half of that, rounded down.
  - Example: battle weapon ranks add fully; battle armor/accessories add at half weight.
- Equipped-skill modifier: only `actor.skills`, never `actor.skillPool`; `+1` per equipped skill, capped at `+3`.

### Outcome Thresholds

```text
total >= 28 => crit
total >= 20 => good
total >= 11 => mid
total >= 4  => bad
total <= 3  => fumble
```

The server passes the complete breakdown and fixed outcome to the AI. The AI narrative must match the outcome.

### Injury Rules

- `crit` / `good`: authoritative damage is `0`.
- `mid`: AI damage is allowed only up to `4%` of max HP; no forced floor.
- `bad`: forced floor is `4%` of max HP; AI damage is capped at `12%`.
- `fumble`: forced floor is `8%` of max HP; AI damage is capped at `20%`.
- Boss stages multiply bad/fumble caps and floors by `1.25`, but do not exceed `25%` of max HP.
- Hidden dungeon or special event adds `+1 percentage point` to bad/fumble floors only.
- There is no separate level-crush damage reduction.
- One floor may trigger per current battle/boss enemy and at most once per non-combat stage type for the run.
- Existing lethal protection remains: floors cannot kill; they leave at least 1 HP.

---

### Task 1: Authoritative Action Check Helpers

**Files:**

- Modify: `game-engine.js`
- Test: `test/action-check.test.js`

**Interfaces:**

Produces:

```js
GE.resolveActionCheck(dg, stageKey, actor)
GE.attributeModifier(actor, stageKey)
GE.equipmentModifier(actor, stageKey)
GE.skillModifier(actor)
```

`resolveActionCheck` returns `null` for non-checked stages, otherwise:

```js
{
  roll: Number,
  attrKey: String,
  attrMod: Number,
  levelMod: Number,
  equipmentMod: Number,
  skillMod: Number,
  mod: Number,
  total: Number,
  outcome: 'crit' | 'good' | 'mid' | 'bad' | 'fumble',
}
```

- [ ] **Step 1: Write failing tests**

Create `test/action-check.test.js` with these tests:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GE = require('../game-engine');

test('equipment and skill modifiers are capped', () => {
  const actor = {
    skills: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
    equipment: [
      { name: '神剑', kind: 'weapon', rarity: 'mythic' },
      { name: '神器甲', kind: 'armor', rarity: 'artifact' },
      { name: '稀有戒', kind: 'accessory', rarity: 'rare' },
    ],
  };
  assert.equal(GE.skillModifier(actor), 3);
  assert.equal(GE.equipmentModifier(actor, 'battle'), 6);
});

test('skill pool is not counted', () => {
  const actor = { skills: [], skillPool: [{ name: '未装备' }] };
  assert.equal(GE.skillModifier(actor), 0);
});

test('action check maps deterministic rolls to outcome tiers', () => {
  const dg = {
    dungeon: { levelMax: 3, isHidden: false, specialEvent: false },
    _curEnemy: { level: 3 },
  };
  const actor = { level: 1, strength: 2, agility: 2, intelligence: 2, luck: 2, equipment: [], skills: [] };
  const original = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(GE.resolveActionCheck(dg, 'battle', actor).outcome, 'fumble');
    Math.random = () => 0.999999;
    assert.equal(GE.resolveActionCheck(dg, 'battle', actor).outcome, 'crit');
  } finally {
    Math.random = original;
  }
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test test/action-check.test.js`

Expected: FAIL because the exported helpers do not exist.

- [ ] **Step 3: Implement helpers in `game-engine.js`**

Add after `realmDiffMod`:

```js
const ACTION_CHECK_STAGES = new Set(['battle', 'boss', 'encounter', 'explore', 'loot', 'breakthrough']);
const RARITY_RANK = { common: 0, advanced: 1, rare: 2, artifact: 3, epic: 4, legendary: 5, mythic: 6 };
const EQUIPMENT_STAGE_WEIGHT = {
  battle: { weapon: 1, armor: 0.5, accessory: 0.5, tool: 0 },
  boss: { weapon: 1, armor: 1, accessory: 0.5, tool: 0 },
  encounter: { weapon: 1, armor: 0.5, accessory: 0.5, tool: 0 },
  explore: { tool: 1, armor: 0.5, accessory: 0.5, weapon: 0 },
  loot: { tool: 1, accessory: 1, armor: 0.5, weapon: 0 },
  breakthrough: { accessory: 1, armor: 1, tool: 0.5, weapon: 0 },
};

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function attributeModifier(actor, stageKey) {
  const keys = STAGE_ATTR[stageKey] || ['luck'];
  const values = keys.map(key => Number(actor && actor[key]) || 10);
  const best = Math.max(...values);
  return clampNumber(Math.floor((best - 10) / 2), -2, 5);
}

function equipmentModifier(actor, stageKey) {
  const weights = EQUIPMENT_STAGE_WEIGHT[stageKey] || {};
  const total = (actor && Array.isArray(actor.equipment) ? actor.equipment : []).reduce((sum, item) => {
    if (!item) return sum;
    const weight = Number(weights[item.kind] || 0);
    if (!weight) return sum;
    const rank = RARITY_RANK[LootSettlement.normalizeRarity(item.rarity)] || 0;
    return sum + Math.floor((rank + 1) * weight);
  }, 0);
  return Math.min(6, total);
}

function skillModifier(actor) {
  return Math.min(3, Array.isArray(actor && actor.skills) ? actor.skills.length : 0);
}

function outcomeForTotal(total) {
  if (total >= 28) return 'crit';
  if (total >= 20) return 'good';
  if (total >= 11) return 'mid';
  if (total >= 4) return 'bad';
  return 'fumble';
}

function resolveActionCheck(dg, stageKey, actor) {
  if (!ACTION_CHECK_STAGES.has(stageKey)) return null;
  const keys = STAGE_ATTR[stageKey] || ['luck'];
  const values = keys.map(key => ({ key, value: Number(actor && actor[key]) || 10 }));
  values.sort((a, b) => b.value - a.value);
  const attrKey = values[0].key;
  const attrMod = attributeModifier(actor, stageKey);
  const actorLevel = Math.max(1, Number(actor && actor.level) || 1);
  const opponentLevel = Math.max(1, Number(dg && dg._curEnemy && dg._curEnemy.level)
    || Number(dg && dg.dungeon && dg.dungeon.levelMax) || actorLevel);
  const levelMod = clampNumber(actorLevel - opponentLevel, -5, 6);
  const equipmentMod = equipmentModifier(actor, stageKey);
  const skillMod = skillModifier(actor);
  const roll = rollD20();
  const mod = attrMod + levelMod + equipmentMod + skillMod;
  const total = roll + mod;
  return { roll, attrKey, attrMod, levelMod, equipmentMod, skillMod, mod, total, outcome: outcomeForTotal(total) };
}
```

Export `attributeModifier`, `equipmentModifier`, `skillModifier`, and `resolveActionCheck` in `module.exports`.

- [ ] **Step 4: Run the test again**

Run: `node --test test/action-check.test.js`

Expected: PASS.

### Task 2: Lower And Gate Forced Injury

**Files:**

- Modify: `game-engine.js`
- Test: `test/action-check.test.js`

**Interfaces:**

- Consumes: `resolveActionCheck`, existing `applyStageEffects`.
- Produces: authoritative damage floors once per enemy/stage and outcome caps inside `applyStageEffects`.

- [ ] **Step 1: Add failing tests**

Append to `test/action-check.test.js`:

```js
test('mid has no forced floor and negative floors are gated per enemy', () => {
  const dg = {
    damage: 0,
    deaths: [],
    memberGains: {},
    bossDrops: [],
    dungeon: { isHidden: false, specialEvent: false },
    _curEnemy: { name: '哥布林', level: 3 },
  };
  const actor = { id: 'a', name: '甲', hp: 100, max_hp: 100 };
  assert.equal(GE.resolveDamageFloor(dg, 'battle', actor, 'mid'), 0);
  assert.equal(GE.resolveDamageFloor(dg, 'battle', actor, 'bad'), 4);
  assert.equal(GE.resolveDamageFloor(dg, 'battle', actor, 'bad'), 0);
});

test('applyStageEffects caps AI damage by outcome', () => {
  const dg = { damage: 0, deaths: [], memberGains: {}, bossDrops: [], dungeon: { isHidden: false, specialEvent: false }, _curEnemy: { name: '哥布林', level: 3 } };
  const actor = { id: 'a', name: '甲', hp: 100, max_hp: 100 };
  GE.applyStageEffects(dg, 'battle', actor, 0, 'good', 80, 0, false, actor);
  assert.equal(actor.hp, 100);
  GE.applyStageEffects(dg, 'battle', actor, 0, 'bad', 80, 0, false, actor);
  assert.equal(actor.hp, 88);
});
```

- [ ] **Step 2: Run tests and confirm new assertions fail**

Run: `node --test test/action-check.test.js`

Expected: FAIL for current `mid` floor and uncapped AI damage.

- [ ] **Step 3: Replace damage constants and floor resolver**

Replace `DAMAGE_FLOOR_PCT` with:

```js
const DAMAGE_FLOOR_PCT = {
  battle: { bad: 0.04, fumble: 0.08 },
  boss: { bad: 0.05, fumble: 0.10 },
  encounter: { bad: 0.04, fumble: 0.08 },
  explore: { bad: 0.03, fumble: 0.05 },
  loot: { bad: 0.02, fumble: 0.04 },
  retreat: { bad: 0.04, fumble: 0.08 },
  breakthrough: { bad: 0.04, fumble: 0.06 },
};
```

Replace `resolveDamageFloor` with:

```js
function damageFloorGuardKey(dg, stageKey) {
  if (stageKey === 'battle' || stageKey === 'boss') {
    return `${stageKey}:${String(dg && dg._curEnemy && dg._curEnemy.name) || 'unknown'}`;
  }
  return `${stageKey}:run`;
}

function resolveDamageFloor(dg, stageKey, actor, outcome) {
  if (!dg || !actor || actor.isDead) return 0;
  dg._damageFloorGuard = dg._damageFloorGuard || new Set();
  const key = damageFloorGuardKey(dg, stageKey);
  if (dg._damageFloorGuard.has(key)) return 0;
  const base = (DAMAGE_FLOOR_PCT[stageKey] || {})[outcome] || 0;
  if (!base) return 0;
  const mapDanger = dg.dungeon && (dg.dungeon.isHidden || dg.dungeon.specialEvent) ? 0.01 : 0;
  const maxHp = Math.max(1, Number(actor.max_hp) || 100);
  const floor = Math.round(maxHp * Math.min(0.25, base + mapDanger));
  if (floor <= 0) return 0;
  dg._damageFloorGuard.add(key);
  const currentHp = Number.isFinite(Number(actor.hp)) ? Math.max(0, Number(actor.hp)) : maxHp;
  return Math.max(0, Math.min(floor, Math.max(0, currentHp - 1)));
}
```

- [ ] **Step 4: Clamp damage in `applyStageEffects`**

Add:

```js
const DAMAGE_CAP_PCT = { crit: 0, good: 0, mid: 0.04, bad: 0.12, fumble: 0.20 };
const BOSS_DAMAGE_CAP_PCT = { crit: 0, good: 0, mid: 0.05, bad: 0.15, fumble: 0.25 };
```

Inside `applyStageEffects`, replace the current `dmg` calculation with:

```js
const caps = stageKey === 'boss' ? BOSS_DAMAGE_CAP_PCT : DAMAGE_CAP_PCT;
const maxHp = Math.max(1, Number(actor.max_hp) || 100);
const cap = Math.round(maxHp * (caps[outcome] || 0));
const floor = resolveDamageFloor(dg, stageKey, actor, outcome);
const dmg = Math.max(Math.min(aiDmg, cap), floor);
```

Keep the existing HP update, death handling, healing, boss-drop, and breakthrough logic unchanged.

- [ ] **Step 5: Run tests again**

Run: `node --test test/action-check.test.js`

Expected: PASS.

### Task 3: Server Pre-Roll And AI Enforcement

**Files:**

- Modify: `game-engine.js`
- Modify: `server.js`

**Interfaces:**

- Consumes: `resolveActionCheck`.
- Produces: `aiStoryPayload` includes a non-null `actionCheck`; `server.js` overrides AI outcome and records roll metadata.

- [ ] **Step 1: Make `aiStoryPayload` carry the real check**

In `aiStoryPayload`, replace:

```js
roll: null, mod: null, total: null, actor: actor.name,
...
attr: '',
```

with:

```js
roll: roll == null ? null : Number(roll),
mod: mod == null ? null : Number(mod),
total: total == null ? null : Number(total),
actor: actor.name,
...
attr: attrKey || '',
```

Add after `needsCheck`:

```js
actionCheck: roll == null || mod == null || total == null ? null : {
  roll: Number(roll), mod: Number(mod), total: Number(total),
},
```

The numeric parameters remain backward-compatible because absent checks still send `null`.

- [ ] **Step 2: Add a fixed-outcome prompt line**

In `server.js`, inside the dynamic prompt block, immediately before the JSON schema line, add:

```js
if (b.actionCheck) {
  lines.push(`【服务端判定】骰子 ${b.actionCheck.roll} + 修正 ${b.actionCheck.mod} = ${b.actionCheck.total}；本步 outcome 必须固定为服务端给出的等级，只能用剧情解释它，不得改写成败。`);
}
```

Update the following outcome explanation to say the AI `outcome` must equal `b.actionCheck.outcome` when present.

Note: `aiStoryPayload` must include `outcome` in `actionCheck` as well:

```js
actionCheck: roll == null || mod == null || total == null ? null : {
  roll: Number(roll), mod: Number(mod), total: Number(total), outcome,
},
```

Because `aiStoryPayload` does not currently receive `outcome`, extend its signature to:

```js
function aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse, outcome)
```

and pass `actionCheck && actionCheck.outcome` from `server.js`.

- [ ] **Step 3: Roll before AI request**

In `dungeonStep`, after `dg._curEnemy` is selected and before the `try` block, add:

```js
const actionCheck = needsCheck ? GE.resolveActionCheck(dg, stageKey, actor) : null;
```

Change the payload call to:

```js
payload = GE.aiStoryPayload(
  dg, stageKey, actor, support, support2,
  actionCheck && actionCheck.attrKey,
  actionCheck && actionCheck.roll,
  actionCheck && actionCheck.mod,
  actionCheck && actionCheck.total,
  null, null,
  actionCheck && actionCheck.outcome,
);
```

- [ ] **Step 4: Force AI result to the roll**

Change:

```js
const aiStep = GE.normalizeAiStepResult(j, { outcome: needsCheck ? 'mid' : 'good' });
outcome = aiStep.outcome;
```

to:

```js
const aiStep = GE.normalizeAiStepResult(j, { outcome: actionCheck ? actionCheck.outcome : (needsCheck ? 'mid' : 'good') });
if (actionCheck) aiStep.outcome = actionCheck.outcome;
outcome = aiStep.outcome;
```

The existing item/skill ownership checks continue to run.

- [ ] **Step 5: Make AI skill success follow the roll**

Change `resolveAiSkillUse` so its returned `success` is:

```js
success: actionCheck ? actionCheck.total >= 11 : entry.success === true
```

Keep the validation that the named skill must exist in `actor.skills`.

- [ ] **Step 6: Record real check metadata**

Change `stepRec` header fields from zero values to:

```js
stage: stageKey,
actor: actor.name,
attr: actionCheck ? actionCheck.attrKey : '',
roll: actionCheck ? actionCheck.roll : 0,
mod: actionCheck ? actionCheck.mod : 0,
total: actionCheck ? actionCheck.total : 0,
outcome,
```

Also change `realmB` to:

```js
realmB: actionCheck ? actionCheck.levelMod : 0,
```

This keeps the existing client display fields intact.

### Task 4: Regression And Manual Verification

**Files:**

- Verify: `test/action-check.test.js`
- Verify: existing dungeon flow tests

- [ ] **Step 1: Run focused tests**

Run: `node --test test/action-check.test.js test/dungeon-flow.test.js test/no-d20-ai-flow.test.js test/dungeon-item-settlement.test.js`

Expected: PASS. Existing tests that intentionally prove the old AI-decided flow may need updating only where they assert `roll=0`, `mod=0`, `total=0`, or AI-owned outcomes.

- [ ] **Step 2: Update only contradictory old tests**

For tests asserting that dynamic AI flow has no numeric roll, update fixtures to provide an `actionCheck` or assert that checks are absent only for `opening`, `closing`, `rest`, and `retreat`. Do not weaken item-ownership or healing assertions.

- [ ] **Step 3: Run full relevant suite**

Run: `npm test`

Expected: PASS. If unrelated pre-existing failures appear, record them without fixing unrelated behavior.

- [ ] **Step 4: Manual smoke run**

Start the game and run one low-level dungeon with a high-level character. Verify:

- Step records show nonzero roll/mod/total for checked stages.
- Most steps resolve `good` or `crit`.
- No forced injury occurs on `good` outcomes.
- At most one forced floor occurs per battle enemy.
- The AI story visibly matches the recorded outcome.
