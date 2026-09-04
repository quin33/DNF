const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const AI = require('../ai-companions.js');
const GE = require('../game-engine.js');
const DB = require('../db.js');
const { createRoomRunner } = require('../room-runner.js');

test('preset companion library ships twenty complete cards matching the fixed NPC names', () => {
  assert.equal(AI.DEFAULT_CARDS.length, 20);
  assert.deepEqual(AI.NPC_NAME_POOL, [
    '赛丽亚·克鲁敏', '林纳斯', '卡妮娜', '凯丽', '莎兰', '风振',
    'G.S.D', '歌兰蒂斯', '阿尔伯特', '辛达', '罗莉安', '奥兰奶奶',
    '阿甘左', '西岚', '布万加', '巴恩', '卢克西', '帕丽丝',
    '沙影·贝利特', '尼尔巴斯·格拉西亚',
  ]);
  for (const card of AI.DEFAULT_CARDS) {
    assert.ok(card.key, 'card key is present');
    assert.ok(card.name, 'card name is present');
    assert.ok(card.bio && card.bio.length > 0, `${card.name} has a biography`);
    assert.ok(card.personality, `${card.name} has a personality`);
    assert.equal(card.traits, undefined, `${card.name} no longer ships a traits array`);
    assert.equal(card.traitDescs, undefined, `${card.name} no longer ships traitDescs`);
    assert.ok(card.character_class, `${card.name} has a character class`);
    assert.ok(card.skills.length >= 1, `${card.name} has skills`);
    assert.ok(card.bag.length >= 1, `${card.name} has a bag`);
    for (const attr of ['strength', 'agility', 'intelligence', 'luck']) {
      assert.ok(Number.isFinite(card[attr]), `${card.name}.${attr} is numeric`);
    }
    assert.ok(card.hp <= card.max_hp, `${card.name} hp is within max_hp`);
    assert.ok(card.stamina <= card.max_stamina, `${card.name} stamina is within max_stamina`);
  }
});

test('genNpc uses the preset card when supplied and falls back to random data otherwise', () => {
  const card = AI.findCardByName('赛丽亚·克鲁敏');
  const npc = GE.genNpc(card.name, card);
  assert.equal(npc.name, '赛丽亚·克鲁敏');
  assert.equal(npc.is_npc, true);
  assert.equal(npc.is_mine, false);
  assert.equal(npc.gender, card.gender);
  assert.equal(npc.character_class, card.character_class);
  assert.equal(npc.strength, card.strength);
  assert.equal(npc.max_hp, card.max_hp);
  assert.deepEqual(npc.skills.map(skill => skill.name), card.skills.map(skill => skill.name));
  assert.ok(npc.id.startsWith('npc-'));

  const fallback = GE.genNpc('路人甲');
  assert.equal(fallback.name, '路人甲');
  assert.ok(Number.isFinite(fallback.strength));
  assert.equal(fallback.skills.length, 0);
});

test('server NPC members carry card hp into dungeon party so low damage does not kill them', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const npcSource = source.slice(source.indexOf('function getNpcCardByName'), source.indexOf('function npcPublicCard'));
  const npcContext = {
    DB: { getAiCompanionCardByName: () => null },
    AI_COMPANIONS: AI,
    GE,
    console,
  };
  vm.createContext(npcContext);
  vm.runInContext(npcSource, npcContext);
  const member = npcContext.makeNpcMember('阿甘左');
  assert.equal(member.hp, 175);
  assert.equal(member.max_hp, 175);

  const { buildDungeonParty } = createRoomRunner({ GE, GC: { ROOT_SKILLS: null } });
  const npcMember = buildDungeonParty({ party: [member] }, {})[0];
  assert.equal(npcMember.hp, 175);
  assert.equal(npcMember.max_hp, 175);

  const dg = { damage: 0, memberGains: { [npcMember.id]: { damage: 0 } }, party: [npcMember] };
  GE.applyStageEffects(dg, 'battle', npcMember, 0, 'bad', 10);
  assert.equal(npcMember.hp, 157);
  assert.equal(npcMember.isDead, undefined);
});

test('db seeds the twenty companion cards and supports save/reset round trips', () => {
  const seeded = DB.listAiCompanionCards();
  assert.equal(seeded.length, 20);
  const card = DB.getAiCompanionCardByName('赛丽亚·克鲁敏');
  assert.ok(card);
  assert.equal(card.data.bio.length > 0, true);

  const saved = DB.saveAiCompanionCard('sairiya', { gold: 777, bio: '测试改写小传。' });
  assert.equal(saved.data.gold, 777);
  assert.equal(saved.is_default, false);
  assert.equal(DB.getAiCompanionCardByName('赛丽亚·克鲁敏').data.gold, 777);

  const reset = DB.resetAiCompanionCard('sairiya');
  assert.equal(reset.is_default, true);
  assert.equal(reset.data.gold, AI.findCardByKey('sairiya').gold);
});
