# DNF 月光纸笺·轻复古 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 DNF 游戏前端重塑为暖白羊皮纸、月光蓝、铜金和木棕构成的轻复古月光酒馆 UI，同时保持现有功能和信息架构不变。

**Architecture:** 以 `style.css` 的主题令牌和公共容器为视觉基础，按页面壳层、公共导航、酒馆大厅、内容面板和响应式验证分阶段改造。`index.html` 只做主要导航图标和必要语义 class 调整，不引入新框架、不拆分现有业务脚本。

**Tech Stack:** 原生 HTML、CSS、JavaScript；Node.js `node:test`；现有本地静态服务 `node server.js`。

**Spec:** `docs/superpowers/specs/2026-09-03-moonlit-parchment-ui-design.md`

## Global Constraints

- 不修改服务端、数据库、AI 流程或角色数据结构。
- 不重写现有标签页、模态框、日志阅读、在线匹配等业务流程。
- 不引入新的前端框架或外部字体依赖。
- 中间游戏区保持居中纸笺背景，两侧继续显示 `pic/天空之城.jpg`。
- 复古元素只用于页头、标题条、分区边框、空状态和局部装饰；数据卡片保持平整、紧凑。
- 主要导航和操作不再依赖 Emoji 作为唯一图标；图标按钮保留 `title` 或可访问名称。
- 在 390px、768px、1024px、1440px 视口检查文字换行、按钮尺寸、横向滚动和背景裁切。
- 每个视觉改动任务必须先添加会失败的结构回归测试，再实现 CSS/HTML，最后运行针对性测试和完整测试。

## 文件地图

- Modify: `style.css` — 主题变量、页面壳层、页头、导航、内容面板和响应式规则。
- Modify: `index.html` — 主要导航和公共标题中的图标语义与必要 class；保留现有渲染逻辑。
- Modify: `test/app-shell.test.js` — 主题令牌、页面壳层、导航图标和关键复古结构的字符串级回归测试。
- Create during verification only: visual screenshots outside the repository or in an ignored temporary folder; do not add generated screenshots to git.

---

### Task 1: 建立暖白羊皮纸主题令牌与页面壳层

**Files:**
- Modify: `style.css:1-185`
- Test: `test/app-shell.test.js`

**Interfaces:**
- Consumes: existing `body`, `.app-content`, `.advs1`, `[data-theme="light"]` selectors.
- Produces: CSS variables `--paper-bg`, `--paper-raised`, `--paper-muted`, `--ink`, `--ink-muted`, `--moon-blue`, `--moon-blue-dark`, `--copper`, `--wood`, `--danger`, `--success`; `.app-content` remains the centered game canvas.

- [ ] **Step 1: Write the failing tests**

Add tests in `test/app-shell.test.js` that extract the `:root`, light-theme, `body`, and `.app-content` blocks and assert:

```js
test('moonlit parchment theme exposes shared paper, ink, moon, copper, and wood tokens', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const rootTheme = styles.slice(styles.indexOf(':root {'), styles.indexOf('/* ============ 白色仙侠风主题'));
  assert.match(rootTheme, /--paper-bg:\s*#f7f1e5/);
  assert.match(rootTheme, /--paper-raised:\s*#fffaf0/);
  assert.match(rootTheme, /--ink:\s*#2c3440/);
  assert.match(rootTheme, /--moon-blue:\s*#6f879c/);
  assert.match(rootTheme, /--copper:\s*#b98545/);
  assert.match(rootTheme, /--wood:\s*#805a3b/);
});

test('game canvas uses the parchment surface while body keeps the sky background', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const body = styles.slice(styles.indexOf('body {'), styles.indexOf('::-webkit-scrollbar'));
  const appContent = styles.slice(styles.indexOf('.app-content {'), styles.indexOf('/* ============ 深渊酒馆页头'));
  assert.match(body, /url\("pic\/天空之城\.jpg"\)/);
  assert.match(appContent, /background:\s*var\(--paper-bg\)/);
  assert.match(appContent, /margin:\s*0\s+auto/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/app-shell.test.js`

Expected: the two new subtests fail because the paper token names and `background: var(--paper-bg)` are not present yet; existing tests remain unchanged.

- [ ] **Step 3: Implement the minimal theme and shell changes**

In `style.css`:

1. Add the paper/ink/moon/copper/wood variables to `:root`.
2. Map the existing light theme semantic variables to the new tokens instead of scattering new hex values through components.
3. Keep the existing body background image declaration and adjust its overlay to a subtle cool-night tint.
4. Change `.app-content` from hard-coded white to `background: var(--paper-bg)` while preserving `width: min(100%, 1200px)`, `margin: 0 auto`, `min-height: 100vh`, and the existing shadow.
5. Reduce global radius variables to the light-revamp values from the spec without changing fixed modal behavior.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/app-shell.test.js`

Expected: all app-shell tests pass, including the two new theme/shell tests.

- [ ] **Step 5: Commit the task**

```bash
git add style.css test/app-shell.test.js
git commit -m "feat: add moonlit parchment theme tokens"
```

### Task 2: 改造月光酒馆页头、公告和标签导航

**Files:**
- Modify: `index.html:117-161`
- Modify: `style.css:187-375`
- Test: `test/app-shell.test.js`

**Interfaces:**
- Consumes: existing `T.title_kicker`, `T.title`, `T.title_badge`, `T.subtitle`, `T.beta_notice`, `T.notice`, tab button `data-tab` attributes, and `FEATURED_BUILDING_CODES` count.
- Produces: stable classes `.moonlit-sigil`, `.moonlit-icon`, and `.tabs`/`.tab-btn` styling that preserves tab click behavior and count badges.

- [ ] **Step 1: Write the failing tests**

Add tests that assert the public navigation markup contains semantic icon hooks and no Emoji-only tab labels:

```js
test('primary navigation exposes moonlit icon hooks without emoji-only labels', () => {
  const html = readAsset('index.html');
  assert.match(html, /class="moonlit-sigil"/);
  assert.match(html, /class="moonlit-icon"/);
  assert.match(html, /data-tab="tavern"[\s\S]*class="moonlit-icon"/);
  assert.match(html, /data-tab="logs"[\s\S]*class="moonlit-icon"/);
  assert.doesNotMatch(html, /<button class="tab-btn active"[^>]*>🍺/);
});

test('moonlit header and tabs use paper, copper, and wood visual hooks', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.advs1-header[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.tabs[\s\S]*var\(--paper-muted\)/);
  assert.match(styles, /\.tab-btn\.active[\s\S]*var\(--copper\)/);
  assert.match(styles, /\.moonlit-icon/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/app-shell.test.js`

Expected: the new navigation tests fail because the new classes and selectors do not exist.

- [ ] **Step 3: Implement the header and navigation changes**

In `index.html`:

1. Replace the header sigil content with a `.moonlit-sigil` wrapper that has a text alternative/title and a compact moon/cup/sword mark.
2. Add `.moonlit-icon` spans to the seven primary tabs while preserving each existing `data-tab`, label text, and building count badge.
3. Keep Emoji in dynamic story, character, dungeon, and log content; only primary navigation and key static operation labels are in scope here.

In `style.css`:

1. Restyle `.advs1-header` as a flat paper sign with a thin copper edge, subtle moonlit blue inset, and no high-tech radial beacon treatment.
2. Restyle `.advs1-beacon` as a static or low-frequency moon-window ornament; add a reduced-motion fallback.
3. Restyle `.advs1-beta-notice` and `.notice-banner` as readable paper notices with copper/blue accent rules.
4. Restyle `.tabs` as a flat wood/paper menu and `.tab-btn.active` with a copper underline and paper highlight.
5. Add `.moonlit-icon` dimensions, color, and alignment without changing button hit areas.

- [ ] **Step 4: Run the focused tests and manually inspect tab behavior**

Run: `node --test test/app-shell.test.js`

Then open `http://localhost:8788` and click all seven tabs. Expected: each tab still activates the same `#tab-*` section, the building count remains visible, and no tab label is clipped at 390px width.

- [ ] **Step 5: Commit the task**

```bash
git add index.html style.css test/app-shell.test.js
git commit -m "feat: style moonlit tavern header and navigation"
```

### Task 3: 统一酒馆大厅、桌台与聊天留言簿

**Files:**
- Modify: `style.css` sections for `.tavern-layout`, `.hall-tables`, `.bar-stools`, `.table-seats`, `.chat-col`, and related tavern cards.
- Modify: `index.html` only where existing tavern section headings need a stable semantic class.
- Test: `test/app-shell.test.js`

**Interfaces:**
- Consumes: existing tavern DOM classes and data rendering functions; no JavaScript API changes.
- Produces: shared visual language for `.tavern-layout`, table sections, occupied/vacant seats, and `.chat-col`.

- [ ] **Step 1: Write the failing tests**

Add structural assertions:

```js
test('tavern hall exposes paper desk and guestbook visual surfaces', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.tavern-layout/);
  assert.match(styles, /\.hall-tables/);
  assert.match(styles, /\.chat-col/);
  assert.match(styles, /\.chat-col[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.seat-vacant[\s\S]*dashed/);
  assert.match(styles, /\.table-seats[\s\S]*var\(--wood\)/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/app-shell.test.js`

Expected: the new assertions fail for the new paper/wood surface requirements.

- [ ] **Step 3: Implement the tavern visual system**

1. Keep `.tavern-layout` as the existing two-column layout on desktop and its current column-to-stack breakpoint.
2. Restyle the main hall surface with `--paper-raised`, a thin `--wood` edge, and a compact section heading with a copper diamond marker.
3. Restyle bars and table sections with restrained wood borders and paper interiors; use dashed copper outlines for vacant seats.
4. Restyle occupied seat cards as compact role slips with clear name, drink, and status hierarchy.
5. Restyle `.chat-col` as a guestbook surface with paper-raised background, ink text, copper title rule, compact message slips, and a fixed-height input area.
6. Preserve all hover, click, seat selection, and chat input states. Do not add decorative nested cards that obscure the existing hierarchy.

- [ ] **Step 4: Run tests and inspect the main interaction surface**

Run: `node --test test/app-shell.test.js`

Open `http://localhost:8788`, verify the tavern tab, click an occupied and a vacant seat, and type in the chat field without sending. Expected: selection styles remain visible, text remains readable, and the two-column layout stacks cleanly below 860px.

- [ ] **Step 5: Commit the task**

```bash
git add index.html style.css test/app-shell.test.js
git commit -m "feat: style tavern desks and guestbook"
```

### Task 4: 统一活动、建筑、冒险者、小队和日志面板

**Files:**
- Modify: `style.css` sections for `.event-header`, `.event-rules`, `.stage-row`, `.rank-row`, `.build-card`, `.adv-card`, `.party-*`, `.log-card`, `.adv-log-*`, and modal reading surfaces.
- Modify: `index.html` only for stable heading/section classes where an existing selector is too broad.
- Test: `test/app-shell.test.js`

**Interfaces:**
- Consumes: existing page-specific classes and render functions.
- Produces: page panels that share paper/ink/moon/copper semantics while retaining their existing data states and click targets.

- [ ] **Step 1: Write the failing tests**

Add assertions that representative panel selectors use shared tokens and preserve status semantics:

```js
test('secondary pages reuse the moonlit parchment panel language', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /\.event-header[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.build-card[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.adv-card[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.log-card[\s\S]*var\(--paper-raised\)/);
  assert.match(styles, /\.btn-primary[\s\S]*var\(--moon-blue-dark\)/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/app-shell.test.js`

Expected: the new secondary-page token assertions fail before the page-specific styles are migrated.

- [ ] **Step 3: Implement shared panel styling page by page**

Apply the same hierarchy to each group:

1. Activity: paper event header, copper metadata, readable rules and ranking rows.
2. Building: flat diagram-card surfaces, copper status badges, paper-raised hover state.
3. Adventurers: paper role dossier cards with the existing accent/status bars preserved.
4. Party: wood-framed room cards, copper selection state, paper member slips.
5. Logs: parchment reading header, blue-gray metadata, copper active status, and readable modal body.
6. Buttons and form controls: use moon-blue-dark fills for primary actions, paper-raised backgrounds for secondary controls, and preserve disabled/focus states.

Do not alter render functions, API calls, text content, sorting, pagination, settlement, or modal open/close behavior.

- [ ] **Step 4: Run focused tests and regression checks**

Run:

```bash
node --test test/app-shell.test.js
node --test test/feed.test.js test/settlement-typography.test.js
```

Expected: all selected tests pass. Manually open Activities, Buildings, Adventurers, Party, and Logs and verify cards, tabs, filters, pagination, and modal controls still work.

- [ ] **Step 5: Commit the task**

```bash
git add index.html style.css test/app-shell.test.js
git commit -m "feat: unify moonlit parchment content panels"
```

### Task 5: 响应式、动效、可访问性与最终验收

**Files:**
- Modify: `style.css` responsive and motion sections.
- Modify: `index.html` only if accessibility labels are missing on changed icon controls.
- Test: `test/app-shell.test.js`

**Interfaces:**
- Consumes: all visual tokens and component styles from Tasks 1–4.
- Produces: responsive and reduced-motion behavior matching the approved spec.

- [ ] **Step 1: Write the failing tests**

Add tests for the explicit motion and responsive contracts:

```js
test('moonlit UI defines reduced-motion and mobile stacking rules', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /@media\s*\(max-width:\s*860px\)[\s\S]*\.tavern-layout/);
  assert.match(styles, /@media\s*\(max-width:\s*700px\)[\s\S]*\.tabs/);
  assert.match(styles, /@media\s*\(max-width:\s*520px\)[\s\S]*\.advs1/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/app-shell.test.js`

Expected: the reduced-motion assertion fails if no explicit rule has been added yet.

- [ ] **Step 3: Implement final responsive and motion rules**

1. Add a `@media (prefers-reduced-motion: reduce)` block that disables beacon breathing, tab transition transforms, and non-essential card motion while preserving visible state changes.
2. Keep the existing 860px breakpoint for tavern-to-stack behavior; ensure the chat column follows the main content on narrow screens.
3. Keep tab controls horizontally scrollable at 700px and below, with a minimum 40px hit area.
4. Ensure 520px and below uses the existing compact `.advs1` padding and modal sizing without causing horizontal overflow.
5. Verify primary icon controls have `title`, `aria-label`, or visible text after markup changes.

- [ ] **Step 4: Run all automated verification**

Run:

```bash
node --test test/app-shell.test.js
npm test
git diff --check
```

Expected: `app-shell.test.js` passes, the full suite reports 0 failures, and `git diff --check` produces no whitespace errors.

- [ ] **Step 5: Run visual verification at all required viewports**

With the existing service running at `http://localhost:8788`, inspect screenshots at 390px, 768px, 1024px, and 1440px widths. Check:

- the middle parchment canvas is centered and side background remains visible on desktop;
- the title, notices, tabs, tavern tables, guestbook, and modal reading surfaces do not overlap;
- all tab labels, badges, buttons, filters, and long Chinese text fit their containers;
- the mobile chat column stacks below the tavern content and the tab bar scrolls without page-level horizontal overflow;
- paper backgrounds remain warm white rather than yellow-brown, and body text maintains strong contrast.

- [ ] **Step 6: Commit the final verification changes**

```bash
git add style.css index.html test/app-shell.test.js
git commit -m "test: verify moonlit parchment responsive UI"
```

## Plan Self-Review

- Spec coverage: theme tokens and shell are covered by Task 1; header/notice/navigation by Task 2; tavern and guestbook by Task 3; secondary pages by Task 4; motion, accessibility, responsive behavior, and viewport verification by Task 5.
- Scope: all tasks remain within the existing frontend subsystem and do not change server or data contracts.
- TDD: every task starts with a concrete failing string-level regression test, then a focused test run, implementation, and green verification.
- Placeholder scan: every task includes concrete files, commands, code expectations, and verification outcomes.
- Type consistency: this plan introduces only CSS custom properties and class hooks; no new JavaScript API or data type is required.
