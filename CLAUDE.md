# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Keel is a quality gate that also picks the model. Source of truth: `docs/DESIGN.md` (§5 requirements, §6 architecture and module table).

## Rules

- Keep Keel small by scope, not by a line cap: no scheduler, service, or orchestration features.
- Language-free core: the gate knows only git, globs, and `keel.json` commands. Language knowledge lives in defaults and `keel init` presets.
- Zero runtime dependencies. Dev tools only: eslint, prettier. Node ≥ 24, ESM.
- Every behavior has a requirement ID in `docs/DESIGN.md` §5 and a test whose title starts with that ID (`test/trace.test.js` enforces both directions, and that every `src/`/`bin/` file has a row in the DESIGN §6.1a module table).
- Write the test first; it must fail before the change (Keel's own gate checks this).
- Never weaken, skip, or delete tests. Never add lint/type/hook bypasses.
- Errors must be visible. No catch-all handlers except where a comment names the requirement that allows it.
- Keel never deploys or publishes. It may push a branch and open a PR only with `--pr`, and enable GitHub auto-merge of the certified SHA only with `--merge` (DESIGN §9 policy).
- Nothing personal belongs here: the owner's machine setup lives in a separate private repo (`test/skills.test.js` guards this).
- `AGENTS.md` is a symlink to this file, so Codex reads the same rules.

## Commands

    npm test                                   # all tests (node:test, concurrency 4)
    node --test test/gate.test.js              # one file
    node --test --test-name-pattern='REQ-RUN-21' test/*.test.js   # one requirement
    npm run lint                               # eslint
    npm run format:check                       # prettier
    node bin/keel.js gate                      # self-gate before a PR (base origin/main, card from commit types)

CI (`.github/workflows/ci.yml`) also installs `pytest`: REQ-PROJ-5 fixtures run a Python project.

## Architecture

Two halves joined by the ledger:

- **Gate** (`src/gate.js`): verifies a committed HEAD against a base in fresh temp worktrees, never the working tree. Policy (`keel.json`) is read at the base ref, so a candidate cannot loosen its own rules. Stages, in order: static (locked verification files, skip/bypass markers, scope — `src/scan.js`), head checks and tests, red proof (new tests must fail on base), held-out tests, optional mutation, cross-model review (`src/review.js`). Writes a receipt JSON to `<stateDir>/receipts/`.
- **Runner** (`src/run.js`): one card → worktree `keel/<id>` → worker CLI at tier N (`src/workers.js` builds argv for `claude -p` / `codex exec`, parses usage, classifies failures) → gate → on failure, next tier with the failure summary. Start tier comes from card rules, then the ledger may raise it (learned routing, REQ-RUN-21). Stops on pass, `maxAttempts`, card budget (`cardBudgetUsd`), auth or quota failure, unavailable review, or a `KEEL_BLOCKED` file the worker writes. `dailyBudgetUsd` is checked by `keel poll` before each issue.
- **Ledger** (`src/ledger.js`): `ledger.jsonl` in the state dir (`$KEEL_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/keel`), one row per attempt/authoring/review. `keel report` and its `--escaped` (`escaped.js`), `--dora` (`dora.js`), and `--value` (`value.js`) views all read it plus git history.
- **Linear loop** (`src/poll.js`, `linear.js`, `linear-http.js`): `keel poll` maps issues to cards, holds back issues blocked by open issues until the blockers close, calls `run`, comments, and moves the issue. The HTTP client is injected, so tests use an in-memory fake.
- `bin/keel.js` is the only CLI entry: `parseArgs` dispatch; `UsageError` (`src/usage.js`) → exit 2.

Cards are markdown with a header (`kind`, `size`, `paths`, `allowEdits`, `heldOut`, `acceptance`) and a requirements body; see `cards/KEEL-1.md` and `skills/cards/`. Config defaults and validation live in `src/config.js`.

## Tests

- Tests build throwaway git repos with `test/helpers.js` (`tmp`, `commit`, `FIXTURE_TEST`).
- `test/fake-worker.js` stands in for the model CLI; its first argument selects the behaviour (pass, crash, blocked, …), and `KEEL_FAKE_LOG` records what it was given.
- Set `KEEL_STATE_DIR` to a temp dir in any test that writes the ledger; never touch the real one.
- The suite's time is subprocess spawns (git, node, sh: about 20,000 per run, 7–70 ms each on macOS), not CPU. Start from `fixtureRepo()`, which copies a repo built once per process, instead of `git init` per test; inject `sleep` and clocks instead of waiting. A test over 30 s fails (`--test-timeout`).
