import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, git } from './git.js';
import { stateDir } from './ledger.js';

const DAY_MS = 86400000;
const FIX = /^fix(\([^)]*\))?!?:/i;
const LINEAR_ID = /^[A-Z]+-\d+$/;

/** `git patch-id --stable` over a patch text: one "<patch-id> <commit>" line per commit in it. */
function patchIds(patch, cwd) {
  const r = spawnSync('git', ['patch-id', '--stable'], { cwd, input: patch, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git patch-id failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '));
}

/** The branch merges land on: origin's default branch when the repo has one, else the checked-out HEAD. */
export function defaultRef(repo) {
  const r = exec('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], repo);
  return r.status === 0 ? r.stdout.trim() : 'HEAD';
}

/** Each remote's default branch as last fetched: its remote HEAD, else its main branch (REQ-LED-20). */
export function defaultRefs(repo) {
  const remotes = git(['remote'], repo)
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
  if (!remotes.length) return [{ remote: null, ref: defaultRef(repo), exists: true }];
  return remotes.map((remote) => {
    const head = exec('git', ['rev-parse', '--abbrev-ref', `${remote}/HEAD`], repo);
    const ref = head.status === 0 ? head.stdout.trim() : `${remote}/main`;
    const resolved = exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], repo);
    return { remote, ref, exists: resolved.status === 0 };
  });
}

/** Rows before REQ-LED-6 carry no base; the gate receipt for the same card and head has it. */
function receiptBase(card, head) {
  const dir = join(stateDir(), 'receipts');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith(`${card}-${head}-`));
  return file ? (JSON.parse(readFileSync(join(dir, file), 'utf8')).base ?? null) : null;
}

const filesCache = new Map();
/** Files a commit changed; cached, since every baseline commit re-reads the same later fixes (REQ-LED-8). */
const filesOf = (sha, repo) => {
  const key = `${repo}\0${sha}`;
  if (!filesCache.has(key)) filesCache.set(key, changedBy(sha, repo));
  return filesCache.get(key);
};

const changedBy = (sha, repo) =>
  git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha], repo).split('\0').filter(Boolean);

export function mainCommits(repo, ref, since) {
  return git(['log', '--no-merges', `--since=${since}`, '--format=%H%x00%cI%x00%s', ref], repo)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, at, subject] = l.split('\0');
      return { sha, at, subject };
    })
    .reverse(); // oldest first
}

// Lockfiles change with every dependency fix; sharing one is no evidence the earlier change was defective (REQ-LED-6).
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;

// Prose and requirements lists: an edit there is not a defect in the earlier change (REQ-LED-10).
const DOC = /\.(md|txt|rst)$/i;
const attributable = (f) => !LOCKFILE.test(f) && !DOC.test(f);

const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/**
 * Per file a fix commit changed: the commits that wrote the old-side lines it modifies or deletes, by `git blame` at
 * its parent (REQ-LED-10). A pure insertion counts against the lines on either side of it, since it lands inside
 * their code. Files new in the fix have no old lines; doc, requirements, and lock files are not blamed at all. Blame
 * follows renames, so a line keeps its author's commit under a new path.
 */
function ownersOf(sha, repo) {
  const owners = {};
  for (const file of filesOf(sha, repo).filter(attributable)) {
    const old = exec('git', ['cat-file', 'blob', `${sha}^:${file}`], repo);
    if (old.status !== 0) continue; // added by the fix
    const n = lineCount(old.stdout);
    const ranges = [];
    const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', `${sha}^`, sha, '--', file], repo); // git() makes pathspecs literal (REQ-GATE-5)
    for (const h of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      const [from, to] = count ? [start, start + count - 1] : [Math.max(1, start), Math.min(n, start + 1)];
      if (from <= to) ranges.push('-L', `${from},${to}`);
    }
    if (!ranges.length) continue;
    const blame = git(['blame', '--porcelain', ...ranges, `${sha}^`, '--', file], repo);
    owners[file] = [...new Set([...blame.matchAll(/^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+/gm)].map((m) => m[1]))];
  }
  return owners;
}

const ownersCache = new Map();
const unwritable = new Set(); // state dirs already reported as unwritable
/**
 * `ownersOf`, cached in memory and in `<stateDir>/blame/<repo hash>/<sha>.json` (REQ-LED-11): a commit never changes,
 * so its answer holds for every later report, and the baseline re-reads the same fixes for every earlier commit.
 */
function cachedOwners(sha, repo) {
  const repoKey = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  const key = `${repoKey}\0${sha}`;
  if (ownersCache.has(key)) return ownersCache.get(key);
  const dir = join(stateDir(), 'blame', repoKey);
  const file = join(dir, `${sha}.json`);
  let owners;
  if (existsSync(file)) owners = JSON.parse(readFileSync(file, 'utf8'));
  else {
    owners = ownersOf(sha, repo);
    try {
      mkdirSync(dir, { recursive: true });
      const partial = `${file}.${process.pid}.tmp`;
      writeFileSync(partial, JSON.stringify(owners));
      renameSync(partial, file); // a concurrent report never reads a half-written file
    } catch (err) {
      // REQ-LED-11: the cache only saves time; an unwritable state dir is reported once and the report still answers.
      if (!unwritable.has(stateDir())) process.stderr.write(`keel: blame cache not written (${err.message})\n`);
      unwritable.add(stateDir());
    }
  }
  ownersCache.set(key, owners);
  return owners;
}

/**
 * What later went wrong with `commits[index]` within `windowDays` (REQ-LED-6, REQ-LED-8, REQ-LED-10): `fix:` commits
 * that modify or delete lines it wrote (doc, requirements, and lock files left out), and reverts that name it (git's
 * default subject, or the post-deploy workflow's, REQ-LED-7).
 */
export function laterFailures(commits, index, repo, windowDays = 30) {
  const change = commits[index];
  const until = Date.parse(change.at) + windowDays * DAY_MS;
  const later = commits.slice(index + 1).filter((c) => Date.parse(c.at) <= until);
  // A change that wrote only docs or lockfiles owns no attributable line.
  const candidates = !filesOf(change.sha, repo).some(attributable)
    ? []
    : later
        .filter((c) => FIX.test(c.subject))
        .map((c) => {
          const owners = cachedOwners(c.sha, repo);
          return { ...c, files: Object.keys(owners).filter((f) => owners[f].includes(change.sha)) };
        })
        .filter((c) => c.files.length);
  const reverts = later
    .filter((c) => /^revert/i.test(c.subject))
    .filter((c) => c.subject.includes(change.sha.slice(0, 7)) || c.subject.includes(`"${change.subject}"`));
  return { candidates, reverts };
}

/**
 * Escaped-defect candidates for judging value (REQ-LED-6, REQ-LED-8). A Keel change counts as merged when a commit on
 * the default branch has the same patch identity as base..head (a clean squash) or, for a Linear-style card ID,
 * names the ID in its subject. A candidate is a later `fix:` commit within `windowDays` of the merge that modifies or
 * deletes lines the merge wrote (REQ-LED-10); a revert that names the merge always counts. Each merge commit counts
 * once, for the earliest accepted run that landed in it.
 */
export function escapedDefects(rows, { windowDays = 30 } = {}) {
  const runs = new Map();
  // A run counts at its last passing row: a findings turn moves the accepted head past the attempt's (REQ-RUN-38).
  const accepted = new Map();
  for (const r of rows) if (r.attemptPass && r.head) accepted.set(r.run ?? `${r.repo}\0${r.head}`, r);
  for (const r of accepted.values()) if (!runs.has(`${r.repo}\0${r.head}`)) runs.set(`${r.repo}\0${r.head}`, r);
  const merged = [];
  const notFound = [];
  const byRepo = new Map();
  // Earliest first, so when two accepted runs of a card land as one merge, the merge counts once, from its first run.
  const ordered = [...runs.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  for (const r of ordered) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const counted = new Set(); // repo + merge commit
  for (const [repo, repoRuns] of byRepo) {
    if (typeof repo !== 'string' || !existsSync(repo)) {
      // Rows from before REQ-LINEAR-9 carry no repo.
      for (const r of repoRuns) notFound.push({ card: r.card, repo, reason: repo ? 'repo missing' : 'repo unknown' });
      continue;
    }
    // A merge never precedes its run; reading history from a day before the oldest run keeps big repos fast.
    const since = new Date(Math.min(...repoRuns.map((r) => Date.parse(r.at))) - DAY_MS).toISOString();
    const refs = defaultRefs(repo);
    const histories = new Map();
    const historyFor = ({ remote, ref, exists }) => {
      if (!exists) return null;
      if (!histories.has(ref)) {
        const commits = mainCommits(repo, ref, since);
        const log = git(['log', '-p', '--no-merges', `--since=${since}`, '--format=commit %H', ref], repo);
        histories.set(ref, { remote, ref, commits, idOf: new Map(patchIds(log, repo).map(([id, sha]) => [sha, id])) });
      }
      return histories.get(ref);
    };
    for (const r of repoRuns) {
      const base = r.base ?? receiptBase(r.card, r.head);
      if (!base) {
        notFound.push({ card: r.card, repo, reason: 'base unknown' });
        continue;
      }
      const target = patchIds(`commit ${r.head}\n${git(['diff', base, r.head], repo)}`, repo)[0]?.[0];
      const named = LINEAR_ID.test(r.card) ? new RegExp(`\\b${r.card}\\b`) : null;
      let found;
      for (const candidate of refs) {
        const history = historyFor(candidate);
        if (!history) continue;
        const index = history.commits.findIndex((c) => history.idOf.get(c.sha) === target || named?.test(c.subject));
        if (index !== -1) {
          found = { ...history, index };
          break;
        }
      }
      if (!found) {
        const looked = refs.some((candidate) => candidate.remote)
          ? ` (looked at remotes: ${refs.map((candidate) => candidate.remote).join(', ')})`
          : '';
        notFound.push({ card: r.card, repo, reason: `not on the default branch${looked}` });
        continue;
      }
      const merge = found.commits[found.index];
      if (counted.has(`${repo}\0${merge.sha}`)) continue;
      counted.add(`${repo}\0${merge.sha}`);
      const { candidates, reverts } = laterFailures(found.commits, found.index, repo, windowDays);
      merged.push({
        card: r.card,
        run: r.run,
        repo,
        ref: found.ref,
        mergeSha: merge.sha,
        mergedAt: merge.at,
        candidates,
        reverts,
      });
    }
  }
  return { merged, notFound };
}

export function formatEscaped({ merged, notFound }) {
  const short = (sha) => sha.slice(0, 7);
  const day = (at) => at.slice(0, 10);
  const lines = [];
  for (const m of merged) {
    const from = `${m.card} merged ${short(m.mergeSha)} ${day(m.mergedAt)} →`;
    for (const c of m.candidates)
      lines.push(`${from} fix ${short(c.sha)} ${day(c.at)} ${JSON.stringify(c.subject)} (${c.files.join(', ')})`);
    for (const c of m.reverts) lines.push(`${from} revert ${short(c.sha)} ${day(c.at)} ${JSON.stringify(c.subject)}`);
  }
  for (const n of notFound) lines.push(`${n.card}: ${n.reason}${n.repo ? ` (${n.repo})` : ''}`);
  const count = merged.filter((m) => m.candidates.length || m.reverts.length).length;
  lines.push(
    `merged ${merged.length}; not found on the default branch ${notFound.length}; later fixed on the same lines or reverted ${count}`,
  );
  return lines.join('\n');
}
