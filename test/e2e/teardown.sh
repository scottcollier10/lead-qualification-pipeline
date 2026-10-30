#!/usr/bin/env bash
# Removes the local e2e containers and network. Leaves the local test DB running
# (stop it with: npm run db:down).
docker rm -f lqv2-n8n lqv2-postgrest >/dev/null 2>&1 || true
docker network disconnect lqv2-e2e lqv2-local-db >/dev/null 2>&1 || true
docker network rm lqv2-e2e >/dev/null 2>&1 || true
pkill -f test/e2e/fake-cloud.js >/dev/null 2>&1 || true
echo "e2e stack removed"
