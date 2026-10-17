import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectProject, proposeConfig, writeProposedConfig } from '../src/init.js';
import { tmp, write } from './helpers.js';

test('REQ-PROJ-2 detects npm and proposes only the scripts that exist', () => {
  write((process.env.__d = tmp()), {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -b' } }),
    'package-lock.json': '{}',
  });
  const found = detectProject(process.env.__d);
  assert.deepEqual(found.map((f) => f.kind).sort(), ['node']);
  const proposed = proposeConfig(found);
  assert.equal(proposed.testCommand, 'npm test');
  assert.deepEqual(Object.keys(proposed.checks).sort(), ['build', 'lint', 'test']);
  assert.ok(!('typecheck' in proposed.checks), 'no typecheck script was declared');
});

test('REQ-PROJ-2 picks the right package manager from the lockfile', () => {
  for (const [lock, cmd] of [
    ['pnpm-lock.yaml', 'pnpm test'],
    ['yarn.lock', 'yarn test'],
    ['bun.lockb', 'bun run test'],
  ]) {
    const dir = tmp();
    write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), [lock]: '' });
    assert.equal(proposeConfig(detectProject(dir)).testCommand, cmd);
  }
});

test('REQ-PROJ-2 detects Python (uv) with ruff and mypy configured, pytest as testCommand', () => {
  const dir = tmp();
  write(dir, {
    'pyproject.toml': '[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
    'uv.lock': '',
  });
  const found = detectProject(dir);
  assert.deepEqual(
    found.map((f) => f.kind),
    ['python'],
  );
  const proposed = proposeConfig(found);
  assert.equal(proposed.testCommand, 'uv run python -m pytest -q');
  assert.deepEqual(Object.keys(proposed.checks).sort(), ['lint', 'test', 'typecheck']);
  assert.match(proposed.checks.lint, /^uv run ruff check/);
});

test('REQ-PROJ-2 detects Python (poetry) without ruff/mypy: only a test check', () => {
  const dir = tmp();
  write(dir, { 'pyproject.toml': '[project]\nname = "x"\n', 'poetry.lock': '' });
  const proposed = proposeConfig(detectProject(dir));
  assert.deepEqual(Object.keys(proposed.checks), ['test']);
  assert.equal(proposed.testCommand, 'poetry run python -m pytest -q');
});

test('REQ-PROJ-2 detects plain pip Python (requirements.txt, no lockfile)', () => {
  const dir = tmp();
  write(dir, { 'requirements.txt': 'pytest\n' });
  const proposed = proposeConfig(detectProject(dir));
  assert.equal(proposed.testCommand, 'python -m pytest -q');
});

test('REQ-PROJ-2 detects Go, Rust, and Ruby', () => {
  const go = tmp();
  write(go, { 'go.mod': 'module x\n' });
  assert.deepEqual(proposeConfig(detectProject(go)), {
    checks: { vet: 'go vet ./...', test: 'go test ./...' },
    testCommand: 'go test ./...',
  });

  const rust = tmp();
  write(rust, { 'Cargo.toml': '[package]\nname = "x"\n' });
  const rustProposed = proposeConfig(detectProject(rust));
  assert.equal(rustProposed.testCommand, 'cargo test');
  assert.ok('clippy' in rustProposed.checks);

  const ruby = tmp();
  write(ruby, { Gemfile: 'source "https://rubygems.org"\n', '.rspec': '' });
  const rubyProposed = proposeConfig(detectProject(ruby));
  assert.equal(rubyProposed.testCommand, 'bundle exec rspec');
});

test('REQ-PROJ-2 detects a Makefile with a test target, and Terraform', () => {
  const make = tmp();
  write(make, { Makefile: 'test:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run\n' });
  const madeProposed = proposeConfig(detectProject(make));
  assert.equal(madeProposed.testCommand, 'make test');
  assert.ok('lint' in madeProposed.checks);

  const tf = tmp();
  write(tf, { 'main.tf': 'resource "null_resource" "x" {}\n' });
  const tfFound = detectProject(tf);
  assert.deepEqual(
    tfFound.map((f) => f.kind),
    ['terraform'],
  );
});

test('REQ-PROJ-2 a Makefile wrapper around Python tests wins over the raw Python detector, so checks.test and testCommand agree', () => {
  // Real bug found running keel init on a real Python-with-Makefile repo (2026-09-28):
  // detectPython's testCommand ("uv run python -m pytest -q") won by DETECTORS order, but
  // detectMake's checks.test ("make test") separately overwrote checks.test in the merge - the
  // proposed config ran two different commands for what claimed to be the same check.
  const dir = tmp();
  write(dir, {
    'pyproject.toml': '[project]\nname = "x"\n',
    'uv.lock': '',
    Makefile: 'test:\n\t$(PY) -m pytest --cov -q\n\nlint:\n\truff check .\n',
  });
  const proposed = proposeConfig(detectProject(dir));
  assert.equal(proposed.checks.test, 'make test');
  assert.equal(proposed.testCommand, 'make test', 'testCommand must run the same command checks.test does');
});

test('REQ-PROJ-2 combines markers found at the repo root (monorepo)', () => {
  const dir = tmp();
  write(dir, {
    'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    'pyproject.toml': '[project]\nname = "x"\n',
  });
  const found = detectProject(dir)
    .map((f) => f.kind)
    .sort();
  assert.deepEqual(found, ['node', 'python']);
});

test('REQ-PROJ-2 fails with no marker, listing the keys to set by hand', () => {
  assert.equal(detectProject(tmp()).length, 0);
  assert.throws(() => proposeConfig([]), /checks.*testCommand|testCommand.*checks/s);
});

test('REQ-PROJ-2 keel init never overwrites an existing keel.json', () => {
  const dir = tmp();
  write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'keel.json': '{"maxAttempts":9}' });
  const result = writeProposedConfig(dir);
  assert.equal(result.written, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'keel.json'), 'utf8')).maxAttempts, 9);
});

test('REQ-PROJ-2 keel init writes a valid, loadable keel.json', () => {
  const dir = tmp();
  write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const result = writeProposedConfig(dir);
  assert.equal(result.written, true);
  assert.ok(existsSync(join(dir, 'keel.json')));
  const saved = JSON.parse(readFileSync(join(dir, 'keel.json'), 'utf8'));
  assert.equal(saved.testCommand, 'npm test');
});

test('REQ-PROJ-6 a repo with GitHub workflows gets an actionlint check, first, without changing testCommand', () => {
  const dir = tmp();
  write(dir, {
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'node --test' } }),
    '.github/workflows/ci.yml': 'on: push\n',
  });
  const proposed = proposeConfig(detectProject(dir));
  assert.equal(Object.keys(proposed.checks)[0], 'actionlint');
  assert.equal(proposed.checks.actionlint, 'actionlint -shellcheck= -pyflakes=');
  assert.equal(proposed.testCommand, 'npm test');
});

test('REQ-PROJ-6 no workflows directory, no actionlint check', () => {
  const dir = tmp();
  write(dir, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.equal(proposeConfig(detectProject(dir)).checks.actionlint, undefined);
});
