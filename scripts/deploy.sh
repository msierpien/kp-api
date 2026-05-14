#!/bin/bash
# Skrypt deploymentu backendu na Proxmox VM
# Uruchomienie: bash scripts/deploy.sh

set -e

COMPOSE_FILE="docker-compose.production.yml"
ENV_FILE=".env"

echo "=== Deploy: Personalization API ==="

# Sprawdź czy .env istnieje
if [ ! -f "$ENV_FILE" ]; then
  echo "BŁĄD: Brak pliku $ENV_FILE"
  echo "Skopiuj .env.production.example jako .env i wypełnij wartości."
  exit 1
fi

# Zatrzymaj stare kontenery (bez usuwania danych)
echo "[1/4] Zatrzymywanie kontenerów..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans

# Zbuduj i uruchom
echo "[2/4] Budowanie i uruchamianie kontenerów..."
docker compose -f "$COMPOSE_FILE" up -d --build

# Poczekaj aż API będzie gotowe
echo "[3/4] Oczekiwanie na gotowość API..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3001/health | grep -q '"status":"ok"'; then
    echo "API gotowe!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "BŁĄD: API nie odpowiedziało w ciągu 60s"
    docker compose -f "$COMPOSE_FILE" logs api --tail=50
    exit 1
  fi
  sleep 2
done

# Uruchom migracje bazy danych
echo "[4/4] Uruchamianie migracji Prisma..."
docker compose -f "$COMPOSE_FILE" exec api pnpm prisma migrate deploy

echo ""
echo "=== Deploy zakończony pomyślnie ==="
echo "API: http://localhost:3001/health"
