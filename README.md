# Keel

**Ship AI-written code you can trust, at the lowest model cost that works.**

The deterministic merge gate for AI-written code:

- **Proof, not opinion**: for a fix or feature, new tests must fail on the base and pass on the head, checked on the
  exact PR head Keel enables auto-merge for.
- **Rules the agent cannot edit**: tests and policy are locked, and policy is read from the base commit.
- **Cheapest tier that pays off**: each card starts at the cheapest tier your own ledger shows passes often enough
  (higher for large or protected cards) and moves up only when an attempt fails.

Keel drives the coding agent you already use (Claude Code, Codex, or any CLI) through a loop:
build → **deterministic gate** → escalate only on failure → PR with evidence → auto-merge when tested and reviewed.
No model grades its own work: code decides pass or fail.

```
card / Linear issue ──▶ keel run ──▶ worker (cheapest tier that pays off) ──▶ keel gate ──┬─ pass ─▶ PR with evidence ─▶ auto-merge
                                       ▲                                                   │
                                       └──── one tier up, with only the trimmed failure ◀──┘ fail
```

## Why it is worth it

Real use across 14 of the author's repos (77 runs, 2026-09-27 to 2026-10-10; `keel report --value` on 2026-10-10):

| Measure                                    | Keel                             | Other changes in the same repos |
| ------------------------------------------ | -------------------------------- | ------------------------------- |
| Merged changes later fixed or reverted     | **2 of 30 (7 %)**                | 52 of 150 (35 %)                |
| Cost per accepted card (failed runs incl.) | ≈ $0.98                          | —                               |
| Matched pilot vs plain Claude Code         | 16/16 accepted, 0 review defects | 14/16, 2 review defects         |

"Later fixed" is a heuristic (a `fix:` commit touching the same files, lockfiles aside, within 30 days), the same rule
for both sides.

**Built-in quality.** The gate checks, with no model in the loop:

- **Regression proof**: the base is green; the new tests fail on the base and pass on the head.
- **Locked verification**: existing tests, runner configs, `keel.json`, CI, and `package.json` scripts cannot change
  unless the card allows it. Rules come from the base commit, never from the change under test.
- **No bypasses**: no lint-disable, `any`, ts-ignore, type-ignore, skip/only markers, or hook skipping added.
- **Scope**: only the files the card allows.
- **Held-out tests** for larger cards, written by hand or by a configured author tier (`heldOutAuthorTier`, best a
  different model family), and never shown to the builder.
- **Cross-model review** (on by default): a model of the other family reads the card and diff; a finding of
  `medium` or higher (`reviewBlock`) on a changed file blocks. When that reviewer is out of quota, the strongest tier of another
  family reviews instead (`reviewFallback`, default on), and the receipt and `keel/gate` status say so. Keel records review tokens per
  provider family across all sessions; with a `reviewWindows` budget, `keel gate` prints the tokens left and a nearly used window goes to the
  fallback first. A re-gate of a small doc-only change runs at a lower reviewer effort (`lightReview`).
- **Optional**: mutation testing on changed files and named acceptance commands.

**Token efficiency.**

- **Learned routing**: per repo, Keel starts at the cheapest tier that pays off. Cheap-first only saves when cost ≤
  pass rate × the cost one tier up, so Keel reads its own ledger and skips a tier that does not pay. It tries that
  tier first again after 10 skipped runs.
- **Escalation on evidence only**: the next tier gets the trimmed gate failure plus one repair line per rule, not a
  re-prompt.
- **Cheap failures**: a worker that finds the card impossible writes `KEEL_BLOCKED` and stops. Keel parks the card
  instead of paying for stronger models to game the gate.
- **Spending limits**: a daily ceiling per repo (`dailyBudgetUsd`) and a per-card cap (`cardBudgetUsd`).
- **Lean workers**: no MCP servers or skill listing, targeted checks only, and the green base is cached per day.

**Speed and autonomy.** `keel poll` turns a Linear project into a queue. It picks the next issue in priority and
dependency order (an issue waits for the issues that block it, and for open branches that change the files its card names), builds it, and comments the result. It moves a pass to
review, and with `--merge` enables GitHub auto-merge of exactly the certified commit. It posts the `keel/gate` status on
that commit; make `keel/gate` a required check, and a later push cannot merge until the gate passes on it.
Work the agents find on the way is not lost: the builder lists out-of-scope work in `KEEL_FOLLOWUP`, and
non-blocking review notes count too. `keel poll` files them as Low issues in the same project (at most
`followUpsPerDay`, default 5), and the loop builds them like any other issue. Before filing, it drops a finding whose
cited line the base has since changed; a follow-up of a still-open issue waits for it, and one on a locked file names
that file in `allowEdits`.

## Quick start

Needs Node ≥ 24, git, and a logged-in `claude` or `codex` CLI (`gh` for PRs).

```bash
git clone https://github.com/buildproven/keel && cd keel && npm ci && npm link   # not on npm yet
cd your-repo
keel init                          # detects the project; proposes keel.json (JS, Python, Go, Rust, Ruby, Make, Terraform)
git add keel.json && git commit -m "chore: add keel.json"
keel doctor --base HEAD            # every check must be green on base before a card can pass
keel run cards/BUG-1.md --pr       # build, gate, escalate; open a PR of the certified commit
keel report --value                # is it paying off?
```

A card is a short markdown file (or a Linear issue):

```markdown
# BUG-1: Totals ignore refunds

kind: bug
size: S
paths: src/billing/**, test/billing/**

## Requirements

- REQ-BILL-4: When an order has a refund, the invoice total shall subtract it.
```

`kind` (bug, feature, refactor, ui, infra, chore) and `size` (S, M, L) are required. `paths`, `allowEdits`,
`acceptance`, and `heldOut` are optional; M/L bug and feature cards need held-out tests; by default the strongest tier of the other family writes them (`heldOutAuthorTier`, `null` = off).

## Commands

| Command                                                                   | What it does                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keel init`                                                               | Propose `keel.json` from the project's marker files                                                                                                                                                                                                      |
| `keel doctor --base <ref>`                                                | Run install and every check on a clean base; show merge readiness                                                                                                                                                                                        |
| `keel gate [--base <ref>] [--card <card>] [--author <family>] [--status]` | Gate the committed HEAD against origin's default branch; card from commit types if none; reviewer of another family than the author; JSON receipt; a `timing` line and `IMPROVE:` lines for slow or slowing stages; `--status` posts `keel/gate` on HEAD |
| `keel run <card \| ISSUE-ID> [--pr \| --merge]`                           | Build a card or one Linear issue: learned start tier, escalate on failure                                                                                                                                                                                |
| `keel poll [--project <name>] [--limit N \| --issue ID]`                  | One pass of the Linear loop (needs `LINEAR_API_KEY`)                                                                                                                                                                                                     |
| `keel report [--value] [--dora] [--escaped]`                              | Cost, tiers, time; value against your baseline; DORA; escaped-defect list                                                                                                                                                                                |
| `keel audit [--limit N]`                                                  | Re-review merged PRs that only a fallback reviewer saw, with the reviewer that was out; findings join the found-work queue                                                                                                                               |
| `keel test`                                                               | Run the test command inside a machine-wide gate slot, so builders' test runs queue with the gates                                                                                                                                                        |
| `keel clean [--force \| --auto]`                                          | List parked worktrees; `--force` removes the clean ones; `--auto` (also run before every `run` and `poll`) the finished ones                                                                                                                             |

Unattended use (launchd, many repos, exit codes): `docs/UNATTENDED.md`. Design and every requirement with its
test: `docs/DESIGN.md`.

## Config (`keel.json`)

Keys: `checks`, `testCommand`, `testFilesCommand`, `heldOutCommand`, `testGlobs`, `protected`, `verificationPaths`, `bypassAllow`,
`heldOutRequired`, `heldOutAuthorTier`, `shareDirs`, `workerEnvAllow`, `linearProject`, `dailyBudgetUsd`,
`cardBudgetUsd`, `learnStart`, `acceptance`, `install`, `mutation`, `review`, `reviewBlock`, `reviewFallback`, `approveAllowEdits`, `fixLowFindings`, `reviewWindows`, `lightReview`, `smoke`, `tiers`, `startTier`,
`maxAttempts`, `workerTimeoutSec`, `failureTailChars`, `claudePermissionMode`, `workerArgs`. Unknown keys are errors.
Defaults: `src/config.js`.

Optional `priceInPerM` / `priceOutPerM` / `priceCachedPerM` (USD per million tokens; the last for cache reads) on a tier let `keel report --value` show what the same tokens would have cost at the top tier.

Default tiers: Sonnet 5.5 high → Opus 5.5 high → Codex gpt-5.6-sol high. Any CLI works as a tier
through the `exec` provider.

## How it compares

| Tool type                                | What it gives                        | What Keel adds                                                                |
| ---------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| Claude Code / Codex / Cursor agents      | A strong builder                     | An independent, deterministic gate and per-attempt model choice from evidence |
| Issue-to-PR orchestrators (Symphony, …)  | Tracker polling, workspaces, retries | A gate that decides, learned routing, dependency order, evidence in the PR    |
| Review bots (CodeRabbit, Greptile, …)    | A model's opinion of a diff          | Counterfactual test proof and locked verification; review is one stage        |
| Model routers (Martian, OpenRouter Auto) | A model chosen per request           | A model chosen from verified results: start tier learned from gate outcomes   |
| TDD hooks (TDD Guard)                    | Test-first nudges during editing     | A check of the finished commit, from the base commit's policy                 |

## Safety

Keel is not a sandbox: workers and checks run with your user's rights. Run it without production secrets. Keel
strips secret-looking variables from workers and checks, never passes card text to a shell, never pushes to the
default branch, and never deploys. Trust model: `docs/DESIGN.md` §6.5.

## Skills for Claude Code and Codex

`skills/keel` (build a card or issue through Keel) and `skills/cards` (turn a spec into small Linear cards Keel can
build) teach an agent to drive Keel. From the Keel clone, link each one (`<name>` is `keel` or `cards`):

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/<name>" ~/.claude/skills/<name>   # Codex: ~/.agents/skills/<name>
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

MIT licensed.
