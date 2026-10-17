import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILLS = fileURLToPath(new URL('../skills', import.meta.url));

test('REQ-SKILL-1 skills/ holds only the keel and cards product skills, with nothing from the owner machine', () => {
  const dirs = readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.deepEqual(dirs.sort(), ['cards', 'keel']);
  for (const name of dirs) {
    for (const file of readdirSync(join(SKILLS, name), { recursive: true }).filter((f) => !f.endsWith('/'))) {
      const text = readFileSync(join(SKILLS, name, file), 'utf8');
      assert.doesNotMatch(text, /\/Users\/|~\/Projects|\.config\/buildproven|\.secrets\//, `${name}/${file}`);
    }
  }
  assert.ok(readFileSync(join(SKILLS, 'keel', 'SKILL.md'), 'utf8').startsWith('---'));
});
