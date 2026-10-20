import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { builderText, linkedDirs } from './config.js';
import { changedFiles, exec, git, isDirty, revParse, withTempWorktree } from './git.js';
import { failureSummary, gate, inconclusive, linkShared, prepareCheckout, repairLines, shell, staticStage } from './gate.js';
import { removeParkedWorktree } from './clean.js';
import { mergeReadiness } from './doctor.js';
import { GATE_CONTEXT, postGateStatus } from './status.js';
import { appendAttempt, readLedger, stateDir } from './ledger.js';
import { approveEdits, reviewerFor } from './review.js';
import { spendFile } from './window.js';
import { matchesAny } from './scan.js';
import { addUsage, runWorker } from './workers.js';
import { acquireRunLock } from './run-lock.js';

const BLOCKED_FILE = 'KEEL_BLOCKED';
const DONE_FILE = 'KEEL_DONE'; // the card is already satisfied (REQ-LINEAR-30)
const FOLLOWUP_FILE = 'KEEL_FOLLOWUP';
const MAX_FOLLOWUPS = 5;
const FOLLOWUP_KINDS = ['bug', 'feature', 'chore'];

const touchesProtected = (paths, config) => paths.some((p) => matchesAny(p.replace(/\*.*$/, 'x'), config.protected));

/** Start tier from size and protected paths (REQ-RUN-2). */
export function startTier(card, config) {
  let t = 0;
  if (card.size === 'L') t = Math.max(t, config.startTier.L);
  if (card.kind === 'infra' || touchesProtected(card.paths, config)) t = Math.max(t, config.startTier.protected);
  return Math.min(t, config.tiers.length - 1);
}

const LEARN_MIN_RUNS = 5; // fewer runs that started at a tier say nothing about its first-try pass rate
const LEARN_WINDOW = 20; // the most recent runs that started at a tier
const PROBE_AFTER = 10; // runs that started above a skipped tier before it is tried again
// First tries that say nothing about the model: the card, the provider, or Keel stopped them (REQ-RUN-21).
const NOT_THE_MODEL = new Set(['blocked', 'approved', 'quota', 'network', 'auth', 'harness-error']);
/**
 * A tier's identity in the ledger (REQ-RUN-35): rows keep it, so a reordered ladder cannot misread them. An exec tier is
 * its command too, since model and effort are optional there.
 */
export const tierLabel = (t) =>
  `${t.provider}/${t.model}/${t.effort}${t.provider === 'exec' ? `/${JSON.stringify(t.command ?? null)}` : ''}`;
const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
const usd = (x) => `$${x.toFixed(2)}`;

/**
 * Learned start tier (REQ-RUN-21). Cheapest-first saves only when the cheap attempt costs less than what it saves:
 * L < p × H, with p the tier's first-try pass rate and L, H the mean priced attempt cost at that tier and one up,
 * all from this repo's ledger. While that fails, start one tier higher. After PROBE_AFTER runs that started above a
 * skipped tier, try it again so its numbers stay current. Too little or unpriced data keeps the rule tier.
 */
export function learnedStart(rows, repo, ruleTier, config) {
  if (!config.learnStart) return { tier: ruleTier, note: null };
  // Authoring, a findings turn (REQ-RUN-38), and a refine turn (REQ-LED-17) are not attempts of a tier.
  const mine = rows.filter((r) => r.repo === repo && !['held-out-author', 'fix-findings', 'refine'].includes(r.role));
  // Rows are read by their tier label, not by the index they were written with (REQ-RUN-35): a row whose tier is no
  // longer on the ladder (-1) counts for none. A row with no label it can be matched by (no provider, an exec row
  // without tierLabel) and a ladder with twin labels keep the index.
  const labels = config.tiers.map(tierLabel);
  const unique = new Set(labels).size === labels.length;
  const at = (r) => {
    if (!unique) return r.tier;
    if (r.tierLabel) return labels.indexOf(r.tierLabel);
    return r.provider && r.provider !== 'exec' ? labels.indexOf(tierLabel(r)) : r.tier;
  };
  // A row without ruleLabel keeps how many tiers learning moved it (tier - ruleTier), measured from where it maps today.
  const ruleAt = (r) => {
    if (unique && r.ruleLabel) return labels.indexOf(r.ruleLabel);
    const i = at(r);
    return i === -1 ? -1 : i - ((r.tier ?? 0) - (r.ruleTier ?? 0));
  };
  const runs = new Map();
  // A resumed attempt re-gates a kept head without building (REQ-RUN-25): it says nothing about the tier's first try.
  // A first try that waited only for review (REQ-RUN-24) was not judged, so it is no failure either.
  for (const r of mine)
    if (r.attempt === 1 && !r.resumed && !r.pendingReview && !NOT_THE_MODEL.has(r.workerStatus) && !runs.has(r.run)) runs.set(r.run, r);
  const firsts = [...runs.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const priced = (tier) => mine.filter((r) => at(r) === tier && !r.resumed && typeof r.cost === 'number').map((r) => r.cost);
  let tier = ruleTier;
  let note = null;
  while (tier < config.tiers.length - 1) {
    const lastAt = firsts.findLastIndex((r) => at(r) === tier);
    // Only runs that learning moved above this tier count; a rule (L, protected) that starts higher says nothing.
    const skipped = firsts.slice(lastAt + 1).filter((r) => at(r) > tier && ruleAt(r) <= tier).length;
    if (lastAt !== -1 && skipped >= PROBE_AFTER) {
      note = `probe: tier ${tier} not tried first in the last ${PROBE_AFTER} runs`;
      break;
    }
    const started = firsts.filter((r) => at(r) === tier).slice(-LEARN_WINDOW);
    const L = priced(tier);
    const H = priced(tier + 1);
    if (started.length < LEARN_MIN_RUNS || !L.length || !H.length) break;
    const p = started.filter((r) => r.attemptPass).length / started.length;
    if (mean(L) < p * mean(H)) break;
    note = `learned: tier ${tier} passed first in ${started.filter((r) => r.attemptPass).length}/${started.length} runs; ${usd(mean(L))} ≥ ${Math.round(p * 100)}% × ${usd(mean(H))}`;
    tier += 1;
  }
  return { tier, note };
}

// Existing test files are locked (REQ-GATE-4): new tests go in a new test file, or the first attempt is wasted (REQ-RUN-14).
const NEW_TEST_FILE = "Put the new tests in a new test file. Do not edit any existing test file unless the card's allowEdits names it.";

const KIND_RULES = {
  bug: `First add a regression test that fails on the current code and names the requirement ID. Then fix the code. ${NEW_TEST_FILE}`,
  feature: `First add tests that fail on the current code, one per requirement, each naming its requirement ID. Then implement. ${NEW_TEST_FILE}`,
  refactor: 'Do not change any existing test file. Keep behavior identical; all existing tests must stay green.',
  ui: `Add a test (for example Playwright) that fails before the change when possible. Then implement. ${NEW_TEST_FILE}`,
  infra: 'Add or update a dry-run/plan check. Do not apply changes to real infrastructure.',
  chore: 'Keep behavior identical unless the card says otherwise.',
};

export function buildPrompt(card, config, failure, commits = '') {
  const scope = card.paths.length ? `Change only files matching: ${card.paths.join(', ')}.` : 'Change only files the card needs.';
  return [
    `You are the builder for card ${card.id} in this git worktree. Work autonomously; do not ask questions.`,
    KIND_RULES[card.kind],
    scope,
    'Never delete, skip, or weaken existing tests. Never add lint, type, or hook bypasses. No TODO placeholders.',
    `If the card is already satisfied by the current code, change nothing: write to the file ${DONE_FILE} in the worktree root one short paragraph naming the commit ("commit <sha>") or PR ("PR #<n>") that satisfied it, and stop. If the card is impossible as written, or a test or check is defective, do not work around it: write the reason in one short paragraph to the file ${BLOCKED_FILE} in the worktree root and stop. If an existing test asserts behavior the card changes, so it must change too, add one line per such file to ${BLOCKED_FILE}: allowEdits: <path>; another model may approve it and you continue.`,
    // Found work is filed for the loop, not done here or lost (REQ-RUN-26).
    `For real work outside this card (a defect, a missing test, a needed change), do not do it: append one line per item to the file ${FOLLOWUP_FILE} in the worktree root, as <bug|feature|chore>: <title> — <why, with path:line>.`,
    // Review findings are the most common gate failure; a self-review before the gate saves a cycle (REQ-RUN-43).
    'Before you finish, review your diff as a hostile reviewer would: list the input edge cases, saved or legacy data, error and catch paths, and external API limits it touches. For each, confirm a test covers it (for a behavior change, a test that fails without your change), and fix any gap.',
    // The gate runs the full checks; a worker re-running them too doubled wall time in pilot round 1 (REQ-RUN-15).
    `Before you finish, run only the checks that cover your change (the affected tests, lint or type checks on the files you changed). Do not run the full suite: the gate then runs: ${Object.values(config.checks).join(' ; ')}`,
    // Keel commits the worktree itself (REQ-RUN-7); a sandboxed worker cannot write a linked worktree's git dir (REQ-RUN-18).
    'Do not commit: leave your changes in the working tree. Keel commits them after you finish.',
    '',
    '# Card',
    builderText(card),
    // A fresh session on a kept branch must know the work is there (REQ-RUN-33).
    ...(commits ? ['', `# Your branch already has these commits:\n${commits}`, 'Build on them; do not redo their work.'] : []),
    ...(failure ? ['', '# The previous attempt failed the gate. Fix the root cause:', failure] : []),
  ].join('\n');
}

/** The prompt for a continued session (REQ-RUN-33): it already has the card and the rules, so only the failure. */
export const resumePrompt = (failure) =>
  [
    'Keel committed your changes and gated them.',
    '',
    '# The previous attempt failed the gate. Fix the root cause:',
    failure,
    '',
    `The same rules hold: do not commit; write ${BLOCKED_FILE} if the card cannot be met; file outside work in ${FOLLOWUP_FILE}.`,
  ].join('\n');

const CORRECTED = new Set(['locked', 'scope']);

/**
 * What a gate spent on models (REQ-LED-13): the review and the verdict on edited tests (REQ-GATE-44), summed; null
 * when neither ran. The cost is null when no part had one, and unpriced when a part spent tokens at no known price.
 */
export function reviewSpend(results) {
  const ran = results.filter((r) => r.name === 'review' || (r.name === 'test-edits' && (r.cost !== undefined || r.usage !== undefined)));
  if (!ran.length) return null;
  const edits = ran.find((r) => r.name === 'test-edits');
  const costs = ran.map((r) => r.cost).filter((c) => typeof c === 'number');
  return {
    reviewer: ran.find((r) => r.name === 'review')?.reviewer ?? edits?.reviewer ?? edits?.approval?.by ?? null,
    reviewCost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    reviewUsage: ran.reduce((u, r) => addUsage(u, r.usage ?? null), null),
    reviewUnpriced: ran.some((r) => r.unpriced),
  };
}

/**
 * The corrective turn's text (REQ-RUN-32): every locked or out-of-scope path with its rule, the rule to follow, and the
 * repair lines the gate would give (which keep the REQ-RUN-30 allowEdits way open for an edit the card truly needs).
 */
function correctiveText(failed, base) {
  const problems = failed.flatMap((r) => r.problems);
  return [
    'Keel checked your work before the full gate. These edits fail it:',
    ...problems.map((p) => `- ${p.rule}: ${p.path}${p.why ? ` (${p.why})` : ''}`),
    'Revert your edits to these locked files; put new tests in new files. Undo changes to files outside the card paths.',
    ...failed.flatMap((r) => repairLines(r, base)),
  ].join('\n');
}

/** A later call may continue a session only on the same CLI (REQ-RUN-33); for exec, the same command. */
const sameCli = (a, b) => a.provider === b.provider && (a.provider !== 'exec' || JSON.stringify(a.command) === JSON.stringify(b.command));

/** Two worker calls of one attempt as one (REQ-RUN-32): spend summed, unknown when either is unknown; the last call's outcome. */
function combine(a, b) {
  const sum = (x, y) => (x === null || y === null || x === undefined || y === undefined ? null : x + y);
  const usage =
    a.usage && b.usage
      ? {
          in: a.usage.in + b.usage.in,
          ...(a.usage.cacheWrite || b.usage.cacheWrite ? { cacheWrite: (a.usage.cacheWrite ?? 0) + (b.usage.cacheWrite ?? 0) } : {}),
          out: a.usage.out + b.usage.out,
          cached: a.usage.cached + b.usage.cached,
        }
      : null;
  return { ...b, usage, cost: sum(a.cost, b.cost), durationMs: a.durationMs + b.durationMs };
}

const authorPrompt = (card) =>
  [
    `You write held-out acceptance tests for card ${card.id} in this git worktree. Another agent implements the card later without seeing your tests; the gate then runs them.`,
    'Write tests only, in new test files, at least one per requirement, each naming its requirement ID. Do not change any other file and do not commit.',
    'Each test must fail on the current code because the required behavior is missing, and pass once the card is implemented as written.',
    'Test only behavior the card states, through interfaces the card or the existing code names. Do not depend on new internal names the card does not give.',
    '',
    '# Card',
    builderText(card),
  ].join('\n');

/** A card needs authored held-out tests when the gate will require them (REQ-GATE-10) and it names none (REQ-RUN-17). */
const needsAuthoring = (card, config) =>
  !card.heldOut &&
  config.heldOutAuthorTier !== null &&
  config.heldOutRequired.includes(card.size) &&
  ['bug', 'feature'].includes(card.kind);

/** A file a test runner discovers by its own name; support files (conftest.py, __init__.py, helpers) are not. */
const TEST_FILE = /\.(test|spec)\.[^.]+$|^test_.+\.py$|_test\.[^.]+$/i;

/**
 * The name an authored held-out test is kept under (REQ-RUN-17): `heldout_` before the file name, after a leading
 * `test_`, so the builder, which writes the obvious test file for the card, never takes the same path and makes the
 * gate refuse to overwrite it. Support files, and names that would no longer match `testGlobs`, keep their name.
 */
export function heldOutName(p, config) {
  const name = basename(p);
  if (!TEST_FILE.test(name)) return p;
  const renamed = join(
    dirname(p),
    name.replace(/^(test_)?/i, (prefix) => `${prefix}heldout_`),
  );
  return matchesAny(renamed, config.testGlobs) ? renamed : p;
}

/**
 * The heldOutName of each authored file, but only when the tests, renamed on the base checkout, still fail there as a
 * real failure that names a renamed file; otherwise the original names (a rename that breaks an import proves nothing).
 */
function keptNames(dir, added, config) {
  const renamed = added.map((p) => heldOutName(p, config));
  if (renamed.every((p, i) => p === added[i])) return added;
  const move = (from, to) => from.forEach((p, i) => p !== to[i] && renameSync(join(dir, p), join(dir, to[i])));
  move(added, renamed);
  const r = shell(config.heldOutCommand, dir, config);
  move(renamed, added);
  const ok = !inconclusive(r) && r.code !== 0 && renamed.some((p, i) => p !== added[i] && r.out.includes(basename(p)));
  return ok ? renamed : added;
}

/**
 * Held-out tests from the author tier (REQ-RUN-17), written on a temporary checkout of base the builder never sees.
 * They are kept only when they fail on base as a real test failure that names them. Returns an error text, or null.
 */
function authorHeldOut({ repo, card, config, baseSha, runId, heldDir, log }) {
  const index = config.heldOutAuthorTier;
  const t = config.tiers[index];
  log(`held-out author: tier ${index} ${t.provider}/${t.model}/${t.effort}`);
  const row = {
    run: runId,
    card: card.id,
    repo: resolve(repo),
    base: baseSha,
    attempt: 0,
    role: 'held-out-author',
    tier: index,
    provider: t.provider,
    model: t.model,
    effort: t.effort,
    gatePass: false,
    head: null,
  };
  try {
    return withTempWorktree(repo, baseSha, (dir) => {
      const installed = prepareCheckout(repo, dir, config);
      if (installed) return `install failed:\n${installed.out.slice(-2000)}`;
      const w = runWorker(t, authorPrompt(card), dir, config);
      Object.assign(row, { workerStatus: w.status, usage: w.usage, cost: w.cost, durationMs: w.durationMs });
      if (w.status !== 'ok') return `author worker ${w.status}:\n${w.output}`;
      git(['add', '-A'], dir);
      const added = git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z', baseSha], dir)
        .split('\0')
        .filter((p) => p && matchesAny(p, config.testGlobs));
      if (!added.length) return 'the author wrote no new test file';
      const r = shell(config.heldOutCommand, dir, config);
      const out = r.out.slice(-2000);
      if (inconclusive(r)) return `the authored tests did not run (exit ${r.code}):\n${out}`;
      if (r.code === 0) return `the authored tests pass on base, so they prove nothing:\n${out}`;
      if (!added.some((p) => r.out.includes(basename(p)))) return `the failure on base does not name an authored test file:\n${out}`;
      const kept = keptNames(dir, added, config);
      rmSync(heldDir, { recursive: true, force: true }); // Only Keel's own per-card directory under its state dir.
      for (const [i, p] of kept.entries()) {
        mkdirSync(dirname(join(heldDir, p)), { recursive: true });
        copyFileSync(join(dir, added[i]), join(heldDir, p));
      }
      return null;
    });
  } finally {
    appendAttempt({ usage: null, durationMs: 0, workerStatus: 'harness-error', ...row });
  }
}

function excludeShared(repo, dirs) {
  const file = resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim(), 'info', 'exclude');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = dirs.map((d) => `/${d}`).filter((e) => !current.split('\n').includes(e));
  if (missing.length) appendFileSync(file, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`);
}

/**
 * Commit whatever the worker left uncommitted (REQ-RUN-7). Returns an error text when hooks reject it or the worker left
 * the branch. A worker that left the branch fails this attempt only: the worktree goes back on the branch, its
 * uncommitted and untracked changes discarded, so the next tier starts from the last commit Keel made there.
 */
function commitLeftovers(wt, card, attempt, branch) {
  const current = exec('git', ['symbolic-ref', '-q', 'HEAD'], wt).stdout.trim();
  if (current !== `refs/heads/${branch}`) {
    git(['checkout', '-q', '-f', branch], wt);
    git(['clean', '-q', '-fd'], wt);
    return `worker left branch ${branch} (HEAD is ${current || 'detached'}); stay on it`;
  }
  if (!isDirty(wt)) return null;
  git(['add', '-A'], wt);
  const r = exec('git', ['commit', '-q', '-m', `chore(${card.id}): keel attempt ${attempt} leftovers`], wt);
  return r.status === 0 ? null : `commit failed (hooks?):\n${`${r.stdout}${r.stderr}`.slice(-2000)}`;
}

/** Statuses that say nothing about the work: the next tier, or the next run, continues it as it is (REQ-RUN-44). */
const KEEP_DIRTY = new Set(['ok', 'approved', 'auth', 'quota', 'network']);
const onBranch = (wt, branch) => exec('git', ['symbolic-ref', '-q', 'HEAD'], wt).stdout.trim() === `refs/heads/${branch}`;

/**
 * Commit what a worker that ended other than `ok` left behind (REQ-RUN-44), so the parked worktree is clean and the
 * cleanup can remove it (REQ-CLEAN-6). When a hook rejects the commit, the diff is saved as a patch under the state
 * dir and this run worktree only is reset to its HEAD (REQ-RUN-45). Returns the commit error, or null.
 */
function parkLeftovers(wt, card, attempt, branch, log) {
  const error = commitLeftovers(wt, card, attempt, branch);
  if (!error || !onBranch(wt, branch) || !isDirty(wt)) return error;
  const patch = git(['diff', '--binary', 'HEAD'], wt);
  const dir = join(stateDir(), 'leftovers');
  mkdirSync(dir, { recursive: true });
  // A later run of the same card never overwrites an earlier patch: `wx` fails when the file exists.
  let file;
  for (let n = 1; ; n++) {
    file = join(dir, `${card.id}-attempt-${attempt}${n === 1 ? '' : `-${n}`}.patch`);
    try {
      writeFileSync(file, patch, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  // Keel's own run worktree on its own keel/<card> branch, never the user's checkout; the work is in the patch.
  git(['reset', '-q', '--hard'], wt);
  git(['clean', '-q', '-fd'], wt);
  log(`attempt ${attempt}: the leftovers commit failed; saved the diff to ${file} and reset the worktree`);
  return error;
}

/**
 * Work the worker found outside the card (REQ-RUN-26): read and remove FOLLOWUP_FILE so it is never committed.
 * Lines are `<kind>: <title> — <detail>`; a line without a known kind is a chore.
 */
function takeFollowUps(wt) {
  const file = join(wt, FOLLOWUP_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  rmSync(file);
  return lines
    .map((l) => l.trim().slice(0, 300))
    .filter(Boolean)
    .map((l) => {
      const m = /^([a-z]+):\s*(.*)$/i.exec(l);
      const known = m && FOLLOWUP_KINDS.includes(m[1].toLowerCase());
      const [title, ...rest] = (known ? m[2] : l).split(' — ');
      return { kind: known ? m[1].toLowerCase() : 'chore', title: title.trim(), detail: rest.join(' — ').trim() };
    })
    .filter((f) => f.title);
}

/** Add found work to `list`, keeping titles distinct (case-insensitive) and at most MAX_FOLLOWUPS (REQ-RUN-26). */
function addFollowUps(list, found) {
  for (const f of found) {
    if (list.length >= MAX_FOLLOWUPS) break;
    if (!list.some((x) => x.title.toLowerCase() === f.title.toLowerCase())) list.push(f);
  }
}

/**
 * The existing test files a blocked worker asks to edit (`allowEdits: <path>` lines, REQ-RUN-30). Every path must be a
 * test file that exists at base, is not a verification file (keel.json, runner configs), and is not allowed yet;
 * otherwise nothing is asked, so policy files never reach approval.
 */
function editRequest(reason, card, config, baseSha, wt) {
  const paths = [...reason.matchAll(/^allowEdits:\s*(.+)$/gim)].flatMap((m) => m[1].split(/[\s,]+/)).filter(Boolean);
  const ok = (p) =>
    exec('git', ['cat-file', '-e', `${baseSha}:${p}`], wt).status === 0 &&
    matchesAny(p, config.testGlobs) &&
    !matchesAny(p, config.verificationPaths) &&
    !matchesAny(p, card.allowEdits);
  return paths.length && paths.every(ok) ? [...new Set(paths)] : [];
}

/**
 * A worker that reports the card blocked leaves BLOCKED_FILE (REQ-RUN-13), or DONE_FILE when it is already satisfied
 * (REQ-LINEAR-30): a blocked stop whose reason says so, for `keel poll` to verify. Read and remove both so neither is
 * ever committed.
 */
function takeBlockedReason(wt) {
  const doneFile = join(wt, DONE_FILE);
  if (existsSync(doneFile)) {
    const done = readFileSync(doneFile, 'utf8').trim().slice(0, 2000);
    rmSync(doneFile);
    rmSync(join(wt, BLOCKED_FILE), { force: true });
    return `already satisfied: ${done || '(no evidence given)'}`;
  }
  const file = join(wt, BLOCKED_FILE);
  if (!existsSync(file)) return null;
  const reason = readFileSync(file, 'utf8').trim().slice(0, 2000);
  rmSync(file);
  return reason || '(no reason given)';
}

const stageDetail = (r) =>
  r.name === 'red-proof' && r.files?.length
    ? `failed on base, passes on head: ${r.files.join(', ')}`
    : r.name === 'held-out'
      ? 'path withheld'
      : r.name === 'review'
        ? `by ${r.reviewer}${r.notes?.length ? `; non-blocking: ${r.notes.map((n) => `${n.severity} ${n.path}:${n.line} ${n.text}`).join('; ')}` : ''}${r.unparsed?.length ? `; unparsed: ${r.unparsed.join('; ')}` : ''}`
        : '';

/**
 * PR body: what the gate proved, so review can start from the evidence (REQ-RUN-16). Held-out paths never
 * appear (REQ-GATE-10); a run with any unpriced attempt shows cost n/a rather than a low number.
 */
export function prBody({ card, receipt, tier, attempt, cost }) {
  const rows = receipt.results.map(
    (r) => `| ${r.name} | pass${r.flaky ? ' (flaky: failed once, passed on retry)' : ''} | ${stageDetail(r)} |`,
  );
  const closes = /^[A-Z]+-\d+$/.test(card.id) ? `\n\nCloses ${card.id}` : '';
  return [
    `Built by keel. Gate passed on ${receipt.head} against ${receipt.base}.`,
    '',
    '| Stage | Result | Evidence |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `Passed on tier ${tier.index} (${tier.provider}/${tier.model}/${tier.effort}), attempt ${attempt} of the run; run cost ${cost === null ? 'n/a' : `$${cost.toFixed(2)}`}.${closes}`,
  ].join('\n');
}

/** Publish the branch and open a PR with argv only — card text never reaches a shell (REQ-RUN-4). */
function pushCertified(wt, branch, receipt) {
  if (git(['rev-parse', `refs/heads/${branch}`], wt).trim() !== receipt.head)
    return { ok: false, out: 'branch tip is not the certified commit' };
  const push = exec('git', ['push', '-u', 'origin', `${receipt.head}:refs/heads/${branch}`], wt);
  return { ok: push.status === 0, out: `${push.stdout}${push.stderr}` };
}

function openPr(wt, { branch, baseBranch, card, draft, body }) {
  const args = [
    'pr',
    'create',
    '--head',
    branch,
    '--base',
    baseBranch,
    '--title',
    card.title,
    '--body',
    body,
    ...(draft ? ['--draft'] : []),
  ];
  const pr = exec('gh', args, wt);
  return { ok: pr.status === 0, out: `${pr.stdout}${pr.stderr}`.trim() };
}

/**
 * Auto-merge policy (REQ-RUN-20, DESIGN §9): tested and reviewed, required checks on the base branch, and held-out
 * tests for a protected, infra, or L change. Otherwise the PR stays open (a draft when risky) with the reason. When
 * only GitHub auto-merge itself is unavailable, `selfMerge` marks the PR for `keel poll --merge` to merge (REQ-MERGE-1).
 */
function mergePolicy({ wt, baseBranch, config, receipt, needsReview }) {
  const ready = mergeReadiness({ repo: wt, branch: baseBranch, config });
  if (!ready.ready && !ready.fallback) return { state: 'off', reason: ready.reason };
  if (needsReview && !receipt.results.some((r) => r.name === 'held-out' && r.pass))
    return { state: 'off', reason: 'protected change without held-out tests' };
  return ready.ready ? { state: 'auto', reason: null } : { state: 'off', reason: ready.reason, selfMerge: true };
}

const SELF_MERGE_LINE = '; keel poll --merge merges this certified SHA itself once every check on it passes';

/** The PR body's `Auto-merge:` line for a merge state (REQ-RUN-20, REQ-MERGE-1); empty without `--merge`. */
const autoMergeLine = (m) =>
  m ? `\n\nAuto-merge: ${m.state === 'auto' ? 'on' : `off — ${m.reason}${m.selfMerge ? SELF_MERGE_LINE : ''}`}` : '';

/** The PR URL: the last line `gh pr create` printed. */
const prUrl = (prResult) => prResult.out.trim().split('\n').at(-1);

/** GitHub merges exactly the certified commit, and only after the required checks pass (REQ-RUN-20). */
function enableAutoMerge(wt, prResult, head) {
  if (!prResult?.ok) return { state: 'failed', reason: 'the PR was not opened' };
  const r = exec('gh', ['pr', 'merge', prUrl(prResult), '--auto', '--squash', '--match-head-commit', head], wt);
  // GitHub refused auto-merge on an open PR: `keel poll --merge` may still merge the certified SHA itself (REQ-MERGE-1).
  return r.status === 0
    ? { state: 'auto', reason: null }
    : { state: 'failed', reason: `${r.stdout}${r.stderr}`.trim().slice(-500), selfMerge: true };
}

/** Gate the worktree's HEAD for this card with the builder's cross-family reviewer. */
const gateWorktree = ({ wt, baseSha, card, config, t, log, flaky = [] }) => {
  const receipt = gate({
    flaky,
    repo: wt,
    base: baseSha,
    card,
    config,
    receiptDir: join(stateDir(), 'receipts'),
    cacheDir: join(stateDir(), 'cache'),
    reviewer: reviewerFor(config, t),
    spendFile: spendFile(),
    slotDir: join(stateDir(), 'locks'), // REQ-GATE-29
    log,
  });
  for (const line of receipt.improve ?? []) log(line); // REQ-GATE-46
  return receipt;
};

/** Everything a run spent so far: attempts, held-out authoring, review, findings turns (REQ-RUN-22); unpriced rows cannot count. */
const runSpent = (runId) =>
  readLedger()
    .filter((r) => r.run === runId)
    .reduce((n, r) => n + (typeof r.cost === 'number' ? r.cost : 0) + (typeof r.reviewCost === 'number' ? r.reviewCost : 0), 0);

const FIX_KINDS = ['bug', 'feature'];
const DISMISS = /^KEEL_DISMISS\s+(\S+):(\d+)\s+(.+)$/gm;

/** The text of the corrective turn on review notes (REQ-RUN-36). */
export const fixFindingsText = (notes) =>
  [
    'Keel committed your changes and the gate passed. The cross-family review left these findings below the blocking level:',
    ...notes.map((n) => `- ${n.severity} ${n.path}:${n.line} ${n.text}`),
    'Fix each one that is real, with a test where it is a behaviour; for one that is not real, reply why in KEEL_DISMISS lines (`KEEL_DISMISS <path>:<line> <reason>`) and change nothing for it.',
    `The same rules hold: do not commit; put new tests in new test files; write ${BLOCKED_FILE} if a fix cannot be made; file outside work in ${FOLLOWUP_FILE}.`,
  ].join('\n');

/**
 * One corrective turn on the review notes of a passing attempt (REQ-RUN-36), continuing the attempt's session
 * (REQ-RUN-33). Returns the receipt to accept and the turn's cost: the new one when the re-gate passes, else the earlier
 * passing one with the worktree reset to its head (REQ-RUN-37). Appends its own ledger row (REQ-RUN-38).
 */
function fixFindings({ wt, card, config, t, attempt, branch, baseSha, receipt, notes, session, row, followUps, log }) {
  const passed = receipt.head;
  log(`attempt ${attempt}: one corrective turn on ${notes.length} review note${notes.length === 1 ? '' : 's'} (tier ${row.tier})`);
  const { run, card: id, repo, base, tier, provider, model, effort, ruleTier, tierLabel: label, ruleLabel, cardHash, builderHash } = row;
  const out = {
    run,
    card: id,
    repo,
    base,
    attempt,
    tier,
    provider,
    model,
    effort,
    ruleTier,
    tierLabel: label,
    ruleLabel,
    cardHash,
    builderHash,
    role: 'fix-findings',
    notes: notes.length,
    gatePass: true, // the attempt is accepted whatever the turn does (REQ-RUN-37)
    head: passed,
    continued: true,
  };
  let why;
  let accepted = receipt;
  try {
    const w = runWorker(t, fixFindingsText(notes), wt, config, session.id);
    Object.assign(out, { workerStatus: w.status, usage: w.usage, cost: w.cost, durationMs: w.durationMs });
    if (w.session) out.session = w.session;
    out.dismissed = [...(w.text ?? '').matchAll(DISMISS)].map((m) => ({ path: m[1], line: Number(m[2]), reason: m[3].trim() }));
    const blocked = takeBlockedReason(wt);
    addFollowUps(followUps, takeFollowUps(wt));
    why = w.status !== 'ok' ? `worker ${w.status}` : blocked !== null ? 'the worker blocked' : commitLeftovers(wt, card, attempt, branch);
    if (!why && revParse('HEAD', wt) === passed && !isDirty(wt)) out.outcome = 'unchanged';
    if (!why && !out.outcome) {
      const start = Date.now();
      const next = gateWorktree({ wt, baseSha, card, config, t, log });
      out.gateMs = Date.now() - start;
      Object.assign(out, reviewSpend(next.results)); // REQ-LED-13
      if (next.pass) {
        Object.assign(out, { outcome: 'fixed', head: next.head });
        accepted = next;
      } else
        why = `the gate failed (${next.results
          .filter((r) => !r.pass)
          .map((r) => r.name)
          .join(', ')})`;
    }
  } catch (error) {
    // REQ-RUN-37 allows this catch: an error in the optional turn (worker, commit, re-gate) must not lose the attempt
    // that already passed. It is logged and recorded on the row, never swallowed silently.
    why = `error: ${error.message}`;
    out.error = error.message.slice(0, 2000);
  }
  try {
    if (!out.outcome) {
      // REQ-RUN-37: never lose a passing result. This is Keel's own run worktree on its own keel/<card> branch, never
      // the user's checkout, so a hard reset to the head the gate passed is safe here. The worktree goes back on the
      // card's branch first, so a worker that switched branches or detached cannot make the reset move another ref.
      git(['checkout', '-q', '-f', branch], wt);
      git(['reset', '-q', '--hard', passed], wt);
      git(['clean', '-q', '-fd'], wt);
      log(`findings turn: ${why}; back to the passing head ${passed}`);
      out.outcome = 'reverted';
    }
  } catch (error) {
    // A worktree Keel cannot put back at the passing head cannot be accepted: the error goes on, after the row.
    Object.assign(out, { outcome: 'restore-failed', error: `restore: ${error.message}`.slice(0, 2000) });
    throw error;
  } finally {
    appendAttempt({ usage: null, durationMs: 0, workerStatus: 'harness-error', ...out });
  }
  return { receipt: accepted, cost: out.cost ?? null };
}

const MAX_NETWORK_RETRIES = 2; // A stronger model fixes nothing about a dropped connection; retry the same tier this many times first.

/**
 * Next tier after a failure (REQ-RUN-3, REQ-RUN-6, REQ-RUN-11): quota moves to another provider; a
 * network failure retries the same tier up to MAX_NETWORK_RETRIES times, then escalates like an
 * ordinary error would (a persistent "network" failure is more likely a real provider outage the ladder
 * should still climb past); anything else climbs one tier. `networkRetries` is the count already used
 * at the current tier, passed by the caller since nextTier itself is stateless.
 */
export function nextTier(tiers, tier, floor, status, networkRetries = 0) {
  if (status === 'quota') {
    // At or above the floor, and never the provider that is out (REQ-RUN-6).
    const other = tiers.findIndex((t, i) => i > tier && i >= floor && t.provider !== tiers[tier].provider);
    return other === -1 ? null : other;
  }
  if (status === 'network' && networkRetries < MAX_NETWORK_RETRIES) return tier;
  return Math.max(floor, Math.min(tier + 1, tiers.length - 1));
}

/**
 * The tier to use when `reserved` providers are over a plan window (REQ-PLAN-3): `tier` itself when its provider is not
 * reserved, else the next tier the quota rule (REQ-RUN-6) gives that is not reserved either, or null.
 */
export function skipReserved(tiers, tier, floor, reserved, log = () => {}) {
  while (tier !== null && reserved.has(tiers[tier].provider)) {
    log(`tier ${tier} skipped: ${tiers[tier].provider} plan window ${reserved.get(tiers[tier].provider)}`);
    tier = nextTier(tiers, tier, floor, 'quota');
  }
  return tier;
}

/** The one-line (blocked: multi-line) message `keel run` prints when it stops without a pass (REQ-RUN-13). */
export const describeStop = ({ stopped, failure, worktree }) =>
  `STOPPED (${stopped})${stopped === 'blocked' ? `: the worker reports the card blocked:\n${failure}\n` : ' —'} ${worktree ? `worktree kept at ${worktree}` : `no worktree kept: ${failure}`}`;

/** Attempt loop: cheapest tier first, escalate on failure, stop on auth, exhausted quota, or a blocked card. */
export function run({ repo, card, config, base = 'HEAD', pr = false, merge = false, reserved = new Map(), log = () => {} }) {
  const baseSha = revParse(base, repo);
  const baseBranch = base === 'HEAD' ? git(['symbolic-ref', '--short', 'HEAD'], repo).trim() : base.replace(/^origin\//, '');
  const branch = `keel/${card.id}`;
  const repoKey = createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8);
  const key = `${basename(repo)}-${repoKey}-${card.id}`;
  const wt = join(stateDir(), 'worktrees', key);
  const releaseLock = acquireRunLock(join(stateDir(), 'locks', key));
  try {
    return runLocked({ repo, card, config, base, baseSha, baseBranch, branch, wt, pr: pr || merge, merge, reserved, log });
  } finally {
    releaseLock();
  }
}

/** Identity of a card as written, so a kept head is reused only for the card it was built for (REQ-RUN-25). */
const hashOf = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const cardHash = hashOf;

/**
 * The last attempt of this card in this repo, when it stopped only for an unavailable reviewer (REQ-RUN-24) and its
 * head is still the clean tip of the card's worktree. `stale` is true when the base, the card, or the tier ladder
 * has changed since, so the head must be built again.
 */
function keptHead({ repo, card, config, baseSha, branch, wt }) {
  // A refine turn (REQ-LED-17) is not an attempt: it must not hide a kept head.
  const last = readLedger().findLast((r) => r.card === card.id && r.repo === resolve(repo) && !r.poll && r.role !== 'refine');
  if (!last?.pendingReview) return null;
  if (!existsSync(wt)) {
    // The worktree is gone; a branch still at the kept head is Keel's own and is deleted so the card builds again.
    if (exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).stdout.trim() === last.head) {
      git(['worktree', 'prune'], repo);
      git(['branch', '-D', branch], repo);
    }
    return null;
  }
  if (isDirty(wt)) return null;
  const tip = exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], wt).stdout.trim();
  // A deleted branch ref protects no work: the worktree is stale. A tip elsewhere may hold work Keel did not make.
  if (!tip) return { row: last, stale: true };
  if (tip !== last.head) return null;
  // The worktree must still have the kept branch checked out at that head, or the next worker would build elsewhere.
  const onHead =
    exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], wt).stdout.trim() === branch &&
    exec('git', ['rev-parse', 'HEAD'], wt).stdout.trim() === last.head;
  // The tier that built the head must be the same entry (provider, family, model, effort, command), so the author family
  // and the reviewer picked against it hold; the reviewer tier itself may change, that is why the run waited.
  const builder = config.tiers[last.tier];
  const stale = !onHead || last.base !== baseSha || last.cardHash !== cardHash(card) || !builder || last.builderHash !== hashOf(builder);
  return { row: last, stale };
}

function runLocked({ repo, card, config, baseSha, baseBranch, branch, wt, pr, merge, reserved, log }) {
  const hash = cardHash(card);
  let kept = keptHead({ repo, card, config, baseSha, branch, wt });
  if (kept?.stale) {
    // Built on an old base, for an older card or ladder, or moved off: its verdict would not hold now (REQ-RUN-25).
    log(`kept head ${kept.row.head} is on an old base, card, or builder tier, or no longer checked out; building again`);
    removeParkedWorktree({ repo, path: wt, branch });
    kept = null;
  }
  if (!kept) {
    // Before a worktree or any worker call: nothing may use a window kept for the owner (REQ-PLAN-3).
    const author = needsAuthoring(card, config) ? config.tiers[config.heldOutAuthorTier] : null;
    const blocked = config.tiers.every((t) => reserved.has(t.provider))
      ? 'every tier'
      : author && reserved.has(author.provider)
        ? `the held-out author (tier ${config.heldOutAuthorTier})`
        : null;
    if (blocked) {
      const why = [...reserved].map(([p, w]) => `${p} ${w}`).join('; ');
      log(`${blocked} is on a provider over its plan window: ${why}`);
      return { pass: false, stopped: 'quota', branch, worktree: null, failure: `${blocked} is on a provider over its plan window: ${why}` };
    }
  }
  if (kept) log(`gating the kept head ${kept.row.head} again; it waited for review (tier ${kept.row.tier})`);
  else {
    if (existsSync(wt)) throw new Error(`worktree exists: ${wt} — inspect it, then: git worktree remove --force ${wt}`);
    git(['worktree', 'add', '--quiet', '-b', branch, wt, baseSha], repo);
  }
  excludeShared(repo, linkedDirs(config));
  linkShared(repo, wt, linkedDirs(config));

  const runId = randomUUID();
  if (needsAuthoring(card, config)) {
    const heldDir = join(stateDir(), 'heldout', basename(wt));
    const error = kept && existsSync(heldDir) ? null : authorHeldOut({ repo, card, config, baseSha, runId, heldDir, log });
    if (error) {
      // No build attempt ran: the worktree and branch this run made hold no work, and would block the next run (REQ-RUN-41).
      if (!kept) removeParkedWorktree({ repo, path: wt, branch });
      return { pass: false, stopped: 'held-out-author', branch, worktree: wt, failure: error };
    }
    card = { ...card, heldOut: heldDir }; // The card text, and so the builder prompt, never carries this path (REQ-GATE-10).
  }
  const ruleTier = startTier(card, config);
  const learned = learnedStart(readLedger(), resolve(repo), ruleTier, config);
  if (learned.note) log(`start tier ${learned.tier} (${learned.note})`);
  let tier = kept ? kept.row.tier : learned.tier;
  let floor = Math.min(tier, learned.tier);
  if (!kept) {
    const usable = skipReserved(config.tiers, tier, floor, reserved, log);
    if (usable === null) {
      // No attempt ran: the worktree and branch hold no work and would block the next run (REQ-PLAN-3, REQ-RUN-41).
      removeParkedWorktree({ repo, path: wt, branch });
      const why = [...reserved].map(([p, w]) => `${p} ${w}`).join('; ');
      return {
        pass: false,
        stopped: 'quota',
        branch,
        worktree: null,
        failure: `every usable tier's provider is over its plan window: ${why}`,
      };
    }
    tier = usable;
  }
  let failure = null;
  let networkRetries = 0;
  let runCost = 0; // null once any attempt is unpriced (REQ-RUN-16)
  const followUps = []; // found work across all attempts (REQ-RUN-26, -27)
  const approvedEdits = []; // allowEdits the other family approved (REQ-RUN-30)
  let session = null; // the last CLI session and its tier, continued when the next call is the same CLI (REQ-RUN-33)
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const t = config.tiers[tier];
    log(`attempt ${attempt}: tier ${tier} ${t.provider}/${t.model}/${t.effort}`);
    const row = {
      run: runId,
      card: card.id,
      repo: resolve(repo),
      base: baseSha,
      attempt,
      tier,
      provider: t.provider,
      model: t.model,
      effort: t.effort,
      ruleTier,
      tierLabel: tierLabel(t),
      ruleLabel: tierLabel(config.tiers[ruleTier]),
      cardHash: hash,
      builderHash: hashOf(t),
      gatePass: false,
      head: null,
    };
    let w;
    let receipt = null;
    let commitError = null;
    let blocked = null;
    /** One worker call, continuing the last session when it is the same CLI (REQ-RUN-33). */
    const turn = (text) => {
      const resume = session && sameCli(session.tier, t) ? session.id : null;
      const prompt = resume
        ? resumePrompt(text)
        : buildPrompt(card, config, text, git(['log', '--oneline', `${baseSha}..HEAD`], wt).trim());
      const r = runWorker(t, prompt, wt, config, resume);
      if (resume) row.continued = true;
      session = r.session ? { tier: t, id: r.session } : null;
      if (r.session) row.session = r.session;
      return r;
    };
    try {
      // The first attempt of a resumed run gates the kept head instead of building (REQ-RUN-25).
      w = kept ? { status: 'ok', usage: null, cost: 0, durationMs: 0, output: '' } : turn(failure);
      if (kept) row.resumed = true;
      kept = null;
      blocked = takeBlockedReason(wt);
      addFollowUps(followUps, takeFollowUps(wt));
      // A locked or out-of-scope edit is fixed by the same tier, not escalated: a stronger tier repeats it (REQ-RUN-32).
      if (blocked === null && w.status === 'ok' && !row.resumed) {
        commitError = commitLeftovers(wt, card, attempt, branch);
        const failed = commitError
          ? []
          : staticStage({ repo: wt, base: baseSha, card, config }).filter((r) => !r.pass && CORRECTED.has(r.name));
        if (failed.length) {
          const problems = failed.flatMap((r) => r.problems);
          row.corrective = { rules: [...new Set(problems.map((p) => p.rule))], paths: [...new Set(problems.map((p) => p.path))] };
          log(
            `attempt ${attempt}: ${row.corrective.rules.join(', ')} on ${row.corrective.paths.join(', ')}; one corrective turn on tier ${tier}`,
          );
          w = combine(w, turn(correctiveText(failed, baseSha)));
          blocked = takeBlockedReason(wt);
          addFollowUps(followUps, takeFollowUps(wt));
        }
      }
      if (blocked !== null) {
        w = { ...w, status: 'blocked', output: blocked };
        row.blockedReason = blocked;
        // A block that only asks to edit locked test files goes to the other family, not to a human (REQ-RUN-30).
        const paths = config.approveAllowEdits ? editRequest(blocked, card, config, baseSha, wt) : [];
        const verdict = paths.length ? approveEdits({ config, builder: t, card, request: blocked, paths, cwd: wt }) : null;
        if (verdict) {
          Object.assign(row, { reviewCost: verdict.cost, reviewUsage: verdict.usage, reviewUnpriced: Boolean(verdict.unpriced) }); // REQ-LED-13
          if (verdict.approved) {
            // The gate still proves the approved edit (REQ-GATE-44), so it knows which allowEdits were approved.
            card = { ...card, allowEdits: [...card.allowEdits, ...paths], approvedEdits: [...(card.approvedEdits ?? []), ...paths] };
            approvedEdits.push({ paths, by: verdict.by, reason: verdict.reason });
            row.allowEditsApproved = { paths, by: verdict.by, reason: verdict.reason };
            failure = `Keel approved allowEdits for ${paths.join(', ')} (${verdict.by}: ${verdict.reason}). Continue the card; change those tests only as the card requires.`;
            log(`allowEdits approved by ${verdict.by} for ${paths.join(', ')}: ${verdict.reason}`);
            w = { ...w, status: 'approved' };
          } else {
            row.allowEditsDenied = { paths, by: verdict.by, reason: verdict.reason };
            w = { ...w, output: `${blocked}\n\nallowEdits denied by ${verdict.by}: ${verdict.reason}` };
          }
        }
      }
      // A blocked worker stops the run: its edits on the card's branch are committed, never left dirty (REQ-RUN-44).
      if (w.status === 'blocked' && onBranch(wt, branch)) parkLeftovers(wt, card, attempt, branch, log);
      Object.assign(row, { workerStatus: w.status, usage: w.usage, cost: w.cost, durationMs: w.durationMs });
      runCost = runCost !== null && typeof w.cost === 'number' ? runCost + w.cost : null;
      if (blocked === null) {
        commitError =
          commitError ??
          (KEEP_DIRTY.has(w.status) ? commitLeftovers(wt, card, attempt, branch) : parkLeftovers(wt, card, attempt, branch, log));
        const gateStart = Date.now();
        const gateHead = (flaky = []) => gateWorktree({ wt, baseSha, card, config, t, log, flaky });
        receipt = commitError ? null : gateHead();
        // A check that failed twice in one gate may still be the machine, not the work: gate the same head once more
        // before a stronger tier is paid to change nothing (REQ-RUN-34, extends REQ-GATE-18).
        const stage = receipt?.results.find((r) => !r.pass);
        if (
          stage &&
          w.status === 'ok' &&
          (Object.hasOwn(config.checks, stage.name) || stage.name === 'regression-on-head') &&
          revParse('HEAD', wt) === receipt.head &&
          !isDirty(wt)
        ) {
          log(`${stage.name} failed on ${receipt.head}; gating the same head again before escalating`);
          row.regated = true;
          receipt = gateHead([stage.name]);
        }
        Object.assign(row, { gatePass: Boolean(receipt?.pass), gateMs: Date.now() - gateStart, head: receipt?.head ?? null });
        // Every stage passed but the reviewer was unavailable: keep this head for the next run (REQ-RUN-24).
        if (receipt?.results.every((r) => r.pass || (r.name === 'review' && r.problems.every((p) => p.rule === 'review-unavailable'))))
          row.pendingReview = !receipt.pass;
        Object.assign(row, reviewSpend(receipt?.results ?? []));
        const flaky = (receipt?.results ?? []).filter((r) => r.flaky).map((r) => r.name);
        if (flaky.length) {
          row.flaky = flaky;
          log(`flaky (failed once, passed on retry): ${flaky.join(', ')}`);
        }
      }
    } finally {
      appendAttempt({ usage: null, durationMs: 0, workerStatus: 'harness-error', ...row }); // Recorded even when the gate throws.
    }
    if (w.status === 'approved') continue; // same tier, now with the approved allowEdits (REQ-RUN-30)
    if (w.status === 'blocked')
      return { pass: false, stopped: 'blocked', branch, worktree: wt, failure: w.output, followUps, approvedEdits };
    if (w.status === 'auth') return { pass: false, stopped: 'auth', branch, worktree: wt, failure: w.output, followUps };
    // A reviewer outage is not the builder's fault: stop rather than escalate (REQ-GATE-21).
    const unavailable = receipt?.results.find((r) => r.name === 'review' && r.problems.some((p) => p.rule === 'review-unavailable'));
    if (unavailable)
      return {
        pass: false,
        stopped: 'review-unavailable',
        pendingReview: Boolean(row.pendingReview),
        branch,
        worktree: wt,
        failure: unavailable.output ?? '',
        followUps,
      };
    if (w.status === 'ok' && receipt?.pass) {
      // One corrective turn on the review's notes before a bug or feature card is accepted (REQ-RUN-36).
      const lowNotes = receipt.results.find((r) => r.name === 'review')?.notes ?? [];
      if (
        config.fixLowFindings &&
        FIX_KINDS.includes(card.kind) &&
        lowNotes.length &&
        // Only a continued session is cheap: a fresh one would explore the repo again (REQ-RUN-33).
        session &&
        sameCli(session.tier, t) &&
        (config.cardBudgetUsd === null || runSpent(runId) < config.cardBudgetUsd)
      ) {
        const fixed = fixFindings({
          wt,
          card,
          config,
          t,
          attempt,
          branch,
          baseSha,
          receipt,
          notes: lowNotes,
          session,
          row,
          followUps,
          log,
        });
        receipt = fixed.receipt;
        runCost = runCost !== null && typeof fixed.cost === 'number' ? runCost + fixed.cost : null;
      }
      const needsReview =
        touchesProtected(
          changedFiles(baseSha, 'HEAD', wt).map((f) => f.path),
          config,
        ) ||
        card.size === 'L' ||
        card.kind === 'infra';
      log(`gate passed on tier ${tier}; branch ${branch}${needsReview ? ' (human review required)' : ''}`);
      // Non-blocking review notes are found work too (REQ-RUN-27).
      // They have their own cap of MAX_FOLLOWUPS, so builder items cannot crowd them out.
      const notes = receipt.results.find((r) => r.name === 'review')?.notes ?? [];
      const noted = [];
      addFollowUps(
        noted,
        notes.map((n) => ({ kind: 'bug', title: `Review: ${n.text}`.slice(0, 200), detail: `${n.severity} ${n.path}:${n.line}` })),
      );
      for (const n of noted) if (!followUps.some((f) => f.title.toLowerCase() === n.title.toLowerCase())) followUps.push(n);
      const pushed = pr ? pushCertified(wt, branch, receipt) : null;
      // The required keel/gate status goes on the certified SHA before the PR opens, so the PR body tells the truth and a
      // later head cannot merge (REQ-RUN-23).
      const status = pushed?.ok ? postGateStatus(wt, receipt, config) : null;
      if (status) log(status.ok ? `status ${GATE_CONTEXT} success on ${receipt.head}` : `status ${GATE_CONTEXT} not posted: ${status.out}`);
      // A failed post fails a requested merge whatever the policy, so `--merge` exits 1 (REQ-RUN-23).
      let mergeState = !merge
        ? null
        : status && !status.ok
          ? { state: 'failed', reason: `${GATE_CONTEXT} status not posted: ${status.out.slice(-500)}` }
          : mergePolicy({ wt, baseBranch, config, receipt, needsReview });
      const prText = prBody({ card, receipt, tier: { index: tier, ...t }, attempt, cost: runCost });
      const body = prText + autoMergeLine(mergeState);
      const draft = needsReview && mergeState?.state !== 'auto' && !mergeState?.selfMerge;
      const prResult = pushed && (pushed.ok ? openPr(wt, { branch, baseBranch, card, draft, body }) : pushed);
      if (mergeState?.state === 'auto') {
        mergeState = enableAutoMerge(wt, prResult, receipt.head);
        // The body said auto-merge was on before GitHub answered; a refusal corrects it (REQ-MERGE-5).
        if (mergeState.selfMerge) {
          const edit = exec('gh', ['pr', 'edit', prUrl(prResult), '--body', prText + autoMergeLine(mergeState)], wt);
          if (edit.status !== 0) log(`PR body not corrected: ${`${edit.stdout}${edit.stderr}`.trim().slice(-500)}`);
        }
      }
      if (mergeState) log(`auto-merge: ${mergeState.state}${mergeState.reason ? ` (${mergeState.reason})` : ''}`);
      return {
        pass: true,
        tier,
        attempt,
        branch,
        worktree: wt,
        receipt,
        needsReview,
        pr: prResult,
        merge: mergeState,
        status,
        followUps,
        approvedEdits,
      };
    }
    const workerNote = w.status !== 'ok' ? `worker ${w.status}:\n${w.output}\n\n` : '';
    failure = commitError ?? workerNote + (receipt ? failureSummary(receipt, config.failureTailChars) : '');
    if (
      touchesProtected(
        changedFiles(baseSha, 'HEAD', wt).map((f) => f.path),
        config,
      )
    )
      floor = Math.max(floor, config.startTier.protected);
    const next = skipReserved(config.tiers, nextTier(config.tiers, tier, floor, w.status, networkRetries), floor, reserved, log);
    log(`attempt ${attempt} failed (${w.status === 'ok' ? 'gate' : w.status})`);
    // Unpriced attempts cannot count; the priced spend still stops the card (REQ-RUN-22).
    if (config.cardBudgetUsd !== null) {
      const spent = runSpent(runId);
      if (spent >= config.cardBudgetUsd) {
        log(`card budget reached: ${usd(spent)} of $${config.cardBudgetUsd}`);
        return { pass: false, stopped: 'budget', branch, worktree: wt, failure, followUps };
      }
    }
    if (next === null) return { pass: false, stopped: 'quota', branch, worktree: wt, failure, followUps };
    networkRetries = next === tier && w.status === 'network' ? networkRetries + 1 : 0;
    tier = next;
  }
  return { pass: false, stopped: 'max-attempts', branch, worktree: wt, failure, followUps };
}
