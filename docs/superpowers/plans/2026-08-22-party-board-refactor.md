# 小队招募板重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将本地小队页重排为参考站点的招募板结构，同时保留地图选择、匹配、公开队伍、加入队伍和实时副本流程。

**Architecture:** 继续使用现有 `renderParty()` 作为页面骨架，保留 `online.js` 的在线覆盖和现有全局状态；只新增参考站点对应的分段、我的小队、匹配表单、公开队伍和邀请空状态容器。CSS 采用现有主题变量，确保白色/暗色主题和移动断点继续工作。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node test runner、现有 WebSocket 在线层。

**Spec:** 已确认的参考站点小队模块布局设计（本对话）。

## Global Constraints

- 保留现有地图选择、随机地图、单人匹配、创建公开队伍、加入公开队伍、邀请码和 WebSocket 副本流程。
- 不新增前端框架或依赖。
- 公开队伍和成员文本必须继续经过 `esc()` 转义。
- 视觉层使用现有 `--color-*` 和 `--outpost-brass` 主题变量。

### Task 1: Add failing structure tests

**Files:**
- Modify: `test/feed.test.js`

- [ ] **Step 1: Write failing assertions** for the segment switch, my-party panel, forecast group, public party heading, and invite empty-state copy.
- [ ] **Step 2: Run `node --test test/feed.test.js`** and confirm the new assertions fail against the current party markup.

### Task 2: Rebuild the party page markup

**Files:**
- Modify: `index.html:1277-1361`

- [ ] **Step 1: Add the ordinary/special segment switch while preserving the existing map choice state.**
- [ ] **Step 2: Add the board heading and two live counters.**
- [ ] **Step 3: Add the “我的小队” panel with the current running/matching state and refresh action.**
- [ ] **Step 4: Move map selection and match/create controls into the reference form grouping without changing handler names.**
- [ ] **Step 5: Add the invitation-code join row and invitation empty state.**

### Task 3: Align online public-party rendering

**Files:**
- Modify: `online.js:343-385`

- [ ] **Step 1: Keep the current `/api/party/list` data and join/start handlers.**
- [ ] **Step 2: Render each room with the reference metadata order: room id, state, dungeon, recommended level, party count, created time, description, members, action.**
- [ ] **Step 3: Keep all dynamic values escaped and preserve button disabled/leader behavior.**

### Task 4: Add reference-style CSS

**Files:**
- Modify: `style.css:1419-1480`

- [ ] **Step 1: Style the segment switch and board heading.**
- [ ] **Step 2: Style the my-party panel, forecast block, matching controls, and invite row.**
- [ ] **Step 3: Style public party cards and responsive mobile stacking.**

### Task 5: Verify behavior and visual output

**Files:**
- Test: `test/feed.test.js`
- Verify: local `http://127.0.0.1:8787/#party`

- [ ] **Step 1: Run `node --test test/feed.test.js`.**
- [ ] **Step 2: Run the existing package test command and record unrelated failures separately.**
- [ ] **Step 3: Inspect the local party page at desktop and mobile widths; confirm buttons and dynamic room cards remain present.**
- [ ] **Step 4: Verify `/api/health` returns HTTP 200.**
