/**
 * Wersaliki i obrys napisu: czy wydruk wyglada jak podglad.
 *
 * Cztery napisy na jednym arkuszu, wszystkie z ta sama trescia z odpowiedzi
 * klienta: bez zmian, wersaliki, obrys i obrys w kolorze wiodacym. Nie omijamy
 * renderera - wolamy `renderPreview`, czyli ten sam kod, ktory robi paczki do
 * druku.
 *
 * Sprawdzenie jest ilosciowe, nie "na oko": skrypt liczy piksele w kolorze
 * obrysu i przerywa, gdy ich nie ma. Napis bialy na bialym tle byloby widac
 * dopiero po otwarciu pliku, czyli nigdy.
 *
 * Uruchomienie (bez bazy):
 *   pnpm tsx src/scripts/text-style-render-check.ts
 */
import fs from 'fs/promises';
import path from 'path';

// Atrapy sekretow: `config` waliduje env juz przy imporcie, a ten skrypt do
// bazy ani do szyfrowania nie siega. Stad ustawienie PRZED dynamicznym
// importem renderera nizej - statyczny import wywrocilby skrypt na maszynie
// bez `.env`.
process.env.DATABASE_URL ||= 'postgresql://check:check@localhost:5432/check';
process.env.JWT_ACCESS_SECRET ||= 'render-check-access-secret-render-check';
process.env.JWT_REFRESH_SECRET ||= 'render-check-refresh-secret-render-check';
process.env.ENCRYPTION_KEY ||= 'render-check-encryption-key-32b!';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');
const DPI = 300;
const WIDTH_PX = 1181; // 100 mm
const HEIGHT_PX = 945; // 80 mm

const PRIMARY = '#8a1538';

function textLayer(
  id: string,
  y: number,
  extra: Record<string, unknown>
) {
  return {
    id,
    name: id,
    type: 'text',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 1,
    x: Math.round(WIDTH_PX / 2),
    y,
    width: 1000,
    height: 160,
    rotation: 0,
    properties: {
      type: 'text',
      fieldKey: 'imie',
      placeholder: 'Zażółć gęślą jaźń',
      fontSize: 28,
      fontUnit: 'pt',
      fontFamily: 'Arial',
      fontWeight: 400,
      fontStyle: 'normal',
      fill: '#1a1a1a',
      textAlign: 'center',
      lineHeight: 1.2,
      maxLines: 1,
      editable: true,
      ...extra,
    },
  };
}

/** Ile pikseli obrazu lezy blisko zadanego koloru. */
function countNear(data: Uint8ClampedArray, hex: string, tolerance = 40): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  let hits = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - r) <= tolerance &&
      Math.abs(data[i + 1] - g) <= tolerance &&
      Math.abs(data[i + 2] - b) <= tolerance
    ) {
      hits += 1;
    }
  }
  return hits;
}

async function main() {
  const layout = {
    version: 2,
    canvas: {
      width: 100,
      height: 80,
      unit: 'mm',
      dpi: DPI,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    primaryColor: PRIMARY,
    layers: [
      textLayer('bez-zmian', 120, {}),
      textLayer('wersaliki', 340, { textTransform: 'uppercase' }),
      textLayer('obrys', 560, { stroke: '#1e6b3a', strokeWidthMm: 0.4 }),
      // Obrys ma isc za kolorem wiodacym projektu - to ten sam mechanizm, co
      // przy wypelnieniu tekstu i obrysie figury.
      textLayer('obrys-wiodacy', 780, { stroke: 'currentColor', strokeWidthMm: 0.4 }),
    ],
  };

  const { renderPreview } = await import('../services/renderer/fabric-renderer.service');

  const buffer = await renderPreview(
    {
      templateName: 'text-style-check',
      templateVersion: 1,
      layoutConfig: layout,
      answers: { imie: 'Aleksandra Wiśniewska' },
    } as any,
    { width: WIDTH_PX, height: HEIGHT_PX, scale: 1, deviceScaleFactor: 1, format: 'png' }
  );

  await fs.mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, 'render-text-style.png');
  await fs.writeFile(target, buffer);

  // Piksele czytamy tym samym `canvas`, ktorym renderer rysuje - bez dokladania
  // zaleznosci tylko po to, zeby otworzyc wlasny PNG.
  const { createCanvas, loadImage } = await import('canvas');
  const image = await loadImage(buffer);
  const measure = createCanvas(image.width, image.height);
  measure.getContext('2d').drawImage(image, 0, 0);
  const { data } = measure.getContext('2d').getImageData(0, 0, image.width, image.height);

  const greenPixels = countNear(data, '#1e6b3a');
  const primaryPixels = countNear(data, PRIMARY);

  console.log('OK:', target, `${Math.round(buffer.length / 1024)} kB`);
  console.log('Piksele obrysu #1e6b3a:', greenPixels);
  console.log('Piksele obrysu w kolorze wiodacym:', primaryPixels);
  console.log('Oczekiwane, od gory: "Aleksandra Wiśniewska", to samo WERSALIKAMI,');
  console.log('napis z zielonym obrysem, napis z obrysem bordo (kolor wiodacy).');

  if (greenPixels < 100) {
    throw new Error(`Obrys #1e6b3a nie trafil na raster (${greenPixels} pikseli)`);
  }
  if (primaryPixels < 100) {
    throw new Error(
      `Obrys currentColor nie wzial koloru wiodacego (${primaryPixels} pikseli)`
    );
  }
}

main().catch((error) => {
  console.error('RENDER CHECK FAILED:', error);
  process.exit(1);
});
