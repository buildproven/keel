import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { escapeRe, expectedBranch, listParkedWorktrees, removeParkedWorktree } from './clean.js';
import { loadConfig } from './config.js';
import { exec, git, makeRemovable } from './git.js';
import { readLedger, stateDir } from './ledger.js';
import { runLockHeld } from './run-lock.js';
import { alive } from './slots.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** A ledger row's repo is the path a run was given; compare real paths (macOS /var is /private/var). */
const sameDir = (a, real) => a === real || (existsSync(a) && realpathSync(a) === real);

/**
 * The automatic cleanup (REQ-CLEAN-3..5), run before each `keel poll` pass and each `keel run`: remove every parked
 * worktree that is safe and finished, report once each one that is not safe, and remove gate checkouts no live process
 * owns. Returns { removed, kept, checkouts }.
 */
export function autoClean({ log = () => {}, now = Date.now(), tmpRoot = tmpdir() } = {}) {
  const reported = readReported(log);
  const seen = {};
  const removed = [];
  const kept = [];
  const rows = readLedger();
  const keepDays = new Map(); // repo → days, or an Error when its keel.json cannot be read
  for (const w of listParkedWorktrees()) {
    let verdict;
    try {
      verdict = judge(w, { rows, now, keepDays });
      if (verdict.remove) {
        removeParkedWorktree(w);
        removed.push(w.path);
        log(`removed ${w.path} (${verdict.why})`);
      }
    } catch (e) {
      // REQ-CLEAN-4: a failure on one worktree is reported and never stops the cleanup, the poll, or the run.
      verdict = { keep: `cleanup failed: ${e.message.split('\n')[0]}` };
    }
    if (!verdict.keep) continue;
    kept.push({ path: w.path, reason: verdict.keep });
    seen[w.path] = verdict.keep;
    if (reported[w.path] !== verdict.keep) log(`kept ${w.path}: ${verdict.keep}`);
  }
  writeReported(seen);
  const checkouts = removeDeadCheckouts({ tmpRoot, now, log });
  return { removed, kept, checkouts };
}

/** Whether one parked worktree goes (REQ-CLEAN-3), stays silently (running or young), or stays with a reason (REQ-CLEAN-4). */
function judge(w, { rows, now, keepDays }) {
  if (!w.own) return { keep: `on ${w.branch ?? 'a detached HEAD'}, not ${expectedBranch(w.path)}` };
  if (runLockHeld(join(stateDir(), 'locks', basename(w.path)))) return {}; // its run is in progress
  if (!w.clean) return { keep: 'uncommitted changes' };
  const id = w.branch.slice('keel/'.length);
  const ref = `refs/heads/${w.branch}`;
  const leftovers = new RegExp(`^chore\\(${escapeRe(id)}\\): keel attempt \\d+ leftovers$`);
  // Commits no other branch outside keel/* and no remote-tracking ref holds: they exist only in this worktree.
  const only = git(['log', '--format=%h %s', ref, '--not', '--exclude=keel/*', '--branches', '--remotes'], w.repo)
    .split('\n')
    .filter(Boolean);
  const foreign = only.filter((l) => !leftovers.test(l.slice(l.indexOf(' ') + 1)));
  if (foreign.length) return { keep: `commits only there that Keel did not make: ${foreign.slice(0, 3).join('; ')}` };
  const repo = realpathSync(w.repo);
  const last = rows.filter((r) => r.card === id && r.at && r.repo && sameDir(r.repo, repo)).at(-1);
  const activity = last ? Date.parse(last.at) : Number(git(['log', '-1', '--format=%ct', ref], w.repo)) * 1000;
  if (now - activity < HOUR) return {}; // a run that just ended: its own poll handles it
  if (!only.length) return { remove: true, why: 'no commit only there' };
  if (!keepDays.has(w.repo)) {
    try {
      keepDays.set(w.repo, loadConfig(w.repo, 'HEAD').worktreeKeepDays);
    } catch (e) {
      keepDays.set(w.repo, e); // REQ-CLEAN-4: reported as the reason this worktree stays
    }
  }
  const days = keepDays.get(w.repo);
  if (days instanceof Error) return { keep: `keel.json of ${w.repo} unreadable: ${days.message.split('\n')[0]}` };
  if (now - activity > days * DAY) return { remove: true, why: `Keel commits only, last activity over ${days} days ago` };
  return {};
}

const reportedFile = () => join(stateDir(), 'cleanup-kept.json');

/** path → reason already reported (REQ-CLEAN-4); none yet is an empty map. A damaged file only means reporting again. */
function readReported(log) {
  let text;
  try {
    text = readFileSync(reportedFile(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    log(`${reportedFile()} unreadable (${e.message}); reporting kept worktrees again`);
    return {};
  }
}

/** Written to a temp file and renamed into place, so a concurrent cleanup never reads half a file (REQ-CLEAN-4). */
function writeReported(seen) {
  mkdirSync(stateDir(), { recursive: true });
  const temp = `${reportedFile()}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(seen, null, 2)}\n`);
  renameSync(temp, reportedFile());
}

const CHECKOUT = /^keel-wt-(?:(\d+)-)?[A-Za-z0-9]{6}$/;

/**
 * Remove gate checkouts no live process owns (REQ-CLEAN-5): `keel-wt-<pid>-<random>` whose pid is dead, or an unnamed
 * `keel-wt-<random>` over a day old, in TMPDIR/keel.noindex and in TMPDIR itself. Only those exact directories are
 * removed, never a symlink; then `git worktree prune` runs in each repo their `.git` file names.
 */
function removeDeadCheckouts({ tmpRoot, now, log }) {
  const repos = new Set();
  let count = 0;
  for (const root of [join(tmpRoot, 'keel.noindex'), tmpRoot]) {
    let names;
    try {
      names = readdirSync(root);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // no gate has run here yet
      throw e;
    }
    for (const name of names) {
      const m = CHECKOUT.exec(name);
      if (!m) continue;
      const dir = join(root, name);
      const st = lstatSync(dir, { throwIfNoEntry: false });
      // Gone already (another keel's cleanup), or a symlink or file: not a checkout to remove here.
      if (!st?.isDirectory()) continue; // a symlink or file is not a checkout Keel made
      const dead = m[1] ? !alive(Number(m[1])) : now - st.mtimeMs > DAY;
      if (!dead) continue;
      let repo;
      try {
        repo = repoOf(dir);
        makeRemovable(dir);
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        if (e.code === 'ENOENT') continue; // another keel's cleanup removed it meanwhile
        // REQ-CLEAN-4: one checkout that cannot be removed is reported and never stops the cleanup.
        log(`kept ${dir}: ${e.message.split('\n')[0]}`);
        continue;
      }
      count++;
      if (repo) repos.add(repo);
    }
  }
  for (const repo of repos) exec('git', ['worktree', 'prune'], repo); // a repo since moved or deleted needs no prune
  if (count) log(`removed ${count} gate checkouts no live process owns`);
  return count;
}

/** The git dir of a checkout's repo, from its `.git` file (`gitdir: <git dir>/worktrees/<name>`); null when unknown. */
function repoOf(dir) {
  let text;
  try {
    text = readFileSync(join(dir, '.git'), 'utf8');
  } catch (e) {
    if (['ENOENT', 'EISDIR'].includes(e.code)) return null; // not a linked checkout: nothing to prune
    throw e;
  }
  const gitdir = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
  return gitdir ? dirname(dirname(gitdir)) : null; // the repo's git dir: `git worktree prune` runs there
}
