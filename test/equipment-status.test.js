const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const online = fs.readFileSync(path.join(__dirname, '..', 'online.js'), 'utf8');

test('equipment and skill actions use an adventuring-only busy guard', () => {
  assert.match(server, /function equipmentActionBusyReason\(role\)/);
  assert.match(server, /const busy = \['inventory_equip', 'inventory_unequip', 'skill_equip', 'skill_unequip'\]\.includes\(action\)\s*\? equipmentActionBusyReason\(role\)\s*:\s*characterBusyReason\(role\)/);
  assert.match(server, /if \(role\.status === 'adventuring'\) return '角色正在探险'/);
});

test('online equipment actions are not blocked by insighting or cultivation states', () => {
  const actionBlock = online.match(/async function onlineCharacterAction\([\s\S]*?\n  }/);
  assert.ok(actionBlock);
  assert.doesNotMatch(actionBlock[0], /insighting|taixuInsight|cultivat/);
});
