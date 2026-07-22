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

# The command-scoped assignment is the trust boundary: Prisma may migrate with
# the admin principal, but this shell's DATABASE_URL remains the runtime DSN.
DATABASE_URL="$migration_database_url" \
  pnpm --filter @uoa/api exec prisma migrate deploy --schema prisma/schema.prisma

exec node API/dist/server.js
