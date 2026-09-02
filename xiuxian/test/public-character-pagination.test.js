const assert = require('node:assert/strict');
const test = require('node:test');

const DB = require('../db');

test('public character query returns only the requested filtered page', () => {
  const suffix = `page-${process.pid}-${Date.now()}`;
  const userIds = [];
  const characterIds = [];

  try {
    for (let index = 1; index <= 13; index++) {
      const userId = Number(DB.createUser(`pager-${index}-${suffix}`, 'hash', 'salt'));
      const name = `Pager ${index} ${suffix}`;
      const characterId = Number(DB.createCharacter(userId, name, {
        name,
        status: 'idle',
        level: index,
        strength: index,
        agility: index,
        intelligence: index,
        luck: index,
        gold: index,
      }));
      userIds.push(userId);
      characterIds.push(characterId);
    }

    const firstPage = DB.getPublicCharactersPage({
      page: 1,
      pageSize: 12,
      status: 'idle',
      sort: 'level',
      order: 'asc',
      q: suffix,
    });
    const secondPage = DB.getPublicCharactersPage({
      page: 2,
      pageSize: 12,
      status: 'idle',
      sort: 'level',
      order: 'asc',
      q: suffix,
    });

    assert.deepEqual(
      { total: firstPage.total, page: firstPage.page, pageSize: firstPage.pageSize, pages: firstPage.pages, count: firstPage.characters.length },
      { total: 13, page: 1, pageSize: 12, pages: 2, count: 12 },
    );
    assert.equal(firstPage.characters[0].name, `Pager 1 ${suffix}`);
    assert.deepEqual(
      { page: secondPage.page, count: secondPage.characters.length, name: secondPage.characters[0].name },
      { page: 2, count: 1, name: `Pager 13 ${suffix}` },
    );
  } finally {
    for (const characterId of characterIds) DB.db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
    for (const userId of userIds) DB.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
});

test('public character query pins the current role only at the first page without duplicates', () => {
  const suffix = `pinned-${process.pid}-${Date.now()}`;
  const userIds = [];
  const characterIds = [];

  try {
    for (let index = 1; index <= 13; index++) {
      const userId = Number(DB.createUser(`pinned-${index}-${suffix}`, 'hash', 'salt'));
      const name = `Pinned ${index} ${suffix}`;
      const characterId = Number(DB.createCharacter(userId, name, {
        name,
        status: 'idle',
        level: index,
      }));
      userIds.push(userId);
      characterIds.push(characterId);
    }

    const firstPage = DB.getPublicCharactersPage({
      page: 1,
      pageSize: 12,
      status: 'idle',
      sort: 'level',
      order: 'asc',
      q: suffix,
      pinnedCharacterId: characterIds[12],
    });
    const secondPage = DB.getPublicCharactersPage({
      page: 2,
      pageSize: 12,
      status: 'idle',
      sort: 'level',
      order: 'asc',
      q: suffix,
      pinnedCharacterId: characterIds[12],
    });

    assert.deepEqual(
      { total: firstPage.total, page: firstPage.page, pages: firstPage.pages, count: firstPage.characters.length, firstName: firstPage.characters[0].name },
      { total: 13, page: 1, pages: 2, count: 12, firstName: `Pinned 13 ${suffix}` },
    );
    assert.equal(firstPage.characters.some(character => character.id === characterIds[12]), true);
    assert.deepEqual(
      { page: secondPage.page, count: secondPage.characters.length, name: secondPage.characters[0].name },
      { page: 2, count: 1, name: `Pinned 12 ${suffix}` },
    );
    assert.equal(secondPage.characters.some(character => character.id === characterIds[12]), false);
  } finally {
    for (const characterId of characterIds) DB.db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
    for (const userId of userIds) DB.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
});
