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
