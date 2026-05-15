# Plan rozbudowy modułu magazynowego: katalogi produktów i kontrola stanów

> Data aktualizacji: 2026-05-15
> Status: dokument architektoniczny po implementacji backendu Etapu 1: katalogi produktów magazynowych
> Zakres: magazyn, katalogi, dokumenty, stany, EAN/skaner, mapowania sklepów, stock sync, Swagger i proces Git

---

## 1. Cel

Moduł magazynowy ma być centralnym miejscem kontroli fizycznych produktów, stanów i dokumentów magazynowych dla wielu sklepów. Inspirujemy się podejściem BaseLinkera, w którym magazyn nie jest tylko listą stanów, ale ma katalog produktów, a produkty są przypisane do katalogu i dopiero z niego mapowane do sklepów, magazynów oraz integracji.

Najważniejsza zmiana w kolejnym kroku to dodanie warstwy `WarehouseCatalog`:

```text
Tenant
  └── WarehouseCatalog
        └── WarehouseProduct
              ├── WarehouseProductBarcode
              ├── ShopProductMapping
              └── WarehouseDocumentItem
```

Taki podział daje porządek teraz i zostawia miejsce na przyszły moduł produktowy/PIM bez mieszania go z bieżącą logiką magazynu.

---

## 2. Zakres

### Robimy teraz

- Katalog produktów magazynowych jako warstwę nadrzędną nad `WarehouseProduct`.
- Przypisanie każdego produktu magazynowego do jednego katalogu.
- Domyślny katalog dla każdego tenanta i migrację istniejących produktów.
- Filtrowanie produktów po katalogu.
- Rozszerzenie importu/mapowania produktów sklepu o wybór katalogu przy tworzeniu produktu magazynowego.
- Pełne opisanie nowych endpointów w Swagger/OpenAPI.
- Procedurę Git przed implementacją i po implementacji.

### Zostaje w magazynie, bez przebudowy

- `WarehouseProduct` jako produkt fizyczny ze stanem, ceną, jednostką i SKU.
- `ShopProductMapping` jako most produkt sklepu -> produkt magazynowy.
- `WarehouseProductBarcode` z wieloma EAN-ami i `quantityMultiplier`.
- Dokumenty `PZ`, `PW`, `WZ`, `RW` w cyklu `DRAFT` -> `CONFIRMED` -> opcjonalnie `CANCELLED`.
- `currentStock` jako szybki cache stanu, przeliczalny z dokumentów.
- Auto-WZ z zamówień i synchronizacja stanów do sklepów przez kolejkę `stock-sync`.

### Odkładamy na później

- Warianty produktów.
- Bundle/zestawy.
- Zdjęcia, opisy wielojęzyczne i rozbudowane pola produktowe.
- Producent jako pełna domena PIM.
- Pola specyficzne dla marketplace.
- Makra produktowe.
- Fulfillment, rezerwacje, wiele fizycznych magazynów i lokalizacje półkowe.

---

## 3. Stan obecny repo

Na 2026-05-15 w repo są już wdrożone kluczowe elementy magazynu:

- `WarehouseProduct` z `purchasePrice`, `retailPrice` i `currentStock`.
- Dokumenty magazynowe `PZ`, `PW`, `WZ`, `RW`.
- Audyt dokumentów: kto utworzył, zatwierdził i anulował dokument.
- Transakcyjna numeracja dokumentów z PostgreSQL advisory lock.
- Ochrona przed ujemnym stanem przez `limitsJson.warehouse.allowNegativeStock`.
- `ShopProductMapping` jako most między produktem sklepu i produktem magazynowym.
- Import produktów z PrestaShop do mapowań.
- Tworzenie produktu magazynowego z mapowania.
- EAN-y i skaner z obsługą wielu kodów na produkt oraz przelicznika opakowań.
- Auto-WZ z zamówień jako `DRAFT`, z opcjonalnym auto-confirm.
- `StockSyncLog`, kolejka `stock-sync` i worker synchronizacji stanów do PrestaShop.
- Endpoint rekalibracji cache `currentStock`.
- Swagger pod `/docs` przez `src/plugins/swagger-docs.plugin.ts`.

Etap 1 wdrożony po dodaniu katalogów:

- model `WarehouseCatalog`;
- `WarehouseProduct.catalogId`;
- migracja tworząca katalog domyślny per tenant i przypisująca istniejące produkty;
- endpointy `/admin/warehouse/catalogs`;
- filtrowanie produktów po `catalogId`;
- `catalogId` w `POST/PUT /admin/warehouse/products`;
- rozszerzenie `createWarehouseProductFromMapping()` o opcjonalny `catalogId`;
- tag `warehouse-catalogs` i schema w Swagger/OpenAPI.

Do domknięcia poza backendiem `kp-api`:

- widok katalogów w panelu admina;
- filtr katalogu na liście produktów w panelu;
- wybór katalogu przy tworzeniu produktu z panelu i z mapowania sklepu.

---

## 4. Inspiracje z BaseLinkera

Źródła:

- [BaseLinker `addInventory`](https://api.baselinker.com/index.php?method=addInventory)
- [BaseLinker `addInventoryProduct`](https://api.baselinker.com/index.php?method=addInventoryProduct)
- [BaseLinker `getInventoryProductsList`](https://api.baselinker.com/index.php?method=getInventoryProductsList)
- [BaseLinker `addInventoryDocument`](https://api.baselinker.com/index.php?method=addInventoryDocument)
- [BaseLinker `updateInventoryProductsStock`](https://api.baselinker.com/index.php?method=updateInventoryProductsStock)

| Koncepcja z BaseLinkera | Co przenosimy do kp-api | Decyzja |
|---|---|---|
| Inventory/catalog jako kontener produktów | `WarehouseCatalog` | Przenosimy teraz |
| Produkt przypisany do katalogu | `WarehouseProduct.catalogId` | Przenosimy teraz |
| Lista produktów z filtrami po SKU, EAN, nazwie, kategorii/katalogu, stocku | Rozszerzone `GET /admin/warehouse/products` | Przenosimy częściowo teraz |
| EAN dodatkowy z ilością | `WarehouseProductBarcode.quantityMultiplier` | Już wdrożone |
| Dokument magazynowy tworzony jako draft i dopiero zatwierdzany wpływa na stan | `WarehouseDocument.status` | Już wdrożone |
| Bulk aktualizacja stanów | `stock-sync` z logami i bieżącym `currentStock` | Już wdrożone w podstawie |
| Ceny per price group | Na teraz `retailPrice` i `purchasePrice`; price groups później | Odkładamy |
| Wielu producentów, warianty, bundle, zdjęcia, pola integracji | Przyszły moduł produktowy/PIM | Odkładamy |
| Rezerwacje i wiele magazynów | Przyszła rozbudowa magazynu | Odkładamy |

Ważna decyzja: nie kopiujemy całego modelu BaseLinkera. Bierzemy tylko te elementy, które wzmacniają magazyn bez uruchamiania pełnego PIM-a.

---

## 5. Docelowy model domeny

### `WarehouseCatalog`

Katalog jest logiczną kolekcją produktów magazynowych w ramach jednego tenanta. Dla Kreatywnych Papierków może to być na przykład:

- `default` - katalog główny;
- `zaproszenia`;
- `akcesoria`;
- `materialy`;
- `testowy-import-prestashop`.

W v1 produkt należy do jednego katalogu. Jeśli w przyszłości pojawi się potrzeba tagów lub wielu katalogów na produkt, dodamy relację wiele-do-wielu bez przebudowy dokumentów magazynowych.

Proponowany model Prisma:

```prisma
model WarehouseCatalog {
  id          String   @id @default(cuid())
  tenantId    String   @map("tenant_id")
  code        String
  name        String
  description String?
  isDefault   Boolean  @default(false) @map("is_default")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  tenant   Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products WarehouseProduct[]

  @@unique([tenantId, code])
  @@index([tenantId])
  @@index([tenantId, isActive])
  @@map("warehouse_catalogs")
}
```

Zmiany w `Tenant`:

```prisma
warehouseCatalogs WarehouseCatalog[]
```

Zmiany w `WarehouseProduct`:

```prisma
catalogId String @map("catalog_id")
catalog   WarehouseCatalog @relation(fields: [catalogId], references: [id], onDelete: Restrict)

@@index([catalogId])
```

### Reguły biznesowe katalogów

- Każdy tenant musi mieć dokładnie jeden aktywny katalog domyślny.
- `WarehouseProduct.catalogId` jest wymagane po migracji.
- Jeśli API tworzy produkt bez `catalogId`, używa katalogu domyślnego tenanta.
- Nie można usunąć katalogu domyślnego.
- Nie można usunąć katalogu, który ma produkty.
- Dezaktywacja katalogu nie dezaktywuje produktów, ale blokuje tworzenie nowych produktów w tym katalogu.
- Zmiana katalogu produktu nie zmienia stanów ani dokumentów. To tylko klasyfikacja katalogowa.

---

## 6. Migracja danych

Migracja powinna być bezpieczna dla istniejących danych:

1. Utworzyć tabelę `warehouse_catalogs`.
2. Dla każdego tenanta utworzyć katalog domyślny:

```text
code = "default"
name = "Katalog główny"
isDefault = true
isActive = true
```

3. Dodać `catalog_id` do `warehouse_products` jako nullable.
4. Przypisać wszystkim istniejącym produktom katalog domyślny ich tenanta.
5. Ustawić `catalog_id` jako `NOT NULL`.
6. Dodać indeksy i relację `ON DELETE RESTRICT`.

Nazwa migracji:

```text
20260515_add_warehouse_catalogs
```

---

## 7. API magazynu z katalogami

### Katalogi

| Metoda | Endpoint | Opis |
|---|---|---|
| `GET` | `/admin/warehouse/catalogs` | Lista katalogów tenanta |
| `POST` | `/admin/warehouse/catalogs` | Utworzenie katalogu |
| `GET` | `/admin/warehouse/catalogs/:id` | Szczegóły katalogu |
| `PUT` | `/admin/warehouse/catalogs/:id` | Edycja katalogu |
| `DELETE` | `/admin/warehouse/catalogs/:id` | Usunięcie katalogu, tylko gdy nie jest domyślny i nie ma produktów |
| `GET` | `/admin/warehouse/catalogs/:id/products` | Lista produktów z katalogu |

`POST /admin/warehouse/catalogs`:

```json
{
  "code": "zaproszenia",
  "name": "Zaproszenia",
  "description": "Produkty gotowe i półprodukty związane z zaproszeniami",
  "isDefault": false,
  "isActive": true
}
```

Jeśli `isDefault = true`, serwis musi w transakcji zdjąć flagę domyślności z pozostałych katalogów tenanta.

### Produkty magazynowe

Rozszerzyć istniejące endpointy:

| Metoda | Endpoint | Zmiana |
|---|---|---|
| `GET` | `/admin/warehouse/products?catalogId=...` | Filtr po katalogu |
| `POST` | `/admin/warehouse/products` | Przyjmuje opcjonalne `catalogId` |
| `PUT` | `/admin/warehouse/products/:id` | Przyjmuje opcjonalne `catalogId` |

`POST /admin/warehouse/products`:

```json
{
  "catalogId": "catalog_id",
  "sku": "SKU-123",
  "name": "Nazwa produktu",
  "unit": "szt",
  "description": "Opis magazynowy",
  "purchasePrice": 10.5,
  "retailPrice": 19.99
}
```

Reguła domyślna:

- jeśli `catalogId` nie przyszło w body, produkt trafia do domyślnego katalogu tenanta;
- jeśli `catalogId` wskazuje nieaktywny albo obcy katalog, API zwraca `400`;
- jeśli katalog nie istnieje, API zwraca `404`.

### Mapowania sklepów

Rozszerzyć endpoint:

```text
POST /admin/shop-mappings/:id/create-product
```

Body opcjonalne:

```json
{
  "catalogId": "catalog_id"
}
```

Reguła:

- jeśli `catalogId` podano, nowy produkt magazynowy powstaje w tym katalogu;
- jeśli nie podano, używany jest katalog domyślny;
- jeśli produkt z takim SKU już istnieje, mapowanie podpina istniejący produkt i nie zmienia jego katalogu.

---

## 8. Przepływy magazynowe po dodaniu katalogów

### Ręczne utworzenie produktu

1. Operator wybiera katalog albo zostawia domyślny.
2. API waliduje katalog tenanta.
3. `WarehouseProduct` powstaje z `catalogId`.
4. Produkt od razu może dostać EAN, cenę i dokument PZ.

### Import produktów sklepu

1. `POST /admin/shop-mappings/import/:shopId` pobiera katalog sklepu do `ShopProductMapping`.
2. Operator filtruje niezamapowane produkty.
3. Przy `POST /admin/shop-mappings/:id/create-product` wybiera katalog docelowy.
4. Powstaje `WarehouseProduct` i mapowanie zostaje podpięte.

### Dokument magazynowy

1. `PZ`/`PW` zwiększa `currentStock` po `CONFIRMED`.
2. `WZ`/`RW` zmniejsza `currentStock` po `CONFIRMED`.
3. Katalog produktu nie wpływa na przeliczenie stanów.
4. `POST /admin/warehouse/recalculate-stock` nadal liczy stan z dokumentów `CONFIRMED`.

### Skaner EAN

1. Operator skanuje kod EAN.
2. API zwraca produkt, EAN i `quantityMultiplier`.
3. Pozycja dokumentu zapisuje snapshot: `barcodeId`, `scannedEan`, `baseQuantity`, `quantityMultiplier`, `quantity`.
4. Katalog produktu może być zwracany w odpowiedzi lookupu dla wygody panelu admina.

### Synchronizacja stanów do sklepów

1. Po zatwierdzeniu albo anulowaniu dokumentu serwis zbiera unikalne `warehouseProductId`.
2. `stock-sync` odpytuje bieżący `currentStock`, nie ufa wartości z job data.
3. Dla każdego aktywnego `ShopProductMapping` wysyła stan do sklepu.
4. `StockSyncLog` zapisuje wynik.

---

## 9. Swagger/OpenAPI jako definicja gotowości

Każdy nowy endpoint musi być widoczny w `/docs` i mieć kompletne schema:

- `tags`;
- `summary`;
- `params`;
- `querystring`;
- `body`;
- podstawowe `response` dla `200`, `201`, `204`, `400`, `404`.

Dodać tag w `src/plugins/swagger-docs.plugin.ts`:

```typescript
{ name: 'warehouse-catalogs', description: 'Katalogi produktów magazynowych' }
```

Rekomendacja tagowania:

- endpointy katalogów: `warehouse-catalogs`;
- produkty, dokumenty, stock, EAN: `warehouse`;
- mapowania sklepu: `shop-mappings`;
- logi synchronizacji stanów: docelowo `stock-sync` albo `warehouse`.

Definicja gotowości Swagger:

- `/docs` pokazuje katalogi, produkty, dokumenty, EAN/skaner i mapowania.
- `POST /admin/warehouse/catalogs` da się przetestować z poziomu Swagger UI.
- `POST /admin/warehouse/products` pokazuje `catalogId`.
- `POST /admin/shop-mappings/:id/create-product` pokazuje opcjonalne body z `catalogId`.

---

## 10. Git przed implementacją i po implementacji

Przed zmianami:

```bash
git status --short
git branch --show-current
git log -1 --oneline
git fetch --prune
git status -sb
```

Zasady:

- Nie nadpisywać lokalnych zmian użytkownika.
- Jeśli plik jest zmieniony przed pracą, najpierw przeczytać różnicę i dopasować edycję.
- Nie używać `git reset --hard` ani `git checkout --` bez wyraźnej zgody.
- Migracje Prisma mają być opisane w `warehouse.md`.
- Zmiany publicznego API mają być opisane w `warehouse.md` i Swaggerze.

Po zmianach:

```bash
git diff --stat
git diff -- warehouse.md
pnpm build
```

Jeśli implementacja obejmuje migrację:

```bash
pnpm prisma:generate
pnpm prisma:migrate
```

Jeśli build albo migracja nie przechodzą, zapisać w podsumowaniu:

- komendę;
- błąd;
- czy problem dotyczy nowych zmian, czy istniejącego stanu repo.

---

## 11. Kolejność implementacji katalogów

### Krok 1: model i migracja

- Dodać `WarehouseCatalog` do `prisma/schema.prisma`.
- Dodać relację `Tenant.warehouseCatalogs`.
- Dodać `WarehouseProduct.catalogId`.
- Przygotować migrację tworzącą domyślne katalogi i przypisującą istniejące produkty.
- Uruchomić `pnpm prisma:generate`.

### Krok 2: serwis katalogów

Nowy plik:

```text
src/services/admin/warehouse-catalogs.service.ts
```

Odpowiedzialności:

- lista katalogów;
- pobranie katalogu;
- utworzenie katalogu;
- edycja katalogu;
- usunięcie katalogu;
- znalezienie katalogu domyślnego;
- walidacja `catalogId` dla produktu.

### Krok 3: route katalogów

Nowy plik:

```text
src/routes/admin/warehouse-catalogs.routes.ts
```

Rejestracja:

```text
src/routes/admin/index.ts
```

Rekomendowany prefix:

```text
/admin/warehouse/catalogs
```

### Krok 4: produkty magazynowe

Zmienić:

```text
src/services/admin/warehouse.service.ts
src/routes/admin/warehouse.routes.ts
```

Zakres:

- `CreateProductInput.catalogId?`;
- `UpdateProductInput.catalogId?`;
- `ProductsQuery.catalogId?`;
- walidacja katalogu;
- domyślny katalog przy braku `catalogId`;
- include katalogu w odpowiedziach szczegółowych, jeśli panel admina tego potrzebuje.

### Krok 5: mapowania sklepu

Zmienić:

```text
src/services/admin/shop-product-import.service.ts
src/routes/admin/shop-mappings.routes.ts
```

Zakres:

- `createWarehouseProductFromMapping(mappingId, { catalogId? })`;
- body w endpointzie `POST /admin/shop-mappings/:id/create-product`;
- domyślny katalog przy braku `catalogId`.

### Krok 6: Swagger i weryfikacja

- Dodać tag `warehouse-catalogs`.
- Uzupełnić schema nowych i zmienionych endpointów.
- Sprawdzić `/docs`.
- Uruchomić build.

---

## 12. Test plan

### Migracja

- Dla każdego tenanta powstaje dokładnie jeden katalog domyślny.
- Wszystkie istniejące produkty mają `catalogId`.
- Nie ma produktu bez katalogu po migracji.
- Relacja `ON DELETE RESTRICT` blokuje usunięcie katalogu z produktami.

### API katalogów

- `GET /admin/warehouse/catalogs` zwraca tylko katalogi bieżącego tenanta.
- `POST /admin/warehouse/catalogs` tworzy katalog z unikalnym `code`.
- Próba powtórzenia `code` w tym samym tenancie zwraca błąd.
- `PUT /admin/warehouse/catalogs/:id` edytuje nazwę, opis i aktywność.
- Ustawienie katalogu jako domyślnego zdejmuje `isDefault` z poprzedniego.
- `DELETE` blokuje katalog domyślny.
- `DELETE` blokuje katalog z produktami.

### Produkty

- `POST /admin/warehouse/products` bez `catalogId` używa katalogu domyślnego.
- `POST /admin/warehouse/products` z `catalogId` przypisuje produkt do wskazanego katalogu.
- `PUT /admin/warehouse/products/:id` pozwala przenieść produkt do innego aktywnego katalogu.
- `GET /admin/warehouse/products?catalogId=...` filtruje po katalogu.
- Produkt nie może zostać przypisany do katalogu innego tenanta.

### Mapowania sklepów

- `POST /admin/shop-mappings/:id/create-product` bez body tworzy produkt w katalogu domyślnym.
- Ten sam endpoint z `catalogId` tworzy produkt w wybranym katalogu.
- Jeśli produkt ze SKU już istnieje, endpoint podpina istniejący produkt i nie zmienia jego katalogu.

### Regresja magazynu

- PZ `CONFIRMED` zwiększa `currentStock`.
- WZ `CONFIRMED` zmniejsza `currentStock`.
- `cancelDocument()` odwraca wpływ dokumentu na stan.
- `POST /admin/warehouse/recalculate-stock` przywraca zgodny cache.
- Lookup EAN dalej zwraca produkt i przelicznik.
- Skan EAN opakowania zbiorczego zapisuje poprawne `baseQuantity`, `quantityMultiplier` i finalne `quantity`.
- Stock sync dalej wysyła bieżący stan produktu do zmapowanych sklepów.

### Jakość

```bash
pnpm build
pnpm test
```

Jeśli testów automatycznych jeszcze nie ma dla magazynu, minimalna ręczna ścieżka akceptacyjna:

1. Utworzyć katalog.
2. Utworzyć produkt w katalogu.
3. Dodać EAN do produktu.
4. Utworzyć PZ przez skan EAN.
5. Zatwierdzić PZ.
6. Sprawdzić `currentStock`.
7. Utworzyć WZ.
8. Zatwierdzić WZ.
9. Sprawdzić log `StockSyncLog`.
10. Otworzyć `/docs` i potwierdzić obecność nowych endpointów.

---

## 13. Ryzyka i decyzje

| Ryzyko | Decyzja / mitigacja |
|---|---|
| Katalog zacznie udawać pełny produkt/PIM | W v1 katalog ma tylko porządkować produkty magazynowe |
| Istniejące produkty bez katalogu po migracji | Migracja tworzy domyślny katalog i przypisuje wszystkie rekordy |
| Przypadkowe usunięcie katalogu z produktami | `ON DELETE RESTRICT` i walidacja w serwisie |
| Integracje sklepów nie znają katalogu | Katalog jest wewnętrzny; `ShopProductMapping` nadal mapuje sklep -> produkt magazynowy |
| Rozjazd Swaggera z implementacją | Swagger jest częścią definicji gotowości |
| Przyszłe multi-warehouse | Nie blokujemy go, ale nie wprowadzamy teraz dodatkowego wymiaru stanów |

---

## 14. Przyszły moduł produktu/PIM

Katalog magazynowy jest pierwszym krokiem, ale nie powinien jeszcze przejmować odpowiedzialności PIM.

W przyszłości można dodać osobny moduł produktu:

```text
Product
  ├── ProductVariant
  ├── ProductImage
  ├── ProductDescription
  ├── Manufacturer
  └── MarketplaceFields
```

Wtedy `WarehouseProduct` może stać się fizycznym SKU powiązanym z produktem handlowym albo wariantem. Na dziś nie robimy tej przebudowy, bo obecna potrzeba dotyczy magazynu, stanów i katalogowania produktów magazynowych.

---

## 15. Roadmapa kolejnych etapów rozbudowy

Roadmapa jest ułożona tak, żeby najpierw domknąć fundament magazynu, potem poprawić operacyjność, a dopiero później wejść w bardziej zaawansowane integracje i przyszły produkt/PIM.

### Etap 0: porządek przed kolejną implementacją

Cel: upewnić się, że następne zmiany startują z czystego i opisanego stanu.

Status pre-flight z 2026-05-15:

- aktualna gałąź: `feature/warehouse-negative-stock-guard`;
- ostatni commit: `837fe90 feat: extend warehouse sync flows`;
- remote: `origin git@github.com:msierpien/kp-api.git`;
- gałąź nie ma ustawionego upstreamu, więc `git status -sb` nie pokazuje porównania ahead/behind dla `@{u}`;
- lokalnie zmieniony jest tylko `warehouse.md`;
- `git fetch --prune` wykonany przed startem kolejnych prac.

Decyzje dla następnego sprintu:

- `warehouse.md` jest źródłem prawdy dla Etapu 1;
- implementację katalogów prowadzić w osobnym PR/branchu, rekomendowana nazwa: `feature/warehouse-catalogs`;
- do Etapu 1 nie dorzucać hurtowni, synchronizacji cen, rezerwacji ani PIM;
- każdy PR z katalogami musi zawierać migrację Prisma, aktualizację Swagger/OpenAPI i checklistę testów z sekcji 12;
- przed właściwą implementacją katalogów warto ustawić upstream dla branchu roboczego albo utworzyć nowy branch od aktualnej bazy.

Checklist Etapu 0:

- Ustalić aktualną gałąź roboczą i porównać ją z remote przez procedurę z sekcji Git.
- Zdecydować, czy `warehouse.md` jest źródłem prawdy dla najbliższego sprintu magazynowego.
- Rozbić implementację katalogów na osobny branch/PR.
- W issue albo opisie PR przepisać kryteria akceptacji z sekcji test plan.

Efekt końcowy:

- wiadomo, co wchodzi do etapu katalogów;
- nie mieszamy katalogów z hurtownią, cenami ani PIM-em;
- Swagger i migracja są wymagane od pierwszego PR.

### Etap 1: katalogi produktów magazynowych

Cel: dodać `WarehouseCatalog` jako pierwszą warstwę porządkującą produkty magazynowe.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- migracja `warehouse_catalogs` i `WarehouseProduct.catalogId` - wdrożone;
- domyślny katalog per tenant - wdrożone;
- serwis `warehouse-catalogs.service.ts` - wdrożone;
- route `warehouse-catalogs.routes.ts` - wdrożone;
- filtrowanie `GET /admin/warehouse/products?catalogId=...` - wdrożone;
- `catalogId` w `POST/PUT /admin/warehouse/products` - wdrożone;
- opcjonalny `catalogId` w `POST /admin/shop-mappings/:id/create-product` - wdrożone;
- tag `warehouse-catalogs` i pełne schema w Swagger - wdrożone.

Zakres panelu admina:

- lista katalogów;
- tworzenie i edycja katalogu;
- filtr katalogu na liście produktów;
- wybór katalogu przy ręcznym tworzeniu produktu;
- wybór katalogu przy tworzeniu produktu z mapowania sklepu.

Wytyczne dla frontendu panelu admina:

1. Dodać widok `Magazyn -> Katalogi`
   - tabela: `Nazwa`, `Kod`, `Domyślny`, `Aktywny`, `Liczba produktów`, `Utworzono`, akcje;
   - akcje: dodaj, edytuj, usuń;
   - katalog domyślny powinien mieć czytelny znacznik i zablokowaną akcję usunięcia;
   - przy katalogu z produktami akcja usunięcia powinna być zablokowana albo pokazywać komunikat z API.

2. Dodać formularz katalogu
   - pola: `name`, `code`, `description`, `isDefault`, `isActive`;
   - `code` powinien być krótki, techniczny, np. `zaproszenia`, `akcesoria`, `materialy`;
   - ustawienie `isDefault=true` powinno informować, że poprzedni katalog domyślny zostanie zastąpiony;
   - nie pozwalać na pusty `name` i pusty `code`.

3. Dodać filtr katalogu na liście produktów magazynowych
   - pobrać katalogi z `GET /admin/warehouse/catalogs?isActive=true&limit=200`;
   - dodać select `Wszystkie katalogi` + lista katalogów;
   - po wyborze katalogu wołać `GET /admin/warehouse/products?catalogId=...`;
   - w tabeli produktów pokazać nazwę katalogu, jeśli API zwraca `product.catalog`.

4. Dodać katalog do formularza produktu magazynowego
   - przy tworzeniu produktu dodać select katalogu;
   - domyślnie wybrać katalog z `isDefault=true`;
   - jeśli użytkownik nic nie wybierze, backend i tak użyje katalogu domyślnego;
   - przy edycji produktu pozwolić przenieść produkt do innego aktywnego katalogu.

5. Dodać katalog przy tworzeniu produktu z mapowania sklepu
   - w akcji `Utwórz produkt magazynowy` z `ShopProductMapping` pokazać modal z wyborem katalogu;
   - domyślnie wybrać katalog domyślny;
   - wywołać `POST /admin/shop-mappings/:id/create-product` z body `{ "catalogId": "..." }`;
   - jeśli backend zwróci istniejący produkt, pokazać komunikat, że mapowanie zostało podpięte do istniejącego SKU.

6. Obsłużyć stany błędów
   - `400` przy duplikacie `code` katalogu: pokazać komunikat z API;
   - `400` przy nieaktywnym katalogu: poprosić o wybór aktywnego katalogu;
   - `404` przy brakującym katalogu: odświeżyć listę katalogów;
   - `DELETE` katalogu domyślnego albo katalogu z produktami: pokazać komunikat i nie usuwać lokalnie rekordu z tabeli.

Endpointy dla panelu:

```text
GET    /admin/warehouse/catalogs?page=1&limit=50&search=&isActive=true
POST   /admin/warehouse/catalogs
GET    /admin/warehouse/catalogs/:id
PUT    /admin/warehouse/catalogs/:id
DELETE /admin/warehouse/catalogs/:id
GET    /admin/warehouse/catalogs/:id/products?page=1&limit=50

GET    /admin/warehouse/products?catalogId=:catalogId
POST   /admin/warehouse/products
PUT    /admin/warehouse/products/:id

POST   /admin/shop-mappings/:id/create-product
```

Przykładowe body katalogu:

```json
{
  "code": "zaproszenia",
  "name": "Zaproszenia",
  "description": "Produkty i półprodukty związane z zaproszeniami",
  "isDefault": false,
  "isActive": true
}
```

Przykładowe body produktu:

```json
{
  "catalogId": "catalog_id",
  "sku": "INV-KOMUNIA-001",
  "name": "Zaproszenie komunijne - wzór 01",
  "unit": "szt",
  "purchasePrice": 4.5,
  "retailPrice": 12.99
}
```

Przykładowe body tworzenia produktu z mapowania:

```json
{
  "catalogId": "catalog_id"
}
```

Kryteria akceptacji panelu:

- operator widzi listę katalogów i rozpoznaje katalog domyślny;
- operator może utworzyć i edytować katalog;
- operator nie może przypadkowo usunąć katalogu domyślnego;
- lista produktów filtruje się po katalogu;
- formularz produktu pokazuje i zapisuje `catalogId`;
- produkt tworzony z mapowania sklepu trafia do wybranego katalogu;
- po odświeżeniu strony wybrane katalogi i przypisania produktów pozostają zgodne z API.

Efekt końcowy:

- każdy produkt ma katalog;
- nowe produkty trafiają do katalogu domyślnego albo wybranego;
- operator może uporządkować magazyn bez dotykania przyszłego modułu produktu.

### Etap 2: operacyjność magazynu i widoczność logów

Cel: sprawić, żeby magazyn był wygodny w codziennej pracy i łatwy do diagnozowania.

Status backend/API: wdrożone w `kp-api`.

Zakres backend:

- endpoint/listing `StockSyncLog` w panelu admina - wdrożone;
- filtry logów po sklepie, produkcie, statusie i dacie - wdrożone;
- endpoint ręcznego ponowienia syncu stanu - wdrożone;
- historia ruchów produktu: dokumenty i pozycje dokumentów dla konkretnego `warehouseProductId` - wdrożone;
- endpoint szybkiego podglądu rozbieżności: `currentStock` vs stan liczony z dokumentów - wdrożone.

Endpointy Etapu 2:

```text
GET  /admin/warehouse/stock-sync-logs?page=1&limit=50&status=FAILED&shopId=&warehouseProductId=&dateFrom=&dateTo=
POST /admin/warehouse/stock-sync-logs/:id/retry

GET  /admin/warehouse/products/:id/movements?page=1&limit=50&status=CONFIRMED&type=PZ&dateFrom=&dateTo=
GET  /admin/warehouse/stock/discrepancies?includeZero=false
```

Wytyczne dla panelu admina:

1. Dodać widok `Magazyn -> Logi synchronizacji`
   - tabela: data, sklep, produkt, status, trigger, stan wysłany, liczba prób, błąd;
   - filtry: status, sklep, produkt, zakres dat;
   - dla `FAILED` pokazać akcję `Ponów sync`;
   - po retry odświeżyć listę i pokazać nowy log `PENDING`.

2. Dodać sekcję `Ruchy magazynowe` na karcie produktu
   - tabela: data dokumentu, numer dokumentu, typ, status, ilość, wpływ na stan, EAN, notatka;
   - filtry: status dokumentu, typ dokumentu, zakres dat;
   - `stockDelta` pokazywać z plusem/minusem tylko dla dokumentów `CONFIRMED`.

3. Dodać widok albo widget `Rozbieżności stanów`
   - endpoint zwraca produkty, dla których `currentStock` różni się od stanu liczonego z dokumentów;
   - pokazać: SKU, nazwa, katalog, `currentStock`, `calculatedStock`, `difference`;
   - jeśli lista jest pusta, pokazać pozytywny stan: brak rozbieżności;
   - obok widoku można podpiąć istniejącą akcję `POST /admin/warehouse/recalculate-stock`.

Kryteria akceptacji panelu Etapu 2:

- operator widzi logi synchronizacji stanów i może filtrować błędy;
- operator może ponowić synchronizację z poziomu logu;
- operator na karcie produktu widzi historię ruchów magazynowych;
- operator widzi, czy `currentStock` zgadza się z dokumentami;
- błędy z API są pokazywane bez ukrywania szczegółów `errorMessage`.

Zakres panelu admina:

- karta produktu: stan, katalog, EAN-y, mapowania sklepów, ostatnie ruchy;
- widok logów synchronizacji;
- akcja "przelicz stan" i "ponów sync" dla wybranego produktu;
- czytelne ostrzeżenia przy ujemnych stanach i nieudanych syncach.

Efekt końcowy:

- operator widzi, dlaczego stan produktu jest taki, a nie inny;
- błędy synchronizacji nie giną w logach serwera;
- `currentStock` jest łatwy do sprawdzenia i naprawienia.

### Etap 3: integracja z hurtownią i automatyczne przyjęcia

Cel: zasilić magazyn danymi z hurtowni bez ręcznego przepisywania stanów i cen zakupu.

Status backend/API v1: wdrożone w `kp-api` dla feedów CSV.

Zakres backend:

- modele `WholesaleProvider`, `WholesaleProductMapping`, `WholesaleSyncLog` - wdrożone;
- obsługa źródła `CSV_FEED` - wdrożone;
- presety mapowania kolumn dla `GODAN` i `PARTYDECO` - wdrożone;
- ręczny sync hurtowni z wynikiem - wdrożone;
- mapowanie produktu hurtowni do `WarehouseProduct` - wdrożone;
- zapis `lastKnownStock`, `lastKnownPrice`, EAN, nazwy, kategorii i snapshotu CSV - wdrożone;
- kolejka `wholesale-sync`, automatyczne PZ i korekty magazynowe - odłożone na kolejny krok po walidacji feedów.

Endpointy Etapu 3:

```text
GET    /admin/wholesale/providers
POST   /admin/wholesale/providers
GET    /admin/wholesale/providers/:id
PUT    /admin/wholesale/providers/:id
DELETE /admin/wholesale/providers/:id
POST   /admin/wholesale/providers/:id/sync

GET    /admin/wholesale/providers/:id/mappings
PUT    /admin/wholesale/mappings/:id

GET    /admin/wholesale/providers/:id/logs
```

Przykład providera Godan:

```json
{
  "name": "Godan",
  "feedUrl": "WKLEJ_URL_FEEDU_GODAN",
  "preset": "GODAN",
  "platform": "CSV_FEED",
  "syncEnabled": true,
  "isActive": true
}
```

Przykład providera PartyDeco:

```json
{
  "name": "PartyDeco",
  "feedUrl": "WKLEJ_URL_FEEDU_PARTYDECO",
  "preset": "PARTYDECO",
  "platform": "CSV_FEED",
  "syncEnabled": true,
  "isActive": true
}
```

Presety kolumn:

| Provider | SKU | EAN | Nazwa | Stan | Cena zakupu | Kategoria |
|---|---|---|---|---|---|---|
| Godan | `Kod produktu` | `Kod EAN` | `Nazwa` | `Stan magazynowy` | `Cena netto jednostkowa` | brak |
| PartyDeco | `code` | `ean` | `name` | `stock` | `price_net` | `category_path` |

#### Status konfiguracji testowej

Na środowisku deweloperskim dodano bezpośrednio do bazy dwóch providerów hurtowni dla tenanta `default-tenant-id`:

| Provider | ID | Status | Sync |
|---|---|---|---|
| Godan | `wholesale_provider_godan_default` | aktywny | jeszcze nieuruchomiony |
| PartyDeco | `wholesale_provider_partydeco_default` | aktywny | jeszcze nieuruchomiony |

Oba providery mają:

- `platform = CSV_FEED`;
- `syncEnabled = true`;
- `isActive = true`;
- zapisany `feedUrl` w bazie;
- zapisany `configJson` z presetem, separatorem `;` i mapperem kolumn.

Ważne:

- konfiguracje providerów są w bazie, nie w seedzie i nie w migracji;
- URL-e feedów zawierają tokeny/dostęp integracyjny, więc nie powinny być przepisywane do kodu frontendu ani commitowane w dokumentacji publicznej;
- synchronizacja produktów nie była jeszcze uruchomiona, więc `WholesaleProductMapping` i `WholesaleSyncLog` mają na start po `0` rekordów dla obu providerów;
- kolejnym krokiem testowym jest ręczne uruchomienie `POST /admin/wholesale/providers/:id/sync`, najpierw najlepiej z małym `limit`, żeby sprawdzić mapowanie pól i licznik `skipped`.

Przykład testowego syncu z ograniczeniem:

```json
{
  "limit": 20
}
```

Po syncu należy sprawdzić:

- `GET /admin/wholesale/providers/:id/logs` - czy status jest `SUCCESS`;
- `GET /admin/wholesale/providers/:id/mappings` - czy powstały kandydaty produktów hurtowni;
- czy `externalSku`, `externalEan`, `externalName`, `lastKnownStock`, `lastKnownPrice` są uzupełnione zgodnie z feedem;
- czy `payloadJson` zawiera oryginalny wiersz CSV.

#### Plan elastycznych importerów i mapperów

Docelowo integracja hurtowni nie powinna być listą warunków `if provider === GODAN`. Provider ma mieć konfigurację importu, a parser CSV ma działać tak samo dla wielu plików:

```json
{
  "preset": "CUSTOM",
  "delimiter": ";",
  "fieldMapping": {
    "sku": "code",
    "ean": "ean",
    "name": "name",
    "stock": "stock",
    "price": "price_net",
    "description": "description",
    "image": "photos",
    "category": "category_path"
  }
}
```

Minimalne pola mapera:

- `sku` - wymagane, stabilny identyfikator produktu w hurtowni;
- `name` - wymagane, nazwa do listy kandydatów;
- `ean` - opcjonalne, ale zalecane;
- `stock` - opcjonalne, stan z hurtowni;
- `price` - opcjonalne, cena zakupu netto;
- `description`, `image`, `category` - opcjonalne pola informacyjne, na razie zapisywane w `payloadJson` albo wybranych polach mapowania.

Zasady dodawania kolejnych plików:

- jeśli hurtownia ma typowy układ kolumn, dodać preset w backendzie, np. `ABC_HURT`;
- jeśli plik jest jednorazowy albo niestandardowy, użyć `CUSTOM` i zapisać `fieldMapping` w `WholesaleProvider.configJson`;
- URL feedu z tokenem zapisujemy tylko w bazie przez API, nigdy w repo ani w kodzie frontendu;
- każdy provider może mieć własny separator kolumn, np. `;`, `,`, `\t`;
- separator wartości wewnątrz kolumny, np. zdjęcia albo atrybuty rozdzielone przecinkiem, zostaje w `payloadJson` do późniejszego PIM-a.

Rekomendowany kolejny krok backendu:

```text
POST /admin/wholesale/providers/preview
```

Body:

```json
{
  "feedUrl": "URL_FEEDU",
  "delimiter": ";",
  "limit": 5
}
```

Odpowiedź:

```json
{
  "columns": ["code", "ean", "name", "stock", "price_net"],
  "sampleRows": [
    {
      "code": "10M-000",
      "ean": "5901157459862",
      "name": "Balony 23cm, Metallic Mix",
      "stock": "34",
      "price_net": "17.53"
    }
  ]
}
```

Panel admina powinien użyć preview do kreatora importu:

1. Operator wkleja URL feedu.
2. Panel pobiera kolumny i kilka przykładowych wierszy.
3. Operator wybiera separator i mapuje kolumny na pola systemowe.
4. Panel zapisuje `WholesaleProvider` z `preset=CUSTOM` i `fieldMapping`.
5. Operator odpala `Synchronizuj teraz`.

Kryteria akceptacji elastycznego importera:

- można dodać Godan przez preset bez ręcznego mapowania;
- można dodać PartyDeco przez preset bez ręcznego mapowania;
- można dodać nowy CSV przez `CUSTOM` bez zmian w kodzie backendu;
- synchronizacja tworzy/aktualizuje `WholesaleProductMapping`;
- błędne lub puste SKU jest pomijane i liczone w `skipped`;
- pełny oryginalny wiersz CSV zostaje w `payloadJson`, żeby później wykorzystać dodatkowe pola w PIM.

Wytyczne dla panelu admina:

- dodać widok `Magazyn -> Hurtownie`;
- umożliwić dodanie providera CSV z presetem `GODAN`, `PARTYDECO` albo `CUSTOM`;
- nie zapisywać feed URL-i z tokenami w kodzie frontendu ani w repo, tylko w bazie przez API;
- dodać przycisk `Synchronizuj teraz`;
- po syncu pokazać log: pobrane, utworzone mapowania, zaktualizowane mapowania, pominięte, status;
- dodać tabelę produktów hurtowni z filtrem `niezamapowane`;
- dodać akcję mapowania produktu hurtowni do istniejącego `WarehouseProduct`.

Decyzja na start:

- w v1 hurtownia nie tworzy nowych produktów automatycznie;
- najpierw importuje kandydatów do mapowania;
- operator decyduje, który produkt hurtowni odpowiada produktowi magazynowemu.
- v1 nie tworzy dokumentów `PZ` i nie zmienia `WarehouseProduct.currentStock`.

Efekt końcowy:

- stany i ceny zakupu z feedu są widoczne na mapowaniach hurtowni;
- ruch magazynowy nadal wymaga świadomej decyzji operatora;
- błędy feedu są widoczne w `WholesaleSyncLog`.

### Etap 4: synchronizacja cen do sklepów

Cel: rozdzielić cenę zakupu, cenę sprzedaży i publikację ceny do sklepów.

Zakres backend:

- model `PriceSyncLog`;
- kolejka `price-sync`;
- klient ceny dla PrestaShop;
- później klient ceny dla WooCommerce;
- endpoint ręcznej synchronizacji ceny produktu;
- opcja `autoCalculateRetail` według marży albo reguły tenanta.

Decyzja na start:

- synchronizujemy tylko `retailPrice`;
- `purchasePrice` zostaje wewnętrzne;
- price groups, promocje i cenniki per sklep odkładamy na później.

Efekt końcowy:

- zmiana ceny magazynowej może trafić do sklepów kontrolowanym procesem;
- operator ma log sukcesów i błędów;
- ceny nie mieszają się z logiką stanów.

### Etap 5: dokładniejsza kontrola stanów

Cel: przygotować magazyn do bardziej zaawansowanych procesów bez przedwczesnego multi-warehouse.

Zakres możliwy po etapach 1-4:

- rezerwacje stanów dla zamówień;
- status "do wydania" przed potwierdzeniem WZ;
- minimalny stan produktu i alerty;
- raport produktów poniżej minimum;
- automatyczny cron rekalibracji `currentStock`;
- eksport ruchów magazynowych do CSV.

Decyzja na start:

- nie wprowadzamy jeszcze wielu fizycznych magazynów;
- nie dodajemy lokalizacji półek;
- najpierw stabilizujemy jeden magazyn i dokumenty.

Efekt końcowy:

- magazyn zaczyna wspierać decyzje operacyjne, nie tylko przechowuje stan;
- łatwiej zauważyć braki, rozbieżności i produkty wymagające zamówienia.

### Etap 6: przyszły produkt/PIM

Cel: rozbudować produkt dopiero wtedy, gdy magazyn będzie stabilny.

Zakres przyszły:

- `Product` jako produkt handlowy;
- `ProductVariant` jako wariant sprzedażowy;
- zdjęcia, opisy, producent, atrybuty;
- relacja produktu handlowego lub wariantu do `WarehouseProduct`;
- pola pod marketplace i eksporty.

Decyzja:

- `WarehouseCatalog` nie staje się PIM-em;
- obecny `WarehouseProduct` zostaje fizycznym SKU magazynowym;
- PIM powstaje jako osobny moduł, gdy będzie realna potrzeba zarządzania treściami produktowymi.

Efekt końcowy:

- magazyn pozostaje prosty i stabilny;
- moduł produktu może rosnąć bez przebudowy dokumentów magazynowych.

### Rekomendowana kolejność sprintów

| Sprint | Priorytet | Zakres | Dlaczego teraz |
|---|---|---|---|
| 1 | P0 | `WarehouseCatalog`, migracja, API, Swagger | Fundament pod porządkowanie produktów |
| 2 | P0 | Panel katalogów i filtr produktów po katalogu | Operator od razu korzysta z nowej warstwy |
| 3 | P1 | Logi stock sync, historia ruchów, ponowienie syncu | Mniej ręcznej diagnostyki |
| 4 | P1 | Hurtownia: provider, mapowania, ręczny sync | Automatyzacja danych wejściowych |
| 5 | P2 | Price sync i `PriceSyncLog` | Kontrolowana publikacja cen |
| 6 | P2 | Alerty stanów, rezerwacje, raporty | Dojrzałość operacyjna |
| 7 | P3 | Produkt/PIM | Dopiero po stabilnym magazynie |

---

## 16. Definicja ukończenia etapu katalogów

Etap katalogów jest gotowy, gdy:

- każdy produkt magazynowy ma katalog;
- istnieje katalog domyślny per tenant;
- API pozwala tworzyć, edytować, listować i usuwać katalogi zgodnie z regułami;
- produkty można filtrować po katalogu;
- produkt tworzony z mapowania sklepu trafia do wybranego albo domyślnego katalogu;
- Swagger pokazuje wszystkie nowe endpointy;
- `pnpm build` przechodzi;
- `warehouse.md` zawiera aktualne informacje o modelu, migracji, API i testach.
