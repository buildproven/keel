# Changelog

Keel follows [semantic versioning](https://semver.org). Each entry names the requirement IDs (`docs/DESIGN.md` §5)
it adds or changes. Keel is not on npm yet: install from a clone (README, Quick start).

## 0.3.0 (2026-10-23)

### Added

- **Many projects** (REQ-MULTI-1..5): a ranked project list outside every repo (`~/.config/keel/projects.json` or
  `$KEEL_PROJECTS_FILE`) with an `active` count, so Keel works on only your top N repos. `keel projects` lists it;
  `add [--rank N]`, `remove`, `pause`, `resume`, and `active <N|all>` edit it. `keel poll --projects` runs one pass
  over each active project in rank order; one project's error is reported and the next still runs.
- **Proposing work** (REQ-PROPOSE-1..8): `keel propose` reads the base commit for signals (TODO/FIXME markers,
  source files no test names), then asks the strongest tier, in one read-only turn, what is most worth building next.
  The answer is checked like a refined card (EARS requirements, acceptance checks, size S/M, no `allowEdits`) and
  written as `PROP-<n>.md` card files outside the repo, or filed with `--file` as Linear issues that wait for your
  approval when `proposeApproval` is on. `keel poll --propose` does this when the backlog runs dry; by default the
  loop then builds its own proposals with no human step, at most one propose turn per repo per day (REQ-PROPOSE-9).
- `keel poll --projects` fetches each repo and polls against origin's default branch unless the list names a base
  (REQ-MULTI-6), so a schedule needs one line: `keel poll --projects --propose --merge`.
  New `keel.json` keys: `proposeMax`, `proposeApproval`, `proposeTier`, `sourceGlobs`.
- `keel report` shows propose turns and their cost.
- `CHANGELOG.md`, `.editorconfig`, Dependabot for GitHub Actions and dev dependencies, and an issue-template chooser
  that points security reports to the private channel.

### Fixed

- Workers and checks no longer break when git config comes from the environment (REQ-RUN-50): the secret scrub
  dropped `GIT_CONFIG_KEY_<n>` but kept `GIT_CONFIG_COUNT`, so every git call failed with "missing config key". The
  whole set now goes, values included (they can carry credentials).

### Docs

- The README documents every `keel.json` key, grouped by area, and a test keeps it that way (REQ-OSS-5).

## 0.2.0 (2026-10-17)

The version this history starts at. The gate (red proof, locked verification files, bypass markers, scope, held-out
tests, cross-model review, optional mutation), the runner (learned start tier, escalation on gate failure, budgets,
plan windows), the ledger and `keel report` (`--value`, `--dora`, `--escaped`, `--recur`), the Linear loop
(`keel poll`: dependency order, refine turns, found-work follow-ups, self-merge of certified SHAs), `keel doctor`,
`keel audit`, `keel test`, and `keel clean`. Changes from that release onward are in `git log`.
