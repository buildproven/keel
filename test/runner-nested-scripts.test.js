import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptPaths } from '../src/scan.js';

const pkg = (scripts) => JSON.stringify({ scripts });

test('REQ-GATE-4 runner files are found through nested package.json scripts', () => {
  const p = pkg({ test: 'npm run unit', unit: 'pnpm run inner', inner: 'sh scripts/run-tests.sh' });
  assert.deepEqual(scriptPaths(p, ['npm test']), ['scripts/run-tests.sh']);
});

test('REQ-GATE-4 every script a command chains is followed, with its pre and post hooks', () => {
  const p = pkg({ lint: 'node scripts/lint.mjs', unit: 'yarn run deep', deep: 'node scripts/deep.mjs', predeep: 'sh scripts/pre.sh' });
  assert.deepEqual(scriptPaths(p, ['npm run lint && npm run unit']).sort(), ['scripts/deep.mjs', 'scripts/lint.mjs', 'scripts/pre.sh']);
});

test('REQ-GATE-4 a script cycle terminates', () => {
  const p = pkg({ a: 'npm run b', b: 'npm run a && node scripts/x.mjs' });
  assert.deepEqual(scriptPaths(p, ['npm run a']), ['scripts/x.mjs']);
});
