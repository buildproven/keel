import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCard } from '../src/config.js';
import { run } from '../src/run.js';
import { fixtureConfig, fixtureRepo, g, tmp } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fake-worker.js', import.meta.url));
const tier = (mode) => ({ provider: 'exec', model: `exec-${mode}`, effort: 'low', command: ['node', FAKE, mode] });

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
  process.env.KEEL_FAKE_LOG = join(tmp('keel-log-'), 'calls.jsonl');
});

/** Run a card with a fake `gh` on PATH and return the PR body it was given. */
function prBodyOf(cardText, config) {
  const { dir } = fixtureRepo();
  const remote = tmp('keel-remote-');
  g(remote, 'init', '-q', '--bare');
  g(dir, 'remote', 'add', 'origin', remote);
  const bin = tmp('keel-bin-');
  const argvLog = join(bin, 'gh-argv.json');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node\nif (process.argv[2] === 'pr') require('fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('https://example.test/pr/1');\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const r = run({ repo: dir, card: parseCard(cardText), config, pr: true });
    assert.equal(r.pass, true, r.failure);
    assert.equal(r.pr.ok, true, r.pr.out);
  } finally {
    process.env.PATH = oldPath;
  }
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  return argv[argv.indexOf('--body') + 1];
}

test('REQ-RUN-16 the PR body carries the gate evidence: stages, red-proof files, tier, model, attempts, and run cost', () => {
  const body = prBodyOf(
    '# BUI-77: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n',
    fixtureConfig({ tiers: [tier('fix-only'), tier('good')] }),
  );
  assert.match(body, /\| red-proof \| pass \|.*test\/add\.test\.js/);
  assert.match(body, /\| locked \| pass \|/);
  assert.match(body, /\| scope \| pass \|/);
  assert.match(body, /tier 1 \(exec\/exec-good\/low\), attempt 2 of the run/);
  assert.match(body, /run cost \$0\.02/, 'both attempts count, the failed one included');
  assert.match(body, /Closes BUI-77/);
});

test('REQ-RUN-16 the PR body marks a flaky stage, shows an unpriced run as n/a, and never names the held-out path', () => {
  const heldOut = tmp('keel-heldout-');
  mkdirSync(join(heldOut, 'test'));
  writeFileSync(
    join(heldOut, 'test', 'held.test.js'),
    "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(1, 1), 2);\n",
  );
  const flag = join(tmp('keel-flaky-'), 'seen');
  // The first run of the check fails and leaves a flag; the retry passes (REQ-GATE-18).
  const flakyCheck = `if [ -e ${flag} ]; then exit 0; else touch ${flag}; exit 1; fi`;
  const body = prBodyOf(
    `# fix add\nkind: bug\nsize: S\nheldOut: ${heldOut}\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n`,
    fixtureConfig({ tiers: [tier('good')], checks: { flaky: flakyCheck, test: 'for f in test/*.js; do node "$f" || exit 1; done' } }),
  );
  assert.match(body, /\| flaky \| pass \(flaky: failed once, passed on retry\) \|/);
  assert.match(body, /\| held-out \| pass \|/);
  assert.ok(!body.includes(heldOut), 'the held-out location stays hidden (REQ-GATE-10)');
  assert.ok(!/Closes/.test(body), 'only Linear-style IDs get a Closes line');
  // A worker that fixes the card but reports no cost (as Codex does).
  const noCost = [
    "printf 'export const add = (a, b) => a + b;\\n' > src/add.js",
    "printf \"import assert from 'node:assert';\\nimport { add } from '../src/add.js';\\nassert.strictEqual(add(2, 3), 5);\\n\" > test/add.test.js",
  ].join(' && ');
  const unpriced = prBodyOf(
    '# T-9: fix add\nkind: bug\nsize: S\n\n## Requirements\n- REQ-ADD-1: add shall sum.\n',
    fixtureConfig({ tiers: [{ provider: 'exec', model: 'exec-plain', effort: 'low', command: ['sh', '-c', noCost] }] }),
  );
  assert.match(unpriced, /run cost n\/a/);
});
