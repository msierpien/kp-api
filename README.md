# Personalization API

API do personalizacji zaproszeń z integracją PrestaShop 9.

## Technologie

- **Backend:** TypeScript + Fastify
- **ORM:** Prisma
- **Baza danych:** PostgreSQL 16
- **Cache/Queue:** Redis 7
- **Auth:** JWT (access + refresh tokens)
- **Container:** Docker + Docker Compose

## Wymagania

- Docker Desktop lub Docker Engine + Docker Compose
- Node.js 20+ (dla development bez Dockera)
- pnpm 9+ (zamiast npm - szybszy i bardziej efektywny)

## Instalacja i uruchomienie

### 1. Przygotowanie środowiska

```bash
# Skopiuj plik środowiskowy
cp .env.example .env

# Edytuj .env i dostosuj wartości
```

### 2. Uruchomienie z Dockerem (zalecane)

```bash
# Uruchom wszystkie serwisy
docker-compose up -d

# Sprawdź logi
docker-compose logs -f api

# Wykonaj migracje Prisma
docker-compose exec api pnpm prisma migrate dev --name init

# (Opcjonalnie) Wypełnij bazę danymi testowymi
docker-compose exec api pnpm prisma:seed

# Zatrzymaj serwisy
docker-compose down

# Zatrzymaj i usuń volumes (UWAGA: usuwa dane z bazy!)
docker-compose down -v
```

API będzie dostępne na: `http://localhost:3001`
Adminer (UI bazy danych): `http://localhost:8081`
Prisma Studio: `docker-compose exec api pnpm prisma studio`

### 3. Uruchomienie bez Dockera (development)

```bash
# Zainstaluj pnpm (jeśli nie masz)
corepack enable
corepack prepare pnpm@latest --activate

# Zainstaluj zależności
pnpm install

# Wygeneruj Prisma Client
pnpm prisma generate

# Upewnij się, że PostgreSQL i Redis działają lokalnie
# Dostosuj DB_HOST=localhost i REDIS_HOST=localhost w .env

# Wykonaj migracje
pnpm prisma migrate dev

# (Opcjonalnie) Wypełnij bazę danymi
pnpm db:seed

# Uruchom w trybie dev
pnpm dev
```

## Struktura projektu

```
api/
├── docker-compose.yml       # Konfiguracja kontenerów
├── Dockerfile               # Budowanie obrazu API
├── package.json             # Zależności Node.js
├── tsconfig.json            # Konfiguracja TypeScript
├── .env.example             # Przykładowy plik środowiskowy
├── .env                     # Plik środowiskowy (git-ignored)
├── prisma/
│   ├── schema.prisma       # Schemat bazy danych Prisma
│   └── seed.ts             # Dane testowe
└── src/
    ├── index.ts            # Główny plik aplikacji
    ├── lib/
    │   └── prisma.ts       # Singleton Prisma Client
    ├── config/             # Konfiguracja
    ├── routes/             # Endpointy API
    ├── services/           # Logika biznesowa
    ├── middleware/         # Middleware (auth, validation)
    ├── types/              # Typy TypeScript
    └── utils/              # Narzędzia pomocnicze
```

pnpm dev              # Uruchom w trybie dev z hot-reload
pnpm start:dev        # Alias dla pnpm dev

# Production
pnpm build            # Zbuduj aplikację
pnpm start            # Uruchom zbudowaną aplikację

# Prisma
pnpm prisma:generate       # Wygeneruj Prisma Client
pnpm prisma:migrate        # Utwórz i zastosuj migrację (dev)
pnpm prisma:migrate:deploy # Zastosuj migracje (production)
pnpm prisma:studio         # Otwórz Prisma Studio
pnpm prisma:seed           # Wypełnij bazę danymi testowymi

# Database
pnpm db:push          # Push schematu do DB bez migracji
pnpm db:seed          # Wypełnij bazę danymi testowymi

# Code quality
pnpm lint             # Sprawdź kod
pnpm lint:fix         # Napraw automatycznie błędy

# Tests
pnpm test             # Uruchom testy
pnpm lint:fix         # Napraw automatycznie błędy

# Tests
npm run test             # Uruchom testy
npm run test:watch       # Testy w trybie watch
```

## Prisma

pnpm prisma migrate dev --name nazwa_migracji

# Wygenerowanie Prisma Client po zmianach
pnpm prisma generate

# Przeglądanie danych w Prisma Studio
pnpm prisma studio

# Reset bazy danych (UWAGA: usuwa wszystkie dane!)
pnpm prisma migrate reset

# Push schematu bez tworzenia migracji (szybkie prototypowanie)
pnpmeset bazy danych (UWAGA: usuwa wszystkie dane!)
npx prisma migrate reset

# Push schematu bez tworzenia migracji (szybkie prototypowanie)
npx prisma db push
```

### Schemat bazy

Pełny schemat znajduje się w `prisma/schema.prisma`.

Główne modele:
- `Shop` - sklepy PrestaShop
- `Order`, `OrderItem` - zamówienia
- `WebhookEvent` - zdarzenia webhook
- `PersonalizationTemplate` - szablony personalizacji
- `Form`, `FormField` - definicje formularzy
- `PersonalizationCase` - przypadki personalizacji
- `PersonalizationAnswer` - odpowiedzi klientów
- `User` - użytkownicy admin/seller

## Endpointy API

### Status
- `GET /` - Informacje o API
- `GET /health` - Health check

### Webhook (PrestaShop → API)
- `POST /webhooks/prestashop/order` - Przyjmij zamówienie z PrestaShop

### Portal publiczny (klient)
- `GET /public/orders/:order_reference` - Lista case w zamówieniu
- `GET /public/cases/:case_id` - Formularz i odpowiedzi
- `PUT /public/cases/:case_id/answers` - Zapisz odpowiedzi (draft)
- `POST /public/cases/:case_id/submit` - Zatwierdź personalizację

### Panel admin
- `POST /auth/login` - Zaloguj admina
- `POST /auth/refresh` - Odśwież token
- `GET /admin/cases` - Lista przypadków (filtry)
- `GET /admin/cases/:case_id` - Szczegóły case
- `PUT /admin/cases/:case_id/answers` - Korekta odpowiedzi
- `PUT /admin/cases/:case_id/status` - Zmień status
- `GET /admin/templates` - Lista szablonów
- `POST /admin/templates` - Utwórz szablon

## Zmienne środowiskowe

Wszystkie zmienne są opisane w pliku `.env.example`.

**WAŻNE:** Przed wdrożeniem produkcyjnym zmień wszystkie sekrety:
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `WEBHOOK_SECRET`
- Hasła do bazy danych i Redis
- `DATABASE_URL` z odpowiednimi credentials

## Dane testowe

Po wykonaniu `pnpm prisma:seed` dostępne będą:

**Użytkownicy:**
- Admin: `admin@kreatywne-papierki.pl` / `admin123`
- Seller: `seller@kreatywne-papierki.pl` / `seller123`

**Szablon:**
- Kod: `INV_KOMUNIA_01`
- Nazwa: "Zaproszenie komunijne - wzór 01"
- Pola: imię dziecka, data, godzina, kościół, miejsce przyjęcia

## Rozwój

### Roadmap
- [x] Setup Docker
- [x] Prisma ORM + schemat bazy danych
- [x] Podstawowa aplikacja Fastify
- [ ] Autoryzacja JWT
- [ ] Webhook z PrestaShop
- [ ] Portal publiczny
- [ ] Panel admin
- [ ] Integracja email
- [ ] Rendering PDF/PNG (przyszłość)

## Dokumentacja

Pełna specyfikacja techniczna: `../spec-personalizacja-prestashop-next-fastify.md`
