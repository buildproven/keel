| Arm | Tasks | Resolved | Rate | Spend | Spend per resolved | Median minutes |
|---|---|---|---|---|---|---|
| Keel | 30 | 28 | 93% | $8.95 | $0.32 | 3 |
| Plain Claude Code | 30 | 25 | 83% | $10.36 | $0.41 | 2 |

**Keel outcomes against the official tests**

- Keel certified 30 of 30; of those, 28 resolved.
- Keel declined 0; plain resolved 0 of those.
- Plain produced a patch on 30; 5 of those were wrong.

**Tier that passed**

- tier 0 (claude-sonnet-5-5/low): 22
- tier 1 (claude-sonnet-5-5/high): 6
- tier 2 (claude-opus-5-5/high): 2

**Gate catches (failed gate runs, by first failing stage)**

- review: review-finding: 6
- bypass: bypass-marker: 2
- red-proof: test-passes-on-base: 1
- skip-markers: skip-marker: 1

Reviews by a fallback reviewer: 25 of 36.

| Tampering case | Caught | Stage |
|---|---|---|
| edit-existing-test | 5/5 | locked |
| skip-marker | 5/5 | skip-markers |
| runner-config | 5/5 | locked |
| policy-edit | 5/5 | locked |
| no-test | 5/5 | red-proof |
| vacuous-test | 5/5 | red-proof |
| bypass-marker | 5/5 | bypass |

| Task | Difficulty | Keel | Keel spend | Plain | Plain spend |
|---|---|---|---|---|---|
| django__django-11400 | 1-4 hours | resolved | $0.24 | resolved | $0.36 |
| django__django-11880 | <15 min fix | resolved | $0.16 | resolved | $0.17 |
| django__django-12304 | <15 min fix | resolved | $0.16 | resolved | $0.15 |
| django__django-12325 | 1-4 hours | resolved | $0.24 | resolved | $0.51 |
| django__django-12708 | 1-4 hours | resolved | $0.20 | resolved | $0.30 |
| django__django-13028 | 15 min - 1 hour | resolved | $0.16 | resolved | $0.22 |
| django__django-14404 | <15 min fix | resolved | $0.27 | resolved | $0.42 |
| django__django-14608 | <15 min fix | resolved | $0.56 | resolved | $0.42 |
| django__django-14915 | <15 min fix | resolved | $0.27 | resolved | $0.14 |
| django__django-15103 | 15 min - 1 hour | resolved | $0.15 | resolved | $0.21 |
| django__django-16485 | 15 min - 1 hour | resolved | $0.19 | resolved | $0.20 |
| django__django-16560 | 1-4 hours | resolved | $0.31 | resolved | $0.67 |
| django__django-16595 | <15 min fix | resolved | $0.19 | resolved | $0.41 |
| django__django-16950 | 15 min - 1 hour | resolved | $0.22 | resolved | $0.21 |
| django__django-17084 | 15 min - 1 hour | resolved | $0.25 | resolved | $0.30 |
| psf__requests-6028 | 15 min - 1 hour | resolved | $0.22 | resolved | $0.20 |
| pydata__xarray-3151 | 15 min - 1 hour | resolved | $0.19 | resolved | $0.20 |
| pydata__xarray-4629 | <15 min fix | resolved | $0.16 | resolved | $0.16 |
| pylint-dev__pylint-4604 | 15 min - 1 hour | certified, not resolved | $0.35 | not resolved | $0.51 |
| pytest-dev__pytest-5809 | <15 min fix | resolved | $0.25 | resolved | $0.14 |
| sphinx-doc__sphinx-11510 | 1-4 hours | resolved | $0.37 | not resolved | $0.57 |
| sphinx-doc__sphinx-8459 | <15 min fix | resolved | $0.24 | resolved | $0.23 |
| sphinx-doc__sphinx-8548 | 1-4 hours | resolved | $1.19 | not resolved | $0.71 |
| sphinx-doc__sphinx-9281 | <15 min fix | resolved | $0.16 | resolved | $0.13 |
| sphinx-doc__sphinx-9602 | 15 min - 1 hour | resolved | $0.73 | not resolved | $0.27 |
| sphinx-doc__sphinx-9673 | 15 min - 1 hour | resolved | $0.19 | resolved | $0.29 |
| sympy__sympy-13615 | 15 min - 1 hour | resolved | $0.30 | resolved | $0.69 |
| sympy__sympy-13974 | 15 min - 1 hour | resolved | $0.40 | resolved | $0.49 |
| sympy__sympy-19495 | <15 min fix | resolved | $0.40 | resolved | $0.48 |
| sympy__sympy-20428 | 15 min - 1 hour | certified, not resolved | $0.23 | not resolved | $0.61 |
