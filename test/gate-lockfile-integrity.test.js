import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate, repairLines } from '../src/gate.js';
import { BUGGY, commit, fixtureConfig, fixtureRepo } from './helpers.js';

const card = parseCard('# T-1: lockfile integrity\nkind: chore\nsize: S\n');
const registryEntry = (extra = {}) => ({
  version: '1.2.3',
  resolved: 'https://registry.example.test/pkg/-/pkg-1.2.3.tgz',
  integrity: 'sha512-example',
  ...extra,
});
const lockfile = (packages) => `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }, null, 2)}\n`;
const integrityProblems = (receipt) => receipt.results.flatMap((result) => result.problems).filter((p) => p.rule === 'lockfile-integrity');

test('REQ-GATE-54 a lockfile diff that drops integrity fails lockfile-integrity', () => {
  for (const field of ['integrity', 'resolved']) {
    const path = `node_modules/missing-${field}`;
    const complete = lockfile({ '': { name: 'fixture' }, [path]: registryEntry() });
    const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
    const stripped = registryEntry();
    delete stripped[field];
    commit(dir, { 'notes.txt': `${field}\n`, 'package-lock.json': lockfile({ '': { name: 'fixture' }, [path]: stripped }) });

    const failed = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(failed.pass, false);
    assert.deepEqual(integrityProblems(failed), [{ rule: 'lockfile-integrity', path }]);
    assert.deepEqual(
      repairLines(
        failed.results.find((result) => result.name === 'lockfile-integrity'),
        'origin/main',
      ),
      [
        'Fix: restore package-lock.json with `git checkout origin/main -- package-lock.json`, then run `npm install --package-lock-only`; do not delete and regenerate the lockfile.',
      ],
    );

    commit(dir, { 'package-lock.json': complete });
    const restored = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(restored.pass, true, JSON.stringify(restored.results, null, 2));
  }
});

test('REQ-GATE-54 lockfile-integrity names every stripped package path', () => {
  const integrityPath = 'node_modules/missing-integrity';
  const resolvedPath = 'node_modules/missing-resolved';
  const complete = lockfile({
    '': { name: 'fixture' },
    [integrityPath]: registryEntry(),
    [resolvedPath]: registryEntry(),
  });
  const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
  const noIntegrity = registryEntry();
  const noResolved = registryEntry();
  delete noIntegrity.integrity;
  noResolved.resolved = '';
  commit(dir, {
    'package-lock.json': lockfile({
      '': { name: 'fixture' },
      [integrityPath]: noIntegrity,
      [resolvedPath]: noResolved,
    }),
  });

  const receipt = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.deepEqual(integrityProblems(receipt), [
    { rule: 'lockfile-integrity', path: integrityPath },
    { rule: 'lockfile-integrity', path: resolvedPath },
  ]);
});

test('REQ-GATE-54 bundled, linked, and git entries need no integrity', () => {
  const complete = {
    '': { name: 'fixture' },
    'node_modules/bundled': registryEntry({ inBundle: true }),
    'node_modules/linked': registryEntry({ link: true }),
    'node_modules/file-dependency': registryEntry({ version: 'file:../file-dependency', resolved: 'file:../file-dependency' }),
    'node_modules/git-dependency': registryEntry({ resolved: 'git+https://github.com/example/dependency.git#abcdef' }),
  };
  const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': lockfile(complete) });
  const stripped = Object.fromEntries(
    Object.entries(complete).map(([path, entry]) => {
      const copy = { ...entry };
      delete copy.integrity;
      delete copy.resolved;
      return [path, copy];
    }),
  );
  commit(dir, { 'package-lock.json': lockfile(stripped) });

  const receipt = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
});

test('REQ-GATE-54 a repo without package-lock.json skips lockfile integrity', () => {
  const { dir, base } = fixtureRepo();
  commit(dir, { 'notes.txt': 'no lockfile\n' });

  const receipt = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(receipt.pass, true, JSON.stringify(receipt.results, null, 2));
  assert.deepEqual(integrityProblems(receipt), []);
  assert.equal(
    receipt.results.some((result) => result.name === 'lockfile-integrity'),
    false,
  );
});

test('REQ-GATE-54 legacy lockfiles and new entries do not create an integrity drop', () => {
  const legacy = `${JSON.stringify({ name: 'fixture', lockfileVersion: 1, dependencies: { pkg: { version: '1.2.3' } } }, null, 2)}\n`;
  const { dir: legacyDir, base: legacyBase } = fixtureRepo({ ...BUGGY, 'package-lock.json': legacy });
  commit(legacyDir, { 'notes.txt': 'legacy\n', 'package-lock.json': legacy.replace('1.2.3', '1.2.4') });
  const legacyReceipt = gate({ repo: legacyDir, base: legacyBase, card, config: fixtureConfig() });
  assert.equal(legacyReceipt.pass, true, JSON.stringify(legacyReceipt.results, null, 2));

  const baseLock = lockfile({ '': { name: 'fixture' } });
  const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': baseLock });
  commit(dir, {
    'package-lock.json': lockfile({ '': { name: 'fixture' }, 'node_modules/new-package': { version: '1.2.3' } }),
  });
  const newEntryReceipt = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(newEntryReceipt.pass, true, JSON.stringify(newEntryReceipt.results, null, 2));
});

test('REQ-GATE-54 malformed candidate lockfile fails visibly', () => {
  const complete = lockfile({ '': { name: 'fixture' }, 'node_modules/pkg': registryEntry() });
  const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
  commit(dir, { 'package-lock.json': '{not json\n' });

  const receipt = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(receipt.pass, false);
  assert.deepEqual(integrityProblems(receipt), [
    { rule: 'lockfile-integrity', path: 'package-lock.json', detail: 'candidate package-lock.json is not valid JSON' },
  ]);

  const { dir: repairDir, base: repairBase } = fixtureRepo({ ...BUGGY, 'package-lock.json': '{not json\n' });
  commit(repairDir, { 'package-lock.json': complete });
  const repaired = gate({ repo: repairDir, base: repairBase, card, config: fixtureConfig() });
  assert.equal(repaired.pass, true, JSON.stringify(repaired.results, null, 2));
});

test('REQ-GATE-54 a structurally malformed candidate lockfile fails lockfile-integrity', () => {
  const complete = lockfile({ '': { name: 'fixture' }, 'node_modules/pkg': registryEntry() });
  const noMap = 'candidate package-lock.json has no packages map';
  const noVersion = 'candidate package-lock.json has no valid lockfileVersion (1, 2, or 3)';
  const cases = [
    ['packages missing', { name: 'fixture', lockfileVersion: 3 }, noMap],
    ['packages scalar', { name: 'fixture', lockfileVersion: 3, packages: 'oops' }, noMap],
    ['packages array', { name: 'fixture', lockfileVersion: 3, packages: [] }, noMap],
    ['packages null', { name: 'fixture', lockfileVersion: 2, packages: null }, noMap],
    ['version missing', { name: 'fixture', packages: {} }, noVersion],
    ['version null', { name: 'fixture', lockfileVersion: null, packages: {} }, noVersion],
    ['version string', { name: 'fixture', lockfileVersion: '3', packages: {} }, noVersion],
    ['version unknown', { name: 'fixture', lockfileVersion: 9, packages: {} }, noVersion],
    ['root array', [], 'candidate package-lock.json is not an object'],
    [
      'entry scalar',
      { name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/pkg': 'x' } },
      'candidate package-lock.json entry "node_modules/pkg" is not an object',
    ],
    [
      'entry null',
      { name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/pkg': null } },
      'candidate package-lock.json entry "node_modules/pkg" is not an object',
    ],
  ];
  for (const [label, body, detail] of cases) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
    commit(dir, { 'notes.txt': `${label}\n`, 'package-lock.json': `${JSON.stringify(body)}\n` });
    const failed = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(failed.pass, false, label);
    assert.deepEqual(integrityProblems(failed), [{ rule: 'lockfile-integrity', path: 'package-lock.json', detail }], label);
  }
});

test('REQ-GATE-54 a v1 lockfile without a packages map is valid', () => {
  const v1 = `${JSON.stringify({ name: 'fixture', lockfileVersion: 1, dependencies: {} })}\n`;
  const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': v1 });
  commit(dir, { 'notes.txt': 'v1\n', 'package-lock.json': v1.replace('{}', '{"a":{"version":"1.0.0"}}') });
  assert.deepEqual(integrityProblems(gate({ repo: dir, base, card, config: fixtureConfig() })), []);
});

test('REQ-GATE-54 an entry with non-string fields is malformed; an emptied entry is an integrity drop', () => {
  const path = 'node_modules/pkg';
  const complete = lockfile({ '': { name: 'fixture' }, [path]: registryEntry() });
  const lockPath = 'package-lock.json';
  const cases = [
    [
      'numeric version, intact fields',
      registryEntry({ version: 1 }),
      { rule: 'lockfile-integrity', path: lockPath, detail: `candidate package-lock.json entry "${path}" has a non-string version` },
    ],
    [
      'numeric version only',
      { version: 1 },
      { rule: 'lockfile-integrity', path: lockPath, detail: `candidate package-lock.json entry "${path}" has a non-string version` },
    ],
    [
      'non-string integrity',
      registryEntry({ integrity: 5 }),
      { rule: 'lockfile-integrity', path: lockPath, detail: `candidate package-lock.json entry "${path}" has a non-string integrity` },
    ],
    ['emptied entry', {}, { rule: 'lockfile-integrity', path }],
  ];
  for (const [label, entry, problem] of cases) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
    commit(dir, { 'notes.txt': `${label}\n`, 'package-lock.json': lockfile({ '': { name: 'fixture' }, [path]: entry }) });
    const failed = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(failed.pass, false, label);
    assert.deepEqual(integrityProblems(failed), [problem], label);
  }
});

test('REQ-GATE-54 only the named non-registry sources skip the check; invented prefixes do not', () => {
  const path = 'node_modules/pkg';
  const complete = lockfile({ '': { name: 'fixture' }, [path]: registryEntry() });
  for (const resolved of ['link:../pkg', 'git+evil:example/pkg', 'git+anything://host/pkg']) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
    commit(dir, {
      'notes.txt': `${resolved}\n`,
      'package-lock.json': lockfile({ '': { name: 'fixture' }, [path]: { version: '1.2.3', resolved } }),
    });
    const failed = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(failed.pass, false, resolved);
    assert.deepEqual(integrityProblems(failed), [{ rule: 'lockfile-integrity', path }], resolved);
  }
  for (const resolved of ['git+https://github.com/example/pkg.git#abc', 'git+ssh://git@github.com/example/pkg.git', 'github:example/pkg']) {
    const { dir, base } = fixtureRepo({ ...BUGGY, 'package-lock.json': complete });
    commit(dir, {
      'notes.txt': `${resolved}\n`,
      'package-lock.json': lockfile({ '': { name: 'fixture' }, [path]: { version: '1.2.3', resolved } }),
    });
    assert.deepEqual(integrityProblems(gate({ repo: dir, base, card, config: fixtureConfig() })), [], resolved);
  }
});
