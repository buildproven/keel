import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { gate } from '../src/gate.js';
import { FIXED_SRC, commit, fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const bug = () => parseCard('# T-1: t\nkind: bug\nsize: S\n');
const redProof = (r) => r.results.find((x) => x.name === 'red-proof');

test('REQ-GATE-3 the red-proof overlay copies a binary test file byte for byte, so a test of the bytes alone does not pass red proof', () => {
  const { dir, base } = fixtureRepo(); // add() stays buggy: this change fixes nothing
  writeFileSync(join(dir, 'test/data.bin'), Buffer.from([0xff, 0x00]));
  commit(dir, {
    'test/vacuous.test.js':
      "import assert from 'node:assert';\nimport { readFileSync } from 'node:fs';\nassert.deepStrictEqual([...readFileSync(new URL('./data.bin', import.meta.url))], [255, 0]);\n",
  });
  const r = gate({ repo: dir, base, card: bug(), config: fixtureConfig() });
  assert.equal(r.pass, false);
  assert.deepEqual(
    redProof(r).problems.map((p) => p.rule),
    ['test-passes-on-base'],
  );
});

test('REQ-GATE-3 the red-proof overlay keeps an executable test file executable, so it fails on base as a real test failure', () => {
  const run = 'for f in test/*.sh; do "$f" || exit $?; done'; // a non-executable file exits 126, which red proof calls inconclusive
  const { dir, base } = fixtureRepo({
    'src/add.js': 'export const add = (a, b) => a - b;\n',
    'test/ok.sh': '#!/bin/sh\nexit 0\n',
  });
  chmodSync(join(dir, 'test/ok.sh'), 0o755);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '--amend', '--no-edit');
  const baseSha = g(dir, 'rev-parse', 'HEAD');
  assert.notEqual(baseSha, base);
  writeFileSync(
    join(dir, 'test/check.sh'),
    '#!/bin/sh\nnode -e "import(\'./src/add.js\').then((m) => process.exit(m.add(2, 3) === 5 ? 0 : 1))" || { echo "check.sh: add is wrong"; exit 1; }\n',
  );
  chmodSync(join(dir, 'test/check.sh'), 0o755);
  commit(dir, FIXED_SRC);
  const r = gate({ repo: dir, base: baseSha, card: bug(), config: fixtureConfig({ checks: { test: run }, testCommand: run }) });
  assert.equal(redProof(r).pass, true, JSON.stringify(redProof(r)));
});
