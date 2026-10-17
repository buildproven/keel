# Pilot: Keel against native Claude Code / Codex (closed 2026-10-04)

Two agent-run rounds on 2026-10-03 compared plain Claude Code (arm A) with `keel run` (arm B) on the same real
cards from the same base, judged by the same `keel gate` and a hand review of each diff. The full log, the
per-card tables, and the invalid first runs are in git history (`git log -- docs/PILOT.md`, before 2026-10-07).

## Result (16 valid pairs)

|                  | A (plain Claude Code)                                              | B (`keel run`)               |
| ---------------- | ------------------------------------------------------------------ | ---------------------------- |
| Accepted         | 14/16                                                              | 16/16                        |
| Review defects   | 2 (a GitHub-rejected workflow expression; a check-then-write race) | 0                            |
| Median wall time | round 2: 34 s, no verification                                     | round 2: 87 s, gate included |
| Model cost       | not reported                                                       | $0.10–0.80 per card          |

Invalid first runs were card or setup defects (a card that contradicted a test, a runner that never ran new test
files, a red base); they led to `keel doctor`, `install`, REQ-RUN-13, REQ-RUN-14, and REQ-GATE-3 hints.

## Decision

2026-10-04: the owner withdrew the wall-time screening rule (it came from the outside review and compared
verified with unverified work) and kept Keel. From then Keel is judged on real use against the owner's own
baseline (`keel report --value`, DESIGN §8), and from 2026-10-07 it runs the v2 loop in DESIGN §9.

## Known limits

- Small sample; a screening rule, not a statistical test. Founder minutes were never measured.
- Only cards a model can finish without new product decisions are eligible; card quality bounds unattended work.
