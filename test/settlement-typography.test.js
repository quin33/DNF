const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const styles = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

function cssBlocksFor(selector) {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').some(item => item.trim() === selector))
    .map(match => match[2]);
}

function assertDeclaration(selector, declaration) {
  const blocks = cssBlocksFor(selector);
  assert.ok(blocks.length > 0, `missing CSS rule for ${selector}`);
  assert.ok(blocks.some(block => new RegExp(`(?:^|;)\\s*${declaration}\\s*(?:;|$)`, 's').test(block)),
    `missing ${declaration} in ${selector}`);
}

test('settlement traits and attribute buffs match equipment text size and are bold', () => {
  assertDeclaration('.st2-item', 'font-size:\\s*13px');
  assertDeclaration('.st2-trait', 'font-size:\\s*13px');
  for (const selector of ['.st2m-loot', '.st2m-buff', '.msc-loot', '.msc-buff', '.msc-trait']) {
    assertDeclaration(selector, 'font-weight:\\s*700');
  }
  assertDeclaration('.msc-trait', 'font-size:\\s*14\\.5px');
});

test('settlement content applies bold typography across result sections', () => {
  for (const selector of ['.st2-hero', '.st2-stats', '.st2-sec', '.st2-story', '.st2-my-k', '.st2-my-v', '.st2-none', '.st2m-fate', '.st2m-gold', '.st2m-loot em', '.msc-fate']) {
    assertDeclaration(selector, 'font-weight:\\s*700');
  }
});
