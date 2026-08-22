# Hurtownia Netuno — feed ze scrapera

Netuno nie udostępnia feedu ani API. Stany, ceny i parametry pochodzą ze
scrapowania sklepu, ale dalej idą **zwykłym pipeline'em `CSV_FEED`** — sync,
staging, walidacja spadku feedu i publikacja stanów do sklepów działają bez
żadnych odstępstw.

## Jak to jest poskładane

```
scrape-netuno.ts  ──►  storage/wholesale/netuno-koperty.csv  ──►  provider CSV_FEED  ──►  magazyn
   (scraper)                     (feedUrl: file://)                  (preset NETUNO)
```

1. [scrape-netuno.ts](../src/scripts/scrape-netuno.ts) chodzi po kategorii,
   pobiera karty produktów i zapisuje CSV.
2. Provider `Netuno` (platforma `CSV_FEED`, preset `NETUNO`) czyta ten plik.
3. `--sync` wyzwala synchronizację od razu po zapisie feedu.

Skąd biorą się dane: [netuno-scraper.ts](../src/services/admin/wholesale/netuno-scraper.ts)
odpytuje `<url-produktu>?ajax=1&action=refresh`. Endpoint oddaje komplet w
~58 KB zamiast ~370 KB pełnej strony, a w środku siedzi atrybut `data-product`
— strukturalny JSON produktu (97 pól). To jest źródło prawdy; tekst strony
parsujemy tylko dla EAN-u, którego w tym JSON-ie nie ma.

## Uruchamianie

```bash
npx tsx src/scripts/setup-netuno-provider.ts --apply
```

```bash
npx tsx src/scripts/scrape-netuno.ts --sync
```

Na produkcji nie ma `tsx` — tam `pnpm netuno:setup` i `pnpm netuno:scrape --sync`
(patrz [operations.md](operations.md)).

Domyślnie bierze `https://netuno.pl/koperty-11` — 1325 kopert wraz z
podkategoriami, ok. 13 minut. Inną kategorię wskazuje `--category`, a `--limit`
przycina zakres do szybkiego testu.

Sensowny cykl to raz na kilka dni. Interwał `syncEnabled` **nie** jest do tego
używany: walidator dopuszcza maksymalnie 24 h, a sync musi ruszać PO scraperze,
nie niezależnie od niego. Dlatego provider ma `syncEnabled = false`, a kolejność
wymusza `--sync`. Cron powinien wołać sam skrypt.

## Wiązanie z magazynem

Indeks Netuno to ten sam ciąg co SKU w magazynie (`NE120KKG22/K153-DE`), więc
`autoMapWholesaleProvider` w trybie `sku_ean` wiąże pozycje automatycznie.
Scrapujemy **cały** katalog kopert, ale mapowania bez odpowiednika w magazynie
zostają z `warehouseProductId = null` — leżą jako katalog ofertowy ze stanami i
cenami, gotowe pod `bulkCreateWarehouseProductsFromWholesale`.

Feed niesie też `description` i `photos`, więc „Utwórz w sklepie" przenosi opis
i zdjęcia — `extractPublicationData` czyta je wprost z `payloadJson` mapowania.

## Pułapki

**Sitemap Netuno jest zepsuty.** Wszystkie 19 plików `sitemap/product/N.xml`
zwracają te same 250 produktów. Stąd chodzenie po kategoriach, nie po sitemapie.

**Do listingu każdej kategorii doklejany jest produkt promocyjny** (papier
pakowy w roli). Bez filtra `PROMO_NOISE` kategoria deklarująca 56 pozycji
zwraca 57.

**Próg ilościowy bywa rabatem, nie ceną.** PrestaShop zapisuje wtedy
`price: -1`, a prawdziwa wartość siedzi w `reduction` + `reduction_type`.
Wzięte dosłownie dałoby ujemną cenę zakupu — przelicza to `resolveTierPrice`.

**`price_net` to cena katalogowa za jedną sztukę**, świadomie bez progów.
Realna cena zakupu wchodzi dokumentem PZ i to z niej liczy się
`averagePurchaseCost`. Progi lądują w `price_best_tier` / `tier_from` /
`tiers_json` jako informacja przy zamawianiu.

**Kolumna zdjęć nazywa się `photos`, nie `images`** — `parseImageUrls` dzieli
wartość po przecinku tylko dla tej nazwy (albo dla presetu PARTYDECO).

**Ten sam indeks potrafi siedzieć na dwóch produktach** (np. `NC50BSZ/K70` na
wariancie 50 szt. i 100 szt. — różne ceny). Scraper zostawia pierwszy i
raportuje konflikt; warto wtedy zajrzeć na obie karty.

**Feed nie jest nadpisywany przy masowych błędach.** Poniżej 90% poprawnych
pozycji skrypt przerywa przed zapisem — ubogi feed wyzerowałby stany w
magazynie.

**Ceny są publiczne, nie negocjowane.** To cennik katalogowy Netuno; jeśli
kiedyś dojdą indywidualne warunki widoczne dopiero po zalogowaniu, scraper
będzie potrzebował sesji.

## Czego jeszcze nie ma

Parametry (`features_json` i kolumny `format`, `kolor`, `gramatura`, …) trafiają
do feedu i do `payloadJson`, ale **nie** są przenoszone do PrestaShopu jako
cechy produktu — `PrestaShopClient` nie obsługuje jeszcze `product_features`.
Naturalne następne kroki to wpięcie ich w generator opisów AI
(`AiContentProposalInput` ma już pole `features`) i dopisanie obsługi cech
w kliencie.
