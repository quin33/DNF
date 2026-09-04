const assert = require('node:assert');
const { test } = require('node:test');
const GE = require('../game-engine.js');

test('AI返回success=true时应消耗药水，即使正文未明确写出动词', () => {
    const dg = {
      party: [
        {
          id: 'p1',
          uid: 'u1',
          name: '甲',
          hp: 50,
          max_hp: 100,
          bag: [{ name: '生命药水', kind: 'pill', qty: 3 }],
        },
      ],
      consumed: [],
    };

    const actor = dg.party[0];
    const itemUse = {
      success: true,
      item: {
        name: '生命药水',
        kind: 'pill',
        ownerId: 'u1',
        userId: 'u1',
      },
    };

    // 消耗前：3瓶
    assert.equal(actor.bag[0].qty, 3);

    // 调用消耗函数
    const result = GE.consumeItemUse(dg, itemUse, { explicitUse: true, actor });

    // 验证消耗成功
    assert.equal(result.consumed, true);
    assert.equal(actor.bag[0].qty, 2); // 消耗后：2瓶
    assert.equal(dg.consumed.length, 1);
    assert.equal(dg.consumed[0].name, '生命药水');
});

test('消耗到0时应从背包移除', () => {
    const dg = {
      party: [
        {
          id: 'p1',
          uid: 'u1',
          name: '甲',
          bag: [{ name: '生命药水', kind: 'pill', qty: 1 }],
        },
      ],
      consumed: [],
    };

    const actor = dg.party[0];
    const itemUse = {
      success: true,
      item: { name: '生命药水', kind: 'pill', ownerId: 'u1' },
    };

    GE.consumeItemUse(dg, itemUse, { explicitUse: true, actor });

    // 验证药水已从背包移除
    assert.equal(actor.bag.length, 0);
});

test('success=false时不应消耗', () => {
    const dg = {
      party: [
        {
          id: 'p1',
          uid: 'u1',
          name: '甲',
          bag: [{ name: '生命药水', kind: 'pill', qty: 3 }],
        },
      ],
      consumed: [],
    };

    const actor = dg.party[0];
    const itemUse = {
      success: false, // 失败
      item: { name: '生命药水', kind: 'pill', ownerId: 'u1' },
    };

    const result = GE.consumeItemUse(dg, itemUse, { explicitUse: true, actor });

    // 验证未消耗
    assert.equal(result.consumed, false);
    assert.equal(actor.bag[0].qty, 3);
});
