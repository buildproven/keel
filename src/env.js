import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment hygiene for model processes and repo checks (REQ-RUN-12).
 *
 * A worker is a model with shell access: whatever is in its environment is in its reach. The operator's
 * shell legitimately holds API keys (for `keel poll` itself), so anything secret-looking is dropped
 * before a worker or a configured check starts, unless `keel.json` allowlists the exact name.
 */
const SECRET_WORD = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD)(_|$)/i;

export function scrubEnv(env, allow = []) {
  const keep = new Set(allow);
  return Object.fromEntries(Object.entries(env).filter(([name]) => keep.has(name) || !SECRET_WORD.test(name)));
}

let emptyGhDir = null;
const madeGhDirs = [];
/**
 * An empty dir for GH_CONFIG_DIR; a new one if candidate code wrote into the last one. A replaced dir is kept until
 * exit, since a candidate process started with it may still run; the 'exit' hook removes every dir made (REQ-RUN-40).
 */
function noGhConfig() {
  if (!emptyGhDir || readdirSync(emptyGhDir).length) {
    if (!madeGhDirs.length) process.on('exit', () => madeGhDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    emptyGhDir = mkdtempSync(join(tmpdir(), 'keel-nogh-'));
    madeGhDirs.push(emptyGhDir);
  }
  return emptyGhDir;
}

/**
 * The environment of candidate code: workers and every check, test, held-out, and mutation run (REQ-RUN-12). On top of
 * scrubEnv, it hides the owner's GitHub credentials, which live in files, not variables: an empty GH_CONFIG_DIR (gh,
 * and git's `gh auth git-credential` helper, find no login), no system git config (macOS keychain helper), no ssh agent,
 * and no credential prompts. Otherwise candidate code could post the keel/gate status itself (BUI-1151). Names in
 * `allow` keep their real value.
 */
export function candidateEnv(env, allow = []) {
  const out = scrubEnv(env, allow);
  const keep = new Set(allow);
  if (!keep.has('GH_CONFIG_DIR')) out.GH_CONFIG_DIR = noGhConfig();
  if (!keep.has('SSH_AUTH_SOCK')) delete out.SSH_AUTH_SOCK;
  out.GIT_CONFIG_NOSYSTEM = '1';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}
