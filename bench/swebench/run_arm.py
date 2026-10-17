"""Run one arm on prepared tasks and save the patch and spend (BUI-1141).

    python run_arm.py keel|plain [instance_id ...]   # default: every task without a result yet

Each run first resets its checkout to the setup commit (reset), so a rerun never reuses an earlier patch or ledger.
keel:  `keel run card.md` in work/<id>/keel, with a new KEEL_STATE_DIR per run (fresh routing) and TMPDIR under
       $KEEL_BENCH_DIR (Colima mounts only the home dir). The patch is the certified branch; no pass, no patch.
plain: one `claude -p` run of the same text with PLAIN_MODEL in work/<id>/plain, with the credential isolation Keel
       gives its workers (isolated); the patch is whatever it left.
Results go to results/<arm>/<id>.json.
"""
import json
import os
import sys
import tempfile
import time

from common import BENCH, PLAIN_MODEL, RESULTS, load_tasks, sh

EXCLUDE = [":(exclude).keel-bench", ":(exclude)keel.json"]
TIMEOUT = 3 * 3600


def scrubbed():
    """The operator's secrets stay out of model processes, as Keel's own scrubEnv does."""
    import re

    word = re.compile(r"(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD)(_|$)", re.I)
    return {k: v for k, v in os.environ.items() if not word.search(k)}


def isolated():
    """The plain arm gets what Keel gives its own workers (src/env.js candidateEnv): no secrets, and no GitHub
    credentials from files either: an empty GH_CONFIG_DIR, no system git config (macOS keychain helper), no ssh agent,
    no credential prompts. Otherwise the issue text drives a shell that can use the operator's logins."""
    env = scrubbed()
    env.pop("SSH_AUTH_SOCK", None)
    env.update(GH_CONFIG_DIR=tempfile.mkdtemp(prefix="keel-bench-nogh-"), GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    return env


def setup_commit(repo, t):
    """The setup commit prepare.py recorded in work/<id>/<arm>.setup, outside the checkout: git history in the checkout
    is the model's to rewrite, so no baseline comes from it."""
    f = repo.parent / f"{repo.name}.setup"
    if not f.exists():
        raise RuntimeError(f"{f} is missing: run prepare.py")
    return f.read_text().strip()


def reset(repo, t, branch=None):
    """A rerun starts from the setup commit: no earlier patch, index, worktree, commit on `bench`, or Keel branch
    carries over."""
    out = sh(["git", "worktree", "list", "--porcelain"], cwd=repo).stdout
    paths = [l.split(" ", 1)[1] for l in out.splitlines() if l.startswith("worktree ")]
    for p in paths[1:]:  # the first is the checkout itself
        sh(["git", "worktree", "remove", "--force", p], cwd=repo)
    sh(["git", "worktree", "prune"], cwd=repo)
    sh(["git", "checkout", "-q", "-f", "-B", "bench", setup_commit(repo, t)], cwd=repo)
    sh(["git", "clean", "-q", "-ffdx"], cwd=repo)
    if branch and sh(["git", "rev-parse", "--verify", "-q", branch], cwd=repo, check=False).returncode == 0:
        sh(["git", "branch", "-q", "-D", branch], cwd=repo)


def keel_arm(t, work):
    repo = work / "keel"
    branch = f"keel/{t['instance_id']}"
    reset(repo, t, branch)
    state = work / f"state-{time.strftime('%Y%m%d-%H%M%S')}"  # fresh routing and receipts per run, never an old ledger
    tmp = BENCH / "tmp" / t["instance_id"]
    tmp.mkdir(parents=True, exist_ok=True)
    env = {**scrubbed(), "KEEL_STATE_DIR": str(state), "TMPDIR": str(tmp)}
    env.pop("KEEL_AUTHOR", None)
    start = time.time()
    r = sh(["keel", "run", str(work / f"{t['instance_id']}.md"), "--repo", str(repo)], env=env, check=False, timeout=TIMEOUT)
    (work / "keel.log").write_text(r.stdout + r.stderr)
    rows = [json.loads(l) for l in (state / "ledger.jsonl").read_text().splitlines()] if (state / "ledger.jsonl").exists() else []
    receipts = []
    if (state / "receipts").exists():
        for f in sorted((state / "receipts").iterdir()):
            rec = json.loads(f.read_text())
            failed = next((x for x in rec["results"] if not x["pass"]), None)
            receipts.append(
                {
                    "pass": rec["pass"],
                    "failedStage": failed["name"] if failed else None,
                    "rules": [p.get("rule") for p in (failed or {}).get("problems", [])],
                    "reviewer": next((x.get("reviewer") for x in rec["results"] if x["name"] == "review"), None),
                    "fallback": next((x.get("fallback") for x in rec["results"] if x["name"] == "review"), None),
                }
            )
    passed = r.returncode == 0 and any(x["pass"] for x in receipts)
    patch = ""
    if passed:
        patch = sh(["git", "diff", setup_commit(repo, t), branch, "--", ".", *EXCLUDE], cwd=repo).stdout
    cost = sum((x.get("cost") or 0) + (x.get("reviewCost") or 0) for x in rows)
    return {
        "pass": passed,
        "exit": r.returncode,
        "patch": patch,
        "seconds": round(time.time() - start),
        "cost": round(cost, 4),
        "unpriced": sum(1 for x in rows if x.get("cost") is None and x.get("role") != "held-out-author"),
        "attempts": [
            {k: x.get(k) for k in ("attempt", "tier", "provider", "model", "effort", "workerStatus", "gatePass", "cost", "reviewCost", "role")}
            for x in rows
        ],
        "receipts": receipts,
    }


def plain_arm(t, work):
    repo = work / "plain"
    reset(repo, t)
    model, effort = PLAIN_MODEL
    prompt = (work / "prompt.txt").read_text()
    start = time.time()
    r = sh(
        ["claude", "-p", prompt, "--output-format", "json", "--model", model, "--effort", effort, "--permission-mode", "auto",
         "--strict-mcp-config", "--disable-slash-commands"],
        cwd=repo, env=isolated(), check=False, timeout=TIMEOUT,
    )
    (work / "plain.log").write_text(r.stdout + r.stderr)
    cost = None
    try:
        cost = json.loads(r.stdout.strip().split("\n")[-1]).get("total_cost_usd")
    except json.JSONDecodeError:
        pass
    sh(["git", "add", "-A"], cwd=repo)
    patch = sh(["git", "diff", "--cached", setup_commit(repo, t), "--", ".", *EXCLUDE], cwd=repo).stdout
    return {"exit": r.returncode, "patch": patch, "seconds": round(time.time() - start), "cost": cost}


if __name__ == "__main__":
    arm, want = sys.argv[1], set(sys.argv[2:])
    run = {"keel": keel_arm, "plain": plain_arm}[arm]
    (RESULTS / arm).mkdir(parents=True, exist_ok=True)
    for t in load_tasks():
        out = RESULTS / arm / f"{t['instance_id']}.json"
        if (want and t["instance_id"] not in want) or (not want and out.exists()):
            continue
        res = {"instance_id": t["instance_id"], **run(t, BENCH / "work" / t["instance_id"])}
        out.write_text(json.dumps(res, indent=1) + "\n")
        print(f"{arm} {t['instance_id']}: patch {len(res['patch'])} chars, cost {res['cost']}, {res['seconds']}s", flush=True)
