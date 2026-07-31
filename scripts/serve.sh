#!/usr/bin/env bash
# Starts the static dev server (test/serve.js) for manual driving/training.
# Set PORT to override the default 8734.
set -euo pipefail
cd "$(dirname "$0")/.."

node test/serve.js
