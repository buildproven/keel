// REQ-OSS-5: the docs name every setting, and the repo carries the files an open-source user looks for.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('REQ-OSS-5 the README names every keel.json key, so no setting is undocumented', () => {
  const readme = read('README.md');
  const missing = Object.keys(DEFAULTS).filter((k) => !readme.includes(`\`${k}\``));
  assert.deepEqual(missing, [], 'keel.json keys the README does not name');
});

test('REQ-OSS-5 the repo carries the files an open-source user looks for', () => {
  for (const f of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', '.editorconfig'])
    assert.ok(read(f).trim().length > 0, `${f} is empty`);
  const version = JSON.parse(read('package.json')).version.replace(/\./g, '\\.');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${version}\\b`, 'm'), 'CHANGELOG has no entry for the package version');
});
