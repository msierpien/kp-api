import { loadImage, registerFont } from 'canvas';
import { StaticCanvas, FabricImage, IText, Textbox } from 'fabric/node';
import type { TemplateLayoutJson, TemplatePage, PrintLayout, Layer, TextFieldProperties, TextBoxProperties, ImageProperties, MockupConfig } from '../../types/template-layout';
import { getTemplatePages } from '../../types/template-layout';
import { isSvgPath, rasterizeSvgFile } from './svg-raster.service';
import { drawImageInQuad, quadToPixels, type Quad } from '../../lib/mockup-warp';
import { mergeLayoutWithOverrides } from '../../lib/layout-overrides';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../../config';
import { resolveStorageFilePath } from '../storage/local-storage.service';
import { resolveFontFile } from '../admin/fonts.service';

/**
 * Zamienia `imageUrl` warstwy na sciezke pliku w magazynie.
 *
 * Warstwy nie pochodza wylacznie od projektanta - klient dokleja wlasne
 * (`layoutOverrides.addedLayers`), wiec `imageUrl` jest danymi z zewnatrz.
 * Wczesniej trafialo prosto do `path.join` (wyjscie poza magazyn przez `..`)
 * albo do `loadImage(url)` (zadanie HTTP z serwera, czyli SSRF).
 *
 * Adres http przyjmujemy TYLKO jesli wskazuje nasz wlasny magazyn - wtedy
 * czytamy plik z dysku zamiast wolac samych siebie po sieci. Zwraca null,
 * gdy sciezki nie da sie bezpiecznie rozwiazac; wolajacy loguje i pomija
 * warstwe, zamiast wywracac caly render.
 */
function resolveLayerImagePath(imageUrl: string): string | null {
  const value = String(imageUrl || '').trim();
  if (!value) return null;

  let relative = value;

  if (/^https?:\/\//i.test(value)) {
    const publicPrefix = config.storage.publicUrl.replace(/\/$/, '');
    if (!value.startsWith(`${publicPrefix}/`)) return null;
    relative = decodeURIComponent(value.slice(publicPrefix.length + 1));
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // file:, data:, ftp: - nic z tego nie ma prawa trafic do renderera.
    return null;
  }

  try {
    return resolveStorageFilePath(relative);
  } catch {
    return null;
  }
}

interface RenderOptions {
  width: number;
  height: number;
  scale?: number;
  format?: 'png' | 'jpeg';
  includeWatermark?: boolean;
  quality?: number;
  deviceScaleFactor?: number;
}

interface TemplateData {
  answers: Record<string, string | number | boolean>;
  templateName: string;
  layoutConfig?: TemplateLayoutJson;
  layoutOverrides?: any;
  /** Indeks sztuki - decyduje, ktore nadpisania per sztuka nalozyc. */
  itemIndex?: number;
  watermark?: WatermarkConfig;
}

interface WatermarkConfig {
  text: string;
  opacity: number;
  angle: number;
  fontSize?: number;
}

// Cache załadowanych czcionek
const loadedFonts = new Set<string>();

function getFontUnit(value: unknown): 'px' | 'pt' {
  return value === 'px' ? 'px' : 'pt';
}

function fontSizeToRenderPx(
  fontSize: number,
  fontUnit: 'px' | 'pt' = 'pt',
  dpi: number = 300,
  scale: number = 1
): number {
  const baseSize = fontUnit === 'pt' ? (fontSize / 72) * dpi : fontSize;
  return baseSize * scale;
}

// Lista formatow zdatnych do druku zyje w fonts.service (to samo zrodlo
// karmi flage `printable` w panelu), zeby renderer i UI nie rozjechaly sie.

/**
 * Rejestruje w node-canvas czcionke o podanej rodzinie.
 *
 * Zrodlem jest ten sam rejestr, do ktorego wgrywa je panel admina
 * (storage/fonts, patrz services/admin/fonts.service). Wczesniej funkcja
 * szukala pliku w src/fonts wg schematu "Rodzina-waga.ttf" - katalog ten nie
 * istnieje, wiec KAZDY krój pisma cicho spadal na domyslny systemowy i wydruk
 * ignorowal ustawienia szablonu.
 */
async function loadFontFamily(
  fontFamily: string,
  weight: number = 400,
  style: 'normal' | 'italic' = 'normal'
): Promise<void> {
  const fontKey = `${fontFamily}::${weight}::${style}`;
  if (loadedFonts.has(fontKey)) return;

  try {
    // Rodzina moze byc nazwa pliku (starsze szablony) albo rodzina
    // typograficzna z wyborem wagi i kursywy - resolver zna oba warianty.
    const match = await resolveFontFile(fontFamily, weight, style);

    if (!match) {
      console.warn(
        `[Fabric] Brak czcionki "${fontFamily}" w rejestrze - wydruk uzyje kroju systemowego. ` +
          `Wgraj plik TTF/OTF w panelu (Czcionki).`
      );
      return;
    }

    const fontPath = path.join(process.cwd(), 'storage', match.filePath);
    await fs.access(fontPath);
    registerFont(fontPath, { family: fontFamily, weight: String(weight), style });
    loadedFonts.add(fontKey);
    console.log(`[Fabric] Font loaded: ${fontFamily} (${weight}, ${style}) <- ${match.fileName}`);
  } catch (error) {
    console.warn(`[Fabric] Nie udalo sie zaladowac czcionki "${fontFamily}":`, error);
  }
}

/**
 * Ładuje wszystkie czcionki z layoutu
 */
async function loadLayoutFonts(layout: TemplateLayoutJson): Promise<void> {
  // Mapa zamiast klucza tekstowego: wczesniej rodzina i waga byly sklejane
  // myslnikiem i rozbijane split('-'), wiec krój z myslnikiem w nazwie
  // (np. "Noto-Serif") gubil wage i czesc nazwy.
  const needed = new Map<string, { family: string; weight: number; style: 'normal' | 'italic' }>();

  for (const layer of layout.layers) {
    if (layer.type !== 'text' && layer.type !== 'static_text' && layer.type !== 'textbox') continue;

    const props = layer.properties as any;
    const family = String(props.fontFamily || '').trim();
    if (!family) continue;

    const weight = Number(props.fontWeight) || 400;
    const style = props.fontStyle === 'italic' ? 'italic' : 'normal';
    needed.set(`${family}::${weight}::${style}`, { family, weight, style });
  }

  for (const { family, weight, style } of needed.values()) {
    await loadFontFamily(family, weight, style);
  }
}

/**
 * Wymusza zadeklarowana wysokosc ramki pola tekstowego i wyrownanie pionowe.
 *
 * fabric.Textbox wylicza `height` z liczby linii przy kazdym renderze, wiec bez
 * tej korekty wydruk ignorowalby wysokosc pola oraz verticalAlign - a edytor
 * (kp-admin) i podglad klienta (kp-client) je respektuja. Rozjazd bylby widoczny
 * dopiero na gotowym PDF.
 *
 * Logika musi pozostac zgodna z odpowiednikiem w edytorze:
 * src/lib/template-editor/core/layer-factory.ts -> enforceTextboxBox().
 */
function enforceTextboxBox(textbox: any, boxHeight: number, verticalAlign?: string): void {
  if (!textbox || typeof textbox.calcTextHeight !== 'function') return;

  const contentHeight = textbox.calcTextHeight.bind(textbox);
  const align = String(verticalAlign || 'top');

  textbox.calcTextHeight = function () {
    return Math.max(contentHeight(), boxHeight || 0);
  };

  if (typeof textbox._getTopOffset === 'function') {
    const baseTopOffset = textbox._getTopOffset.bind(textbox);

    textbox._getTopOffset = function () {
      const base = baseTopOffset();
      const slack = Math.max(0, (boxHeight || 0) - contentHeight());

      if (align === 'middle') return base + slack / 2;
      if (align === 'bottom') return base + slack;
      return base;
    };
  }

  textbox.initDimensions();
  textbox.setCoords();
}

/**
 * Kolor tla pola tekstowego, albo pusty string gdy tlo ma byc przezroczyste.
 * Logika musi byc zgodna z edytorem:
 * src/lib/template-editor/core/layer-factory.ts -> resolveBackgroundColor().
 */
function resolveBackgroundColor(props: Record<string, unknown>): string {
  const raw = props.backgroundColor;
  const color = typeof raw === 'string' ? raw.trim() : '';

  if (!color || color === 'transparent' || color === 'none') return '';

  const rawOpacity = props.backgroundOpacity;
  if (rawOpacity === undefined || rawOpacity === null || rawOpacity === '') return color;

  const ratio = Number(rawOpacity) / 100;
  if (!Number.isFinite(ratio)) return color;
  if (ratio >= 1) return color;
  if (ratio <= 0) return '';

  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (!hex) return color;

  const value = parseInt(hex[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${Math.round(ratio * 100) / 100})`;
}

/**
 * Konwertuje Layer na obiekt Fabric.js
 */
async function layerToFabricObject(
  layer: Layer,
  answers: Record<string, any>,
  scale: number,
  dpi: number
): Promise<any> {
  const common = {
    left: layer.x * scale,
    top: layer.y * scale,
    width: layer.width * scale,
    height: layer.height * scale,
    opacity: layer.opacity ?? 1,
    angle: layer.rotation || 0,
    selectable: false,
    evented: false,
  };

  // Background lub Image
  if (layer.type === 'background' || layer.type === 'image') {
    const props = layer.properties as ImageProperties;
    const imageUrl = resolveLayerImagePath(props.imageUrl);

    if (!imageUrl) {
      console.error(`[Fabric] Odrzucony adres grafiki warstwy ${layer.id}: ${props.imageUrl}`);
      return null;
    }

    try {
      // SVG: node-canvas go nie otworzy, wiec najpierw rasteryzujemy przez
      // resvg w docelowej rozdzielczosci (z ewentualnym przebarwieniem
      // na kolor z palety projektu).
      const img = isSvgPath(imageUrl)
        ? await loadImage(
            await rasterizeSvgFile({
              filePath: imageUrl,
              widthPx: Math.max(1, layer.width * scale),
              tint: (props as unknown as { tint?: string }).tint,
            })
          )
        : await loadImage(imageUrl);
      
      // Rozmiar obrazu ustawia WYLACZNIE skala. Wczesniej szly tu takze
      // `width`/`height` z `common`, a fabric mnozy jedno przez drugie -
      // obraz wychodzil w rozmiarze (docelowy^2 / naturalny). Przy grafice
      // zblizonej rozmiarem do ramki bylo to ledwie widoczne (serce: 87%),
      // ale zdjecie klienta 5000 px w ramce 1176 px kurczylo sie do 24%.
      //
      // `originX/originY: center` - tak samo jak w edytorze i w portalu.
      // Bez tego serwer rysowal obraz od lewego gornego rogu, czyli
      // przesuniety o pol jego szerokosci i wysokosci wzgledem podgladu.
      const { width: _targetWidth, height: _targetHeight, ...imageCommon } = common;

      return new FabricImage(img as any, {
        ...imageCommon,
        originX: 'center',
        originY: 'center',
        scaleX: (layer.width * scale) / (img.width || 1),
        scaleY: (layer.height * scale) / (img.height || 1),
      });
    } catch (error) {
      console.error(`[Fabric] Failed to load image ${imageUrl}:`, error);
      return null;
    }
  }

  // Text (IText)
  if (layer.type === 'text') {
    const props = layer.properties as TextFieldProperties;
    const value = answers[props.fieldKey] || props.placeholder || '';
    
    return new IText(String(value), {
      ...common,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      originX: 'center',
      originY: 'center',
    });
  }

  // Static text
  if (layer.type === 'static_text') {
    const props = layer.properties as any;
    let value = props.text || '';
    
    // Zamień {{ fieldKey }}
    value = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match: string, key: string) => {
      return answers[key] || match;
    });
    
    return new IText(value, {
      ...common,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      originX: 'center',
      originY: 'center',
    });
  }

  // TextBox
  if (layer.type === 'textbox') {
    const props = layer.properties as TextBoxProperties;
    let value = props.text || '';
    
    // Zamień {{ fieldKey }} na wartości
    value = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match: string, key: string) => {
      return answers[key] || match;
    });
    
    // Bezpośrednie mapowanie
    if (props.fieldKey && answers[props.fieldKey]) {
      value = String(answers[props.fieldKey]);
    }
    
    const textbox = new Textbox(value, {
      ...common,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      backgroundColor: resolveBackgroundColor(props as unknown as Record<string, unknown>),
      padding: (props.padding || 10) * scale,
      originX: 'center',
      originY: 'center',
      // Zawijanie po slowach, tak jak w edytorze. Szablon moze wlaczyc lamanie
      // znakowe (przydatne dla pisma CJK).
      splitByGrapheme: (props as any).splitByGrapheme === true,
    });

    enforceTextboxBox(textbox, layer.height * scale, (props as any).verticalAlign);

    return textbox;
  }

  return null;
}

/**
 * Główna funkcja renderowania do PNG
 */
export async function renderPreview(
  data: TemplateData,
  options: RenderOptions
): Promise<Buffer> {
  const {
    width = 800,
    height = 600,
    scale = 1,
    deviceScaleFactor = 2,
    format = 'png',
    quality = 1,
  } = options;

  if (!data.layoutConfig) {
    throw new Error('Layout config is required');
  }

  console.log('[Fabric] Starting render:', {
    template: data.templateName,
    size: `${width}x${height}`,
    scale,
    deviceScaleFactor,
  });

  // Merge layout z overrides. Sciezka jednostronicowa renderuje lustro
  // pierwszej strony - elementy klienta filtrujemy po jej id (fallback
  // 'page-1' spójny z getTemplatePages dla layoutow bez `pages`).
  const firstPageId = getTemplatePages(data.layoutConfig)[0]?.id || 'page-1';
  const layout = mergeLayoutWithOverrides(data.layoutConfig, data.layoutOverrides, data.itemIndex, firstPageId);

  // Załaduj czcionki
  await loadLayoutFonts(layout);

  // Oblicz finalne wymiary
  const finalWidth = width * deviceScaleFactor;
  const finalHeight = height * deviceScaleFactor;
  const finalScale = scale * deviceScaleFactor;
  const dpi = Number(layout.canvas.dpi || 300);

  // Pozwól fabric/node utworzyć zgodny element canvas przez JSDOM,
  // a następnie pobierz powiązany node-canvas do eksportu.
  const fabricCanvas = new StaticCanvas(undefined, {
    width: finalWidth,
    height: finalHeight,
    backgroundColor: layout.canvas.backgroundColor || '#ffffff',
  });
  const nodeCanvas = fabricCanvas.getNodeCanvas();

  // Renderuj warstwy w kolejności zIndex
  const sortedLayers = [...layout.layers]
    .filter(l => l.visible !== false)
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const layer of sortedLayers) {
    try {
      const fabricObj = await layerToFabricObject(
        layer,
        data.answers,
        finalScale,
        dpi
      );
      
      if (fabricObj) {
        fabricCanvas.add(fabricObj);
      }
    } catch (error) {
      console.error(`[Fabric] Failed to render layer ${layer.id}:`, error);
    }
  }

  // Dodaj watermark jeśli potrzebny
  if (data.watermark && options.includeWatermark) {
    const watermarkText = new IText(data.watermark.text, {
      left: finalWidth / 2,
      top: finalHeight / 2,
      fontSize: (data.watermark.fontSize || 96) * deviceScaleFactor,
      fontFamily: 'Arial',
      fontWeight: '700',
      fill: `rgba(0, 0, 0, ${data.watermark.opacity})`,
      angle: data.watermark.angle,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    fabricCanvas.add(watermarkText);
  }

  // Renderuj canvas
  fabricCanvas.renderAll();

  console.log('[Fabric] Canvas rendered, converting to buffer...');

  // Konwertuj do buffera
  let buffer: Buffer;
  if (format === 'png') {
    buffer = nodeCanvas.toBuffer('image/png');
  } else {
    buffer = nodeCanvas.toBuffer('image/jpeg', { quality });
  }

  console.log('[Fabric] Render complete:', {
    bufferSize: `${(buffer.length / 1024).toFixed(2)} KB`,
  });

  return buffer;
}

/**
 * Renderowanie do PDF (wysokiej jakości, do druku)
 * Używa Fabric.js do renderowania PNG w wysokiej rozdzielczości,
 * następnie konwertuje do PDF używając PDFKit
 */
export async function renderPDF(
  data: TemplateData,
  options: Omit<RenderOptions, 'format'>
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  
  const {
    width = 800,
    height = 600,
    scale = 1,
  } = options;

  console.log('[Fabric] Starting PDF render:', {
    template: data.templateName,
    size: `${width}x${height}`,
    scale,
  });

  // Render PNG w wysokiej rozdzielczości (300 DPI dla druku)
  const printDPI = 300;
  const screenDPI = 96;
  const dpiScale = printDPI / screenDPI;
  
  const pngBuffer = await renderPreview(data, {
    ...options,
    deviceScaleFactor: dpiScale,
    format: 'png',
    quality: 1,
    includeWatermark: false, // Bez watermark w finalnym PDF
  });

  // Konwertuj PNG do PDF
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    
    // Wymiary w punktach (1 punkt = 1/72 cala)
    const pdfWidth = width * scale;
    const pdfHeight = height * scale;
    
    const doc = new PDFDocument({
      size: [pdfWidth, pdfHeight],
      margin: 0,
      autoFirstPage: false,
    });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Dodaj stronę i umieść PNG
    doc.addPage({ size: [pdfWidth, pdfHeight], margin: 0 });
    doc.image(pngBuffer, 0, 0, {
      width: pdfWidth,
      height: pdfHeight,
      fit: [pdfWidth, pdfHeight],
    });

    doc.end();
  });
}

// ============================================
// Renderowanie wielu stron i sklad do druku
// ============================================

const MM_PER_INCH = 25.4;

function canvasPxDimensions(canvas: TemplateLayoutJson['canvas']): { widthPx: number; heightPx: number } {
  const dpi = Number(canvas.dpi || 300);
  const widthPx =
    Number(canvas.width) ||
    Math.round(((Number(canvas.widthMm) || 100) / MM_PER_INCH) * dpi);
  const heightPx =
    Number(canvas.height) ||
    Math.round(((Number(canvas.heightMm) || 100) / MM_PER_INCH) * dpi);
  return { widthPx, heightPx };
}

function canvasMmDimensions(canvas: TemplateLayoutJson['canvas']): { widthMm: number; heightMm: number } {
  const dpi = Number(canvas.dpi || 300);
  const { widthPx, heightPx } = canvasPxDimensions(canvas);
  return {
    widthMm: Number(canvas.widthMm) || (widthPx / dpi) * MM_PER_INCH,
    heightMm: Number(canvas.heightMm) || (heightPx / dpi) * MM_PER_INCH,
  };
}

/**
 * Renderuje pojedyncza strone do PNG w natywnej rozdzielczosci canvas
 * (layer.x jest w pikselach canvas, wiec skala = 1 daje pelne DPI szablonu).
 */
async function renderPageToPng(
  page: TemplatePage,
  answers: Record<string, any>,
  layoutOverrides: any,
  itemIndex?: number
): Promise<{ buffer: Buffer; widthPx: number; heightPx: number }> {
  const pageLayout: TemplateLayoutJson = {
    version: 2,
    canvas: page.canvas,
    fonts: [],
    layers: page.layers,
  };
  const merged = mergeLayoutWithOverrides(pageLayout, layoutOverrides, itemIndex, page.id);
  await loadLayoutFonts(merged);

  const { widthPx, heightPx } = canvasPxDimensions(merged.canvas);
  const dpi = Number(merged.canvas.dpi || 300);

  const fabricCanvas = new StaticCanvas(undefined, {
    width: widthPx,
    height: heightPx,
    backgroundColor: merged.canvas.backgroundColor || '#ffffff',
  });
  const nodeCanvas = fabricCanvas.getNodeCanvas();

  const sortedLayers = [...merged.layers]
    .filter((l) => l.visible !== false)
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const layer of sortedLayers) {
    try {
      const obj = await layerToFabricObject(layer, answers, 1, dpi);
      if (obj) fabricCanvas.add(obj);
    } catch (error) {
      console.error(`[Fabric] Failed to render layer ${layer.id} on page ${page.id}:`, error);
    }
  }

  fabricCanvas.renderAll();
  return { buffer: nodeCanvas.toBuffer('image/png'), widthPx, heightPx };
}

/**
 * Domyslny sklad, gdy szablon nie ma wlasnego print layoutu.
 *
 * Strony ukladane pionowo, jedna pod druga. Kolejne strony (tyl karty) obrocone
 * o 180 stopni - to typowy sklad winietki namiotowej, gdzie tyl po zlozeniu
 * czyta sie poprawnie. Uzytkownik moze to nadpisac edytorem skladania.
 */
function defaultPrintLayout(pages: TemplatePage[]): PrintLayout {
  let yMm = 0;
  const placements: PrintLayout['placements'] = [];
  let widthMm = 0;

  for (let i = 0; i < pages.length; i++) {
    const dims = canvasMmDimensions(pages[i].canvas);
    widthMm = Math.max(widthMm, dims.widthMm);
    placements.push({ pageId: pages[i].id, xMm: 0, yMm, rotation: i === 0 ? 0 : 180 });
    yMm += dims.heightMm;
  }

  return { sheet: { widthMm, heightMm: yMm }, placements };
}

/**
 * Czy strony szablonu maja rozne wymiary.
 *
 * Skladanie na wspolny arkusz ma sens dla przodu i tylu tej samej karty.
 * Gdy strony roznia sie formatem (np. zaproszenie 90x135 i zwrotka 95x145),
 * sa to osobne kartki - drukujemy kazda na wlasnym arkuszu.
 */
export function hasMixedPageSizes(layout: TemplateLayoutJson): boolean {
  const pages = getTemplatePages(layout);
  if (pages.length < 2) return false;

  const first = canvasMmDimensions(pages[0].canvas);
  return pages.some((page) => {
    const dims = canvasMmDimensions(page.canvas);
    return Math.abs(dims.widthMm - first.widthMm) > 0.01 || Math.abs(dims.heightMm - first.heightMm) > 0.01;
  });
}

function drawWatermark(ctx: any, widthPx: number, heightPx: number, watermarkText?: string | null): void {
  if (!watermarkText || !watermarkText.trim()) return;

  const text = watermarkText.trim();
  // Rozmiar dobrany do szerokosci arkusza, zeby napis byl czytelny
  // niezaleznie od formatu; przekatna, polprzezroczysty.
  const fontSize = Math.max(24, Math.round(widthPx / Math.max(6, text.length)));
  ctx.save();
  ctx.translate(widthPx / 2, heightPx / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#000000';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * PNG jednej strony na wlasnym arkuszu, z obrotem ze skladu do druku.
 *
 * Obrot 90/270 zamienia wymiary arkusza - kartka 90x135 mm drukowana poziomo
 * daje arkusz 135x90 mm.
 */
export async function renderPrintPagePng(
  layout: TemplateLayoutJson,
  page: TemplatePage,
  answers: Record<string, any>,
  layoutOverrides?: any,
  watermarkText?: string | null,
  itemIndex?: number
): Promise<{ buffer: Buffer; widthMm: number; heightMm: number; widthPx: number; heightPx: number; dpi: number }> {
  const { createCanvas, Image } = await import('canvas');
  const dpi = Number(page.canvas.dpi || layout.canvas.dpi || 300);
  const rotation = layout.print?.placements?.find((placement) => placement.pageId === page.id)?.rotation || 0;
  const swap = rotation === 90 || rotation === 270;

  const render = await renderPageToPng(page, answers, layoutOverrides, itemIndex);
  const sheetWidthPx = swap ? render.heightPx : render.widthPx;
  const sheetHeightPx = swap ? render.widthPx : render.heightPx;

  const sheet = createCanvas(sheetWidthPx, sheetHeightPx);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheetWidthPx, sheetHeightPx);

  const img = new Image();
  img.src = render.buffer;
  ctx.save();
  ctx.translate(sheetWidthPx / 2, sheetHeightPx / 2);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, -render.widthPx / 2, -render.heightPx / 2, render.widthPx, render.heightPx);
  ctx.restore();

  drawWatermark(ctx, sheetWidthPx, sheetHeightPx, watermarkText);

  const dims = canvasMmDimensions(page.canvas);
  return {
    buffer: sheet.toBuffer('image/png'),
    widthMm: swap ? dims.heightMm : dims.widthMm,
    heightMm: swap ? dims.widthMm : dims.heightMm,
    widthPx: sheetWidthPx,
    heightPx: sheetHeightPx,
    dpi,
  };
}

/**
 * Sklada wyrenderowane strony na jeden arkusz wg print layoutu (lub domyslnego).
 * Zwraca PNG arkusza i jego wymiary w mm.
 */
async function composePrintSheet(
  layout: TemplateLayoutJson,
  answers: Record<string, any>,
  layoutOverrides: any,
  watermarkText?: string | null,
  itemIndex?: number
): Promise<{ buffer: Buffer; widthMm: number; heightMm: number }> {
  const { createCanvas, Image } = await import('canvas');
  const pages = getTemplatePages(layout);
  const print = layout.print && layout.print.placements?.length ? layout.print : defaultPrintLayout(pages);
  const dpi = Number(layout.canvas.dpi || 300);
  const mmToPx = (mm: number) => Math.round((mm / MM_PER_INCH) * dpi);

  const rendered = new Map<string, { buffer: Buffer; widthPx: number; heightPx: number }>();
  for (const page of pages) {
    rendered.set(page.id, await renderPageToPng(page, answers, layoutOverrides, itemIndex));
  }

  const sheet = createCanvas(mmToPx(print.sheet.widthMm), mmToPx(print.sheet.heightMm));
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  for (const placement of print.placements) {
    const page = pages.find((p) => p.id === placement.pageId);
    const render = rendered.get(placement.pageId);
    if (!page || !render) continue;

    const img = new Image();
    img.src = render.buffer;
    const wPx = render.widthPx;
    const hPx = render.heightPx;
    const x = mmToPx(placement.xMm);
    const y = mmToPx(placement.yMm);

    ctx.save();
    if (placement.rotation) {
      // Obrot wokol srodka strony.
      ctx.translate(x + wPx / 2, y + hPx / 2);
      ctx.rotate((placement.rotation * Math.PI) / 180);
      ctx.drawImage(img, -wPx / 2, -hPx / 2, wPx, hPx);
    } else {
      ctx.drawImage(img, x, y, wPx, hPx);
    }
    ctx.restore();
  }

  drawWatermark(ctx, sheet.width, sheet.height, watermarkText);

  return { buffer: sheet.toBuffer('image/png'), widthMm: print.sheet.widthMm, heightMm: print.sheet.heightMm };
}

/**
 * PNG arkusza do druku (wszystkie strony zlozone wg print layoutu lub
 * domyslnego skladania). Uzywane przez paczke do druku (per sztuka).
 * Uwaga: sciezka wielostronicowa nie obsluguje jeszcze spadow (bleed).
 */
export async function renderPrintSheetPng(
  layout: TemplateLayoutJson,
  answers: Record<string, any>,
  layoutOverrides?: any,
  watermarkText?: string | null,
  itemIndex?: number
): Promise<{ buffer: Buffer; widthMm: number; heightMm: number; widthPx: number; heightPx: number; dpi: number }> {
  const { buffer, widthMm, heightMm } = await composePrintSheet(layout, answers, layoutOverrides, watermarkText, itemIndex);
  const dpi = Number(layout.canvas.dpi || 300);
  return {
    buffer,
    widthMm,
    heightMm,
    widthPx: Math.round((widthMm / MM_PER_INCH) * dpi),
    heightPx: Math.round((heightMm / MM_PER_INCH) * dpi),
    dpi,
  };
}

/**
 * Wizualizacja projektu na zdjeciu produktu (mockup).
 *
 * Kazda powierzchnia dostaje wskazana strone projektu, naciagnieta na cztery
 * rogi z korekcja perspektywy. Tryb `multiply` sprawia, ze biel projektu
 * przepuszcza fakture papieru ze zdjecia - wyglada jak nadruk, nie naklejka.
 */
export async function renderMockupPng(
  layout: TemplateLayoutJson,
  answers: Record<string, any>,
  mockup: MockupConfig,
  layoutOverrides?: any,
  options: { maxWidthPx?: number } = {}
): Promise<Buffer> {
  const { createCanvas, Image } = await import('canvas');

  // Zdjecie mockupu pochodzi z szablonu (admin), ale ta sama sciezka co
  // warstwy - jedna regula rozwiazywania adresow dla calego renderera.
  const photoPath = resolveLayerImagePath(mockup.imageUrl);
  if (!photoPath) {
    throw new Error(`Nieprawidłowy adres zdjęcia mockupu: ${mockup.imageUrl}`);
  }
  const photo = await loadImage(photoPath);

  const maxWidthPx = options.maxWidthPx;
  const scale = maxWidthPx && photo.width > maxWidthPx ? maxWidthPx / photo.width : 1;
  const width = Math.round(photo.width * scale);
  const height = Math.round(photo.height * scale);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photo as any, 0, 0, width, height);

  const pages = getTemplatePages(layout);

  for (const surface of mockup.surfaces) {
    const page = pages.find((item) => item.id === surface.pageId);
    if (!page) {
      console.warn(`[Mockup] Strona ${surface.pageId} nie istnieje w szablonie - pomijam powierzchnie`);
      continue;
    }

    const rendered = await renderPageToPng(page, answers, layoutOverrides);
    const design = new Image();
    design.src = rendered.buffer;

    drawImageInQuad(ctx, design as any, quadToPixels(surface.corners as Quad, width, height), {
      blendMode: surface.blendMode,
      opacity: surface.opacity,
      subdivisions: 16,
    });
  }

  return canvas.toBuffer('image/png');
}

/**
 * PDF do druku obejmujacy wszystkie strony zlozone na arkuszu.
 * Dla szablonu jednostronicowego zachowanie jak renderPDF.
 */
export async function renderPrintPdf(data: TemplateData): Promise<Buffer> {
  if (!data.layoutConfig) throw new Error('Layout config is required');

  const { buffer: sheetPng, widthMm, heightMm } = await composePrintSheet(
    data.layoutConfig,
    data.answers,
    data.layoutOverrides
  );

  const PDFDocument = (await import('pdfkit')).default;
  const pdfWidth = (widthMm / MM_PER_INCH) * 72; // punkty PDF
  const pdfHeight = (heightMm / MM_PER_INCH) * 72;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: [pdfWidth, pdfHeight], margin: 0, autoFirstPage: false });
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: [pdfWidth, pdfHeight], margin: 0 });
    doc.image(sheetPng, 0, 0, { width: pdfWidth, height: pdfHeight, fit: [pdfWidth, pdfHeight] });
    doc.end();
  });
}

export { RenderOptions, TemplateData, WatermarkConfig };
