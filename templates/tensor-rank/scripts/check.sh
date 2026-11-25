#!/usr/bin/env bash
# Runs the self-check suite on all tensor-rank targets in targets.json.
set -euo pipefail
cd "$(dirname "$0")/.."
node checker/verify.mjs --self-check targets.json
