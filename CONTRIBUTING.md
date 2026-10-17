# Contributing to Keel

Thanks for helping. Keel holds its own changes to the rules it enforces on others.

## Setup

Node 24 or later. No runtime dependencies.

    npm ci
    npm test          # node:test
    npm run lint
    npm run format:check

CI also installs `pytest`: some fixtures run a Python project.

## Rules for a change

- **Scope.** Keel is a gate that also picks the model. It is not a scheduler, a service, or an orchestrator. The core
  knows only git, globs, and `keel.json` commands; language knowledge lives in defaults and `keel init` presets.
- **A requirement for every behavior.** Add or change a line in `docs/DESIGN.md` §5 with a requirement ID, and give
  every new `src/` or `bin/` file a row in the §6.1a module table. `test/trace.test.js` checks both directions.
- **Test first.** Write the test in a new file, with a title that starts with the requirement ID, and see it fail
  before you change the code. Do not weaken, skip, or delete existing tests.
- **Visible errors.** No catch-all handlers, lint or type bypasses, or disabled hooks.
- **Gate before the PR.** Run `node bin/keel.js gate` on your committed branch: it runs the checks and the review the
  merge requires. `main` also requires the `keel/gate` commit status, which only a maintainer can post: a maintainer
  runs `keel gate --status` on your PR head before it merges.

One concern per PR, with `feat:`, `fix:`, `chore:`, or `docs:` commits. Describe the requirement IDs and the test
that proves each one.

## Reporting

Bugs and feature requests: open an issue with the templates. Security problems: see [SECURITY.md](SECURITY.md).
