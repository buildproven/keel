# SWE-bench Verified: Keel against plain Claude Code (BUI-1141)

Run 2026-10-12/13, 30 tasks. Full tables: `results/report.md` (output of `report.py`).

## Result

| Arm                                            | Resolved     | Spend  | Spend per resolved |
| ---------------------------------------------- | ------------ | ------ | ------------------ |
| Keel (`keel run`, cheapest tier first)         | 28/30 (93 %) | $8.95  | $0.32              |
| Plain Claude Code (one `claude -p`, Opus high) | 25/30 (83 %) | $10.36 | $0.41              |

- Keel certified all 30 tasks; 28 of them pass the official tests.
- pytest-5809 was rerun on 2026-10-13. In the first run, Keel crashed: the review prompt went to the reviewer as one
  argument, and the diff held a NUL byte, which no process argument may contain. Since buildproven/keel#128 the prompt
  goes on stdin. The rerun passed on tier 0 for $0.25 and resolves the task. No other result changed.
- Plain gave a patch on all 30; 5 were wrong. Keel resolved 3 of those 5.
- Tier that passed the gate: tier 0 (Sonnet low) 22, tier 1 (Sonnet high) 6, tier 2 (Opus high) 2.
- Tampering: the deterministic gate caught 35/35 cases (7 kinds × 5 tasks) before review.
- Two plain runs hung for 92 and 127 minutes (the agent waited for a "tests finished" line that never came).
  No Keel run hung.

30 tasks is a small sample: the 2-task difference in resolved count is not statistically significant. The
cost difference and the 2 "certified, not resolved" Keel results (a 7 % false-pass rate) are the more useful signals.

## Method

- **Tasks** (`pick.py`): seeded (1141) random sample of 30 from SWE-bench Verified, without astropy, matplotlib, and
  scikit-learn (compiled extensions; their images rebuild too slowly under x86 emulation). 15 django, 6 sphinx,
  4 sympy, 2 xarray, 1 each requests, pylint, pytest. Difficulty: 11 under 15 min, 13 up to 1 h, 6 up to 4 h.
- **Setup** (`prepare.py`): two clones per task at the base commit, plus one setup commit: `.keel-bench/test.sh`
  runs the given test files in the official x86 task image (Docker, `--platform linux/amd64`), and `keel.json`
  uses it as the test check. Both arms get the same issue text and the same note on how to run tests.
- **Keel arm** (`run_arm.py keel`): `keel run <id>.md`. The patch is the certified branch `keel/<id>` only; a
  declined task has no patch. Spend is Keel's ledger estimate for every attempt and review.
- **Plain arm** (`run_arm.py plain`): one `claude -p` run, Opus high, permission mode auto; the patch is the full
  diff. Spend is the CLI's reported cost.
- **Isolation and reruns** (since 2026-10-13): the plain arm now gets the credential isolation Keel gives its workers
  (an empty `GH_CONFIG_DIR`, no system git config, no ssh agent). The plain results above were run before that change;
  no task needs network or GitHub access. Each run first resets its checkout to the setup commit, which `prepare.py` records in `work/<id>/<arm>.setup`
  outside the checkout (a model can rewrite the checkout's history), and each Keel run
  uses a new state dir, so a rerun never reuses an earlier patch or ledger.
- **Grading** (`grade.py`): the official `swebench.harness.run_evaluation` on each arm's predictions. Files under
  `.keel-bench/` and `keel.json` are removed from both patches first.
- **Tampering** (`tamper.py 5`): 7 commits per task that make tests pass without a fix (edit an existing test, skip
  marker, runner config, policy edit, no test, vacuous test, bypass marker). Caught means a deterministic stage
  failed before review.

## Limits

- The cross-family reviewer (Codex) was out of quota for most of the run: 25 of 36 reviews were by the
  fallback (REQ-GATE-22), a Claude tier. The review was then same-family.
- Plain Claude Code ran once at the strongest tier; it had no retry loop. A plain loop with retries may close
  part of the gap at higher cost.
- The test runner in the prompt is a benchmark aid; real repos give Keel their own checks.
- Single run per task; model output varies between runs.

## Reproduce

    export KEEL_BENCH_DIR=~/keel-bench          # venv with swebench 5.0.2, work dirs, Docker logs
    python pick.py 30 && python prepare.py
    python run_arm.py keel && python run_arm.py plain
    python grade.py keel && python grade.py plain
    python tamper.py 5 && python report.py
