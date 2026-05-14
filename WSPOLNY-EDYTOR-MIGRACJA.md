# Wspolny Edytor Szablonow - Zadanie i Plan Migracji

## Cel

Zastapic dwa rozne edytory/renderery:

- `admin/src/components/template-editor/editor-canvas.tsx`
- `client/src/components/fabric-preview-editor.tsx`

jednym wspolnym silnikiem edytora opartym o Fabric.js, wspoldzielonym przez `admin` i `client`.

Docelowo oba widoki maja korzystac z tych samych:

- danych z bazy (`layoutJson`, `forms`, `layoutOverrides`)
- zasad renderowania warstw
- zasad skalowania
- logiki `text` i `textbox`
- logiki drag / resize / rotate

Roznice miedzy `admin` i `client` maja wynikac tylko z uprawnien i otoczki UI.

## Problem dzisiaj

Aktualny stan:

- `admin` ma osobny renderer canvas
- `client` ma osobny renderer preview/editor
- oba komponenty maja zduplikowana logike renderowania warstw
- oba komponenty inaczej licza skale i zachowanie obiektow
- bugfix w jednym miejscu nie daje automatycznie poprawki w drugim

Przyklady skutkow:

- rozjazdy wygladu admin vs klient
- rozjazdy `textbox`
- rozne zachowanie placeholderow i wartosci formularza
- rozjazdy w `layoutOverrides`
- wiecej ryzyka regresji przy kazdej zmianie

## Decyzja architektoniczna

Rekomendacja:

- utworzyc lokalna biblioteke w `packages/template-editor`
- nie robic jednego wielkiego komponentu ekranowego
- wydzielic wspolny `canvas engine`
- zostawic osobne wrappery:
  - `AdminTemplateEditor`
  - `ClientTemplateEditor`

## Proponowana struktura

```text
packages/
  template-editor/
    src/
      core/
        canvas-engine.ts
        layer-factory.ts
        geometry.ts
        permissions.ts
        font-loader.ts
        overrides.ts
        text-behavior.ts
      react/
        TemplateCanvas.tsx
      types/
        index.ts
      index.ts
```

Wrappery aplikacyjne:

```text
admin/src/components/template-editor/
  AdminTemplateEditor.tsx

client/src/components/
  ClientTemplateEditor.tsx
```

## Zakres biblioteki

Biblioteka ma zawierac:

- render warstw `background`, `image`, `text`, `static_text`, `textbox`
- wspolna logike scale / viewport / resize observer
- ladowanie fontow
- mapowanie `layoutJson -> fabric objects`
- mapowanie `fabric objects -> layoutOverrides`
- zasady interakcji zalezne od `permissions`
- callbacki typu:
  - `onValueChange`
  - `onLayoutOverridesChange`
  - `onSelectionChange`
  - `onCanvasReady`

Biblioteka nie powinna zawierac:

- wywolan API
- React Query
- routingu Next.js
- paneli admina
- formularza klienta
- toolbarow, list warstw, property paneli

## Model uprawnien

Proponowany kontrakt:

```ts
type EditorMode = 'admin' | 'client'

interface EditorPermissions {
  canEditText: boolean
  canMove: boolean
  canResize: boolean
  canRotate: boolean
  canSelectLockedLayers?: boolean
  showSelectionBorders?: boolean
}
```

Dla klienta uprawnienia beda dodatkowo ograniczane przez dane warstwy:

- `clientDraggable`
- `clientResizable`
- `clientRotatable`

## Dane wejsciowe

Wspolny komponent powinien przyjmowac:

```ts
interface TemplateCanvasProps {
  layout: TemplateLayoutJson
  values: Record<string, string>
  layoutOverrides?: LayoutOverrides | null
  mode: 'admin' | 'client'
  permissions: EditorPermissions
  apiUrl?: string
  height?: number
  onValueChange?: (fieldKey: string, value: string) => void
  onLayoutOverridesChange?: (overrides: LayoutOverrides) => void
  onSelectionChange?: (layerId: string | null) => void
  onCanvasReady?: (canvas: unknown) => void
}
```

## Etapy wdrozenia

### Etap 1 - przygotowanie shared layer

1. Utworzyc `packages/template-editor`.
2. Skopiowac tylko wspolne typy i helpery.
3. Wydzielic wspolne funkcje:
   - ladowanie fontow
   - liczenie viewport / scale
   - tworzenie obiektow Fabric
   - ekstrakcja overrides

### Etap 2 - wspolny renderer

1. Zbudowac `TemplateCanvas.tsx`.
2. Przeniesc do niego logike renderu z `admin` i `client`.
3. Ujednolicic:
   - pozycjonowanie
   - `originX/originY`
   - skale obrazow
   - zachowanie `Textbox`
   - placeholdery i podstawianie wartosci formularza

### Etap 3 - klient

1. Podmienic `client/src/components/fabric-preview-editor.tsx` na wrapper nad biblioteka.
2. Zostawic tymczasowo legacy fallbacki hardcoded tylko dla kompatybilnosci wstecznej.
3. Zostawic klientowi tylko:
   - formularz
   - submit / draft / preview
   - obsluge mutacji

Status:

- wykonane dla dynamicznych layoutow z bazy
- `client` korzysta juz ze wspolnego `TemplateCanvas`
- legacy fallback klienta zostal usuniety w ramach porzadkow po migracji

### Etap 4 - admin

1. Podmienic `admin/src/components/template-editor/editor-canvas.tsx` na wrapper nad biblioteka.
2. Zostawic po stronie admina:
   - toolbar
   - warstwy
   - panel wlasciwosci
   - tryb klienta

### Etap 5 - porzadki

1. Usunac zdublowane implementacje.
2. Usunac helpery specyficzne tylko dla starego klienta.
3. Sprawdzic importy typow i zaleznosci.

## Kryteria akceptacji

Migracje uznajemy za zakonczona, gdy:

- ten sam layout wyglada tak samo w `admin` i `client`
- `text` i `textbox` maja to samo zachowanie po obu stronach
- `layoutOverrides` dzialaja identycznie
- klient i admin korzystaja z jednego wspolnego renderera
- brak fallbackow hardcoded dla layoutow z bazy

## Testy po wdrozeniu

### Testy manualne

1. Porownanie tego samego szablonu w `admin` i `client`.
2. Porownanie `text`.
3. Porownanie `textbox`.
4. Porownanie tla i assetow.
5. Drag / resize / rotate dla klienta.
6. Save draft -> reopen -> submit.
7. Finalny PDF z `layoutOverrides`.

### Testy regresyjne

1. Snapshoty warstw dla wybranych szablonow.
2. Testy mapowania `layout -> fabric object`.
3. Testy mapowania `fabric object -> layoutOverrides`.

## Uwagi operacyjne

- `Textbox` jest najbardziej ryzykownym elementem migracji.
- Najpierw przepiac `client`, potem `admin`.
- Nie laczyc biblioteki z API ani z komponentami UI panelu.
- W czasie migracji utrzymac cienkie wrappery, zeby nie zrobic jednego komponentu "do wszystkiego".

## Stan na teraz

Aktualnie:

- `layoutOverrides` dzialaja end-to-end
- reczne zamowienia tworza `personalization_cases`
- `client` korzysta ze wspolnego `TemplateCanvas`
- `admin` renderuje canvas przez te sama biblioteke
- trwa stabilizacja po migracji i reczny QA zgodnosci renderu

## Status wdrozenia

### Etap 1 - wykonany

Utworzono szkielet biblioteki:

- `packages/template-editor/package.json`
- `packages/template-editor/tsconfig.json`
- `packages/template-editor/src/types/index.ts`
- `packages/template-editor/src/core/geometry.ts`
- `packages/template-editor/src/core/overrides.ts`
- `packages/template-editor/src/core/permissions.ts`
- `packages/template-editor/src/core/font-loader.ts`
- `packages/template-editor/src/react/TemplateCanvas.tsx`
- `packages/template-editor/src/index.ts`

Etap 1 nie przepina jeszcze `admin` ani `client`.

### Etap 2 - wykonany

Do biblioteki przeniesiono:

- wspolny viewport / scale
- wspolny `TemplateCanvas`
- wspolne helpery renderowania warstw
- wspolny emitter `layoutOverrides`

Dodane pliki:

- `packages/template-editor/src/core/layer-factory.ts`
- `packages/template-editor/src/core/layout-overrides-emitter.ts`

Rozszerzone pliki:

- `packages/template-editor/src/react/TemplateCanvas.tsx`
- `packages/template-editor/src/index.ts`

### Etap 3 - wykonany

Zrobiono:

1. `client` zostal podpiety do `TemplateCanvas`
2. formularz, draft, submit i preview zostaly zachowane po stronie aplikacji
3. `layoutOverrides` sa zbierane i resetowane z poziomu klienta
4. normalizacja opcji `radio` / `select` obsluguje dane stringowe z bazy
5. legacy hardcoded preview po stronie klienta zostal usuniety

### Etap 4 - wykonany

Zrobiono:

1. `admin/src/components/template-editor/editor-canvas.tsx` zostal przepiety na wrapper nad biblioteka
2. `admin` i `client` transpiluja lokalny pakiet `@kreatywne-papierki/template-editor`
3. renderer warstw, skala i ladowanie fontow sa wspoldzielone
4. naprawiono petle selekcji i odswiezanie canvasu po zmianie layoutu / permissions

### Etap 5 - w toku

Pozostalo:

1. reczny QA `admin` vs `client` vs finalny PDF
2. domkniecie zgodnosci renderu dla wszystkich przypadkow brzegowych
3. usuniecie pozostalych helperow legacy i nieuzywanego kodu
4. testy regresji dla `text`, `textbox`, tla i assetow

## Lista wysokiego priorytetu

1. Zweryfikowac zapis i odczyt:
   - koloru tekstu
   - fontu
   - rozmiaru fontu
   - `clientDraggable`
   - `clientResizable`
   - `clientRotatable`
2. Porownac ten sam szablon w:
   - `admin`
   - `client`
   - finalnym PDF
3. Potwierdzic poprawne ladowanie:
   - teł
   - assetow
   - fontow globalnych
4. Udokumentowac znane ograniczenia i otwarte regresje po migracji
