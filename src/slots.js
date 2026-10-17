import { spawnSync } from 'node:child_process';
import { availableParallelism, cpus as cpuList, platform } from 'node:os';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A fixed slot count from KEEL_GATE_SLOTS (REQ-SLOT-1), or null: then the count follows the machine's idle CPU and memory. */
export function fixedSlots(env = process.env) {
  if (env.KEEL_GATE_SLOTS === undefined) return null;
  const n = Number(env.KEEL_GATE_SLOTS);
  if (!Number.isInteger(n) || n < 1) throw new Error(`KEEL_GATE_SLOTS must be an integer ≥ 1, got ${JSON.stringify(env.KEEL_GATE_SLOTS)}`);
  return n;
}

/** Below this share of idle CPU no new slot opens (REQ-SLOT-1). */
export const MIN_IDLE = 0.2;
/** Cores one more gate is assumed to need: its checks and parallel tests (REQ-SLOT-1). */
const CORES_PER_GATE = 2;

/** Total and idle CPU time over all cores, from os.cpus() (REQ-SLOT-1). */
const cpuTimes = () =>
  cpuList().reduce((a, { times: t }) => ({ total: a.total + t.user + t.nice + t.sys + t.idle + t.irq, idle: a.idle + t.idle }), {
    total: 0,
    idle: 0,
  });

/**
 * Share of CPU time idle over `ms` (REQ-SLOT-1), measured from os.cpus() time deltas. Not the load average: on macOS
 * that counts waiting threads too and lags by minutes, so it read 30 with 45 % of the CPU idle and starved the slots.
 */
export function cpuIdleShare(ms = 1000, sleep = sleepMs) {
  const a = cpuTimes();
  sleep(ms);
  const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? (b.idle - a.idle) / total : 1;
}

/**
 * Whether memory is short (REQ-SLOT-1): on macOS the kernel's pressure level is critical or under 15 % of memory is
 * available (`kern.memorystatus_level`); on Linux MemAvailable is under 15 % of MemTotal. os.freemem() is not used: on
 * macOS it leaves out reclaimable pages and reads under 1 % on a healthy machine. Elsewhere, or when the reading
 * fails, it is not short; the CPU reading still guards.
 */
export function memoryLow(os = platform(), run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }), read = readFileSync) {
  if (os === 'darwin') {
    const r = run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level']);
    const [pressure, availablePct] = String(r.stdout ?? '')
      .trim()
      .split(/\s+/)
      .map(Number);
    return r.status === 0 && (pressure >= 4 || availablePct < 15);
  }
  if (os === 'linux') {
    const kb = (k, text) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1]);
    const text = read('/proc/meminfo', 'utf8');
    return kb('MemAvailable', text) < 0.15 * kb('MemTotal', text);
  }
  return false;
}

/**
 * Slots the machine has room for now (REQ-SLOT-1): the gates running plus one per 2 idle cores, at most half the cores.
 * Under 20 % idle CPU, or short of memory, no new slot opens (the running count, at least 1). The running gates' own
 * load is already outside the idle share, so it is never counted twice.
 */
export function idleSlots({ idle, running, cpus, memLow }) {
  const cap = Math.max(1, Math.floor(cpus / 2));
  if (memLow || idle < MIN_IDLE) return Math.max(1, Math.min(cap, running));
  return Math.min(cap, Math.max(1, running + Math.floor((idle * cpus) / CORES_PER_GATE)));
}

/** Whether process `pid` lives; one under another user counts as alive (REQ-GATE-29, REQ-LEASE-1). */
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // REQ-GATE-29: ESRCH means the holder is gone; EPERM means it lives under another user.
    return e.code === 'EPERM';
  }
};

/**
 * A slot is free (no directory), held, or dead (its holder is gone, or wrote no pid within a minute). Another gate may
 * release it at any moment, so a file that vanishes while it is read means free (REQ-GATE-29).
 */
export function slotState(slot) {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    return alive(pid) ? 'held' : 'dead';
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    return Date.now() - statSync(slot).mtimeMs > 60000 ? 'dead' : 'held';
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return 'free';
  }
}

/** Slots held by a live process. */
export function slotsInUse(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((s) => /^slot-\d+$/.test(s) && slotState(join(dir, s)) === 'held').length;
}

/**
 * Free a dead slot (REQ-GATE-29), one gate at a time: under `<slot>.takeover`, taken with an atomic mkdir, the slot is
 * removed only if it is still dead. Without the lock, a gate that saw the slot dead removed it after another gate had
 * taken it over, and two gates ran in one slot (BUI-1200). Returns whether this call removed it. A lock left by a gate
 * that died inside the takeover is cleared after a minute.
 */
export function reclaim(slot) {
  const lock = `${slot}.takeover`;
  try {
    mkdirSync(lock);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60000) rmSync(lock, { recursive: true, force: true });
    } catch (e2) {
      if (e2.code !== 'ENOENT') throw e2; // the other gate finished its takeover meanwhile
    }
    return false;
  }
  try {
    if (slotState(slot) !== 'dead') return false;
    rmSync(slot, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Take a free slot: mkdir is atomic, so two gates never get the same one. A slot whose holder is gone is freed. */
function take(dir, size) {
  for (let i = 0; i < size; i++) {
    const slot = join(dir, `slot-${i}`);
    try {
      mkdirSync(slot);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const state = slotState(slot);
      if (state === 'held' || (state === 'dead' && !reclaim(slot))) continue;
      i--; // the slot is free now: try it again
      continue;
    }
    writeFileSync(join(slot, 'pid'), String(process.pid));
    return slot;
  }
  return null;
}

/**
 * Gates ahead of `mine` in the queue: live tickets that sort before it. A ticket whose gate is gone is removed, so a
 * crashed gate cannot hold the queue (REQ-GATE-29).
 */
function ahead(dir, mine) {
  let n = 0;
  for (const t of readdirSync(dir).filter((f) => f.startsWith('ticket-') && f < mine)) {
    if (alive(Number(t.split('-').pop()))) n++;
    else rmSync(join(dir, t), { force: true });
  }
  return n;
}

/**
 * Run fn holding one of the machine-wide slots in `dir` (REQ-GATE-29), waiting for one when all are held, so parallel
 * gates queue their heavy stages instead of pushing each other past the stage timeout. Slots go first come, first
 * served: each request leaves a ticket, and a gate takes a slot only while fewer live tickets are ahead of it than slots
 * are free. A ticket sorts by `since`, the gate's start time (REQ-SLOT-3), so each later stage of a started gate queues
 * ahead of gates that came after it, and the oldest gate finishes first. The count is `size` when fixed, else it follows
 * the machine's idle CPU and memory and is recomputed while waiting (REQ-SLOT-1); with no slot held, a gate always runs. The waiting
 * line names the count and is said again when it changes. The wait does not count against any stage timeout, since the
 * stage starts after it.
 */
export function withGateSlot(
  {
    dir,
    size = null,
    since = Date.now(),
    sleep = sleepMs,
    log,
    idle = () => cpuIdleShare(),
    memLow = () => memoryLow(),
    cpus = availableParallelism(),
  },
  fn,
) {
  mkdirSync(dir, { recursive: true });
  const ticket = join(dir, `ticket-${String(since).padStart(15, '0')}-${process.pid}`);
  writeFileSync(ticket, '');
  let slot = null;
  try {
    let said = null;
    for (;;) {
      const before = ahead(dir, basename(ticket));
      const running = slotsInUse(dir);
      const n = size ?? (running ? idleSlots({ idle: idle(), running, cpus, memLow: memLow() }) : 1);
      if (before < n - running) slot = take(dir, n);
      if (slot) break;
      const line = `waiting for gate slot (${running} running of ${n}${before ? `, ${before} ahead` : ''})`;
      if (line !== said) log(line);
      said = line;
      sleep(2000);
    }
  } finally {
    rmSync(ticket, { force: true });
  }
  try {
    return fn();
  } finally {
    if (holds(slot)) rmSync(slot, { recursive: true, force: true }); // never another gate's slot (BUI-1200)
  }
}

/** Whether `slot` still holds this process's pid. */
function holds(slot) {
  try {
    return readFileSync(join(slot, 'pid'), 'utf8') === String(process.pid);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return false;
  }
}
