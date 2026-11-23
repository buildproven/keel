import { spawnSync } from 'node:child_process';
import { exec, git } from './git.js';
import { UsageError } from './usage.js';

const refExists = (ref, repo) => exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo).status === 0;

/** `keel gate` without `--base`: origin's default branch (REQ-CLI-6). */
export function findDefaultBase(repo) {
  const head = exec('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo);
  // origin/HEAD can dangle after the default branch is renamed and pruned; then try the usual names.
  const named = head.status === 0 ? [head.stdout.trim().replace(/^refs\/remotes\//, '')] : [];
  return [...named, 'origin/main', 'origin/master'].find((ref) => refExists(ref, repo)) ?? null;
}

/**
 * The ref whose keel.json sets policy outside a gate (`keel audit`, the cleanup's keep days, `report --value` prices):
 * origin's default branch, else HEAD. The primary checkout can be stale or on any branch (REQ-CFG-2).
 */
export const policyRef = (repo) => findDefaultBase(repo) ?? 'HEAD';

/** A remote that cannot give the base of a card command; the CLI stops with exit 4 (REQ-BASE-3). */
export class BaseError extends Error {}

/** A remote URL without its user and password, safe to print (REQ-BASE-3). */
const redact = (text) => text.replace(/(\/\/)[^/@\s]*@/g, '$1');

/**
 * The base of every command that reads a card (`keel run`, `keel poll`, `keel check-card`) without `--base`: origin's
 * default branch, fetched first, so a primary checkout that has not pulled cannot give a build a stale base. HEAD only
 * in a repo without an `origin` remote. A failed fetch throws BaseError, never falls back (REQ-BASE-1..3).
 */
export function cardBase(repo) {
  const url = exec('git', ['remote', 'get-url', 'origin'], repo);
  if (url.status !== 0) return 'HEAD';
  // No credential prompt: a nightly poll has no terminal to answer it.
  const remote = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const fail = (why) =>
    new BaseError(`cannot fetch remote origin (${redact(url.stdout.trim())}): ${redact(why)}; pass --base <ref> to use a local ref`);
  const lastLine = (r) => (r.stderr ?? r.error?.message ?? '').trim().split('\n').at(-1) || `git exited ${r.status}`;
  const head = remote(['ls-remote', '--symref', 'origin', 'HEAD']);
  if (head.error || head.status !== 0) throw fail(lastLine(head));
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head.stdout)?.[1];
  if (!branch) throw fail('it has no default branch');
  const fetched = remote(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (fetched.error || fetched.status !== 0) throw fail(lastLine(fetched));
  return `origin/${branch}`;
}

export function defaultBase(repo) {
  const ref = findDefaultBase(repo);
  if (!ref) throw new UsageError('gate needs --base <ref> (origin has no default branch)');
  return ref;
}

// Conventional-commit type → card kind, strongest first (REQ-CLI-7).
const KIND_OF = [
  ['feature', ['feat']],
  ['bug', ['fix']],
  ['infra', ['ci', 'build']],
  ['refactor', ['refactor', 'perf']],
];
const TYPE = /^([a-z]+)(\([^)]*\))?!?:\s/;

/** `keel gate` without `--card`: a size-S card named after the branch, its kind from commit types (REQ-CLI-7). */
export function branchCard(repo, base) {
  const branch = exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  const name = branch.status === 0 ? branch.stdout.trim() : git(['rev-parse', '--short', 'HEAD'], repo).trim();
  const id =
    name
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64) || 'branch';
  const types = git(['log', '--format=%s', `${base}..HEAD`], repo)
    .split('\n')
    .map((s) => TYPE.exec(s)?.[1])
    .filter(Boolean);
  if (!types.length) throw new UsageError(`gate needs --card <card.md>: no commit since ${base} has a conventional type (feat:, fix:, …)`);
  const kind = KIND_OF.find(([, t]) => types.some((x) => t.includes(x)))?.[0] ?? 'chore';
  return { id, title: id, kind, size: 'S', paths: [], allowEdits: [], acceptance: [], heldOut: null, text: `# ${id}\n` };
}
