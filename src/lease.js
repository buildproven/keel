import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { exec, git } from './git.js';
import { stateDir } from './ledger.js';
import { runLockHeld } from './run-lock.js';
import { PROSE, matchesAny } from './scan.js';

/**
 * The files each other open branch of the repo changes (REQ-LEASE-1), as a Map of name → sorted paths: each local
 * `keel/<ID>` branch whose `keel run` is in progress (keelRuns), with its diff from the merge base plus its
 * worktree's uncommitted changes, since a worker commits only at the end of an attempt; and, with an `origin` remote,
 * the open PRs `gh` lists, named `PR #<n> (<branch>)`. A keel branch with no run and no open PR is not open: a squash
 * merge never makes it an ancestor of base, and a failed run's branch stays until `keel clean`. `own` (the branch being
 * built or gated) is never included, also as a PR. A `gh` failure is logged and only local runs are checked; it never
 * stops a run, poll, or gate.
 */
export function openBranchFiles(repo, base, { own, log }) {
  const open = new Map();
  for (const { path, branch } of keelRuns(repo)) {
    if (branch === own) continue;
    const pending = [...diffNames(path, git(['merge-base', base, branch], repo).trim()), ...untracked(path)];
    open.set(branch, [...new Set([...diffNames(repo, `${base}...${branch}`), ...pending])].sort());
  }
  if (exec('git', ['remote', 'get-url', 'origin'], repo).status !== 0) return open;
  const r = exec('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,files'], repo);
  if (r.status !== 0) {
    log(`path lease: open PRs not checked: gh pr list failed: ${`${r.stdout}${r.stderr}`.trim().slice(0, 300)}`);
    return open;
  }
  let prs;
  try {
    prs = JSON.parse(r.stdout);
  } catch (e) {
    // REQ-LEASE-1: output gh did not write as JSON is a gh failure; it is logged and never stops a run, poll, or gate.
    if (!(e instanceof SyntaxError)) throw e;
    log(`path lease: open PRs not checked: gh pr list printed no JSON: ${r.stdout.trim().slice(0, 300)}`);
    return open;
  }
  for (const pr of prs) {
    if (pr.headRefName === own) continue;
    const files = (pr.files ?? []).map((f) => f.path);
    if (open.has(pr.headRefName)) open.set(pr.headRefName, [...new Set([...open.get(pr.headRefName), ...files])].sort());
    else open.set(`PR #${pr.number} (${pr.headRefName})`, [...new Set(files)].sort());
  }
  return open;
}

/**
 * `keel run`s in progress on this repo: worktrees of `keel/*` branches under the state dir whose run lock (named after
 * the worktree, REQ-RUN-10) has a live holder. From `git worktree list`, so any checkout of the repo sees them.
 */
function keelRuns(repo) {
  const runs = [];
  for (const block of git(['worktree', 'list', '--porcelain'], repo).split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(keel\/.+)$/m.exec(block)?.[1];
    if (!path || !branch || !existsSync(path)) continue;
    // No live lock: the run ended, and its branch is parked or merged.
    if (runLockHeld(join(stateDir(), 'locks', basename(path)))) runs.push({ path, branch });
  }
  return runs;
}

const untracked = (dir) => git(['ls-files', '-z', '--others', '--exclude-standard'], dir).split('\0').filter(Boolean);

const diffNames = (repo, range) => git(['diff', '--name-only', '--no-renames', '-z', range], repo).split('\0').filter(Boolean).sort();

/**
 * Open branches whose changed files `wanted` matches (REQ-LEASE-1), with those files. Prose (.md, .txt, .rst) is shared:
 * nearly every change touches README or DESIGN, and a prose conflict is a quick rebase, not a re-gate of code.
 */
export const leaseConflicts = (open, wanted) =>
  [...open]
    .map(([branch, files]) => ({ branch, files: files.filter((f) => !PROSE.has(extname(f)) && wanted(f)) }))
    .filter((c) => c.files.length);

/** `keel/A (src/x.js), PR #7 (feat/z) (src/z.js)`: each conflicting branch with up to three of its files. */
export const describeConflicts = (conflicts) =>
  conflicts.map((c) => `${c.branch} (${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? ', …' : ''})`).join(', ');

/** Open branches that change a file the card's `paths` cover (REQ-LEASE-2, -3); a card without `paths` leases nothing. */
export function cardLease(repo, base, card, log) {
  if (!card.paths?.length) return [];
  return leaseConflicts(openBranchFiles(repo, base, { own: `keel/${card.id}`, log }), (f) => matchesAny(f, card.paths));
}

/** One warning per open branch that changes a file HEAD changes (REQ-LEASE-1); `keel gate` prints them, never blocks. */
export function overlapWarnings(repo, base, log) {
  const own = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
  const mine = new Set(diffNames(repo, `${base}...HEAD`));
  return leaseConflicts(openBranchFiles(repo, base, { own, log }), (f) => mine.has(f)).map(
    (c) => `paths overlap ${describeConflicts([c])}: merge one first, then rebase the other`,
  );
}
