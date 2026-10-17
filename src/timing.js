import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './git.js';
import { appendJsonl, readJsonl } from './ledger.js';

/** `4s`, `3m12s` (REQ-GATE-45). */
export const fmtMs = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Stage name → ms for every result that was timed (REQ-GATE-45). */
export const checkTimes = (results) => Object.fromEntries(results.filter((r) => typeof r.ms === 'number').map((r) => [r.name, r.ms]));

/** One `keel gate` line with each timed stage, slowest work visible at a glance (REQ-GATE-45). */
export function timingLine(results, waitMs = 0) {
  const times = Object.entries(checkTimes(results));
  if (!times.length) return null;
  const total = times.reduce((n, [, ms]) => n + ms, 0);
  // Slot queue time leads, apart from the work, so a slow gate shows whether it worked or waited (REQ-GATE-47).
  const wait = waitMs >= 1000 ? `wait ${fmtMs(waitMs)} · ` : '';
  return `timing ${wait}${times.map(([name, ms]) => `${name} ${fmtMs(ms)}`).join(' · ')} · total ${fmtMs(total + waitMs)}`;
}

/** Waiting longer than this for gate slots earns an IMPROVE line (REQ-GATE-47). */
const WAIT_LIMIT_MS = 60_000;

/** The repository a checkout belongs to: its real git common dir, so every worktree of it matches (REQ-GATE-46). */
export const repoIdOf = (repo) => realpathSync(resolve(repo, git(['rev-parse', '--git-common-dir'], repo).trim()));

/** Absolute limits (ms) above which a stage is slow whatever its history (REQ-GATE-46). */
const LIMIT_MS = { review: 300_000, 'test-edits': 300_000 };
const DEFAULT_LIMIT_MS = 120_000;
const RATIO = 1.5;
const NOISE_MS = 30_000; // a slowdown smaller than this is noise, not a regression
const MIN_SAMPLES = 3;
const WINDOW = 20;

/**
 * Why the red proof ran the whole suite on base though `testFilesCommand` is set, from the head's `targeted-on-head`
 * row (REQ-GATE-33, -46); null when it is not set (no row) or the proof was targeted.
 */
function untargetedReason(results) {
  const row = results.find((r) => r.name === 'targeted-on-head');
  if (!row || row.targeted) return null;
  if (row.unseen?.length)
    return `the suite output names no new test file (${row.unseen.join(', ')}) and no node --test glob of testCommand matches it, so the red proof ran the whole suite on base; make the runner print file names, or name the files in a node --test glob`;
  return 'testFilesCommand failed on head for the new test files, so the red proof ran the whole suite on base; check that it runs them';
}

/** The likeliest fix for a slow stage, by name (REQ-GATE-46). */
export function hintFor(name) {
  if (/^(test|regression-on-head|held-out|targeted-on-head)$/.test(name) || name.startsWith('acceptance:'))
    return 'run tests in parallel (pytest -n auto with pytest-xdist; node --test unless --test-concurrency=1; no jest --runInBand), or split the slowest tests';
  if (name === 'red-proof') return 'set testFilesCommand so the red proof runs only the new test files on base';
  if (name === 'install') return 'cache dependencies, or drop install and let the gate link shared dirs';
  if (name === 'review' || name === 'test-edits') return 'review time grows with the diff; split the card into smaller changes';
  if (name === 'mutation') return 'mutate only the changed files';
  if (/lint|format|type/.test(name)) return 'check only changed files or turn on the tool cache (ruff/eslint --cache, mypy incremental)';
  return 'profile this command; it is one of the slowest steps';
}

/**
 * `IMPROVE:` lines for this gate's stages against the trailing median of earlier gates of the same repository
 * (REQ-GATE-46): a stage over its absolute limit, or more than 1.5× its median (and 30 s more) once 3 earlier
 * gates timed it. Only passing earlier gates count, since a failing gate stops early and is not comparable.
 */
export function improveLines(times, history, results = []) {
  const lines = [];
  for (const [name, ms] of Object.entries(times)) {
    const past = history
      .filter((h) => h.pass && typeof h.checks?.[name] === 'number')
      .slice(-WINDOW)
      .map((h) => h.checks[name]);
    const med = past.length >= MIN_SAMPLES ? median(past) : null;
    const limit = LIMIT_MS[name] ?? DEFAULT_LIMIT_MS;
    const slower = med !== null && ms > med * RATIO && ms - med > NOISE_MS;
    if (ms <= limit && !slower) continue;
    const why = [
      ...(ms > limit ? [`over the ${fmtMs(limit)} limit`] : []),
      ...(med !== null ? [`median ${fmtMs(med)} over ${past.length} gates`] : []),
    ].join('; ');
    lines.push(`IMPROVE: ${name} took ${fmtMs(ms)} (${why}): ${(name === 'red-proof' && untargetedReason(results)) || hintFor(name)}`);
  }
  return lines;
}

/**
 * Record this gate's stage times and return its IMPROVE lines (REQ-GATE-46). One row per gate in
 * `gate-times.jsonl` beside the receipts: { repo, card, head, pass, at, checks: { stage: ms } }.
 */
export function recordGateTimes(file, { repo, card, head, pass, results, waitMs = 0 }) {
  const checks = checkTimes(results);
  if (!Object.keys(checks).length) return [];
  const id = repoIdOf(repo);
  const history = readJsonl(file).filter((r) => r.repo === id);
  const lines = [...waitLines(waitMs), ...improveLines(checks, history, results)];
  appendJsonl(file, { repo: id, card, head, pass, at: new Date().toISOString(), waitMs, checks });
  return lines;
}

/** An IMPROVE line when the gate queued over a minute for slots (REQ-GATE-47). */
export const waitLines = (waitMs) =>
  waitMs > WAIT_LIMIT_MS
    ? [
        `IMPROVE: waited ${fmtMs(waitMs)} for gate slots: other gates or work outside keel held the CPU or memory (slots follow idle CPU, REQ-SLOT-1); run fewer builders at once or stop idle sessions' test runs`,
      ]
    : [];

/** Per repository, the stage with the highest median over its last N passing gates (REQ-LED-18). */
export function slowestChecks(rows, last = WINDOW) {
  const byRepo = new Map();
  for (const r of rows) if (r.pass && r.checks) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const out = [];
  for (const [repo, gates] of byRepo) {
    const recent = gates.slice(-last);
    const names = new Set(recent.flatMap((g) => Object.keys(g.checks)));
    let worst = null;
    for (const name of names) {
      const xs = recent.map((g) => g.checks[name]).filter((x) => typeof x === 'number');
      const m = median(xs);
      if (!worst || m > worst.medianMs) worst = { repo, check: name, medianMs: m, n: xs.length };
    }
    if (worst) out.push({ ...worst, gates: recent.length });
  }
  return out.sort((a, b) => b.medianMs - a.medianMs);
}

export const formatSlowest = (list) =>
  list.length
    ? [
        'slowest check per repo (median, last passing gates):',
        ...list.map((s) => `  ${s.repo}: ${s.check} ${fmtMs(s.medianMs)} (${s.n} of ${s.gates} gates)`),
      ].join('\n')
    : 'slowest check per repo: no timed gates yet';

/** What a check command really runs: `npm test` / `npm run X` expanded through package.json, split on && ; || (REQ-CLI-13). */
/**
 * The `scripts` of package.json, read only when a command names npm. A file that is not JSON leaves npm commands
 * unexpanded: speed advice never fails the doctor (REQ-CLI-13), and the checks themselves report a broken manifest.
 */
function npmScripts(dir) {
  const pkgFile = resolve(dir, 'package.json');
  if (!existsSync(pkgFile)) return {};
  try {
    return JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {};
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return {};
  }
}

export function expandCommand(command, dir, depth = 0) {
  let scripts = null;
  return command
    .split(/&&|\|\||;/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const m = part.match(/^npm (?:run(?:-script)? |)(test|[\w:.-]+)$/);
      const name = m && (m[1] === 'test' || part.startsWith('npm run')) ? m[1] : null;
      if (name) scripts ??= npmScripts(dir);
      return name && scripts[name] && depth < 3 ? expandCommand(scripts[name], dir, depth + 1) : [part];
    });
}

const PYTEST_CONFIGS = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'];

/** Why a test command runs on one worker, or null when it runs in parallel or is not recognised (REQ-CLI-13). */
export function serialReason(command, dir) {
  const parts = expandCommand(command, dir);
  for (const p of parts) {
    if (/\bpytest\b/.test(p) && !/(^|\s)(-n|--numprocesses)(\s|=|$)/.test(p)) {
      const addopts = PYTEST_CONFIGS.map((f) => resolve(dir, f))
        .filter(existsSync)
        .some((f) => /addopts[^\n]*(-n|--numprocesses)\b/.test(readFileSync(f, 'utf8')));
      if (!addopts) return `pytest runs on one core: add pytest-xdist and \`-n auto\` to "${p}"`;
    }
    if (/node --test\b/.test(p) && /--test-concurrency[= ]1\b/.test(p))
      return `"${p}" runs test files one at a time: drop --test-concurrency=1`;
    if (/\bjest\b/.test(p) && /(--runInBand|\s-i(\s|$))/.test(p)) return `"${p}" runs in band: drop --runInBand`;
    if (/\bvitest\b/.test(p) && /--no-file-parallelism/.test(p)) return `"${p}" disables file parallelism: drop --no-file-parallelism`;
  }
  return null;
}

/** Commands two configured checks both run, so the gate pays for them twice (REQ-CLI-13). */
export function duplicateWork(commands, dir) {
  const seen = new Map();
  for (const [name, command] of Object.entries(commands))
    for (const part of new Set(expandCommand(command, dir))) seen.set(part, [...(seen.get(part) ?? []), name]);
  return [...seen].filter(([, names]) => new Set(names).size > 1).map(([part, names]) => ({ part, names: [...new Set(names)] }));
}
