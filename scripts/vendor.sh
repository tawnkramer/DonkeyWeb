#!/usr/bin/env bash
# Produces the self-hosted /vendor files so the app has zero runtime CDN
# dependencies (CDN latency/outages were causing intermittent failures,
# and offline dev is nice). This is the only place a build tool touches
# the project: the app's own modules stay bundler-free; esbuild just
# flattens npm's tfjs (which has no single-file ESM artifact) into one
# importable file. Import maps don't apply inside workers, so the
# training worker needs exactly this kind of bare-specifier-free file.
#
# Rerun after bumping the pinned versions in package.json (npm run vendor).
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p vendor

npx esbuild scripts/tf-entry.js --bundle --minify --format=esm \
  --platform=browser --outfile=vendor/tf.mjs --log-level=warning

# three ships a real single-file ESM build; a straight copy is the whole job.
cp node_modules/three/build/three.module.js vendor/three.module.js

ls -sh vendor/
