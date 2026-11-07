import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BUGGY, FIXTURE_TEST, fixtureRepo, tmp } from './helpers.js';

const KEEL_JSON = `${JSON.stringify({ checks: { test: FIXTURE_TEST }, testCommand: FIXTURE_TEST })}\n`;
const repo = () => fixtureRepo({ ...BUGGY, 'keel.json': KEEL_JSON }).dir;
const BIN = new URL('../bin/keel.js', import.meta.url).pathname;

function keel(args, state) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, KEEL_STATE_DIR: state } });
}

/** A card file outside the repo, so it is read as given (REQ-CARD-3). */
function cardFile(text) {
  const file = join(tmp('keel-card-'), 'BUI-9.md');
  writeFileSync(file, text);
  return file;
}

const oneLine = (r, file) => {
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  const lines = r.stderr.trimEnd().split('\n');
  assert.equal(lines.length, 1, `one stderr line, got:\n${r.stderr}`);
  assert.match(lines[0], /^keel: /);
  assert.ok(lines[0].includes(file), `names the file: ${lines[0]}`);
  return lines[0];
};

test('REQ-CARD-2 invalid card prints one line, no stack trace', () => {
  const dir = repo();
  const state = tmp('keel-state-');
  const cases = [
    ['# BUI-9: t\nkind: rewrite\nsize: S\n', /kind "rewrite".*bug, feature, refactor, ui, infra, chore/],
    ['# BUI-9: t\nkind: bug\nsize: XL\n', /size "XL".*S, M, L/],
    ['# BUI-9: t\nsize: S\n', /kind.*missing.*bug, feature, refactor, ui, infra, chore/],
    ['# BUI-9: t\nkind: bug\n', /size.*missing.*S, M, L/],
    ['# BUI-9: t\nkind: bug\nsize: S\nkindd: bug\n', /unknown header "kindd".*kind, size, paths/],
    ['# BUI-9: t\nkind: bug\nsize: S\nsize: M\n', /header "size" is given twice/],
    ['# BUI-9: t\nkind: bug\nsize: S\npaths: ["a.js"\n', /paths item .* bracket or quote/],
  ];
  for (const [text, reason] of cases) {
    const file = cardFile(text);
    for (const args of [
      ['gate', '--base', 'HEAD', '--card', file, '--repo', dir],
      ['run', file, '--repo', dir],
    ]) {
      const line = oneLine(keel(args, state), file);
      assert.match(line, reason, `${args[0]}: ${line}`);
    }
  }
});

test('REQ-CARD-2 a card file that cannot be read prints one line, no stack trace', () => {
  const dir = repo();
  const file = join(tmp('keel-card-'), 'missing.md');
  const line = oneLine(keel(['gate', '--base', 'HEAD', '--card', file, '--repo', dir], tmp('keel-state-')), file);
  assert.match(line, /ENOENT/);
});

test('REQ-CARD-2 headerless card names the minimum headers', () => {
  const dir = repo();
  const file = cardFile('# BUI-9: do a thing\n\n## Requirements\n\n- kind: of a list item, not a header\n');
  for (const args of [
    ['gate', '--base', 'HEAD', '--card', file, '--repo', dir],
    ['run', file, '--repo', dir],
  ]) {
    const line = oneLine(keel(args, tmp('keel-state-')), file);
    assert.match(line, /no header lines/);
    assert.ok(line.includes('kind: <kind>'), line);
    assert.ok(line.includes('size: <S|M>'), line);
  }
});

test('REQ-CARD-3 a card in the repo but not in the base commit prints one line, no stack trace', () => {
  const dir = repo();
  writeFileSync(join(dir, 'BUI-9.md'), '# BUI-9: t\nkind: bug\nsize: S\n');
  const line = oneLine(keel(['gate', '--base', 'HEAD', '--card', join(dir, 'BUI-9.md'), '--repo', dir], tmp('keel-state-')), 'BUI-9.md');
  assert.match(line, /not in the base commit/);
});
