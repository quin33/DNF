const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyStageEffects } = require('../game-engine.js');

const ROOT = path.join(__dirname, '..');

test('applyStageEffects marks a member dead when hp reaches zero', () => {
  const dg = {
    damage: 0,
    deaths: [],
    memberGains: { u1: { damage: 0, fumbles: 0 } },
    _curEnemy: null,
    bossDrops: [],
  };
  const actor = { id: 'u1', name: '测试修士', hp: 10, max_hp: 100 };

  applyStageEffects(dg, 'battle', actor, 5, 'fumble', 20);
  assert.equal(actor.hp, 0);
  assert.equal(actor.isDead, true);
  assert.deepEqual(dg.deaths, ['测试修士']);

  applyStageEffects(dg, 'battle', actor, 5, 'bad', 20);
  assert.equal(actor.hp, 0);
  assert.equal(dg.deaths.length, 1, 'dead member should only be recorded once');
});

test('AI damage is authoritative and positive damage applies regardless of outcome', () => {
  const dg = {
    damage: 0,
    deaths: [],
    memberGains: { u1: { damage: 0, fumbles: 0 } },
    _curEnemy: null,
    bossDrops: [],
  };
  const actor = { id: 'u1', name: '测试修士', hp: 100, max_hp: 100 };

  applyStageEffects(dg, 'battle', actor, 0, 'bad', 0);
  assert.equal(actor.hp, 100);
  assert.equal(dg.damage, 0);

  applyStageEffects(dg, 'battle', actor, 0, 'good', 7);
  assert.equal(actor.hp, 93);
  assert.equal(dg.damage, 7);
  assert.equal(dg.memberGains.u1.damage, 7);
});

test('successful AI healing restores HP without exceeding max HP', () => {
  const dg = {
    damage: 0,
    deaths: [],
    memberGains: { u1: { damage: 0, healing: 0 } },
    _curEnemy: null,
    bossDrops: [],
  };
  const actor = { id: 'u1', name: '测试修士', hp: 40, max_hp: 50 };

  applyStageEffects(dg, 'battle', actor, 0, 'good', 0, 20, true);

  assert.equal(actor.hp, 50);
  assert.equal(dg.healing, 10);
  assert.equal(dg.memberGains.u1.healing, 10);
});

test('settlement permanently deletes dead characters and keeps death logs', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

  assert.match(server, /fate: \(hpNow <= 0 \|\| m\.isDead\) \? '阵亡'/);
  assert.match(server, /characterDeletes\.push\(\{ userId: m\.uid, characterId: m\.charId \}\)/);
  assert.match(server, /DB\.commitExpeditionSettlement\(/);
  assert.match(server, /committed\.deletedCharacters/);
  assert.match(server, /function notifyCharacterDeleted/);
  assert.match(online, /case 'character_deleted'/);
  assert.match(online, /window\.showDeathDialog/);
  assert.match(index, /showDeathDialog\(role\.name, dg\.dungeon\.name, deathLog\.id/);
  assert.match(index, /角色数据已永久删除/);
  assert.match(styles, /\.msc-fate\.dead/);
});

test('death summaries are generated as structured per-role reasons and an overall summary', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const online = fs.readFileSync(path.join(ROOT, 'online.js'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  assert.match(server, /\/api\/ai\/death-summary/);
  assert.match(server, /death_summary/);
  assert.match(server, /death_reason/);
  assert.match(server, /overall/);
  assert.match(server, /roles/);
  assert.match(online, /death_reason/);
  assert.match(index, /death_reason/);
  assert.match(index, /死亡记录/);
});
