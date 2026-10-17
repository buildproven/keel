import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapedDefects, formatEscaped } from '../src/escaped.js';
import { appendAttempt, stateDir } from '../src/ledger.js';
import { formatValue, value } from '../src/value.js';
import { commit, fixtureRepo, g, tmp } from './helpers.js';

const KEEL = fileURLToPath(new URL('../bin/keel.js', import.meta.url));

beforeEach(() => {
  process.env.KEEL_STATE_DIR = tmp('keel-state-');
});

const row = (over) => ({ run: over.card, attempt: 1, tier: 0, attemptPass: true, cost: 0.1, at: new Date().toISOString(), ...over });

const SRC = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

/** A Keel change (BUI-9) that writes lib.js and a DESIGN.md section, merged to main under its ID. */
function merged() {
  const { dir } = fixtureRepo();
  commit(dir, { 'src/lib.js': '// lib\n', 'docs/DESIGN.md': '# Design\n\nIntro.\n', 'notes.txt': 'n\n' }, 'chore: start');
  const start = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-9');
  const files = { 'src/lib.js': `// lib\n${SRC}`, 'docs/DESIGN.md': '# Design\n\nIntro.\n\nREQ-9 lib.\n', 'notes.txt': 'n\nm\n' };
  const head = commit(dir, files, 'feat: lib');
  g(dir, 'checkout', '-q', 'main');
  const merge = commit(dir, files, 'BUI-9: lib (#1)');
  return { dir, base: start, head, merge, rows: [row({ card: 'BUI-9', repo: dir, base: start, head })] };
}

test('REQ-LED-10 a later fix that changes only lines the merge did not write is not counted against it', () => {
  const { dir, rows } = merged();
  commit(dir, { 'src/lib.js': `// lib, fixed header\n${SRC}` }, 'fix: header comment');
  const [m] = escapedDefects(rows).merged;
  assert.deepEqual(m.candidates, [], 'the fix rewrote line 1, which predates the merge');
  assert.deepEqual(value(rows).keel, { merged: 1, followed: 0 });
});

test('REQ-LED-10 a later fix that modifies or deletes a line the merge wrote is counted, with that file', () => {
  const { dir, rows } = merged();
  commit(dir, { 'src/lib.js': '// lib\nexport const a = 1;\nexport const b = 20;\nexport const c = 3;\n' }, 'fix: b is 20');
  commit(dir, { 'src/lib.js': '// lib\nexport const a = 1;\nexport const b = 20;\n' }, 'fix: drop c');
  const [m] = escapedDefects(rows).merged;
  assert.deepEqual(
    m.candidates.map((c) => [c.subject, c.files]),
    [
      ['fix: b is 20', ['src/lib.js']],
      ['fix: drop c', ['src/lib.js']],
    ],
  );
});

test('REQ-LED-10 a fix that only edits doc or requirements files (*.md, *.txt, *.rst) the merge wrote is not counted', () => {
  const { dir, rows } = merged();
  commit(dir, { 'docs/DESIGN.md': '# Design\n\nIntro.\n\nREQ-9 lib, reworded.\n', 'notes.txt': 'n\nx\n' }, 'fix: reword REQ-9');
  const [m] = escapedDefects(rows).merged;
  assert.deepEqual(m.candidates, []);
});

test('REQ-LED-10 a revert of the merge always counts, whatever lines it touches', () => {
  const { dir, rows, merge } = merged();
  commit(
    dir,
    { 'src/lib.js': '// lib\n', 'docs/DESIGN.md': '# Design\n\nIntro.\n', 'notes.txt': 'n\n' },
    `Revert "BUI-9: lib (#1)"\n\nThis reverts commit ${merge}.`,
  );
  const v = value(rows);
  assert.deepEqual(v.keel, { merged: 1, followed: 1 });
  assert.match(formatEscaped(escapedDefects(rows)), /BUI-9 merged [0-9a-f]{7} .* → revert [0-9a-f]{7} .*"Revert \\"BUI-9: lib \(#1\)\\""/);
});

test('REQ-LED-10 the baseline uses the same line rule as Keel merges', () => {
  const { dir, rows } = merged();
  commit(dir, { 'src/other.js': 'export const x = 1;\nexport const y = 2;\n' }, 'feat: other');
  commit(dir, { 'src/other.js': 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n' }, 'fix: add z after other');
  commit(dir, { 'src/other.js': 'export const x = 10;\nexport const y = 2;\nexport const z = 3;\n' }, 'fix: x is 10');
  commit(dir, { 'docs/DESIGN.md': '# Design, fixed\n\nIntro.\n\nREQ-9 lib.\n' }, 'fix: design title');
  const v = value(rows);
  // base, chore: start, feat: other, and three fixes; only feat: other has its own line later changed by a fix.
  // chore: start wrote DESIGN.md line 1, but a doc edit is not a defect.
  assert.deepEqual(v.other, { changes: 6, followed: 1 });
});

test('REQ-LED-10 --escaped and --value say what they count', () => {
  const { dir, rows, base, head } = merged();
  commit(dir, { 'src/lib.js': '// lib\nexport const a = 2;\nexport const b = 2;\nexport const c = 3;\n' }, 'fix: a is 2');
  const text = formatEscaped(escapedDefects(rows));
  assert.match(text, /^merged 1; not found on the default branch 0; later fixed on the same lines or reverted 1$/m);
  // REQ-LED-15 reworded the --value line; it counts the same thing.
  assert.match(formatValue(value(rows)), /^Later fixed on the same lines: Keel 100% \(1 of 1\) vs other work 0% \(0 of 3\)$/m);
  appendAttempt({ ...row({ card: 'BUI-9', repo: dir, base, head }), workerStatus: 'ok', gatePass: true, usage: null, durationMs: 1 });
  const out = execFileSync('node', [KEEL, 'report', '--escaped'], { encoding: 'utf8', env: { ...process.env } });
  assert.match(out, /later fixed on the same lines or reverted 1/);
});

test('REQ-LED-11 line attribution is cached in the state dir per repo and fix commit, and a cached answer is reused', () => {
  const { dir, rows } = merged();
  const fix = commit(dir, { 'src/lib.js': '// lib\nexport const a = 1;\nexport const b = 5;\nexport const c = 3;\n' }, 'fix: b is 5');
  const first = escapedDefects(rows).merged[0].candidates.map((c) => c.sha);
  assert.deepEqual(first, [fix]);
  const root = join(stateDir(), 'blame');
  assert.ok(existsSync(root), 'blame cache directory exists');
  const repos = readdirSync(root);
  assert.equal(repos.length, 1, 'one directory per repo');
  assert.ok(readdirSync(join(root, repos[0])).includes(`${fix}.json`), 'one file per fix commit');
  // The cache holds what blame found; a new process, with git now unable to blame, must still answer from it.
  g(dir, 'config', 'blame.ignoreRevsFile', join(dir, 'missing-ignore-revs'));
  assert.throws(() => g(dir, 'blame', 'src/lib.js'), 'blame really fails now');
  appendAttempt({ ...rows[0], workerStatus: 'ok', gatePass: true, usage: null, durationMs: 1 });
  const out = execFileSync('node', [KEEL, 'report', '--escaped'], { encoding: 'utf8', env: { ...process.env } });
  assert.match(out, new RegExp(`→ fix ${fix.slice(0, 7)} `));
});

test('REQ-LED-10 a fix on lines the merge wrote counts after the file was renamed in between', () => {
  const { dir, rows } = merged();
  g(dir, 'mv', 'src/lib.js', 'src/core.js');
  g(dir, 'commit', '-q', '-m', 'refactor: rename lib');
  commit(dir, { 'src/core.js': '// lib\nexport const a = 1;\nexport const b = 7;\nexport const c = 3;\n' }, 'fix: b is 7');
  const [m] = escapedDefects(rows).merged;
  assert.deepEqual(
    m.candidates.map((c) => [c.subject, c.files]),
    [['fix: b is 7', ['src/core.js']]],
  );
});

test('REQ-LED-10 line attribution works in a SHA-256 repository', () => {
  const dir = tmp('keel-repo-');
  g(dir, 'init', '-q', '--object-format=sha256', '-b', 'main');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'user.name', 'test');
  g(dir, 'config', 'commit.gpgsign', 'false');
  const base = commit(dir, { 'src/lib.js': '// lib\n' }, 'base');
  g(dir, 'checkout', '-q', '-b', 'keel/BUI-9');
  const head = commit(dir, { 'src/lib.js': `// lib\n${SRC}` }, 'feat: lib');
  g(dir, 'checkout', '-q', 'main');
  commit(dir, { 'src/lib.js': `// lib\n${SRC}` }, 'BUI-9: lib (#1)');
  commit(dir, { 'src/lib.js': '// lib\nexport const a = 1;\nexport const b = 9;\nexport const c = 3;\n' }, 'fix: b is 9');
  const [m] = escapedDefects([row({ card: 'BUI-9', repo: dir, base, head })]).merged;
  assert.equal(m.mergeSha.length, 64);
  assert.deepEqual(
    m.candidates.map((c) => c.subject),
    ['fix: b is 9'],
  );
});

test('REQ-LED-11 a blame cache that cannot be written is reported on stderr and the report still answers', () => {
  const { dir, rows } = merged();
  commit(dir, { 'src/lib.js': '// lib\nexport const a = 1;\nexport const b = 4;\nexport const c = 3;\n' }, 'fix: b is 4');
  const blocked = join(tmp('keel-state-file-'), 'not-a-dir');
  writeFileSync(blocked, 'x');
  process.env.KEEL_STATE_DIR = blocked;
  const warnings = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => warnings.push(String(chunk)) && true;
  try {
    assert.deepEqual(
      escapedDefects(rows).merged[0].candidates.map((c) => c.subject),
      ['fix: b is 4'],
    );
  } finally {
    process.stderr.write = write;
  }
  assert.match(warnings.join(''), /keel: blame cache not written/);
});
