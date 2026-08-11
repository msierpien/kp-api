# Wzorzec: dodanie nowego szablonu personalizacji

Ścieżka „grafika z dysku → gotowy szablon na produkcji”. Powstała przy
`WINIETKA_BOTANICZNA`; ten sam bieg pasuje do każdego szablonu z tłem i
kilkoma polami.

Wzorcowa para plików:

- `src/scripts/create-winietka-botaniczna-template.ts` — zapis do bazy,
- `src/scripts/winietka-botaniczna-render-check.ts` — podgląd bez bazy.

---

## 0. Zanim dotkniesz kodu — zmierz grafikę

Nie zgaduj kadru na oko. Trzy liczby wystarczą i wszystkie da się policzyć
skryptem w `node -e` z pakietem `canvas`:

| Co | Po co |
| --- | --- |
| `width × height` i proporcja | musi zgadzać się z proporcją karty, inaczej `cover` przytnie ozdobnik |
| pas wolnego miejsca (wiersze bez ciemnych pikseli) | tam idzie ramka tekstu |
| dominujące ciemne barwy | z nich bierze się kolor tuszu i paletę |

Przykład (grafika botaniczna: 1817 × 866 px = 2,098; karta 105 × 50 mm = 2,1 —
różnica 0,05 mm, czyli `cover` nie ma czego obciąć):

```bash
node -e "const{createCanvas,loadImage}=require('canvas');(async()=>{const i=await loadImage(process.argv[1]);console.log(i.width,i.height,(i.width/i.height).toFixed(3))})()" "sciezka/do/tla.png"
```

## 1. Kroje pisma — najpierw rejestr serwera

Renderer wydruku bierze pliki **wyłącznie** z `storage/fonts`. Krój spoza
rejestru daje ładny podgląd w panelu i inny wydruk, bez żadnego ostrzeżenia.

```bash
ssh -p 10176 root@henryk176.mikrus.xyz 'docker exec personalization-api ls /app/storage/fonts'
```

Wybrany krój ściągnij też **lokalnie** do `kp-api/storage/fonts` — bez tego
render-check (krok 4) narysuje litery krojem systemowym:

```bash
ssh -p 10176 root@henryk176.mikrus.xyz 'docker cp personalization-api:/app/storage/fonts/NAZWA.ttf /tmp/NAZWA.ttf'
scp -P 10176 root@henryk176.mikrus.xyz:/tmp/NAZWA.ttf kp-api/storage/fonts/NAZWA.ttf
```

## 2. Rozmiar pisma z pomiaru, nie z oka

Renderer **nie ma auto-dopasowania**, a fabric łamie tekst tylko po SPACJACH.
Wielkość dobiera się pomiarem najdłuższego realnego wpisu — dwuczłonowe
nazwisko to jedno słowo:

```bash
node -e "
const {createCanvas, registerFont} = require('canvas');
registerFont('kp-api/storage/fonts/NAZWA.ttf', {family:'Rodzina', weight:'500'});
const ctx = createCanvas(10,10).getContext('2d');
const px2mm = v => v*25.4/300;
for (const pt of [18,20,22,24,26]) {
  const s = pt/72*300;
  ctx.font = '500 '+s+'px \"Rodzina\"';
  const w = 'Wiśniewska-Kowalczyk';
  const ls = 40/1000*s*w.length;               // letterSpacing 40/1000 em
  console.log(pt+'pt', px2mm(ctx.measureText(w).width+ls).toFixed(1)+'mm');
}"
```

Bierz największy rozmiar, który mieści najdłuższe słowo z zapasem ~8 % ramki.
Przy dwóch wierszach `lineHeight` 1,1 zamiast 1,2 — inaczej blok nie mieści się
w pasie tła.

Czego pomiar nie załatwi: pojedyncze słowo dłuższe niż ~24 znaki i tak wyjdzie
poza kartę. `maxLength` pola tego nie pilnuje (liczy całość razem ze spacjami),
więc taki wpis poprawia się ręcznie w edytorze.

### `textbox` czy `text`?

| | `textbox` | `text` (i `static_text`) |
|---|---|---|
| skład | zawija po spacjach w ramce `width`, `verticalAlign` działa | jedna linia, bez zawijania |
| co ustawia rozmiar | `fontSize` w ramce o zadanej szerokości | wyłącznie `fontSize` |
| czym jest `width`/`height` | realna ramka tekstu | **ramka kontrolna** — granica dla odpowiedzi klienta |

Dla `text` ramka **nie skaluje napisu** — ani na wydruku, ani (od 2026-08-11)
w podglądzie edytora. Służy walidacji: `answers-validation.service` bierze
`layer.width` jako maksimum i odrzuca dłuższy wpis komunikatem „Linia jest za
długa”. Ramka węższa niż napis w rozmiarze z wydruku blokuje więc zamówienie —
zmierz napis i nadaj ramce co najmniej tę szerokość (audyt istniejących
szablonów: `src/scripts/audit-text-layer-scale.ts`).

## 3. Skrypt zakładający szablon

Skopiuj `create-winietka-botaniczna-template.ts` i zmień stałe u góry. Rzeczy,
które muszą zostać takie, jakie są:

- **Idempotencja** — szukanie po `code`, `update` zamiast drugiego `create`;
  `ensureAsset` rozdziela pliki po `fileName`, więc kolejne uruchomienie nie
  mnoży kopii grafiki.
- **Tenant po slugu** — skrypt nie ma kontekstu middleware Prismy, a baza niesie
  też tenanta seedowego. Szablon wpięty do złego tenanta nie pojawi się w panelu.
- **`canvas`/`layers` jako lustro pierwszej strony** — wymaga tego format
  (`getTemplatePages`) i szukają tego starsi konsumenci.
- **`x`/`y` warstwy to ŚRODEK ramki.** Układ projektuje się krawędziami w mm,
  środek liczy helper `textbox`.
- **Tło jako `type: 'background'`, `locked: true`** — ma jedną poprawną pozycję,
  a przypadkowe przeciągnięcie w edytorze widać dopiero na wydruku.
- **Pole „per sztuka” to `scope: 'INDIVIDUAL'`** — panel wystawi wtedy tyle
  wpisów, ile sztuk w zamówieniu (lista gości). `SHARED` = jedna wartość na całe
  zamówienie.

Winietka składana ma dodatkowo arkusz podwójnej wysokości i przód obrócony
o 180°, żeby po złożeniu stała napisem do gościa:

```ts
print: {
  sheet: { widthMm: 105, heightMm: 100 },
  placements: [
    { pageId: 'page-1', xMm: 0, yMm: 0,  rotation: 180 },
    { pageId: 'page-2', xMm: 0, yMm: 50, rotation: 0 },
  ],
  mode: 'sheet',
}
```

Mockup można pominąć (`mockups` jest opcjonalne) i podłożyć zdjęcie ręcznie
w panelu.

Nowe pole formatu wymaga wpisu w schemacie Zod
`src/schemas/admin.schema.ts` — inaczej pierwszy zapis z edytora po cichu je
wytnie.

## 4. Sprawdzenie przed zapisem do bazy

Skrypt eksportuje `buildLayout` za `require.main === module`, więc da się go
zaimportować bez pisania do bazy. Render-check robi dwie rzeczy:

1. przepuszcza layout przez `templateLayoutSchema` (ten sam, który tnie zapis
   z panelu),
2. renderuje stronę **tą samą ścieżką co wydruk** (`renderPrintPagePng`).

```bash
cd kp-api
DATABASE_URL="postgresql://x:x@localhost:5432/x" \
JWT_ACCESS_SECRET="check-only-secret-check-only-secret" \
JWT_REFRESH_SECRET="check-only-secret-check-only-secret2" \
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef" \
pnpm tsx src/scripts/<szablon>-render-check.ts
```

(Zmienne są atrapami — `config` waliduje env przy imporcie renderera, do bazy
nic nie idzie.)

PNG wychodzi **obrócony o 180°**, jeśli tak mówi `print.placements` — to nie
błąd, to skład arkusza.

Gdzie naprawdę wylądował tekst, sprawdza się różnicą względem renderu z pustą
wartością pola (dopasowanie po kolorze łapie też ciemne liście):

```ts
const base = await renderPrintPagePng(layout, page, { guest_name: ' ' })
// ...render z treścią, różnica pikseli > 40 → bounding box tuszu
```

Dla `WINIETKA_BOTANICZNA` wyszło: jeden wiersz 23,3–29,0 mm, dwa wiersze
19,3–35,9 mm przy białym pasie tła 17,8–35,2 mm.

## 5. Wjazd na produkcję (bez pełnego deployu)

Kontener `personalization-api` ma tylko `dist` i zależności produkcyjne — **nie
ma `tsx`**, a nowy plik z `src/scripts` nie trafi do `dist` bez przebudowy obrazu.

```bash
cd kp-api
npx tsc src/scripts/<skrypt>.ts --outDir /tmp/build --module commonjs \
  --target ES2020 --esModuleInterop --skipLibCheck --moduleResolution node
scp -P 10176 /tmp/build/<skrypt>.js "<grafika>.png" root@henryk176.mikrus.xyz:/tmp/
ssh -p 10176 root@henryk176.mikrus.xyz '
  docker cp /tmp/<skrypt>.js personalization-api:/app/dist/scripts/<skrypt>.js
  docker exec personalization-api mkdir -p /app/tmp
  docker cp /tmp/<grafika>.png personalization-api:/app/tmp/tlo.png
  docker exec -e BG_SOURCE=/app/tmp/tlo.png personalization-api \
    node /app/dist/scripts/<skrypt>.js
'
```

Nazwy plików bez polskich znaków i spacji — przechodzą przez `scp` i `docker cp`
bez cytowania.

Po wszystkim posprzątaj kopie:

```bash
ssh -p 10176 root@henryk176.mikrus.xyz '
  rm -f /tmp/<skrypt>.js /tmp/<grafika>.png
  docker exec personalization-api rm -f /app/tmp/tlo.png
'
```

Sam skrypt zostaje w repozytorium i trafi do `dist` przy najbliższej przebudowie
obrazu.

## 6. Po zapisie

- Grafika leży w `storage/templates/<CODE>/background/` — sprawdź, że plik
  faktycznie tam jest (`docker exec personalization-api ls -l ...`).
- Mockup podłóż w panelu (zakładka Mockupy, narożniki przeciągane po zdjęciu).
- Jeśli po drodze zmieniałeś szablon w edytorze, sprawdź, co panel tam
  faktycznie zapisał — potrafi podmienić krój i **włączyć wszystkie zgody
  klienta** (`clientDraggable`, `clientFontFamily`, …), których skrypt nie
  ustawiał. Krój z edytora musi być w `storage/fonts`; renderer rozwiązuje go
  po `fontFamily` z warstwy, a nie po tablicy `layout.fonts` (ta zostaje
  z pierwotnego skryptu i po zmianie w panelu jest po prostu nieaktualna).

## 7. Publikacja jako produkt w sklepie

Wzorzec: `src/scripts/publish-winietka-botaniczna-product.ts` (bez wariantów)
albo `publish-mis-product.ts` (z atrybutem „Rodzaj papieru”).

Co robi jedno uruchomienie:

1. renderuje zdjęcie produktowe z **mockupu szablonu** (`renderMockupPng`) —
   karta pokazuje dokładnie to, co dostanie klient; PNG idzie do JPEG, bo
   PrestaShop odrzuca pliki powyżej 2000 KB,
2. zakłada/aktualizuje kartę w PrestaShop (rozpoznanie po `reference`),
3. ustawia `out_of_stock = 1` — papeteria powstaje na zamówienie, więc stan 0
   nie może zamykać sprzedaży,
4. zakłada `PersonalizedProduct` wiążący referencję z szablonem — bez tego
   zamówienie nie trafi do personalizacji.

`PHOTO_ONLY=1` zatrzymuje skrypt po zdjęciu — obejrzyj je, zanim cokolwiek
pojawi się w sklepie. Pierwsze uruchomienie warto też zrobić z
`PRODUCT_ACTIVE=0`. `REPLACE_PHOTO=1` przerysowuje zdjęcie i podmienia je
na karcie.

Cena w PrestaShop jest **netto** — brutto dzielimy przez 1,23
(1,50 zł brutto = 1.219512).

**Kombinacje nie mogą dostawać własnych referencji.** PrestaShop wpisuje do
pozycji zamówienia referencję kombinacji, jeśli ta jest ustawiona, a
dopasowanie produktu personalizowanego (`sync-orders`) szuka po referencji
produktu — własna referencja kombinacji zerwałaby dopasowanie.

Na koniec magazyn:

```bash
docker exec -e DRY_RUN=1 personalization-api node /app/dist/scripts/sync-personalization-to-shop-mappings.js
docker exec personalization-api node /app/dist/scripts/sync-personalization-to-shop-mappings.js
```

Skrypt dopina mapowanie sklepowe i kartę magazynową; `DRY_RUN=1` najpierw
pokazuje, czego dotknie.

---

## Lista kontrolna

- [ ] proporcja grafiki = proporcja karty
- [ ] krój jest w `storage/fonts` na serwerze **i** lokalnie
- [ ] rozmiar pisma z `measureText`, nie z oka
- [ ] pole per sztuka ma `scope: 'INDIVIDUAL'`
- [ ] tło `locked: true`
- [ ] layout przechodzi `templateLayoutSchema`
- [ ] render-check obejrzany okiem
- [ ] skrypt idempotentny (odpalony dwa razy nie robi drugiego szablonu)
- [ ] zdjęcie produktowe obejrzane (`PHOTO_ONLY=1`) przed publikacją
- [ ] `PersonalizedProduct` wskazuje szablon, mapowanie magazynowe dociągnięte
- [ ] karta produktu otwarta w przeglądarce: cena, minimalna ilość, zdjęcie
- [ ] `/tmp` na serwerze posprzątane
