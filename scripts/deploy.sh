#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
API_URL="${API_URL:-http://127.0.0.1:3001}"
IMAGE="kp-api-app:production"
ROLLBACK_IMAGE="kp-api-app:rollback"

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "BŁĄD: brak pliku .env"
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "BŁĄD: repozytorium ma niezatwierdzone zmiany"
  exit 1
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi

echo "[1/5] Budowanie obrazu z obniżonym priorytetem"
ionice -c2 -n7 nice -n 10 docker compose -f "$COMPOSE_FILE" build api

echo "[2/5] Migracje bazy"
docker compose -f "$COMPOSE_FILE" run --rm --no-deps api pnpm prisma migrate deploy

echo "[3/5] Uruchamianie rozdzielonych procesów"
docker compose -f "$COMPOSE_FILE" up -d --no-deps api worker scheduler

echo "[4/5] Healthcheck"
for attempt in $(seq 1 30); do
  if curl -fsS "$API_URL/health" >/dev/null; then
    echo "API gotowe"
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "BŁĄD: API nie odpowiedziało w ciągu 60 sekund"
    if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
      docker tag "$ROLLBACK_IMAGE" "$IMAGE"
      docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api worker scheduler
      echo "Przywrócono poprzedni obraz"
    fi
    exit 1
  fi
  sleep 2
done

echo "[5/5] Weryfikacja ról"
docker compose -f "$COMPOSE_FILE" ps api worker scheduler
git rev-parse HEAD > .deployed-main-commit
echo "Deploy OK: $(git rev-parse --short HEAD)"
