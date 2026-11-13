import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workflowWeakened } from '../src/workflow.js';

const BASE = `name: quality
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
const weakened = (step) => workflowWeakened(BASE, `${BASE}${step}`, ['npm test']);

test('REQ-GATE-43 an added step whose run is empty, blank, or null is not a run step', () => {
  const empty = [
    "      - run: ''\n",
    '      - run: ""\n',
    "      - run: '   '\n",
    '      - run: |\n',
    '      - run: >-\n',
    '      - run: |\n\n\n',
    '      - run: null\n',
    '      - run: Null\n',
    '      - run: NULL\n',
    '      - run: ~\n',
    '      - run: ~ # nothing\n',
    '      - name: x\n        run: null\n',
  ];
  for (const step of empty) assert.match(weakened(step) ?? '', /not a run step/, step);
});

test('REQ-GATE-43 an added step whose run has command text stays a run step', () => {
  for (const step of [
    '      - run: npm run audit\n',
    "      - run: 'npm run audit'\n",
    '      - run: |\n          npm run audit\n',
    '      - run: nullcheck\n',
    '      - run: ~/bin/audit\n',
  ])
    assert.equal(weakened(step), null, step);
});
