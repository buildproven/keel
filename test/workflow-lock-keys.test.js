import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkflow, workflowWeakened } from '../src/workflow.js';

const COMMANDS = ['npm run lint', 'npm test'];
const weakened = (base, head) => workflowWeakened(base, head, COMMANDS);

const job = (lines, step = '      - run: npm test\n') => `name: quality
on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
${lines}    steps:
      - uses: actions/checkout@v4
${step}`;
const BASE = job('');
const ADDED = '      - run: npm run audit\n';

test('REQ-GATE-43 quoted keys name the same YAML key as plain ones, so they cannot hide a key the checks look for', () => {
  assert.equal(parseWorkflow('"env":\n  A: b\n').has('env'), true);
  assert.equal(parseWorkflow("'it''s': x\n").has("it's"), true);
  assert.throws(() => parseWorkflow('env: a\n"env": b\n'), /duplicate key env/);
  const hidden = {
    environment: '    "environment": production\n',
    permissions: "    'permissions':\n      contents: write\n",
    env: '    "env":\n      TOKEN: ${{ secrets.NPM_TOKEN }}\n',
  };
  for (const [key, lines] of Object.entries(hidden)) {
    const base = job(lines);
    assert.notEqual(weakened(base, `${base}${ADDED}`), null, `a quoted ${key} key is still seen`);
  }
  const top = `"env":\n  TOKEN: \${{ secrets.NPM_TOKEN }}\n${BASE}`;
  assert.match(weakened(top, `${top}${ADDED}`) ?? '', /expression/);
  assert.match(weakened(BASE, `${BASE}      - "uses": some/action@v1\n        run: x\n`) ?? '', /sets uses/);
});

test('REQ-GATE-43 an added step whose run is not a scalar is not a run step', () => {
  for (const run of ['run:', 'run: []', 'run: {}', 'run: [x]', 'run: {a: b}'])
    assert.match(weakened(BASE, `${BASE}      - ${run}\n`) ?? '', /not a run step/, run);
  assert.equal(weakened(BASE, `${BASE}      - run: |\n          npm run audit\n`), null);
});

test('REQ-GATE-43 the job must run a configured command as a command, not as text inside another command', () => {
  const notRun = [
    "      - run: echo 'npm test is disabled'\n",
    '      - run: echo npm test\n',
    '      - run: |\n          echo "skip"\n          # npm test\n',
    '      - run: npm testx\n',
    '      - run: >\n          echo\n          npm test\n',
  ];
  for (const step of notRun) {
    const base = job('', step);
    assert.match(weakened(base, `${base}${ADDED}`) ?? '', /runs no configured check or test command/, step);
  }
  const ran = [
    '      - run: npm test\n',
    '      - run: npm test -- --coverage\n',
    "      - run: 'npm test'\n",
    '      - run: |\n          npm ci\n          npm test\n',
  ];
  for (const step of ran) {
    const base = job('', step);
    assert.equal(weakened(base, `${base}${ADDED}`), null, step);
  }
});
