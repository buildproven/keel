"""Shared settings for the SWE-bench Verified benchmark of Keel against plain Claude Code (BUI-1141).

Everything heavy (clones, task workdirs, logs) lives in $KEEL_BENCH_DIR (default ~/keel-bench), never in this repo.
"""
import json
import os
import subprocess
from pathlib import Path

BENCH = Path(os.environ.get("KEEL_BENCH_DIR", Path.home() / "keel-bench"))
HERE = Path(__file__).resolve().parent
TASKS = HERE / "tasks.json"
RESULTS = HERE / "results"
DATASET = "SWE-bench/SWE-bench_Verified"
SEED = 1141
# Repos with compiled extensions cannot run their tests from a source checkout mounted over the task image's /testbed,
# which Keel's gate needs; they are left out and the method says so.
EXCLUDED_REPOS = {"astropy/astropy", "matplotlib/matplotlib", "scikit-learn/scikit-learn"}
PLAIN_MODEL = ("claude-opus-5-5", "high")  # plain Claude Code: the strongest Claude tier Keel has, one attempt


def sh(args, cwd=None, env=None, check=True, timeout=None):
    r = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args))} failed ({r.returncode}): {r.stdout[-2000:]}{r.stderr[-2000:]}")
    return r


def load_tasks():
    return json.loads(TASKS.read_text())


def test_command(instance):
    """The task's own test command line from its eval script, without the test files (they vary per run)."""
    lines = instance["eval_script"].split("\n")
    start = next(i for i, l in enumerate(lines) if "Start Test Output" in l)
    line = lines[start + 1]
    if instance["repo"] == "django/django":
        return "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1"
    words = line.split(" ")
    while words and (words[-1].endswith(".py") or "/" in words[-1] or "::" in words[-1]):
        words.pop()
    return " ".join(words)
