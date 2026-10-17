#!/bin/sh
# Run test files of one SWE-bench task inside the task's Docker image, with this checkout mounted at /testbed (BUI-1141).
# prepare.py copies this file to .keel-bench/test.sh in each task checkout, next to .keel-bench/env.
#
#   sh .keel-bench/test.sh [test files...]   # no arguments: the test files changed since the task base
set -eu
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
exec docker run --rm --platform linux/amd64 -e SETUPTOOLS_SCM_PRETEND_VERSION=99.0 -v "$here":/testbed "$IMAGE" \
  bash -c "source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed && $install; $RUNNER $targets"
