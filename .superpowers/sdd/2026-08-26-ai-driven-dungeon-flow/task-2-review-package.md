# Task 2 Review Package

## Report
# Task 2 Report: AI-driven dynamic dungeon flow

## Scope
Implemented dynamic state initialization for newly created online dungeons and server-side AI decision-driven stepping. Legacy `plan` metadata remains on snapshots for compatibility but is not used to terminate runs marked `flowMode: 'dynamic'`.

## RED
Added focused tests in `test/dungeon-flow.test.js` and `test/dungeon-flow-integration.test.js` covering dynamic state fields, boss resolution gating, minimum-step closing rejection, max-step failure, snapshot exposure, AI parser behavior, and decision application order. The first focused run failed on the missing `flowMode` field as expected.

## GREEN
- `createDg()` now initializes `flowMode: 'dynamic'`, `minSteps: 10`, `maxSteps: 40`, `phase: 'opening'`, quest/encounter containers, `lastDecision`, and `nextHint`; quest objective is derived from dungeon lore/name.
- `aiStoryPayload()` carries phase, quest/encounter state, bounds, decision metadata, and dynamic progress.
- `server.js` snapshots expose dynamic state; `dungeonStep()` uses dynamic phase selection, appends focus entries per generated step, parses structured AI decisions with plain-text fallback, applies normalized decisions before settlement/scheduling, enforces closing and max-step guards, and keeps legacy plan stepping unchanged for legacy snapshots.
- AI user messages now include dynamic state and request decision fields.

## Verification
- `node --test test/dungeon-flow.test.js test/dungeon-flow-integration.test.js` — 22/22 passed.
- `node --check server.js` — passed.
- `node --check game-engine.js` — passed.
- Existing regression checks: `node --test test/feed.test.js test/progression.test.js test/narrative-focus.test.js` — 83 tests total, 82 passed initially with one source-shape assertion corrected; focused replacement-character and narrative-cap checks pass after correction.

## Concerns
- Full integration execution of a live AI-backed room was not run because it requires configured external AI credentials; tests validate source contracts and pure state transitions.
- Dynamic focus windows are intentionally one generated step at a time; richer multi-step focus scheduling remains a later refinement.

No Git repository.

## game-engine dynamic changes
    exp: 0, status: 'idle',
  };
}

/* 创建房间 dg（开本）；联机与单机共用默认长度 */
function createDg(hostChar, opts = {}) {
  hostChar = hostChar || {};
  const isHidden = Math.random() < 0.1;
  const specialEvent = Math.random() < 0.1;
  const breakthrough = canBreakthrough(hostChar) && Math.random() < 0.1;
  const base = (opts.choice && DUNGEON_POOL.find(d => d.name === opts.choice)) || pickDungeon(hostChar);
  const enemies = rollEnemies(base, specialEvent);
  const bosses = (base.bosses || []).map((b, i) => ({ ...b, realm: i === 1 ? '筑基中期' : '筑基初期' }));
  const dungeon = { ...base, name: isHidden ? (base.hiddenName || base.name) : base.name, desc: isHidden ? (base.hiddenDesc || base.desc) : base.desc, isHidden, baseName: base.name, enemies, bosses, specialEvent, breakthrough };
  const objective = String(dungeon.lore || '').trim() || `探索${dungeon.name}`;
  return {
    id: 'dg' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    dungeon, party: [], flowMode: 'dynamic', minSteps: 10, maxSteps: 40,
    phase: 'opening', quest: { status: 'active', objective }, encounter: { status: 'none', name: '' },
    lastDecision: {}, nextHint: '', plan: buildPlan(isHidden, enemies.length, specialEvent, breakthrough),
    planIdx: 0, stepIdx: 0, totalStep: 0, steps: [], damage: 0, deaths: [],
    status: 'waiting', startedAt: Date.now(), timer: null, memberGains: {},
    bossDrops: [], _curEnemy: null, gains: {}, consumed: [], breachSuccess: false, localUsed: false, source: 'online',
  };
}

/* AI 请求体构造（与单机 generateStep 载荷一致） */
function aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse) {
  const focus = (dg.focusPlan || [])[dg.totalStep] || null;
  const cast = focus && focus.mode === 'group' ? (dg.party || []) : [actor, support, support2].filter(Boolean);
  const allowedCharacters = [...new Set(cast.map(member => member && member.name).filter(Boolean))];
  const forbiddenCharacters = [...new Set((dg.party || []).map(member => member && member.name).filter(Boolean))].filter(name => !allowedCharacters.includes(name));
  return {
    dungeon: dg.dungeon.name, baseDungeon: dg.dungeon.baseName || dg.dungeon.name, isHidden: !!dg.dungeon.isHidden,
    specialEvent: !!dg.dungeon.specialEvent, breakthrough: !!dg.dungeon.breakthrough,
    lore: dg.dungeon.lore || '', enemies: dg.dungeon.enemies || [], bosses: dg.dungeon.bosses || [],
    flowMode: dg.flowMode || 'legacy', phase: dg.phase || stageKey,
    quest: dg.quest || { status: 'active', objective: '' },
    encounter: dg.encounter || { status: 'none', name: '' },
    minSteps: Number(dg.minSteps == null ? 10 : dg.minSteps), maxSteps: Number(dg.maxSteps == null ? 40 : dg.maxSteps),
    lastDecision: dg.lastDecision || {}, nextHint: dg.nextHint || '',
    stage: stageKey, stageLabel: (dg.plan && dg.plan[dg.planIdx] || {}).label || stageKey,
    roll, mod, total, actor: actor.name,
    support: support ? support.name : null, support2: support2 ? support2.name : null, attr: attrKey,
    focus: focus ? { actor: actor.name, step: focus.focusStep, size: focus.windowSize, highlight: !!focus.highlight, mode: focus.mode } : null,
    allowedCharacters, forbiddenCharacters,
    stepNo: dg.totalStep + 1, totalSteps: Number(dg.maxSteps == null ? ((dg.plan || []).reduce((a, p) => a + p.steps, 0) || 40) : dg.maxSteps),
    enemy: dg._curEnemy ? { name: dg._curEnemy.name, realm: dg._curEnemy.realm || '', desc: dg._curEnemy.desc || '' } : null,
    itemUse: itemUse ? { name: itemUse.item.name, desc: itemUse.item.desc || '', kind: itemUse.item.kind || 'misc', roll: itemUse.roll, total: itemUse.total, success: itemUse.success } : null,
    skillUse: skillUse ? { name: skillUse.name, type: skillUse.type, tier: skillUse.tier || '黄阶', elem: skillUse.elem || '', elemMod: skillUse.elemMod || 0, desc: skillUse.desc || '', roll: skillUse.roll, total: skillUse.total, success: skillUse.success } : null,
    party: dg.party.map(m => ({
      name: m.name, gender: m.gender || '男', realm: m.character_class || '', root: (m.traits && m.traits[0]) || '',
      personality: m.personality || '', traits: m.traits || [],
      skills: (m.skills || []).map(s => ({ name: s.name, type: s.type || '', tier: skillTier(s), desc: s.desc || '' })),
      items: (m.equipment || []).map(i => ({ name: i.name, kind: i.kind || 'misc', desc: i.desc || '', qty: i.qty || 1 })),
    })),
    context: dg.steps.slice(-5).map(s => s.text).join('\n'),
  };
}

module.exports = {
  DUNGEON_POOL, STAGE_ATTR, ATTR_NAME, QI_LAYER, SKILL_TIERS, MAX_SKILLS, NPC_NAME_POOL, BREAKTHROUGH_EXP,
  rollD20, pick, skillTier, itemBonus, traitBonus, realmBonus, realmDiffMod, elemMatchMod,
  rollEnemies, pickDungeon, buildPlan, buildNarrativeFocusPlan, itemUseCheck, skillUseCheck, parseLootMarkers, extractGold,
  applyStageEffects, genNpc, createDg, aiStoryPayload, addTrait, regenerateHp, assignLoot, hasDuplicateCharacterName, experienceNeeded, canBreakthrough,
  applyLevelGrowth, applyExperience, parseLearnedSkills, applyLearnedSkills,
  normalizeAiDecision, canEnterClosing, resolveNextPhase, applyAiDecision,
};

## server dynamic changes
  const s = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && typeof ws._uid === 'number') ws.send(s);
  });
}
function runningSnapshot(room) {
  const dg = room && room.dg;
  if (!dg) return null;
  return {
    id: dg.id,
    runId: dg.id,
    startedAt: dg.startedAt,
    dungeon: dg.dungeon,
    baseDungeon: dg.dungeon.baseName,
    planLabels: dg.plan.map(p => ({ key: p.key, label: p.label })),
    party: roomStatePublic(room).party,
    dgParty: dg.party.map(m => ({
      uid: m.uid || null,
      charId: m.charId || null,
      name: m.name,
      hp: m.hp,
      max_hp: m.max_hp || 100,
      isNpc: !!m.isNpc,
    })),
    steps: dg.steps || [],
    totalStep: dg.totalStep || 0,
    flowMode: dg.flowMode || 'legacy', minSteps: dg.minSteps, maxSteps: dg.maxSteps,
    phase: dg.phase, quest: dg.quest, encounter: dg.encounter, lastDecision: dg.lastDecision, nextHint: dg.nextHint,
  };
}
function addMember(room, m) { room.party.push(m); }
function waitingRoomsPublic() {
  return Array.from(ROOMS.values()).filter(room => room.status === 'waiting').map(roomStatePublic);
}
function broadcastRooms() {
  const payload = JSON.stringify({ type: 'rooms_updated', rooms: waitingRoomsPublic() });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && typeof ws._uid === 'number') ws.send(payload);
  });
}
function roomForMember(ws) { return ws._roomId ? ROOMS.get(ws._roomId) : null; }
function roomForUser(uid) {
  return Array.from(ROOMS.values()).find(room => (
    room.status === 'waiting' && room.party.some(member => member.uid === uid)
  )) || null;
}
function authenticatedSocketUser(ws, token) {
  const uid = token ? DB.sessionUserId(token) : null;
  if (!uid || ws._uid !== uid) return null;
  return DB.findUserById(uid);
}
function validDungeonName(name) {
  return typeof name === 'string' && GE.DUNGEON_POOL.some(dungeon => dungeon.name === name);
}
function memberFromCharacter(uid, character, ws) {
  return {
    uid,
    name: character.data.name,
    charId: Number(character.id),
    char: character.data,
    ws,
    isNpc: false,
    character_class: character.data.character_class || '',
  };
}
function toPublic(uid) {
  const u = DB.findUserById(uid);
  return { uid, username: u ? u.username : '?' };
}

/* ---------- 服务端权威副本推进 ---------- */
const TICK_MS = process.env.ROOM_FAST === '1' ? 50 : 3500;
function fillNpcs(room) {
  const target = 4;
  while ((room.party || []).length < target) {
    const used = new Set((room.party || []).map(member => member && member.name));
    const available = GE.NPC_NAME_POOL.filter(name => !used.has(name));
    const npc = GE.genNpc(available.length ? available[Math.floor(Math.random() * available.length)] : `无名修士${room.party.length + 1}`);
    npc.ws = null; npc.isNpc = true; addMember(room, npc);
  }
}
function startRoomRun(room, hostChar) {
  const dg = GE.createDg(hostChar, { choice: room.choice });
  dg.party = room.party.map(m => m.isNpc
    ? { ...m, id: m.id || m.name, name: m.name, isNpc: true, is_mine: false, ws: null }
    : { ...(GC.ROOT_SKILLS ? hostChar : {}), ...(m.char ? m.char : {}), id: m.uid, name: m.name, is_mine: true, ws: m.ws, uid: m.uid, charId: m.charId, isNpc: false });
  // 副本开始即是明确的精力消耗：服务端立即持久化“探险中”，公共角色列表才能让所有玩家看到真实状态。
  for (const member of dg.party) {
    if (member.isNpc || !member.uid || !member.charId) continue;
    member.status = 'adventuring';
    member.stamina = Math.max(0, (member.stamina || 0) - 10);
    const character = DB.getCharacter(member.uid, member.charId);
    if (!character) continue;
    const role = character.data;
    role.status = 'adventuring';
    role.stamina = Math.max(0, (role.stamina || 0) - 10);
    const saved = DB.saveCharacter(member.uid, member.charId, role, role.name);
    notifyCharacterUpdated(member.uid, member.charId, saved.updated_at);
  }
  dg.party.forEach(m => { const id = m.uid || m.id; dg.memberGains[id] = { acts: 0, rolls: [], damage: 0, loot: [], traits: [], crits: 0, fumbles: 0 }; });
  dg.focusPlan = dg.flowMode === 'dynamic' ? [] : GE.buildNarrativeFocusPlan(dg);
  dg.status = 'running'; room.status = 'running'; room.dg = dg;
  broadcastAll({ type: 'dungeon_started', runId: dg.id, snapshot: runningSnapshot(room) });
  scheduleTick(room);
}
function scheduleTick(room) {
  if (room.status !== 'running' || !room.dg) return;
  if (room._timer) return;
  room._timer = setTimeout(async () => {
    room._timer = null;
    if (room.status !== 'running' || !room.dg) return;
    try { await dungeonStep(room); } catch (e) { console.error('[run] 步骤失败:', e.message); failRoomRun(room, e); }
  }, TICK_MS);
}
function failRoomRun(room, error) {
  if (!room || room._failureRecorded) return;
  room._failureRecorded = true;
  const dg = room.dg;
  if (room._timer) { clearTimeout(room._timer); room._timer = null; }
  const message = String(error && error.message || error || 'AI 叙事生成失败').slice(0, 200);
  const storyText = dg ? dg.steps.map(s => `第${s.stepNo}段：${s.rawText || s.text || ''}`).join('\n') : '';
  if (dg) {
    for (const member of dg.party || []) {
      if (member.isNpc || !member.uid) continue;
      const character = member.charId ? DB.getCharacter(member.uid, member.charId) : null;
      if (character) {
        const role = character.data;
        role.status = 'resting';
        // 副本开始已扣除 10 点精力，AI 失败取消时原路退还；不写入副本中的临时气血。
        role.stamina = Math.min(role.max_stamina || 100, (role.stamina || 0) + 10);
        const saved = DB.saveCharacter(member.uid, member.charId, role, role.name);
        notifyCharacterUpdated(member.uid, member.charId, saved.updated_at);
      }
      const log = {
        id: DB.nextLogSeq(member.uid), run_id: dg.id,
        party_name: '匹配小队' + room.id, dungeon_name: dg.dungeon.name,
        status: 'failed', result_summary: storyText, created_at: new Date().toISOString(),
        is_favorited: false, summary_text: '', cancel_reason: message,
        dg_snapshot: { icon: dg.dungeon.icon, name: dg.dungeon.name, baseName: dg.dungeon.baseName, isHidden: !!dg.dungeon.isHidden, specialEvent: !!dg.dungeon.specialEvent, steps: dg.steps, party: dg.party.map(x => ({ name: x.name, is_mine: !x.isNpc })) },
        settlement: null,
      };
      DB.addLog(member.uid, log);
    }
  }
  room.status = 'error';
  broadcastAll({ type: 'run_error', runId: dg && dg.id, error: 'AI 生成失败，已重试仍未得到有效内容', detail: message, snapshot: dg ? runningSnapshot(room) : null });
  room.party.forEach(member => { if (!member.isNpc && member.ws) member.ws._roomId = null; });
  if (ROOMS.get(room.id) === room) ROOMS.delete(room.id);
}
async function dungeonStep(room) {
  const dg = room.dg;
  const dynamic = dg.flowMode === 'dynamic';
  const plan = dynamic ? null : dg.plan[dg.planIdx];
  if (!dynamic && !plan) { await settleRoom(room); return; }
  const stageKey = dynamic ? (dg.phase || 'explore') : plan.key;
  if (!dynamic && (!dg.focusPlan || dg.focusPlan.length !== dg.plan.reduce((sum, entry) => sum + entry.steps, 0))) dg.focusPlan = GE.buildNarrativeFocusPlan(dg);
  const focus = dynamic
    ? { actorIndex: dg.totalStep % Math.max(1, dg.party.length), supportIndex: null, support2Index: null, highlight: dg.totalStep > 0 && dg.totalStep % 3 === 2, mode: 'focus', focusStep: 1, windowSize: 1 }
    : (dg.focusPlan[dg.totalStep] || { actorIndex: dg.totalStep % dg.party.length, supportIndex: null, support2Index: null, highlight: false });
  const actor = dg.party[focus.actorIndex] || dg.party[0];
  const support = focus.supportIndex == null ? null : dg.party[focus.supportIndex] || null;
  const support2 = focus.support2Index == null ? null : dg.party[focus.support2Index] || null;
  if (stageKey === 'battle') dg._curEnemy = dg.dungeon.enemies[Math.floor(Math.random() * dg.dungeon.enemies.length)];
  else if (stageKey === 'boss') dg._curEnemy = dg.dungeon.bosses[dg.stepIdx] || dg.dungeon.bosses[0];
  else dg._curEnemy = null;
  let roll = 0, mod = 0, total = 0, attrKey = '', realmB = 0;
  const checkStage = stageKey === 'encounter' ? 'explore' : stageKey;
  const needsCheck = dynamic ? !['opening', 'closing', 'rest', 'retreat'].includes(stageKey) : plan.check;
  if (needsCheck) {
    const attrKeys = GE.STAGE_ATTR[checkStage] || GE.STAGE_ATTR.explore;
    attrKey = attrKeys[Math.floor(Math.random() * attrKeys.length)];
    const attr = actor[attrKey] || 10;
    realmB = GE.realmBonus(actor);
    const realmDiff = (stageKey === 'battle' || stageKey === 'boss') ? GE.realmDiffMod(actor, dg._curEnemy) : 0;
    mod = Math.floor((attr - 10) / 2) + GE.itemBonus(dg, checkStage) + GE.traitBonus(actor) + realmB + realmDiff;
    roll = GE.rollD20();
    total = roll + mod;
  }
  const itemUse = needsCheck ? GE.itemUseCheck(dg, checkStage) : null;
  const skillUse = needsCheck ? GE.skillUseCheck(dg, checkStage, actor) : null;
  if (itemUse && itemUse.success && (itemUse.item.kind === 'pill' || itemUse.item.kind === 'talisman')) { if (!dg.consumed) dg.consumed = []; dg.consumed.push({ name: itemUse.item.name, ownerId: actor.uid || null }); }
  const payload = GE.aiStoryPayload(dg, stageKey, actor, support, support2, attrKey, roll, mod, total, itemUse, skillUse);
  if (dynamic) {
    dg.focusPlan = dg.focusPlan || [];
    dg.focusPlan.push({ stageKey, mode: focus.mode, windowId: dg.totalStep, focusStep: 1, windowSize: 1, actorIndex: focus.actorIndex, supportIndex: null, support2Index: null, highlight: !!focus.highlight });
  }
  const j = await callAIStory(payload);
  const text = j && j.text ? String(j.text) : '';
  if (!text) throw new Error('AI 返回空内容');
  const lootNames = GE.parseLootMarkers(text);
  if (lootNames.length) { if (!dg.gainedLoot) dg.gainedLoot = []; lootNames.forEach(n => { if (!dg.gainedLoot.some(x => x.name === n)) dg.gainedLoot.push(n); }); }
  const rawText = String(text).trim();
  const cleanText = rawText.replace(/【获得：[^】]*】/g, '').trim();
  const goodBar = dg.dungeon.specialEvent ? 14 : 12;
  const outcome = needsCheck ? (total >= 18 || roll === 20 ? 'crit' : total >= goodBar ? 'good' : total >= 7 ? 'mid' : total >= 2 ? 'bad' : 'fumble') : 'good';
  GE.applyStageEffects(dg, stageKey, actor, total, outcome);
  const stepRec = {
    stage: stageKey, actor: actor.name, attr: attrKey, roll, mod, total, outcome, text: cleanText, rawText,
    stepNo: dg.totalStep + 1, enemy: dg._curEnemy ? dg._curEnemy.name : '', realmB, src: 'ai',
    itemUse: itemUse ? { name: itemUse.item.name, success: itemUse.success } : null,
    skillUse: skillUse ? { name: skillUse.name, type: skillUse.type, tier: skillUse.tier, elemMod: skillUse.elemMod || 0, success: skillUse.success } : null,
  };
  dg.steps.push(stepRec);
  const g = dg.memberGains[actor.uid || actor.id];
  if (g) { g.acts++; if (needsCheck) { g.rolls.push(total); if (outcome === 'crit') g.crits++; if (outcome === 'fumble') g.fumbles++; } }
  if (support && cleanText.includes(support.name)) { const sg = dg.memberGains[support.uid || support.id]; if (sg) sg.acts++; }
  if (support2 && cleanText.includes(support2.name)) { const sg2 = dg.memberGains[support2.uid || support2.id]; if (sg2) sg2.acts++; }
  dg.totalStep++;
  if (!dynamic) { dg.stepIdx++; if (dg.stepIdx >= plan.steps) { dg.stepIdx = 0; dg.planIdx++; } }
  let decision = j.decision || {};
  if (dynamic) {
    const fallbackPhase = dg.totalStep > 0 && dg.phase === 'opening' ? 'explore' : dg.phase;
    decision = GE.normalizeAiDecision(decision, { phase: fallbackPhase, questStatus: dg.quest && dg.quest.status, encounterStatus: dg.encounter && dg.encounter.status, nextHint: dg.nextHint });
    if (dg.totalStep < dg.minSteps && decision.phase === 'closing') decision = { ...decision, phase: dg.phase, continue: true };
    GE.applyAiDecision(dg, decision);
  }
  broadcastAll({
    type: 'step',
    runId: dg.id,
    step: {
      no: stepRec.stepNo, stage: stepRec.stage, stageLabel: dynamic ? stageKey : plan.label, actor: stepRec.actor, text: stepRec.text,
      roll, mod, total, success: outcome !== 'bad' && outcome !== 'fumble',
      itemUse: stepRec.itemUse, skillUse: stepRec.skillUse, enemy: stepRec.enemy,
      partyHp: dg.party.map(m => ({ name: m.name, hp: m.hp || 0, max_hp: m.max_hp || 100 })),
    },
  });
  if (dynamic) {
    if (dg.phase === 'closing' && GE.canEnterClosing(dg, dg.lastDecision || {})) { await settleRoom(room); return; }
    if (dg.totalStep >= dg.maxSteps) { await settleRoom(room); return; }
  } else if (!dg.plan[dg.planIdx]) { await settleRoom(room); return; }
  scheduleTick(room);
}

function parseAiStoryResponse(content, fallback = {}) {
  const raw = String(content || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) { try { parsed = JSON.parse(fenced[1]); } catch {} }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { text: raw, decision: GE.normalizeAiDecision({}, fallback) };
  const text = String(parsed.text || parsed.content || '').trim() || raw;
  const decision = GE.normalizeAiDecision(parsed, fallback);
  return { text, decision };
}
async function callAIStory(payload) {
  if (process.env.ROOM_FAST === '1') throw new Error('FAST_MODE');
  if (!isConfigured) throw new Error('AI 未配置');
  const url = CONFIG.baseURL.replace(/\/+$/, '') + '/chat/completions';
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CONFIG.apiKey },
        body: JSON.stringify({ model: CONFIG.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserMessage(payload) }], temperature: CONFIG.temperature ?? 0.85, max_tokens: CONFIG.maxTokens ?? 5000, stream: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
      const rawContent = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (!rawContent) throw new Error('AI 返回空内容');
      let text = rawContent;
      if (text.includes('\uFFFD')) throw new Error('AI 返回乱码（重试中）');
      const parsed = parseAiStoryResponse(text, { phase: payload.phase || payload.stage || 'explore', questStatus: payload.quest && payload.quest.status, encounterStatus: payload.encounter && payload.encounter.status, nextHint: payload.nextHint });
      text = parsed.text;
      // 联机副本单步同样限制为 300 字，保留完整句子避免截断在句中
      const maxLength = 300;
      if (text.length > maxLength) {
        const cut = text.slice(0, maxLength);
        const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
        return { text: lastDot > 100 ? cut.slice(0, lastDot + 1) : cut, decision: parsed.decision };
      }
      return { text, decision: parsed.decision };
    } catch (e) {
      lastError = e;
      if (attempt === 0) {
        console.warn(`[ai-story] 第 1 次调用失败，准备重试：${e.name === 'AbortError' ? '超时(120s)' : String(e.message || e).slice(0, 160)}`);
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('AI 叙事生成失败');
}
async function settleRoom(room) {
  const dg = room.dg;
  room.status = 'settling';
  let storyText = dg.steps.map(s => `第${s.stepNo}段：${s.rawText || s.text || ''}`).join('\n');
  const runSignature = `${room.id}-${dg.startedAt || Date.now()}-${dg.steps.length}-${storyText.length}`;
  // 并行的 AI 结算（对齐单机版 Promise.all）：总结 + 成败判定 + 战利品提取
  const [summaryRaw, outcomeRaw, lootRaw, learnedSkillsRaw] = await Promise.all([
    callLLM(`本局编号：${runSignature}\n副本：${dg.dungeon.name}\n\n探险日志全文（必须以此为唯一依据）：\n${storyText.slice(0, 8000)}`, SUMMARY_PROMPT),
    callLLM('探险日志全文：\n' + storyText.slice(0, 12000), OUTCOME_PROMPT),
    // 战利品提取是结构化 JSON，使用独立长度上限，避免多段明确获得记录被截断。
    callLLM('探险日志全文：\n' + storyText.slice(0, 12000), EXTRACT_LOOT_PROMPT, 2000),
    callLLM('队伍成员：' + dg.party.filter(member => !member.isNpc).map(member => member.name).join('、') + '\n\n探险日志全文：\n' + storyText.slice(0, 12000), LEARNED_SKILL_PROMPT, 2000),
  ]);
  // 探险总结：150 字以内截断，并保留完整句子（避免切到句中导致不完整）
  let summaryText = String(summaryRaw || '').trim();
  if (!summaryText) throw new Error('AI 未返回探险总结');
  if (summaryText.length > 150) {
    const cut = summaryText.slice(0, 150);
    const lastDot = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('…'));
    summaryText = lastDot > 60 ? cut.slice(0, lastDot + 1) : cut;
  }
  let aiOk = null;

## tests
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDg,
  normalizeAiDecision,
  canEnterClosing,
  resolveNextPhase,
  applyAiDecision,
} = require('../game-engine.js');

test('createDg initializes dynamic flow state independent of plan length', () => {
  const dg = createDg({ level: 1, exp: 0, name: '测试修士' }, { choice: '枯骨林' });
  assert.equal(dg.flowMode, 'dynamic');
  assert.equal(dg.minSteps, 10);
  assert.equal(dg.maxSteps, 40);
  assert.equal(dg.phase, 'opening');
  assert.equal(dg.quest.status, 'active');
  assert.equal(typeof dg.quest.objective, 'string');
  assert.equal(dg.encounter.status, 'none');
  assert.deepEqual(dg.lastDecision, {});
  assert.equal(dg.nextHint, '');
  assert.notEqual(dg.plan.reduce((sum, entry) => sum + entry.steps, 0), 0);
});

test('dynamic boss encounter remains active until AI resolves it before loot and closing', () => {
  const state = { flowMode: 'dynamic', totalStep: 10, minSteps: 10, maxSteps: 40, phase: 'boss', quest: { status: 'active' }, encounter: { status: 'none' } };
  applyAiDecision(state, { phase: 'boss', event: 'advance', questStatus: 'active', encounterStatus: 'active' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'boss', event: 'advance', questStatus: 'active', encounterStatus: 'active' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'boss', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'boss');
  applyAiDecision(state, { phase: 'loot', event: 'advance', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'loot');
  applyAiDecision(state, { phase: 'closing', event: 'advance', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.phase, 'closing');
});

test('dynamic flow forces continuation before minSteps and fails unresolved quest at maxSteps', () => {
  const early = { flowMode: 'dynamic', totalStep: 8, minSteps: 10, maxSteps: 40, phase: 'explore', quest: { status: 'completed' }, encounter: { status: 'none' } };
  applyAiDecision(early, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none', continue: false });
  assert.notEqual(early.phase, 'closing');
  const late = { flowMode: 'dynamic', totalStep: 40, minSteps: 10, maxSteps: 40, phase: 'explore', quest: { status: 'active' }, encounter: { status: 'none' } };
  applyAiDecision(late, { phase: 'explore', questStatus: 'active', encounterStatus: 'none' });
  assert.equal(late.quest.status, 'failed');
  assert.equal(late.phase, 'closing');
});

const base = (overrides = {}) => ({
  totalStep: 10,
  minSteps: 10,
  maxSteps: 40,
  phase: 'explore',
  quest: { status: 'active' },
  encounter: { status: 'none' },
  nextHint: '',
  ...overrides,
});

test('invalid phase falls back to fallback.phase', () => {
  const d = normalizeAiDecision({ phase: 'bogus' }, { phase: 'battle' });
  assert.equal(d.phase, 'battle');
});

test('missing statuses use safe active defaults unless fallback supplies valid values', () => {
  const d = normalizeAiDecision({}, { phase: 'explore', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(d.questStatus, 'completed');
  assert.equal(d.encounterStatus, 'resolved');
  const safe = normalizeAiDecision({}, { phase: 'explore' });
  assert.equal(safe.questStatus, 'active');
  assert.equal(safe.encounterStatus, 'active');
});

test('nextHint is trimmed and bounded', () => {
  const d = normalizeAiDecision({ nextHint: '  hello ' + 'x'.repeat(500) }, { phase: 'explore' });
  assert.equal(d.nextHint.length, 240);
  assert.equal(d.nextHint.startsWith('hello'), true);
});

test('continue is boolean with safe continuation default', () => {
  assert.equal(normalizeAiDecision({}, { phase: 'explore' }).continue, true);
  assert.equal(normalizeAiDecision({ continue: 0 }, { phase: 'explore' }).continue, false);
  assert.equal(normalizeAiDecision({ continue: 'no' }, { phase: 'explore' }).continue, true);
  assert.equal(normalizeAiDecision({ continue: 'no' }, { phase: 'explore', continue: false }).continue, false);
  assert.equal(normalizeAiDecision({ event: 'bad', questStatus: 'bad', encounterStatus: 'bad' }, { phase: 'explore' }).event, 'advance');
});

test('closing before minSteps is rejected', () => {
  const state = base({ totalStep: 9 });
  const decision = normalizeAiDecision({ phase: 'closing' }, { phase: 'closing' });
  assert.equal(canEnterClosing(state, decision), false);
});

test('closing with active quest or encounter is rejected', () => {
  const state = base({ totalStep: 10 });
  assert.equal(canEnterClosing(state, normalizeAiDecision({ phase: 'closing' }, {})), false);
  assert.equal(canEnterClosing({ ...state, quest: { status: 'completed' }, encounter: { status: 'active' } }, normalizeAiDecision({ phase: 'closing' }, {})), false);
});

test('resolved quest and encounter can close after minSteps', () => {
  const state = base({ quest: { status: 'completed' }, encounter: { status: 'resolved' } });
  assert.equal(canEnterClosing(state, normalizeAiDecision({ phase: 'closing' }, {})), true);
  for (const qs of ['failed', 'retreated']) {
    assert.equal(canEnterClosing({ ...state, quest: { status: qs }, encounter: { status: 'none' } }, normalizeAiDecision({ phase: 'closing' }, {})), true);
  }
});

test('active encounter rejects loot and preserves current conflict phase', () => {
  const state = base({ phase: 'battle', encounter: { status: 'active' } });
  const decision = normalizeAiDecision({ phase: 'loot' }, { phase: 'battle' });
  assert.equal(resolveNextPhase(state, decision), 'battle');
});

test('resolver normalizes malformed decision phases', () => {
  const state = base({ phase: 'battle' });
  assert.equal(resolveNextPhase(state, { phase: 'bogus' }), 'battle');
});

test('at maxSteps unresolved quest becomes failed and closes', () => {
  const state = base({ totalStep: 40, phase: 'explore', quest: { status: 'active' } });
  const decision = normalizeAiDecision({ phase: 'explore' }, { phase: 'explore' });
  const next = resolveNextPhase(state, decision);
  assert.equal(state.quest.status, 'active');
  assert.equal(next, 'closing');
});

test('at maxSteps forged success cannot override unresolved prior state', () => {
  const state = base({ totalStep: 40, quest: { status: 'active' }, encounter: { status: 'active' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved' });
  assert.equal(state.quest.status, 'failed');
  assert.equal(state.encounter.status, 'escaped');
  assert.equal(state.phase, 'closing');
});

test('at maxSteps malformed or missing encounter settles to escaped', () => {
  for (const encounter of [undefined, { status: 'bogus' }]) {
    const state = base({ totalStep: 40, quest: { status: 'completed' }, encounter });
    applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'resolved' });
    assert.equal(state.encounter.status, 'escaped');
  }
});

test('at maxSteps missing quest settles to failed', () => {
  const state = base({ totalStep: 40, quest: undefined, encounter: { status: 'none' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'failed');
});

test('at maxSteps malformed prior quest cannot forge completion', () => {
  const state = base({ totalStep: 40, quest: { status: 'bogus' }, encounter: { status: 'none' } });
  applyAiDecision(state, { phase: 'closing', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'failed');
});

test('applyAiDecision initializes missing quest and encounter containers', () => {
  const state = base(); delete state.quest; delete state.encounter;
  applyAiDecision(state, { phase: 'explore', questStatus: 'completed', encounterStatus: 'none' });
  assert.equal(state.quest.status, 'completed');
  assert.equal(state.encounter.status, 'none');
});

test('applyAiDecision updates decision-owned fields and stores normalized decision', () => {
  const state = base({ phase: 'explore', quest: { status: 'active' }, encounter: { status: 'none' } });
  const d = applyAiDecision(state, { phase: 'loot', event: 'resolve', questStatus: 'completed', encounterStatus: 'resolved', nextHint: ' next ' });
  assert.equal(d.phase, 'loot');
  assert.equal(state.phase, 'loot');
  assert.equal(state.quest.status, 'completed');
  assert.equal(state.encounter.status, 'resolved');
  assert.equal(state.lastDecision, d);
  assert.equal(state.nextHint, 'next');
  assert.equal(state.totalStep, 10);
});
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('server.js', 'utf8');

test('new online runs opt into dynamic flow and expose authoritative state', () => {
  const run = source.slice(source.indexOf('function startRoomRun'), source.indexOf('function leaveRoomCleanup'));
  assert.match(run, /GE\.createDg\(hostChar, \{ choice: room\.choice \}\)/);
  assert.match(run, /flowMode === 'dynamic'/);
  assert.match(source, /minSteps: dg\.minSteps, maxSteps: dg\.maxSteps/);
  assert.match(source, /phase: dg\.phase, quest: dg\.quest, encounter: dg\.encounter/);
});

test('dynamic dungeonStep applies AI decision before settling or scheduling', () => {
  const step = source.slice(source.indexOf('async function dungeonStep'), source.indexOf('function parseAiStoryResponse'));
  assert.match(step, /j\.decision/);
  assert.match(step, /GE\.applyAiDecision\(dg, decision\)/);
  assert.match(step, /GE\.canEnterClosing\(dg/);
  assert.match(step, /dg\.totalStep >= dg\.maxSteps/);
  assert.match(step, /scheduleTick\(room\)/);
});

test('AI story parser accepts structured decisions and plain-text fallback', () => {
  assert.match(source, /function parseAiStoryResponse\(content, fallback = \{\}\)/);
  assert.match(source, /GE\.normalizeAiDecision\(parsed, fallback\)/);
  assert.match(source, /return \{ text: raw, decision: GE\.normalizeAiDecision/);
  assert.match(source, /phase: payload\.phase/);
});
