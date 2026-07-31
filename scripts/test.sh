#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob

tests=(test/*.test.js)

if (( ${#tests[@]} == 0 )); then
  echo "No test files matched test/*.test.js" >&2
  exit 1
fi

# test/training.test.js runs a real TF.js model through this sandbox's
# software-WebGL backend and alone accounts for ~80% of the suite's wall
# time (~150s of ~190s) -- see train/model.js for why the architecture
# can't shrink to make that faster. Skipped by default so the rest of the
# suite stays fast to iterate on; set RUN_TRAINING_TESTS=1 when you've
# touched something that could affect it (train/, data/tub.js, the test
# itself) or before a final check.
heavy="test/training.test.js"
if [[ "${RUN_TRAINING_TESTS:-0}" != "1" ]]; then
  skipped=()
  kept=()
  for f in "${tests[@]}"; do
    if [[ "$f" == "$heavy" ]]; then skipped+=("$f"); else kept+=("$f"); fi
  done
  tests=("${kept[@]}")
  for f in "${skipped[@]}"; do
    echo "==> $f (skipped -- set RUN_TRAINING_TESTS=1 to include)"
  done
fi

for test_file in "${tests[@]}"; do
  echo "==> $test_file"
  node --test "$test_file"
done
