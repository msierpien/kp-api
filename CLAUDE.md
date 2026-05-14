# CLAUDE.md

Wskazówki dla Claude Code (claude.ai/code) podczas pracy z kodem w tym repozytorium.

## 📊 Status projektu (2026-01-30)

### ✅ Zaimplementowane (MVP ~55%)

**Backend API (70%):**
- ✅ Auth JWT (access + refresh tokens)
- ✅ CRUD integracji (shops)
- ✅ CRUD produktów personalizowanych
- ✅ Synchronizacja zamówień (manualny + API)
- ✅ Case Management (lista, szczegóły, edycja, statusy, notatki)
- ✅ Templates & Forms (CRUD)
- ✅ Public endpoints (personalizacja przez token)
- ⏳ Cron job do synchronizacji - TODO
- ⏳ Email service - TODO
- ⏳ Render PDF worker - TODO

**Admin Panel (80%):**
- ✅ Dashboard z statystykami
- ✅ Case Management (lista, szczegóły, workflow)
- ✅ Integracje (zarządzanie sklepami, test połączenia, sync)
- ✅ Produkty personalizowane
- ✅ Graficzny konfigurator szablonów
- ✅ Logi synchronizacji
- ⏳ Multi-tenant UI - TODO

**Portal Klienta (100%):**
- ✅ Formularz personalizacji (dynamiczny)
- ✅ Zapisywanie draftu
- ✅ Generowanie PNG (Fabric.js)
- ✅ Upload preview
- ✅ Zatwierdzenie finalne

**Integracja PrestaShop (70%):**
- ✅ PrestaShopClient (REST API)
- ✅ Sync service (pobieranie zamówień)
- ✅ Logowanie do sync_logs
- ⏳ Automatyczny cron job - TODO
- ⏳ Retry logic - TODO

## 🎯 Priorytetowe zadania

1. **Multi-tenant refaktoryzacja** (Etap 2)
   - Dodanie modelu `Tenant`
   - Izolacja danych per sprzedawca
   - Middleware z `tenantId`

2. **Cron Job** (MVP must-have)
   - Automatyczna synchronizacja zamówień co X minut
   - Scheduler (node-cron lub BullMQ)

3. **Email Service** (MVP must-have)
   - Konfiguracja SMTP
   - Wysyłka linków do personalizacji
   - Template e-maili

4. **Render PDF Worker** (Etap 3)
   - Kolejka BullMQ
   - Worker z Puppeteer/Playwright
   - Storage S3-compatible

## 📚 Dokumentacja

- **[README.md](README.md)** - główny README systemu
- **[PROGRESS.md](PROGRESS.md)** - dziennik postępu (historia sesji)
- **[REFRAKTORYZACJA.md](REFRAKTORYZACJA.md)** - plan refaktoryzacji etapowej
- **[spec-personalizacja-prestashop-next-fastify.md](spec-personalizacja-prestashop-next-fastify.md)** - pełna specyfikacja techniczna
- **[api/README.md](api/README.md)** - backend API (endpointy, konfiguracja)
- **[admin/README.md](admin/README.md)** - panel admin (funkcje, troubleshooting)
- **[client/README.md](client/README.md)** - portal klienta (UI flow)

## 🏗️ Stos technologiczny

- **API Backend:** TypeScript + Fastify (port 3001)
- **ORM:** Prisma
- **Baza danych:** PostgreSQL 16
- **Cache/Queue:** Redis 7 + BullMQ
- **Auth:** JWT (access 15min, refresh 7d)
- **Admin Panel:** Next.js 14 (App Router) + React Query + shadcn/ui
- **Portal Klienta:** Next.js 14 + Fabric.js
- **Package Manager:** pnpm (wymagany!)

## 📊 Status MVP: ~55%
- Infrastruktura: 100% ✅
- Baza danych: 100% ✅
- API Backend: 70% ⏳
- Admin Panel: 80% ⏳
- Portal Klienta: 100% ✅
- Integracje: 70% ⏳

---

**Więcej:** Zobacz [README.md](README.md) i [PROGRESS.md](PROGRESS.md)
