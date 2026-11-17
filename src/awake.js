import { spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Timeouts that count only the time the machine is awake (REQ-GATE-67). Node's `spawnSync` timeout runs on a clock that,
 * on macOS, goes on while the machine sleeps, so a stage that started before a lid-closed Maintenance Sleep was killed
 * after 15 minutes of wall time with seconds of work done (BUI-1708). The command runs under this file as a watchdog
 * process: it ticks, and a gap between ticks much longer than a tick is time the machine (or the watchdog) was
 * suspended, so it counts as one tick only. The result has `spawnSync`'s shape, with its ETIMEDOUT error on a timeout.
 */
const WATCHDOG = fileURLToPath(import.meta.url);
const FORWARD = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** The tick of a timeout: a twentieth of it, 20 ms to 1 s. A gap over ten ticks is suspended time. */
export const tickFor = (timeoutMs) => Math.min(1000, Math.max(20, Math.floor(timeoutMs / 20)));

/** The awake time one tick interval adds: all of it, or one tick when the gap shows the machine was suspended. */
export const awakeMs = (gapMs, tickMs) => (gapMs > 10 * tickMs ? tickMs : gapMs);

/** `spawnSync(cmd, args, options)` with `timeoutMs` of awake time instead of `options.timeout`. */
export function spawnAwake(cmd, args, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`awake timeout must be a positive number, not ${timeoutMs}`);
  // A non-string command is a harness fault, as `spawnSync` treats it; argv would quietly make it a string.
  if (![cmd, ...args].every((a) => typeof a === 'string')) throw new TypeError(`command and arguments must be strings: ${cmd}`);
  const opts = { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] };
  delete opts.timeout; // the watchdog keeps the time
  const r = spawnSync(process.execPath, [WATCHDOG, String(timeoutMs), cmd, ...args], opts);
  const note = parseNote(r.output?.[3]);
  const { output, ...result } = r;
  const out = { ...result, output: output ? output.slice(0, 3) : output };
  const fault = (code) => Object.assign(new Error(`spawnSync ${cmd} ${code}`), { code });
  if (note.error) return { ...out, status: null, signal: null, error: fault(note.error) };
  // The child's own exit and signal, from the note; without one (the watchdog crashed), the watchdog's own.
  const exit = note.exit ? { status: note.exit.code, signal: note.exit.signal } : {};
  return { ...out, ...exit, ...(note.timedOut ? { error: fault('ETIMEDOUT') } : {}) };
}

/** The watchdog's lines on fd 3, merged: `{ timedOut }`, `{ error }` (a code), `{ exit: { code, signal } }`. */
function parseNote(raw) {
  const lines = raw ? String(raw).split('\n').filter(Boolean) : [];
  return Object.assign({}, ...lines.map((l) => JSON.parse(l)));
}

/** The watchdog process: run the command with this process's stdio, kill it with SIGTERM after `timeoutMs` awake. */
function watch(timeoutMs, cmd, args) {
  const tickMs = tickFor(timeoutMs);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  const forward = Object.fromEntries(FORWARD.map((s) => [s, () => child.kill(s)]));
  for (const s of FORWARD) process.on(s, forward[s]);
  let awake = 0;
  let last = performance.now();
  let fired = false;
  const timer = setInterval(() => {
    const now = performance.now();
    awake += awakeMs(now - last, tickMs);
    last = now;
    if (awake >= timeoutMs && !fired) {
      fired = true;
      writeSync(3, `${JSON.stringify({ timedOut: true })}\n`);
      child.kill('SIGTERM');
    }
  }, tickMs);
  child.on('error', (e) => {
    if (child.pid !== undefined) throw e; // a failure after start (a kill that failed) is a harness fault, shown as a crash
    clearInterval(timer);
    writeSync(3, `${JSON.stringify({ error: e.code })}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    clearInterval(timer);
    for (const s of FORWARD) process.off(s, forward[s]);
    writeSync(3, `${JSON.stringify({ exit: { code, signal } })}\n`);
    process.exit(signal ? 128 + constants.signals[signal] : code); // as a shell reports it; the caller reads the note
  });
}

if (process.argv[1] === WATCHDOG) watch(Number(process.argv[2]), process.argv[3], process.argv.slice(4));
