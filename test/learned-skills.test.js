const assert = require('node:assert/strict');
const test = require('node:test');

const GE = require('../game-engine');

test('learned skills are validated, deduplicated, and stored in the equipped slots first', () => {
  const role = {
    name: '沈青萝',
    skills: [{ name: '圣光十字', type: '物理技', desc: '以圣光画十字，正面扑倒魔物。' }],
    skillPool: [],
  };
  const learned = GE.parseLearnedSkills(JSON.stringify([
    { member: '沈青萝', name: '魔力弹', type: '魔法技', desc: '指尖凝出一颗刺目的魔力弹，折线扑向敌人。' },
    { member: '沈青萝', name: '魔力弹', type: '魔法技', desc: '重复条目。' },
    { member: '陌生人', name: '崩拳', type: '物理技', desc: '不应分配。' },
  ]));

  const granted = GE.applyLearnedSkills(role, learned.filter(skill => skill.member === role.name));

  assert.deepEqual(granted, [{ name: '魔力弹', type: '魔法技', desc: '指尖凝出一颗刺目的魔力弹，折线扑向敌人。', storage: 'equipped' }]);
  assert.deepEqual(role.skills.map(skill => skill.name), ['圣光十字', '魔力弹']);
  assert.deepEqual(role.skillPool, []);
});

test('learned skills enter the skill pool when all five equipped slots are full', () => {
  const role = {
    skills: Array.from({ length: 5 }, (_, index) => ({ name: `已有技能${index + 1}`, type: '物理技', desc: '已装备。' })),
    skillPool: [],
  };

  const granted = GE.applyLearnedSkills(role, [{ name: '寒冰之气', type: '魔法技', desc: '凝寒气护身，冻住近身的敌人。' }]);

  assert.equal(role.skills.length, 5);
  assert.deepEqual(role.skillPool, [{ name: '寒冰之气', type: '魔法技', desc: '凝寒气护身，冻住近身的敌人。' }]);
  assert.deepEqual(granted, [{ name: '寒冰之气', type: '魔法技', desc: '凝寒气护身，冻住近身的敌人。', storage: 'pool' }]);
});
