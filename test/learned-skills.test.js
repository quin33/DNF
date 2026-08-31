const assert = require('node:assert/strict');
const test = require('node:test');

const GE = require('../game-engine');

test('learned skills are validated, deduplicated, and stored in the equipped slots first', () => {
  const role = {
    name: '沈青萝',
    skills: [{ name: '青木养气诀', type: '功法', tier: '黄阶', desc: '旧有功法。' }],
    skillPool: [],
  };
  const learned = GE.parseLearnedSkills(JSON.stringify([
    { member: '沈青萝', name: '落叶飞花术', type: '术法', tier: '玄阶', desc: '以灵气卷起飞叶，化作锋芒袭敌。' },
    { member: '沈青萝', name: '落叶飞花术', type: '术法', tier: '玄阶', desc: '重复条目。' },
    { member: '陌生人', name: '无主秘术', type: '术法', tier: '黄阶', desc: '不应分配。' },
  ]));

  const granted = GE.applyLearnedSkills(role, learned.filter(skill => skill.member === role.name));

  assert.deepEqual(granted, [{ name: '落叶飞花术', type: '术法', tier: '玄阶', desc: '以灵气卷起飞叶，化作锋芒袭敌。', storage: 'equipped' }]);
  assert.deepEqual(role.skills.map(skill => skill.name), ['青木养气诀', '落叶飞花术']);
  assert.deepEqual(role.skillPool, []);
});

test('learned skills enter the skill pool when all five equipped slots are full', () => {
  const role = {
    skills: Array.from({ length: 5 }, (_, index) => ({ name: `已有技能${index + 1}`, type: '功法', tier: '黄阶', desc: '已装备。' })),
    skillPool: [],
  };

  const granted = GE.applyLearnedSkills(role, [{ name: '玄冰护体术', type: '术法', tier: '地阶', desc: '寒气化甲，护持周身。' }]);

  assert.equal(role.skills.length, 5);
  assert.deepEqual(role.skillPool, [{ name: '玄冰护体术', type: '术法', tier: '地阶', desc: '寒气化甲，护持周身。' }]);
  assert.deepEqual(granted, [{ name: '玄冰护体术', type: '术法', tier: '地阶', desc: '寒气化甲，护持周身。', storage: 'pool' }]);
});
