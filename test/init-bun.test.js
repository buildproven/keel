import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProject, proposeConfig } from '../src/init.js';
import { tmp, write } from './helpers.js';

test('REQ-PROJ-2 a bun project runs its package scripts with `bun run`, not the bun test runner or bundler', () => {
  for (const lock of ['bun.lock', 'bun.lockb']) {
    const dir = tmp();
    write(dir, {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc', build: 'vite build' } }),
      [lock]: '',
    });
    const proposed = proposeConfig(detectProject(dir));
    assert.deepEqual(proposed.checks, {
      lint: 'bun run lint',
      typecheck: 'bun run typecheck',
      build: 'bun run build',
      test: 'bun run test',
    });
    assert.equal(proposed.testCommand, 'bun run test');
  }
});
