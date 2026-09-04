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
  const lowActor = { level: 1, strength: 2, agility: 2, intelligence: 2, luck: 2, equipment: [], skills: [] };
  const highActor = { level: 10, strength: 18, agility: 18, intelligence: 10, luck: 10, equipment: [], skills: [] };
  const original = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(GE.resolveActionCheck(dg, 'battle', lowActor).outcome, 'fumble');
    Math.random = () => 0.999999;
    assert.equal(GE.resolveActionCheck(dg, 'battle', highActor).outcome, 'crit');
  } finally {
    Math.random = original;
  }
});

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
