# Running Keel unattended

Keel is not a scheduler (CLAUDE.md): `keel poll` does one pass and exits. A schedule lives outside
Keel. Enabling one spends model quota and moves Linear issues to review, so nothing here is installed for you.

## Before you enable a schedule

0. Run `keel doctor --repo <dir> --base origin/<default>`. It runs the install and every check on a clean
   checkout of base; a check that is red or unrunnable there makes every card fail at every tier.

1. The repo has a `keel.json` on its default branch (`keel init`, review, merge). Policy is read from
   the base commit (REQ-CFG-1), never from the change under test.
2. `keel.json` names `linearProject` (REQ-LINEAR-10). On a Claude or Codex subscription, `planLimits`
   (default 5-hour 90 %, week 80 %) keeps the rest of each plan window for your own sessions (REQ-PLAN-2).
   With tiers that bill an API key, set a `dailyBudgetUsd` ceiling (REQ-LINEAR-9).
3. `LINEAR_API_KEY` is set for the job only. Keel strips secret-looking variables from workers and
   checks (REQ-RUN-12); list anything a check truly needs in `workerEnvAllow`.
4. Run one pass by hand first: `keel poll --repo <dir> --limit 1`, and read the Linear comment.
5. `keel poll` never passes `--pr` unless you do. Without it a pass leaves a `keel/<ISSUE>` branch and
   a comment; with it, a PR (draft when protected paths, size L, or infra are touched). `--merge` also
   enables GitHub auto-merge when the change is tested and reviewed (DESIGN §9, REQ-RUN-20).

## One repo, launchd

A pass needs a small wrapper that loads the Linear key for that process only, fetches, and polls against
`origin/<default branch>` with `--merge` (DESIGN §9). Save it outside the repo (for example
`~/bin/keel-nightly.sh`, then `chmod +x` it) and keep the key in a file only you can read (`chmod 600`):

```sh
#!/bin/sh
set -eu
repo="$1"
LINEAR_API_KEY="$(sed -n 's/^LINEAR_API_KEY=//p' "$HOME/.config/keel/.env" | head -1)"
[ -n "$LINEAR_API_KEY" ] || { echo "keel-nightly: no LINEAR_API_KEY" >&2; exit 2; }
export LINEAR_API_KEY
git -C "$repo" fetch --quiet origin
exec keel poll --repo "$repo" --base "$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD)" --limit 1 --merge
```

launchd starts with an empty `PATH` and cannot expand `$HOME`, so render the paths yourself, set `PATH` to
where `keel`, `git`, `gh`, and your agent CLIs live, and load the file yourself:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.keel.poll.__REPO__</string>
  <key>ProgramArguments</key>
  <array>
    <string>__HOME__/bin/keel-nightly.sh</string>
    <string>__REPO_DIR__</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>__PATH__</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>__HOME__/Library/Logs/ai.keel.poll.__REPO__.log</string>
  <key>StandardErrorPath</key><string>__HOME__/Library/Logs/ai.keel.poll.__REPO__.log</string>
</dict>
</plist>
```

Run the schedule on one machine only: two machines polling the same project pick the same issue.

Stagger `Hour`/`Minute` across repos so passes do not overlap. Load with
`launchctl bootstrap gui/$(id -u) <plist>`; run once now with `launchctl kickstart gui/$(id -u)/<label>`;
stop with `launchctl bootout gui/$(id -u)/<label>`.

For repos where cards change dependencies, set `"install"` in `keel.json` (for example
`"install": "pnpm install --frozen-lockfile"`). The gate then installs from the committed manifest in every
fresh checkout instead of reusing the worker's `node_modules` (REQ-GATE-16), so it tests what was committed.

Make a card's acceptance criteria executable: define named commands in `keel.json`
(`"acceptance": {"audit": "npm audit --audit-level high"}`) and select them from the issue's `keel` block
(`acceptance: audit`). The gate then fails the card unless they pass (REQ-GATE-15); card text never
supplies a command.

Only issues that make a good card should be eligible: label tracking and decision issues `no-keel`
(REQ-LINEAR-11), and put `allowEdits`/`paths`/`size` for real cards in a fenced `keel` block in the
issue (REQ-LINEAR-12).

## Many repos

Rank the repos once, and choose how many Keel works on (README, "Many projects"):

```sh
keel projects add ~/src/shop --rank 1
keel projects add ~/src/api
keel projects active 5           # only the top 5 unpaused repos
```

Then the wrapper above runs one pass over all of them, in rank order, instead of one repo. Each still uses its own
`keel.json`, Linear project, and budget; Keel fetches `origin` in each and polls against its default branch (or the
project's `base` from the list), so the wrapper needs no fetch of its own:

```sh
exec keel poll --projects --propose --merge
```

With `--propose`, a repo whose backlog is empty gets up to `proposeMax` drafted cards in its Linear project instead of
an idle pass (at most one propose turn per repo per day), and the next pass builds them: the loop keeps itself fed.
Set `"proposeApproval": true` in a repo's `keel.json` to hold its proposals until you delete each one's first line.
The pass is still one pass that exits: the schedule stays yours.

## Exit codes

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Every attempted issue passed, or nothing was eligible                           |
| 1    | At least one issue failed, was blocked, or its PR step failed                   |
| 2    | Usage error (bad flag, missing project, `--repo` not a dir)                     |
| 3    | Daily budget reached, or a provider limit deferred an issue (retried next poll) |

## Watching it

- `keel report` shows attempts, tier, tokens, cost, tier-0 share, and cost per accepted card.
- `keel clean` lists parked worktrees; `--force` removes the clean ones. Every `run` and `poll` first removes finished ones and dead gate checkouts by itself (REQ-CLEAN-3..5); `keel clean --auto` runs that once.
