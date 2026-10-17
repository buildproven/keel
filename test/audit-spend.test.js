import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { audit } from '../src/audit.js';
import { FIXED_SRC, REGRESSION_TEST, commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

test('REQ-GATE-24 keel audit records its review spend in the shared state dir, so the window estimate counts audits', () => {
  const state = tmp('keel-state-');
  process.env.KEEL_STATE_DIR = state;
  const { dir } = fixtureRepo();
  const merged = commit(dir, { ...REGRESSION_TEST, ...FIXED_SRC }, 'fix: add numbers (#1)');
  const prs = [{ number: 1, title: 'fix: add numbers', body: 'Closes BUI-7', headRefOid: 'h1', mergeCommit: { oid: merged } }];
  const statuses = [{ context: 'keel/gate', description: 'passed; review by c/c/high (fallback: exec/exec-codex/high quota)' }];
  const bin = tmp('keel-bin-');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'list') { console.log(${JSON.stringify(JSON.stringify(prs))}); process.exit(0); }
if (a[0] === 'api') { console.log(${JSON.stringify(JSON.stringify(statuses))}); process.exit(0); }
process.exit(1);
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const codex = {
    provider: 'exec',
    family: 'codex',
    model: 'exec-codex',
    effort: 'high',
    command: [
      'node',
      '-e',
      "require('fs').readFileSync(0); console.log('VERDICT: pass'); console.log(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }))",
    ],
  };
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    assert.equal(audit({ repo: dir, config: fixtureConfig({ tiers: [codex] }) })[0].outcome, 'pass');
  } finally {
    process.env.PATH = old;
  }
  const rows = readFileSync(join(state, 'review-spend.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => [r.family, r.tokens]),
    [['codex', 150]],
  );
});
