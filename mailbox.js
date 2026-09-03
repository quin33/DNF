'use strict';

/* ============================================================
   mailbox.js · 公会邮箱福利（DNF）
   不定时间隔生成邮件；道具由玩家在建筑页面的邮箱领取。
   邮件保存在角色数据 role.mailbox 中，领取后才计入背包。
   ============================================================ */

const MIN_INTERVAL_MS = 40 * 60 * 1000;
const MAX_INTERVAL_MS = 100 * 60 * 1000;
const MAX_UNREAD = 6;
const BAG_CAPACITY = 100;

const WELCOME_LETTER = {
  sender: '赛丽亚·克鲁敏',
  title: '欢迎来到赫顿玛尔',
  body: '冒险家，公会替你备了一份补给。地下城里带足伤药总不会错，愿阿拉德的风一直站在你这边。',
  items: [
    { name: '生命药水', kind: 'pill', qty: 3, rarity: 'common', desc: '赫顿玛尔药铺常备的红色伤药，拧开瓶盖饮下，能愈合轻伤并稳住状态。' },
    { name: '魔力药水', kind: 'pill', qty: 2, rarity: 'common', desc: '蓝色魔力药水，施法消耗过大时饮下一瓶，精神与魔力都能迅速回升。' },
  ],
};

const GIFT_LETTERS = [
  {
    sender: '赫顿玛尔公会收发员',
    title: '例行补给',
    body: '公会仓库匀出两件常用耗材，已随邮差送达，收好再出发。',
    items: [
      { name: '生命药水', kind: 'pill', qty: 3, rarity: 'common', desc: '赫顿玛尔药铺常备的红色伤药，拧开瓶盖饮下，能愈合轻伤并稳住状态。' },
      { name: '魔力药水', kind: 'pill', qty: 2, rarity: 'common', desc: '蓝色魔力药水，施法消耗过大时饮下一瓶，精神与魔力都能迅速回升。' },
    ],
  },
  {
    sender: '卡坤',
    title: '铁匠铺留赠',
    body: '清点工坊时翻出这批边角料，送去铁匠铺或留着换钱都合适。',
    items: [
      { name: '硬化皮革', kind: 'material', qty: 3, rarity: 'common', desc: '经药水反复鞣制的厚实兽皮，适合打造皮甲护具，也可作为炼金辅料。' },
      { name: '无色晶核', kind: 'material', qty: 2, rarity: 'common', desc: '锻造与强化常用的基础材料，入炉后能稳定火温，让装备更易成形。' },
    ],
  },
  {
    sender: '辛达',
    title: '铁料寄售',
    body: '一袋秘银碎块压了许久箱底，正好送给你练手，熔炼成器或转手都可。',
    items: [
      { name: '秘银碎块', kind: 'material', qty: 2, rarity: 'advanced', desc: '泛着银光的矿石碎块，熔铸装备时能提升锋刃与韧性，铁匠铺常用辅料。' },
    ],
  },
  {
    sender: '林纳斯',
    title: '新手武器试用',
    body: '武器库里翻出一把压仓的练习剑，刃口还没开利，正适合新冒险家练手。',
    items: [
      { name: '练习用宽刃剑', kind: 'weapon', qty: 1, rarity: 'advanced', desc: '剑身厚重、重心沉稳的练习剑，未开利刃，适合在驻地熟悉剑路。' },
    ],
  },
  {
    sender: '公会仓库管事',
    title: '远征备用',
    body: '这双硬皮靴在仓库放了有些年头，鞋底仍结实，走地下城的长路正合适。',
    items: [
      { name: '硬皮靴', kind: 'armor', qty: 1, rarity: 'common', desc: '鞣革压制的短靴，鞋底钉了防滑铁片，适合地下城湿滑地形。' },
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
