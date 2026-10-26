import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, test } from 'node:test';
import { routedCost } from '../src/value.js';
import { FIXTURE_TEST, commit, fixtureRepo, g, tmp } from './helpers.js';

const BIN = resolve('bin/keel.js');

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

/**
 * The MBP's nightly audit on 2026-10-26: origin/main has a valid keel.json, but the primary checkout is on a branch
 * that has none (lifescape), so policy read at HEAD crashed the audit.
 */
function staleCheckout() {
  const { dir } = fixtureRepo();
  const tier = { provider: 'exec', family: 'codex', model: 'm', effort: 'high', command: ['true'], priceInPerM: 1, priceOutPerM: 2 };
  const keelJson = JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST, tiers: [tier] });
  const main = commit(dir, { 'keel.json': keelJson }, 'chore: keel');
  g(dir, 'update-ref', 'refs/remotes/origin/main', main);
  g(dir, 'checkout', '-q', '-b', 'feature/old-work');
  g(dir, 'rm', '-q', 'keel.json');
  g(dir, 'commit', '-q', '-m', 'wip: before keel');
  return dir;
}

test('REQ-CFG-2 keel audit reads keel.json at the base, not at a primary checkout that has none', () => {
  const dir = staleCheckout();
  const bin = tmp('keel-bin-');
  writeFileSync(join(bin, 'gh'), "#!/bin/sh\necho '[]'\n");
  chmodSync(join(bin, 'gh'), 0o755);
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, 'audit', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  const byDefault = run();
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.match(byDefault.stderr, /audit: nothing to audit/);
  const named = run('--base', 'HEAD');
  assert.equal(named.status, 1, 'an explicit --base is the ref read');
  assert.match(named.stderr, /keel\.json: "checks" and "testCommand" are not set/);
});

test('REQ-CFG-2 report --value prices the top tier from keel.json at the base', () => {
  const dir = staleCheckout();
  const [line] = routedCost([{ repo: dir, cost: 1, usage: { in: 1_000_000, out: 0 } }]);
  assert.equal(line.reason, null);
  assert.equal(line.top, 1);
});
