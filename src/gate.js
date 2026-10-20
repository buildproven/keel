import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkEnv } from './env.js';
import { linkedDirs } from './config.js';
import { outLine, reviewStage, testEditStage } from './review.js';
import { fixedSlots, withGateSlot } from './slots.js';
import { recordGateTimes, timingLine } from './timing.js';
import {
  addedLines,
  changedFiles,
  exec,
  fileMode,
  git,
  isDirty,
  mainWorktree,
  revParse,
  sh,
  showBlob,
  showFile,
  trackedContentDirty,
  withTempWorktree,
} from './git.js';
import {
  commandTestGlobs,
  findBypassMarkers,
  findSkipMarkers,
  fold,
  locksAny,
  matchesAny,
  outOfScope,
  PROSE,
  pyprojectToolSectionsChanged,
  packageToolConfigChanged,
  scriptPaths,
  scriptsAppendOnly,
  scriptsChanged,
  testShape,
} from './scan.js';
import { workflowWeakened } from './workflow.js';

const NOT_A_TEST_RESULT = new Set([126, 127]); // command not executable / not found
const tail = (s, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);
const fail = (name, rule, extra = {}) => ({ name, pass: false, problems: [{ rule, ...extra }] });
export const inconclusive = (r) => r.timedOut || r.code === null || NOT_A_TEST_RESULT.has(r.code);

/** Where shared dirs come from: the repo, then its main worktree when the repo is a git checkout (REQ-GATE-48). */
const sharedRoots = (from) => (existsSync(join(from, '.git')) ? [from, mainWorktree(from)] : [from]);

/** Symlink shared dependency dirs (node_modules, .venv) so temp checkouts can run tests. */
export function linkShared(from, to, dirs) {
  const roots = sharedRoots(from);
  for (const d of dirs) {
    const src = roots.map((r) => resolve(r, d)).find((p) => existsSync(p));
    if (src && !existsSync(join(to, d))) symlinkSync(src, join(to, d));
  }
}

/** shareDirs that keel.json writes and neither the repo nor its main worktree has, so no checkout could run (REQ-GATE-49). */
function missingShared(repo, config) {
  if (!config.shareDirsRequired) return [];
  const roots = sharedRoots(repo);
  return linkedDirs(config).filter((d) => !roots.some((r) => existsSync(resolve(r, d))));
}

/**
 * Make a fresh checkout runnable: install from the committed manifest when `install` is set, else link the
 * shared dirs (REQ-GATE-16). Returns the failed install result, or null.
 */
export function prepareCheckout(repo, dir, config) {
  if (!config.install) {
    linkShared(repo, dir, linkedDirs(config));
    return null;
  }
  const r = shell(config.install, dir, config);
  return r.code === 0 ? null : r;
}

/** Write a file inside root; refuse, before creating anything, paths that resolve outside it or land on a symlink (REQ-GATE-12). */
export function writeInside(root, rel, write) {
  const realRoot = `${realpathSync(root)}${sep}`;
  const target = join(root, rel);
  let existing = dirname(target);
  while (!existsSync(existing)) existing = dirname(existing);
  if (!`${realpathSync(existing)}${sep}`.startsWith(realRoot)) return `path escapes checkout: ${rel}`;
  mkdirSync(dirname(target), { recursive: true });
  if (!`${realpathSync(dirname(target))}${sep}`.startsWith(realRoot)) return `path escapes checkout: ${rel}`;
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return `target is a symlink: ${rel}`;
  write(target);
  return null;
}

const needsProof = (card) => ['bug', 'feature'].includes(card.kind);
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The card names `path` as a place to change (REQ-GATE-43): its paths match it, or its text names the path or file name. */
const names = (card, path) =>
  matchesAny(path, card.paths) ||
  new RegExp(`(^|[^\\w./-])(${escapeRe(path)}|${escapeRe(basename(path))})(?![\\w/-]|\\.\\w)`).test(card.text ?? '');

/**
 * Why the head file may check less than the base file (REQ-GATE-44), or null: a modified file that keeps every test name,
 * adds no skip marker, and has no fewer assertions. `needTests`: the base file must have a test to compare.
 */
function shapeBlocker(f, { repo, from, head }, needTests) {
  if (f.status !== 'M') return 'only a modified test file can be proved; a deleted, renamed, or type-changed one cannot';
  const before = testShape(showFile(from, f.path, repo) ?? '');
  const after = testShape(showFile(head, f.path, repo) ?? '');
  if (needTests && !before.tests.length) return 'no test found in the base file to compare';
  const left = [...after.tests];
  for (const name of before.tests) {
    const k = left.indexOf(name);
    if (k < 0) return `test removed or renamed: ${name}`;
    left.splice(k, 1);
  }
  if (after.assertions < before.assertions) return `assertions drop from ${before.assertions} to ${after.assertions}`;
  if (after.skips > before.skips) return 'a skip marker was added';
  return null;
}

/**
 * Why an edit to an existing test file cannot be proved non-weakening (REQ-GATE-44), or null when it may go on to the
 * per-file red proof and the cross-family verdict: a modified file of a bug or feature card, with `testFilesCommand`
 * and `approveAllowEdits` set, that keeps every test name, adds no skip marker, and has no fewer assertions.
 */
function testEditBlocker(f, ctx) {
  const { card, config } = ctx;
  if (f.status !== 'M') return 'only a modified test file can be proved; a deleted, renamed, or type-changed one cannot';
  if (!needsProof(card)) return 'only a bug or feature card has a red proof for an edited test';
  if (!config.approveAllowEdits) return 'approveAllowEdits is off';
  if (!config.testFilesCommand) return 'needs testFilesCommand to prove the edited file fails on base by itself';
  return shapeBlocker(f, ctx, true);
}

const APPROVED_SHAPE = 'approved allowEdits (REQ-RUN-30) keeps every test name, assertion, and skip marker count';

function staticChecks(ctx) {
  const { repo, base, from, head, card, config, changed } = ctx;
  const isTest = (p) => matchesAny(p, config.testGlobs);
  // An allowEdits path the other family approved before the edit (REQ-RUN-30) is still proved after it (REQ-GATE-44).
  const approved = (p) => matchesAny(p, card.approvedEdits ?? []);
  const allowed = (p) => matchesAny(p, card.allowEdits) && !approved(p);
  const commands = [...Object.values(config.checks), config.testCommand, config.testFilesCommand, config.heldOutCommand].filter(Boolean);
  // Runner files either side calls stay locked (REQ-GATE-40): the base may call a file the branch's fork point did not.
  const runners = new Set([from, base].flatMap((ref) => scriptPaths(showFile(ref, 'package.json', repo), commands)).map(fold));
  const lines = addedLines(from, head, repo);
  const locked = [];
  const relaxed = []; // locked files whose edit is proved non-weakening (REQ-GATE-42..44)
  const testEdits = [];
  /** Lock `problem` unless `why` is null (the edit is proved), in which case record the proof. */
  const lockUnless = (problem, why, proof) => {
    if (why === null) relaxed.push({ path: problem.path, rule: problem.rule, proof });
    else locked.push({ ...problem, ...(why ? { why } : {}) });
  };
  for (const f of changed) {
    if (f.status !== 'D' && ['120000', '160000'].includes(fileMode(head, f.path, repo)))
      locked.push({ rule: 'unsupported-mode', path: f.path });
    if (allowed(f.path)) continue;
    if (isTest(f.path) && f.status !== 'A') {
      const problem = { rule: 'existing-test-changed', path: f.path, status: f.status };
      if (approved(f.path)) {
        const why = shapeBlocker(f, ctx, false);
        const proved = why === null && needsProof(card) && Boolean(config.testFilesCommand);
        lockUnless(problem, why, proved ? 'pending test-edit-proof and test-edits' : APPROVED_SHAPE);
        if (proved) testEdits.push(f.path);
      } else {
        const why = testEditBlocker(f, ctx);
        lockUnless(problem, why, 'pending test-edit-proof and test-edits');
        if (why === null) testEdits.push(f.path);
      }
    }
    if (locksAny(f.path, config.verificationPaths)) {
      // A workflow the card names may change when it only adds (REQ-GATE-43); any other verification file stays locked.
      const named = WORKFLOW.test(f.path) && names(card, f.path);
      const why = !named
        ? undefined
        : f.status !== 'M'
          ? 'only an edit to an existing workflow can be proved'
          : workflowWeakened(showFile(from, f.path, repo), showFile(head, f.path, repo), commands);
      lockUnless(
        { rule: 'verification-file-changed', path: f.path, status: f.status },
        why,
        'workflow keeps every base job, step, needs, if, and check name',
      );
    }
    if (runners.has(fold(f.path))) locked.push({ rule: 'runner-script-changed', path: f.path, status: f.status });
    if (fold(basename(f.path)) === 'package.json' && scriptsChanged(showFile(from, f.path, repo), showFile(head, f.path, repo))) {
      // Only the root package.json holds the scripts the test command runs (REQ-GATE-42).
      const why =
        f.path === 'package.json'
          ? scriptsAppendOnly(showFile(from, f.path, repo), showFile(head, f.path, repo), [config.testCommand], config.testGlobs)
          : undefined;
      lockUnless({ rule: 'package-scripts-changed', path: f.path }, why, 'append-only test files');
    }
    if (fold(basename(f.path)) === 'package.json' && packageToolConfigChanged(showFile(from, f.path, repo), showFile(head, f.path, repo)))
      locked.push({ rule: 'package-tool-config-changed', path: f.path });
    if (
      fold(basename(f.path)) === 'pyproject.toml' &&
      !locksAny(f.path, config.verificationPaths) &&
      pyprojectToolSectionsChanged(showFile(from, f.path, repo), showFile(head, f.path, repo))
    )
      locked.push({ rule: 'verification-file-changed', path: f.path, status: f.status });
  }
  const code = lines.filter((l) => !PROSE.has(extname(l.path)) && !matchesAny(l.path, config.bypassAllow));
  // A path the card allows to edit is in scope (REQ-GATE-50); allowEdits alone never turns scope on.
  const scope = outOfScope(
    changed.map((f) => f.path),
    card.paths.length ? [...card.paths, ...card.allowEdits] : [],
  );
  ctx.testEdits = testEdits;
  return [
    { name: 'locked', problems: locked, ...(relaxed.length ? { relaxed } : {}) },
    { name: 'skip-markers', problems: findSkipMarkers(lines.filter((l) => isTest(l.path))) },
    { name: 'bypass', problems: findBypassMarkers(code) },
    { name: 'scope', problems: scope.map((path) => ({ rule: 'out-of-scope', path })) },
  ].map((r) => ({ ...r, pass: r.problems.length === 0 }));
}

/** Where the candidate left the base (REQ-GATE-40); the base itself when they share no history. */
function forkPoint(baseSha, head, repo) {
  const fork = exec('git', ['merge-base', baseSha, head], repo);
  return fork.status === 0 ? fork.stdout.trim() : baseSha;
}

/** The static stage alone on the committed HEAD (REQ-RUN-32): the same checks the gate runs first, in about 100 ms. */
export function staticStage({ repo, base, card, config }) {
  const head = revParse('HEAD', repo);
  const baseSha = revParse(base, repo);
  const from = forkPoint(baseSha, head, repo);
  return staticChecks({ repo, base: baseSha, from, head, card, config, changed: changedFiles(from, head, repo) });
}

/** Configured commands run without secret-looking (REQ-RUN-12) or coding-agent (REQ-GATE-51) environment variables. */
export const shell = (command, dir, config) => sh(command, dir, { env: checkEnv(process.env, config.workerEnvAllow) });

/**
 * Whether a runner's output names the repo file `path` (REQ-GATE-33): the path as written, or under the checkout `dir`,
 * never as part of a longer path or name, so `test/unit/a.test.js` is not `test/a.test.js` or `test/data.test.js`.
 */
const namesPath = (out, path, dir) =>
  new RegExp(`(^|[^\\w./-]|${escapeRe(`${dir}/`)}|${escapeRe(`${realpathSync(dir)}/`)})${escapeRe(path)}(?![\\w./-])`, 'm').test(out);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
/**
 * The test command for just `files` (REQ-GATE-33): each `{files}` becomes the shell-quoted paths. Paths come from git,
 * never from card text; one that starts with `-` gets `./` so a runner cannot read it as an option.
 */
const filesCommand = (config, files) =>
  config.testFilesCommand.replaceAll('{files}', files.map((p) => quote(p.startsWith('-') ? `./${p}` : p)).join(' '));
const proofFiles = ({ changed, config }) =>
  changed.filter((f) => f.status !== 'D' && matchesAny(f.path, config.testGlobs)).map((f) => f.path);

/**
 * Run a head command; on failure run it once more on the same checkout (REQ-GATE-18). A pass on the retry is
 * reported as flaky with the first failure kept, so a load-induced timeout neither escalates the model nor hides.
 */
function runHead(command, dir, config) {
  const start = Date.now();
  const first = shell(command, dir, config);
  // The time of the first run: a flaky retry doubles the wall time but says nothing about the command's speed (REQ-GATE-45).
  const ms = Date.now() - start;
  if (first.code === 0) return { code: 0, out: first.out, ms };
  const again = shell(command, dir, config);
  return again.code === 0 ? { code: 0, out: first.out, flaky: true, ms } : { ...again, ms };
}

const headResult = (name, r, rule) => ({
  ...(r.code === 0 ? { name, pass: true, problems: [] } : rule ? fail(name, rule) : { name, pass: false, problems: [] }),
  ...(typeof r.ms === 'number' ? { ms: r.ms } : {}),
  ...(r.flaky ? { flaky: true } : {}),
  ...(r.code !== 0 || r.flaky ? { output: tail(r.out) } : {}),
});

/** One `keel gate` output line per stage. */
export const stageLine = (r) =>
  `${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.flaky ? ' (flaky: failed once, passed on retry)' : ''}${r.baseRedFixed ? ` (base-red-fixed: ${r.baseRedFixed.join(', ')})` : ''}${r.fallback ? ` (fallback reviewer ${r.reviewer}; ${r.fallback.from} ${r.fallback.status})` : ''}${r.effort ? ` (re-review of a small doc change: effort ${r.effort})` : ''}${r.unavailable?.length ? ` (out: ${r.unavailable.map(outLine).join('; ')})` : ''}${r.unparsed?.length ? ` (unparsed: ${r.unparsed.join('; ')})` : ''}${r.problems.length ? ` ${JSON.stringify(r.problems)}` : ''}`;

/** Checks and the regression tests run on a fresh checkout of head, never on worker leftovers (REQ-GATE-1, -3, -13, -14). */
function candidateStages(ctx) {
  const { repo, head, card, config } = ctx;
  // Names come from the card, commands only from base keel.json (REQ-GATE-15): card text never reaches a shell.
  const unknown = card.acceptance.filter((name) => !Object.hasOwn(config.acceptance, name));
  if (unknown.length) return [fail('acceptance', 'unknown-acceptance', { names: unknown })];
  return withTempWorktree(repo, head, (dir) => {
    const installStart = Date.now();
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return [{ ...fail('install', 'install-failed'), output: tail(installed.out) }];
    const results = config.install ? [{ name: 'install', pass: true, problems: [], ms: Date.now() - installStart }] : [];
    let suiteOut = ''; // what the whole suite printed on head (REQ-GATE-33)
    for (const [name, command] of Object.entries(config.checks)) {
      const r = runHead(command, dir, config);
      if (command === config.testCommand) suiteOut = r.out;
      results.push(headResult(name, r));
      if (r.code !== 0) break;
    }
    const testedByChecks = Object.values(config.checks).includes(config.testCommand);
    if (results.every((r) => r.pass) && needsProof(card) && !testedByChecks) {
      const r = runHead(config.testCommand, dir, config);
      suiteOut = r.out;
      results.push(headResult('regression-on-head', r, 'regression-fails-on-head'));
    }
    // The red proof runs only the new files on base (REQ-GATE-33) when two things hold on head: testCommand (and CI)
    // really runs each new file, because the whole suite's output names it or a `node --test` glob of testCommand or the
    // package.json scripts it runs matches it; and the files command passes, so a runner that cannot take these files
    // fails here, not as a false "fails on base". Otherwise the red proof runs the whole suite.
    if (results.every((r) => r.pass) && needsProof(card) && config.testFilesCommand) {
      const proof = proofFiles(ctx);
      const pkg = join(dir, 'package.json');
      const globs = commandTestGlobs(existsSync(pkg) ? readFileSync(pkg, 'utf8') : null, [config.testCommand]);
      const unseen = proof.filter((p) => !namesPath(suiteOut, p, dir) && !matchesAny(p, globs));
      const r = proof.length && !unseen.length ? shell(filesCommand(config, proof), dir, config) : null; // no retry: a flaky files command is not trusted on base
      ctx.targeted = r?.code === 0;
      results.push({
        name: 'targeted-on-head',
        pass: true,
        problems: [],
        targeted: ctx.targeted,
        ...(unseen.length ? { unseen } : {}),
        ...(r?.code ? { output: tail(r.out) } : {}),
      });
    }
    for (const name of results.every((r) => r.pass) ? card.acceptance : []) {
      const r = runHead(config.acceptance[name], dir, config);
      results.push(headResult(`acceptance:${name}`, r));
      if (r.code !== 0) break;
    }
    if (revParse('HEAD', dir) !== head || trackedContentDirty(dir)) results.push(fail('integrity', 'candidate-mutated-by-checks'));
    return results;
  });
}

/**
 * Where the green baseline of this base is cached (REQ-GATE-17): one file per repository, base commit, test command,
 * install command, linked dirs, and UTC day, so a stale toolchain cannot keep a base green for longer than a day.
 */
function baseGreenFile({ repo, base, config, cacheDir }) {
  if (!cacheDir) return null;
  const day = new Date().toISOString().slice(0, 10);
  // Keyed by the repository (git common dir), not the worktree: every card's worktree shares one green base.
  const repository = realpathSync(resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim()));
  const key = [repository, base, config.testCommand, config.install ?? '', linkedDirs(config).join(','), day].join('\0');
  return join(cacheDir, 'base-green', createHash('sha256').update(key).digest('hex'));
}

/**
 * A red base baseline (REQ-GATE-52). It passes the red proof as `base-red-fixed` only when every failing file is a proof
 * file the card modifies: those are red on base and pass on head. A targeted baseline ran only such files; an untargeted
 * one must pass with them removed from the base checkout. Never recorded (REQ-GATE-17). Otherwise `baseline-not-green`
 * names the base test files the runner output names.
 */
function baseRed({ repo, base, config }, dir, proof, onBase, baseline) {
  const modified = onBase ?? proof.filter((p) => fileMode(base, p, repo));
  const outs = [baseline.out];
  const named = (files) => files.filter((p) => outs.some((out) => namesPath(out, p, dir)));
  const output = tail(baseline.out);
  // A timeout or a runner that cannot start is not a test failure; a targeted failure must name a file it ran.
  let fixed = !inconclusive(baseline) && (onBase ? named(onBase).length > 0 : false);
  let flaky = false;
  if (!onBase && modified.length && !inconclusive(baseline)) {
    for (const p of modified) {
      const err = writeInside(dir, p, (t) => unlinkSync(t));
      if (err) return fail('red-proof', 'unsafe-path', { detail: err });
    }
    const without = runHead(config.testCommand, dir, config);
    fixed = without.code === 0;
    flaky = Boolean(without.flaky);
    if (!fixed) outs.push(without.out);
  }
  if (fixed) {
    const files = named(modified);
    return {
      name: 'red-proof',
      pass: true,
      problems: [],
      files: proof,
      baseRedFixed: files.length ? files : modified,
      output,
      ...(flaky ? { flaky: true } : {}),
      ...(onBase ? { targeted: true } : {}),
    };
  }
  const tests = git(['ls-tree', '-r', '-z', '--name-only', base], repo)
    .split('\0')
    .filter((p) => p && matchesAny(p, config.testGlobs));
  const files = named(tests);
  return { ...fail('red-proof', 'baseline-not-green', files.length ? { files } : {}), output };
}

/**
 * Counterfactual regression proof (REQ-GATE-3): the base must be green, and the new tests overlaid on base
 * must fail as a real test failure that names a new test file.
 */
function redProof(ctx) {
  const { repo, base, head, card, config } = ctx;
  if (!needsProof(card)) return null;
  const proof = proofFiles(ctx);
  if (!proof.length) return fail('red-proof', 'no-test-changed');
  return withTempWorktree(repo, base, (dir) => {
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return { ...fail('red-proof', 'install-failed'), output: tail(installed.out) };
    const cached = baseGreenFile(ctx);
    let flaky = false;
    // A targeted overlay runs only the proof files, so only their base versions need a green baseline; a new file has
    // none (REQ-GATE-17). An untargeted overlay runs the whole suite, so the whole suite must be green on base.
    const onBase = ctx.targeted ? proof.filter((p) => fileMode(base, p, repo)) : null;
    if ((!cached || !existsSync(cached)) && onBase?.length !== 0) {
      const command = onBase ? filesCommand(config, onBase) : config.testCommand;
      const baseline = runHead(command, dir, config); // A load-induced base failure gets one retry too (REQ-GATE-18).
      flaky = Boolean(baseline.flaky);
      if (baseline.code !== 0) return baseRed(ctx, dir, proof, onBase, baseline);
      if (cached && !onBase) {
        mkdirSync(dirname(cached), { recursive: true });
        writeFileSync(cached, `${new Date().toISOString()}\n`); // Only a green base is cached (REQ-GATE-17).
      }
    }
    for (const p of proof) {
      const err = writeInside(dir, p, (t) => {
        const blob = showBlob(head, p, repo);
        writeFileSync(t, blob.data);
        chmodSync(t, blob.mode === '100755' ? 0o755 : 0o644);
      });
      if (err) return fail('red-proof', 'unsafe-path', { detail: err });
    }
    const r = shell(ctx.targeted ? filesCommand(config, proof) : config.testCommand, dir, config);
    const output = tail(r.out);
    if (inconclusive(r)) return { ...fail('red-proof', 'inconclusive', { code: r.code }), output };
    if (r.code === 0) {
      // A runner that lists its test files by name never runs a new file; say so instead of "passes on base" alone.
      const unseen = proof.every((p) => !r.out.includes(basename(p)));
      const hint = unseen ? { hint: 'no new test file appears in the test output: the test command may not run them' } : {};
      return { ...fail('red-proof', 'test-passes-on-base', { files: proof, ...hint }), output };
    }
    if (!proof.some((p) => r.out.includes(basename(p))))
      return { ...fail('red-proof', 'failure-not-in-new-tests', { files: proof }), output };
    return {
      name: 'red-proof',
      pass: true,
      problems: [],
      files: proof,
      output,
      ...(flaky ? { flaky: true } : {}),
      ...(ctx.targeted ? { targeted: true } : {}),
    };
  });
}

/**
 * Each edited existing test (REQ-GATE-44) by itself: it passes alone on head, and, overlaid alone on base (the other
 * edited files as on base), fails with a real test failure, so the edit is needed by the change, as REQ-GATE-3 proves
 * for a new test.
 */
function testEditProof(ctx) {
  const { repo, base, head, config } = ctx;
  const files = ctx.testEdits ?? [];
  if (!files.length) return null;
  const locked = (path, why, output) => ({
    ...fail('test-edit-proof', 'existing-test-changed', { path, why }),
    ...(output ? { output: tail(output) } : {}),
  });
  const onHead = withTempWorktree(repo, head, (dir) => {
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return { ...fail('test-edit-proof', 'install-failed'), output: tail(installed.out) };
    for (const p of files) {
      const r = shell(filesCommand(config, [p]), dir, config);
      if (r.code !== 0) return locked(p, 'fails alone on head with testFilesCommand', r.out);
    }
    return null;
  });
  if (onHead) return onHead;
  return withTempWorktree(repo, base, (dir) => {
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return { ...fail('test-edit-proof', 'install-failed'), output: tail(installed.out) };
    // One edited file at a time, the others as on base: an edit to one test must not be what makes another fail.
    for (const p of files) {
      let saved = null; // the base file, put back after the run
      const err = writeInside(dir, p, (t) => {
        saved = existsSync(t) ? { data: readFileSync(t), mode: statSync(t).mode & 0o777 } : null;
        const blob = showBlob(head, p, repo);
        writeFileSync(t, blob.data);
        chmodSync(t, blob.mode === '100755' ? 0o755 : 0o644);
      });
      if (err) return fail('test-edit-proof', 'unsafe-path', { detail: err });
      const r = shell(filesCommand(config, [p]), dir, config);
      const restored = writeInside(dir, p, (t) => {
        if (saved) {
          writeFileSync(t, saved.data);
          chmodSync(t, saved.mode);
        } else unlinkSync(t);
      });
      if (restored) return fail('test-edit-proof', 'unsafe-path', { detail: restored });
      if (inconclusive(r)) return { ...fail('test-edit-proof', 'inconclusive', { path: p, code: r.code }), output: tail(r.out) };
      if (r.code === 0) return locked(p, 'passes alone on base, so the change does not need the edit', r.out);
    }
    return { name: 'test-edit-proof', pass: true, problems: [], files };
  });
}

/** The cross-family verdict on edited existing tests (REQ-GATE-44), on the candidate's own diff (REQ-GATE-40). */
const testEdits = (ctx) => (ctx.testEdits?.length ? testEditStage({ ...ctx, files: ctx.testEdits }) : null);

const listFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));

/** Copy held-out files into a checkout of ref and run the held-out command. Never overwrites a file. */
function runHeldOut({ repo, card, config }, ref, files) {
  return withTempWorktree(repo, ref, (dir) => {
    if (prepareCheckout(repo, dir, config)) return { error: 'install-failed' };
    for (const rel of files) {
      if (existsSync(join(dir, rel))) return { error: 'held-out-overwrite' };
      if (writeInside(dir, rel, (t) => copyFileSync(join(card.heldOut, rel), t))) return { error: 'unsafe-path' };
    }
    return shell(config.heldOutCommand, dir, config);
  });
}

/**
 * Held-out tests (REQ-GATE-10): required for M/L bug/feature cards. They must pass on head and, for
 * bug/feature, fail on base — which also proves they ran. Problems never carry the path.
 */
function heldOut(ctx) {
  const { base, head, card, config } = ctx;
  const required = config.heldOutRequired.includes(card.size) && needsProof(card);
  if (!card.heldOut) return required ? fail('held-out', 'held-out-required', { size: card.size }) : null;
  if (!isAbsolute(card.heldOut) || !existsSync(card.heldOut)) return fail('held-out', 'held-out-missing');
  const files = listFiles(card.heldOut);
  if (!files.length) return fail('held-out', 'held-out-empty');
  const onHead = runHeldOut(ctx, head, files);
  if (onHead.error) return fail('held-out', onHead.error);
  if (onHead.code !== 0) return { ...fail('held-out', 'held-out-fails-on-head'), privateOutput: tail(onHead.out) };
  if (needsProof(card)) {
    const onBase = runHeldOut(ctx, base, files);
    if (onBase.error) return fail('held-out', onBase.error);
    if (onBase.code === 0 || inconclusive(onBase)) return { ...fail('held-out', 'held-out-not-executed'), privateOutput: tail(onBase.out) };
  }
  return { name: 'held-out', pass: true, problems: [], privateOutput: tail(onHead.out) };
}

/**
 * Mutation testing (REQ-GATE-20): red proof shows a new test fails on base, not that it is strong. The configured
 * command gets the changed non-test files in KEEL_CHANGED_FILES (newline-separated) on a fresh checkout of head;
 * a non-zero exit fails the stage, and its output (the surviving mutants) goes to the next attempt.
 */
function mutation(ctx) {
  const { repo, head, card, config, changed } = ctx;
  if (!config.mutation || !needsProof(card)) return null;
  const files = changed.filter((f) => f.status !== 'D' && !matchesAny(f.path, config.testGlobs)).map((f) => f.path);
  if (!files.length) return null;
  return withTempWorktree(repo, head, (dir) => {
    const installed = prepareCheckout(repo, dir, config);
    if (installed) return { ...fail('mutation', 'install-failed'), output: tail(installed.out) };
    const env = { ...checkEnv(process.env, config.workerEnvAllow), KEEL_CHANGED_FILES: files.join('\n') };
    return headResult('mutation', sh(config.mutation, dir, { env }), 'mutants-survived');
  });
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * A receipt as previousReview needs it, or null. Receipts sit where candidate code could write, and a concurrent gate
 * may still be writing one, so a file that is not JSON, or has no commit SHA head, date, or results list, is not a
 * receipt, nor is anything but a regular file (REQ-GATE-23). The head goes to git, so it must be a SHA, not an option.
 */
function readReceipt(file) {
  // Only a regular file: a directory throws, and a FIFO would block the gate forever (REQ-GATE-23).
  if (!statSync(file).isFile()) return null;
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // REQ-GATE-23: a file that is not JSON is not a receipt; any other read error stays visible.
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (!isObject(r) || typeof r.head !== 'string' || !SHA.test(r.head) || !Array.isArray(r.results)) return null;
  return Number.isFinite(Date.parse(r.at)) ? r : null;
}

/**
 * The newest earlier review of this card whose head is an ancestor of `head` (REQ-GATE-23): its blocking findings and
 * the diff since. A commit is its own ancestor, so a re-gate of an unchanged head gets that head's findings. The file prefix only narrows the read: `feature-` also matches `feature-fix-…`, so the receipt's
 * own card id decides. Receipts are written by Keel but sit where candidate code could write; a forged one only changes the
 * reviewer's prompt, which the candidate's diff can already do, and a malformed one is skipped (readReceipt).
 */
function previousReview(receiptDir, card, head, repo) {
  if (!receiptDir || !existsSync(receiptDir)) return null;
  const receipts = readdirSync(receiptDir)
    .filter((f) => f.startsWith(`${card.id}-`) && f.endsWith('.json'))
    .map((f) => readReceipt(join(receiptDir, f)))
    .filter((r) => r && r.card === card.id)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const r of receipts) {
    const review = r.results.find((x) => isObject(x) && x.name === 'review' && x.reviewer);
    if (!review || !Array.isArray(review.problems) || !review.problems.every(isObject)) continue;
    if (review.problems.some((p) => p.rule === 'review-unavailable')) continue;
    if (exec('git', ['merge-base', '--is-ancestor', r.head, head], repo).status !== 0) continue;
    const findings = review.problems.filter((p) => p.rule === 'review-finding');
    return { head: r.head, findings, delta: git(['diff', '--text', '--no-textconv', r.head, head], repo) };
  }
  return null;
}

/**
 * Time a stage (REQ-GATE-45): a stage that yields one result untimed gets the stage's wall time. Stages with several
 * results (static, candidate checks) time their own commands; the slot wait is outside, since `run` starts after it.
 */
function timed(fn) {
  const start = Date.now();
  const out = fn();
  if (out.length === 1 && out[0] && typeof out[0].ms !== 'number') out[0].ms = Date.now() - start;
  return out;
}

/**
 * Run the gate on the committed HEAD of repo against base. Stops at the first failing stage.
 * Returns the receipt; writes it when receiptDir is set.
 */
export function gate({
  repo,
  base,
  card,
  config,
  receiptDir,
  cacheDir = null,
  reviewer = null,
  spendFile = null,
  waitReviewHours = 0,
  sleep = sleepMs,
  log = () => {},
  slotDir = null,
  flaky = [],
}) {
  const head = revParse('HEAD', repo);
  const baseSha = revParse(base, repo);
  const results = [];
  const failed = () => results.some((r) => !r.pass);

  if (isDirty(repo)) results.push(fail('clean-tree', 'uncommitted-changes'));
  // Fail before any slot wait when the checks cannot find their dependencies (REQ-GATE-49).
  const missing = missingShared(repo, config);
  if (missing.length) {
    const why = (d) => `missing ${d} in ${repo}: install dependencies there or set "install" in keel.json`;
    results.push({ name: 'prepare', pass: false, problems: missing.map((d) => ({ rule: 'missing-shared-dir', path: d, detail: why(d) })) });
  }
  // What the candidate changed is measured from where it left the base (REQ-GATE-40): a merge applies exactly that, so
  // work the base gained since is never read as the candidate's. Policy and the red proof still use the base itself.
  const from = forkPoint(baseSha, head, repo);
  const ctx = {
    repo,
    base: baseSha,
    from,
    head,
    card,
    config,
    cacheDir,
    reviewer,
    spendFile,
    previous: previousReview(receiptDir, card, head, repo),
    changed: failed() ? [] : changedFiles(from, head, repo),
  };
  // Nothing to certify: a no-op head must not pass as work done (REQ-GATE-19, found when a no-op card passed in pilot round 2).
  if (!failed() && !ctx.changed.length) results.push(fail('changes', 'no-change'));
  // Stages that run the project's commands queue for a machine-wide slot (REQ-GATE-29).
  const heavy = new Set([candidateStages, redProof, testEditProof, heldOut, mutation]);
  // One start time for every stage, so a started gate keeps its place in the queue (REQ-SLOT-3).
  const slots = slotDir ? { dir: slotDir, size: fixedSlots(), since: Date.now(), log } : null;
  const review = (c) => reviewStage({ ...c, base: c.from }); // the reviewer reads the candidate's own diff (REQ-GATE-40)
  let waitMs = 0;
  for (const stage of [staticChecks, candidateStages, redProof, testEditProof, heldOut, mutation, testEdits, review]) {
    if (failed()) break;
    const run = () => timed(() => [stage(ctx)].flat().filter(Boolean));
    const asked = Date.now();
    const slotted = () => {
      waitMs += Date.now() - asked; // time queued for a gate slot (REQ-GATE-47)
      return run();
    };
    results.push(...(slots && heavy.has(stage) ? withGateSlot(slots, slotted) : run()));
  }
  // Same process, same head: only the review runs again, so no stored receipt is trusted (REQ-GATE-28).
  const last = results.at(-1);
  if (waitReviewHours > 0 && last?.name === 'review' && last.problems.some((p) => p.rule === 'review-unavailable')) {
    const ms = resetWaitMs(last.unavailable ?? []);
    if (ms !== null && ms <= waitReviewHours * 3600 * 1000) {
      log(`every reviewer is out; waiting ${Math.ceil(ms / 60000)} min for the reset, then the review runs again`);
      sleep(ms);
      results[results.length - 1] = timed(() => [review(ctx)])[0];
    }
  }
  // Stages that failed an earlier gate of this same head pass here only as flaky (REQ-RUN-34).
  for (const r of results) if (r.pass && flaky.includes(r.name)) r.flaky = true;
  const receipt = {
    version: 3,
    card: card.id,
    kind: card.kind,
    size: card.size,
    base: baseSha,
    head,
    pass: !failed(),
    results,
    at: new Date().toISOString(),
  };
  receipt.waitMs = waitMs;
  receipt.timing = timingLine(results, waitMs); // REQ-GATE-45, REQ-GATE-47
  if (receiptDir) {
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `${card.id}-${head}-${Date.now()}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    // Stage times per repository beside the receipts, and what to speed up (REQ-GATE-46).
    receipt.improve = recordGateTimes(join(dirname(receiptDir), 'gate-times.jsonl'), {
      repo,
      card: card.id,
      head,
      pass: receipt.pass,
      results,
      waitMs,
    });
  }
  return receipt;
}

const restore = (p, base) =>
  `Fix: restore ${p.path} with \`git checkout ${base} -- ${p.path}\`; it defines what passing means. Put new tests in a new test file. If the card cannot be met without changing it, write KEEL_BLOCKED saying the card needs allowEdits: ${p.path}.`;

/**
 * One repair line per failed rule (REQ-RUN-19). A rule name alone did not stop the next tier from repeating the
 * violation: in the 2026-10-06 polls tier 1 changed the same existing test that failed tier 0.
 */
const REPAIR = {
  'existing-test-changed': restore,
  'verification-file-changed': restore,
  'runner-script-changed': restore,
  'package-scripts-changed': restore,
  'package-tool-config-changed': restore,
  'bypass-marker': (p) =>
    `Fix: remove the marker at ${p.path}:${p.line} and fix what it hides; follow how existing files in this repo avoid it.`,
  'skip-marker': (p) => `Fix: remove the skip or focus marker at ${p.path}:${p.line}; every test must run.`,
  'out-of-scope': (p, base) =>
    `Fix: undo the change to ${p.path} (\`git checkout ${base} -- ${p.path}\`, or delete it if new); the card allows only its paths.`,
  'no-test-changed': () => 'Fix: add a new test file with a test that fails on the current code and passes with your change.',
  'test-passes-on-base': () => 'Fix: the new test passes on the old code too, so it proves nothing; assert the behavior the card changes.',
  'failure-not-in-new-tests': () =>
    'Fix: on the old code the failure must come from your new tests; make them run and fail on the missing behavior.',
  'mutants-survived': () => 'Fix: strengthen the tests so each surviving mutant above makes them fail.',
  'review-finding': (p) => `Fix: resolve the review finding at ${p.path}:${p.line}; if it is wrong, make the code or a test show why.`,
};

export const repairLines = (r, base) => [...new Set(r.problems.map((p) => REPAIR[p.rule]?.(p, base)).filter(Boolean))];

/** Short failure text for the next worker prompt: failing steps only, each with its repair line. Held-out details never leak. */
export function failureSummary(receipt, maxChars) {
  const text = receipt.results
    .filter((r) => !r.pass)
    .map((r) =>
      r.name === 'held-out'
        ? `## held-out\n${r.problems.map((p) => p.rule).join(', ')} (details withheld)`
        : [`## ${r.name}`, ...r.problems.map((p) => JSON.stringify(p)), ...repairLines(r, receipt.base), r.output ?? ''].join('\n'),
    )
    .join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * Milliseconds until the earliest reset time the unavailable reviewers named (REQ-GATE-26), read as the next such
 * local clock time, plus one minute; null when none named one (REQ-GATE-28).
 */
export function resetWaitMs(unavailable, now = new Date()) {
  const waits = unavailable
    .map((u) => CLOCK.exec(u.retryAt ?? ''))
    .filter(Boolean)
    .map(([, h, m, ap]) => {
      let hour = Number(h) % (ap ? 12 : 24);
      if (ap?.toLowerCase() === 'pm') hour += 12;
      const at = new Date(now);
      at.setHours(hour, Number(m ?? 0), 0, 0);
      if (at <= now) at.setDate(at.getDate() + 1);
      return at - now + 60000;
    });
  return waits.length ? Math.min(...waits) : null;
}
