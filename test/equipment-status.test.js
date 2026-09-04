const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const online = fs.readFileSync(path.join(__dirname, '..', 'online.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('equipment and skill actions stay locked during expedition and inn treatment', () => {
  assert.match(server, /function equipmentActionBusyReason\(role\)/);
  assert.match(server, /const busy = action === 'inn_exit' \? '' : \(\['inventory_equip', 'inventory_unequip', 'consumable_slot_equip', 'consumable_slot_unequip', 'skill_equip', 'skill_unequip'\]\.includes\(action\)\s*\? equipmentActionBusyReason\(role\)\s*:\s*characterBusyReason\(role\)\)/);
  assert.match(server, /if \(role && role\.status === 'adventuring'\) return '角色正在地下城探险'/);
  assert.match(server, /if \(role && \(role\.status === 'treating' \|\| role\.seriaInn\)\) return '角色正在赛利亚旅馆治疗'/);
});

test('online equipment actions are not blocked by insighting or cultivation states', () => {
  const actionBlock = online.match(/async function onlineCharacterAction\([\s\S]*?\n  }/);
  assert.ok(actionBlock);
  assert.doesNotMatch(actionBlock[0], /insighting|taixuInsight|cultivat/);
});

test('online character actions refresh and retry once after a role conflict', () => {
  const actionBlock = online.match(/async function onlineCharacterAction\([\s\S]*?\n  }/);
  assert.ok(actionBlock);
  assert.match(actionBlock[0], /for \(let attempt = 0; attempt < 2/);
  assert.match(actionBlock[0], /await refreshOnlineRoles\(\)/);
  assert.match(online, /function isCharacterConflictMessage[\s\S]*角色数据已更新/);
});

test('server-committed forging avoids a redundant full role upload', () => {
  const doForge = source.slice(source.indexOf('async function doForge'), source.indexOf('function consumeForgeMat'));
  assert.match(doForge, /serverCommitted = true/);
  assert.match(doForge, /if \(!serverCommitted\)/);
});
