import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderText, parseCard } from '../src/config.js';

const card = (header) => `# BUI-1: t\nkind: bug\nsize: M\n${header}\n\n## Requirements\n- REQ-X-1: x.\n`;

test('REQ-GATE-10 an indented heldOut header is the held-out path and is removed from the builder text', () => {
  const c = parseCard(card('  heldOut: /secret/held'));
  assert.equal(c.heldOut, '/secret/held');
  assert.doesNotMatch(builderText(c), /secret/);
});

test('REQ-CARD-2 a header key given twice rejects the card, so a decoy heldOut cannot hide the real one', () => {
  assert.throws(() => parseCard(card('heldOut: /decoy\nheldOut: /secret/held')), /header "heldOut" is given twice/);
  assert.throws(() => parseCard('# BUI-1: t\nkind: bug\nsize: S\nsize: M\n'), /header "size" is given twice/);
});

test('REQ-GATE-10 a heldOut header behind any whitespace trim() removes is also removed from the builder text', () => {
  for (const space of ['\u00a0', '\v', '\f', '\ufeff', '\u3000', '\t']) {
    const c = parseCard(card(`${space}heldOut: /secret/held`));
    assert.equal(c.heldOut, '/secret/held', JSON.stringify(space));
    assert.doesNotMatch(builderText(c), /secret/, JSON.stringify(space));
  }
});
