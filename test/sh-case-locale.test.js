import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// A shell `case` range such as `[A-Z]*)` follows the collation order of the locale: under en_US.UTF-8 (macOS)
// `[A-Z]` also matches lower-case letters, so a test fixture passes in CI (C locale) and fails on the Mac.
// Use a character class (`[[:upper:]]`, `[[:lower:]]`) instead.
test('REQ-RUN-67 no shell case pattern in Keel uses a locale-dependent letter range', () => {
  const r = spawnSync(
    'git',
    ['grep', '-n', '-E', String.raw`in \[(A-Z|a-z)\]\*?\)`, '--', 'src', 'test', 'bin', ':!test/sh-case-locale.test.js'],
    { encoding: 'utf8' },
  );
  // git grep exits 1 when nothing matches; any other status is a broken check, not a pass.
  assert.ok(r.status === 0 || r.status === 1, `git grep failed: ${r.stderr}`);
  const out = r.stdout.trim();
  assert.equal(out, '', `use [[:upper:]] or [[:lower:]]:\n${out}`);
});
