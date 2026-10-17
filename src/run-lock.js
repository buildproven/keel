import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { alive } from './slots.js';

let taken = 0; // tells apart two locks of one process: a run that starts another run of the same card

/** Live entries of a card's run lock, `<lock>.run-<pid>-<n>`; entries of dead processes or with no pid are removed. */
function liveEntries(lock) {
  const dir = dirname(lock);
  const prefix = `${basename(lock)}.run-`;
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return []; // no locks dir yet: no run holds anything
    throw e;
  }
  const live = [];
  const legacy = legacyHolder(lock);
  if (legacy !== null) live.push({ file: null, pid: legacy });
  for (const f of names.filter((x) => x.startsWith(prefix))) {
    const pid = Number(f.slice(prefix.length).split('-')[0]);
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) live.push({ file: join(dir, f), pid });
    else rmSync(join(dir, f), { force: true }); // a crash leftover: removing it twice is harmless
  }
  return live;
}

/**
 * The live pid in a lock of the earlier layout, `<lock>/pid`, which a keel run started before this one may still hold;
 * null when there is none or its owner is dead. Such a dir is only read, never removed: it may still be in use.
 */
function legacyHolder(lock) {
  let text;
  try {
    text = readFileSync(join(lock, 'pid'), 'utf8');
  } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; // no lock of the earlier layout
    throw e;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

/**
 * Acquire an exclusive lock for (repo, cardId) before touching its worktree (REQ-RUN-10). Each run writes its own entry
 * `<lock>.run-<pid>-<n>`, then lists the card's entries: it holds the lock only when no other entry belongs to a live
 * process, else it removes its entry and fails with the locked error. Whoever lists second sees the other's entry, so
 * two runs never both hold a card; two that start at the same moment can both yield, and the next poll retries. An
 * entry of a dead process is removed by whoever sees it. No live entry is ever moved or deleted by another process, so
 * there is no reclaim race, and the owner is in the name, so no crash leaves a lock without one. The holder also keeps
 * the earlier layout's `<lock>/pid`, so an older Keel run on the same card yields to it, as a newer one yields to an
 * older one's.
 */
export function acquireRunLock(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  const mine = `${lock}.run-${process.pid}-${++taken}`;
  writeFileSync(mine, '');
  const dropEntry = () => rmSync(mine, { force: true });
  const locked = (pid) => new Error(`card is locked by another keel run in progress (pid ${pid}): ${lock}`);
  const other = liveEntries(lock).find((e) => e.file !== mine);
  if (other) {
    dropEntry();
    throw locked(other.pid);
  }
  // Hold the lock for an older Keel too: it takes `<lock>` with mkdir and reads `<lock>/pid`, and never sees entries.
  // The marker appears with this pid already in it (a temp dir renamed into place); one left by a dead run is replaced.
  const fresh = mkdtempSync(`${lock}.new-`);
  writeFileSync(join(fresh, 'pid'), String(process.pid));
  for (let tries = 0; ; tries++) {
    try {
      renameSync(fresh, lock);
      break;
    } catch (e) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) {
        rmSync(fresh, { recursive: true, force: true });
        dropEntry();
        throw e;
      }
    }
    const holder = legacyHolder(lock);
    if (holder !== null || tries > 0) {
      rmSync(fresh, { recursive: true, force: true });
      dropEntry();
      throw locked(holder ?? 'unknown');
    }
    rmSync(lock, { recursive: true, force: true }); // a dead run's marker; no newer run can race this: the entry is ours
  }
  return () => {
    releaseMarker(lock);
    dropEntry();
  };
}

/** Remove this run's `<lock>` marker, moved aside first so a half-deleted dir is never a target (REQ-RUN-10). */
function releaseMarker(lock) {
  if (legacyHolder(lock) !== process.pid) return; // not ours: leave it
  const gone = `${lock}.done-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, gone);
  } catch (e) {
    if (e.code === 'ENOENT') return; // already gone
    throw e;
  }
  rmSync(gone, { recursive: true, force: true });
}

/** Whether a live run holds this card lock (REQ-RUN-10), for path leases (REQ-LEASE-1). */
export const runLockHeld = (lock) => liveEntries(lock).length > 0;
