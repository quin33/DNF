# 太虚幻境 AI 参悟 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增太虚幻境建筑，让玩家选择功法或术法并输入 100 字内目标，由服务端结合角色状态调用 AI、校验阶位并原子写入功法栏或功法库。

**Architecture:** 新建 `taixu-insight.js` 封装参悟配置、角色上下文构建和 AI JSON 校验，避免把可测试规则埋入 HTTP 路由。`server.js` 提供权威角色接口并负责版本校验与保存，`online.js` 同步响应到当前角色，`index.html` 只负责交互、结果弹窗和最近动态。

**Tech Stack:** Node.js CommonJS、原生 HTTP、SQLite 数据层、原生 JavaScript/HTML/CSS、Node test runner。

**Spec:** `docs/superpowers/specs/2026-08-24-taixu-insight-design.md`

## Global Constraints

- 玩家必须主动选择「功法」或「术法」。
- 期望目标去除首尾空白后长度必须为 1 至 100 字。
- 阶位仅允许「黄阶、玄阶、地阶、天阶」，并作为能力稀有度。
- AI 必须结合境界、灵根、特质、功法栏和功法库，过强目标要降格为当前境界可掌握的版本。
- 当前灵石消耗、精力消耗和冷却均为零，但必须集中配置并经过统一校验入口。
- 生成、校验、费用处理和能力写入由服务端权威完成；失败时不得改变角色数据。
- 功法栏未满时自动装备，已满时进入功法库。
- 当前工作目录没有 `.git` 元数据，各任务的提交步骤改为运行 `git status` 确认该限制，并保留清晰的文件级检查点。

## File Structure

- Create `taixu-insight.js`: 参悟费用配置、角色上下文提示、AI JSON 解析与白名单校验。
- Create `test/taixu-insight.test.js`: 纯逻辑、服务端契约、前端入口和动态记录回归测试。
- Modify `server.js`: 权威参悟路由、AI 重试、角色版本保存和冷却字段。
- Modify `online.js`: 在线参悟请求、角色同步和 409 错误处理。
- Modify `data.js`: 太虚幻境建筑数据。
- Modify `index.html`: 建筑入口、参悟弹窗、提交/结果状态、最近动态。
- Modify `style.css`: 太虚幻境弹窗、分段选择和结果布局。

---

### Task 1: 参悟领域规则模块

**Files:**
- Create: `taixu-insight.js`
- Create: `test/taixu-insight.test.js`

**Interfaces:**
- Consumes: 角色对象 `{ name, character_class, root, traits, skills, skillPool }` 和 AI 原始文本。
- Produces: `TAIXU_INSIGHT_COST`、`buildTaixuInsightPrompt(role, type, goal)`、`parseTaixuInsight(raw, expectedType, knownNames)`、`validateTaixuInsightAccess(role, now)`。

- [ ] **Step 1: 写 AI 结果校验的失败测试**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const TI = require('../taixu-insight');

test('taixu insight accepts a valid skill and preserves the selected type', () => {
  const result = TI.parseTaixuInsight(
    '{"name":"赤霞护元诀","type":"功法","tier":"玄阶","elem":"火灵根","desc":"引赤霞护住经脉，可抵御寻常灵力冲击，但久持会加重真元负担。"}',
    '功法',
    new Set(['火球术'])
  );
  assert.deepEqual(result, {
    name: '赤霞护元诀', type: '功法', tier: '玄阶', elem: '火灵根',
    desc: '引赤霞护住经脉，可抵御寻常灵力冲击，但久持会加重真元负担。'
  });
});

test('taixu insight rejects mismatched type, invalid tier, duplicate name, and corrupted text', () => {
  assert.throws(() => TI.parseTaixuInsight('{"name":"雷诀","type":"术法","tier":"玄阶","desc":"护体"}', '功法', new Set()), /类型/);
  assert.throws(() => TI.parseTaixuInsight('{"name":"雷诀","type":"功法","tier":"仙阶","desc":"护体"}', '功法', new Set()), /阶位/);
  assert.throws(() => TI.parseTaixuInsight('{"name":"火球术","type":"术法","tier":"黄阶","desc":"聚火伤敌"}', '术法', new Set(['火球术'])), /重复/);
  assert.throws(() => TI.parseTaixuInsight('{"name":"破�诀","type":"功法","tier":"黄阶","desc":"护体"}', '功法', new Set()), /乱码/);
});
```

- [ ] **Step 2: 运行测试并确认缺少模块**

Run: `node --test test/taixu-insight.test.js`

Expected: FAIL，错误包含 `Cannot find module '../taixu-insight'`。

- [ ] **Step 3: 实现集中配置、提示构建和解析校验**

```js
const TAIXU_INSIGHT_COST = Object.freeze({ gold: 0, stamina: 0, cooldownMs: 0 });
const VALID_TYPES = new Set(['功法', '术法']);
const VALID_TIERS = new Set(['黄阶', '玄阶', '地阶', '天阶']);

function parseJsonObject(raw) {
  let text = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function parseTaixuInsight(raw, expectedType, knownNames = new Set()) {
  const parsed = parseJsonObject(raw);
  const skill = {
    name: String(parsed.name || '').trim().slice(0, 20),
    type: String(parsed.type || '').trim(),
    tier: String(parsed.tier || '').trim(),
    elem: String(parsed.elem || '无').trim().slice(0, 20),
    desc: String(parsed.desc || '').trim().slice(0, 200),
  };
  if (!skill.name || !skill.desc) throw new Error('AI 返回字段不完整');
  if ([skill.name, skill.elem, skill.desc].some(value => value.includes('�'))) throw new Error('AI 返回乱码');
  if (!VALID_TYPES.has(expectedType) || skill.type !== expectedType) throw new Error('AI 返回类型不符');
  if (!VALID_TIERS.has(skill.tier)) throw new Error('AI 返回阶位无效');
  if (knownNames.has(skill.name)) throw new Error('AI 返回重复能力');
  return skill;
}
```

`buildTaixuInsightPrompt` 必须把 `character_class`、`root`、`traits`、`skills`、`skillPool` 和目标拼入文本，并明确“面对越级目标必须降格，不得生成当前境界无法掌握的能力”。`validateTaixuInsightAccess` 返回 `{ ok, error, remainingMs }`，按 `TAIXU_INSIGHT_COST` 检查灵石、精力和 `role.taixuInsightAt`。

- [ ] **Step 4: 添加角色上下文和预留费用测试**

```js
test('taixu prompt contains authoritative role context and downgrade rules', () => {
  const prompt = TI.buildTaixuInsightPrompt({
    name: '云岚', character_class: '练气五层', root: '火灵根',
    traits: ['临危不乱'],
    skills: [{ name: '火球术', type: '术法', tier: '黄阶', desc: '聚火伤敌' }],
    skillPool: [{ name: '吐纳诀', type: '功法', tier: '黄阶', desc: '引气入体' }]
  }, '功法', '护体并疗伤');
  for (const text of ['练气五层', '火灵根', '临危不乱', '火球术', '吐纳诀', '护体并疗伤', '必须降格']) assert.match(prompt, new RegExp(text));
});

test('taixu costs are currently free while cooldown validation remains active', () => {
  assert.deepEqual(TI.TAIXU_INSIGHT_COST, { gold: 0, stamina: 0, cooldownMs: 0 });
  assert.deepEqual(TI.validateTaixuInsightAccess({ gold: 0, stamina: 0 }, Date.now()), { ok: true, error: '', remainingMs: 0 });
});
```

- [ ] **Step 5: 运行领域测试**

Run: `node --test test/taixu-insight.test.js`

Expected: PASS，4 个测试全部通过。

- [ ] **Step 6: 记录文件级检查点**

Run: `git status --short`

Expected: 当前环境输出 `fatal: not a git repository`；确认本任务仅新增 `taixu-insight.js` 与 `test/taixu-insight.test.js`。

---

### Task 2: 服务端权威参悟与原子保存

**Files:**
- Modify: `server.js`（顶部依赖区、`handleAuthAPI` 的角色路由区）
- Modify: `test/taixu-insight.test.js`

**Interfaces:**
- Consumes: Task 1 的 `TI.buildTaixuInsightPrompt`、`TI.parseTaixuInsight`、`TI.validateTaixuInsightAccess` 和 `TI.TAIXU_INSIGHT_COST`。
- Produces: `POST /api/character/:id/taixu-insight`，响应 `{ ok, skill, storage, character, updated_at, cost }`。

- [ ] **Step 1: 写服务端路由契约失败测试**

```js
const fs = require('node:fs');

test('server exposes an authoritative taixu insight route with versioned save', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const start = server.indexOf('const taixuInsightMatch');
  const end = server.indexOf('const forgeMatch', start);
  const route = server.slice(start, end);
  assert.match(route, /\/taixu-insight/);
  assert.match(route, /body\.updated_at/);
  assert.match(route, /DB\.getCharacter/);
  assert.match(route, /buildTaixuInsightPrompt/);
  assert.match(route, /for \(let attempt = 0; attempt < 3/);
  assert.match(route, /DB\.saveCharacterIfCurrent/);
  assert.match(route, /skills\.length < GE\.MAX_SKILLS/);
  assert.doesNotMatch(route, /body\.(root|traits|skills|character_class)/);
});
```

- [ ] **Step 2: 运行契约测试并确认路由缺失**

Run: `node --test test/taixu-insight.test.js`

Expected: FAIL，服务端切片为空或缺少 `/taixu-insight`。

- [ ] **Step 3: 实现路由输入与角色版本校验**

在 `server.js` 顶部引入：

```js
const TI = require('./taixu-insight');
```

在炼器路由之前匹配：

```js
const taixuInsightMatch = urlPath.match(/^\/api\/character\/(\d+)\/taixu-insight$/);
```

路由必须依次校验登录、POST、`updated_at`、角色归属与版本、`type` 白名单及 `goal.length`。从数据库角色构造已知名称：

```js
const knownNames = new Set([...(role.skills || []), ...(role.skillPool || [])].map(skill => skill && skill.name).filter(Boolean));
```

- [ ] **Step 4: 实现最多三次 AI 生成与校验**

```js
let skill = null;
let lastError = null;
for (let attempt = 0; attempt < 3 && !skill; attempt++) {
  try {
    const prompt = TI.buildTaixuInsightPrompt(role, type, goal);
    const retryNote = attempt ? `\n前次结果无效：${String(lastError.message || lastError)}。请重新生成不同名称。` : '';
    const raw = await callLLM(prompt + retryNote, TI.TAIXU_INSIGHT_SYSTEM_PROMPT, 1200);
    skill = TI.parseTaixuInsight(raw, type, knownNames);
  } catch (error) {
    lastError = error;
  }
}
if (!skill) { sendJSON(res, 502, { error: '太虚幻境未能参悟出可用能力，请稍后重试' }); return true; }
```

- [ ] **Step 5: 实现费用预留、存储位置和条件保存**

在通过 AI 校验后才复制并修改角色。按配置扣除 `gold`、`stamina`，写入 `taixuInsightAt`；功法栏少于 `GE.MAX_SKILLS` 时进入 `skills`，否则进入 `skillPool`。调用：

```js
const saved = DB.saveCharacterIfCurrent(u.id, charId, character.updated_at, role, role.name);
```

保存失败返回 409。成功响应包含 `cost: TI.TAIXU_INSIGHT_COST`，并调用 `notifyCharacterUpdated`。

- [ ] **Step 6: 添加白名单、重名和失败不落库的静态契约断言**

```js
test('taixu route validates input before AI and only mutates after a valid result', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const route = server.slice(server.indexOf('const taixuInsightMatch'), server.indexOf('const forgeMatch'));
  assert.match(route, /goal\.length > 100/);
  assert.match(route, /validateTaixuInsightAccess/);
  assert.ok(route.indexOf('if (!skill)') < route.indexOf('role.skills'));
  assert.match(route, /storage = role\.skills\.length < GE\.MAX_SKILLS \? 'equipped' : 'pool'/);
});
```

- [ ] **Step 7: 运行领域与服务端契约测试**

Run: `node --test test/taixu-insight.test.js && node --check server.js`

Expected: 全部 PASS，语法检查退出码 0。

- [ ] **Step 8: 记录文件级检查点**

Run: `git status --short`

Expected: 当前环境仍报告不是 Git 仓库；确认本任务只修改 `server.js` 和参悟测试。

---

### Task 3: 在线客户端参悟适配器

**Files:**
- Modify: `online.js`（窗口 API 导出区）
- Modify: `test/taixu-insight.test.js`

**Interfaces:**
- Consumes: Task 2 的 `/api/character/:id/taixu-insight`。
- Produces: `window.taixuInsight(type, goal): Promise<{ skill, storage }>`，并更新 `D.my_adventurer`。

- [ ] **Step 1: 写在线适配器失败测试**

```js
test('online client posts taixu requests and refreshes the authoritative role', () => {
  const online = fs.readFileSync('online.js', 'utf8');
  assert.match(online, /window\.taixuInsight\s*=\s*async function/);
  assert.match(online, /\/taixu-insight/);
  assert.match(online, /updated_at:\s*role\._char_updated_at/);
  assert.match(online, /Object\.assign\(role, result\.character/);
});
```

- [ ] **Step 2: 运行测试并确认适配器不存在**

Run: `node --test test/taixu-insight.test.js`

Expected: FAIL，缺少 `window.taixuInsight`。

- [ ] **Step 3: 实现在线适配器**

```js
window.taixuInsight = async function taixuInsight(type, goal) {
  const role = window.D && window.D.my_adventurer;
  if (!role || !role._char_db_id) throw new Error('请先创建角色');
  const result = await api('/api/character/' + role._char_db_id + '/taixu-insight', {
    method: 'POST',
    body: { type, goal, updated_at: role._char_updated_at },
  });
  Object.assign(role, result.character, {
    _char_db_id: role._char_db_id,
    _char_updated_at: result.updated_at,
    is_mine: true,
  });
  return result;
};
```

沿用 `api()` 的 409 错误消息，不在适配器内吞掉异常。同步 `D.adventurers` 中对应角色，并刷新我的、冒险者与建筑视图。

- [ ] **Step 4: 运行测试与语法检查**

Run: `node --test test/taixu-insight.test.js && node --check online.js`

Expected: 全部 PASS，语法检查退出码 0。

- [ ] **Step 5: 记录文件级检查点**

Run: `git status --short`

Expected: 当前环境报告不是 Git 仓库；确认本任务仅修改 `online.js` 和测试。

---

### Task 4: 太虚幻境建筑与参悟弹窗

**Files:**
- Modify: `data.js:61-63`
- Modify: `index.html:370-557`
- Modify: `style.css`（建筑设施样式区）
- Modify: `test/taixu-insight.test.js`

**Interfaces:**
- Consumes: Task 3 的 `window.taixuInsight(type, goal)`。
- Produces: `openTaixuRealmModal()`、`setTaixuType(type)`、`updateTaixuGoalCount()`、`submitTaixuInsight()`、`renderTaixuInsightResult(result)`。

- [ ] **Step 1: 写建筑入口和表单失败测试**

```js
test('building page exposes the taixu realm with type selection and a 100 character goal', () => {
  const data = fs.readFileSync('data.js', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(data, /code:\s*'taixu_realm'/);
  assert.match(html, /openTaixuRealmModal/);
  assert.match(html, /data-taixu-type="功法"/);
  assert.match(html, /data-taixu-type="术法"/);
  assert.match(html, /maxlength="100"/);
  assert.match(html, /id="taixu-goal-count"/);
});
```

- [ ] **Step 2: 运行测试并确认建筑缺失**

Run: `node --test test/taixu-insight.test.js`

Expected: FAIL，缺少 `taixu_realm`。

- [ ] **Step 3: 增加建筑数据和点击路由**

在 `data.js` 建筑数组加入：

```js
{ id: 14, code: 'taixu_realm', name: '太虚幻境', icon: '◎', category: '修炼', description: '观想太虚万象，依自身道途参悟新的功法与术法。', status: 'built', upgrade_level: 1 },
```

将 `renderBuilding()` 的过滤条件加入 `taixu_realm`，卡片点击调用 `openTaixuRealmModal()`，操作提示为“点击进入参悟”。更新建筑页说明文字，使四个现有设施均被准确描述。

- [ ] **Step 4: 实现弹窗结构和可访问交互**

弹窗使用两个 `<button type="button">` 组成分段控件，并维护 `let taixuType = '功法'`。目标输入使用 `<textarea id="taixu-goal" maxlength="100">`，`input` 事件更新 `0 / 100`。角色摘要必须从 `D.my_adventurer` 当前值渲染境界、灵根、特质、功法栏和功法库数量。

提交前执行：

```js
const goal = String($('#taixu-goal').value || '').trim();
if (!goal || goal.length > 100) {
  toastMsg(goal ? '期望目标不能超过 100 字' : '请输入期望目标');
  return;
}
```

- [ ] **Step 5: 实现生成中、成功和失败状态**

`submitTaixuInsight()` 在请求期间禁用按钮并显示“正在观想太虚万象…”。成功结果展示名称、功法/术法、阶位、属性、描述和“已装备至功法栏”或“已存入功法库”。错误时保留原输入，恢复按钮并显示服务端错误消息。

- [ ] **Step 6: 添加弹窗样式**

新增 `.taixu-dialog`、`.taixu-type-switch`、`.taixu-type-btn`、`.taixu-context`、`.taixu-goal-wrap`、`.taixu-result` 样式。复用现有颜色变量、按钮体系和最大宽度；移动端分段按钮仍保持两列，文本域和提交按钮为全宽，所有文字不得溢出。

- [ ] **Step 7: 运行 UI 契约测试和语法检查**

Run: `node --test test/taixu-insight.test.js && node --check online.js && node --check server.js`

Expected: 全部 PASS，两个语法检查退出码 0。

- [ ] **Step 8: 记录文件级检查点**

Run: `git status --short`

Expected: 当前环境报告不是 Git 仓库；确认本任务只修改 `data.js`、`index.html`、`style.css` 和测试。

---

### Task 5: 最近动态与端到端回归验证

**Files:**
- Modify: `index.html`（`submitTaixuInsight` 成功分支、动态渲染）
- Modify: `test/taixu-insight.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 返回的 `{ skill, storage }` 和现有 `addFeedItem`。
- Produces: 太虚幻境成功参悟动态；失败请求不产生动态。

- [ ] **Step 1: 写动态记录失败测试**

```js
test('successful taixu insight writes one sourced recent activity entry', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const submit = html.slice(html.indexOf('async function submitTaixuInsight'), html.indexOf('function ', html.indexOf('async function submitTaixuInsight') + 20));
  assert.match(submit, /addFeedItem/);
  assert.match(submit, /太虚幻境 · 参悟/);
  assert.match(submit, /result\.skill\.tier/);
  assert.ok(submit.indexOf('await window.taixuInsight') < submit.indexOf('addFeedItem'));
});
```

- [ ] **Step 2: 运行测试并确认缺少动态**

Run: `node --test test/taixu-insight.test.js`

Expected: FAIL，成功分支尚未调用 `addFeedItem`。

- [ ] **Step 3: 在成功保存后写入动态**

```js
addFeedItem('◎', result.skill.name, `太虚幻境 · 参悟${result.skill.type}`, result.storage === 'equipped' ? '功法栏' : '功法库', '', {
  kind: 'insight',
  tier: result.skill.tier,
  description: result.skill.desc,
});
```

扩展动态渲染，仅对 `kind === 'insight'` 展示阶位标签、描述和保存位置。调用必须位于 `await window.taixuInsight(...)` 成功返回之后，catch 分支不得写动态。

- [ ] **Step 4: 更新 README 建筑与能力说明**

在建筑模块说明中新增太虚幻境：玩家选择功法/术法、填写 100 字内目标、AI 结合角色状态生成黄/玄/地/天阶能力；当前免费且无冷却。

- [ ] **Step 5: 运行完整自动化测试**

Run: `npm test`

Expected: 所有测试通过；若本机已有 8787 服务或 `tavern.db` 锁导致既有集成测试失败，保留完整输出并额外运行下面的无服务测试组合，不把环境锁误报为功能失败。

Run: `node --test test/taixu-insight.test.js test/feed.test.js test/learned-skills.test.js test/progression.test.js test/app-shell.test.js`

Expected: 全部 PASS，0 fail。

- [ ] **Step 6: 运行全局约束与语法检查**

Run: `node --check server.js; node --check online.js; rg -n "taixu_realm|taixu-insight|太虚幻境" data.js index.html online.js server.js taixu-insight.js README.md`

Expected: 两个语法检查退出码 0；搜索结果覆盖建筑数据、前端入口、在线适配器、服务端路由、领域模块和文档。

- [ ] **Step 7: 浏览器手工验收**

启动未占用端口：`$env:PORT=8788; npm start`，访问 `http://localhost:8788`。登录并打开建筑页，确认太虚幻境卡片可进入；分别选择功法和术法；验证空输入被阻止、输入到 100 字仍可提交、101 字无法输入；成功结果展示阶位和保存位置；关闭后在我的页面确认最近动态；刷新页面确认新能力仍存在。

- [ ] **Step 8: 记录最终检查点**

Run: `git status --short`

Expected: 当前环境报告不是 Git 仓库；最终交付中明确列出所有改动文件与测试证据，不声称已创建提交。
