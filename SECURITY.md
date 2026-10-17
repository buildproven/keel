# Security policy

Keel runs coding agents and project commands with your user's rights; it is not a sandbox. The trust model is in
`docs/DESIGN.md` §6.5.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.
Include the Keel version or commit, the steps to reproduce, and the impact. You will get an answer within 7 days.

In scope: a way for a candidate change to pass the gate without meeting its policy (for example editing locked tests
or loosening `keel.json`), secrets leaking to workers or checks, card text reaching a shell, or a push to the default
branch.

## Supported versions

The latest release on the default branch.
