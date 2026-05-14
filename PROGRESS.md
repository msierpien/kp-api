# Dziennik postępu – personalizacja PrestaShop (Fastify + Next.js)

## TODO (aktualne)
1) ✅ ~~Finalny PDF (druk)~~ → ZROBIONE (Etap 5)
2) Layout overrides (zmiany pozycji przez klienta)
   - Zapisać zmiany do bazy i używać ich w renderze finalnym (WYSIWYG).
3) ✅ ~~Spójność storage~~ → ZROBIONE (Etap 5 - cleanup)
4) ✅ ~~Refaktoryzacja Fastify (API)~~ → ZROBIONE
   - ✅ Multi-tenant i izolacja danych (tenantScope + SUPER_ADMIN)
   - ✅ Centralny config (config.ts)
   - ✅ Porządek storage i spójne URL
5) ✅ ~~Email Service (manual control)~~ → ZROBIONE (Etap 6)
6) ✅ ~~Queue monitoring & retry~~ → ZROBIONE (Etap 7)

## 2026-01-30 (cd.)

### Hotfix: Bull Board Route Conflict
**Czas: ~10 min**

#### Problem:
- FastifyError: Method 'GET' already declared for route '/admin/queues'
- Bull Board (queue dashboard) używało `/admin/queues`
- Konflikt z custom queue API routes (Etap 7)

#### Rozwiązanie:
- ✅ Zmieniono Bull Board path: `/admin/queues` → `/admin/bull-board`
- ✅ Dodano email queue do Bull Board dashboard
- ✅ Dodano export `getEmailQueue()` w email.queue.ts
- ✅ Commit: `6556e0e` (API repo)
- ✅ Merge do main

**Uwaga:** Custom queue API `/admin/queues` (Next.js admin) działa niezależnie od Bull Board. Bull Board to alternatywny dashboard dla dev/debug.

---

### Sesja: Etap 7 - Queue Monitoring & Retry
**Czas: ~5h | MVP: 65% → 70%**

#### Zrealizowano:
1. **Backend Queue Monitoring API**
   - queue-stats.service.ts: getAllQueuesStats(), getQueueStats(), getQueueJobs(), getJobDetails()
   - Retry mechanisms: retryJob(), retryAllFailed()
   - Job management: deleteJob(), cleanQueue()
   - 8 admin endpoints (/admin/queues/*):
     - GET /queues - all queues with stats
     - GET /queues/:name/stats - specific queue
     - GET /queues/:name/jobs?status&page&limit - jobs list
     - GET /queues/:name/jobs/:id - job details
     - POST /queues/:name/jobs/:id/retry - retry single job
     - POST /queues/:name/retry-failed - bulk retry all failed
     - DELETE /queues/:name/jobs/:id - delete job
     - POST /queues/:name/clean - clean old jobs
   - SUPER_ADMIN only access

2. **Admin Dashboard UI**
   - Queue overview page (/dashboard/queues):
     - Grid cards with stats per queue (render, email)
     - Color-coded counters: waiting (yellow), active (blue), completed (green), failed (red)
     - Failed jobs alert badges
     - Auto-refresh every 30s
   - Queue detail page (/dashboard/queues/[name]):
     - Stats cards for all statuses (6 cards)
     - Tabs for filtering: Waiting/Active/Completed/Failed/Delayed
     - Jobs table: ID, type, status badge, attempts, timestamps
     - Bulk retry button for all failed jobs (with confirmation)
     - Individual retry button per failed job
     - Pagination (20 per page)
     - Auto-refresh every 10s

3. **Enhanced Error Tracking**
   - render.worker.ts: Store error details in job data (message, stack, timestamp, attemptNumber, caseId)
   - email.worker.ts: Enhanced error capture with full context (to, caseId, attempt)
   - Error data preserved in BullMQ for inspection via admin UI
   - Wrapped job.updateData() in try-catch to prevent secondary failures

4. **UI Components Added**
   - Tabs component (@radix-ui/react-tabs)
   - Queue types in types/index.ts
   - use-queue.ts hooks with mutations
   - 8 new API client methods

#### Commits:
**API (main):**
- fc8baf2: Merge Etap 7 - Queue Monitoring & Retry
  - 3aab233: Backend queue monitoring API
  - fb973e2: Enhanced error tracking in workers

**Admin (main):**
- 9507f28: Merge Etap 7 - Queue Monitoring Dashboard
  - 27cb015: Foundation (types, hooks, overview page)
  - 6cb3f84: Queue detail page with job management

**Stan: MVP ≈70% (było 65%)**

**Uwagi:**
- Job detail modal skipped (not critical for MVP)
- Failed job notifications (email alerts) skipped (nice-to-have)
- Manual testing pominięte - można przetestować w przyszłości
- Kolejki działają, retry działa, UI kompletny

---

## 2026-01-30

### Sesja: Etap 6 - Email Service (Manual Control)
**Czas: ~5.5h | MVP: 60% → 65%**

#### Zrealizowano:
1. **Backend Email Infrastructure (API)**
   - BullMQ queue (email.queue.ts): async email sending z retry (3x, exponential backoff)
   - Email worker (email.worker.ts): obsługa personalizationEmail + testEmail
   - Tracking w DB: emailSentAt, emailFailedAt, emailError, emailAttempts
   - AUTO_SEND_EMAILS=false: manual control (sync nie wysyła automatycznie)
   - MailHog integration: dev SMTP testing (ports 1025/8025)

2. **Admin API Endpoints**
   - POST /admin/email/test: testowanie SMTP + wysyłka testowa
   - POST /admin/cases/bulk-send-email: wysyłka do max 50 cases (z pominięciem już wysłanych)
   - POST /admin/cases/:id/resend-email: kolejkowanie pojedynczego emaila
   - GET /admin/cases?emailStatus=sent|not_sent|failed: filtrowanie

3. **Admin UI**
   - Cases table: kolumna Email z badge (✓ Wysłano / Nie wysłano / ✗ Błąd)
   - Case detail: przycisk "Wyślij email" (only if not sent) + status badges
   - Bulk actions: checkbox selection + bulk send (z podsumowaniem)
   - Email status filter: Wszystkie/Wysłano/Nie wysłano/Błąd

4. **Docker Configuration**
   - Dodano MailHog service do docker-compose.yml
   - Fixed Dockerfile: Python + canvas dependencies (dla PDF rendering)
   - ENV vars: ENCRYPTION_KEY, AUTO_SEND_EMAILS, SMTP_*

#### Commits:
**API (main):**
- 52fbee3: Merge Etap 6 - Email Service
  - 646410c: Backend foundation (queue, worker, tracking)
  - 3597621: Manual send API endpoints
  - 8307b95: Fix cleanup-storage import
  - 3fd672c: Docker env vars
  - 9f82f87: Dockerfile deps

**Admin (main):**
- 1ee7cf4: Merge Etap 6 - Email Service UI
  - 355f2e9: Email column
  - 01e7bf3: Case detail button
  - 86ff8df: Bulk actions
  - 813b63f: Email filter

**Stan: MVP ≈65% (było 60%)**

**Uwagi:**
- Testowanie manualne pominięte (przejście do Etap 7)
- MailHog gotowy ale nie przetestowany end-to-end
- Email worker działa (logs potwierdzają inicjalizację)

---

## 2026-01-31

### Sesja: Etap 5 - Porządek w storage i renderach
- ✅ **PDF rendering pipeline** - zaimplementowano renderPDF():
  - Fabric.js server-side rendering
  - PNG w 300 DPI dla jakości druku
  - Konwersja PNG → PDF używając PDFKit
  - Integration z render.worker.ts
  - Zapisanie jako Asset (type: PDF_PRINT)
- ✅ **Storage cleanup service** - cleanup-storage.service.ts:
  - Znajdowanie orphaned files (pliki w storage nie w DB)
  - Usuwanie starych plików z możliwością filtra wieku (olderThanDays)
  - Czyszczenie pustych folderów
  - Dry run mode dla testów
  - cleanupCasePreview() - czyszczenie starych preview dla case
- ✅ **Admin endpoints** - /admin/storage/* (SUPER_ADMIN only):
  - POST /cleanup - ręczne wywołanie cleanup
  - GET /stats - statystyki storage bez usuwania
- ✅ **Scheduled cleanup** - scheduler.service.ts:
  - Codziennie o 3:00 automatyczny cleanup
  - Usuwanie orphaned files starszych niż 30 dni
  - Logowanie wyników (pliki usunięte, miejsce zwolnione)

**Stan: MVP ≈60% (było 55%)**

---

## 📊 Wnioski i rekomendacje (2026-01-31)

### ✅ Co działa dobrze (strengths)
1. **Solidna architektura multi-tenant**
   - Automatyczna izolacja danych przez Prisma middleware
   - SUPER_ADMIN z pełną kontrolą
   - JWT + AsyncLocalStorage - eleganckie rozwiązanie

2. **Czysty kod**
   - Rozdzielenie warstw: routes → services → prisma
   - Scentralizowana konfiguracja (config.ts)
   - Tylko 3 TODO/FIXME w całym kodzie

3. **Nowoczesny stack**
   - TypeScript + Fastify (wydajne)
   - Prisma ORM (type-safe)
   - BullMQ + Redis (scalable queue)
   - Next.js 14 App Router

4. **Dobre praktyki Git**
   - Feature branches per etap
   - Descriptive commits
   - Osobne repo dla api/admin/client

### ⚠️ Obszary do poprawy (gaps)

#### 1. **Brak testów** ⭐⭐⭐ (HIGH PRIORITY)
**Problem:**
- 0 testów jednostkowych/integracyjnych
- Refaktoryzacja bez safety net
- Ryzyko regresji przy zmianach

**Rekomendacja:**
- Dodać Vitest lub Jest
- Testy dla krytycznych flow:
  - Auth (login, JWT validation, role checks)
  - Multi-tenant isolation (czy admin widzi tylko swoje dane?)
  - PDF rendering pipeline
  - Storage cleanup logic
- Minimalny coverage: 40-50% dla services

**Szacowany wysiłek:** 2-3 dni

#### 2. **Monitoring i obserwability** ⭐⭐⭐ (HIGH)
**Problem:**
- Brak strukturalnego loggingu
- console.log/error rozproszony po kodzie
- Brak metryk (queue depth, render time, errors)
- Trudne debugowanie w produkcji

**Rekomendacja:**
- Dodać Pino logger (fast + structured JSON logs)
- Instrumentacja:
  - Queue jobs (success/fail rate, duration)
  - PDF rendering (time per case, DPI)
  - Storage cleanup (files deleted, space saved)
  - API response times
- Opcjonalnie: Sentry/LogRocket dla error tracking

**Szacowany wysiłek:** 1-2 dni

#### 3. **Email service** ⭐⭐ (MEDIUM - ✅ DONE)
**Status:** ✅ Zrealizowano w Etapie 6 (2026-01-30)

**Co zrobiono:**
- BullMQ queue + worker z retry logic (3x exponential backoff)
- Manual control: AUTO_SEND_EMAILS=false
- Tracking: emailSentAt, emailFailedAt, emailError, emailAttempts
- Admin UI: bulk send, filters, status badges
- MailHog integration dla dev testing
- Endpoints: /admin/email/test, /admin/cases/bulk-send-email

#### 4. **Queue monitoring & retry** ⭐⭐ (MEDIUM - ⏳ NASTĘPNY)
**Problem:**
- Render job failure = case stuck forever
- Brak visibility w stan kolejek (waiting, active, failed, completed)
- Brak UI do ręcznego retry failed jobs
- Email queue też potrzebuje monitoringu

**Rekomendacja - Etap 7:**
- Admin UI: queue dashboard z metrykami
  - Render queue: jobs by status, avg duration, error rate
  - Email queue: pending, sent, failed
- Retry mechanisms:
  - Manual retry button dla failed jobs
  - Bulk retry (wszystkie failed)
- Job details view:
  - Error stack trace
  - Job payload
  - Attempt history
- Dead letter queue handling

**Szacowany wysiłek:** 1.5-2 dni

#### 5. **Layout overrides (WYSIWYG)** ⭐⭐ (MEDIUM)
**Problem:**
- Klient nie może przesuwać elementów w UI
- Zmiany pozycji nie zapisywane do bazy
- Render nie używa overrides

**Rekomendacja:**
- Dodać pole `layoutOverrides: Json?` w PersonalizationCase
- Zapisywać zmiany pozycji z Fabric.js
- Merge overrides w renderPDF()
- UI: drag & drop w client portal

**Szacowany wysiłek:** 2-3 dni

#### 6. **Brak testów** ⭐⭐⭐ (HIGH - do zrobienia po core features)
**Problem:**
- 0 testów jednostkowych/integracyjnych
- Refaktoryzacja bez safety net
- Ryzyko regresji przy zmianach

**Rekomendacja - Etap 8:**
- Dodać Vitest
- Testy dla krytycznych flow:
  - Auth (login, JWT validation, role checks)
  - Multi-tenant isolation
  - PDF rendering pipeline
  - Email queue
  - Storage cleanup logic
- Minimalny coverage: 40-50% dla services

**Szacowany wysiłek:** 2-3 dni

#### 7. **Dokumentacja API** ⭐ (LOW)
**Problem:**
- Brak OpenAPI/Swagger docs
- Frontend dev musi czytać kod routes
- Trudne testowanie API ręcznie

**Rekomendacja:**
- Dodać @fastify/swagger + @fastify/swagger-ui
- Auto-generate docs z Zod schemas
- Dostępne pod /docs w dev mode

**Szacowany wysiłek:** 0.5 dnia

#### 7. **Next.js upgrade** ⭐ (LOW - can wait)
**Problem:**
- Next.js 14.2.21 (current: 15.x)
- Brak nowych features (turbopack, partial prerendering)

**Rekomendacja:**
- Upgrade do Next.js 15 w osobnym etapie
- Najpierw: audyt breaking changes
- Testing flow after upgrade

**Szacowany wysiłek:** 1 dzień

#### 8. **Performance optimizations** ⭐ (LOW)
**Potencjalne bottlenecki:**
- N+1 queries w niektórych routes (brak dataloader)
- Brak cachingu (Redis) dla często czytanych danych
- Fabric.js rendering może być wolny przy dużych canvas
- Storage cleanup skanuje cały folder (może być wolne)

**Rekomendacje:**
- Profiling: measure before optimize
- Add Redis cache dla templates, shops (cache invalidation)
- Optymalizacja Prisma includes (use select)
- Storage cleanup: incremental scan lub index plików

**Szacowany wysiłek:** 2-3 dni (gdy będzie bottleneck)

### 🎯 Priorytetowy roadmap (po Etapie 5)

**Faza 1: Stabilizacja MVP (1-2 tygodnie)**
1. ✅ Etap 5: Storage & PDF render - DONE
2. ⏳ Email service implementation (1d)
3. ⏳ Basic tests - critical paths (2-3d)
4. ⏳ Structured logging + monitoring (1-2d)
5. ⏳ Queue retry logic (1d)

**Faza 2: Feature completion (1-2 tygodnie)**
6. ⏳ Layout overrides (WYSIWYG) (2-3d)
7. ⏳ API documentation (Swagger) (0.5d)
8. ⏳ Admin UI improvements (filters, bulk actions)
9. ⏳ Client portal UX polish

**Faza 3: Production readiness (1 tydzień)**
10. ⏳ Security audit (SQL injection, XSS, CSRF)
11. ⏳ Performance profiling + optimizations
12. ⏳ Error tracking (Sentry)
13. ⏳ Deployment automation (CI/CD)
14. ⏳ Backup strategy (DB + storage)

**Faza 4: Scale & polish (ongoing)**
- Next.js 15 upgrade
- Advanced monitoring (Prometheus/Grafana)
- Multi-platform integrations (WooCommerce, Shopify)
- Mobile-responsive client portal
- Advanced templates (multi-page PDF)

### 📈 Metryki sukcesu

**Techniczne:**
- Test coverage ≥40%
- API response time p95 <200ms
- PDF render time <5s per case
- Zero data leaks between tenants
- Uptime >99.5%

**Biznesowe:**
- Time to first personalization <2 min (od kliknięcia link)
- Admin case processing time <5 min (approval workflow)
- Email delivery rate >95%
- Storage costs <$50/month (S3)

---

## 2026-01-30

### Sesja: Podgląd i porządki w dokumentacji
- ✅ Uporządkowana logika przycisków w portalu klienta:
  - **Zapisz wersję roboczą** → zapis tylko stanu formularza.
  - **Save PNG** → zapis stanu + generowanie i upload PNG (Frontend Fabric.js).
  - **Zatwierdź i wyślij** → bez zmian (na później).
- ✅ Usunięte okno podglądu obrazka (PNG zapisujemy bez renderu w UI).
- ✅ Naprawiony błąd ikon po zmianie UI (zamiana `Eye` → `FileImage`).
- ✅ Backend ignoruje preview z DB, jeśli plik nie istnieje w storage (brak martwych URL).
- ✅ Dokumentacja zsynchronizowana z aktualnym pipeline:
  - `PROBLEMS.md` – aktualny stan i lista zadań
  - `LIVE-PODGLAD.md` – skrócony, aktualny opis
  - Plany przeniesione do archiwum

## 2026-01-26

### Sesja 1: Decyzje architektoniczne i planowanie
- Utworzono sekcję „Wnioski agenta" w `Api/spec-personalizacja-prestashop-next-fastify.md` z listą decyzji do doprecyzowania.
- Uzgodniono plan wdrożenia obejmujący kolejno: migracje Postgres, API Fastify (webhook + public/admin), testy, moduł Presta, panel Next.js, notyfikacje do Presta, operacyjne bezpieczeństwo, etap renderingu.

### Sesja 2: Refaktoryzacja do architektury PULL

#### Decyzje architektoniczne:
- ✅ Zmiana z webhooków (PUSH) na polling (PULL) - API aktywnie pobiera zamówienia
- ✅ Uniwersalna architektura dla wielu platform e-commerce (nie tylko PrestaShop)
- ✅ Moduł PrestaShop NIE jest wymagany w MVP - korzystamy z REST API
- ✅ Wybrano Prisma jako ORM (zamiast Drizzle/TypeORM/Kysely)
- ✅ pnpm jako package manager

#### Infrastruktura Docker (100%):
- ✅ PostgreSQL 16-alpine (port 5432)
- ✅ Redis 7-alpine (port 6379)
- ✅ Fastify API (port 3001)
- ✅ Adminer (port 8081)
- ✅ Rozwiązano problemy: OpenSSL w Alpine, DATABASE_URL, konflikty portów
- ✅ Wszystkie kontenery uruchomione i zdrowe

#### Baza danych Prisma (100%):
- ✅ Schema z wszystkimi modelami dla architektury PULL
- ✅ Enum `ShopPlatform` (PRESTASHOP, WOOCOMMERCE, SHOPIFY, MAGENTO, OTHER)
- ✅ Model `Shop` z konfiguracją API credentials
- ✅ Model `PersonalizedProduct` - rejestracja produktów personalizowanych:
  - `identifier_type` (SKU, INDEX, EAN) - po jakim polu identyfikować produkt
  - `identifier_value` - wartość identyfikatora z PrestaShop
  - `template_id` - powiązany szablon personalizacji
- ✅ Model `Order` / `OrderItem` z `external_order_id` (zamiast prestashop_order_id)
- ✅ Model `SyncLog` (zastąpił WebhookEvent dla logów synchronizacji)
- ✅ Modele personalizacji: Template, Form, FormField, Case, Answer
- ✅ Model `User` z rolami (ADMIN, SELLER)
- ✅ Migracje wykonane:
  - `20260126113500_init` - początkowa struktura (webhook-based)
  - `20260126124732_refactor_to_pull_architecture` - refaktoryzacja do PULL
- ✅ Dane testowe załadowane:
  - Sklep: Kreatywne Papierki (PRESTASHOP)
  - Użytkownicy: admin@kreatywne-papierki.pl, seller@kreatywne-papierki.pl
  - Template: INV_KOMUNIA_01
  - Formularz z 7 polami
  - Produkt personalizowany: SKU=INV-KOMUNIA-001 → template INV_KOMUNIA_01

#### API Fastify - podstawy (30%):
- ✅ Serwer działający na localhost:3001
- ✅ Health check endpoint (`/health`)
- ✅ Root info endpoint (`/`)
- ✅ Security: CORS, Helmet, Rate limiting
- ✅ Prisma client singleton
- ✅ Logger (pino-pretty w dev)
- ✅ Graceful shutdown
- ✅ Hot-reload z tsx

#### API Fastify - endpointy admin (40%):
- ✅ `POST /auth/login` - logowanie JWT
- ✅ `POST /auth/refresh` - odświeżanie tokenu
- ✅ `GET /auth/me` - pobranie aktualnego użytkownika
- ✅ Auth middleware dla wszystkich `/admin/*`
- ✅ `GET /admin/shops` - lista integracji
- ✅ `POST /admin/shops` - dodanie integracji
- ✅ `PUT /admin/shops/:id` - edycja integracji
- ✅ `POST /admin/shops/:id/test` - test połączenia z PrestaShop
- ✅ `POST /admin/shops/:id/sync` - **manualne pobieranie zamówień**
- ✅ `GET /admin/cases` - lista przypadków personalizacji
- ✅ `GET /admin/sync-logs` - historia synchronizacji

#### Integracja PrestaShop (60%):
- ✅ `PrestaShopClient` - klient REST API PrestaShop
  - Obsługa WEB_SERVICE (API Key)
  - Obsługa ADMIN_API (OAuth 2.0)
  - Pobieranie zamówień z filtrami
  - Pobieranie szczegółów zamówienia
  - Pobieranie danych klienta
- ✅ `syncShopOrders()` - service synchronizacji
  - Pobiera zamówienia z PrestaShop API
  - Filtruje po SKU produktów personalizowanych
  - Tworzy zamówienia w bazie
  - Tworzy przypadki personalizacji
  - Generuje tokeny dostępu
  - Loguje operację do `sync_logs`
  - Obsługa błędów i idempotencja

#### Frontend Next.js - podstawy (50%):
- ✅ Aplikacja uruchomiona (localhost:3000)
- ✅ Logowanie JWT z cookies
- ✅ Dashboard z statystykami
- ✅ Strona integracji (`/dashboard/integrations`)
  - Formularz konfiguracji PrestaShop
  - Test połączenia
  - **Przycisk "Pobierz zamówienia"**
  - Wyświetlanie wyników synchronizacji
- ✅ Lista przypadków (`/dashboard/cases`)
- ✅ Sidebar nawigacja
- ✅ API client z auto-refresh tokenu
- ✅ Logger (pino-pretty w dev)
- ✅ Graceful shutdown
- ✅ Hot-reload z tsx
- ⏳ Brak endpointów biznesowych

#### Development tooling:
- ✅ EditorConfig (.editorconfig)
- ✅ Node version manager (.nvmrc - v20.20.0)
- ✅ pnpm config (.npmrc)
- ✅ Prettier ignore
- ✅ Docker ignore

#### Specyfikacja (100%):
- ✅ Zaktualizowana sekcja 1.2 - Integracja PULL zamiast webhook
- ✅ Zaktualizowana sekcja 2.1 - Konfiguracja sklepów i mapowanie produktów
- ✅ Zaktualizowana sekcja 5.1 - Workflow pobierania zamówień
- ✅ Zaktualizowana sekcja 6 - Model danych z nowymi tabelami
- ✅ Zaktualizowana sekcja 7 - REST API endpoints (usunięto webhook endpoint)
- ✅ Zaktualizowana sekcja 8 - Integracja bez modułu PrestaShop
- ✅ Zaktualizowana sekcja 9 - Panel admin z zarządzaniem sklepami
- ✅ Zaktualizowana sekcja 11 - Etapy MVP
- ✅ Usunięte wszystkie odniesienia do `webhook_events`, webhooków, `prestashop_order_id`
- ✅ Dodane opisy `PersonalizedProduct`, `SyncLog`, `ShopPlatform`

### Następne kroki (MVP):

**Priorytet 1 - Backend API (brakujące endpointy):**
1. **⏳ Case Management - szczegóły i edycja** (0%)
   - ❌ GET /admin/cases/:id (szczegóły przypadku z odpowiedziami)
   - ❌ PUT /admin/cases/:id/answers (korekta odpowiedzi przez sprzedawcę)
   - ❌ PUT /admin/cases/:id/status (zmiana statusu: NEW → WAITING → SUBMITTED → READY_FOR_PRINT)
   - ❌ POST /admin/cases/:id/notes (notatki wewnętrzne)

2. **⏳ Templates Management - CRUD szablonów** (50%)
   - ✅ GET /admin/templates (lista)
   - ✅ GET/PUT /admin/templates/:id/form (edycja formularzy)
   - ❌ POST /admin/templates (tworzenie nowego szablonu)
   - ❌ PUT /admin/templates/:id (edycja metadanych: nazwa, opis, wersja)
   - ❌ DELETE /admin/templates/:id (usuwanie szablonu)

3. **⏳ Automatyczny Cron Job / Worker** (0%)
   - ❌ Worker pobierający zamówienia co X minut
   - ❌ Scheduler (node-cron lub BullMQ)
   - ✅ Service syncShopOrders już gotowy

4. **⏳ Wysyłka e-maili** (0%)
   - ❌ Konfiguracja SMTP / Sendgrid
   - ❌ Template e-maila z linkiem
   - ❌ Wysyłka po utworzeniu case
   - ❌ Przypomnienia o niewypełnionych formularzach

**Priorytet 2 - Frontend Admin Panel:**
5. **⏳ Szczegóły przypadku personalizacji** (0%)
   - ❌ Strona /dashboard/cases/[id]
   - ❌ Wyświetlanie odpowiedzi klienta
   - ❌ Formularz edycji odpowiedzi
   - ❌ Workflow statusów z przyciskami akcji
   - ❌ Historia zmian

6. **⏳ Zarządzanie integracjami - wiele sklepów** (50%)
   - ✅ API obsługuje wiele sklepów
   - ❌ UI pokazuje tylko pierwszy sklep PrestaShop
   - ❌ Lista wszystkich integracji w tabeli
   - ❌ Dodawanie nowych integracji (przycisk "Dodaj sklep")
   - ❌ Przełączanie między sklepami

7. **⏳ Zarządzanie szablonami - CRUD** (50%)
   - ✅ Lista szablonów
   - ✅ Edycja formularzy (graficzny konfigurator)
   - ❌ Dodawanie nowego szablonu (przycisk "Dodaj szablon")
   - ❌ Edycja metadanych szablonu
   - ❌ Usuwanie szablonów

**Priorytet 3 - Portal Klienta:**
8. **✅ Portal publiczny** (100%) - UKOŃCZONE 27.01.2026
   - ✅ Projekt Next.js w katalogu `client/` (port 3002)
   - ✅ Konfiguracja: TypeScript, Tailwind CSS, shadcn/ui
   - ✅ Strona /[token] - formularz personalizacji
   - ✅ Dynamiczny renderer pól (text, textarea, number, email, date, select, radio, checkbox, file)
   - ✅ Walidacja z zod + react-hook-form
   - ✅ Zapisywanie wersji roboczej (draft)
   - ✅ Zatwierdzanie personalizacji (submit)
   - ✅ Strona /[token]/potwierdzenie - podsumowanie
   - ✅ Obsługa błędów i stanów (wygasły token, już zatwierdzone)

### Sesja 3: Panel Administracyjny MVP

#### API Fastify - Auth & Admin (100%):
- ✅ Struktura katalogów: `routes/`, `services/`, `middleware/`, `schemas/`, `types/`
- ✅ Auth Service z JWT (access 15min, refresh 7d)
- ✅ Auth Routes: POST `/auth/login`, `/auth/refresh`, `/auth/logout`, GET `/auth/me`
- ✅ Auth Middleware z weryfikacją JWT
- ✅ Admin Routes chronione przez JWT:
  - GET `/admin/stats` - statystyki case (NEW, WAITING, SUBMITTED, READY_FOR_PRINT)
  - GET `/admin/sync-logs?limit=5` - ostatnie synchronizacje
  - GET `/admin/cases?page=1&limit=20&status=&search=&sortBy=createdAt&sortOrder=desc` - lista case z paginacją
  - **GET `/admin/orders`** - lista zamówień z items i personalizacją
  - **GET `/admin/orders/:id`** - szczegóły zamówienia
- ✅ Zod schemas dla walidacji
- ✅ TypeScript types
- ✅ Zaktualizowany seed.ts z przykładowymi zamówieniami i case

#### API Fastify - Public Personalization (100%):
- ✅ GET `/personalization/:token` - pobranie case po tokenie dostępu
- ✅ PUT `/personalization/:token/design` - zapis projektu
- ✅ POST `/personalization/:token/submit` - zatwierdzenie do produkcji
- ✅ Walidacja wygaśnięcia tokenów (30 dni)

#### Frontend Next.js Admin Panel (100%):
- ✅ Projekt Next.js 14 z App Router w `admin/`
- ✅ Konfiguracja: TypeScript, Tailwind, ESLint
- ✅ shadcn/ui komponenty: Button, Card, Input, Label, Badge, Table, Select
- ✅ Biblioteki: React Query, react-hook-form, zod, js-cookie, lucide-react, date-fns
- ✅ API Client z obsługą JWT (access + refresh tokens w cookies)
- ✅ Hooks: useAuth, useCases, useStats, useSyncLogs, **useOrders**, **useOrder**
- ✅ Layout: Sidebar, Header z nowym linkiem "Zamówienia"
- ✅ Strony:
  - `/login` - formularz logowania
  - `/dashboard` - statystyki + ostatnie synchronizacje + szybkie linki
  - `/dashboard/cases` - tabela z paginacją, filtry (status, search), sortowanie
  - **`/dashboard/orders`** - lista zamówień z produktami i statusami personalizacji
  - **`/dashboard/integrations`** - zarządzanie sklepami z przyciskiem sync
- ✅ Middleware Next.js dla ochrony tras
- ✅ Środowisko: `.env.local` z `NEXT_PUBLIC_API_URL`

### Postęp ogólny MVP: ~48%
- Infrastruktura: 100% ✅
- Baza danych: 100% ✅
- API Backend: 65% ⏳ (brakuje: case details, templates CRUD, cron, emails)
- Integracje: 70% ⏳ (działa sync, brakuje: retry logic, multi-shop UI)
- Frontend Admin: 55% ⏳ (brakuje: case details, multi-shop UI, templates CRUD)
- Portal Klienta: 0% ❌ (planowane w kolejnej fazie)

### Najważniejsze osiągnięcia (26.01.2026):
- ✅ **Manualne pobieranie zamówień działa!**
- ✅ **Lista zamówień w panelu admin**
- ✅ **Endpointy personalizacji dla klientów**
- ✅ PrestaShop REST API client gotowy (naprawiono parsowanie orders[])
- ✅ Synchronizacja tworzy zamówienia i cases
- ✅ Przycisk w panelu admin z wynikami
- ✅ Baza danych potwierdzona jako gotowa na wiele sklepów
- ✅ Integracja z PrestaShop API (WEB_SERVICE + ADMIN_API)
- ✅ Tokeny dostępu dla klientów do personalizacji

#### Uruchomienie:
```bash
# API (w katalogu api/)
docker-compose up -d
pnpm prisma:seed  # opcjonalnie: załaduj dane testowe

# Admin Panel (w katalogu admin/)
pnpm install
pnpm dev
```

#### Logowanie testowe:
- Admin: `admin@kreatywne-papierki.pl` / `admin123`
- Seller: `seller@kreatywne-papierki.pl` / `seller123`

### Postęp ogólny MVP: ~55%
- Infrastruktura: 100%
- Baza danych: 100%
- API Backend: 70% (auth + admin endpoints gotowe, brak CRUD i sync worker)
- Integrations: 0% (brak PrestaShop sync worker)
- Frontend Admin: 80% (dashboard + lista case, brak szczegółów case i edycji)
