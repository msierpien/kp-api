import { loadImage, registerFont } from 'canvas';
import { StaticCanvas, FabricImage, IText, Textbox } from 'fabric/node';
import type { TemplateLayoutJson, Layer, TextFieldProperties, TextBoxProperties, ImageProperties } from '../../types/template-layout';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../../config';
import { listFonts } from '../admin/fonts.service';

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

// node-canvas potrafi zarejestrowac tylko formaty plikowe TrueType/OpenType.
// Pliki webowe (woff/woff2) z rejestru sa dla druku bezuzyteczne.
const RENDERABLE_FONT_FORMATS = ['ttf', 'otf'];

/**
 * Rejestruje w node-canvas czcionke o podanej rodzinie.
 *
 * Zrodlem jest ten sam rejestr, do ktorego wgrywa je panel admina
 * (storage/fonts, patrz services/admin/fonts.service). Wczesniej funkcja
 * szukala pliku w src/fonts wg schematu "Rodzina-waga.ttf" - katalog ten nie
 * istnieje, wiec KAZDY krój pisma cicho spadal na domyslny systemowy i wydruk
 * ignorowal ustawienia szablonu.
 */
async function loadFontFamily(fontFamily: string, weight: number = 400): Promise<void> {
  const fontKey = `${fontFamily}-${weight}`;
  if (loadedFonts.has(fontKey)) return;

  try {
    const available = await listFonts();
    const match = available.find(
      (font) =>
        font.family.toLowerCase() === fontFamily.toLowerCase() &&
        RENDERABLE_FONT_FORMATS.includes(font.format.toLowerCase())
    );

    if (!match) {
      console.warn(
        `[Fabric] Brak czcionki "${fontFamily}" w rejestrze - wydruk uzyje kroju systemowego. ` +
          `Wgraj plik TTF/OTF w panelu (Czcionki).`
      );
      return;
    }

    const fontPath = path.join(process.cwd(), 'storage', match.filePath);
    await fs.access(fontPath);
    registerFont(fontPath, { family: fontFamily, weight: String(weight) });
    loadedFonts.add(fontKey);
    console.log(`[Fabric] Font loaded: ${fontFamily} (${weight}) <- ${match.fileName}`);
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
  const needed = new Map<string, { family: string; weight: number }>();

  for (const layer of layout.layers) {
    if (layer.type !== 'text' && layer.type !== 'static_text' && layer.type !== 'textbox') continue;

    const props = layer.properties as any;
    const family = String(props.fontFamily || '').trim();
    if (!family) continue;

    const weight = Number(props.fontWeight) || 400;
    needed.set(`${family}::${weight}`, { family, weight });
  }

  for (const { family, weight } of needed.values()) {
    await loadFontFamily(family, weight);
  }
}

/**
 * Merge layoutu z overrides (zmiany pozycji przez klienta)
 */
function mergeLayoutWithOverrides(
  layout: TemplateLayoutJson,
  overrides?: any
): TemplateLayoutJson {
  if (!overrides?.layers) return layout;
  
  return {
    ...layout,
    layers: layout.layers.map(layer => {
      const override = overrides.layers[layer.id];
      if (!override) return layer;
      
      // Styl wybrany przez klienta (o ile szablon na to pozwolil) trafia do
      // properties warstwy. Bez tego wybory z portalu byly widoczne wylacznie
      // w podgladzie, a wydruk zachowywal ustawienia projektanta.
      const style: Record<string, unknown> = {};
      for (const key of ['fontSize', 'fontFamily', 'fill', 'textAlign'] as const) {
        const value = (override as Record<string, unknown>)[key];
        if (value !== undefined && value !== null) {
          style[key] = value;
        }
      }

      return {
        ...layer,
        x: override.x ?? layer.x,
        y: override.y ?? layer.y,
        width: override.width ?? layer.width,
        height: override.height ?? layer.height,
        rotation: override.rotation ?? layer.rotation,
        properties: Object.keys(style).length
          ? { ...(layer.properties as unknown as Record<string, unknown>), ...style }
          : layer.properties,
      } as typeof layer;
    })
  };
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
    const imageUrl = props.imageUrl.startsWith('http')
      ? props.imageUrl
      : path.join(config.storage.path, props.imageUrl);
    
    try {
      const img = await loadImage(imageUrl);
      
      return new FabricImage(img as any, {
        ...common,
        scaleX: (layer.width * scale) / img.width,
        scaleY: (layer.height * scale) / img.height,
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

  // Merge layout z overrides
  const layout = mergeLayoutWithOverrides(data.layoutConfig, data.layoutOverrides);

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

export { RenderOptions, TemplateData, WatermarkConfig };
