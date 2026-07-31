#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob

tests=(test/*.test.js)

if (( ${#tests[@]} == 0 )); then
  echo "No test files matched test/*.test.js" >&2
  exit 1
fi

node --test "${tests[@]}"
