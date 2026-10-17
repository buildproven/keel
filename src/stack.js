import { extname } from 'node:path';
import { git } from './git.js';
import { PROSE, matchesAny } from './scan.js';

/** Changed lines outside tests and prose above which a card of each size should be split (REQ-GATE-30). */
export const SIZE_BUDGET = { S: 300, M: 800, L: 1500 };

/**
 * Branches whose unmerged commits HEAD contains (REQ-GATE-30), from git alone: local and remote branches merged into
 * HEAD but not into base, except HEAD's own branch, its remote copies, and its upstream of any name (empty when there is
 * none or HEAD is detached). Each merge of one of them forces the others to merge again.
 */
export function stackWarnings(repo, base) {
  const own = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
  const upstream = git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${own}`], repo).trim();
  const refs = git(
    ['for-each-ref', '--format=%(refname:short)', '--merged', 'HEAD', '--no-merged', base, 'refs/heads', 'refs/remotes'],
    repo,
  )
    .split('\n')
    .filter(Boolean)
    .filter((r) => r !== own && r !== upstream && !r.endsWith(`/${own}`) && !r.endsWith('/HEAD'));
  return refs.map((r) => {
    const n = Number(git(['rev-list', '--count', `${base}..${r}`], repo).trim());
    return `stacked on ${r} (${n} commit${n === 1 ? '' : 's'}): merge ${r} first, or rebase onto ${base}`;
  });
}

/**
 * A warning when the change has more added plus deleted lines outside tests and prose than its card size allows
 * (REQ-GATE-30), naming the files with the most changed lines; else null.
 */
export function sizeWarning(repo, base, head, card, config) {
  const budget = SIZE_BUDGET[card.size];
  const rows = git(['diff', '--numstat', '--no-renames', base, head], repo)
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([added, , path]) => added !== '-' && !PROSE.has(extname(path)) && !matchesAny(path, config.testGlobs));
  const byFile = new Map();
  let total = 0;
  for (const [added, deleted, path] of rows) {
    const n = Number(added) + Number(deleted);
    total += n;
    byFile.set(path, n);
  }
  if (!budget || total <= budget) return null;
  const top = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `diff is ${total} changed lines outside tests, over ${budget} for size ${card.size}: split it by concern; largest: ${top.map(([d, n]) => `${d} ${n}`).join(', ')}`;
}
