import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { matchesAny } from '../src/scan.js';
import { commit, fixtureConfig, fixtureRepo } from './helpers.js';

const chore = parseCard('# T-1: test card\nkind: chore\nsize: S\n');
const rules = (receipt) => receipt.results.flatMap((r) => r.problems.map((p) => p.rule));

// Each file is read by a runner or tool the default checks may call; a new one redefines "passing".
const TOOL_FILES = [
  '.npmrc', // npm `script-shell=/usr/bin/true` turns every `npm test` into exit 0
  'web/.npmrc',
  '.yarnrc.yml',
  '.prettierignore', // `*` makes `prettier --check .` pass on anything
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.mjs',
  'GNUmakefile', // GNU make reads it before Makefile
  'taskfile.yml',
  '.pytest.ini', // pytest reads it before pyproject.toml
  '.eslintignore',
  'vite.config.ts', // vitest reads vite.config when there is no vitest.config
  'vitest.workspace.ts',
];

test('REQ-PROJ-4 default verificationPaths lock the runner and tool config files a check reads', () => {
  for (const path of TOOL_FILES) assert.ok(matchesAny(path, DEFAULTS.verificationPaths), path);
});

test('REQ-GATE-4 a new .npmrc fails the gate as a verification file', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { '.npmrc': 'script-shell=/usr/bin/true\n' });
  const r = gate({ repo: dir, base, card: chore, config: fixtureConfig() });
  assert.deepEqual(rules(r), ['verification-file-changed']);
});

test('REQ-GATE-4 a change to a package.json tool-config key (jest, mocha, eslintConfig, prettier) fails the gate', () => {
  for (const key of ['jest', 'mocha', 'eslintConfig', 'prettier']) {
    const { dir, base } = fixtureRepo();
    commit(dir, { 'package.json': JSON.stringify({ type: 'module', [key]: { x: 1 } }) + '\n' });
    const r = gate({ repo: dir, base, card: chore, config: fixtureConfig() });
    assert.deepEqual(rules(r), ['package-tool-config-changed'], key);
  }
});

test('REQ-GATE-4 a package.json change outside scripts and tool keys stays free', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'package.json': JSON.stringify({ type: 'module', dependencies: { a: '1' } }) + '\n' });
  const r = gate({ repo: dir, base, card: chore, config: fixtureConfig() });
  assert.deepEqual(rules(r), []);
});
