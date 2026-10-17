import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** `npm pack --dry-run --json`: what an outside user would install. */
const packed = () =>
  JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' }))[0];

test('REQ-PKG-1 the package holds only the CLI, its source, README, LICENSE, and package.json, and nothing from the owner machine', () => {
  const files = packed().files.map((f) => f.path);
  for (const f of files) assert.match(f, /^(bin\/|src\/|README\.md$|LICENSE$|package\.json$)/, `unexpected file in package: ${f}`);
  for (const f of files.filter((p) => /^(bin|src)\//.test(p))) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /\/Users\/|~\/Projects|\.config\/buildproven|\.secrets\//, `${f} names a path on the owner's machine`);
  }
  assert.equal(pkg.name, '@buildproven/keel');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'zero runtime dependencies');
});

test('REQ-PKG-1 the packed tarball installs into an empty directory and its keel runs', () => {
  const dir = tmp('keel-pack-');
  const [{ filename }] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { cwd: ROOT, encoding: 'utf8' }),
  );
  const prefix = join(dir, 'install');
  execFileSync('npm', ['install', '--offline', '--no-audit', '--no-fund', '--prefix', prefix, join(dir, filename)], { encoding: 'utf8' });
  const out = execFileSync(join(prefix, 'node_modules', '.bin', 'keel'), ['--help'], { encoding: 'utf8' });
  assert.match(out, /quality gate that picks the model/);
});

test('REQ-CLI-5 keel --version and -v print the package version and exit 0', () => {
  for (const flag of ['--version', '-v']) {
    const out = execFileSync('node', [join(ROOT, 'bin', 'keel.js'), flag], { encoding: 'utf8' });
    assert.equal(out.trim(), pkg.version);
  }
});

test('REQ-CLI-5 --version with a command is a usage error, so `keel gate -v` can never pass without gating', () => {
  const r = spawnSync('node', [join(ROOT, 'bin', 'keel.js'), 'gate', '-v'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^keel: --version takes no command/);
});
