# Personalization API

API do personalizacji zaproszeń z integracją wieloplatformową (PrestaShop, WooCommerce, Shopify, etc.).

## 🚀 Szybki start

### Technologie
- TypeScript + Fastify
- Prisma ORM + PostgreSQL 16
- Redis 7 + BullMQ (kolejka renderów)
- Docker Compose

### Start z Dockerem (zalecane)
```bash
cd api
cp .env.example .env
docker-compose up -d
docker-compose exec api pnpm prisma migrate dev
docker-compose exec api pnpm prisma:seed
```
API: `http://localhost:3001`

### Start bez Dockera
```bash
cd api
pnpm install
pnpm prisma generate
pnpm prisma migrate dev
pnpm prisma:seed
pnpm dev
```

### Porty (Docker)
- **API:** 3001
- **PostgreSQL:** 5432
- **Redis:** 6379
- **Adminer:** 8081 (GUI bazy danych)

## 📋 API Endpoints

### Health Check
- `GET /health` - status API
- `GET /` - informacje o API

### Public (Portal Klienta)
- `GET /personalization/:token` - dane case + formularz + answers
- `PUT /personalization/:token/design` - zapis wersji roboczej (draft)
- `POST /personalization/:token/upload-preview` - upload PNG z frontu
- `POST /personalization/:token/preview` - walidacja + zwrot istniejącego preview (bez renderu)
- `POST /personalization/:token/submit` - zatwierdzenie i utworzenie render job

**Uwaga:** draft i submit zapisują również `layoutOverrides` dla warstw `text` i `textbox`, dzięki czemu finalny render respektuje pozycję i rozmiar ustawione przez klienta.

### Auth
- `POST /auth/login` - logowanie (email + password)
- `POST /auth/refresh` - odświeżenie tokenu (refresh token)
- `GET /auth/me` - pobranie danych zalogowanego użytkownika

### Admin - Case Management
- `GET /admin/cases` - lista case (paginacja, filtry, sortowanie)
- `GET /admin/cases/:id` - szczegóły case
- `PUT /admin/cases/:id/answers` - aktualizacja odpowiedzi (korekta sprzedawcy)
- `PUT /admin/cases/:id/status` - zmiana statusu workflow
- `POST /admin/cases/:id/notes` - dodanie notatki wewnętrznej

### Admin - Integracje (Sklepy)
- `GET /admin/shops` - lista integracji z platformami
- `POST /admin/shops` - dodanie nowej integracji
- `PUT /admin/shops/:id` - edycja integracji
- `POST /admin/shops/:id/test` - test połączenia z API sklepu
- `POST /admin/shops/:id/sync` - manualne uruchomienie synchronizacji zamówień

### Admin - Produkty personalizowane
- `GET /admin/personalized-products` - lista mapowań SKU → template
- `POST /admin/personalized-products` - dodanie produktu personalizowanego
- `PUT /admin/personalized-products/:id` - edycja mapowania

### Admin - Szablony i formularze
- `GET /admin/templates` - lista szablonów
- `GET /admin/templates/:id` - szczegóły szablonu
- `GET /admin/templates/:id/form` - konfiguracja formularza
- `PUT /admin/templates/:id/form` - aktualizacja formularza
- `GET /admin/templates/:id/layout` - pobranie layoutu wizualnego
- `PUT /admin/templates/:id/layout` - zapis layoutu wizualnego
- `GET /admin/templates/:id/assets` - lista assetów szablonu
- `POST /admin/templates/:id/assets` - upload assetu (PNG/JPG/SVG/WebP, max 10 MB)
- `DELETE /admin/templates/:id/assets/:assetId` - usunięcie assetu

### Admin - Czcionki (globalne)
- `GET /admin/fonts` - lista wszystkich czcionek z `storage/fonts/`
- `POST /admin/fonts` - upload czcionki (TTF/OTF/WOFF/WOFF2, max 10 MB)
- `DELETE /admin/fonts/:fileName` - usunięcie czcionki

### Admin - Zamówienia
- `GET /admin/orders` - lista zamówień z items
- `GET /admin/orders/:id` - szczegóły zamówienia

### Admin - Logi i statystyki
- `GET /admin/sync-logs` - historia synchronizacji z platformami
- `GET /admin/stats` - statystyki (count cases per status)

## 💾 Storage

### Lokalizacja
Pliki zapisują się w `api/storage/...`

### Struktura
```
storage/
├── fonts/                              # Globalne czcionki (TTF/OTF/WOFF/WOFF2)
├── templates/
│   └── {templateCode}/
│       └── background/                 # Assety tła szablonu
└── {orderId}/
    └── v{templateVersion}/
        ├── {timestamp}-preview.png     # PNG z portalu klienta
        ├── final.pdf                   # Finalny PDF do druku
        └── assets/                     # Uploaded files
```

### URL
Pliki dostępne pod: `http://localhost:3001/storage/...`

Endpoint: `GET /storage/*` (static file serving)

## 🗄️ Baza danych

### Modele Prisma

**Integracje:**
- `Shop` - konfiguracja sklepów e-commerce (credentials, API type)
- `PersonalizedProduct` - mapowanie SKU/index/EAN → template
- `SyncLog` - logi synchronizacji zamówień

**Zamówienia:**
- `Order` - zamówienia z platform e-commerce
- `OrderItem` - pozycje zamówień

**Personalizacja:**
- `PersonalizationTemplate` - szablony (INV_KOMUNIA_01, etc.)
- `Form` - formularze w szablonie
- `FormField` - pola formularza (text, select, date, etc.)
- `PersonalizationCase` - przypadki personalizacji (1 per order item, answers + layoutOverrides)
- `PersonalizationAnswer` - odpowiedzi klienta

**Użytkownicy:**
- `User` - konta admin/seller (role: ADMIN, SELLER)

### Migracje
```bash
# Utworzenie nowej migracji
pnpm prisma migrate dev --name nazwa_migracji

# Zastosowanie migracji
pnpm prisma migrate deploy

# Reset bazy (DEV ONLY!)
pnpm prisma migrate reset
```

### Seed (dane testowe)
```bash
pnpm prisma:seed
```

Tworzy:
- Użytkowników: admin@kreatywne-papierki.pl, seller@kreatywne-papierki.pl
- Sklep: Kreatywne Papierki (PRESTASHOP)
- Template: INV_KOMUNIA_01 z formularzem
- Produkt personalizowany: SKU=INV-KOMUNIA-001

### Prisma Studio (GUI)
```bash
pnpm prisma studio
```
Otworzy GUI na: `http://localhost:5555`

## 🔒 Bezpieczeństwo

### JWT Auth
- **Access token:** 15 min (HTTP-only cookie)
- **Refresh token:** 7 dni (HTTP-only cookie)
- Middleware: `authenticateJWT` dla wszystkich `/admin/*`

### Rate Limiting
- Public endpoints: 100 req/15min
- Admin endpoints: 1000 req/15min

### CORS
Dozwolone origins z `FRONTEND_URL` i `CLIENT_URL` (env)

### Token personalizacji
- Token w URL jest hashowany w bazie (SHA-256)
- TTL: do momentu zatwierdzenia (submit)
- Po submit: token nieaktywny

## 🔧 Zmienne środowiskowe

Najważniejsze (pełna lista w `.env.example`):

**API:**
- `API_PORT=3001`
- `API_HOST=0.0.0.0`
- `API_URL=http://localhost:3001` (do budowania URL storage)

**Database:**
- `DATABASE_URL=postgresql://user:pass@host:5432/db`

**Redis:**
- `REDIS_URL=redis://localhost:6379`

**Auth:**
- `JWT_ACCESS_SECRET` - secret dla access token
- `JWT_REFRESH_SECRET` - secret dla refresh token

**Frontend URLs:**
- `FRONTEND_URL=http://localhost:3000` (admin panel)
- `CLIENT_URL=http://localhost:3002` (portal klienta)

**Storage:**
- `STORAGE_PATH=./storage` - lokalizacja plików
- `STORAGE_TYPE=local` (docelowo: s3)

**Email:**
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

## 📊 Logowanie

Używamy `pino` jako logger:
- **Dev:** `pino-pretty` (kolorowe logi)
- **Production:** JSON format

Logi zawierają:
- Request ID (X-Request-ID)
- User ID (jeśli auth)
- Timestamp, level, message

## 🔄 Synchronizacja zamówień (PULL)

### Workflow
1. **Cron job** co X minut (5-15 min) - nadal do dokończenia
2. Pobiera opłacone zamówienia z API sklepu
3. **Filtruje** po SKU z tabeli `personalized_products`
4. Tworzy `Order` + `OrderItem` + `PersonalizationCase`
5. Generuje token dostępowy (hash do DB)
6. **Wysyła e-mail** z linkiem
7. Loguje do `sync_logs`

### Manualne uruchomienie
```bash
# Z panelu admin
POST /admin/shops/:id/sync

# Bezpośrednio (dev)
curl -X POST http://localhost:3001/admin/shops/{shopId}/sync \
  -H "Authorization: Bearer {token}"
```

### Service: `syncShopOrders(shopId)`
Lokalizacja: `src/services/shop-sync.service.ts`

Obsługuje:
- Idempotencję (check by external_order_id)
- Rate limiting do API platform
- Error handling i retry
- Logowanie do `sync_logs`

## 🎨 Render Pipeline

### Obecny stan
- ✅ PNG generowane w przeglądarce klienta (Fabric.js)
- ✅ Upload PNG: `POST /personalization/:token/upload-preview`
- ✅ PDF do druku generowany asynchronicznie przez BullMQ worker
- ✅ `layoutOverrides` merge'owane z layoutem przy finalnym renderze

### Docelowa architektura
1. Klient klika "Zatwierdź" → `POST /personalization/:token/submit`
2. API tworzy `RenderJob` w kolejce (BullMQ)
3. **Worker** pobiera job i renderuje PDF
4. PDF zapisany w storage: `{orderId}/v{version}/final.pdf`
5. Status case: SUBMITTED → READY_FOR_PRINT

## 🛠️ Development

### Komendy
```bash
# Dev z hot-reload
pnpm dev

# Build produkcyjny
pnpm build
pnpm start

# Linting
pnpm lint
pnpm lint:fix

# Testy
pnpm test
pnpm test:watch
```

**Uwaga:** pokrycie testami nadal jest niepełne; krytyczne flow są priorytetem na kolejny etap.

### Struktura kodu
```
api/src/
├── index.ts              # Entry point, server Fastify
├── lib/
│   └── prisma.ts         # Singleton Prisma Client
├── routes/
│   ├── auth.routes.ts    # Auth endpoints
│   ├── admin/            # Admin endpoints
│   └── public/           # Public endpoints
├── services/
│   ├── auth.service.ts   # Logika JWT
│   ├── shop-sync.service.ts  # Synchronizacja
│   └── admin/            # Admin services
├── middleware/
│   ├── auth.middleware.ts    # JWT verification
│   └── error-handler.ts      # Global error handler
├── schemas/
│   ├── auth.schema.ts    # Zod schemas
│   └── admin.schema.ts
├── types/
│   └── index.ts          # TypeScript types
└── utils/
    └── logger.ts         # Pino logger
```

### Hot-reload
API używa `tsx watch` - automatyczny restart przy zmianach w `src/`.

### Docker logs
```bash
# Wszystkie kontenery
docker-compose logs -f

# Tylko API
docker-compose logs -f api

# Tylko PostgreSQL
docker-compose logs -f postgres
```

## 🧪 Testing

### Health check
```bash
curl http://localhost:3001/health
```

### Login test
```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kreatywne-papierki.pl","password":"admin123"}'
```

### Dane testowe
Po `pnpm prisma:seed`:
- Admin: `admin@kreatywne-papierki.pl` / `admin123`
- Seller: `seller@kreatywne-papierki.pl` / `seller123`

## 📝 Coding Standards

- TypeScript strict mode
- ESLint + Prettier
- Conventional Commits
- Async/await (nie callbacks)
- Error handling: try/catch + global handler

---

**Zobacz też:** [../README.md](../README.md) - Główny README systemu
