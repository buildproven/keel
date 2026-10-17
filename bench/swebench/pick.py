"""Pick the benchmark tasks: a seeded random sample of SWE-bench Verified, excluding EXCLUDED_REPOS (BUI-1141).

    python pick.py [N]     # default 30; writes tasks.json
"""
import json
import random
import sys

from datasets import load_dataset

from common import DATASET, EXCLUDED_REPOS, SEED, TASKS, test_command

n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
ds = [r for r in load_dataset(DATASET, split="test") if r["repo"] not in EXCLUDED_REPOS]
ds.sort(key=lambda r: r["instance_id"])
pick = random.Random(SEED).sample(ds, n)
keep = ["instance_id", "repo", "base_commit", "problem_statement", "image", "version", "difficulty"]
tasks = [{**{k: r[k] for k in keep}, "test_command": test_command(r)} for r in sorted(pick, key=lambda r: r["instance_id"])]
TASKS.write_text(json.dumps(tasks, indent=1) + "\n")
print(f"{len(tasks)} tasks from {len(ds)} eligible; repos: {sorted({t['repo'] for t in tasks})}")
