/**
 * Warstwy jednoliniowe (`text`, `static_text`) rozciagane do ramki.
 *
 * Do wersji, w ktorej edytor przestal skalowac takie warstwy do
 * `layer.width`/`layer.height`, panel rysowal napis WCISNIETY w ramke:
 *
 *   scaleX = layer.width  / zmierzona_szerokosc_napisu
 *   scaleY = layer.height / zmierzona_wysokosc_napisu
 *
 * Renderer druku nigdy tego nie robil - sklada napis samym `fontSize`
 * (kp-api/src/services/renderer/fabric-renderer.service.ts, galaz
 * `layer.type === 'text'`). Stad dwa skutki, ktore ten skrypt nazywa po imieniu:
 *
 *  1. ROZJAZD PODGLADU Z WYDRUKIEM - projektant widzial inny stopien pisma niz
 *     szedl na papier, a pole "Rozmiar" w Typografii nie zmienialo w podgladzie
 *     nic. Po poprawce edytor pokazuje wydruk, wiec taki szablon bedzie wygladal
 *     w panelu INACZEJ NIZ DOTAD (sam wydruk sie nie zmienia).
 *
 *  2. ZA CIASNA RAMKA - dla warstwy `text` `layer.width` jest granica dla
 *     ODPOWIEDZI KLIENTA (kp-api/src/services/renderer/answers-validation.service.ts
 *     -> text-validator.service.ts: "Linia jest za dluga" blokuje zamowienie).
 *     Ramka wezsza niz napis w rozmiarze z wydruku byla w starym podgladzie
 *     niewidoczna - napis i tak dopasowywal sie do ramki - a klientowi odbijala
 *     wpisana tresc. To jest realna usterka, nie kosmetyka.
 *
 * Uruchomienie (domyslnie NIC nie zapisuje):
 *
 *   pnpm tsx src/scripts/audit-text-layer-scale.ts
 *   pnpm tsx src/scripts/audit-text-layer-scale.ts --template=SZALWIOWA_ZIELEN
 *   pnpm tsx src/scripts/audit-text-layer-scale.ts --json
 *
 * Dwa tryby zapisu, o zupelnie roznych skutkach:
 *
 *   --fix-frames
 *     Poszerza ramke kontrolna tam, gdzie napis w rozmiarze z wydruku juz sie
 *     w niej nie miesci. NIGDY nie zweza (ramka to decyzja projektanta) i NIE
 *     RUSZA WYDRUKU - naprawia tylko walidacje odpowiedzi klienta.
 *
 *   --fix-fontsize --template=KOD
 *     Przelicza `fontSize` ze skali, ktora widac bylo w starym edytorze
 *     (fontSize * scaleY), i poszerza ramke pod nowy napis. ZMIENIA WYDRUK:
 *     napis wyjdzie taki, jak wygladal w panelu, a nie taki, jak dotad szedl
 *     na papier. Uzywac wylacznie dla szablonu, o ktorym projektant powie, ze
 *     to podglad byl tym wlasciwym obrazem - dlatego wymagany jest jawny
 *     `--template`.
 *
 * Przed kazdym zapisem poprzedni layout laduje w historii wersji szablonu
 * (`template_layout_versions`), wiec zmiane da sie cofnac z panelu.
 *
 * Na produkcji: kompilacja lokalna i `docker cp` do /app/dist/scripts
 * (w kontenerze nie ma tsx) - patrz docs/operations.md.
 */
import { Prisma } from '@prisma/client';
import { registerFont } from 'canvas';
import { IText } from 'fabric/node';
import fs from 'fs/promises';
import path from 'path';
import prisma from '../lib/prisma';
import { resolveFontFile } from '../services/admin/fonts.service';

/** Powyzej tej roznicy skali uznajemy, ze podglad rozjezdzal sie z wydrukiem. */
const DEFAULT_TOLERANCE = 0.05;

type LayerLike = Record<string, any>;

export interface Occurrence {
  /** Gdzie w layoucie siedzi ta kopia warstwy - layout lustruje warstwy. */
  where: string;
  layer: LayerLike;
  dpi: number;
}

interface Finding {
  szablon: string;
  szablonId: string;
  warstwa: string;
  nazwa: string;
  typ: string;
  tresc: string;
  fontSize: number;
  jednostka: string;
  ramka: { szerokosc: number; wysokosc: number };
  napis: { szerokosc: number; wysokosc: number };
  skalaX: number;
  skalaY: number;
  /** Stopien pisma, ktory projektant WIDZIAL w starym edytorze. */
  fontSizeZPodgladu: number;
  /** Podglad pokazywal inny rozmiar niz wydruk. */
  rozjazdPodgladu: boolean;
  /** Napis z wydruku nie miesci sie w ramce - walidator odrzuci odpowiedz. */
  zaCiasnaRamka: boolean;
  kopie: number;
}

// ============================================
// Kroje pisma - ten sam rejestr, co wydruk
// ============================================

const registeredFonts = new Set<string>();

/**
 * Rejestruje krój w node-canvas z magazynu `storage/fonts`.
 *
 * Swiadome powtorzenie `loadFontFamily` z fabric-renderer.service (tamta nie
 * jest eksportowana). Pomiar musi trafiac w ten sam plik, ktory idzie na
 * wydruk - bold jest zauwazalnie szerszy od regulara.
 */
async function ensureFont(
  fontFamily: string,
  weight: number,
  style: 'normal' | 'italic'
): Promise<boolean> {
  const key = `${fontFamily}::${weight}::${style}`;
  if (registeredFonts.has(key)) return true;

  try {
    const match = await resolveFontFile(fontFamily, weight, style);
    if (!match) return false;

    const fontPath = path.join(process.cwd(), 'storage', match.filePath);
    await fs.access(fontPath);
    registerFont(fontPath, { family: fontFamily, weight: String(weight), style });
    registeredFonts.add(key);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Pomiar warstwy
// ============================================

function getFontUnit(value: unknown): 'px' | 'pt' {
  return value === 'px' ? 'px' : 'pt';
}

function fontSizeToPx(fontSize: number, fontUnit: 'px' | 'pt', dpi: number): number {
  return fontUnit === 'pt' ? (fontSize / 72) * dpi : fontSize;
}

/**
 * Tresc, ktora mierzyl stary edytor: warstwa bez odpowiedzi klienta pokazuje
 * placeholder, a tokeny `{{ klucz }}` zostaja w niej doslownie.
 */
export function getMeasuredText(layer: LayerLike): string {
  const props = (layer.properties || {}) as Record<string, any>;

  if (layer.type === 'static_text') {
    return String(props.text || '');
  }

  const fieldKey = String(props.fieldKey || '');
  return String(props.placeholder || (fieldKey ? `{{ ${fieldKey} }}` : ''));
}

export async function measureLayer(
  layer: LayerLike,
  dpi: number
): Promise<{ width: number; height: number; fontRegistered: boolean } | null> {
  const props = (layer.properties || {}) as Record<string, any>;
  const text = getMeasuredText(layer);
  if (!text.trim()) return null;

  const fontFamily = String(props.fontFamily || 'Arial');
  const weight = Number(props.fontWeight) || 400;
  const style = props.fontStyle === 'italic' ? ('italic' as const) : ('normal' as const);
  const fontRegistered = await ensureFont(fontFamily, weight, style);

  const fontUnit = getFontUnit(props.fontUnit);
  const fontSizePx = fontSizeToPx(Number(props.fontSize || 24), fontUnit, dpi);

  // Te same wlasciwosci, ktore ustawiala fabryka warstw w edytorze - i BEZ
  // `styleRanges`: stara skala liczyla sie przed ich nalozeniem.
  const textObj = new IText(text, {
    charSpacing: Number(props.letterSpacing) || 0,
    fontSize: fontSizePx,
    fontFamily,
    fontWeight: String(weight),
    fontStyle: style,
    lineHeight: Number(props.lineHeight) || 1.2,
    originX: 'center',
    originY: 'center',
  });

  return {
    width: textObj.width || 0,
    height: textObj.height || 0,
    fontRegistered,
  };
}

// ============================================
// Chodzenie po layoucie
// ============================================

/**
 * Wszystkie listy warstw w layoucie.
 *
 * Layout lustruje warstwy: `layout.layers` to kopia pierwszej strony
 * pierwszego wariantu, a `layout.pages` kopia stron tego wariantu. Poprawka
 * musi wejsc w KAZDA kopie, inaczej pierwszy zapis z panelu ja cofnie.
 */
function collectPages(layout: any): Array<{ where: string; canvas: any; layers: any[] }> {
  const pages: Array<{ where: string; canvas: any; layers: any[] }> = [];

  if (Array.isArray(layout?.layers)) {
    pages.push({ where: 'layers', canvas: layout.canvas, layers: layout.layers });
  }

  if (Array.isArray(layout?.pages)) {
    layout.pages.forEach((page: any, index: number) => {
      if (!Array.isArray(page?.layers)) return;
      pages.push({
        where: `pages[${index}]`,
        canvas: page.canvas ?? layout.canvas,
        layers: page.layers,
      });
    });
  }

  if (Array.isArray(layout?.variants)) {
    layout.variants.forEach((variant: any, variantIndex: number) => {
      if (!Array.isArray(variant?.pages)) return;
      variant.pages.forEach((page: any, pageIndex: number) => {
        if (!Array.isArray(page?.layers)) return;
        pages.push({
          where: `variants[${variantIndex}].pages[${pageIndex}]`,
          canvas: page.canvas ?? layout.canvas,
          layers: page.layers,
        });
      });
    });
  }

  return pages;
}

/** Kopie warstw jednoliniowych zebrane po id - jedna warstwa, wiele luster. */
export function collectTextLayers(layout: any): Map<string, Occurrence[]> {
  const byId = new Map<string, Occurrence[]>();

  for (const page of collectPages(layout)) {
    const dpi = Number(page.canvas?.dpi) || 300;

    for (const layer of page.layers) {
      if (layer?.type !== 'text' && layer?.type !== 'static_text') continue;
      const id = String(layer.id || '');
      if (!id) continue;

      const list = byId.get(id) || [];
      list.push({ where: page.where, layer, dpi });
      byId.set(id, list);
    }
  }

  return byId;
}

// ============================================
// Skrypt
// ============================================

interface Options {
  templates: string[];
  tolerance: number;
  json: boolean;
  fixFrames: boolean;
  fixFontSize: boolean;
}

function parseOptions(argv: string[]): Options {
  const templates: string[] = [];
  let tolerance = DEFAULT_TOLERANCE;
  let json = false;
  let fixFrames = false;
  let fixFontSize = false;

  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--fix-frames') fixFrames = true;
    else if (arg === '--fix-fontsize') fixFontSize = true;
    else if (arg.startsWith('--template=')) {
      templates.push(
        ...arg
          .slice('--template='.length)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      );
    } else if (arg.startsWith('--tolerance=')) {
      const value = Number(arg.slice('--tolerance='.length));
      if (Number.isFinite(value) && value >= 0) tolerance = value;
    }
  }

  return { templates, tolerance, json, fixFrames, fixFontSize };
}

function describeLayout(layout: any): string {
  const pages = Array.isArray(layout?.pages) && layout.pages.length > 0 ? layout.pages.length : 1;
  const variants = Array.isArray(layout?.variants) ? layout.variants.length : 1;
  const pageLabel = pages === 1 ? '1 strona' : `${pages} stron`;
  return variants > 1 ? `${pageLabel}, ${variants} warianty` : pageLabel;
}

/** Ramka nigdy sie nie zweza - to decyzja projektanta, nie wynik pomiaru. */
export function widenFrame(occurrences: Occurrence[], width: number, height: number): boolean {
  let changed = false;

  for (const occurrence of occurrences) {
    const nextWidth = Math.max(Number(occurrence.layer.width) || 0, Math.ceil(width));
    const nextHeight = Math.max(Number(occurrence.layer.height) || 0, Math.ceil(height));

    if (nextWidth !== occurrence.layer.width || nextHeight !== occurrence.layer.height) {
      occurrence.layer.width = nextWidth;
      occurrence.layer.height = nextHeight;
      changed = true;
    }
  }

  return changed;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (options.fixFrames && options.fixFontSize) {
    throw new Error('Wybierz jeden tryb zapisu: --fix-frames ALBO --fix-fontsize');
  }

  if (options.fixFontSize && options.templates.length === 0) {
    throw new Error(
      '--fix-fontsize zmienia wydruk, wiec wymaga jawnego --template=KOD (mozna podac kilka po przecinku)'
    );
  }

  const templates = await prisma.personalizationTemplate.findMany({
    where: {
      layoutJson: { not: Prisma.DbNull },
      ...(options.templates.length > 0 ? { code: { in: options.templates } } : {}),
    },
    select: { id: true, code: true, name: true, layoutJson: true },
    orderBy: { code: 'asc' },
  });

  if (options.templates.length > 0) {
    const found = new Set(templates.map((template) => template.code));
    const missing = options.templates.filter((code) => !found.has(code));
    if (missing.length > 0) {
      console.warn(`⚠️  Nie znaleziono szablonów: ${missing.join(', ')}`);
    }
  }

  const findings: Finding[] = [];
  const brakujaceKroje = new Set<string>();
  const zmienioneSzablony: string[] = [];
  let warstwyOgolem = 0;

  for (const template of templates) {
    const layout = template.layoutJson as any;
    if (!layout) continue;

    const layers = collectTextLayers(layout);
    let layoutZmieniony = false;

    for (const [layerId, occurrences] of layers) {
      warstwyOgolem += 1;

      const [primary] = occurrences;
      const props = (primary.layer.properties || {}) as Record<string, any>;
      const measured = await measureLayer(primary.layer, primary.dpi);
      if (!measured || measured.width <= 0 || measured.height <= 0) continue;

      if (!measured.fontRegistered) {
        brakujaceKroje.add(String(props.fontFamily || '(brak)'));
      }

      const frameWidth = Number(primary.layer.width) || 0;
      const frameHeight = Number(primary.layer.height) || 0;
      const skalaX = frameWidth > 0 ? frameWidth / measured.width : 1;
      const skalaY = frameHeight > 0 ? frameHeight / measured.height : 1;

      const rozjazdPodgladu =
        Math.abs(skalaX - 1) > options.tolerance || Math.abs(skalaY - 1) > options.tolerance;
      const zaCiasnaRamka = frameWidth > 0 && measured.width > frameWidth + 1;

      const fontUnit = getFontUnit(props.fontUnit);
      const fontSize = Number(props.fontSize || 24);

      if (rozjazdPodgladu || zaCiasnaRamka) {
        findings.push({
          szablon: template.code,
          szablonId: template.id,
          warstwa: layerId,
          nazwa: String(primary.layer.name || layerId),
          typ: String(primary.layer.type),
          tresc: getMeasuredText(primary.layer).replace(/\s+/g, ' ').slice(0, 40),
          fontSize,
          jednostka: fontUnit,
          ramka: { szerokosc: Math.round(frameWidth), wysokosc: Math.round(frameHeight) },
          napis: { szerokosc: Math.round(measured.width), wysokosc: Math.round(measured.height) },
          skalaX: Math.round(skalaX * 100) / 100,
          skalaY: Math.round(skalaY * 100) / 100,
          fontSizeZPodgladu: Math.round(fontSize * skalaY * 10) / 10,
          rozjazdPodgladu,
          zaCiasnaRamka,
          kopie: occurrences.length,
        });
      }

      if (options.fixFontSize) {
        // Stopien pisma z PIONOWEJ skali - to ona decydowala o wysokosci
        // glifow w starym podgladzie. Po zmianie mierzymy jeszcze raz, zeby
        // ramka kontrolna objela nowy napis.
        const nextFontSize = Math.max(1, Math.round(fontSize * skalaY));
        if (nextFontSize !== fontSize) {
          for (const occurrence of occurrences) {
            occurrence.layer.properties = {
              ...(occurrence.layer.properties || {}),
              fontSize: nextFontSize,
            };
          }

          const remeasured = await measureLayer(occurrences[0].layer, occurrences[0].dpi);
          widenFrame(
            occurrences,
            remeasured?.width || measured.width,
            remeasured?.height || measured.height
          );
          layoutZmieniony = true;
        }
        continue;
      }

      if (options.fixFrames && zaCiasnaRamka) {
        if (widenFrame(occurrences, measured.width, measured.height)) {
          layoutZmieniony = true;
        }
      }
    }

    if (layoutZmieniony) {
      // Stan SPRZED nadpisania trafia do historii wersji - tak samo jak przy
      // zapisie z panelu, wiec projektant moze wrocic jednym klikiem.
      const przed = await prisma.personalizationTemplate.findUnique({
        where: { id: template.id },
        select: { layoutJson: true },
      });

      if (przed?.layoutJson) {
        await prisma.templateLayoutVersion.create({
          data: {
            templateId: template.id,
            layoutJson: przed.layoutJson as any,
            summary: `${describeLayout(przed.layoutJson)} - przed migracją warstw tekstowych`,
          },
        });
      }

      await prisma.personalizationTemplate.update({
        where: { id: template.id },
        data: { layoutJson: layout },
      });

      zmienioneSzablony.push(template.code);
    }
  }

  const rozjechane = findings.filter((finding) => finding.rozjazdPodgladu).length;
  const ciasne = findings.filter((finding) => finding.zaCiasnaRamka).length;

  const podsumowanie = {
    tryb: options.fixFontSize ? 'fix-fontsize' : options.fixFrames ? 'fix-frames' : 'raport',
    szablony: templates.length,
    warstwyJednoliniowe: warstwyOgolem,
    rozjazdPodgladu: rozjechane,
    zaCiasnaRamka: ciasne,
    zapisane: zmienioneSzablony,
    krojeSpozaRejestru: [...brakujaceKroje],
  };

  if (options.json) {
    console.log(JSON.stringify({ podsumowanie, warstwy: findings }, null, 2));
  } else {
    console.log(`\nSzablony: ${podsumowanie.szablony}, warstwy text/static_text: ${warstwyOgolem}`);
    console.log(`Podgląd rozjeżdżał się z wydrukiem (tolerancja ${options.tolerance}): ${rozjechane}`);
    console.log(`Ramka za ciasna dla napisu z wydruku (walidator odrzuci odpowiedź): ${ciasne}\n`);

    if (findings.length > 0) {
      console.table(
        findings.map((finding) => ({
          szablon: finding.szablon,
          warstwa: finding.nazwa,
          treść: finding.tresc,
          'fontSize (druk)': `${finding.fontSize} ${finding.jednostka}`,
          'fontSize (stary podgląd)': `${finding.fontSizeZPodgladu} ${finding.jednostka}`,
          skalaX: finding.skalaX,
          skalaY: finding.skalaY,
          'ramka px': `${finding.ramka.szerokosc}×${finding.ramka.wysokosc}`,
          'napis px': `${finding.napis.szerokosc}×${finding.napis.wysokosc}`,
          'za ciasna': finding.zaCiasnaRamka ? 'TAK' : '',
        }))
      );
    }

    if (brakujaceKroje.size > 0) {
      console.warn(
        `\n⚠️  Kroje spoza rejestru (node-canvas podstawił krój systemowy, pomiar przybliżony): ${[
          ...brakujaceKroje,
        ].join(', ')}`
      );
    }

    if (zmienioneSzablony.length > 0) {
      console.log(`\n✅ Zapisano: ${zmienioneSzablony.join(', ')} (poprzedni layout w historii wersji)`);
    } else if (options.fixFrames || options.fixFontSize) {
      console.log('\nNic nie wymagało zapisu.');
    } else {
      console.log('\nTryb raportu — nic nie zapisano. Zapis: --fix-frames albo --fix-fontsize.');
    }
  }
}

// Testy importuja z tego pliku sam pomiar i chodzenie po layoucie, wiec
// przejscie do bazy odpala sie wylacznie przy uruchomieniu skryptu wprost.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
