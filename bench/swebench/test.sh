#!/bin/sh
# Run test files of one SWE-bench task inside the task's Docker image, with this checkout mounted at /testbed (BUI-1141).
# prepare.py copies this file to .keel-bench/test.sh in each task checkout, next to .keel-bench/env.
#
#   sh .keel-bench/test.sh [test files...]   # no arguments: the test files changed since the task base
#
# The container gets a name and a time limit (KEEL_BENCH_TEST_TIMEOUT seconds, default 1800), and it is killed by name
# when the limit is hit or when this script is terminated (REQ-BENCH-1, -2): `docker run --rm` alone left hung
# containers running for days after the caller gave up (BUI-1323).
set -eu
limit=${KEEL_BENCH_TEST_TIMEOUT:-1800}
case "$limit" in
  '' | *[!0-9]* | 0*) echo "keel-bench: KEEL_BENCH_TEST_TIMEOUT must be a positive integer of seconds, got '$limit'" >&2; exit 2 ;;
esac
here=$(cd "$(dirname "$0")/.." && pwd)
. "$here/.keel-bench/env"
cd "$here"
if [ $# -gt 0 ]; then
  files="$*"
else
  files=$({ git diff --name-only "$BASE" --; git ls-files --others --exclude-standard; } | grep -E "$TEST_RE" | sort -u |
    while read -r f; do [ -f "$f" ] && echo "$f"; done | tr '\n' ' ')
fi
if [ -z "$(echo "$files" | tr -d ' ')" ]; then echo "keel-bench: no changed test files"; exit 0; fi
case "$REPO" in
  django/django) targets=$(for f in $files; do echo "$f" | sed -e 's#^tests/##' -e 's#\.py$##' -e 's#/#.#g'; done | tr '\n' ' ') ;;
  *) targets="$files" ;;
esac
# The image has an editable install of /testbed; pytest also needs its generated version file, so it is reinstalled.
install=":"
[ "$REPO" = pytest-dev/pytest ] && install="python -m pip install -e . --no-deps -q >/dev/null 2>&1"
name="keel-bench-$$-$(date +%s)"
# The trap is set before the container or the watchdog starts: a signal between `docker run &` and a later trap ended
# the script with the default action and left the new container running (REQ-BENCH-2, BUI-1704).
# The shell runs a trap only between commands, so an empty `run` in the trap means the client may be forked but
# `run=$!` has not run yet: the trap then only sets `signal`, and the check right after `run=$!` stops the run.
# `stop` removes the container whether it is running or only created: a client that has created its container forwards
# TERM to it instead of exiting, and `docker kill` fails on a container that has not started. So the client gets KILL,
# and the container is removed again after the client is gone, in case it created the container meanwhile.
run=
watchdog=
signal=
remove() {
  if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name" >/dev/null; fi
}
stop() {
  echo "keel-bench: terminated; killing container $name" >&2
  for p in $watchdog; do kill "$p" 2>/dev/null || true; done
  remove
  for p in $run; do
    kill -KILL "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  remove
  exit 143
}
trap 'signal=1; [ -z "$run" ] || stop' TERM INT HUP
docker run --rm --name "$name" --platform linux/amd64 -e SETUPTOOLS_SCM_PRETEND_VERSION=99.0 -v "$here":/testbed "$IMAGE" \
  timeout "$limit" bash -c "source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed && $install; $RUNNER $targets" &
run=$!
[ -z "$signal" ] || stop
# The watchdog kills the container from the host too, in case the client or the emulated timeout hangs. It polls the
# client once a second instead of one long sleep: a missed TERM then leaves at most a 1 s sleep, never one that holds
# the caller's output open for the whole limit (REQ-BENCH-3).
(
  elapsed=0
  while [ "$elapsed" -lt "$limit" ]; do
    sleep 1
    kill -0 "$run" 2>/dev/null || exit 0
    elapsed=$((elapsed + 1))
  done
  echo "keel-bench: tests exceeded $limit s (KEEL_BENCH_TEST_TIMEOUT); killing container $name" >&2
  docker kill "$name" >/dev/null
) &
watchdog=$!
status=0
wait "$run" || status=$?
trap - TERM INT HUP
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
exit "$status"
