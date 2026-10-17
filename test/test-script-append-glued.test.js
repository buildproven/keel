import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { scriptsAppendOnly } from '../src/scan.js';

const pkg = (scripts) => `${JSON.stringify({ type: 'module', scripts }, null, 2)}\n`;
const check = (before, after) => scriptsAppendOnly(pkg(before), pkg(after), ['npm test'], DEFAULTS.testGlobs);

test('REQ-GATE-42 text glued to the last test file argument changes that argument, so it stays locked', () => {
  const base = { test: 'node --test test/a.test.js' };
  // `test/a.test.jstest/b.test.js` is one path that matches the test globs, but test/a.test.js no longer runs.
  assert.match(check(base, { test: 'node --test test/a.test.jstest/b.test.js' }) ?? '', /last argument/);
  assert.match(check(base, { test: 'node --test test/a.test.js.bak.test.js' }) ?? '', /last argument/);
  assert.equal(check(base, { test: 'node --test test/a.test.js test/b.test.js' }), null);
});
