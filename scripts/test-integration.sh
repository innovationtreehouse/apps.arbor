#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "Error: OPENROUTER_API_KEY is not set. Export it before running this script."
  exit 1
fi

CONTAINER=arbor-test-postgres
DB_URL="postgres://postgres:postgres@localhost:5433/arbor_test"

cleanup() {
  docker stop "$CONTAINER" 2>/dev/null || true
  docker rm   "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=arbor_test \
  -p 5433:5432 \
  postgres:16

echo "Waiting for postgres..."
until docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done

DATABASE_URL="$DB_URL" npm run --prefix packages/db db:migrate

DATABASE_URL="$DB_URL" \
AWS_REGION=us-east-1 \
SLACK_BOT_TOKEN=xoxb-not-real \
npm run test:integration
