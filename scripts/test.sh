#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob

tests=(test/*.test.js)

if (( ${#tests[@]} == 0 )); then
  echo "No test files matched test/*.test.js" >&2
  exit 1
fi

for test_file in "${tests[@]}"; do
  echo "==> $test_file"
  node --test "$test_file"
done
