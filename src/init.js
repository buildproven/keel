import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeTestGlobs } from './scan.js';
import { UsageError } from './usage.js';

const read = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
const has = (dir, name) => existsSync(join(dir, name));
const scripts = (pkgText) => (pkgText ? (JSON.parse(pkgText).scripts ?? {}) : {});

/** Node package manager from the lockfile present at root; npm is the fallback. */
function nodeManager(dir) {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (has(dir, 'yarn.lock')) return 'yarn';
  if (has(dir, 'bun.lockb') || has(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

const EXEC = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };

/**
 * The test runner of a `test` script, for given files (REQ-GATE-33): vitest and jest, whose passing output names each
 * file, and `node --test` over explicit file globs, which the gate matches new files against, since the targeted red
 * proof needs to know the suite runs them. null for others (mocha and a bare `node --test` show no files).
 */
function nodeFilesCommand(script, pm) {
  if (!script) return null;
  if (/\bvitest\b/.test(script)) return `${EXEC[pm]} vitest run {files}`;
  if (/\bjest\b/.test(script)) return `${EXEC[pm]} jest {files}`;
  if (nodeTestGlobs(script).length) return 'node --test {files}';
  return null;
}

function detectNode(dir) {
  const pkg = read(dir, 'package.json');
  if (!pkg) return null;
  const s = scripts(pkg);
  const pm = nodeManager(dir);
  // bun needs `bun run`: `bun test` and `bun build` are its own test runner and bundler, not the scripts (REQ-PROJ-2).
  const run = (name) => (pm === 'npm' || pm === 'bun' ? `${pm} run ${name}` : `${pm} ${name}`);
  const checks = {};
  for (const name of ['lint', 'typecheck', 'build']) if (s[name]) checks[name] = run(name);
  if (s.test) checks.test = pm === 'npm' ? 'npm test' : run('test');
  return { kind: 'node', checks, testCommand: checks.test ?? null, testFilesCommand: nodeFilesCommand(s.test, pm) };
}

/** Python runner prefix from the lockfile present at root; plain `python` (or `python3`) is the fallback. */
function pythonRunner(dir) {
  if (has(dir, 'uv.lock')) return 'uv run';
  if (has(dir, 'poetry.lock')) return 'poetry run';
  return '';
}

function detectPython(dir) {
  const pyproject = read(dir, 'pyproject.toml');
  if (!pyproject && !has(dir, 'requirements.txt') && !has(dir, 'setup.py')) return null;
  const runner = pyproject ? pythonRunner(dir) : '';
  const prefix = runner ? `${runner} ` : '';
  const checks = {};
  if (pyproject && /\[tool\.ruff\]/.test(pyproject)) checks.lint = `${prefix}ruff check .`;
  if (pyproject && /\[tool\.mypy\]/.test(pyproject)) checks.typecheck = `${prefix}mypy .`;
  const testCommand = `${prefix}python -m pytest -q`;
  checks.test = testCommand;
  return { kind: 'python', checks, testCommand };
}

function detectGo(dir) {
  if (!has(dir, 'go.mod')) return null;
  return { kind: 'go', checks: { vet: 'go vet ./...', test: 'go test ./...' }, testCommand: 'go test ./...' };
}

function detectRust(dir) {
  if (!has(dir, 'Cargo.toml')) return null;
  return { kind: 'rust', checks: { clippy: 'cargo clippy -- -D warnings', test: 'cargo test' }, testCommand: 'cargo test' };
}

function detectRuby(dir) {
  if (!has(dir, 'Gemfile')) return null;
  const testCommand = has(dir, '.rspec') || has(dir, 'spec') ? 'bundle exec rspec' : 'bundle exec rake test';
  const checks = { test: testCommand };
  if (has(dir, '.rubocop.yml')) checks.lint = 'bundle exec rubocop';
  return { kind: 'ruby', checks, testCommand };
}

/** Only used when nothing more specific (node/go/rust/...) matched, so a JS repo with a Makefile wrapper still gets its own checks. */
function detectMake(dir) {
  const mk = read(dir, 'Makefile') ?? read(dir, 'makefile');
  if (!mk || !/^test:/m.test(mk)) return null;
  const checks = { test: 'make test' };
  if (/^lint:/m.test(mk)) checks.lint = 'make lint';
  return { kind: 'make', checks, testCommand: 'make test' };
}

function detectTerraform(dir) {
  if (!readdirSync(dir).some((f) => f.endsWith('.tf'))) return null;
  return { kind: 'terraform', checks: { fmt: 'terraform fmt -check', validate: 'terraform validate' }, testCommand: null };
}

/** GitHub workflows are code a gate cannot run; actionlint catches invalid inputs and expressions (REQ-PROJ-6). */
function detectActions(dir) {
  const wf = join(dir, '.github', 'workflows');
  if (!existsSync(wf) || !readdirSync(wf).some((f) => /\.ya?ml$/.test(f))) return null;
  return { kind: 'actions', checks: { actionlint: 'actionlint -shellcheck= -pyflakes=' }, testCommand: null };
}

// detectActions first: actionlint takes seconds, so a bad workflow fails before slow builds and tests run.
const DETECTORS = [detectActions, detectNode, detectPython, detectGo, detectRust, detectRuby, detectMake, detectTerraform];

/** Every project type found at the repo root (REQ-PROJ-2); several can combine (monorepo). */
export function detectProject(dir) {
  return DETECTORS.map((d) => d(dir)).filter(Boolean);
}

/**
 * Merge detected project(s) into one proposed keel.json shape (REQ-PROJ-2). Checks from every
 * detected kind are combined — except a Makefile with a `test:` target always wins its own `test`
 * key and supplies `testCommand`: it is the project's own declared entry point, and a raw language
 * detector's direct invocation (e.g. `python -m pytest`) can silently run a different command than
 * `make test` does (different flags, different env) even though both claim to be "the test check".
 * Real bug found running `keel init` on a real Python-with-Makefile repo (2026-09-28): `checks.test`
 * and `testCommand` disagreed because they were chosen by two different, uncoordinated rules.
 * Absent a Makefile, the first detected kind with a `testCommand` supplies it, as before. Terraform
 * alone (no testCommand) still proposes its plan/validate checks under a chore-only workflow.
 */
export function proposeConfig(found) {
  if (!found.length) throw new UsageError('no project marker found; set "checks" and "testCommand" in keel.json by hand');
  const checks = Object.assign({}, ...found.map((f) => f.checks));
  const make = found.find((f) => f.kind === 'make');
  if (make) Object.assign(checks, make.checks);
  const source = make ?? found.find((f) => f.testCommand);
  const testCommand = source?.testCommand ?? null;
  if (!testCommand)
    throw new UsageError('detected project has no test command (checks and testCommand both needed); set "testCommand" by hand');
  // Only from the kind that supplies testCommand, so both run the same runner (REQ-GATE-33).
  return { checks, testCommand, ...(source.testFilesCommand ? { testFilesCommand: source.testFilesCommand } : {}) };
}

/** `keel init`: propose and write keel.json, never overwriting an existing one (REQ-PROJ-2). */
export function writeProposedConfig(dir) {
  const target = join(dir, 'keel.json');
  if (existsSync(target)) return { written: false, path: target };
  const proposed = proposeConfig(detectProject(dir));
  writeFileSync(target, `${JSON.stringify(proposed, null, 2)}\n`);
  return { written: true, path: target, proposed };
}
