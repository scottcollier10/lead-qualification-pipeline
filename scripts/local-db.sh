#!/usr/bin/env bash
# Local-only throwaway Postgres for tests. Uses the Supabase Postgres image so
# roles (anon, authenticated, service_role) and privileges match hosted Supabase.
# Never points at a cloud database.
set -euo pipefail
NAME=lqv2-local-db
PORT=${LQ_V2_LOCAL_DB_PORT:-54329}
IMAGE=${LQ_V2_LOCAL_DB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.132}
URL="postgres://postgres:postgres@localhost:${PORT}/postgres"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "${PORT}:5432" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
    for i in $(seq 1 60); do
      if psql "$URL" -qtAc 'select 1' >/dev/null 2>&1; then break; fi
      sleep 1
    done
    # The Supabase image runs init scripts after first accepting connections; wait for service_role.
    for i in $(seq 1 60); do
      if [ "$(psql "$URL" -qtAc "select count(*) from pg_roles where rolname='service_role'" 2>/dev/null)" = "1" ]; then break; fi
      sleep 1
    done
    for f in "$ROOT"/sql/migrations/*.sql; do
      psql "$URL" -q -v ON_ERROR_STOP=1 -f "$f"
    done
    echo "local db ready: $URL"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  url)
    echo "$URL"
    ;;
  *)
    echo "usage: $0 up|down|url" >&2; exit 1 ;;
esac
