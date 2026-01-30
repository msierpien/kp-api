# Personalization API

API do personalizacji zaproszeń z integracją PrestaShop. Aktualnie podgląd PNG generowany jest po stronie klienta (Fabric.js) i uploadowany do API. Finalny PDF (druk) jeszcze nie jest zaimplementowany.

## Technologie
- TypeScript + Fastify
- Prisma + PostgreSQL
- Redis + BullMQ (kolejka renderów)
- Docker Compose (lokalnie)

## Szybki start (Docker)
```bash
cp .env.example .env
docker-compose up -d
docker-compose exec api pnpm prisma migrate dev
docker-compose exec api pnpm prisma:seed
```
API: `http://localhost:3001`

## Szybki start (dev bez Dockera)
```bash
pnpm install
pnpm prisma generate
pnpm prisma migrate dev
pnpm dev
```

## Najważniejsze endpointy
### Public (portal klienta)
- `GET /personalization/:token` – dane case + formularz
- `PUT /personalization/:token/design` – zapis draftu (answers)
- `POST /personalization/:token/preview` – walidacja + zwrot istniejącego preview (bez renderu)
- `POST /personalization/:token/upload-preview` – upload PNG z frontu
- `POST /personalization/:token/submit` – submit i utworzenie render job

### Admin
- `POST /auth/login`
- `POST /auth/refresh`
- `GET /admin/cases`
- `GET /admin/templates`
- `GET /admin/orders`

## Storage
Pliki zapisują się w `api/storage/<orderId>/v<templateVersion>/...` i są dostępne pod `/storage/...`.

## Zmienne środowiskowe
Najważniejsze (pełna lista w `.env.example`):
- `API_PORT`, `API_HOST`
- `DATABASE_URL`
- `REDIS_URL`
- `STORAGE_PATH`
- `API_URL` (do budowania URL w storage)

## Użytkownicy testowi (seed)
- Admin: `admin@kreatywne-papierki.pl` / `admin123`
- Seller: `seller@kreatywne-papierki.pl` / `seller123`
