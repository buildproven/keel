import { spawnSync } from 'node:child_process';
import { checkEnv } from './env.js';
import { OPEN_HOLD_MS, fixedSlots, withGateSlot } from './slots.js';

/**
 * `keel test` (REQ-SLOT-2): run the repo's `testCommand` in the working tree while holding a machine-wide gate slot
 * (REQ-GATE-29, REQ-SLOT-1), so a builder's own test runs queue with every gate instead of loading the machine beside
 * them. Output goes straight to the terminal; the result is the command's exit code (1 when a signal ended it). Candidate
 * code runs with the environment the gate gives its test command (REQ-RUN-12, REQ-GATE-51).
 */
export function keelTest({ repo, config, slotDir, log }) {
  return withGateSlot(
    { dir: slotDir, cap: fixedSlots(), log, holdMs: OPEN_HOLD_MS, ...(config.gateCores ? { coresPerGate: config.gateCores } : {}) },
    () => {
      const r = spawnSync(config.testCommand, {
        cwd: repo,
        shell: true,
        stdio: 'inherit',
        env: checkEnv(process.env, config.workerEnvAllow),
      });
      if (r.error) throw r.error;
      return r.status ?? 1;
    },
  );
}
