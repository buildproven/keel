---
name: keel
description: 'Build a Linear issue or hand-written card through Keel: a deterministic gate (tests written first, locked, scope-checked) drives a tiered Claude/Codex model escalation. Use when the user asks to fix, build, or ship a specific issue/ticket/bug via Keel, or asks to set Keel up in a repo, or asks for a quality check or gate before a PR or merge.'
---

# Keel

Keel is a CLI, not a model you reimplement in prose. Always shell out to the
real `keel` binary (on PATH after `npm ci && npm link` in a clone of the keel repo) rather than hand-writing the gate logic
yourself. Full design: `docs/DESIGN.md` in the keel repo.

Keel is the referee of the autonomous loop (DESIGN §9): the cheapest model builds,
a deterministic gate proves it (tests first, locks, scope, held-out, mutation), a
model of the other family reviews it, and with `--merge` GitHub merges exactly the
certified commit after required CI. Prefer it when the user names Keel, asks for
unattended or gate-checked building, or wants work merged without reviewing it.
For an ordinary "fix this bug" ask with no mention of Keel, just fix it directly.
To write cards for Keel, use the `cards` skill.

## Everyday commands

| When                                    | Command                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| Before a PR                             | `keel gate`                                                          |
| Build one Linear issue                  | `keel run BUI-123 --merge`                                           |
| Work the backlog                        | `keel poll --limit N --merge`                                        |
| Work the backlog of your top N repos    | `keel poll --projects --merge`                                       |
| Choose which repos Keel works on        | `keel projects add <dir> --rank 1`, `keel projects active 5`         |
| No card yet: ask what is worth building | `keel propose [--focus "tests"]`, then `keel run <PROP file>`        |
| Backlog empty: draft cards for approval | `keel poll --propose` (cards wait until you delete their first line) |

`keel gate` defaults to origin's default branch and, without `--card`, gates a size-S card whose kind comes
from the branch's commit types (`feat:` → feature, `fix:` → bug, …). Pass `--card` to set scope, size M/L, or
held-out tests. The review runs on a model of another family than the author; from Codex, run
`keel gate --author codex`. Where the default branch requires `keel/gate`, push the branch first and run
`keel gate --status`: it posts the result on HEAD (`keel run --pr` does this itself).

## One-time setup per repo

A repo needs `keel.json` before `keel gate`/`run`/`poll` work in it (config is
read from the base commit, never the branch under test — this is deliberate,
not a bug). If missing:

```bash
keel init --repo <path>          # detects Node/Python/Go/Rust/Ruby/Make/Terraform, proposes keel.json
```

Read the proposed `keel.json`, adjust `checks`/`testCommand` if the defaults
are wrong for the repo (e.g. drop a slow `build` check from the gate), then
commit it on the repo's default branch before running anything else.

## Build a card

```bash
keel run <card.md> --repo <path> [--pr]
```

Card format (kind: bug/feature/refactor/ui/infra/chore; size: S/M/L):

```markdown
# ISSUE-ID: title

kind: bug
size: S
allowEdits: path/to/file/the/issue/explicitly/says/to/change

## Requirements

<the issue's own description/acceptance criteria, verbatim>
```

**The single most common cause of wasted attempts (found in the first real
pilot run): a missing `allowEdits` line.** If the issue's own text says to
change `.github/**`, a config file, or anything else Keel locks by default
(`docs/DESIGN.md` §6.5's `verificationPaths`), name it in `allowEdits` up
front. Without it, the gate correctly rejects the edit every time, burning a
full model tier before the agent even gets a chance to work around it.

Read `keel run`'s output. `needsReview: true` (protected paths, size L, infra)
means auto-merge needs passing held-out tests; without them the PR is a draft.

`--merge` (implies `--pr`) enables GitHub auto-merge of the certified SHA. It
needs review on (the default; `"review": false` turns it off) and required status
checks on the base branch; `keel doctor` prints `merge-ready yes|no (reason)`.

## Autonomous Linear loop

```bash
LINEAR_API_KEY=<key> keel poll --repo <path> [--merge] [--limit N | --issue <ID>]
```

Picks the next open issue not yet attempted (label `no-keel` opts out), builds it,
comments the outcome, and moves it to review; with `--merge` the PR auto-merges and
`Closes <ID>` closes the issue. A worker that finds the card impossible, already
done, or human work stops it as `blocked` with the reason.

## After a run

```bash
keel report                       # cost/tier per card
keel report --escaped --dora      # escaped defects; DORA metrics per repo
keel clean                        # list parked (failed) worktrees across every repo
keel clean --force                # remove the clean ones and their branches
keel clean --auto                 # remove only finished ones (run and poll do this by themselves)
```

A parked worktree is kept on purpose for inspection — read the failure before
cleaning it, don't reflexively `--force` everything.
