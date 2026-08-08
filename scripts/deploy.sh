#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
API_URL="${API_URL:-http://127.0.0.1:3001}"
SKIP_GIT_PULL="${SKIP_GIT_PULL:-0}"
IMAGE="kp-api-app:production"
ROLLBACK_IMAGE="kp-api-app:rollback"
APP_SERVICES=(api worker scheduler)
BUILD_SERVICES=(api migrate)
# Ile GB musi byc wolne, zanim ruszy build. Sam obraz wazy ~1,2 GB, ale eksport
# warstw potrzebuje miejsca na rozpakowane dane posrednie - przy niecalym GB
# deploy padal dopiero po kilku minutach budowania, na zapisie warstw.
MIN_FREE_GB="${MIN_FREE_GB:-5}"
# Sprzatanie po udanym deployu. SKIP_CLEANUP=1 wylacza (np. przy debugowaniu
# buildu, gdy cache ma zostac).
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat <<'USAGE'
Uzycie:
  bash scripts/deploy.sh [--after-pull|--no-pull|--skip-git-pull]

Domyslnie skrypt robi git pull --ff-only, build obrazow, migracje Prisma,
restart api/worker/scheduler i healthcheck /health.

Parametry:
  --after-pull, --no-pull, --skip-git-pull
      Pomin git pull, gdy zmiany zostaly juz pobrane recznie.
  --pull
      Wymus git pull nawet przy SKIP_GIT_PULL=1.
  -h, --help
      Pokaz pomoc.

Zmienne srodowiskowe:
  MIN_FREE_GB (domyslnie 5)
      Ile GB musi byc wolne przed budowaniem. Ponizej progu skrypt najpierw
      sprzata cache i obrazy bez taga, a gdy to nie wystarczy - przerywa deploy
      PRZED budowaniem, zamiast padac w polowie zapisu warstw.
  SKIP_CLEANUP=1
      Nie sprzataj po udanym deployu (przydatne przy debugowaniu buildu).
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --after-pull|--no-pull|--skip-git-pull)
      SKIP_GIT_PULL=1
      ;;
    --pull)
      SKIP_GIT_PULL=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "BŁĄD: nieznany parametr: $arg"
      usage
      exit 1
      ;;
  esac
done

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

docker_data_root() {
  docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker
}

free_gb() {
  local target="$1"
  # Az do korzenia w gore: swiezo po instalacji katalog dockera moze jeszcze
  # nie istniec, a `df` na nieistniejacej sciezce zwraca blad.
  while [[ ! -d "$target" && "$target" != "/" ]]; do
    target="$(dirname "$target")"
  done
  df -P -BG "$target" | awk 'NR==2 { gsub("G", "", $4); print $4 }'
}

# Usuwa WYLACZNIE rzeczy nieprzypisane do niczego: cache budowania i obrazy bez
# taga. `kp-api-app:production` i `:rollback` maja tagi, wiec zostaja - rollback
# musi przezyc sprzatanie, bo to jedyna droga powrotu.
prune_docker_leftovers() {
  echo "Sprzatanie: cache budowania i obrazy bez taga"
  docker builder prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
}

# Kazdy deploy zostawia obraz bez taga (~1,2 GB). Bez sprzatania uzbieralo sie
# ich 84 i dysk stanal na 100% - build przechodzil, a deploy padal dopiero przy
# zapisie warstw. Sprawdzamy miejsce ZANIM cokolwiek zbudujemy.
ensure_disk_space() {
  local root free
  root="$(docker_data_root)"
  free="$(free_gb "$root")"

  if [[ -z "$free" ]]; then
    echo "OSTRZEZENIE: nie udalo sie odczytac wolnego miejsca dla $root - pomijam kontrole"
    return 0
  fi

  if [[ "$free" -ge "$MIN_FREE_GB" ]]; then
    echo "Wolne miejsce: ${free} GB (wymagane ${MIN_FREE_GB} GB)"
    return 0
  fi

  echo "Wolne miejsce: ${free} GB, wymagane ${MIN_FREE_GB} GB - probuje odzyskac"
  prune_docker_leftovers
  free="$(free_gb "$root")"

  if [[ "$free" -lt "$MIN_FREE_GB" ]]; then
    echo "BLAD: po sprzataniu nadal tylko ${free} GB wolnego na $root."
    echo "      Deploy przerwany PRZED budowaniem - produkcja dziala dalej na starym obrazie."
    echo "      Zwolnij miejsce recznie, np.:"
    echo "        docker system df                 # co zajmuje miejsce"
    echo "        docker image prune -a --filter 'until=168h'   # obrazy starsze niz tydzien"
    echo "      albo uruchom ponownie z nizszym progiem: MIN_FREE_GB=3 bash scripts/deploy.sh"
    exit 1
  fi

  echo "Odzyskano miejsce, wolne: ${free} GB"
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
  echo "[1/7] Pomijam git pull (zmiany powinny byc juz pobrane)"
else
  echo "[1/7] Pobieranie zmian z git"
  script_before="$(git rev-parse "HEAD:scripts/deploy.sh" 2>/dev/null || echo brak)"
  git pull --ff-only
  ensure_clean_worktree

  # Bash czyta skrypt PARTIAMI, wiec podmiana pliku w trakcie jego wykonywania
  # sprawia, ze dalsza czesc jest czytana z nowego pliku od starego offsetu -
  # a to znaczy losowo urwane polecenia. Skoro `git pull` moze podmienic wlasnie
  # ten plik, po takiej zmianie uruchamiamy sie od nowa juz z nowej wersji.
  script_after="$(git rev-parse "HEAD:scripts/deploy.sh" 2>/dev/null || echo brak)"
  if [[ "$script_before" != "$script_after" ]]; then
    echo "deploy.sh zmienil sie w tym pobraniu - uruchamiam sie ponownie z nowej wersji"
    exec bash "$0" --after-pull
  fi
fi

current_commit="$(git rev-parse --short HEAD)"
export GIT_SHA="${GIT_SHA:-$(git rev-parse --short=12 HEAD)}"
export BUILD_DATE="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

echo "[2/7] Przygotowanie rollbacku obrazu"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi

echo "[3/7] Budowanie obrazów z obniżonym priorytetem"
ensure_disk_space
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

echo "[7/7] Healthcheck i wersja"
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

if ! version_payload="$(curl -fsS "$API_URL/version")"; then
  echo "BŁĄD: API nie zwróciło informacji o wersji"
  rollback_app_image
  exit 1
fi

echo "Wersja API: ${version_payload}"
echo "Weryfikacja ról"
compose ps "${APP_SERVICES[@]}"
git rev-parse HEAD > .deployed-main-commit
echo "Deploy OK: ${previous_commit} -> ${current_commit} (${GIT_SHA}, ${BUILD_DATE})"

# Dopiero TERAZ, po zdrowym API: poprzedni obraz jest juz odtagowany do
# `:rollback`, wiec sprzatanie nie zabiera drogi powrotu. Bledy sprzatania nie
# moga wywrocic udanego deployu - stad `|| true` w srodku.
if [[ "$SKIP_CLEANUP" == "1" ]]; then
  echo "Sprzatanie pominiete (SKIP_CLEANUP=1)"
else
  prune_docker_leftovers
  echo "Wolne miejsce po sprzataniu: $(free_gb "$(docker_data_root)") GB"
fi
