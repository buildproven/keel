import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exec, showFile } from './git.js';
import { UsageError } from './usage.js';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const table = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TOP_KEYS = ['active', 'projects'];
const PROJECT_KEYS = ['repo', 'paused', 'limit', 'base'];
const positiveInt = (n) => Number.isInteger(n) && n >= 1;

/** The ranked project list (REQ-MULTI-1): `$KEEL_PROJECTS_FILE`, else `${XDG_CONFIG_HOME:-~/.config}/keel/projects.json`. */
export const projectsFile = (env = process.env) =>
  env.KEEL_PROJECTS_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'keel', 'projects.json');

/** `~` and `~/…` name the home directory, so a hand-written list reads like a shell path. */
const expand = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * The project list at `file` (REQ-MULTI-1), validated: `{ active, projects: [{ repo, paused, limit, base }] }`, list
 * order is priority. A missing file is an empty list; anything malformed is an error that names the file, never a
 * silently shorter list.
 */
export function readProjects(file = projectsFile()) {
  if (!existsSync(file)) return { active: null, projects: [] };
  const bad = (msg) => {
    throw new Error(`${file}: ${msg}`);
  };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    bad(`not valid JSON (${e.message})`);
  }
  if (!table(data)) bad('must be a JSON object with "projects"');
  const unknown = Object.keys(data).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length) bad(`unknown keys: ${unknown.join(', ')}`);
  const active = own(data, 'active') ? data.active : null;
  if (active !== null && !positiveInt(active)) bad('"active" must be a positive integer or null (all)');
  if (!Array.isArray(data.projects ?? [])) bad('"projects" must be an array');
  const seen = new Set();
  const projects = (data.projects ?? []).map((p, i) => {
    const at = `projects[${i}]`;
    if (typeof p === 'string') p = { repo: p };
    if (!table(p)) bad(`${at} must be a path or an object with "repo"`);
    const extra = Object.keys(p).filter((k) => !PROJECT_KEYS.includes(k));
    if (extra.length) bad(`${at}: unknown keys: ${extra.join(', ')}`);
    if (typeof p.repo !== 'string' || !p.repo.trim()) bad(`${at}: "repo" must be a non-empty path`);
    if (own(p, 'paused') && typeof p.paused !== 'boolean') bad(`${at}: "paused" must be true or false`);
    if (own(p, 'limit') && !positiveInt(p.limit)) bad(`${at}: "limit" must be a positive integer`);
    if (own(p, 'base') && !(typeof p.base === 'string' && p.base.trim())) bad(`${at}: "base" must be a non-empty ref`);
    const repo = resolve(expand(p.repo));
    if (seen.has(repo)) bad(`${at}: ${repo} is listed twice`);
    seen.add(repo);
    return { repo, paused: p.paused ?? false, limit: p.limit ?? null, base: p.base ?? null };
  });
  return { active, projects };
}

/** Write the list back (REQ-MULTI-4): only the keys that differ from their defaults, through a rename so a crash leaves the old file. */
export function writeProjects(file, { active, projects }) {
  const rows = projects.map((p) => ({
    repo: p.repo,
    ...(p.paused ? { paused: true } : {}),
    ...(p.limit ? { limit: p.limit } : {}),
    ...(p.base ? { base: p.base } : {}),
  }));
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ active, projects: rows }, null, 2)}\n`);
  renameSync(temp, file);
}

/** The projects Keel works on (REQ-MULTI-2): the first `active` (all when null) that are not paused, in rank order. */
export function activeProjects({ active, projects }) {
  const live = projects.filter((p) => !p.paused);
  return active === null ? live : live.slice(0, active);
}

/** A project's state for the list (REQ-MULTI-2, -3): active, paused, or beyond the active count. */
export function projectState(data, project) {
  if (project.paused) return 'paused';
  return activeProjects(data).some((p) => p.repo === project.repo) ? 'active' : 'waiting';
}

const indexOf = (data, dir) => data.projects.findIndex((p) => p.repo === resolve(expand(dir)));

/** The listed project for `dir`, else a usage error (REQ-MULTI-4). */
function listed(data, dir) {
  const i = indexOf(data, dir);
  if (i === -1) throw new UsageError(`${resolve(expand(dir))} is not in the project list; add it with keel projects add <dir>`);
  return i;
}

/**
 * Add a git repo at `rank` (1-based; default last), or move it there when it is already listed (REQ-MULTI-4). Returns
 * the new list; the caller writes it.
 */
export function addProject(data, dir, rank = null) {
  const repo = resolve(expand(dir));
  const top = exec('git', ['rev-parse', '--show-toplevel'], repo);
  if (top.status !== 0) throw new UsageError(`${repo} is not a git repository`);
  const projects = [...data.projects];
  const i = indexOf(data, repo);
  const entry = i === -1 ? { repo, paused: false, limit: null, base: null } : projects.splice(i, 1)[0];
  if (rank !== null && !positiveInt(rank)) throw new UsageError('--rank must be a positive integer');
  projects.splice(rank === null ? projects.length : Math.min(rank - 1, projects.length), 0, entry);
  return { ...data, projects };
}

export function removeProject(data, dir) {
  const i = listed(data, dir);
  return { ...data, projects: data.projects.filter((_, j) => j !== i) };
}

export function setPaused(data, dir, paused) {
  const i = listed(data, dir);
  return { ...data, projects: data.projects.map((p, j) => (j === i ? { ...p, paused } : p)) };
}

/** `active <N|all>` (REQ-MULTI-4): how many of the top unpaused projects Keel works on. */
export function setActive(data, value) {
  if (value === 'all') return { ...data, active: null };
  const n = Number(value);
  if (!/^[0-9]+$/.test(String(value ?? '')) || !positiveInt(n)) throw new UsageError('active takes a positive integer or "all"');
  return { ...data, active: n };
}

/**
 * What `keel projects` shows for one repo (REQ-MULTI-3): whether its HEAD has a keel.json, and the Linear project it
 * names. Read from the committed HEAD, as `keel poll` reads policy from a ref.
 */
export function inspectProject(repo) {
  if (!existsSync(repo)) return { found: false };
  if (exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], repo).status !== 0) return { found: true, keelJson: false };
  const text = showFile('HEAD', 'keel.json', repo);
  if (text === null) return { found: true, keelJson: false };
  let linearProject = null;
  try {
    linearProject = JSON.parse(text).linearProject ?? null;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return { found: true, keelJson: true, invalid: true };
  }
  return { found: true, keelJson: true, linearProject };
}

/** The `keel projects` listing (REQ-MULTI-3): rank, state, repo, and what Keel needs that the repo lacks. */
export function formatProjects(data, file, inspect = inspectProject) {
  const head = `Projects (${file}): ${data.active === null ? 'all unpaused are active' : `top ${data.active} unpaused are active`}`;
  if (!data.projects.length) return `${head}\n  none yet: keel projects add <dir> [--rank N]`;
  const lines = data.projects.map((p, i) => {
    const info = inspect(p.repo);
    const notes = [];
    if (!info.found) notes.push('missing directory');
    else if (!info.keelJson) notes.push('no keel.json at HEAD (keel init)');
    else if (info.invalid) notes.push('keel.json is not valid JSON');
    else notes.push(info.linearProject ? `linear ${info.linearProject}` : 'no linearProject (poll skips it)');
    if (p.limit) notes.push(`limit ${p.limit}`);
    if (p.base) notes.push(`base ${p.base}`);
    return `  ${String(i + 1).padStart(2)}. ${projectState(data, p).padEnd(7)} ${p.repo} — ${notes.join(', ')}`;
  });
  return [head, ...lines].join('\n');
}
