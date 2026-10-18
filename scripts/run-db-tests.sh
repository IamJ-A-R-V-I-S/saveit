#!/usr/bin/env bash
# =============================================================================
# SaveIt — database integration test runner
#
# Applies scripts/db-integration-test.sql to a Supabase project and prints the
# report. Requires either:
#
#   - psql, with SUPABASE_DB_URL set (Settings -> Database -> Connection string)
#   - or the Supabase CLI:  supabase db ...
#
# The test is self-cleaning: it creates a throwaway user
# (dbtest@example.invalid), asserts against it, then deletes the auth row so
# every FK cascades away. It leaves one helper table and one helper function
# behind, which this script drops at the end.
#
#   SUPABASE_DB_URL=postgres://... ./scripts/run-db-tests.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<'MSG'
SUPABASE_DB_URL is not set.

Get it from the Supabase dashboard: Project Settings -> Database ->
Connection string (URI). It looks like:

  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

Then run:

  SUPABASE_DB_URL='...' ./scripts/run-db-tests.sh
MSG
  exit 1
fi

command -v psql >/dev/null || {
  echo "psql is required. On Debian/Ubuntu: apt-get install postgresql-client" >&2
  exit 1
}

echo "▸ running database integration tests"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/db-integration-test.sql

echo
echo "▸ dropping test helper artifacts"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'drop table if exists public._saveit_test_results;
   drop function if exists public._saveit_assert(text, boolean, text);'

echo
echo "Done. A non-zero 'failed' count in the report above means something is broken."
