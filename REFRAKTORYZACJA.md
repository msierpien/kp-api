# Plan refaktoryzacji (kontrolowany, etapowy)

## Założenia
- Refaktoryzacja przebiega etapami z **jasnym kryterium zakończenia**.
- Każdy etap ma **osobny branch** i **osobny commit** (lub serię commitów w ramach etapu).
- Po zakończeniu etapu: **merge do main** i krótki opis zmian.

## Standard pracy z Git

**Uwaga:** Każda aplikacja (`api/`, `admin/`, `client/`) ma **własne repozytorium Git**.

1) Utwórz branch dla etapu **w odpowiednim repozytorium**:
```bash
cd api  # lub admin / client
git checkout -b refactor/<nazwa-etapu>
```
2) Pracuj w małych krokach, commituj logiczne części.
3) Po zakończeniu etapu:
```bash
git status
git add -A
git commit -m "refactor: <krótki opis etapu>"
git checkout main
git merge refactor/<nazwa-etapu>
```

**Przykład - refaktoryzacja API:**
```bash
cd api
git checkout -b refactor/multi-tenant-model
# ... zmiany w kodzie ...
git add prisma/schema.prisma src/
git commit -m "refactor(api): dodanie modelu Tenant i izolacji danych"
git checkout main
git merge refactor/multi-tenant-model
```

## Etapy refaktoryzacji (propozycja)

### Etap 1: Porządek dokumentacji
**Cel:** Jeden spójny opis stanu projektu i jedno źródło prawdy.
**Kryterium zakończenia:**
- README w `api/`, `admin/`, `client/` aktualne.
- `PROGRESS.md` zawiera aktualne TODO.
- Stare/nieaktualne pliki MD usunięte.

### Etap 2: Multi-tenant (model danych)
**Cel:** Wprowadzenie `Tenant` i izolacja danych.
**Zakres:**
- Prisma: model `Tenant`, `tenantId` w kluczowych tabelach.
- Migracja danych do default tenant.
**Kryterium zakończenia:** Migracja działa i aplikacja startuje bez błędów.

### Etap 3: Multi-tenant (API i auth)
**Cel:** Filtry po `tenantId` we wszystkich endpointach admin.
**Zakres:**
- JWT z `tenantId`
- Middleware w API (automatyczny filtr Prisma)
**Kryterium zakończenia:** Admin nie widzi danych innych sprzedawców.

### Etap 4: Super Admin (API + UI)
**Cel:** Widoki i endpointy do zarządzania sprzedawcami.
**Zakres:**
- `/admin/tenants`, `/admin/users`
- widoki w panelu admin dla Super Admina
**Kryterium zakończenia:** Super Admin zarządza tenantami i użytkownikami.

### Etap 5: Porządek w storage i renderach
**Cel:** Brak martwych URL + przygotowanie pod finalny PDF.
**Zakres:**
- polityka usuwania preview
- docelowy pipeline renderu PDF
**Kryterium zakończenia:** Storage spójny, brak martwych preview.

---

## Notatki
Jeśli etap wymaga migracji bazy lub zmian w API, warto dodać krótką checklistę w commit message lub PR.

---

# Plan refaktoryzacji Next.js (admin + client)

## Stan wejściowy
- `admin` i `client` używają **Next.js 14.2.21**.
- Rozważany upgrade do **Next.js 16**.

## Etap A: Audyt i stabilizacja
**Cel:** przed upgradem uporządkować podstawy.
- Ujednolicić `NEXT_PUBLIC_API_URL` i fallbacki w obu aplikacjach.
- Wydzielić wspólne typy DTO do `shared/` (opcjonalnie).
- Spiąć obsługę błędów i loadingów (jedna warstwa).
**Kryterium:** brak ostrzeżeń w `next build` i spójne zachowanie UI.

## Etap B: Upgrade Next.js 14 → 16
**Cel:** podnieść wersję bez regresji.
1) Zaktualizować `next`, `eslint-config-next` w `admin` i `client`.
2) Uruchomić `pnpm install`, potem `pnpm build`.
3) Poprawić ostrzeżenia / breaking changes.
4) Upewnić się, że `react`/`react-dom` są zgodne z wymaganiami Next 16.
**Kryterium:** buildy `admin` i `client` przechodzą bez błędów.

## Etap C: Refaktor struktury Next.js
**Cel:** lepsza czytelność i spójność.
- Podział layoutów (np. `app/(auth)` i `app/(dashboard)`).
- Wydzielenie warstwy API (np. `lib/apiClient.ts` + interceptory).
- Wspólne komponenty UI i spójne wzorce formularzy.
**Kryterium:** mniej duplikacji i łatwiejsza praca nad UI.

## Etap D: Testy krytycznych flow
**Cel:** zabezpieczyć refaktor.
- Logowanie, lista case, edycja, Save PNG w portalu klienta.
**Kryterium:** kluczowe flow bez regresji.

---

# Plan refaktoryzacji Fastify (API)

## Etap F1: Multi-tenant i izolacja danych
**Cel:** zabezpieczenie danych sprzedawców.
- Middleware `tenantScope` doklejający `tenantId` do zapytań.
- Guard roli `SUPER_ADMIN` (pełny dostęp).
**Kryterium:** admin nie widzi danych innego sprzedawcy.

## Etap F2: Warstwa danych (services/repositories)
**Cel:** odchudzić routes.
- Logika przeniesiona do `services/` lub `repositories/`.
- Jedno miejsce dla include/select w Prisma.
**Kryterium:** routes bez ciężkiej logiki.

## Etap F3: Walidacje i błędy
**Cel:** spójne schema i error handling.
- Ujednolicić walidację (Zod/JSON schema).
- Centralny handler błędów.
**Kryterium:** spójne odpowiedzi błędów w API.

## Etap F4: Storage i assets
**Cel:** stabilne URL i brak martwych plików.
- Jedna funkcja budowania URL storage.
- Spójna obsługa braku pliku.
**Kryterium:** brak 404 dla istniejących assetów.

## Etap F5: Queue i render worker
**Cel:** przewidywalny pipeline renderów.
- Wydzielenie logiki update statusów i metadanych.
- Spójne retry/logowanie.
**Kryterium:** stabilne joby i spójne statusy case.

## Etap F6: Config i env
**Cel:** porządek konfiguracji.
- Centralny `config.ts` zamiast rozproszonych `process.env`.
**Kryterium:** brak rozproszonych konfiguracji.
