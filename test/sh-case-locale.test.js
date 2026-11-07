import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Shell fixtures in the tests (a `case "$s" in [A-Z]*)` commit-msg hook, REQ-RUN-67) follow the locale's collation:
// under en_US.UTF-8 (macOS) `[A-Z]` also matches lower case, so the suite passed in CI and failed on the Mac.
// Both test commands pin the C locale, so every machine runs the suite the same way.
test('REQ-RUN-67 the full-suite and per-file test commands run under the C locale', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const keel = JSON.parse(readFileSync(new URL('../keel.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /^LC_ALL=C /);
  assert.match(keel.testFilesCommand, /^LC_ALL=C /);
});
