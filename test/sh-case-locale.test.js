import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// The REQ-RUN-67 fixtures are sh hooks whose `[A-Z]` range follows the locale's collation. Run that test file under
// a UTF-8 locale, as on a Mac, so a fixture that depends on the caller's locale fails here, not only on one machine.
test('REQ-RUN-67 the commit-subject tests pass under a UTF-8 locale', () => {
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_COLLATE: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
  delete env.LC_ALL;
  delete env.NODE_TEST_CONTEXT; // else the child reports to this runner and exits 0
  const r = spawnSync(process.execPath, ['--test', 'test/run-commit-subject.test.js'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.slice(-2000));
});
