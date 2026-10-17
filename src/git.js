import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;

/** Run a configured shell command (repo checks). Never throws on a non-zero exit; the caller decides. */
export function sh(command, cwd, { timeoutSec = 900, env = process.env } = {}) {
  const r = spawnSync(command, { cwd, env, shell: true, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutSec * 1000 });
  return { code: r.status, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** Run a program with an argv array (no shell). Returns the raw result. */
export const exec = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });

/**
 * Run git with an argv array. Throws on failure: git errors are harness faults, not gate results. Pathspecs are
 * literal (REQ-GATE-5): a candidate file named `:evil` or `:(glob)x` is that file, never pathspec magic.
 */
export function git(args, cwd) {
  const r = exec('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], cwd);
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
  return r.stdout;
}

/** Resolve a ref to exactly one commit SHA; option-like refs are rejected by --end-of-options. */
export const revParse = (ref, cwd) => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd).trim();
export const isDirty = (cwd) => git(['status', '--porcelain'], cwd).trim() !== '';

/**
 * True only when a *tracked* file was modified/deleted or a new file was staged/added — never for new
 * untracked files. Build/test tools routinely leave cache litter (__pycache__, .pytest_cache, target/,
 * node_modules/.cache) in a checkout; that is normal tool behavior, not tampering with the candidate.
 */
export const trackedContentDirty = (cwd) => git(['status', '--porcelain=v1', '--untracked-files=no'], cwd).trim() !== '';

/** The main worktree of the repo at cwd: the parent of the git common dir (REQ-GATE-48). Equals cwd's top in the main one. */
export const mainWorktree = (cwd) => dirname(resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim()));

/**
 * True when a `.gitignore` file in the repo ignores dir `name`, whether or not it exists (REQ-GATE-49). Other ignore
 * sources do not count: `keel run` writes shared dirs to info/exclude, and a global excludes file says nothing about
 * what this project needs.
 */
export function ignoresDir(name, cwd) {
  const r = exec('git', ['check-ignore', '-v', '--no-index', '--', `${name}/`], cwd);
  if (r.status === 1) return false;
  if (r.status !== 0) throw new Error(`git check-ignore ${name} failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
  const source = r.stdout.split(':')[0];
  return !isAbsolute(source) && !source.startsWith('..') && basename(source) === '.gitignore';
}

/** Files changed base..head as [{status, path}], NUL-delimited so any file name parses. Renames = delete + add. */
export function changedFiles(base, head, cwd) {
  const parts = git(['diff', '--name-status', '-z', '--no-renames', base, head], cwd).split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return files;
}

/** File content at a ref, or null when the path does not exist there. Other git failures throw. */
export function showFile(ref, path, cwd) {
  if (git(['ls-tree', '-z', '--name-only', ref, '--', path], cwd) === '') return null;
  return git(['show', `${ref}:${path}`], cwd);
}

/**
 * File bytes and mode at a ref, or null when absent (REQ-GATE-3 overlay): a Buffer, never a UTF-8 string, so a binary
 * test file is copied byte for byte, and the mode, so an executable test stays executable.
 */
export function showBlob(ref, path, cwd) {
  const mode = fileMode(ref, path, cwd);
  if (!mode) return null;
  const r = spawnSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, maxBuffer: MAX_BUFFER });
  if (r.error || r.status !== 0)
    throw new Error(`git cat-file blob ${ref}:${path} failed: ${(r.stderr?.toString() ?? r.error?.message ?? '').trim()}`);
  return { data: r.stdout, mode };
}

/** Git file mode at a ref ('100644', '120000' for a symlink, …), or null when absent. */
export const fileMode = (ref, path, cwd) => git(['ls-tree', '-z', ref, '--', path], cwd).split(' ')[0] || null;

// git quotes a `+++ b/<path>` header path in double quotes with C-style escapes (\t, \", \\, \n, ...)
// whenever the name has a control character, quote, or backslash — core.quotepath=false only stops
// this for valid UTF-8 bytes, not for those. A name with an embedded space also gets a bare trailing
// tab appended (the historical unified-diff convention for a possible "file\tdate" suffix).
const ESCAPES = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
function unquoteGitPath(raw) {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw.replace(/\t$/, '');
  let out = '';
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const next = body[++i];
    out += next in ESCAPES ? ESCAPES[next] : next;
  }
  return out;
}

/** Added lines per file base..head as [{path, line, text}]. Headers are read only after a `--- ` line. */
export function addedLines(base, head, cwd) {
  const out = git(
    [
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--text',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      head,
    ],
    cwd,
  );
  const added = [];
  let path = null;
  let lineNo = 0;
  let afterMinus = false;
  for (const l of out.split('\n')) {
    if (afterMinus && l.startsWith('+++ ')) path = l === '+++ /dev/null' ? null : unquoteGitPath(l.slice(4)).slice(2);
    else if (l.startsWith('@@')) lineNo = Number(/\+(\d+)/.exec(l)[1]);
    else if (l.startsWith('+') && path) added.push({ path, line: lineNo++, text: l.slice(1) });
    afterMinus = l.startsWith('--- ');
  }
  return added;
}

/**
 * Where temporary checkouts go (REQ-GATE-34): one `keel.noindex` directory under TMPDIR. macOS Spotlight skips a
 * `.noindex` directory and everything in it; on 2026-10-13 it was indexing thousands of gate checkouts under load.
 */
function tempRoot() {
  const root = join(tmpdir(), 'keel.noindex');
  mkdirSync(root, { recursive: true });
  return root;
}

/** Give the owner write access to every directory under dir, never following a symlink, so it can be removed. */
export function makeRemovable(dir) {
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) makeRemovable(join(dir, e.name));
}

/**
 * Run fn inside a temporary detached worktree at ref; always removes it (REQ-GATE-1). Its name carries this pid, so the
 * cleanup can tell a checkout a killed gate left from one a running gate uses (REQ-CLEAN-5). A check may leave a read-only
 * directory (a module cache), so the checkout is made writable before removal. A removal failure is reported on
 * stderr and never replaces fn's result or error: the stage result and its receipt matter more than the temp dir.
 */
export function withTempWorktree(repo, ref, fn) {
  const dir = mkdtempSync(join(tempRoot(), `keel-wt-${process.pid}-`));
  let added = false;
  try {
    git(['worktree', 'add', '--detach', '--quiet', dir, ref], repo);
    added = true;
    return fn(dir);
  } finally {
    try {
      if (existsSync(dir)) makeRemovable(dir);
      rmSync(dir, { recursive: true, force: true });
      if (added) git(['worktree', 'prune'], repo);
    } catch (e) {
      process.stderr.write(`keel: could not remove temporary checkout ${dir}: ${e.message}\n`);
    }
  }
}
