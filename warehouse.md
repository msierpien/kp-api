# Plan rozbudowy modułu magazynowego: katalogi produktów i kontrola stanów

> Data aktualizacji: 2026-05-15
> Status: dokument architektoniczny po implementacji backendu Etapów 1-8 i sprintu operacyjnego dashboardu
> Zakres: magazyn, katalogi, dokumenty, stany, EAN/skaner, mapowania sklepów, stock sync, hurtownie CSV, diagnostyka, Swagger i proces Git

---

## 1. Cel

Moduł magazynowy ma być centralnym miejscem kontroli fizycznych produktów, stanów i dokumentów magazynowych dla wielu sklepów. Inspirujemy się podejściem BaseLinkera, w którym magazyn nie jest tylko listą stanów, ale ma katalog produktów, a produkty są przypisane do katalogu i dopiero z niego mapowane do sklepów, magazynów oraz integracji.

Backend ma już dodaną warstwę `WarehouseCatalog`:

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

- Domknięcie panelu admina dla wdrożonych endpointów magazynu.
- Widok katalogów magazynowych i wybór katalogu w formularzach produktów.
- Dashboard operacyjny magazynu oparty o `GET /admin/warehouse/dashboard`.
- Widoki diagnostyczne: logi stock sync, ruchy produktu i rozbieżności stanów.
- Panel integracji hurtowni: providery CSV, preview, synchronizacja, logi i mapowania.
- Aktualizację `warehouse.md` jako źródła prawdy dla dalszych sprintów.

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

Kolejne etapy backend/API wdrożone po Etapie 1:

- Etap 2: logi stock sync, retry synchronizacji, ruchy produktu i rozbieżności stanów;
- Etap 3: integracja hurtowni przez CSV, providery, mapowania i logi syncu;
- Etap 4: workflow importu produktów sklepu, import logi, automapowanie i bulk create;
- Etap 5: EAN z PrestaShop, preview importu i readiness sklepu;
- Etap 6: preview i mapper CSV dla hurtowni;
- Etap 7: automapowanie produktów hurtowni po SKU i EAN;
- Sprint operacyjny 1: `GET /admin/warehouse/dashboard` i filtry operacyjne produktów.
- Etap 8: `PriceSyncLog`, kolejka `price-sync`, worker i ręczna synchronizacja `retailPrice` do PrestaShop.

Do domknięcia poza backendiem `kp-api`, w panelu admina:

- widok katalogów w panelu admina;
- filtr katalogu na liście produktów w panelu;
- wybór katalogu przy tworzeniu produktu z panelu i z mapowania sklepu;
- dashboard magazynu z kaflami problemów;
- logi stock sync z retry;
- historia ruchów produktu i widok rozbieżności stanów;
- `Integracje -> Hurtownie`: providery, preview CSV, sync, harmonogram, logi, mapowania i auto-mapowanie;
- oferty hurtowni widoczne przy produktach magazynowych.

Następny backend po domknięciu panelu:

- Etap 9: dokładniejsza kontrola stanów, alerty, rezerwacje i raporty.

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
2. Wynik importu zapisuje się w `ShopProductImportLog`.
3. Operator filtruje niezamapowane produkty.
4. Może użyć `POST /admin/shop-mappings/bulk/auto-map`, żeby powiązać pozycje po SKU.
5. Przy `POST /admin/shop-mappings/:id/create-product` albo `POST /admin/shop-mappings/bulk/create-products` wybiera katalog docelowy.
6. Powstaje `WarehouseProduct` i mapowanie zostaje podpięte.

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
- ostatni commit: `48add92 feat: add warehouse operations dashboard`;
- remote: `origin git@github.com:msierpien/kp-api.git`;
- gałąź ma ustawiony upstream `origin/feature/warehouse-negative-stock-guard`;
- `git status -sb` pokazuje branch jako `ahead 1`;
- lokalnie zmieniany w tym porządkowaniu jest `warehouse.md`;
- backend katalogów, diagnostyki, hurtowni i dashboardu jest już obecny w repo.

Decyzje dla następnego sprintu:

- `warehouse.md` pozostaje źródłem prawdy dla prac magazynowych;
- najbliższy sprint jest frontendowy: panel katalogów, dashboard magazynu, diagnostyka i hurtownie;
- Etap 8 (`price-sync`) jest wdrożony po decyzji, że dalsze prace prowadzimy tylko po stronie API;
- do kolejnego PR nie dorzucać PIM, multi-warehouse, lokalizacji półkowych ani automatycznych PZ z hurtowni;
- jeśli frontend jest w osobnym repo, przenieść do niego sekcje "Wytyczne dla panelu admina" jako kryteria akceptacji.

Checklist Etapu 0:

- Potwierdzić lokalizację repo panelu admina.
- Utworzyć branch frontendowy dla prac panelowych.
- Przepisać kryteria akceptacji panelu z Etapów 1-7 i sprintu operacyjnego do issue albo opisu PR.
- Po wdrożeniu panelu wrócić do Etapu 9 dokładniejszej kontroli stanów.

Efekt końcowy:

- wiadomo, że backend magazynu dla Etapów 1-7 jest gotowy do obsłużenia panelu;
- prace frontendowe nie mieszają się z synchronizacją cen ani PIM-em;
- Etap 9 ma jasny warunek startu: panel korzysta już z obecnych API.

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

Endpointy do złożenia karty produktu bez osobnego agregatu:

```text
GET /admin/warehouse/products/:id
GET /admin/warehouse/products/:id/barcodes
GET /admin/warehouse/products/:id/movements
GET /admin/shop-mappings?warehouseProductId=:id
GET /admin/wholesale/product-offers?productIds=:id
GET /admin/warehouse/stock-sync-logs?warehouseProductId=:id
GET /admin/warehouse/price-sync-logs?warehouseProductId=:id
```

`GET /admin/warehouse/products/:id` zwraca katalog i `_count` aktywnych EAN-ów, mapowań sklepowych oraz ofert hurtowni.

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
- harmonogram syncu hurtowni przez `syncInterval` od 30 do 1440 minut - wdrożone;
- endpoint ofert hurtowni dla produktów magazynowych - wdrożone;
- mapowanie produktu hurtowni do `WarehouseProduct` - wdrożone;
- zapis `lastKnownStock`, `lastKnownPrice`, EAN, nazwy, kategorii i snapshotu CSV - wdrożone;
- automatyczne PZ i korekty `currentStock` - odłożone; hurtownia jest źródłem danych, nie ruchem magazynowym.

Endpointy Etapu 3:

```text
GET    /admin/wholesale/providers
POST   /admin/wholesale/providers
GET    /admin/wholesale/providers/:id
PUT    /admin/wholesale/providers/:id
DELETE /admin/wholesale/providers/:id
POST   /admin/wholesale/providers/:id/sync
PUT    /admin/wholesale/providers/:id/sync/interval
GET    /admin/wholesale/product-offers?productIds=id1,id2

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
  "syncInterval": 1440,
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
  "syncInterval": 1440,
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
- `syncInterval = 1440`;
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

Backend/API: wdrożone w `kp-api` 2026-05-15.

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

Endpoint nie zapisuje `feedUrl` w bazie. Służy wyłącznie do kreatora importu i bezpiecznego rozpoznania kolumn.

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

#### Brief dla frontendu: integracja hurtowni

Aktualny kierunek: hurtownie są częścią obszaru `Integracje`, nie głównym widokiem magazynowym. Magazyn pokazuje efekt integracji, czyli powiązane oferty, ostatni znany stan, cenę zakupu i datę syncu przy produktach. Konfiguracja URL-a feedu, preview CSV, harmonogram, ręczny sync, logi i mapowania powinny mieszkać w `Integracje -> Hurtownie`.

Frontend nie powinien trzymać feed URL-i z tokenami w kodzie ani w stałej konfiguracji. URL trafia do API dopiero w formularzu/operator workflow.

Główne widoki:

1. `Integracje -> Hurtownie`: lista providerów
   - endpoint: `GET /admin/wholesale/providers`;
   - tabela: nazwa, preset/platforma, aktywny, sync enabled, interwał syncu, ostatni sync, liczba mapowań, liczba logów;
   - akcje: szczegóły, edycja, usuń, synchronizuj, automapuj, ustaw harmonogram.

2. Kreator dodania hurtowni CSV
   - krok 1: `feedUrl`, separator, preset `GODAN`, `PARTYDECO` albo `CUSTOM`;
   - krok 2: dla `CUSTOM` wywołać `POST /admin/wholesale/providers/preview`;
   - krok 3: pokazać `columns` i `sampleRows`;
   - krok 4: operator mapuje kolumny na pola systemowe;
   - krok 5: ustawić `syncEnabled` i `syncInterval`;
   - krok 6: zapisać przez `POST /admin/wholesale/providers`.

3. Szczegóły hurtowni
   - endpoint: `GET /admin/wholesale/providers/:id`;
   - mapowania: `GET /admin/wholesale/providers/:id/mappings`;
   - logi: `GET /admin/wholesale/providers/:id/logs`;
   - akcje: `POST /admin/wholesale/providers/:id/sync`, `POST /admin/wholesale/providers/:id/auto-map`, `PUT /admin/wholesale/providers/:id/sync/interval`.

4. `Magazyn -> Produkty`: dane hurtowni przy produkcie
   - endpoint: `GET /admin/wholesale/product-offers?productIds=id1,id2`;
   - panel powinien wysyłać ID produktów widocznych na aktualnej stronie;
   - odpowiedź jest pogrupowana po `warehouseProductId`;
   - domyślna prezentacja: najlepsza oferta według najniższej ceny zakupu, a gdy ceny brak - najnowszy sync;
   - przy braku danych pokazać prosty stan `Brak danych z hurtowni`.

Preview CSV:

```text
POST /admin/wholesale/providers/preview
```

```json
{
  "feedUrl": "URL_FEEDU_CSV",
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
      "code": "SKU1",
      "ean": "590123",
      "name": "Produkt testowy",
      "stock": "12",
      "price_net": "4,50"
    }
  ],
  "totalPreviewRows": 1,
  "delimiter": ";"
}
```

Zapis providera:

```text
POST /admin/wholesale/providers
```

Preset Godan albo PartyDeco:

```json
{
  "name": "Godan",
  "feedUrl": "URL_FEEDU",
  "preset": "GODAN",
  "platform": "CSV_FEED",
  "syncEnabled": true,
  "syncInterval": 1440,
  "isActive": true
}
```

Custom CSV:

```json
{
  "name": "Nowa hurtownia",
  "feedUrl": "URL_FEEDU",
  "preset": "CUSTOM",
  "platform": "CSV_FEED",
  "delimiter": ";",
  "fieldMapping": {
    "sku": "code",
    "name": "name",
    "ean": "ean",
    "stock": "stock",
    "price": "price_net",
    "category": "category_path"
  },
  "syncEnabled": true,
  "syncInterval": 1440,
  "isActive": true
}
```

Wymagane pola mapowania:

- `sku`;
- `name`.

Opcjonalne, ale zalecane:

- `ean` - potrzebne do automapowania po kodzie kreskowym;
- `stock` - stan widoczny jako `lastKnownStock`;
- `price` - cena zakupu widoczna jako `lastKnownPrice`;
- `category` - kategoria z feedu.

Synchronizacja:

```text
POST /admin/wholesale/providers/:id/sync
```

```json
{
  "limit": 100
}
```

Po syncu backend tworzy albo aktualizuje `WholesaleProductMapping`. Nie tworzy produktów magazynowych, nie tworzy dokumentu `PZ` i nie zmienia `currentStock`.

Harmonogram:

```text
PUT /admin/wholesale/providers/:id/sync/interval
```

```json
{
  "intervalMinutes": 240
}
```

Zasady:

- minimum: `30` minut;
- maksimum: `1440` minut;
- zmiana interwału przelicza zadanie schedulera dla aktywnego providera z `syncEnabled=true`;
- `syncEnabled=false` albo `isActive=false` zatrzymuje zadanie.

Dane hurtowni przy produktach magazynowych:

```text
GET /admin/wholesale/product-offers?productIds=prod_1,prod_2
```

Przykładowa odpowiedź:

```json
{
  "data": {
    "prod_1": [
      {
        "mappingId": "mapping_id",
        "providerId": "provider_id",
        "providerName": "Godan",
        "providerActive": true,
        "providerSyncEnabled": true,
        "externalSku": "SKU-123",
        "externalEan": "5901234567890",
        "externalName": "Produkt z hurtowni",
        "externalCategory": "Dekoracje",
        "lastKnownStock": "12.000",
        "lastKnownPrice": "4.50",
        "lastSyncAt": "2026-05-15T12:00:00.000Z",
        "providerLastSyncAt": "2026-05-15T12:00:00.000Z"
      }
    ],
    "prod_2": []
  }
}
```

Automapowanie:

```text
POST /admin/wholesale/providers/:id/auto-map
```

```json
{
  "activeOnly": true
}
```

Odpowiedź:

```json
{
  "providerId": "provider_id",
  "scanned": 100,
  "mapped": 73,
  "mappedBySku": 60,
  "mappedByEan": 13,
  "skippedNoProduct": 27
}
```

Znaczenie liczników:

- `scanned` - liczba niepodpiętych mapowań sprawdzonych przez backend;
- `mapped` - suma pozycji podpiętych do `WarehouseProduct`;
- `mappedBySku` - dopasowania po `externalSku = WarehouseProduct.sku`;
- `mappedByEan` - dopasowania po `externalEan = WarehouseProductBarcode.ean`;
- `skippedNoProduct` - brak pasującego produktu magazynowego, to nie jest błąd.

Rekomendowany flow w panelu:

1. Operator dodaje hurtownię albo wybiera istniejącą.
2. Dla `CUSTOM` panel robi preview CSV i zapisuje `fieldMapping`.
3. Operator uruchamia `Synchronizuj`.
4. Panel pokazuje log syncu i listę mapowań.
5. Operator klika `Automapuj`.
6. Panel pokazuje wynik automapowania i odświeża listę mapowań.
7. Pozostałe `skippedNoProduct` zostają do ręcznego podpięcia albo przyszłego tworzenia produktu z mapowania hurtowni.

### Etap 4: workflow importu produktów ze sklepu

Cel: dać panelowi admina pełny proces obsługi importu produktów z PrestaShop bez ręcznego klikania każdego mapowania osobno.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- model `ShopProductImportLog` - wdrożone;
- logowanie wyniku `POST /admin/shop-mappings/import/:shopId` - wdrożone;
- historia importów produktów sklepu - wdrożone;
- automatyczne mapowanie po SKU - wdrożone;
- hurtowe tworzenie produktów magazynowych z mapowań - wdrożone;
- wybór `catalogId` przy hurtowym tworzeniu produktów - wdrożone.

Endpointy Etapu 4:

```text
POST /admin/shop-mappings/import/:shopId
GET  /admin/shop-mappings/import-logs?page=1&limit=50&shopId=&status=

POST /admin/shop-mappings/bulk/auto-map
POST /admin/shop-mappings/bulk/create-products
```

Przykładowy import z PrestaShop:

```json
{
  "limit": 500,
  "activeOnly": true
}
```

Przykładowe automatyczne mapowanie po SKU:

```json
{
  "shopId": "shop_id",
  "activeOnly": true
}
```

Przykładowe hurtowe tworzenie produktów magazynowych:

```json
{
  "mappingIds": ["mapping_id_1", "mapping_id_2"],
  "catalogId": "catalog_id"
}
```

Odpowiedź bulk create rozróżnia:

- `created` - powstał nowy `WarehouseProduct`;
- `linkedExisting` - istniał już produkt magazynowy o tym SKU i mapowanie zostało podpięte;
- `skippedAlreadyMapped` - mapowanie było już podpięte;
- `failed` i `errors` - pozycje, których nie udało się obsłużyć.

Wytyczne dla panelu admina:

1. Dodać widok albo zakładkę `Import produktów sklepu`
   - wybór sklepu;
   - limit importu;
   - przełącznik `tylko aktywne`;
   - przycisk `Importuj z PrestaShop`.

2. Po imporcie pokazać wynik i historię
   - `fetched`, `created`, `updated`, `skipped`, `skippedNoSku`;
   - tabelę z `GET /admin/shop-mappings/import-logs`;
   - błędy z `errorMessage`, jeśli status to `FAILED`.

3. Dodać akcję `Automapuj po SKU`
   - wywołać `POST /admin/shop-mappings/bulk/auto-map`;
   - po zakończeniu odświeżyć listę mapowań;
   - pokazać liczby `scanned`, `mapped`, `skippedNoProduct`.

4. Dodać hurtowe tworzenie produktów magazynowych
   - operator zaznacza niezamapowane pozycje;
   - wybiera katalog docelowy albo zostawia domyślny;
   - panel woła `POST /admin/shop-mappings/bulk/create-products`;
   - po odpowiedzi pokazuje, ile produktów utworzono, ile podpięto do istniejącego SKU, a ile pominięto.

Decyzja na start:

- import PrestaShop nadal nie tworzy produktów magazynowych automatycznie;
- Etap 4 automapował produkty po SKU;
- EAN z PrestaShop i automapowanie po EAN zostały przeniesione do Etapu 5;
- panel powinien wymagać świadomej decyzji operatora przed hurtowym utworzeniem produktów.

Efekt końcowy:

- operator importuje katalog sklepu;
- widzi historię importów;
- może jednym kliknięciem podpiąć produkty po SKU;
- może hurtowo utworzyć brakujące produkty magazynowe w wybranym katalogu.

### Etap 5: import PrestaShop z EAN i readiness

Cel: domknąć import produktów sklepu jako przewidywalny proces przed kliknięciem `Importuj`, z lepszym mapowaniem po EAN.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- `ShopProductMapping.externalEan` - wdrożone;
- migracja `external_ean` i indeks `[tenantId, externalEan]` - wdrożone;
- `PrestaShopClient.fetchProducts` pobiera `ean13` - wdrożone;
- import PrestaShop zapisuje `externalEan` - wdrożone;
- preview importu bez zapisu do bazy - wdrożone;
- automapowanie najpierw po SKU, potem po EAN z `WarehouseProductBarcode` - wdrożone;
- readiness endpoint dla sklepu - wdrożone.

Endpointy Etapu 5:

```text
GET  /admin/shops/:id/import-readiness
POST /admin/shop-mappings/import/:shopId/preview
POST /admin/shop-mappings/import/:shopId
POST /admin/shop-mappings/bulk/auto-map
```

Przykładowy readiness:

```text
GET /admin/shops/shop_1/import-readiness
```

Odpowiedź pokazuje:

- czy sklep jest wspierany (`PRESTASHOP`);
- czy sklep jest aktywny;
- czy ma API key;
- czy tenant ma domyślny katalog;
- ile jest mapowań, ile podpiętych i ile niepodpiętych;
- ostatni log importu.

Przykładowy preview:

```json
{
  "limit": 100,
  "activeOnly": true
}
```

Preview zwraca:

- `fetched`;
- `willCreate`;
- `willUpdate`;
- `skippedNoSku`;
- `withEan`;
- `possibleAutoMapBySku`;
- `possibleAutoMapByEan`;
- `sample` pierwszych pozycji z akcją `CREATE`, `UPDATE` albo `SKIP_NO_SKU`.

Wytyczne dla panelu admina:

1. Przed importem pobrać `GET /admin/shops/:id/import-readiness`
   - jeśli `ready=false`, pokazać checklistę braków;
   - jeśli brakuje domyślnego katalogu, odesłać operatora do katalogów magazynu;
   - jeśli brakuje API key albo sklep jest nieaktywny, odesłać do konfiguracji sklepu.

2. Dodać przycisk `Podejrzyj import`
   - woła `POST /admin/shop-mappings/import/:shopId/preview`;
   - pokazuje liczby nowych/aktualizowanych pozycji;
   - pokazuje informację, ile produktów ma EAN i ile można automapować.

3. Po imporcie uruchomić albo zaproponować `Automapuj`
   - backend mapuje po SKU;
   - jeśli SKU nie znajdzie produktu, backend próbuje EAN przez `WarehouseProductBarcode`;
   - odpowiedź rozróżnia `mappedBySku` i `mappedByEan`.

Efekt końcowy:

- operator wie przed importem, czy integracja jest gotowa;
- import zachowuje EAN ze sklepu;
- mapowania mogą podpiąć się automatycznie również wtedy, gdy SKU się różni, ale EAN pasuje.

### Etap 6: elastyczny preview i mapper CSV hurtowni

Cel: pozwolić operatorowi dodać nowy plik CSV bez zmian w kodzie backendu.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- `POST /admin/wholesale/providers/preview` - wdrożone;
- walidacja separatora CSV - wdrożone;
- limit próbek od 1 do 50 - wdrożone;
- obsługa separatora `\t` dla TSV - wdrożone;
- `CUSTOM` `fieldMapping` w syncu providera - wdrożone wcześniej i utrzymane;
- URL feedu nie jest zapisywany przez preview - wdrożone.

Endpoint Etapu 6:

```text
POST /admin/wholesale/providers/preview
```

Przykładowe body:

```json
{
  "feedUrl": "URL_FEEDU_CSV",
  "delimiter": ";",
  "limit": 5
}
```

Przykładowa odpowiedź:

```json
{
  "columns": ["code", "ean", "name", "stock", "price_net"],
  "sampleRows": [
    {
      "code": "SKU1",
      "ean": "590123",
      "name": "Produkt testowy",
      "stock": "12",
      "price_net": "4,50"
    }
  ],
  "totalPreviewRows": 1,
  "delimiter": ";"
}
```

Wytyczne dla panelu admina:

1. Dodać kreator `Dodaj hurtownię z CSV`
   - krok 1: URL feedu i separator;
   - krok 2: preview kolumn;
   - krok 3: mapowanie kolumn na `sku`, `name`, `ean`, `stock`, `price`, `category`;
   - krok 4: zapis providera jako `CUSTOM` albo wybranego presetu.

2. Nie zapisywać URL-i z tokenami w stanie aplikacji dłużej niż potrzeba
   - URL trafia do backendu w preview;
   - zapis URL-a do bazy następuje dopiero przy `POST /admin/wholesale/providers`.

3. Po zapisie providera użyć istniejącego syncu
   - `POST /admin/wholesale/providers/:id/sync`;
   - potem `GET /admin/wholesale/providers/:id/logs`;
   - potem `GET /admin/wholesale/providers/:id/mappings`.

Efekt końcowy:

- Godan i PartyDeco nadal działają przez presety;
- nowy niestandardowy CSV można dodać bez deployu backendu;
- operator widzi kolumny i przykładowe dane przed zapisaniem konfiguracji.

### Etap 7: automapowanie produktów hurtowni

Cel: ograniczyć ręczne podpinanie produktów hurtowni do magazynu po synchronizacji CSV.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- `POST /admin/wholesale/providers/:id/auto-map` - wdrożone;
- mapowanie po SKU (`externalSku` -> `WarehouseProduct.sku`) - wdrożone;
- fallback po EAN (`externalEan` -> `WarehouseProductBarcode.ean`) - wdrożone;
- wynik z licznikami `mappedBySku`, `mappedByEan`, `skippedNoProduct` - wdrożone;
- operacja nie zmienia stanów magazynowych i nie tworzy dokumentów `PZ`.

Endpoint Etapu 7:

```text
POST /admin/wholesale/providers/:id/auto-map
```

Przykładowe body:

```json
{
  "activeOnly": true
}
```

Przykładowa odpowiedź:

```json
{
  "providerId": "wholesale_provider_godan_default",
  "scanned": 100,
  "mapped": 73,
  "mappedBySku": 60,
  "mappedByEan": 13,
  "skippedNoProduct": 27
}
```

Wytyczne dla panelu admina:

1. Dodać akcję `Automapuj`
   - dostępna na szczegółach providera albo nad tabelą mapowań;
   - po akcji odświeżyć `GET /admin/wholesale/providers/:id/mappings`.

2. Pokazać wynik operatorowi
   - ile pozycji przeskanowano;
   - ile podpięto po SKU;
   - ile podpięto po EAN;
   - ile nadal wymaga ręcznego mapowania.

3. Nie traktować `skippedNoProduct` jako błąd
   - to normalny wynik, gdy magazyn nie ma jeszcze odpowiadających produktów;
   - operator może później utworzyć produkt magazynowy albo zostawić pozycję jako kandydat.

Efekt końcowy:

- po synchronizacji hurtowni operator może jednym kliknięciem podpiąć dużą część produktów;
- EAN z feedów hurtowni zaczyna realnie pomagać;
- nadal nie ma automatycznego przyjęcia towaru ani zmiany `currentStock`.

### Sprint operacyjny 1: widoczność i kontrola magazynu

Cel: dać panelowi admina jeden punkt startowy do pokazania operatorowi, co wymaga uwagi w magazynie.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- `GET /admin/warehouse/dashboard` - zbiorczy dashboard problemów magazynu;
- rozszerzenie `GET /admin/warehouse/products` o filtry operacyjne;
- liczniki produktów bez EAN, bez mapowania sklepu, bez oferty hurtowni;
- lista produktów z niskim albo ujemnym stanem;
- lista ostatnich błędów stock sync do sklepów;
- lista ostatnich błędów sync hurtowni;
- bez migracji i bez zmiany modelu danych.

Endpoint dashboardu:

```text
GET /admin/warehouse/dashboard?lowStockThreshold=1&limit=10&failedSinceDays=7
```

Parametry:

- `lowStockThreshold` - próg niskiego stanu, domyślnie `1`;
- `limit` - liczba pozycji w każdej sekcji, od `1` do `50`, domyślnie `10`;
- `failedSinceDays` - ile dni wstecz liczyć błędy sync, od `1` do `90`, domyślnie `7`.

Odpowiedź:

```json
{
  "summary": {
    "totalProducts": 120,
    "activeProducts": 118,
    "inactiveProducts": 2,
    "lowStockProducts": 8,
    "negativeStockProducts": 1,
    "productsWithoutBarcode": 14,
    "productsWithoutShopMapping": 9,
    "productsWithoutWholesaleOffer": 30,
    "failedStockSyncLogs": 2,
    "failedWholesaleSyncLogs": 1,
    "draftDocuments": 3
  },
  "thresholds": {
    "lowStockThreshold": 1,
    "failedSinceDays": 7,
    "limit": 10
  },
  "sections": {
    "lowStockProducts": [],
    "negativeStockProducts": [],
    "productsWithoutBarcode": [],
    "productsWithoutShopMapping": [],
    "productsWithoutWholesaleOffer": [],
    "failedStockSyncLogs": [],
    "failedWholesaleSyncLogs": []
  }
}
```

Rozszerzone filtry produktów:

```text
GET /admin/warehouse/products?stockBelow=1
GET /admin/warehouse/products?hasBarcode=false
GET /admin/warehouse/products?hasShopMapping=false
GET /admin/warehouse/products?hasWholesaleOffer=false
```

Dodatkowo odpowiedź produktu zawiera `_count`:

- `_count.barcodes`;
- `_count.shopProductMappings`;
- `_count.wholesaleMappings`.

Dotyczy to zarówno `GET /admin/warehouse/products`, jak i `GET /admin/warehouse/products/:id`.

Wytyczne dla panelu admina:

1. Dodać kafle/liczniki na dashboardzie magazynu
   - niski stan;
   - ujemny stan;
   - brak EAN;
   - brak mapowania sklepu;
   - brak oferty hurtowni;
   - błędy sync.

2. Każdy kafel powinien prowadzić do listy produktów z odpowiednim filtrem
   - niski stan: `stockBelow`;
   - brak EAN: `hasBarcode=false`;
   - brak mapowania sklepu: `hasShopMapping=false`;
   - brak oferty hurtowni: `hasWholesaleOffer=false`.

3. Błędy sync pokazywać jako rzeczy do sprawdzenia, nie jako blokadę pracy
   - stock sync można ponawiać przez istniejące `POST /admin/warehouse/stock-sync-logs/:id/retry`;
   - błędy hurtowni prowadzą do `Integracje -> Hurtownie -> Logi`.

Efekt końcowy:

- operator zaczyna dzień od widoku priorytetów;
- produkty wymagające porządkowania są łatwe do znalezienia;
- panel nie musi wykonywać wielu osobnych zapytań tylko po to, żeby policzyć problemy.

### Etap 8: synchronizacja cen do sklepów

Cel: rozdzielić cenę zakupu, cenę sprzedaży i publikację ceny do sklepów.

Status backend/API: wdrożone w `kp-api` 2026-05-15.

Zakres backend:

- model `PriceSyncLog` - wdrożone;
- migracja `price_sync_logs` - wdrożone;
- kolejka `price-sync` i worker BullMQ - wdrożone;
- klient ceny dla PrestaShop Webservice - wdrożone;
- endpoint ręcznej synchronizacji ceny produktu - wdrożone;
- logi synchronizacji cen i retry z poziomu API - wdrożone;
- później klient ceny dla WooCommerce;
- opcja `autoCalculateRetail` według marży albo reguły tenanta.

Endpointy Etapu 8:

```text
POST /admin/warehouse/products/:id/sync-price
GET  /admin/warehouse/price-sync-logs?page=1&limit=50&status=FAILED&shopId=&warehouseProductId=&dateFrom=&dateTo=
POST /admin/warehouse/price-sync-logs/:id/retry
```

Przykładowe body synchronizacji ceny do jednego sklepu:

```json
{
  "shopId": "shop_id"
}
```

Bez `shopId` backend kolejkuje synchronizację do wszystkich aktywnych mapowań produktu.

Decyzja na start:

- synchronizujemy tylko `retailPrice`;
- `purchasePrice` zostaje wewnętrzne;
- worker zawsze czyta aktualną `retailPrice` z bazy w chwili wykonania joba;
- price groups, promocje i cenniki per sklep odkładamy na później.

Efekt końcowy:

- zmiana ceny magazynowej może trafić do sklepów kontrolowanym procesem;
- operator ma log sukcesów i błędów;
- ceny nie mieszają się z logiką stanów.

### Etap 9: dokładniejsza kontrola stanów

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

### Etap 10: przyszły produkt/PIM

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
| 1 | P0 | Panel katalogów i filtr produktów po katalogu | Backend katalogów jest gotowy, operator musi móc z niego korzystać |
| 2 | P0 | Dashboard magazynu i filtry operacyjne produktów | Jeden punkt startowy do pracy z brakami i błędami |
| 3 | P1 | Logi stock sync, historia ruchów, ponowienie syncu, rozbieżności | Mniej ręcznej diagnostyki i szybsze naprawianie stanów |
| 4 | P1 | Panel hurtowni: provider, preview CSV, sync, logi, mapowania, auto-map | Backend integracji hurtowni jest gotowy, brakuje workflow operatora |
| 5 | P1 | Import produktów sklepu: readiness, preview, automapowanie, bulk create | Pełny proces importu bez ręcznego klikania każdej pozycji |
| 6 | P2 | Alerty stanów, rezerwacje, raporty | Dojrzałość operacyjna po ustabilizowaniu podstaw |
| 7 | P3 | Produkt/PIM | Dopiero po stabilnym magazynie |

### Backlog wykonawczy dla panelu admina

P0:

- `Magazyn -> Katalogi`: lista, dodawanie, edycja, usuwanie, blokada usuwania katalogu domyślnego i katalogu z produktami.
- `Magazyn -> Produkty`: filtr katalogu, kolumna katalogu, liczniki EAN/mapowań/ofert, filtry `stockBelow`, `hasBarcode`, `hasShopMapping`, `hasWholesaleOffer`.
- Formularz produktu: wybór aktywnego katalogu przy tworzeniu i edycji, z domyślnym katalogiem jako wartością startową.
- Mapowania sklepu: modal wyboru katalogu przy tworzeniu produktu magazynowego z mapowania.
- Dashboard magazynu: kafle problemów z `GET /admin/warehouse/dashboard` prowadzące do odpowiednio przefiltrowanych list.

P1:

- Logi stock sync: tabela, filtry, podgląd błędu i akcja `Ponów sync`.
- Karta produktu: sekcja ruchów magazynowych z filtrami typu/statusu/daty.
- Rozbieżności stanów: widok `currentStock` kontra stan liczony z dokumentów oraz akcja przeliczenia cache.
- `Integracje -> Hurtownie`: lista providerów, szczegóły, sync ręczny, harmonogram, logi i tabela mapowań.
- Kreator hurtowni CSV: preview, mapowanie kolumn, zapis providera, uruchomienie syncu i auto-mapowanie.
- Import produktów sklepu: readiness, preview importu, automapowanie po SKU/EAN i bulk create produktów w wybranym katalogu.

P2:

- Alerty i raporty stanów po stabilizacji panelu operacyjnego.

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
