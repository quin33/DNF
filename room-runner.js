'use strict';

function createRoomRunner(dependencies) {
  const {
    GE,
    GC,
    aiDecideSetup,
    beginRun,
    broadcastAll,
    broadcastStarting,
    scheduleTick,
    runningSnapshot,
    onFailure,
    console: logger = console,
  } = dependencies || {};

  function buildDungeonParty(room, hostCharacter) {
    return (room.party || []).map(member => member.isNpc
      ? {
          ...(member.char || {}),
          ...member,
          id: member.id || member.name,
          name: member.name,
          isNpc: true,
          is_mine: false,
          ws: null,
        }
      : {
          ...(GC.ROOT_SKILLS ? hostCharacter : {}),
          ...(member.char || {}),
          id: member.uid,
          name: member.name,
          is_mine: true,
          ws: member.ws,
          uid: member.uid,
          charId: member.charId,
          isNpc: false,
        });
  }

  async function startRoomRun(room, hostCharacter) {
    if (!room || room.status !== 'waiting') return null;
    room.status = 'starting';
    if (typeof broadcastStarting === 'function') broadcastStarting(room);
    const base = (room.choice && GE.DUNGEON_POOL.find(dungeon => dungeon.name === room.choice))
      || GE.pickDungeon(hostCharacter);
    let setup;
    try {
      setup = await aiDecideSetup({ dungeon: base, role: hostCharacter });
    } catch (error) {
      logger.warn('[ai/setup] setup failed; using safe defaults:', String(error && error.message || error).slice(0, 160));
      setup = { isHidden: false, specialEvent: false, breakthrough: false, enemies: [] };
    }

    const dungeon = GE.createDg(hostCharacter, { base, setup });
    dungeon.party = buildDungeonParty(room, hostCharacter);
    dungeon.entryHp = {};
    dungeon.party.forEach(member => {
      const entryKey = member.uid || member.id;
      dungeon.entryHp[entryKey] = {
        hp: Math.max(0, Number(member.hp) || 0),
        max_hp: Math.max(1, Number(member.max_hp) || 100),
      };
    });
    dungeon.party.forEach(member => {
      const id = member.uid || member.id;
      dungeon.memberGains[id] = { acts: 0, rolls: [], damage: 0, loot: [], crits: 0, fumbles: 0 };
    });
    dungeon.focusPlan = dungeon.flowMode === 'dynamic' ? [] : GE.buildNarrativeFocusPlan(dungeon);
    room.dg = dungeon;

    try {
      await beginRun({ room, dungeon, snapshot: runningSnapshot(room) });
    } catch (error) {
      room.dg = null;
      room.status = 'waiting';
      if (onFailure) await onFailure(room, error, { beforeStart: true });
      return null;
    }

    dungeon.status = 'running';
    room.status = 'running';
    broadcastAll({ type: 'dungeon_started', runId: dungeon.id, snapshot: runningSnapshot(room) });
    scheduleTick(room);
    return dungeon;
  }

  return { buildDungeonParty, startRoomRun };
}

module.exports = { createRoomRunner };
