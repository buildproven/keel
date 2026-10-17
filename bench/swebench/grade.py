"""Grade one arm with the official SWE-bench harness (Docker, the task images) (BUI-1141).

    python grade.py keel|plain

Writes results/<arm>/predictions.jsonl and results/<arm>/grades.json ({instance_id: resolved}). An empty patch is
graded as not resolved without running.
"""
import json
import subprocess
import sys

from common import BENCH, DATASET, RESULTS, load_tasks

arm = sys.argv[1]
d = RESULTS / arm
preds = []
for t in load_tasks():
    f = d / f"{t['instance_id']}.json"
    if f.exists():
        r = json.loads(f.read_text())
        preds.append({"instance_id": r["instance_id"], "model_name_or_path": f"keel-bench-{arm}", "model_patch": r["patch"]})
(d / "predictions.jsonl").write_text("".join(json.dumps(p) + "\n" for p in preds))
graded = [p["instance_id"] for p in preds if p["model_patch"].strip()]
grades = {p["instance_id"]: False for p in preds}
if graded:
    subprocess.run(
        [sys.executable, "-m", "swebench.harness.run_evaluation", "--dataset_name", DATASET, "--predictions_path",
         str((d / "predictions.jsonl").resolve()), "--run_id", f"keel-bench-{arm}", "--max_workers", "2",
         "--instance_ids", *graded],
        cwd=BENCH, check=True,
    )
    report = json.loads((BENCH / f"keel-bench-{arm}.keel-bench-{arm}.json").read_text())
    for i in report.get("resolved_ids", []):
        grades[i] = True
(d / "grades.json").write_text(json.dumps(grades, indent=1) + "\n")
print(f"{arm}: {sum(grades.values())}/{len(grades)} resolved")
