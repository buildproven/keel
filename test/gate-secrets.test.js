import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { parseCard } from '../src/config.js';
import { failureSummary, gate } from '../src/gate.js';
import { commit, fixtureConfig, fixtureRepo, tmp } from './helpers.js';

const card = parseCard('# T-1: test card\nkind: chore\nsize: S\n');
const stage = (r, name) => r.results.find((x) => x.name === name);
const TOKEN = { 'src/token.js': 'export const token = "abcdefghijkl";\n' };
const RULE =
  '[[rules]]\nid = "env-secret"\ndescription = "secret-shaped assignment"\nregex = \'\'\'(?i)(token|secret|password|api_key)\\s*=\\s*"[^"]{6,}"\'\'\'\n';
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A `gitleaks` on PATH that reads the same arguments as the real one and flags `token = "` in the scanned range. */
function fakeGitleaks() {
  const bin = tmp('keel-bin-');
  const file = join(bin, 'gitleaks');
  writeFileSync(
    file,
    `#!/bin/sh
for a in "$@"; do
  case "$a" in
    --log-opts=*) range="\${a#--log-opts=}" ;;
  esac
done
prev=""
for a in "$@"; do
  [ "$prev" = "--source" ] && source="$a"
  [ "$prev" = "--report-path" ] && report="$a"
  [ "$prev" = "--config" ] && config="$a"
  prev="$a"
done
[ -n "$GITLEAKS_ARGS_LOG" ] && echo "$*" >> "$GITLEAKS_ARGS_LOG"
if git -C "$source" log -p "$range" | grep -q 'token = "'; then
  printf '[{"RuleID":"env-secret","File":"src/token.js","StartLine":1,"Commit":"0123456789abcdef"}]' > "$report"
  exit 1
fi
printf '[]' > "$report"
`,
  );
  chmodSync(file, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
}

test('REQ-GATE-72 a head that adds a secret-shaped value fails the secrets stage when the repo has .gitleaks.toml', () => {
  fakeGitleaks();
  const { dir, base } = fixtureRepo({ ...{ '.gitleaks.toml': RULE }, 'src/a.js': 'export {};\n' });
  commit(dir, TOKEN);
  const r = gate({ repo: dir, base, card, config: fixtureConfig() });
  assert.equal(r.pass, false);
  const secrets = stage(r, 'secrets');
  assert.equal(secrets.pass, false);
  assert.deepEqual(secrets.problems, [{ rule: 'secret-detected', path: 'src/token.js', line: 1, detail: 'env-secret in commit 01234567' }]);
  // The builder is told where, and what to change; the value itself never reaches the receipt.
  assert.match(failureSummary(r, 4000), /Fix: remove the secret-shaped value at src\/token\.js:1/);
  assert.equal(stage(r, 'candidate'), undefined, 'a failed secrets stage stops the gate before the checks run');
});

test('REQ-GATE-72 a clean head passes the secrets stage, and a repo with no gitleaks has no such stage', () => {
  fakeGitleaks();
  const withScan = fixtureRepo({ '.gitleaks.toml': RULE, 'src/a.js': 'export {};\n' });
  commit(withScan.dir, { 'src/b.js': 'export const b = 1;\n' });
  const clean = gate({ repo: withScan.dir, base: withScan.base, card, config: fixtureConfig() });
  assert.equal(stage(clean, 'secrets').pass, true, JSON.stringify(clean.results));

  const without = fixtureRepo();
  commit(without.dir, TOKEN);
  const r = gate({ repo: without.dir, base: without.base, card, config: fixtureConfig() });
  assert.equal(stage(r, 'secrets'), undefined);
  assert.equal(r.pass, true, JSON.stringify(r.results));
});

test('REQ-GATE-72 a pre-push hook, a workflow, or a script that names gitleaks turns the stage on', () => {
  fakeGitleaks();
  for (const file of ['.husky/pre-push', '.github/workflows/ci.yml', 'scripts/run-gitleaks.sh', 'package.json']) {
    const { dir, base } = fixtureRepo({
      'src/a.js': 'export {};\n',
      [file]: file === 'package.json' ? '{"scripts":{"scan":"gitleaks detect"}}\n' : 'gitleaks detect\n',
    });
    commit(dir, TOKEN);
    const r = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(stage(r, 'secrets')?.pass, false, `${file}: ${JSON.stringify(r.results)}`);
  }
});

test('REQ-GATE-72 the scan covers the candidate range only, and uses the .gitleaks.toml of the base', () => {
  fakeGitleaks();
  const log = join(tmp('keel-log-'), 'args');
  process.env.GITLEAKS_ARGS_LOG = log;
  try {
    // A secret already in the base history is not the candidate's; the candidate weakens the config in its own commit.
    const { dir, base } = fixtureRepo({ '.gitleaks.toml': RULE, 'src/a.js': 'export {};\n' });
    commit(dir, { '.gitleaks.toml': '# allow everything\n', 'src/b.js': 'export const b = 1;\n' });
    const r = gate({ repo: dir, base, card, config: fixtureConfig() });
    assert.equal(stage(r, 'secrets').pass, true);
    const args = spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
    assert.match(args, new RegExp(`--log-opts=${base}\\.\\.[0-9a-f]{40}`));
    assert.match(args, /--config \S+gitleaks\.toml/);
  } finally {
    delete process.env.GITLEAKS_ARGS_LOG;
  }
});

test('REQ-GATE-72 a repo that runs gitleaks fails visibly where gitleaks is not installed', () => {
  // A PATH with git and sh only: gitleaks is on none of it, wherever this machine keeps it.
  const bin = tmp('keel-bin-');
  for (const tool of ['git', 'sh']) symlinkSync(spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim(), join(bin, tool));
  process.env.PATH = bin;
  const { dir, base } = fixtureRepo({ '.gitleaks.toml': RULE, 'src/a.js': 'export {};\n' });
  commit(dir, { 'src/b.js': 'export const b = 1;\n' });
  const r = gate({ repo: dir, base, card, config: fixtureConfig({ checks: {}, testCommand: 'true' }) });
  const secrets = stage(r, 'secrets');
  assert.equal(secrets.pass, false);
  assert.equal(secrets.problems[0].rule, 'gitleaks-unavailable');
  assert.match(secrets.problems[0].detail, /not installed/);
});

const realGitleaks = spawnSync('gitleaks', ['version']).status === 0;
if (realGitleaks) {
  test('REQ-GATE-72 the real gitleaks, with the repo .gitleaks.toml, fails a head that adds const token = "abcdefghijkl"', () => {
    const { dir, base } = fixtureRepo({ '.gitleaks.toml': RULE, 'src/a.js': 'export {};\n' });
    commit(dir, { 'src/t.js': 'const token = "abcdefghijkl";\n' });
    const r = gate({ repo: dir, base, card, config: fixtureConfig() });
    const secrets = stage(r, 'secrets');
    assert.equal(secrets.pass, false, JSON.stringify(r.results));
    assert.equal(secrets.problems[0].rule, 'secret-detected');
    assert.equal(secrets.problems[0].path, 'src/t.js');
    assert.ok(!JSON.stringify(r).includes('abcdefghijkl'), 'the value is redacted');
  });
}
