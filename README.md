# Kreatywne Papierki API

Backend Fastify dla systemu obslugi sklepow, magazynu, zamowien i personalizacji zaproszen. API jest wielotenantowe: jedna instalacja obsluguje wiele firm, a dane sa izolowane przez `tenantId`.

## Srodowiska

- Produkcyjne API: `https://api.kreatywne-papierki.pl`
- Swagger: `https://api.kreatywne-papierki.pl/docs`
- Lokalne API: `http://localhost:3001`
- Sklep PrestaShop Kreatywnych Papierkow: `https://kp.kreatywneparty.pl`
- PrestaShop Webservice: `https://kp.kreatywneparty.pl/api`

Panel admina i portal klienta zawsze lacza sie z Fastify przez `NEXT_PUBLIC_API_URL`. Adres sklepu PrestaShop jest zapisywany tylko w konfiguracji integracji sklepu.

## Wersjonowanie i zgodnosc z panelem

API i panel admina maja osobne wersje aplikacji oraz wspolny numer kontraktu API.

Aktualnie:

- API: `1.1.3`
- wymagany minimalny admin: `0.2.0`
- kontrakt API/admin: `2`
- profil zgodnosci: `kp-admin-api`

Zrodla wersji w API:

- `package.json` - wersja pakietu backendu.
- `src/services/ops/version.service.ts` - wersja zwracana przez runtime, kontrakt, minimalny admin i profil zgodnosci.
- `GET /version` - publiczny odczyt wersji API dla panelu i smoke testow.
- `GET /health` - zwraca status uslug oraz ten sam blok `version`.

Zasady podbijania wersji:

- `PATCH`, np. `1.1.2 -> 1.1.3`: poprawki bledow, wydajnosci, dokumentacji runtime albo zachowania kompatybilnego wstecz.
- `MINOR`, np. `1.1.x -> 1.2.0`: nowe endpointy, nowe pola odpowiedzi lub nowe funkcje bez lamania istniejacego panelu.
- `MAJOR`, np. `1.x -> 2.0.0`: zmiana wymagajaca migracji klienta, usuniecie endpointu lub zmiana semantyki niekompatybilna wstecz.

Numer kontraktu (`API_CONTRACT_VERSION`) jest niezalezny od wersji aplikacji. Zmieniaj go tylko wtedy, gdy obecny panel nie moze bezpiecznie pracowac z nowym API albo nowe API nie moze obslugiwac starego panelu. Nie podbijaj kontraktu dla zmian addytywnych, poprawek wydajnosci, nowych widokow opartych o nowe endpointy ani zmian UI.

Po wdrozeniu sprawdz:

```bash
curl -fsS https://api.kreatywne-papierki.pl/version
curl -fsS https://api.kreatywne-papierki.pl/health
```

Panel powinien pokazac w sidebarze status `Zgodne`, np. `Admin v0.2.3 · API v1.1.3 · kontrakt 2`.

## Start lokalny

Wymagania:

- Node.js 20+
- pnpm 9+
- PostgreSQL 16
- Redis 7

Docker:

```bash
cd api
cp .env.example .env
docker-compose up -d
docker-compose exec api pnpm prisma migrate dev
docker-compose exec api pnpm prisma:seed
```

Bez Dockera:

```bash
cd api
pnpm install
pnpm prisma generate
pnpm prisma migrate dev
pnpm prisma:seed
pnpm dev
```

Najwazniejsze skrypty:

```bash
pnpm dev
pnpm build
pnpm deploy:prod
pnpm prisma:migrate
pnpm prisma:migrate:deploy
pnpm prisma:seed
```

## Model systemu

### Tenanty i uprawnienia

`Tenant` reprezentuje firme korzystajaca z systemu. Uzytkownicy maja role `SUPER_ADMIN`, `ADMIN` albo `OPERATOR`.

- `SUPER_ADMIN` zarzadza firmami, uzytkownikami i globalnymi operacjami.
- `ADMIN` i `OPERATOR` pracuja w ramach swojego tenanta.
- Middleware admina filtruje dostep po `tenantId`.

Funkcje opcjonalne sa przechowywane w `Tenant.featuresJson`. Modul personalizacji zaproszen jest kontrolowany flaga:

```json
{
  "personalization_editor": true
}
```

Dla firm bez tej flagi endpointy personalizacji zwracaja `403`, a sync zamowien nie tworzy case'ow personalizacji.

### Magazyn i produkty sklepu

Magazyn jest zrodlem prawdy dla fizycznych produktow:

- `WarehouseCatalog` porzadkuje katalogi produktow.
- `WarehouseProduct` opisuje produkt magazynowy, ceny i stan.
- `WarehouseProductBarcode` przechowuje EAN-y i przeliczniki opakowan.
- `WarehouseDocument` i `WarehouseDocumentItem` obsluguja dokumenty `PZ`, `PW`, `WZ`, `RW`.

Produkty ze sklepow nie tworza osobnej logiki produktowej. Laczy je model:

```text
ShopProductMapping
  shop product SKU/EAN/id
  -> WarehouseProduct
```

Mapowanie jest wykorzystywane przez import produktow, synchronizacje zamowien, stock sync, price sync i personalizacje.

Szczegolowy opis magazynu jest w `warehouse.md`.

### Personalizacja zaproszen

Personalizacja jest opcja na zmapowanym produkcie sklepu, nie osobnym produktem.

```text
ShopProductMapping
  personalizationEnabled
  personalizationTemplateId
```

Przeplyw:

1. Produkt sklepu jest importowany i mapowany do `WarehouseProduct`.
2. Admin wybiera mapowanie i przypisuje `PersonalizationTemplate`.
3. Sync zamowien znajduje `ShopProductMapping` dla pozycji zamowienia.
4. Jesli mapping ma wlaczona personalizacje i szablon, API tworzy `PersonalizationCase`.
5. Klient wypelnia formularz przez publiczny link.
6. Worker renderuje pliki wynikowe dla druku.

Model `PersonalizedProduct` zostaje jako legacy fallback dla starych danych i migracji, ale nowy panel przypisuje szablony przez `ShopProductMapping`.

### Zamowienia i kolejki

Zamowienia sa synchronizowane z integracji sklepow. API tworzy:

- `Order` i `OrderItem`;
- dokumenty magazynowe dla pozycji zmapowanych do magazynu;
- `PersonalizationCase` tylko dla pozycji z aktywna personalizacja;
- logi synchronizacji i zadania kolejek.

BullMQ obsluguje m.in. renderowanie, e-mail, stock sync i price sync. Panel admina ma osobne widoki do monitorowania i retry kolejek.

## Glowne grupy endpointow

Publiczne:

- `GET /health`
- `GET /personalization/:token`
- `PUT /personalization/:token/design`
- `POST /personalization/:token/upload-preview`
- `POST /personalization/:token/preview`
- `POST /personalization/:token/submit`

Auth:

- `POST /auth/login`
- `POST /auth/refresh`
- `GET /auth/me`

Admin:

- `/admin/stats`
- `/admin/cases`
- `/admin/orders`
- `/admin/shops`
- `/admin/shop-mappings`
- `/admin/templates`
- `/admin/fonts`
- `/admin/render-jobs`
- `/admin/queues`
- `/admin/sync-logs`
- `/admin/storage`
- `/admin/tenants`
- `/admin/users`
- `/admin/warehouse/*`
- `/admin/wholesale/*`

Pelna dokumentacja techniczna endpointow jest generowana w Swaggerze pod `/docs`.

## Storage

Pliki sa zapisywane w `api/storage`.

```text
storage/
  fonts/
  templates/
    {templateCode}/
      background/
  {orderId}/
    v{templateVersion}/
      preview.png
      final.pdf
      assets/
```

Publiczne pliki sa serwowane przez `GET /storage/*`.

## Migracje i baza

Tworzenie migracji developerskiej:

```bash
pnpm prisma migrate dev --name nazwa_migracji
```

Wdrozenie produkcji przez Docker po pobraniu zmian z git:

```bash
pnpm deploy:prod
```

Skrypt `scripts/deploy.sh` robi `git pull --ff-only`, buduje obrazy `api` i `migrate`, uruchamia migracje Prisma w jednorazowym kontenerze, restartuje `api`, `worker` i `scheduler`, a na koncu sprawdza `/health`.

Jesli zmiany zostaly juz pobrane recznie:

```bash
SKIP_GIT_PULL=1 pnpm deploy:prod
```

Seed:

```bash
pnpm prisma:seed
```

Seed tworzy domyslnego tenanta Kreatywne Papierki, konta testowe, integracje, szablony i przykladowe dane potrzebne do pracy developerskiej.

## Konfiguracja

Najwazniejsze zmienne:

- `DATABASE_URL`
- `REDIS_URL`
- `API_URL`
- `FRONTEND_URL`
- `CLIENT_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `ENCRYPTION_KEY`
- `AUTO_SEND_EMAILS`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

Pelna lista znajduje sie w `.env.example`.

## Weryfikacja

Przed commitem uruchom:

```bash
pnpm build
```

Dla zmian w Prisma build generuje klienta Prisma automatycznie. Przy zmianach w migracjach sprawdz rowniez, czy `pnpm prisma migrate dev` przechodzi na lokalnej bazie.

## Dokumentacja w repo

- `README.md` - aktualny opis backendu.
- `warehouse.md` - zrodlo prawdy dla modulu magazynowego.
- Swagger `/docs` - aktualne endpointy API.

Stare dzienniki postepu i plany refaktoryzacji nie sa trzymane w repo jako dokumentacja operacyjna.
