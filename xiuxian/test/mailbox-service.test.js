const assert = require('node:assert/strict');
const test = require('node:test');
const MB = require('../mailbox.js');

test('first mailbox sync seeds a welcome letter and schedules the next delivery', () => {
  const role = { bag: [] };
  const now = 1_000_000;
  const result = MB.settleMailbox(role, now, () => 0.5);
  assert.equal(result.changed, true);
  assert.equal(result.generated.length, 1);

  const view = MB.mailboxView(role);
  assert.equal(view.unreadCount, 1);
  assert.equal(view.letters.length, 1);
  assert.equal(view.letters[0].claimedAt, null);
  assert.ok(view.letters[0].items.length > 0);
  assert.ok(view.nextAt > now + MB.MIN_INTERVAL_MS);
  assert.ok(view.nextAt < now + MB.MAX_INTERVAL_MS);
});

test('mailbox letters settle again after the irregular interval has passed', () => {
  const role = { bag: [] };
  const now = 10_000_000;
  MB.settleMailbox(role, now, () => 0.5);
  role.mailbox.nextAt = now - 1;
  const second = MB.settleMailbox(role, now, () => 0.1);
  assert.equal(second.changed, true);
  assert.equal(second.generated.length, 1);
  assert.equal(MB.mailboxView(role).unreadCount, 2);
});

test('collecting a letter adds every attachment to the bag and marks it claimed once', () => {
  const role = { bag: [] };
  MB.settleMailbox(role, 2_000_000, () => 0.5);
  const letter = MB.mailboxView(role).letters[0];
  const before = role.bag.length;

  const claimed = MB.collectLetter(role, letter.id, 2_500_000);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.items.length, letter.items.length);
  assert.equal(role.bag.length, before + claimed.items.length);
  assert.equal(MB.mailboxView(role).unreadCount, 0);

  const duplicate = MB.collectLetter(role, letter.id, 2_600_000);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'already_claimed');
});

test('bag capacity is enforced before any attachment is stored', () => {
  const role = { bag: Array.from({ length: 100 }, (_, index) => ({ name: `占位${index}`, qty: 1, rarity: 'common' })) };
  MB.settleMailbox(role, 3_000_000, () => 0.5);
  const letter = MB.mailboxView(role).letters[0];
  const result = MB.collectLetter(role, letter.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bag_full');
  assert.equal(MB.mailboxView(role).unreadCount, 1);
});
