'use strict';

/* ============================================================
   mailbox.js · 传讯邮箱福利（问道仙坊）
   不定时间隔生成邮件；道具由玩家在建筑页面的邮箱领取。
   邮件保存在角色数据 role.mailbox 中，领取后才计入背包。
   ============================================================ */

const MIN_INTERVAL_MS = 40 * 60 * 1000;
const MAX_INTERVAL_MS = 100 * 60 * 1000;
const MAX_UNREAD = 6;
const BAG_CAPACITY = 100;

const WELCOME_LETTER = {
  sender: '白芷',
  title: '坊市问候',
  body: '新道友初到仙坊，药堂替你备了一份小礼。灵墟之中多带几粒丹药，总比临时抓药稳妥。',
  items: [
    { name: '聚气丹', kind: 'pill', qty: 3, rarity: 'common', desc: '低阶丹药，服之可凝神聚气，聊胜于无，是练气期最常见的补给。' },
    { name: '回灵丹', kind: 'pill', qty: 2, rarity: 'common', desc: '能快速补益灵力的丹药，施法消耗过重时服下，可稳住丹田气机。' },
  ],
};

const GIFT_LETTERS = [
  {
    sender: '坊市执事',
    title: '例行补给',
    body: '坊市库房匀出两味常用丹药，已托信鹤送达，收好以备闯荡灵墟。',
    items: [
      { name: '聚气丹', kind: 'pill', qty: 3, rarity: 'common', desc: '低阶丹药，服之可凝神聚气，聊胜于无，是练气期最常见的补给。' },
      { name: '回灵丹', kind: 'pill', qty: 2, rarity: 'common', desc: '能快速补益灵力的丹药，施法消耗过重时服下，可稳住丹田气机。' },
    ],
  },
  {
    sender: '药堂采药使',
    title: '灵植寄赠',
    body: '灵植园清点出一批新采的辅材，炼丹或易物都派得上用场。',
    items: [
      { name: '百草灵叶', kind: 'material', qty: 3, rarity: 'common', desc: '常年受灵气温养的草叶，炼丹时能中和药性，也可入药温养经脉。' },
      { name: '灵泉晶', kind: 'material', qty: 2, rarity: 'common', desc: '灵泉畔凝成的晶石，炼器时投入炉中可提升法器灵气流转。' },
    ],
  },
  {
    sender: '炼器堂执事',
    title: '炼器辅料',
    body: '炉边余下一把精铁碎片，成色尚可，留给道友熟悉炼器之道。',
    items: [
      { name: '精铁碎片', kind: 'material', qty: 3, rarity: 'common', desc: '锤炼法器时削落的精铁碎块，收集后可重新熔炼，是炼器常用辅料。' },
    ],
  },
  {
    sender: '剑阁大师兄',
    title: '旧剑相赠',
    body: '剑阁换下的旧青锋剑，虽非神兵，胜在手感趁手，赠予初入仙途的道友。',
    items: [
      { name: '旧青锋剑', kind: 'weapon', qty: 1, rarity: 'rare', desc: '剑身泛着青光的旧剑，锋刃尚利，适合修士近身斗法时施展剑术。' },
    ],
  },
  {
    sender: '杂务堂执事',
    title: '储物囊备件',
    body: '库房翻出一只旧兽皮囊，针脚虽粗，装些杂物倒还牢靠。',
    items: [
      { name: '旧兽皮囊', kind: 'tool', qty: 1, rarity: 'common', desc: '妖兽皮缝制的旧储物袋，容量不大，盛放丹药、材料与零碎物件足够。' },
    ],
  },
];

function mailboxState(role) {
  if (!role || typeof role !== 'object') throw new Error('角色数据缺失');
  if (!role.mailbox || typeof role.mailbox !== 'object') role.mailbox = {};
  if (!Array.isArray(role.mailbox.letters)) role.mailbox.letters = [];
  return role.mailbox;
}

function makeLetter(template, now, seq, randomFn) {
  const suffix = Math.floor(randomFn() * 0xffffff).toString(36).padStart(4, '0');
  return {
    id: `mail-${now}-${seq}-${suffix}`,
    sender: template.sender,
    title: template.title,
    body: template.body,
    items: (template.items || []).map(item => ({ ...item })),
    createdAt: now,
    claimedAt: null,
  };
}

function randomDelay(randomFn) {
  return Math.round(MIN_INTERVAL_MS + randomFn() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

function unreadCount(state) {
  return state.letters.filter(letter => !letter.claimedAt).length;
}

function settleMailbox(role, now = Date.now(), randomFn = Math.random) {
  const state = mailboxState(role);
  if (!state.seededAt) {
    const letter = makeLetter(WELCOME_LETTER, now, state.letters.length, randomFn);
    state.letters.push(letter);
    state.seededAt = now;
    state.nextAt = now + randomDelay(randomFn);
    return { changed: true, generated: [letter.id] };
  }
  const nextAt = Number(state.nextAt);
  if (Number.isFinite(nextAt) && now < nextAt) return { changed: false, generated: [] };
  if (unreadCount(state) >= MAX_UNREAD) return { changed: false, generated: [] };
  const template = GIFT_LETTERS[Math.floor(randomFn() * GIFT_LETTERS.length)];
  const letter = makeLetter(template, now, state.letters.length, randomFn);
  state.letters.push(letter);
  state.nextAt = now + randomDelay(randomFn);
  return { changed: true, generated: [letter.id] };
}

function mailboxView(role) {
  const state = mailboxState(role);
  const letters = state.letters
    .slice()
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 60);
  return {
    letters,
    unreadCount: unreadCount(state),
    nextAt: Number.isFinite(Number(state.nextAt)) ? Number(state.nextAt) : 0,
  };
}

function normalizeAttachment(item) {
  const qty = Number(item.qty);
  return {
    name: String(item.name || '未知道具').slice(0, 24),
    desc: String(item.desc || '').slice(0, 200),
    kind: String(item.kind || '杂物').slice(0, 16),
    qty: Number.isSafeInteger(qty) && qty > 0 ? Math.min(999, qty) : 1,
    rarity: String(item.rarity || 'common').slice(0, 16),
  };
}

function collectLetter(role, mailId, now = Date.now()) {
  const state = mailboxState(role);
  const letter = state.letters.find(entry => entry.id === String(mailId || ''));
  if (!letter) return { ok: false, error: '邮件不存在或已过期', code: 'not_found' };
  if (letter.claimedAt) return { ok: false, error: '该邮件已领取', code: 'already_claimed' };
  const items = (letter.items || []).map(normalizeAttachment);
  if (!items.length) return { ok: false, error: '该邮件没有可领取的附件', code: 'empty' };
  if (!Array.isArray(role.bag)) role.bag = [];
  const newNames = items.filter(item => !role.bag.some(existing => existing && existing.name === item.name));
  if (role.bag.length + newNames.length > BAG_CAPACITY) {
    return { ok: false, error: '背包已满，请整理后再领取邮件', code: 'bag_full' };
  }
  for (const item of items) {
    const existing = role.bag.find(entry => entry && entry.name === item.name);
    if (existing) {
      existing.qty = Number(existing.qty || 1) + item.qty;
      existing.desc = item.desc || existing.desc;
      existing.kind = item.kind || existing.kind;
      existing.rarity = item.rarity || existing.rarity;
    } else {
      role.bag.push({ ...item });
    }
  }
  letter.claimedAt = now;
  return { ok: true, items, mailId: letter.id };
}

module.exports = {
  settleMailbox,
  mailboxView,
  collectLetter,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MAX_UNREAD,
};
