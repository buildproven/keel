"""Print the benchmark tables as Markdown from results/ (BUI-1141). docs/BENCHMARK.md quotes this output.

    python report.py
"""
import json
from collections import Counter
from statistics import median

from common import RESULTS, load_tasks


def load(arm):
    d = RESULTS / arm
    grades = json.loads((d / "grades.json").read_text()) if (d / "grades.json").exists() else {}
    out = {}
    for t in load_tasks():
        f = d / f"{t['instance_id']}.json"
        if f.exists():
            out[t["instance_id"]] = {**json.loads(f.read_text()), "resolved": grades.get(t["instance_id"])}
    return out


def money(x):
    return "n/a" if x is None else f"${x:.2f}"


tasks = load_tasks()
keel, plain = load("keel"), load("plain")
both = [t["instance_id"] for t in tasks if t["instance_id"] in keel and t["instance_id"] in plain]

print("| Arm | Tasks | Resolved | Rate | Spend | Spend per resolved | Median minutes |")
print("|---|---|---|---|---|---|---|")
for name, arm in (("Keel", keel), ("Plain Claude Code", plain)):
    rows = [arm[i] for i in both]
    solved = sum(1 for r in rows if r["resolved"])
    spend = sum(r["cost"] or 0 for r in rows)
    print(
        f"| {name} | {len(rows)} | {solved} | {solved / len(rows):.0%} | {money(spend)} | "
        f"{money(spend / solved) if solved else 'n/a'} | {median(r['seconds'] for r in rows) / 60:.0f} |"
    )

print("\n**Keel outcomes against the official tests**\n")
kp = [i for i in both if keel[i]["pass"]]
print(f"- Keel certified {len(kp)} of {len(both)}; of those, {sum(1 for i in kp if keel[i]['resolved'])} resolved.")
print(f"- Keel declined {len(both) - len(kp)}; plain resolved {sum(1 for i in both if not keel[i]['pass'] and plain[i]['resolved'])} of those.")
print(f"- Plain produced a patch on {sum(1 for i in both if plain[i]['patch'].strip())}; {sum(1 for i in both if plain[i]['patch'].strip() and not plain[i]['resolved'])} of those were wrong.")

tiers = Counter()
for i in kp:
    att = [a for a in keel[i]["attempts"] if a.get("role") != "held-out-author" and a.get("gatePass")]
    if att:
        tiers[f"tier {att[-1]['tier']} ({att[-1]['model']}/{att[-1]['effort']})"] += 1
print("\n**Tier that passed**\n")
for k, v in sorted(tiers.items()):
    print(f"- {k}: {v}")

stages = Counter()
for i in both:
    for r in keel[i]["receipts"]:
        if not r["pass"]:
            stages[f"{r['failedStage']}: {', '.join(sorted(set(filter(None, r['rules'])))) or '-'}"] += 1
print("\n**Gate catches (failed gate runs, by first failing stage)**\n")
for k, v in stages.most_common():
    print(f"- {k}: {v}")
fallback = sum(1 for i in both for r in keel[i]["receipts"] if r.get("fallback"))
print(f"\nReviews by a fallback reviewer: {fallback} of {sum(1 for i in both for r in keel[i]['receipts'] if r.get('reviewer'))}.")

tamper = RESULTS / "tamper.json"
if tamper.exists():
    rows = json.loads(tamper.read_text())
    by = Counter()
    caught = Counter()
    for r in rows:
        by[r["case"]] += 1
        caught[r["case"]] += r["caught"]
    print("\n| Tampering case | Caught | Stage |")
    print("|---|---|---|")
    for case in by:
        st = Counter(r["stage"] for r in rows if r["case"] == case).most_common(1)[0][0]
        print(f"| {case} | {caught[case]}/{by[case]} | {st} |")

print("\n| Task | Difficulty | Keel | Keel spend | Plain | Plain spend |")
print("|---|---|---|---|---|---|")
for t in tasks:
    i = t["instance_id"]
    if i not in both:
        continue
    k = keel[i]
    kv = ("resolved" if k["resolved"] else "certified, not resolved") if k["pass"] else "declined"
    pv = "resolved" if plain[i]["resolved"] else ("not resolved" if plain[i]["patch"].strip() else "no patch")
    print(f"| {i} | {t['difficulty']} | {kv} | {money(k['cost'])} | {pv} | {money(plain[i]['cost'])} |")
