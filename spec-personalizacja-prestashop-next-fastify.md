# Specyfikacja techniczna (instrukcje dla agenta AI)
## Aplikacja do personalizacji zaproszeń z integracją PrestaShop 9

**Cel:** Zbudować system, który odbiera zamówienia z PrestaShop 9, wykrywa produkty personalizowane, udostępnia klientowi formularz personalizacji (MVP: przez link w e-mailu), zapisuje odpowiedzi, pozwala klientowi zatwierdzić (blokada edycji), a sprzedawcy umożliwia korekty w panelu admin przed drukiem. Docelowo: generowanie podglądu PDF/PNG (asynchronicznie).

---

## Aktualny stan (2026-01-30)
- Podgląd PNG generowany **w kliencie** (Fabric.js → PNG) i uploadowany do API.
- Przycisk **Save PNG** zapisuje stan + zapisuje PNG w storage (`POST /personalization/:token/upload-preview`).
- Endpoint `POST /personalization/:token/preview` **nie renderuje PNG** – służy do walidacji i zwraca istniejący preview, jeśli jest w storage.
- Finalny PDF do druku **nie jest jeszcze zaimplementowany** (renderPDF w workerze = TODO).

---

## 1. Decyzje architektoniczne (ustalone)

### 1.1 Stos technologiczny
- **API (backend):** TypeScript + **Fastify**, uruchomione na **VPS**
- **Frontend (panel admin):** **Next.js** na **Vercel Free**
- **Baza danych:** PostgreSQL (na VPS)
- **Cache / kolejki (docelowo, szczególnie pod rendering):** Redis (na VPS)
- **Storage plików (docelowo PDF/PNG):** **S3-compatible** (np. Cloudflare R2 / Wasabi / AWS S3)
- **API styl:** **REST-only** (bez GraphQL)

### 1.2 Integracja z e-commerce (PrestaShop / inne)
- **API pobiera zamówienia** z platformy e-commerce (PULL, nie webhook)
- **Cron job / worker** w API sprawdza nowe zamówienia co X minut
- **Identyfikacja produktów personalizowanych**: porównanie atrybutów produktu z zarejestrowanymi w bazie:
  - **SKU (reference)** - np. `INV-KOMUNIA-001`
  - **Index (supplier_reference)** - np. `TEMPLATE_KOMUNIA`
  - **EAN (ean13)** - np. `5901234567890`
  - Admin rejestruje produkty personalizowane w panelu (sklep + identyfikator + template)
- **Uniwersalna architektura**: możliwość dodania innych platform (WooCommerce, Shopify, etc.)

### 1.2a Wielu sprzedawców (multi-tenant)
- System jest **multi-tenant**: wielu sprzedawców (tenantów) w jednej instalacji.
- Każdy sprzedawca ma **własne integracje, klientów, zamówienia i case**.
- Wymagana **izolacja danych**: brak możliwości podglądu danych innych sprzedawców.

### 1.3 Dostęp klienta (MVP + etap 2)
- **MVP:** API wysyła e-mail z linkiem do personalizacji (token w URL)
- Portal personalizacji poza sklepem
- **Etap 2 (później):** formularz w koncie klienta w sklepie (opcjonalnie)
- Dodatkowa opcja bezpieczeństwa: po podaniu numeru zamówienia klient może otrzymać **PIN/hasło na e-mail** (opcjonalna dodatkowa weryfikacja).

### 1.4 Podgląd PDF/PNG
- **MVP (aktualnie):** PNG generowane w przeglądarce klienta i uploadowane do API.
- **Docelowo:** PDF/PNG generowane asynchronicznie (kolejka + worker/renderer na VPS) i zapisywane w S3.

### 1.5 Model personalizacji
- Personalizacja jest **per pozycja zamówienia** (order item).
- Obsługa **list powtarzalnych** (np. lista gości).
- Lista gości ma domyślnie **dokładnie N rekordów**, gdzie **N = quantity** zakupionej pozycji (bez dodawania/usuwania w MVP).

### 1.6 Workflow zatwierdzania
- Klient zatwierdza → dane są blokowane dla klienta.
- Sprzedawca może w panelu admin wprowadzić korektę przed drukiem.

### 1.7 Statusy do PrestaShop
- Aplikacja odsyła status przez **notatkę do zamówienia** oraz (opcjonalnie) zmianę statusu zamówienia w PrestaShop.

---

## 2. Zakres funkcjonalny

### 2.1 MVP (must-have)
1. **Konfiguracja sklepów e-commerce (Integracje)**
   - dodanie sklepu (PrestaShop / inne) z API credentials
   - test połączenia i status integracji
2. **Produkty personalizowane (zakładka Personalizacje)**
   - rejestracja produktu: sklep + identyfikator (SKU/index/EAN) + template
   - konfiguracja formularza personalizacji dla każdego produktu
2. **Pobieranie zamówień z platformy (PULL)**
   - cron job / worker sprawdza nowe zamówienia co X minut
   - filtrowanie po SKU produktów personalizowanych
   - idempotencja - sprawdzanie czy zamówienie już istnieje
3. **Tworzenie przypadków personalizacji (`cases`)**
   - tworzenie case per personalizowana pozycja
   - generacja tokenu dostępu (hash w DB)
   - wysłanie e-maila z linkiem do personalizacji
4. **Portal klienta**
   - wejście przez link z tokenem
   - formularz personalizacji per case
   - walidacje podstawowe (required/min/max/regex)
   - auto-generowanie listy gości: N wpisów = quantity
   - zatwierdzenie (blokada edycji dla klienta)
   - **Save PNG**: zapis stanu + upload PNG do storage
5. **Panel admin (Next.js)**
   - lista przypadków, filtrowanie po statusie, zamówieniu, dacie
   - podgląd odpowiedzi klienta
   - edycja odpowiedzi (korekta sprzedawcy)
   - zmiana statusów (np. APPROVED / READY)
   - konfiguracja sklepów i mapowania produktów
6. **Powiadomienia do sklepu e-commerce**
- Formularz w koncie klienta sklepu (integracja głębsza)
- Obsługa innych platform e-commerce (WooCommerce, Shopify, Magento)cji (MVP)
   - opcjonalnie zmiana statusu zamówienia

### 2.2 Funkcje przyszłe (should-have)
- Formularz w koncie klienta Presta (moduł + API)
- AI walidacja/ulepszanie treści
- Render PDF/PNG, kontrola fontów, layout DTP, warstwy, grafiki
- Wersjonowanie i “zamrażanie” layoutu renderowania

---

## 3. Role i uprawnienia

### 3.1 Role
- **Customer (public)** – dostęp wyłącznie do własnych case przez token
- **Admin / Seller** – dostęp do panelu admin i konfiguracji, korekty danych
- **Super Admin** – zarządza sprzedawcami (tenantami), widzi wszystkie dane i ma osobne widoki w panelu

**Zakres Super Admin (propozycja widoków i akcji):**
- **Tenants / Sprzedawcy**
  - lista sprzedawców (status, plan, limity, data utworzenia)
  - tworzenie / edycja / dezaktywacja sprzedawcy
  - przypisanie domen / subdomen (opcjonalnie)
- **Użytkownicy**
  - lista użytkowników w tenantach
  - reset hasła / wymuszenie zmiany hasła
  - nadawanie roli Admin/Seller
- **Integracje**
  - podgląd integracji per sprzedawca (sklepy, API)
  - blokada/odblokowanie integracji
- **Monitoring**
  - globalne statystyki: liczba case, renderów, błędy
  - logi synchronizacji i renderów (globalnie)
- **Podszywanie się (impersonation)**
  - wejście do panelu sprzedawcy w trybie tylko do odczytu (opcjonalnie)

### 3.2 Autoryzacja
- Public: token w URL (hashowany w DB), TTL = do zatwierdzenia case
- Admin: logowanie (konto + role) – wymagane w MVP

### 3.3 Izolacja danych (multi-tenant)
- Każdy request w panelu admin **musi** być filtrowany po `tenantId`.
- Publiczne tokeny muszą wskazywać case tylko w obrębie tego samego sprzedawcy.
- Zalecany model danych: `Tenant` (sprzedawca) + relacje do `User`, `Shop`, `Order`, `PersonalizationCase`.
- Middleware w API pobiera `tenantId` z JWT i dokłada filtr do zapytań Prisma.

---

## 3A. Proponowany model multi-tenant (szczegóły)

### 3A.1 Modele (schemat)
**Tenant (sprzedawca)**
- `id`, `name`, `status`, `plan`, `limitsJson`, `createdAt`, `updatedAt`

**User**
- dodać `tenantId` (FK → Tenant)
- dodać `role`: `SUPER_ADMIN | ADMIN | SELLER`

**Shop**
- dodać `tenantId` (FK → Tenant)

**Order / OrderItem / PersonalizationCase / Asset / RenderJob**
- dodać `tenantId` (FK → Tenant) lub zapewnić relację po `order.shop.tenantId`

### 3A.2 Minimalny zestaw tabel z `tenantId`
- `users`, `shops`, `orders`, `personalization_cases`, `assets`, `render_jobs`

---

## 3B. Endpointy dla Super Admina (propozycja)

### Tenants
- `GET /admin/tenants` – lista sprzedawców
- `POST /admin/tenants` – utworzenie sprzedawcy
- `PUT /admin/tenants/:id` – edycja danych
- `POST /admin/tenants/:id/disable` – dezaktywacja
- `POST /admin/tenants/:id/enable` – aktywacja

### Użytkownicy (globalnie)
- `GET /admin/users?tenantId=...`
- `POST /admin/users`
- `PUT /admin/users/:id`
- `POST /admin/users/:id/reset-password`

### Integracje / monitoring
- `GET /admin/tenants/:id/shops`
- `GET /admin/tenants/:id/stats`
- `GET /admin/tenants/:id/sync-logs`
- `GET /admin/tenants/:id/render-jobs`

---

## 3C. Plan wdrożenia multi-tenant (migracja)

1) **Prisma schema**
   - dodać `Tenant`
   - dodać `tenantId` do kluczowych tabel
2) **Migracja danych**
   - utworzyć `Tenant: default`
   - przypisać wszystkie istniejące rekordy do `default`
3) **JWT i middleware**
   - `tenantId` w tokenie
   - middleware dołączający filtr `tenantId` do zapytań
4) **API**
   - filtrowanie po `tenantId` we wszystkich endpointach admin
   - wyjątek: SUPER_ADMIN (pełny dostęp)
5) **UI Admin**
   - osobne widoki Super Admina
   - wybór sprzedawcy (dla super admina)
6) **Testy bezpieczeństwa**
   - testy izolacji: admin A nie widzi danych admina B

---

## 4. Bezpieczeństwo i wymagania niefunkcjonalne

### 4.1 Tokeny i dostęp klienta
- Token ma być losowy, długi (np. 32+ bajty), w DB przechowywać **tylko hash**
- Token ważny **do momentu zatwierdzenia**; po zatwierdzeniu portal tylko do odczytu (lub całkowita blokada)
- Ochrona przed brute-force:
  - rate limiting na endpointy public
  - blokPobieranie zamówień (PULL) i idempotencja
- **Cron job / worker** sprawdza nowe zamówienia co X minut (np. 5-15 min)
- Pobiera tylko opłacone zamówienia ze sklepu
- Sprawdza czy zamówienie już istnieje w DB (idempotencja po `shop_id + external_order_id`)
- Filtruje pozycje po SKU produktów personalizowanych (mapowanie w DB)
- Rate limiting do API sklepu (max requests/min)

### 4.3 Logi i audyt
- Zapis zmian odpowiedzi (kto: customer/admin/system, kiedy, z jakiego IP)
- Zapis błędów integracji z platformą e-commerce
- Logi pobierania zamówień (timestamp, ilość pobranych, błędy)
- Szyfrowanie API credentials w bazie (api_key, api_secret)

### 4.3 Logi i audyt
- Zapis zmian odpowiedzi (kto: customer/admin/system, kiedy, z jakiego IP)
- Zapis błędów integracji w sync_logs (failed sync, API errors, rate limits)

### 4.4 RODO / dane osobowe
- Minimalizacja danych przechowywanych: snapshot zamówienia tylko w zakresie wymaganym
- Retencja: zaplanować mechanizm archiwizacji/usuwania po określonym czasie (np. 12–24 miesiące) – decyzja później

---

## 5. Workflow biznesowy

### 5.1 Odbiór zamówienia
1. **Cron job** w API sprawdza nowe zamówienia co X minut (np. 5-15 min).
2. API pobiera opłacone zamówienia z **API sklepu e-commerce** (PrestaShop REST API).
3. **Identyfikuje produkty personalizowane** porównując atrybuty produktu z tabeli `personalized_products`:
   - Dla każdej pozycji sprawdza: `reference` (SKU), `supplier_reference` (index), `ean13` (EAN)
   - Szuka dopasowania w tabeli `personalized_products` dla danego sklepu
   - Przykład: pozycja z SKU = `INV-KOMUNIA-001` → pasuje do wpisu `identifier_value="INV-KOMUNIA-001"` → template `INV_KOMUNIA_01`
4. API zapisuje `orders` i `order_items` (snapshot) – tylko zamówienia zawierające produkty personalizowane.
5. API tworzy `personalization_cases` dla każdej personalizowanej pozycji.
6. API generuje tokeny dostępowe (hash do DB).

### 5.2 Dostęp klienta (MVP)
1. PrestaShop wysyła e-mail do klienta z linkiem do personalizacji.
2. Klient wchodzi w link → aplikacja pokazuje listę case w zamówieniu (jeśli wiele) i formularz.
3. Klient uzupełnia, zapisuje, zatwierdza.
4. Po zatwierdzeniu:
   - case przechodzi w status `SUBMITTED/APPROVED` (zależnie od przyjętej nomenklatury)
   - token dla klienta przestaje umożliwiać edycję
   - API wysyła notatkę do zamówienia w Presta: “Personalizacja uzupełniona”

### 5.3 Korekty sprzedawcy
1. Admin widzi case w panelu.
2. Admin może poprawić pola (np. literówki) → zapis do DB z audytem.
3. Admin aktualizuje status (np. `READY_FOR_PRINT`).
4. API odsyła notatkę/status do Presta.

---

## 6. Model danych (PostgreSQL)

### 6.1 Sklepy i integracje

**Wymagane dla multi-tenant:**
- dodać model `Tenant` i pole `tenant_id` w kluczowych tabelach (min. `User`, `Shop`, `Order`, `PersonalizationCase`).
- wszystkie zapytania w panelu admin muszą być ograniczone do `tenant_id`.

**`shops`**
- `id` (PK)
- `name` (nazwa sklepu)
- `platform` (PRESTASHOP, WOOCOMMERCE, SHOPIFY, MAGENTO, OTHER)
- `base_url`
- `api_key` (zaszyfrowane)
- `api_secret` (zaszyfrowane, opcjonalne)
- `status` (ACTIVE, INACTIVE)
- `last_sync_at` (timestamp ostatniego pobrania zamówień)
- `config_json` (dodatkowa konfiguracja specyficzna dla platformy)
- indeksy: `(status)`, `(platform)`

**`personalized_products`** (produkty personalizowane)
- `id` (PK)
- `shop_id` (FK → shops)
- `external_product_id` (ID produktu w sklepie, opcjonalne)
- `name` (nazwa produktu)
- `identifier_type` (ENUM: SKU, INDEX, EAN) - po jakim polu identyfikować
- `identifier_value` (wartość identyfikatora, np. "INV-KOMUNIA-001")
- `template_id` (FK → personalization_templates)
- `is_active` (boolean)
- `created_at`, `updated_at`
- indeksy: `(shop_id, identifier_type, identifier_value)` UNIQUE, `(template_id)`

**Opis:** Każdy produkt w sklepie, który ma być personalizowany, jest zarejestrowany w tej tabeli. Administrator wybiera:
- Sklep (integracja)
- Pole identyfikujące (SKU/reference, index/supplier_reference, EAN)
- Wartość tego pola w PrestaShop
- Szablon personalizacji z formularzem

### 6.2 Zamówienia

**`orders`**
- `id` (PK)
- `shop_id` (FK)
- `external_order_id` (ID zamówienia w sklepie)
- `order_reference` (string, numer widoczny dla klienta)
- `customer_email`
- `customer_name` (opcjonalnie)
- `language` = `pl`
- `currency`
- `total_paid`
- `created_at_shop`
- `payload_json` (snapshot całego zamówienia z API sklepu)
- `synced_at` (kiedy zostało pobrane)
- indeksy: `(shop_id, external_order_id)` UNIQUE, `(shop_id, order_reference)`, `(customer_email)`

**`order_items`**
- `id` (PK)
- `order_id` (FK)
- `external_item_id` (ID pozycji w sklepie)
- `sku` (SKU produktu)
- `product_name_snapshot`
- `quantity`
- `personalized_product_id` (FK nullable; link do mapowania jeśli personalizowane)
- indeks: `(order_id)`, `(sku)`, `(personalized_product_id)`

### 6.3 Synchronizacja / logi

**`sync_logs`** (logi pobierania zamówień)
- `id` (PK)
- `shop_id` (FK)
- `sync_type` (ORDERS, PRODUCTS)
- `status` (SUCCESS, FAILED, PARTIAL)
- `orders_fetched` (ilość pobranych)
- `orders_created` (ilość nowych)
- `orders_skipped` (ilość pominiętych - już istniały)
- `error_message`
- `started_at`
- `finished_at`
- indeks: `(shop_id)`, `(started_at)`

### 6.4 Konfiguracja personalizacji
**`personalization_templates`**
- `id` (PK)
- `code` (unikalny; np. `INV_KOMUNIA_01`)
- `name`
- `description`
- `version` (int)
- `is_active`

**`template_versions`** (jeśli implementujesz pełne wersjonowanie)
- `id` (PK)
- `template_id` (FK)
- `version` (int)
- `schema_json` (snapshot formularzy/pól dla tej wersji)
- `created_at`

**`forms`**
- `id` (PK)
- `template_id` (FK)
- `template_version` (int) – jeśli wersjonujesz na poziomie DB
- `name`
- `sort_order`
- `is_active`

**`form_fields`**
- `id` (PK)
- `form_id` (FK)
- `key` (unikalne w obrębie form)
- `label`
- `type` (text, textarea, select, checkbox, date, time, repeater, upload)
- `required` (bool)
- `min_length`, `max_length`
- `pattern` (regex, nullable)
- `placeholder`
- `help_text`
- `default_value`
- `options_json` (dla select)
- `repeater_group_key` (nullable; np. `guests`)
- `sort_order`
- `validation_rules_json` (opcjonalnie)

### 6.5 Przypadki personalizacji
**`personalization_cases`**
- `id` (PK)
- `order_id` (FK)
- `order_item_id` (FK, unikalne)
- `template_id` (FK)
- `template_version_frozen` (int) – “zamrożona” wersja do tego case
- `status` (NEW / WAITING_FOR_CUSTOMER / SUBMITTED / READY_FOR_PRINT / ARCHIVED)
- `customer_token_hash`
- `token_active` (bool)
- `submitted_at`
- `notes_internal`

**`personalization_answers`**
- `id` (PK)
- `case_id` (FK)
- `field_id` (FK)
- `value_text` (nullable)
- `value_json` (nullable; dla repeaterów)
- `updated_at`
- unikalne: `(case_id, field_id)`

**`personalization_answer_versions`** (audyt)
- `id` (PK)
- `case_id` (FK)
- `changed_by` (CUSTOMER/ADMIN/SYSTEM)
- `changes_json` (diff lub snapshot)
- `created_at`
- `ip`

### 6.6 PIN (opcjonalna dodatkowa weryfikacja)
**`order_access_pins`**
- `id` (PK)
- `order_id` (FK)
- `pin_hash`
- `expires_at`
- `created_at`
- `used_at` (nullable)

### 6.7 Render i pliki (przyszłość)
**`render_jobs`**
- `id` (PK)
- `case_id` (FK)
- `type` (PDF/PNG)
- `status` (NEW/RUNNING/DONE/FAILED)
- `attemCron job / worker (wewnętrzny)
- **Funkcja:** `syncOrders(shop_id)`
  - Pobiera nowe zamówienia z API sklepu
  - Filtruje po SKU personalizowanych produktów
  - Tworzy cases i wysyła e-maile
  - Loguje do `sync_logs`
- `size_bytes`
- `created_at`

---

## 7. REST API – kontrakty (bez kodu)

### 7.1 Cron job / worker synchronizacji zamówień
- **Wewnętrzny proces:** `syncOrders(shop_id)`
  - Uruchamiany automatycznie co X minut (5-15 min)
  - Pobiera nowe zamówienia z API sklepu e-commerce
  - Filtruje po SKU personalizowanych produktów (mapowanie z tabeli `personalized_products`)
  - Tworzy cases dla personalizowanych pozycji
  - Wysyła e-maile z linkami do personalizacji
  - Loguje operację do `sync_logs`
  - Wymaga: shop_id, api_key, api_secret (z tabeli `shops`)

### 7.2 Publiczny portal klienta (MVP)
- `GET /public/orders/{order_reference}`
  - Parametry: `token` w query
  - Zwraca: listę case w zamówieniu + statusy + linki do formularzy
- `GET /public/cases/{case_id}`
- `POST /auth/login` / `POST /auth/refresh` (JWT)
- `GET /admin/cases` (filtry: status, order_reference, data)
- `GET /admin/cases/{case_id}`
- `PUT /admin/cases/{case_id}/answers` (korekta sprzedawcy)
- `PUT /admin/cases/{case_id}/status`
- `GET/POST/PUT/DELETE /admin/shops` (zarządzanie sklepami)
- `GET/POST/PUT/DELETE /admin/personalized-products` (produkty personalizowane)
- `GET /admin/personalized-products/:id/form` (konfiguracja formularza produktu)
- `PUT /admin/personalized-products/:id/form` (aktualizacja formularza)
- `GET /admin/sync-logs` (historia synchronizacji)
- `POST /admin/shops/{shop_id}/sync` (manualne uruchomienie synchronizacji)
- `GET/POST/PUT /admin/personalized-products` (mapowanie SKU → template)
- `GET/PUT /admin/templates` / `/admin/templates/{id}` (konfiguracja szablonów)
- `GET/PUT /admin/forms` / `/admin/fields` (konfiguracja formularzy i pól)
- `GET /admin/sync-logs` (historia synchronizacji)
- `POST /admin/shops/{shop_id}/sync` (manualne wywołanie synchronizacji)

### 7.4 Odsyłanie statusu do sklepu e-commerce
- Mechanizm: API wywołuje API sklepu (PrestaShop Webservice / REST API)
  - weryfikuje PIN i umożliwia sesję

### 7.3 Panel admin (Next.js → API)
- `POST /auth/login` / `POST /auth/refresh` (lub inny mechanizm)
- `GET /admin/cases` (filtry: status, order_reference, data)
- `GET /admin/cases/{case_id}`
- `PUT /admin/cases/{case_id}/answers` (korekta sprzedawcy)
- `PUT /admin/cases/{case_id}/status`
- `GET/PUT /admin/templates` / `/admin/templates/{id}` (konfiguracja szablonów)
- `GET/PUT /admin/forms` / `/admin/fields` (konfiguracja formularzy i pól)

### 7.4 Odsyłanie statusu do PrestaShop
- Mechanizm: API wywołuje PrestaShop Webservice / endpoint modułu (zależnie od implementacji)
- MVP: “notatka do zamówienia” + opcjonalnie zmiana statusu zamówienia.
- Minimalne zdarzenia:
  - “Personalizacja wysłana przez klienta”
  - “Personalizacja gotowa do druku”

---

## 8. Wymagania dla modułu PrestaShop 9 (MVP)

### 8.1 Pole identyfikujące personalizację
**UWAGA:** Ta sekcja opisuje potencjalny moduł PrestaShop, który **NIE jest wymagany w MVP**. 
W MVP system działa bez modułu - używa REST API PrestaShop do pobierania zamówień.

### 8.1 Identyfikacja produktów personalizowanych (bez modułu PrestaShop)
- **Produkty personalizowane rejestrowane w panelu admin API** (tabela `personalized_products`)
- Admin dodaje produkt personalizowany:
  1. Wybiera **sklep/integrację** (z której będą pobierane zamówienia)
  2. Podaje **nazwę produktu** (dla łatwej identyfikacji)
  3. Wybiera **typ identyfikatora**: SKU (reference), index (supplier_reference), EAN (ean13)
  4. Podaje **wartość identyfikatora** (np. "INV-KOMUNIA-001")
  5. Wybiera **szablon personalizacji** z formularzem
- **Jak działa synchronizacja:**
  - Przy pobieraniu zamówień, system sprawdza każdą pozycję
  - Porównuje atrybuty produktu (SKU/index/EAN) z zarejestrowanymi w `personalized_products`
  - Dla pasujących pozycji tworzy przypadek personalizacji
- **Przykład:**
  - Produkt w Presta: SKU = `INV-KOMUNIA-001`
  - Wpis w API: `identifier_type=SKU, identifier_value="INV-KOMUNIA-001", template=INV_KOMUNIA_01`
  - → Pozycje z tym SKU zostaną rozpoznane jako personalizowane

### 8.2 Pobieranie zamówień przez REST API
- API używa PrestaShop REST API do pobierania zamówień
- Filtruje zamówienia zawierające SKU z tabeli `personalized_products`
- Pobiera tylko zamówienia opłacone (current_state = payment accepted)
- Respektuje rate limiting API PrestaShop (1-2 req/sec)

### 8.3 E-mail z linkiem do personalizacji
- **API automatycznie wysyła e-mail** po utworzeniu case
- E-mail zawiera:
  - Link: `/public/cases/{case_id}?token={access_token}`
  - Numer zamówienia
  - Termin wypełnienia
  - Instrukcje dla klienta

---

## 9. Panel admin (Next.js na Vercel)

### 9.1 Funkcje
- Logowanie admin (role)
- **Dashboard:** statystyki synchronizacji, aktywne case
- **Lista case** + filtry (status, sklep, data) + paginacja
- **Widok case:**
  - dane zamówienia (snapshot)
  - pola i odpowiedzi
  - edycja odpowiedzi
  - historia zmian
  - zmiana statusu
- **Konfiguracja sklepów:**
  - lista sklepów (platform, status, ostatnia synchronizacja)
  - dodawanie/edycja sklepu (nazwa, platforma, URL, API credentials)
  - testowanie połączenia z API sklepu
  - manualne uruchomienie synchronizacji
- **Personalizacje (produkty personalizowane):**
  - lista produktów personalizowanych z informacją o sklepie (integracji)
  - dodawanie produktu: wybór sklepu, nazwa, identyfikator (SKU/index/EAN), szablon
  - edycja konfiguracji formularza personalizacji (pola, walidacje)
  - aktywacja/dezaktywacja produktu
- **Logi synchronizacji:**
  - historia operacji sync z filtrami
  - szczegóły błędów
- **Szablony personalizacji:**
  - zarządzanie templates (code, name, aktywność, wersje)
  - formularze i pola (typy pól, walidacje podstawowe)

### 9.2 Integracja z API
- Wszystkie operacje przez REST do VPS.
- Brak wrażliwych sekretów w Vercel (tylko public base URL API + auth przez tokeny admin).

---

## 10. Rendering PDF/PNG (przyszłość – plan)

### 10.1 Zasada + platform, personalized_products, orders, order_items, sync_logs, templates/forms/fields, cases, answers, audit)
2. Fastify API:
   - konfiguracja sklepów (CRUD)
   - konfiguracja produktów personalizowanych (mapowanie SKU → template)
   - cron job / worker do pobierania zamówień
   - integracja z PrestaShop API
   - public portal endpoints (GET/PUT/submit)
   - admin endpoints (auth, cases, answers, status, shops, products)
   - wysyłka e-maili z linkami
3. Next.js admin:
   - logowanie + lista + widok case + edycja + status
   - zarządzanie sklepami
   - zarządzanie mapowaniem produktów
   - logi synchronizacji
4. Notatka do zamówienia w sklepie przy SUBMITTED/READY

### Etap 2 (rozszerzenia)
1. **Moduł PrestaShop (opcjonalnie):**
   - Formularz personalizacji w koncie klienta sklepu
   - Głębsza integracja UI w backoffice PrestaShop
2. **Bezpieczeństwo:**
   - PIN/e-mail verification jako opcja podwyższonego bezpieczeństwa
3. **Inne platformy e-commerce:**
   - Klienty API dla WooCommerce, Shopify, Magento
   - Uniwersalny adapter pattern dla różnych platform
### Etap 1 (MVP)
1. Postgres schema (tabele: shops, personalized_products, orders, order_items, sync_logs, templates/forms/fields, cases, answers, audit)
2. Fastify API:
   - konfiguracja sklepów/integracji (CRUD + credentials)
   - **produkty personalizowane** (sklep + identyfikator SKU/index/EAN + template + formularz)
   - cron job / worker do pobierania zamówień z platform e-commerce
   - klient API dla PrestaShop (możliwość rozszerzenia na inne platformy)
   - public portal endpoints (GET/PUT/submit)
   - admin endpoints (auth, cases, answers, status, shops, personalized-products, sync-logs)
   - wysyłka e-maili z linkami do personalizacji
3. Next.js admin:
   - logowanie + dashboard
   - lista + widok case + edycja + status
   - zarządzanie sklepami/integracjami (CRUD + test connection)
   - **zakładka "Personalizacje"**: lista produktów personalizowanych (sklep, identyfikator, template, formularz)
   - przeglądanie logów synchronizacji
   - manualne uruchomienie sync
4. Integracja z PrestaShop:
   - Bez dedykowanego modułu (korzysta z REST API PrestaShop)
   - Identyfikacja produktów po atrybutach (reference/SKU, supplier_reference/index, ean13/EAN)
   - Notatka do zamówienia przy SUBMITTED/READY

### Etap 2
1. Formularz w koncie klienta w Presta (moduł + API)
2. PIN/e-mail verification jako opcja podwyższonego bezpieczeństwa

### Etap 3
1. Kolejka + worker renderer na VPS
2. Storage S3 + assets + render_jobs
3. PDF/PNG preview i final

---

## 12. Definicje statusów (propozycja)
Architektura integracji
**USTALONE:** System PULL (polling), nie webhook:
- API pobiera zamówienia z platformy e-commerce (cron job co X minut)
- Uniwersalna architektura - możliwość dodania różnych platform
- Konfiguracja produktów personalizowanych w bazie API (mapowanie SKU → template_id)
- API wysyła e-maile samo (pełna kontrola nad komunikacją)

### 14.2 Zdarzenie wyzwalające
**USTALONE:** Tylko zamówienia **opłacone** (status "Payment accepted" w PrestaShop).

### 14.3 Admin auth
**USTALONE:** JWT (access token + refresh token). Role: ADMIN, SELLER.

### 14.4 Przepływ synchronizacji
**USTALONE:**
1. Cron job co X minut (5-15 min) sprawdza nowe zamówienia
2. Pobiera opłacone zamówienia z API sklepu
3. **Identyfikuje produkty personalizowane** porównując atrybuty (SKU/index/EAN) z tabelą `personalized_products`
4. Tworzy cases, generuje tokeny
5. **API wysyła e-mail** z linkiem do personalizacji
6. Loguje operację do `sync_logs`

### 14.5 Do doprecyzowania w trakcie implementacji
- Częstotliwość cron job (5-15 min)
- Rate limiting do API PrestaShop (1-2 req/sec)
- Retencja i TTL: dodać politykę na dane osobowe i maksymalny czas ważności tokenu klienta
- Walidacje pól: zdefiniować domyślne limity długości/regex
- Lista gości = quantity: potrzebna decyzja co przy zmianie quantity po stronie sklepu
**USTALONE:**
- Tylko zamówienia **opłacone** (status "Payment accepted" / "Paid" w PrestaShop)
- API pobiera zamówienia przez REST API (PULL), nie webhook (PUSH)
- Uniwersalna architektura - możliwość obsługi wielu platform e-commerce
- **Identyfikacja produktów po atrybutach** (SKU/reference, index/supplier_reference, EAN) z tabeli `personalized_products`

### 14.2 Admin auth
**USTALONE:** JWT (access token + refresh token). Role: ADMIN, SELLER.

### 14.3 Przepływ wysyłki linku do personalizacji
**USTALONE:**
1. Moduł PrestaShop po złożeniu zamówienia sprawdza, czy zawiera produkty personalizowane
2. Cron job w API pobiera zamówienie z API sklepu
3. API tworzy case, generuje token i **zwraca link** do modułu
4. Moduł może osadzić link w e-mailu (opcja 1) LUB
5. API sam wysyła e-mail z linkiem do klienta (opcja 2 - uproszczenie)

**Preferowane uproszczenie:** API wysyła e-mail sam (mniej integracji w module Presty).

### 14.4 Do doprecyzowania w trakcie implementacji
- Retencja i TTL: dodać politykę na dane osobowe i maksymalny czas ważności tokenu klienta.
- Walidacje pól: zdefiniować domyślne limity długości/regex; przygotować strategię dla pól `upload` (limity MIME/rozmiaru, AV).
- Rate limiting dla API platform e-commerce: retry z exponential backoff w przypadku 429/503.
- Lista gości = quantity: potrzebna decyzja co przy zmianie quantity po stronie Presty (blokada, dostosowanie, migracja danych?).
