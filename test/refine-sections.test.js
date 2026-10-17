import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRefine } from '../src/refine.js';

const issue = { id: 'BUI-9', title: 'a is off', description: 'a is off', labels: ['Bug'], estimate: null };
const KEEL = '```keel\nkind: bug\nsize: S\npaths: src/**\n```';
const card = (requirements, acceptance, extra = '') =>
  `Context.\n\n## Requirements\n\n${requirements}\n\n## Acceptance\n\n${acceptance}\n\n${extra}${KEEL}`;
const SHALL = '- REQ-A-1: When a runs, the tool shall print b.';
const BOX = '- [ ] A new test of a.';

test('REQ-LINEAR-33 a refined card needs its shall line under Requirements and an open checkbox under Acceptance', () => {
  assert.equal(parseRefine(`CARD\n${card(SHALL, BOX)}`, issue).kind, 'card');

  const emptyRequirements = parseRefine(`CARD\n${card('', BOX, `## Notes\n\nThe tool shall print b.\n\n`)}`, issue);
  assert.equal(emptyRequirements.kind, 'unparsed');
  assert.match(emptyRequirements.why, /no "## Requirements" with a "shall" line/);

  const shallInContext = parseRefine(`CARD\nThe tool shall print b.\n\n${card('- print b', BOX)}`, issue);
  assert.equal(shallInContext.kind, 'unparsed');
  assert.match(shallInContext.why, /no "## Requirements" with a "shall" line/);

  const emptyAcceptance = parseRefine(`CARD\n${card(`${SHALL}\n${BOX}`, '')}`, issue);
  assert.equal(emptyAcceptance.kind, 'unparsed');
  assert.match(emptyAcceptance.why, /no "## Acceptance" with a checkbox/);

  const checked = parseRefine(`CARD\n${card(SHALL, '- [x] A new test of a.')}`, issue);
  assert.equal(checked.kind, 'unparsed');
  assert.match(checked.why, /no "## Acceptance" with a checkbox/);

  const split = parseRefine(`SPLIT\nTITLE: one\n${card(SHALL, BOX)}\nTITLE: two\n${card('', BOX, `## Notes\n\n${SHALL}\n\n`)}`, issue);
  assert.equal(split.kind, 'unparsed');
  assert.match(split.why, /split card 2 is not buildable: no "## Requirements"/);
});
