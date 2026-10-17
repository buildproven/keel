import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { exec, git, isDirty } from './git.js';
import { stateDir } from './ledger.js';

/**
 * Every worktree keel has created under its state dir, across every repo (REQ-CLEAN-1). A parked
 * worktree is kept for inspection (REQ-RUN-5); this only lists them, it never deletes on its own.
 */
export function listParkedWorktrees() {
  const root = join(stateDir(), 'worktrees');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // No worktrees dir yet: nothing to list.
  }
  const found = [];
  for (const e of entries.filter((d) => d.isDirectory())) {
    const path = join(root, e.name);
    const commonDir = exec('git', ['rev-parse', '--git-common-dir'], path);
    if (commonDir.status !== 0) continue; // Not a git worktree (leftover junk) — leave it for a human.
    const repo = dirname(commonDir.stdout.trim());
    const branch = headBranch(path);
    // A status git cannot read counts as dirty: the worktree is kept, never discarded (REQ-CLEAN-4).
    const status = exec('git', ['status', '--porcelain'], path);
    found.push({ path, repo, branch, own: ownBranch(path, branch), clean: status.status === 0 && status.stdout.trim() === '' });
  }
  return found;
}

/** The branch a worktree has checked out, or null when its HEAD is detached. */
const headBranch = (path) => exec('git', ['symbolic-ref', '-q', '--short', 'HEAD'], path).stdout.trim() || null;

/**
 * Keel names a card's worktree `<repo>-<key>-<card id>` and its branch `keel/<card id>` (run.js). A worktree is Keel's
 * to remove only while its HEAD is that branch: a worker can switch it to a human branch or detach it (REQ-CLEAN-2). The
 * whole card id follows the 8-hex repo key, so `keel/1` is not the branch of `…-T-1` (REQ-CLEAN-4).
 */
const ownBranch = (path, branch) =>
  branch?.startsWith('keel/') === true && new RegExp(`-[0-9a-f]{8}-${escapeRe(branch.slice(5))}$`).test(basename(path));
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The keel/ branch a worktree should be on, for messages: the card id is the part of its name after the repo key. */
export const expectedBranch = (path) => `keel/${basename(path).replace(/^.*?-[0-9a-f]{6,}-/, '')}`;

/**
 * Remove one parked worktree and its branch (REQ-CLEAN-2). Only a keel/ branch is ever deleted: a branch Keel did not
 * make is refused. Refuses a worktree with uncommitted tracked changes unless `force` is set, so a card's in-progress
 * fix is never silently discarded.
 */
export function removeParkedWorktree({ repo, path, branch, force = false }) {
  if (!branch?.startsWith('keel/')) throw new Error(`will not delete branch ${branch ?? '(none)'}: not a keel/ branch (${path})`);
  if (!force && isDirty(path)) throw new Error(`worktree has uncommitted changes: ${path} (pass force to discard)`);
  git(['worktree', 'remove', '--force', path], repo);
  exec('git', ['branch', '-D', branch], repo);
}
