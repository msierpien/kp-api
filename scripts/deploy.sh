#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
API_URL="${API_URL:-http://127.0.0.1:3001}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"
IMAGE="kp-api-app:production"
ROLLBACK_IMAGE="kp-api-app:rollback"
APP_SERVICES=(api worker scheduler)
BUILD_SERVICES=(api migrate)

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "BŁĄD: brak pliku $COMPOSE_FILE"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "BŁĄD: brak pliku .env"
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "BŁĄD: brak docker compose / docker-compose"
  exit 1
fi

compose() {
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" "$@"
}

run_low_priority() {
  if command -v ionice >/dev/null 2>&1; then
    ionice -c2 -n7 nice -n 10 "$@"
  else
    nice -n 10 "$@"
  fi
}

ensure_clean_worktree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "BŁĄD: repozytorium ma niezatwierdzone zmiany"
    git status --short --untracked-files=no
    exit 1
  fi
}

rollback_app_image() {
  if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    compose up -d --no-deps --force-recreate "${APP_SERVICES[@]}"
    echo "Przywrócono poprzedni obraz aplikacji. Migracje bazy nie są automatycznie cofane."
  fi
}

wait_for_container_command() {
  local label="$1"
  shift

  for attempt in $(seq 1 30); do
    if "$@" >/dev/null 2>&1; then
      echo "${label} gotowe"
      return 0
    fi

    if [[ "$attempt" -eq 30 ]]; then
      echo "BŁĄD: ${label} nie odpowiedział w ciągu 60 sekund"
      exit 1
    fi

    sleep 2
  done
}

ensure_clean_worktree
previous_commit="$(git rev-parse --short HEAD)"

if [[ "$SKIP_GIT_PULL" == "1" ]]; then
  echo "[1/7] Pomijam git pull (SKIP_GIT_PULL=1)"
else
  echo "[1/7] Pobieranie zmian z git"
  git pull --ff-only
  ensure_clean_worktree
fi

current_commit="$(git rev-parse --short HEAD)"

echo "[2/7] Przygotowanie rollbacku obrazu"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi

echo "[3/7] Budowanie obrazów z obniżonym priorytetem"
run_low_priority "${COMPOSE[@]}" -f "$COMPOSE_FILE" build "${BUILD_SERVICES[@]}"

echo "[4/7] Uruchamianie zależności"
compose up -d postgres redis
wait_for_container_command "Postgres" compose exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
wait_for_container_command "Redis" compose exec -T redis sh -lc 'redis-cli -a "$REDIS_PASSWORD" ping'

echo "[5/7] Migracje bazy"
if ! compose run --rm migrate; then
  echo "BŁĄD: migracje nie powiodły się"
  rollback_app_image
  exit 1
fi

echo "[6/7] Uruchamianie rozdzielonych procesów"
compose up -d --no-deps --force-recreate "${APP_SERVICES[@]}"

echo "[7/7] Healthcheck"
for attempt in $(seq 1 30); do
  if curl -fsS "$API_URL/health" >/dev/null; then
    echo "API gotowe"
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "BŁĄD: API nie odpowiedziało w ciągu 60 sekund"
    rollback_app_image
    exit 1
  fi
  sleep 2
done

echo "Weryfikacja ról"
compose ps "${APP_SERVICES[@]}"
git rev-parse HEAD > .deployed-main-commit
echo "Deploy OK: ${previous_commit} -> ${current_commit}"
