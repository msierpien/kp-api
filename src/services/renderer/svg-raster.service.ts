import fs from 'fs/promises';
import { applySvgTint } from '../../lib/svg-sanitizer';

/**
 * Rasteryzacja SVG do PNG dla renderera druku.
 *
 * Dlaczego nie node-canvas: jego obsluga SVG zalezy od librsvg w cairo.
 * W produkcyjnym obrazie alpine go nie ma, wiec ozdobnik wektorowy
 * wyszedlby z drukarki jako pusty prostokat. A tam, gdzie librsvg jest
 * (np. lokalny macOS), node-canvas i tak rasteryzuje w rozmiarze WLASNYM
 * pliku - ozdobnik powiekszony przez klienta bylby rozmyty mimo wektora.
 *
 * resvg rozwiazuje oba problemy: renderuje w rozmiarze DOCELOWYM (px na
 * arkuszu przy danym DPI) i dziala niezaleznie od bibliotek systemowych.
 */
export async function rasterizeSvgFile(options: {
  /** Bezwzgledna sciezka pliku SVG. */
  filePath: string;
  /** Docelowa szerokosc w pikselach renderu. */
  widthPx: number;
  /** Kolor podstawiany pod `currentColor` (opcjonalny). */
  tint?: string | null;
}): Promise<Buffer> {
  const { filePath, widthPx, tint } = options;
  const raw = await fs.readFile(filePath, 'utf-8');
  const svg = tint ? applySvgTint(raw, tint) : raw;

  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    // Zaokraglamy w gore: pol piksela mniej to widoczna nieostrosc krawedzi.
    fitTo: { mode: 'width', value: Math.max(1, Math.ceil(widthPx)) },
    // Bez fontow: ozdobniki to ksztalty. Tekst w SVG i tak nie ma jak
    // trafic do rejestru krojow szablonu, wiec lepiej go nie udawac.
    font: { loadSystemFonts: false },
  });

  return resvg.render().asPng();
}

/** Czy sciezka wskazuje na SVG (po rozszerzeniu - tak trzymamy je w storage). */
export function isSvgPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.svg');
}
