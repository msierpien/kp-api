# Arkusze zbiorcze i pasery Print & Cut

Jak zrobić szablon, który drukuje się po kilka sztuk na jednym arkuszu i jest
wycinany na ploterze Silhouette.

Uzupełnienie [dodawanie-szablonow.md](dodawanie-szablonow.md) — tam jest przepis
na sam projekt, tu tylko to, co dochodzi przy składzie arkuszowym.

## Po co osobny mechanizm

Domyślnie ziarnem paczki do druku jest **jedna sztuka = jeden plik**. Przy
cięciu ploterem to nie działa: ploter potrzebuje na wydruku **paserów**
(znaczników pozycjonujących), a te odnoszą się do całego arkusza, nie do
pojedynczej kartki. Stąd blok `imposition` w `layoutJson` — zmienia ziarno
paczki na **arkusz**.

Nie mylić z istniejącym blokiem `print`: tam na wspólny arkusz składają się
**strony jednego egzemplarza** (przód i tył winietki). Tu — **kolejne sztuki
z zamówienia**.

## Format

`imposition` w `layoutJson` (typy w `@msierpien/kp-template-core`):

```jsonc
{
  "enabled": true,
  "sheet": { "widthMm": 210, "heightMm": 297 },
  "slots": [
    { "id": "slot-1", "xMm": 18, "yMm": 18,  "rotation": 0 },
    { "id": "slot-2", "xMm": 18, "yMm": 148, "rotation": 0 }
  ],
  "marks": { "preset": "silhouette", "insetTopMm": 15.88, "armLengthMm": 10, "...": "..." },
  "backgroundUrl": "templates/KOD/sheet_background/podklad.png",
  "slotOffsetXMm": 0,
  "slotOffsetYMm": 0
}
```

Rzeczy, które łatwo przeoczyć:

- **`xMm`/`yMm` gniazda to lewy górny róg linii cięcia** (format netto). Spad,
  jeśli szablon go ma, wychodzi poza te współrzędne. Dzięki temu korekta
  w panelu znaczy dokładnie to, co operator widzi na wydruku.
- **`slotOffset*` przesuwa użytki, nie pasery.** Pasery są układem odniesienia
  plotera — przesunięcie ich razem z grafiką niczego by nie naprawiło.
- **Gniazd może być więcej niż sztuk.** Ostatni arkusz niepełnego zamówienia
  zostaje z pustym miejscem, ale z kompletem paserów.
- Sztuki idą w gniazda po kolei: `slots[0]` dostaje pierwszą sztukę arkusza.
  Liczba arkuszy to `ceil(qty / slots.length)`.

## Pasery

Domyślne wartości (`SILHOUETTE_MARKS_DEFAULT`) odtwarzają plik wyeksportowany
ze Silhouette Studio przy ustawieniach domyślnych funkcji Print & Cut:
wstawka 15,88 mm (0,625"), długość ramienia 10 mm, grubość 0,5 mm.

Każdy z czterech rogów to kąt prosty otwarty do środka arkusza. **Ramiona
poziome po prawej są krótsze (5 mm)** — tak rysuje je Silhouette i na takich
plikach ploter został wykalibrowany.

Pasery rysuje `drawRegistrationMarks` w
`src/services/renderer/fabric-renderer.service.ts`, **na samym końcu składania**:
paser zasłonięty użytkiem albo podkładem jest dla czujnika nieodróżnialny od
braku pasera.

Druga droga: jeśli podkład ma już wdrukowane pasery (bo powstał w Silhouette
Studio), ustaw `marks.preset: "none"` — wtedy nic nie dorysowujemy.

## Podkład arkusza

Ozdobna grafika drukowana **pod** użytkami, rozciągana na cały arkusz. Wgrywa
się ją jako `TemplateAsset` typu `SHEET_BACKGROUND`.

**Renderer nie czyta PDF** — node-canvas przyjmuje PNG/JPG (i SVG przez
rasteryzację). Plik ze Silhouette Studio trzeba przekonwertować, a jeśli
pasery generujemy sami, usunąć je z podkładu.

## Kalibracja po próbnym wydruku

1. Wygeneruj paczkę, wydrukuj jeden arkusz **bez skalowania**.
2. Wczytaj do Silhouette Studio, sprawdź czy czujnik znajduje wszystkie cztery
   pasery, potnij próbnie.
3. Zmierz, o ile cięcie mija się z grafiką.
4. W panelu → edytor szablonu → **Arkusz** wpisz różnicę w „Kalibracja użytków"
   (krok 0,1 mm) i wygeneruj paczkę ponownie.

Pozycje pojedynczych gniazd (`X`/`Y`) zmienia się tam, gdzie użytki mają być
rozstawione inaczej; `slotOffset` służy do przesunięcia **wszystkich naraz**.

## Druk

Nowy profil agenta: `zaproszenia-a4-ploter` w `tools/hotprint/config.json`.

Kluczowe pola i powód, dla którego są takie, a nie inne:

| pole | wartość | dlaczego |
|---|---|---|
| `expect_size_mm` | `[210, 297]` | plik ma rozmiar arkusza, nie kartki |
| `allow_rotated` | `false` | pasery są asymetryczne (prawe ramiona krótsze) — obrócony arkusz to zmarnowany nakład |
| `scale_to_fit` | `false` | każde skalowanie przez CUPS rozjeżdża pasery względem grafiki |
| `tolerance_mm` | `1.0` | ciaśniej niż standardowe 1,5 — tu wymiar musi się zgadzać |

Druk bezramkowy jest niepotrzebny: pasery leżą ~15,9 mm od krawędzi, czyli
w obszarze drukowalnym każdej drukarki.

## Weryfikacja bez bazy

```bash
pnpm tsx src/scripts/imposition-render-check.ts
```

Skrypt bierze layout z `create-zaproszenie-90x130-ploter-template.ts`,
przepuszcza go przez schemat Zod panelu, renderuje arkusz **tą samą ścieżką co
wydruk**, a potem **mierzy pasery na gotowym rastrze** i porównuje z
konfiguracją (tolerancja 0,2 mm). Sprawdza też arkusz niepełny i wymiar strony
PDF. Wynik w `tmp/imposition-check/`.

Raportuje dodatkowo odchyłkę od pliku referencyjnego ze Silhouette Studio —
informacyjnie, bo Silhouette liczy wstawkę od krawędzi swojego obszaru
roboczego i rozjeżdża się z A4 o ułamek milimetra (zmierzone: do 0,4 mm).

## Pułapki

- **Nowe pole formatu wymaga wpisu w `src/schemas/admin.schema.ts`.** `z.object`
  wycina nieznane klucze, więc pierwszy zapis z edytora skasowałby je po cichu.
- **Ile się mieści na A4.** Przy domyślnych paserach zostaje 175,2 × 262,2 mm.
  Dwie kartki 90 × 130 zajmują 260 mm wysokości — cały zapas to 2,2 mm, stąd
  start od 18 mm, a nie od 20. Panel ostrzega (`IMPOSITION_SLOT_HITS_MARKS`),
  gdy użytek wchodzi w strefę paserów.
- **Spad na arkuszu zbiorczym.** Ploter tnie po paserach z własną tolerancją,
  więc spad ma sens tylko wtedy, gdy użytki nie stykają się ze sobą — inaczej
  spad jednego wchodzi na sąsiada. Szablon zaproszenia 90 × 130 ma `bleedMm: 0`.
- **`PrintSettings.printOffsetXMm/YMm` działa dalej** i przesuwa cały arkusz
  razem z paserami. To kompensacja mechaniki drukarki i jest tu pożądana —
  kalibracja cięcia to osobna rzecz (`slotOffset*`).
