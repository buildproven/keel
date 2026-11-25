import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ISSUE_ID } from './check-card.js';
import { escapeRe, removeParkedWorktree } from './clean.js';
import { readCard } from './config.js';
import { exec } from './git.js';
import { stateDir } from './ledger.js';
import { runLockHeld } from './run-lock.js';
import { UsageError } from './usage.js';

const MIN = 60_000;
/** Waits for a plan reset before the chain stops (REQ-CHAIN-2). */
export const QUOTA_WAITS = 4;
/** Recoveries of a killed run before its card counts as failed (REQ-CHAIN-4). */
export const KILL_RETRIES = 3;
/** The longest wait for memory before a run starts (REQ-CHAIN-3). */
export const MEMORY_WAIT_MS = 120 * MIN;
const MEMORY_POLL_MS = 10_000;
const MEMORY_LOG_MS = 5 * MIN;
const RESET_MARGIN_MS = 2 * MIN;
const NO_RESET_WAIT_MS = 30 * MIN; // a quota stop that names no reset
/** Poll outcomes of a built card whose branch the next `ship` takes (REQ-CHAIN-1). */
const SHIPPED = new Set(['inReview', 'autoMerge', 'selfMerge']);
/** Poll outcomes that need no new build, but nothing to ship: a human reviews it, or the card was already done. */
const BUILT_ONLY = new Set(['needsReview', 'alreadyDone']);

/**
 * `keel chain <repo> <id...> [--ship] ...` from parseArgs tokens (REQ-CHAIN-1): the repo and the steps in the order
 * given, `{ id }` for a Linear issue, `{ id, card }` for a card file (its id from the card, as `keel run` reads it), and
 * `{ ship: true }` for each `--ship`. Any other option, or an item that is neither an issue ID nor a file, is a usage
 * error; a card file that does not parse is the parser's CardError.
 */
export function chainSteps(tokens) {
  const at = tokens.findIndex((t) => t.kind === 'positional' && t.value === 'chain');
  const rest = tokens.filter((t, i) => i !== at && t.kind !== 'option-terminator');
  const bad = rest.find((t) => t.kind === 'option' && t.name !== 'ship');
  if (bad) throw new UsageError(`chain takes only --ship as an option (got ${bad.rawName})`);
  const [first, ...items] = rest;
  if (!first || first.kind !== 'positional') throw new UsageError('chain needs a repo dir first: keel chain <repo> <id...> [--ship]');
  const steps = items.map((t) => {
    if (t.kind === 'option') return { ship: true };
    // As `keel run`: an issue ID that is not a file is a Linear issue (REQ-CLI-8); a file is a card.
    if (ISSUE_ID.test(t.value) && !existsSync(t.value)) return { id: t.value };
    if (!existsSync(t.value))
      throw new UsageError(`chain builds issues or cards; ${JSON.stringify(t.value)} is neither an issue ID like BUI-123 nor a card file`);
    const card = resolve(t.value);
    return { id: readCard(card).id, card };
  });
  if (!steps.some((s) => s.id)) throw new UsageError('chain needs at least one issue ID or card file');
  return { repo: resolve(first.value), steps };
}

/** The chain's state file for a repo (REQ-CHAIN-6): `<state>/chain/<repo name>.json`. */
export const chainStateFile = (repo, dir = stateDir()) => join(dir, 'chain', `${basename(resolve(repo))}.json`);

/**
 * The memory kill line in percent of memory available (REQ-CHAIN-3): `KEEL_MEMORY_LINE`, else the memory watchdog's
 * own line (`MEMWATCH_MIN_AVAILABLE`), else 40, so the chain waits for the line the watchdog kills runs at.
 */
export function memoryLine(env = process.env) {
  const name = ['KEEL_MEMORY_LINE', 'MEMWATCH_MIN_AVAILABLE'].find((k) => env[k] !== undefined);
  if (!name) return 40;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < 1 || n > 94)
    throw new UsageError(`${name} must be an integer from 1 to 94 (got ${JSON.stringify(env[name])})`);
  return n;
}

/**
 * Memory available now in percent (REQ-CHAIN-3), or null when this machine cannot tell: macOS
 * `kern.memorystatus_level`; Linux MemAvailable of MemTotal (the readings of REQ-SLOT-1).
 */
export function availableMemory(os = platform(), run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }), read = readFileSync) {
  if (os === 'darwin') {
    const r = run('sysctl', ['-n', 'kern.memorystatus_level']);
    const n = Number(String(r.stdout ?? '').trim());
    return r.status === 0 && Number.isFinite(n) ? n : null;
  }
  if (os === 'linux') {
    const text = read('/proc/meminfo', 'utf8');
    const kb = (k) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]);
    const pct = (100 * kb('MemAvailable')) / kb('MemTotal');
    return Number.isFinite(pct) ? Math.floor(pct) : null;
  }
  return null;
}

const OUTPUT_KEEP = 256 * 1024; // the tail of a run's output the chain reads; the rest is only on the terminal

/** Run a command with its output on stderr as it comes, and keep its tail; resolves `{ code, signal, output }`. */
function teeRun(cmd, args, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (chunk) => {
      process.stderr.write(chunk);
      output = (output + chunk).slice(-OUTPUT_KEEP);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, output }));
  });
}

const KEEL_BIN = new URL('../bin/keel.js', import.meta.url).pathname;

/** The real card build of the chain: `keel run <issue id | card file> --repo <repo>` as a child process (REQ-CHAIN-1). */
export const spawnRun =
  (repo) =>
  (id, target = id) =>
    teeRun(process.execPath, [KEEL_BIN, 'run', target, '--repo', repo], repo);

/** The real ship step: `ship <repo> <branch...>` from PATH (REQ-CHAIN-1). */
export const spawnShip = (repo, branches) => teeRun('ship', [repo, ...branches], repo);

/**
 * The reset time a deferral names (REQ-CHAIN-2), as ms, or null: the last `next reset <Date#toString time>` that
 * `keel poll` prints (REQ-PLAN-3), else the last ISO 8601 time on a line that says reset.
 */
export function resetTime(out) {
  const named = [...out.matchAll(/next reset ([A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2})/g)].at(-1);
  const iso = [...out.matchAll(/reset[^\n]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/gi)].at(-1);
  const at = named ? new Date(named[1]).getTime() : iso ? Date.parse(iso[1]) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * What one run of a card tells the chain (REQ-CHAIN-1..5). An issue run ends with the poll line `<id>: <outcome>`
 * (REQ-RUN-51); a card-file run with `PASS tier …` or `STOPPED (<class>) …` (REQ-RUN-13).
 */
function classify(id, r) {
  const out = r.output ?? '';
  const outcome = new RegExp(`^keel: ${escapeRe(id)}: (\\w+)(.*)$`, 'm').exec(out);
  if (outcome && SHIPPED.has(outcome[1])) return { built: true, ship: true };
  if (outcome && BUILT_ONLY.has(outcome[1])) return { built: true, ship: false, note: outcome[1] };
  const pass = /^keel: PASS tier \d+, attempt \d+, branch \S+( — human review required)?/m.exec(out);
  if (pass && r.code === 0) return pass[1] ? { built: true, ship: false, note: 'needsReview' } : { built: true, ship: true };
  const stopped = /^keel: (STOPPED \((\w[\w-]*)\).*)$/m.exec(out);
  if (/plan limit reached/.test(out) || (outcome?.[1] === 'deferred' && /^ \(quota\b/.test(outcome[2])) || stopped?.[2] === 'quota')
    return { quota: true, reset: resetTime(out) };
  if (r.signal || (typeof r.code === 'number' && r.code >= 128))
    return { killed: true, reason: `killed (${r.signal ?? `exit ${r.code}`})` };
  if (/worktree exists: /.test(out)) return { leftover: true, reason: 'a leftover worktree refused the run' };
  const last = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  const reason = outcome
    ? `${outcome[1]}${outcome[2]}`
    : stopped
      ? stopped[1].slice(0, 300)
      : `exit ${r.code}${last ? `: ${last.slice(0, 300)}` : ''}`;
  return { reason };
}

/** The card's worktree and run lock, as `keel run` names them (run.js: `<repo>-<8-hex repo key>-<card id>`). */
function cardPaths(repo, id) {
  const key = `${basename(repo)}-${createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)}-${id}`;
  return { wt: join(stateDir(), 'worktrees', key), lock: join(stateDir(), 'locks', key) };
}

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/**
 * A `wip/<id>-<stamp>` name not on origin yet (REQ-CHAIN-4), `-2`, `-3`, … added when a save of the same minute took it:
 * a rerun built from base again is no descendant of the first save, so a push to that name would be refused.
 * Returns `{ name }`, or `{ error }` when origin cannot be read.
 */
function freeRef({ repo, id, stamp }) {
  const base = `wip/${id}-${stamp}`;
  const r = exec('git', ['ls-remote', 'origin', `refs/heads/${base}*`], repo);
  if (r.status !== 0) return { error: `could not push the worktree to ${base}: ${`${r.stderr}${r.stdout}`.trim().slice(-300)}` };
  const taken = new Set(r.stdout.split('\n').map((l) => l.split('\t')[1]?.replace(/^refs\/heads\//, '')));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return { name };
}

/**
 * Save a killed run's worktree to `wip/<id>-<time>` on origin and remove it (REQ-CHAIN-4). Its uncommitted work, tracked
 * and untracked, goes in a commit built in a temporary index, so no hook runs and the worktree is not changed. Returns
 * `{ ref }` when it was saved and removed, else an error text. Nothing is removed when a step fails.
 */
function saveLeftover({ repo, id, wt, now }) {
  const index = mkdtempSync(join(tmpdir(), 'keel-chain-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(index, 'index') };
    const git = (args) => spawnSync('git', args, { cwd: wt, env, encoding: 'utf8' });
    // Only a worktree on its own keel/<id> branch: then HEAD holds every commit of that branch, so the save holds all of
    // it. A worker can switch it to another branch or detach it; that one is left for a human (as REQ-CLEAN-2).
    const on = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
    if (on !== `keel/${id}`) return `${wt} is on ${on || 'a detached HEAD'}, not keel/${id}; not saved or removed`;
    const head = git(['rev-parse', 'HEAD']);
    if (head.status !== 0) return `cannot read HEAD of ${wt}: ${head.stderr.trim()}`;
    const stamp = stampOf(now());
    for (const args of [
      ['read-tree', 'HEAD'],
      ['add', '-A'],
    ]) {
      const r = git(args);
      if (r.status !== 0) return `git ${args[0]} in ${wt} failed: ${r.stderr.trim()}`;
    }
    const written = git(['write-tree']);
    if (written.status !== 0) return `git write-tree in ${wt} failed: ${written.stderr.trim()}`;
    const tree = written.stdout.trim();
    let sha = head.stdout.trim();
    if (tree !== git(['rev-parse', 'HEAD^{tree}']).stdout.trim()) {
      const c = git(['commit-tree', tree, '-p', sha, '-m', `wip(${id}): work of a killed run (backup ${stamp})`]);
      if (c.status !== 0) return `git commit-tree in ${wt} failed: ${c.stderr.trim()}`;
      sha = c.stdout.trim();
    }
    const ref = freeRef({ repo, id, stamp });
    if (ref.error) return ref.error;
    const push = exec('git', ['push', '-q', 'origin', `${sha}:refs/heads/${ref.name}`], repo);
    if (push.status !== 0) return `could not push the worktree to ${ref.name}: ${`${push.stderr}${push.stdout}`.trim().slice(-300)}`;
    removeParkedWorktree({ repo, path: wt, branch: `keel/${id}`, force: true });
    return { ref: ref.name };
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

/**
 * Wait until memory is at the line + 5 % when it is under the line (REQ-CHAIN-3); false after MEMORY_WAIT_MS. A reading
 * that becomes unreadable ends the wait: the machine cannot tell, as when it never could.
 */
async function memoryReady({ id, memory, killLine, sleep, now, log }) {
  let level = memory();
  if (level === null || level >= killLine) return true;
  const target = killLine + 5;
  const start = now();
  let logged = start;
  log(`chain: ${id}: available memory ${level}% is under the ${killLine}% line; waiting for ${target}% before the run`);
  while (level !== null && level < target) {
    if (now() - start >= MEMORY_WAIT_MS) return false;
    await sleep(MEMORY_POLL_MS);
    level = memory();
    if (now() - logged >= MEMORY_LOG_MS) {
      logged = now();
      log(`chain: ${id}: still waiting for ${target}% available memory (now ${level ?? 'unreadable'}%)`);
    }
  }
  return true;
}

/** Build one card until it is built, fails, or the chain must stop (REQ-CHAIN-2..5). */
async function buildCard({ repo, id, target, runCard, memory, killLine, sleep, now, log }) {
  let waits = 0;
  let recoveries = 0;
  for (;;) {
    if (!(await memoryReady({ id, memory, killLine, sleep, now, log })))
      return { stop: 'memory', reason: `available memory stayed under ${killLine + 5}% for ${MEMORY_WAIT_MS / MIN} minutes` };
    log(`chain: ${id}: keel run`);
    const r = await runCard(id, target);
    const v = classify(id, r);
    if (v.built) return v;
    if (v.quota) {
      if (++waits > QUOTA_WAITS) return { stop: 'quota', reason: `still out of quota after ${QUOTA_WAITS} waits` };
      const at = now();
      const wake = v.reset === null ? at + NO_RESET_WAIT_MS : v.reset + RESET_MARGIN_MS;
      log(`chain: ${id}: plan limit; waiting until ${new Date(wake).toString().slice(0, 21)} (wait ${waits} of ${QUOTA_WAITS})`);
      if (wake > at) await sleep(wake - at);
      continue;
    }
    if (v.killed || v.leftover) {
      const { wt, lock } = cardPaths(repo, id);
      if (existsSync(wt) && runLockHeld(lock)) return { reason: `${v.reason}; a live keel run holds ${wt}` };
      if (++recoveries > KILL_RETRIES) return { reason: `${v.reason}, ${KILL_RETRIES} times` };
      if (existsSync(wt)) {
        const saved = saveLeftover({ repo, id, wt, now });
        if (typeof saved === 'string') {
          log(`chain: ${id}: ${saved}; left ${wt}`);
          return { reason: saved };
        }
        log(`chain: ${id}: saved the killed run's worktree to ${saved.ref} and removed it`);
      }
      log(`chain: ${id}: ${v.reason}; running it again (${recoveries} of ${KILL_RETRIES})`);
      continue;
    }
    return v;
  }
}

/**
 * The chain's state for this repo (REQ-CHAIN-6). Built cards are kept from any earlier chain, so a built card is never
 * built again, and so are branches not shipped yet. Failed cards are skipped only when the earlier chain did not finish
 * (it still lists remaining cards); after a finished chain they are tried again. A state of another repo of the same
 * name is not used.
 */
function startState(file, repo, steps, log) {
  const fresh = { repo, steps, built: [], failed: [], reasons: {}, remaining: [], pending: [], done: false };
  if (!existsSync(file)) return fresh;
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`chain state ${file} is not valid JSON (${e.message}); fix or remove it`);
  }
  if (saved === null || typeof saved !== 'object' || (saved.repo !== undefined && saved.repo !== repo)) return fresh;
  const list = (k) => (Array.isArray(saved[k]) ? saved[k].filter((x) => typeof x === 'string') : []);
  const unfinished = list('remaining').length > 0;
  const state = {
    ...fresh,
    built: list('built'),
    pending: list('pending'),
    failed: unfinished ? list('failed') : [],
    reasons: unfinished && saved.reasons && typeof saved.reasons === 'object' ? saved.reasons : {},
  };
  log(`chain: state ${file}: built ${state.built.length}, failed ${state.failed.length}${unfinished ? `, resuming` : ''}`);
  return state;
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.tmp`;
  writeFileSync(part, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(part, file); // a crash mid-write leaves the last whole state
}

/**
 * `keel chain` (REQ-CHAIN-1..6): build each card in order, run `ship` for the branches built since the last ship at each
 * `--ship` step and at the end, and keep the progress in `stateFile` after every step. Resolves `{ exitCode, state }`:
 * 0 when every card was built and every ship passed, 1 when a card failed or a ship failed, 3 when quota or memory
 * stopped the chain (the next `keel chain` of the same list resumes it).
 */
export async function chain({
  repo,
  steps,
  runCard,
  ship,
  memory = () => availableMemory(),
  killLine = 40,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = () => {},
  stateFile = chainStateFile(repo),
}) {
  const state = startState(stateFile, repo, steps, log);
  // Cards from step `from` on that this chain has still to build (REQ-CHAIN-6).
  const save = (from) => {
    state.remaining = steps
      .slice(from)
      .filter((s) => s.id && !state.built.includes(s.id) && !state.failed.includes(s.id))
      .map((s) => s.id);
    saveState(stateFile, state);
  };
  let shipFailed = false;
  const shipPending = async (from) => {
    if (!state.pending.length) return;
    const branches = state.pending.map((id) => `keel/${id}`);
    log(`chain: ship ${branches.join(' ')}`);
    const r = await ship(repo, branches);
    if (r.code === 0) state.pending = [];
    else {
      shipFailed = true;
      log(`chain: ship failed (${r.signal ?? `exit ${r.code}`}); ${branches.join(' ')} stay queued for the next ship`);
    }
    save(from);
  };
  save(0);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.ship) {
      await shipPending(i + 1);
      continue;
    }
    if (state.built.includes(step.id) || state.failed.includes(step.id)) {
      log(`chain: ${step.id}: ${state.built.includes(step.id) ? 'built' : 'failed'} in this chain already; not built again`);
      continue;
    }
    const v = await buildCard({ repo, id: step.id, target: step.card ?? step.id, runCard, memory, killLine, sleep, now, log });
    if (v.stop) {
      log(`chain: ${step.id}: stopped (${v.stop}): ${v.reason}; the next keel chain of this list resumes here`);
      save(i);
      await shipPending(i);
      return { exitCode: 3, state };
    }
    if (v.built) {
      state.built.push(step.id);
      if (v.ship) state.pending.push(step.id);
      log(`chain: ${step.id}: built${v.note ? ` (${v.note}; not shipped)` : ''}`);
    } else {
      state.failed.push(step.id);
      state.reasons[step.id] = v.reason;
      log(`chain: ${step.id}: not built: ${v.reason}; going on to the next card`);
    }
    save(i + 1);
  }
  await shipPending(steps.length);
  state.done = true;
  save(steps.length);
  return { exitCode: state.failed.length || shipFailed ? 1 : 0, state };
}
