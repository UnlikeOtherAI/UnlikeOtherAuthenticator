#!/bin/sh

set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required for API startup" >&2
  exit 1
fi

if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  migration_database_url=$DATABASE_ADMIN_URL
else
  case "${NODE_ENV:-development}" in
    development|test)
      # Local and disposable test databases deliberately use one unrestricted
      # principal. Every other environment requires the separate admin connection.
      migration_database_url=$DATABASE_URL
      ;;
    production)
      echo "DATABASE_ADMIN_URL is required for production migrations" >&2
      exit 1
      ;;
    *)
      echo "DATABASE_ADMIN_URL is required unless NODE_ENV is development or test" >&2
      exit 1
      ;;
  esac
fi

# A reviewed, checksum-pinned repair handles the rolled-back invitation migration.
# The admin DSN remains scoped to this command, just like Prisma below.
DATABASE_URL="$migration_database_url" node API/dist/cli/recover-invitation-migration.js

# The command-scoped assignment is the trust boundary: Prisma may migrate with
# the admin principal, but this shell's DATABASE_URL remains the runtime DSN.
#
# `set -eu` would abort here on any migrate failure, and for MOST failures that
# is right: refusing to serve on an unknown schema beats serving on one. P3009 is
# different. It means a PREVIOUS migration died half-applied and left
# `_prisma_migrations` with `finished_at NULL, rolled_back_at NULL`; the schema
# may have rolled back, but the bookkeeping is wedged and EVERY subsequent boot
# fails the same way. A bare non-zero exit turns that into an unexplained
# crash-loop and a total auth outage until somebody thinks to read the container
# log. So catch it and say exactly what to run.
#
# Captured to a file rather than piped through `tee`: in POSIX sh a pipeline
# reports the LAST command's status, so `prisma ... | tee log` would report
# tee's success and swallow every migration failure. `pipefail` is not POSIX
# (dash does not have it), so the status is taken directly.
migrate_log="$(mktemp)"
set +e
DATABASE_URL="$migration_database_url" \
  pnpm --filter @uoa/api exec prisma migrate deploy --schema prisma/schema.prisma \
  > "$migrate_log" 2>&1
migrate_status=$?
set -e
cat "$migrate_log"

if [ "$migrate_status" -ne 0 ]; then
  if grep -q 'P3009' "$migrate_log"; then
    echo "" >&2
    echo "=======================================================================" >&2
    echo "MIGRATION BOOKKEEPING IS WEDGED (P3009) — this will crash-loop." >&2
    echo "" >&2
    echo "A previous migration failed. Verify whether its SQL transaction rolled back;" >&2
    echo "but _prisma_migrations still shows it unfinished, so every boot from" >&2
    echo "now on fails here." >&2
    echo "" >&2
    echo "Recover, against DATABASE_ADMIN_URL:" >&2
    echo "  1. SELECT migration_name, started_at, finished_at, rolled_back_at, logs" >&2
    echo "       FROM _prisma_migrations WHERE finished_at IS NULL;" >&2
    echo "  2. Fix whatever the 'logs' column reports (for" >&2
    echo "     20260730180000 that is pre-existing one-active-org-per-domain" >&2
    echo "     violations — the error names every offending user)." >&2
    echo "  3. After proving rollback, ship a scoped recovery using:" >&2
    echo "     npx prisma migrate resolve --rolled-back <migration_name>" >&2
    echo "  4. Redeploy." >&2
    echo "" >&2
    echo "See Docs/deploy.md, 'Recovering from a failed migration'." >&2
    echo "=======================================================================" >&2
  fi
  rm -f "$migrate_log"
  # Propagate Prisma's own exit code rather than flattening it to 1 — the
  # container's status stays as informative as it was before this branch existed.
  exit "$migrate_status"
fi
rm -f "$migrate_log"

exec node API/dist/server.js
