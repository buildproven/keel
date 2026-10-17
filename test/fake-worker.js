// Fake builder for run tests. argv[2] = behaviour; prompt arrives on stdin.
// `script <file>`: the file is a JSON array of behaviours; each call takes the next one and prints a session id
// (`s<call>`), so tests can follow one session across calls (REQ-RUN-33). KEEL_RESUME is the session Keel resumed.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let mode = argv[0];
let session = null;
if (mode === 'script') {
  const counter = `${argv[1]}.n`;
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  mode = JSON.parse(readFileSync(argv[1], 'utf8'))[n];
  session = `s${n + 1}`;
}
const prompt = readFileSync(0, 'utf8');
const env = { model: process.env.KEEL_MODEL, effort: process.env.KEEL_EFFORT, resume: process.env.KEEL_RESUME };
if (process.env.KEEL_FAKE_LOG) appendFileSync(process.env.KEEL_FAKE_LOG, `${JSON.stringify({ mode, prompt, env, argv })}\n`);

const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 };
const result = () => JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage, ...(session ? { session_id: session } : {}) });
// `say:<text>` prints the text as the model's answer, then the result line (a refine turn, REQ-LINEAR-33).
if (mode?.startsWith('say:')) {
  console.log(mode.slice(4));
  console.log(result());
  process.exit(0);
}
if (mode === 'crash') process.exit(3);
if (mode === 'blocked') {
  writeFileSync('KEEL_BLOCKED', 'the card asks for a column the schema does not have\n');
  console.log(result());
  process.exit(0);
}
if (mode === 'quota') {
  console.error('Error: usage limit reached, try again later');
  process.exit(1);
}
if (mode === 'auth') {
  console.error('Not logged in. Please log in.');
  process.exit(1);
}
if (mode === 'network') {
  console.error('Error: fetch failed');
  process.exit(1);
}
if (mode === 'no-usage') {
  console.log('plain text');
  process.exit(0);
}
const REGRESSION = "import assert from 'node:assert';\nimport { add } from '../src/add.js';\nassert.strictEqual(add(2, 3), 5);\n";
if (mode === 'detach') execSync('git checkout -q --detach');
if (['fix-only', 'good', 'good-exit42', 'detach', 'edit-test', 'fix-locked', 'out-of-scope'].includes(mode))
  writeFileSync('src/add.js', 'export const add = (a, b) => a + b;\n');
if (['good', 'good-exit42', 'detach', 'fix-locked', 'out-of-scope'].includes(mode)) {
  mkdirSync('test', { recursive: true });
  writeFileSync('test/add.test.js', REGRESSION);
}
// edit-test puts the regression in the existing (locked) test file; fix-locked restores that file as the base has it.
if (mode === 'edit-test') appendFileSync('test/basic.test.js', "import { add } from '../src/add.js';\nassert.strictEqual(add(2, 3), 5);\n");
if (mode === 'fix-locked') writeFileSync('test/basic.test.js', "import assert from 'node:assert';\nassert.ok(true);\n");
if (mode === 'out-of-scope') {
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/notes.md', 'notes\n');
}
console.log(result());
if (mode === 'detach') execSync('git add -A && git commit -q -m detached-fix');
if (mode === 'good-exit42') process.exit(42);
