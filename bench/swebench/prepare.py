"""Prepare task checkouts for both arms (BUI-1141).

    python prepare.py [instance_id ...]     # default: every task in tasks.json

Per task, in $KEEL_BENCH_DIR/work/<id>/: `keel/` and `plain/` checkouts at the task base plus one setup commit
(`.keel-bench/` test runner, `keel.json`), `<id>.md` (the issue as a Keel card; the file name is the card ID), and `prompt.txt` (the same text for
plain Claude Code). The Docker image is pulled. Re-running skips what exists.
"""
import json
import shlex
import shutil
import sys

from common import BENCH, HERE, load_tasks, sh

KEEL = HERE.parent.parent
TEST_RE = {
    "django/django": r"^tests/.*/(tests|test_[^/]*)\.py$",
}
DEFAULT_TEST_RE = r"(^|/)test_[^/]*\.py$|_test\.py$|(^|/)tests\.py$"


def keel_defaults():
    out = sh(["node", "-e", "import('./src/config.js').then((m) => console.log(JSON.stringify(m.DEFAULTS.verificationPaths)))"], cwd=KEEL)
    return json.loads(out.stdout)


def requirements(t):
    return (
        f"Fix this issue, reported on {t['repo']}:\n\n{t['problem_statement'].strip()}\n\n"
        "Tests run in the project's Docker image: `sh .keel-bench/test.sh <test files>` "
        "(with no arguments it runs the test files changed since the task base).\n"
    )


def record_setup(t, dest):
    """Backfill work/<id>/<arm>.setup for a checkout set up before it existed, or interrupted after its setup commit:
    the first commit after the task base, only if it is that setup commit (its subject, its parent the base)."""
    first = sh(["git", "rev-list", "--reverse", "--first-parent", f"{t['base_commit']}..bench"], cwd=dest).stdout.split()
    info = sh(["git", "log", "-1", "--format=%s %P", first[0]], cwd=dest).stdout.strip() if first else ""
    if info != f"chore: keel bench setup {t['base_commit']}":
        raise RuntimeError(f"{dest}: no clean setup commit after {t['base_commit']}; delete the checkout and prepare again")
    (dest.parent / f"{dest.name}.setup").write_text(first[0] + "\n")


def setup_checkout(t, dest, cache, verification):
    if (dest / ".keel-bench").exists():
        if not (dest.parent / f"{dest.name}.setup").exists():
            record_setup(t, dest)
        return
    if dest.exists():
        shutil.rmtree(dest)  # an unfinished setup from an earlier attempt; dest is a path this script made
    sh(["git", "clone", "-q", "--shared", "--no-checkout", str(cache), str(dest)])
    sh(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "-b", "bench", t["base_commit"]], cwd=dest)
    for k, v in [("user.email", "bench@keel.invalid"), ("user.name", "keel-bench"), ("commit.gpgsign", "false")]:
        sh(["git", "config", k, v], cwd=dest)
    kb = dest / ".keel-bench"
    kb.mkdir()
    shutil.copy(HERE / "test.sh", kb / "test.sh")
    env = {
        "REPO": t["repo"],
        "BASE": t["base_commit"],
        "IMAGE": t["image"],
        "RUNNER": t["test_command"],
        "TEST_RE": TEST_RE.get(t["repo"], DEFAULT_TEST_RE),
    }
    (kb / "env").write_text("".join(f"{k}={shlex.quote(v)}\n" for k, v in env.items()))
    keel = {
        "checks": {"test": "sh .keel-bench/test.sh"},
        "testCommand": "sh .keel-bench/test.sh",
        "verificationPaths": [*verification, ".keel-bench/**"],
        "shareDirs": [],
    }
    (dest / "keel.json").write_text(json.dumps(keel, indent=1) + "\n")
    sh(["git", "add", "-f", ".keel-bench", "keel.json"], cwd=dest)
    sh(["git", "commit", "-q", "-m", "chore: keel bench setup"], cwd=dest)
    # The baseline lives outside the checkout, where a model's commits, amends, or resets cannot move it (run_arm.py).
    (dest.parent / f"{dest.name}.setup").write_text(sh(["git", "rev-parse", "HEAD"], cwd=dest).stdout)


def prepare(t, verification):
    work = BENCH / "work" / t["instance_id"]
    work.mkdir(parents=True, exist_ok=True)
    cache = BENCH / "repos" / t["repo"].replace("/", "__")
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        sh(["git", "clone", "-q", "--no-checkout", f"https://github.com/{t['repo']}.git", str(cache)], timeout=3600)
    for arm in ("keel", "plain"):
        setup_checkout(t, work / arm, cache, verification)
    title = t["problem_statement"].strip().split("\n")[0][:80].replace("#", "")
    (work / f"{t['instance_id']}.md").write_text(f"# {t['instance_id']}: {title}\nkind: bug\nsize: S\n\n## Requirements\n\n{requirements(t)}")
    (work / "prompt.txt").write_text(requirements(t) + "\nMake the change in this checkout, with a test that fails before it.\n")
    sh(["docker", "pull", "-q", "--platform", "linux/amd64", t["image"]], timeout=3600)


if __name__ == "__main__":
    want = set(sys.argv[1:])
    verification = keel_defaults()
    for t in load_tasks():
        if want and t["instance_id"] not in want:
            continue
        prepare(t, verification)
        print(f"prepared {t['instance_id']}")
