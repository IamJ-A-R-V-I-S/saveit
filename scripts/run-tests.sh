#!/usr/bin/env bash
# =============================================================================
# SaveIt — local test runner
#
# Runs everything that can be verified without a deployed Supabase project:
# the deterministic parser, the dedup-key parity contract, and the taxonomy
# resolver. Uses Node's built-in type stripping, so no build step and no Deno
# install is required locally.
#
#   ./scripts/run-tests.sh
#
# The database integration test (scripts/db-integration-test.sql) is NOT run
# here -- it needs a live project. See scripts/run-db-tests.sh.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

NODE_FLAGS="--experimental-strip-types --no-warnings"
status=0

run() {
  local label="$1"; shift
  printf '\n\033[1m▸ %s\033[0m\n' "$label"
  if node $NODE_FLAGS "$@"; then
    printf '\033[32m  ✓ %s passed\033[0m\n' "$label"
  else
    printf '\033[31m  ✗ %s FAILED\033[0m\n' "$label"
    status=1
  fi
}

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "Node 22+ is required for --experimental-strip-types (found $(node -v))" >&2
  exit 1
fi

run "parser"        scripts/test-parse.mjs
run "dedup parity"  scripts/test-dedup-parity.mjs
run "taxonomy"      scripts/test-taxonomy.mjs
run "merge queue"   scripts/test-merge-candidates.mjs
run "pipeline"      scripts/test-pipeline.mjs

printf '\n'
if [ "$status" -eq 0 ]; then
  printf '\033[32m\033[1mAll local test suites passed.\033[0m\n'
else
  printf '\033[31m\033[1mSome tests failed.\033[0m\n'
fi
exit "$status"
