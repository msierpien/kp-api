import { loadImage, registerFont } from 'canvas';
import { StaticCanvas, FabricImage, IText, Textbox, Path, Rect, Ellipse, Line } from 'fabric/node';
import type { TemplateLayoutJson, TemplatePage, PrintLayout, Layer, TextFieldProperties, TextBoxProperties, TextStyleRange, ImageProperties, MockupConfig, ShapeProperties } from '../../types/template-layout';
import {
  buildFabricTextStyles,
  getTemplatePages,
  getTemplatePagesForAnswers,
  resolveCharStyles,
} from '../../types/template-layout';
import { isSvgPath, rasterizeSvgFile } from './svg-raster.service';
import {
  SILHOUETTE_MARKS_DEFAULT,
  applyPrimaryColor,
  buildShapeGeometry,
  buildTextPathD,
  getSheetBackgroundUrl,
  getSheetImposition,
  getSlotPositionMm,
  getTextPathAnchorOffset,
  getTextPathArcLength,
  resolvePrimaryColor,
  resolveTextPathStartOffset,
  type RegistrationMarksConfig,
} from '@msierpien/kp-template-core';
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
    // `text_path` MUSI byc tutaj: bez rejestracji kroju przed renderem
    // napis po luku wyszedlby domyslna czcionka node-canvas.
    if (
      layer.type !== 'text' &&
      layer.type !== 'static_text' &&
      layer.type !== 'textbox' &&
      layer.type !== 'text_path'
    ) {
      continue;
    }

    const props = layer.properties as any;
    const family = String(props.fontFamily || '').trim();
    if (!family) continue;

    const weight = Number(props.fontWeight) || 400;
    const style = props.fontStyle === 'italic' ? 'italic' : 'normal';
    needed.set(`${family}::${weight}::${style}`, { family, weight, style });

    // Fragmenty moga miec wlasna wage, kursywe albo krój - bez zarejestrowania
    // tych wariantow pogrubione slowo wyszloby na wydruku regularem.
    for (const range of (props.styleRanges || []) as Array<Record<string, unknown>>) {
      const rangeFamily = String(range.fontFamily || family).trim();
      if (!rangeFamily) continue;
      const rangeWeight = Number(range.fontWeight) || weight;
      const rangeStyle = range.fontStyle === 'italic' ? 'italic' : range.fontStyle === 'normal' ? 'normal' : style;
      needed.set(`${rangeFamily}::${rangeWeight}::${rangeStyle}`, {
        family: rangeFamily,
        weight: rangeWeight,
        style: rangeStyle,
      });
    }
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

/**
 * Podstawia kolor wiodacy projektu pod `currentColor` w warstwie.
 *
 * Dotyczy wypelnienia i obrysu, bo jedno pokretlo ma malowac i tekst,
 * i kreske figury. Warstwa z wlasnym kolorem przechodzi nietknieta -
 * kolor wiodacy jest wyborem projektanta dla WSKAZANYCH warstw, a nie
 * globalnym przemalowaniem.
 */
function withPrimaryColor(layer: Layer, primaryColor: string | null): Layer {
  if (!primaryColor) return layer;
  const props = layer.properties as unknown as Record<string, unknown> | undefined;
  if (!props) return layer;

  const fill = applyPrimaryColor(props.fill as string | undefined, primaryColor);
  const stroke = applyPrimaryColor(props.stroke as string | undefined, primaryColor);
  if (fill === props.fill && stroke === props.stroke) return layer;

  return { ...layer, properties: { ...props, fill, stroke } } as Layer;
}

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
    const value = String(answers[props.fieldKey] || props.placeholder || '');

    const textField = new IText(value, {
      ...common,
      // charSpacing fabrica ma te sama jednostke co letterSpacing formatu
      // (1/1000 firetu), wiec nie ma tu zadnego przeliczania.
      charSpacing: Number(props.letterSpacing) || 0,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      // Odstep miedzy wierszami z szablonu. Bez tego renderer liczyl domyslna
      // wartoscia fabrica (1,16), wiec ustawienie z edytora nie docieralo na
      // wydruk - podglad projektanta i wydruk mialy inny sklad.
      lineHeight: Number((props as any).lineHeight) || 1.2,
      originX: 'center',
      originY: 'center',
    });

    applyTextStyleRanges(textField, value, props, dpi, scale);
    return textField;
  }

  // Static text
  if (layer.type === 'static_text') {
    const props = layer.properties as any;
    let value = props.text || '';
    
    // Zamień {{ fieldKey }}
    value = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match: string, key: string) => {
      return answers[key] || match;
    });
    
    const staticText = new IText(value, {
      ...common,
      charSpacing: Number(props.letterSpacing) || 0,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      // Odstep miedzy wierszami z szablonu. Bez tego renderer liczyl domyslna
      // wartoscia fabrica (1,16), wiec ustawienie z edytora nie docieralo na
      // wydruk - podglad projektanta i wydruk mialy inny sklad.
      lineHeight: Number((props as any).lineHeight) || 1.2,
      originX: 'center',
      originY: 'center',
    });

    applyTextStyleRanges(staticText, value, props, dpi, scale);
    return staticText;
  }

  // Tekst po krzywej
  if (layer.type === 'text_path') {
    const props = layer.properties as any;

    const geometry = {
      pathShape: props.pathShape === 'circle' ? ('circle' as const) : ('arc' as const),
      radiusMm: Number(props.radiusMm) || 20,
      startAngle: Number(props.startAngle) || 0,
      sweepAngle: Number(props.sweepAngle ?? 180),
    };

    const fieldKey = typeof props.fieldKey === 'string' ? props.fieldKey : '';
    const rawValue = fieldKey ? answers[fieldKey] : props.text;
    const value = String(rawValue ?? props.text ?? '');
    if (!value.trim()) return null;

    // Ta sama funkcja co w edytorze, tylko BEZ mnozenia przez skale podgladu -
    // renderer pracuje w pikselach projektu. To jedyna roznica miedzy
    // podgladem i drukiem i jedyne miejsce, gdzie wolno jej wystapic.
    const pathD = buildTextPathD(geometry, dpi);
    const arcLength = getTextPathArcLength(geometry, dpi);
    const anchor = getTextPathAnchorOffset(geometry, dpi);

    const textPath = new IText(value, {
      ...common,
      charSpacing: Number(props.letterSpacing) || 0,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      originX: 'center',
      originY: 'center',
      // `layer.x/y` to srodek okregu - kotwica fabrica siedzi w srodku bboksu
      // prowadnicy, wiec dokladamy to samo przesuniecie, co edytor.
      left: (layer.x + anchor.dx) * scale,
      top: (layer.y + anchor.dy) * scale,
      // Warstwa jest jednoliniowa; `width`/`height` z `common` opisuja zasieg
      // krzywej i nie moga sluzyc do dopasowania tekstu.
      width: undefined,
      height: undefined,
      // Obrotem steruje `startAngle` w geometrii, nie `angle` obiektu.
      angle: 0,
      // Jawnie, zeby nie zalezec od domyslnej wartosci biblioteki: cache
      // rysuje obiekt na canvasie o rozmiarze bboksu SCIEZKI i obcina glify,
      // ktore z niej wystaja. W przegladarce to wlasnie ucinalo napis.
      objectCaching: false,
    } as any);

    // Szerokosc napisu mierzymy przed dolozeniem sciezki - potem `width`
    // obiektu opisuje krzywa, nie tekst.
    const textWidth = Number((textPath as any).width) || 0;

    (textPath as any).set({
      path: new Path(pathD, { fill: '', stroke: '' } as any),
      pathSide: props.pathSide === 'right' ? 'right' : 'left',
      pathAlign: props.pathAlign || 'baseline',
      pathStartOffset: resolveTextPathStartOffset(
        props.textPathAlign === 'start' || props.textPathAlign === 'end' ? props.textPathAlign : 'center',
        arcLength,
        textWidth
      ),
    });

    return textPath;
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
      charSpacing: Number(props.letterSpacing) || 0,
      fontSize: fontSizeToRenderPx(props.fontSize, getFontUnit(props.fontUnit), dpi, scale),
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      // Odstep miedzy wierszami z szablonu. Bez tego renderer liczyl domyslna
      // wartoscia fabrica (1,16), wiec ustawienie z edytora nie docieralo na
      // wydruk - podglad projektanta i wydruk mialy inny sklad.
      lineHeight: Number((props as any).lineHeight) || 1.2,
      backgroundColor: resolveBackgroundColor(props as unknown as Record<string, unknown>),
      padding: (props.padding || 10) * scale,
      originX: 'center',
      originY: 'center',
      // Zawijanie po slowach, tak jak w edytorze. Szablon moze wlaczyc lamanie
      // znakowe (przydatne dla pisma CJK).
      splitByGrapheme: (props as any).splitByGrapheme === true,
    });

    // Style fragmentow przed wyrownaniem pionowym: zmieniaja wysokosc tekstu
    // (inna waga i rozmiar), a to od niej zalezy offset w ramce.
    applyTextStyleRanges(textbox, value, props, dpi, scale);
    enforceTextboxBox(textbox, layer.height * scale, (props as any).verticalAlign);

    return textbox;
  }

  // Figury: kreska, ramka, kolo, elipsa.
  //
  // Cala geometria idzie z pakietu, tak samo jak w edytorze i w portalu -
  // trzy osobne implementacje liczenia daly by trzy rozne wydruki, a rozjazd
  // widac dopiero na papierze.
  if (layer.type === 'shape') {
    const geometry = buildShapeGeometry(layer as { properties: ShapeProperties } & typeof layer, dpi, scale);

    const shapeCommon = {
      left: geometry.left,
      top: geometry.top,
      // Jak wszedzie w formacie: x/y warstwy to srodek figury.
      originX: 'center' as const,
      originY: 'center' as const,
      angle: geometry.angle,
      opacity: geometry.opacity,
      fill: geometry.fill,
      stroke: geometry.stroke,
      strokeWidth: geometry.strokeWidth,
      strokeDashArray: geometry.strokeDashArray,
      // Grubosc obrysu ma zostac gruboscia obrysu takze po przeskalowaniu
      // obiektu - inaczej ramka rozciagnieta w poziomie ma grubsze boki.
      strokeUniform: true,
      selectable: false,
      evented: false,
    };

    if (geometry.kind === 'line') {
      return new Line(geometry.points, shapeCommon);
    }

    if (geometry.kind === 'ellipse') {
      return new Ellipse({ ...shapeCommon, rx: geometry.rx, ry: geometry.ry });
    }

    return new Rect({
      ...shapeCommon,
      width: geometry.width,
      height: geometry.height,
      rx: geometry.rx,
      ry: geometry.ry,
    });
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
        withPrimaryColor(layer, resolvePrimaryColor(layout as any, data.layoutOverrides)),
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
/**
 * Ile razy gesciej od geometrii projektu renderujemy strone do DRUKU.
 *
 * Projekt zyje w 300 DPI i to wystarcza na ekranie, ale atramentowiec kladzie
 * punkty duzo gesciej - przy 300 DPI widac schodki na cienkim pismie odrecznym
 * i na kropkowanych kreskach. Mnoznik dotyczy wylacznie renderu do druku:
 * geometria (mm, pozycje warstw) zostaje ta sama, rosnie tylko liczba pikseli.
 */
const PRINT_RENDER_SCALE = Math.max(1, Math.min(4, Number(process.env.PRINT_RENDER_SCALE) || 2));

/**
 * Gestosc renderu podgladowego (proof) dla klienta.
 *
 * Ma wystarczyc do wychwycenia literowki na ekranie i do wydruku kontrolnego
 * na domowej drukarce, ale nie do reprodukcji - dlatego wyraznie ponizej
 * 300 DPI projektu i twardo ograniczone z gory.
 */
const PROOF_DPI = Math.max(72, Math.min(200, Number(process.env.PROOF_DPI) || 150));

/**
 * Czy projekt ma zostac przezroczysty zamiast dostac biale tlo.
 *
 * Potrzebne przy skladzie arkuszowym z podkladem: uzytek laduje na wydrukowanej
 * ozdobnej ramce, wiec zamalowanie jego pola na bialo zakryloby ja w calosci.
 * Poza tym przypadkiem tlo zostaje biale - papier tez jest bialy, a
 * przezroczysty PNG na wydruku zachowuje sie roznie w zaleznosci od RIP-a.
 */
function isTransparentBackground(backgroundColor: unknown): boolean {
  const value = String(backgroundColor ?? '').trim().toLowerCase();
  return value === 'transparent' || value === 'rgba(0,0,0,0)' || value === 'none';
}

async function renderPageToPng(
  page: TemplatePage,
  answers: Record<string, any>,
  layoutOverrides: any,
  itemIndex?: number,
  scale: number = 1,
  // Strona nie zna calego layoutu (dostaje canvas i warstwy), a kolor wiodacy
  // siedzi na jego szczycie - musi tu dojechac osobno, inaczej tekst zostaje
  // czarny mimo przemalowanego podkladu.
  primaryColorFromLayout?: string | null
): Promise<{ buffer: Buffer; widthPx: number; heightPx: number }> {
  const pageLayout: TemplateLayoutJson = {
    version: 2,
    canvas: page.canvas,
    fonts: [],
    layers: page.layers,
    ...(primaryColorFromLayout ? { primaryColor: primaryColorFromLayout } : {}),
  };
  const merged = mergeLayoutWithOverrides(pageLayout, layoutOverrides, itemIndex, page.id);
  // Kolor wiodacy: wybor klienta wygrywa z ustawieniem szablonu.
  const primaryColor = resolvePrimaryColor(merged as any, layoutOverrides);
  await loadLayoutFonts(merged);

  const { widthPx: basePx, heightPx: baseHeightPx } = canvasPxDimensions(merged.canvas);
  const dpi = Number(merged.canvas.dpi || 300);
  const widthPx = Math.round(basePx * scale);
  const heightPx = Math.round(baseHeightPx * scale);

  const fabricCanvas = new StaticCanvas(undefined, {
    width: widthPx,
    height: heightPx,
    // `undefined`, nie 'transparent': fabric wpisalby ten napis jako kolor.
    backgroundColor: isTransparentBackground(merged.canvas.backgroundColor)
      ? undefined
      : merged.canvas.backgroundColor || '#ffffff',
  });
  const nodeCanvas = fabricCanvas.getNodeCanvas();

  const sortedLayers = [...merged.layers]
    .filter((l) => l.visible !== false)
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const layer of sortedLayers) {
    try {
      const obj = await layerToFabricObject(withPrimaryColor(layer, primaryColor), answers, scale, dpi);
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
 * Nadaje obiektowi fabrica style fragmentow tekstu.
 *
 * Wolane PO utworzeniu obiektu, bo dopiero on wie, jak zawinal tekst -
 * a `styles` fabrica sa kluczowane numerem linii po zawinieciu.
 * `fontSize` fragmentu jest w tej samej jednostce co warstwa, wiec przelicza
 * sie tak samo jak rozmiar bazowy.
 */
function applyTextStyleRanges(
  textObject: any,
  text: string,
  props: { styleRanges?: unknown; fontUnit?: unknown },
  dpi: number,
  scale: number
): void {
  const ranges = props.styleRanges as TextStyleRange[] | undefined;
  if (!Array.isArray(ranges) || ranges.length === 0) return;

  const charStyles = resolveCharStyles(text, ranges);
  const lines: string[] = Array.isArray(textObject.textLines) && textObject.textLines.length
    ? textObject.textLines
    : [text];
  const styles = buildFabricTextStyles(text, lines, charStyles);

  const fontUnit = getFontUnit(props.fontUnit);
  const rendered: Record<number, Record<number, Record<string, unknown>>> = {};

  for (const [lineIndex, lineStyles] of Object.entries(styles)) {
    rendered[Number(lineIndex)] = {};
    for (const [charIndex, style] of Object.entries(lineStyles)) {
      const { fontSize, fontWeight, ...rest } = style;
      rendered[Number(lineIndex)][Number(charIndex)] = {
        ...rest,
        ...(fontWeight !== undefined ? { fontWeight: String(fontWeight) } : {}),
        ...(fontSize !== undefined
          ? { fontSize: fontSizeToRenderPx(fontSize, fontUnit, dpi, scale) }
          : {}),
      };
    }
  }

  textObject.set('styles', rendered);
  if (typeof textObject.initDimensions === 'function') textObject.initDimensions();
}

/**
 * Wypelnia spad rozciagnietymi krawedziami projektu.
 *
 * Dziala niezaleznie od tresci: dla jednolitego tla ciagnie kolor, dla zdjecia
 * przedluza jego brzeg. Alternatywa - skalowanie calego projektu - przesunelaby
 * teksty wzgledem linii ciecia.
 */
function drawBleedEdges(
  ctx: any,
  img: any,
  widthPx: number,
  heightPx: number,
  bleedPx: number
): void {
  const halfW = widthPx / 2;
  const halfH = heightPx / 2;
  const strip = Math.max(1, Math.round(Math.min(widthPx, heightPx) * 0.01));

  // Boki
  ctx.drawImage(img, 0, 0, strip, heightPx, -halfW - bleedPx, -halfH, bleedPx, heightPx);
  ctx.drawImage(img, widthPx - strip, 0, strip, heightPx, halfW, -halfH, bleedPx, heightPx);
  ctx.drawImage(img, 0, 0, widthPx, strip, -halfW, -halfH - bleedPx, widthPx, bleedPx);
  ctx.drawImage(img, 0, heightPx - strip, widthPx, strip, -halfW, halfH, widthPx, bleedPx);

  // Naroza
  ctx.drawImage(img, 0, 0, strip, strip, -halfW - bleedPx, -halfH - bleedPx, bleedPx, bleedPx);
  ctx.drawImage(img, widthPx - strip, 0, strip, strip, halfW, -halfH - bleedPx, bleedPx, bleedPx);
  ctx.drawImage(img, 0, heightPx - strip, strip, strip, -halfW - bleedPx, halfH, bleedPx, bleedPx);
  ctx.drawImage(img, widthPx - strip, heightPx - strip, strip, strip, halfW, halfH, bleedPx, bleedPx);
}

export interface WatermarkStyle {
  /** Krycie napisow; 0.16 jest czytelne, a nie zabija projektu. */
  opacity?: number;
  angleDeg?: number;
  /** Ile powtorzen napisu ma zmiescic sie w szerokosci obrazu. */
  columns?: number;
}

/**
 * Kafelkowy znak wodny na calej powierzchni.
 *
 * Pojedynczy napis na srodku (tak bylo wczesniej) wycina sie w minute -
 * wystarczy zaslonic go kawalkiem tla. Siatka powtorzen z przesunieciem co
 * drugi rzad nie zostawia ani czystego pola, ani pionowych korytarzy, wiec
 * usuniecie jej wymaga odtworzenia projektu, a nie retuszu.
 */
function drawWatermark(
  ctx: any,
  widthPx: number,
  heightPx: number,
  watermarkText?: string | null,
  style: WatermarkStyle = {}
): void {
  if (!watermarkText || !watermarkText.trim()) return;

  const text = watermarkText.trim();
  const columns = Math.max(1, style.columns ?? 3);
  const angle = ((style.angleDeg ?? -30) * Math.PI) / 180;

  ctx.save();

  // Rozmiar liczymy z faktycznej szerokosci napisu, nie z liczby znakow -
  // "OK" i "NIE DO DRUKU" maja skrajnie rozna dlugosc przy tym samym stopniu.
  const probeSize = 100;
  ctx.font = `bold ${probeSize}px sans-serif`;
  const probeWidth = Number(ctx.measureText(text).width) || probeSize;
  const fontSize = Math.max(12, (widthPx / columns) * (probeSize / probeWidth));
  ctx.font = `bold ${fontSize}px sans-serif`;
  const textWidth = Number(ctx.measureText(text).width) || widthPx / columns;

  const stepX = textWidth * 1.5;
  const stepY = fontSize * 2.6;
  // Siatka rysowana w ukladzie obroconym musi pokryc przekatna, inaczej
  // przy krawedziach zostaja puste trojkaty.
  const reach = Math.hypot(widthPx, heightPx) / 2 + Math.max(stepX, stepY);

  ctx.globalAlpha = style.opacity ?? 0.16;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(widthPx / 2, heightPx / 2);
  ctx.rotate(angle);

  let row = 0;
  for (let y = -reach; y <= reach; y += stepY) {
    const rowOffset = (row % 2) * (stepX / 2);
    for (let x = -reach; x <= reach; x += stepX) {
      ctx.fillText(text, x + rowOffset, y);
    }
    row += 1;
  }

  ctx.restore();
}

/**
 * Nanosi kafelkowy znak wodny na gotowy obraz (PNG/JPEG) i zwraca nowy bufor.
 *
 * Uzywane tam, gdzie obrazu nie renderujemy sami - np. podglad przyslany
 * przez przegladarke klienta.
 */
export async function applyWatermarkToImage(
  imageBuffer: Buffer,
  watermarkText: string,
  options: WatermarkStyle & { maxWidthPx?: number; format?: 'png' | 'jpeg'; quality?: number } = {}
): Promise<{ buffer: Buffer; widthPx: number; heightPx: number }> {
  const { createCanvas } = await import('canvas');
  const image = await loadImage(imageBuffer);

  // Degradacja rozdzielczosci jest czescia ochrony: podglad ma wystarczyc do
  // sprawdzenia literowki, a nie do wydrukowania u konkurencji.
  const maxWidthPx = options.maxWidthPx;
  const scale = maxWidthPx && image.width > maxWidthPx ? maxWidthPx / image.width : 1;
  const widthPx = Math.max(1, Math.round(image.width * scale));
  const heightPx = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext('2d');
  // Biale tlo pod spodem - przezroczysty PNG zapisany jako JPEG dostalby
  // czarne tlo zamiast papieru.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);
  ctx.drawImage(image as any, 0, 0, widthPx, heightPx);

  drawWatermark(ctx, widthPx, heightPx, watermarkText, options);

  const buffer =
    options.format === 'png'
      ? canvas.toBuffer('image/png')
      : canvas.toBuffer('image/jpeg', { quality: options.quality ?? 0.8 });

  return { buffer, widthPx, heightPx };
}

/**
 * Render strony powiekszony o spad, BEZ obrotu.
 *
 * Wydzielone, bo tego samego bufora potrzebuja dwie sciezki: strona na wlasnym
 * arkuszu (nizej) i uzytek w gniezdzie skladu arkuszowego. Obrot dokleja
 * wolajacy, bo w kazdej z nich obraca sie co innego - tam arkusz, tu sam
 * uzytek wzgledem paserow.
 */
async function renderPageWithBleedPng(
  page: TemplatePage,
  answers: Record<string, any>,
  layoutOverrides?: any,
  itemIndex?: number,
  primaryColor?: string | null
): Promise<{ buffer: Buffer; widthPx: number; heightPx: number; bleedMm: number; bleedPx: number; dpi: number }> {
  const { createCanvas, Image } = await import('canvas');
  const dpi = Number(page.canvas.dpi || 300);
  const render = await renderPageToPng(page, answers, layoutOverrides, itemIndex, PRINT_RENDER_SCALE, primaryColor ?? null);

  // Spad: pole rosnie o margines z kazdej strony, a brakujaca powierzchnie
  // wypelniamy rozciagnietymi krawedziami projektu. Bez tego kartka po
  // przycieciu z tolerancja miala biala nitke przy krawedzi.
  const bleedMm = Math.max(0, Number(page.canvas.bleedMm) || 0);
  // Spad liczymy w tej samej gestosci co render strony - inaczej ramka spadu
  // nie zgadzalaby sie z obrazem i projekt wyszedlby przesuniety.
  const bleedPx = Math.round((bleedMm / MM_PER_INCH) * dpi * PRINT_RENDER_SCALE);
  const widthPx = render.widthPx + bleedPx * 2;
  const heightPx = render.heightPx + bleedPx * 2;

  const canvas = createCanvas(widthPx, heightPx);
  const ctx = canvas.getContext('2d');
  // Przezroczysty projekt zostawia pole nietkniete - inaczej zakrylby podklad
  // arkusza, na ktory zostal polozony.
  if (!isTransparentBackground(page.canvas.backgroundColor)) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthPx, heightPx);
  }

  const img = new Image();
  img.src = render.buffer;
  ctx.save();
  ctx.translate(widthPx / 2, heightPx / 2);
  if (bleedPx > 0) {
    drawBleedEdges(ctx, img, render.widthPx, render.heightPx, bleedPx);
  }
  ctx.drawImage(img, -render.widthPx / 2, -render.heightPx / 2, render.widthPx, render.heightPx);
  ctx.restore();

  return {
    buffer: canvas.toBuffer('image/png'),
    widthPx,
    heightPx,
    bleedMm,
    bleedPx,
    // Gestosc BUFORA, nie projektu: konsument liczy z niej mm, wiec musi znac
    // faktyczna liczbe pikseli na cal.
    dpi: dpi * PRINT_RENDER_SCALE,
  };
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
  const rotation = layout.print?.placements?.find((placement) => placement.pageId === page.id)?.rotation || 0;
  const swap = rotation === 90 || rotation === 270;

  const content = await renderPageWithBleedPng(
    page,
    answers,
    layoutOverrides,
    itemIndex,
    resolvePrimaryColor(layout, layoutOverrides)
  );

  const sheetWidthPx = swap ? content.heightPx : content.widthPx;
  const sheetHeightPx = swap ? content.widthPx : content.heightPx;

  const sheet = createCanvas(sheetWidthPx, sheetHeightPx);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheetWidthPx, sheetHeightPx);

  const img = new Image();
  img.src = content.buffer;
  ctx.save();
  ctx.translate(sheetWidthPx / 2, sheetHeightPx / 2);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(img, -content.widthPx / 2, -content.heightPx / 2, content.widthPx, content.heightPx);
  ctx.restore();

  drawWatermark(ctx, sheetWidthPx, sheetHeightPx, watermarkText);

  const dims = canvasMmDimensions(page.canvas);
  const withBleedWidthMm = dims.widthMm + content.bleedMm * 2;
  const withBleedHeightMm = dims.heightMm + content.bleedMm * 2;
  return {
    buffer: sheet.toBuffer('image/png'),
    widthMm: swap ? withBleedHeightMm : withBleedWidthMm,
    heightMm: swap ? withBleedWidthMm : withBleedHeightMm,
    widthPx: sheetWidthPx,
    heightPx: sheetHeightPx,
    dpi: content.dpi,
  };
}

/**
 * Rysuje pasery Print & Cut - znaczniki, po ktorych ploter ustawia ciecie.
 *
 * Kazdy rog to kat prosty otwarty do srodka arkusza. Ramiona poziome po
 * prawej sa krotsze, bo tak rysuje je Silhouette Studio i na takich plikach
 * ploter zostal wykalibrowany.
 *
 * Wolane na SAMYM KONCU skladania: paser zaslonięty uzytkiem albo podkladem
 * jest dla czujnika nieodroznialny od braku pasera.
 */
function drawRegistrationMarks(
  ctx: any,
  sheetWidthPx: number,
  sheetHeightPx: number,
  marks: RegistrationMarksConfig,
  dpi: number
): void {
  if (marks.preset === 'none') return;

  const mm = (value: number) => (value / MM_PER_INCH) * dpi;
  const thickness = mm(marks.thicknessMm);
  const arm = mm(marks.armLengthMm);
  const armRight = mm(marks.armLengthRightMm);

  const left = mm(marks.insetLeftMm);
  const top = mm(marks.insetTopMm);
  const right = sheetWidthPx - mm(marks.insetRightMm);
  const bottom = sheetHeightPx - mm(marks.insetBottomMm);

  ctx.save();
  ctx.fillStyle = marks.color || '#000000';

  // Lewy gorny
  ctx.fillRect(left, top, arm, thickness);
  ctx.fillRect(left, top, thickness, arm);
  // Prawy gorny
  ctx.fillRect(right - armRight, top, armRight, thickness);
  ctx.fillRect(right - thickness, top, thickness, arm);
  // Lewy dolny
  ctx.fillRect(left, bottom - thickness, arm, thickness);
  ctx.fillRect(left, bottom - arm, thickness, arm);
  // Prawy dolny
  ctx.fillRect(right - armRight, bottom - thickness, armRight, thickness);
  ctx.fillRect(right - thickness, bottom - arm, thickness, arm);

  ctx.restore();
}

/**
 * Arkusz zbiorczy: kilka SZTUK z zamowienia na jednym arkuszu, z paserami.
 *
 * Inne ziarno niz `composePrintSheet` - tam na arkusz ida strony jednego
 * egzemplarza (przod i tyl winietki), tu kolejne sztuki. Gniazd moze byc
 * wiecej niz sztuk: ostatni arkusz niepelnego zamowienia zostaje z pustym
 * miejscem, ale z kompletem paserow, zeby ploter mial po czym ciac.
 */
export async function renderImpositionSheetPng(
  layout: TemplateLayoutJson,
  items: Array<{ answers: Record<string, any>; layoutOverrides?: any; itemIndex: number }>,
  options: { watermarkText?: string | null; pageId?: string } = {}
): Promise<{ buffer: Buffer; widthMm: number; heightMm: number; widthPx: number; heightPx: number; dpi: number }> {
  const { createCanvas, Image } = await import('canvas');

  const imposition = getSheetImposition(layout);
  if (!imposition) throw new Error('Layout nie ma włączonego składu arkuszowego');

  // Arkusz i uzytki musza byc liczone w TEJ SAMEJ gestosci - inaczej uzytek
  // wyrenderowany gesciej zostalby wklejony w skali 1:1 i wyszedl za duzy.
  const dpi = Number(layout.canvas.dpi || 300) * PRINT_RENDER_SCALE;
  const mmToPx = (value: number) => (value / MM_PER_INCH) * dpi;

  // Kolor wiodacy arkusza bierzemy z pierwszej sztuki: podklad jest wspolny
  // dla calego arkusza, wiec nie moze mieć dwoch barw naraz.
  const sheetPrimaryColor = resolvePrimaryColor(layout, items[0]?.layoutOverrides);

  const sheetWidthPx = Math.round(mmToPx(imposition.sheet.widthMm));
  const sheetHeightPx = Math.round(mmToPx(imposition.sheet.heightMm));
  const sheet = createCanvas(sheetWidthPx, sheetHeightPx);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheetWidthPx, sheetHeightPx);

  // Podklad drukowany (ozdobna ramka) idzie pod uzytki, rozciagniety na caly
  // arkusz - jego geometria jest juz zgrana z paserami. Kazda strona moze miec
  // wlasny: przod laduje na wstazce, tyl na czystej kartce.
  const backgroundUrl = getSheetBackgroundUrl(imposition, options.pageId);
  if (backgroundUrl) {
    const backgroundPath = resolveLayerImagePath(backgroundUrl);
    if (!backgroundPath) {
      console.error(`[Fabric] Odrzucony adres podkładu arkusza: ${backgroundUrl}`);
    } else {
      try {
        // Podklad wektorowy bierze kolor wiodacy - tak sama zmiana, ktora
        // przemalowuje tekst, przemalowuje tez kokarde na arkuszu. Raster
        // (PNG/JPG) zostaje w swoich barwach, bo nie ma czego podmienic.
        const background = isSvgPath(backgroundPath)
          ? await loadImage(
              await rasterizeSvgFile({
                filePath: backgroundPath,
                widthPx: sheetWidthPx,
                tint: sheetPrimaryColor,
              })
            )
          : await loadImage(backgroundPath);
        ctx.drawImage(background as any, 0, 0, sheetWidthPx, sheetHeightPx);
      } catch (error) {
        console.error(`[Fabric] Nie udało się wczytać podkładu ${backgroundPath}:`, error);
      }
    }
  }

  for (let index = 0; index < items.length && index < imposition.slots.length; index += 1) {
    const item = items[index];
    const slot = imposition.slots[index];
    // Wariant moze byc inny dla kazdej sztuki - odpowiedzi indywidualne
    // rozjezdzaja sie miedzy pozycjami, wiec strony bierzemy per sztuka.
    const pages = getTemplatePagesForAnswers(layout, item.answers);
    // `options.pageId` wskazuje stronę tego ARKUSZA (przód albo tył); `pageId`
    // gniazda jest silniejszy, bo opisuje wyjątek w obrębie jednego arkusza.
    const wantedPageId = slot.pageId || options.pageId;
    const page = wantedPageId ? pages.find((candidate) => candidate.id === wantedPageId) : pages[0];
    if (!page) {
      console.error(`[Fabric] Gniazdo ${slot.id} wskazuje nieistniejącą stronę ${wantedPageId}`);
      continue;
    }

    const content = await renderPageWithBleedPng(
      page,
      item.answers,
      item.layoutOverrides,
      item.itemIndex,
      resolvePrimaryColor(layout, item.layoutOverrides)
    );

    const swap = slot.rotation === 90 || slot.rotation === 270;
    const dims = canvasMmDimensions(page.canvas);
    const netWidthMm = swap ? dims.heightMm : dims.widthMm;
    const netHeightMm = swap ? dims.widthMm : dims.heightMm;
    const { xMm, yMm } = getSlotPositionMm(slot, imposition);

    // Wspolrzedne gniazda wskazuja linie ciecia, wiec obracamy i rysujemy
    // wokol srodka formatu NETTO - spad wychodzi symetrycznie poza niego.
    const centerX = mmToPx(xMm + netWidthMm / 2);
    const centerY = mmToPx(yMm + netHeightMm / 2);

    const img = new Image();
    img.src = content.buffer;
    ctx.save();
    ctx.translate(centerX, centerY);
    if (slot.rotation) ctx.rotate((slot.rotation * Math.PI) / 180);
    ctx.drawImage(img, -content.widthPx / 2, -content.heightPx / 2, content.widthPx, content.heightPx);
    ctx.restore();
  }

  drawWatermark(ctx, sheetWidthPx, sheetHeightPx, options.watermarkText);
  drawRegistrationMarks(ctx, sheetWidthPx, sheetHeightPx, imposition.marks || SILHOUETTE_MARKS_DEFAULT, dpi);

  return {
    buffer: sheet.toBuffer('image/png'),
    widthMm: imposition.sheet.widthMm,
    heightMm: imposition.sheet.heightMm,
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
  // Wariant wybiera odpowiedz klienta - sklad do druku jest wspolny dla
  // szablonu i wskazuje strony po id, wiec warianty maja te same identyfikatory.
  const pages = getTemplatePagesForAnswers(layout, answers);
  const print = layout.print && layout.print.placements?.length ? layout.print : defaultPrintLayout(pages);
  // Arkusz i strony musza byc liczone w TEJ SAMEJ gestosci - inaczej strona
  // wyrenderowana gesciej zostalaby wklejona w skali 1:1 i wyszla za duza.
  const dpi = Number(layout.canvas.dpi || 300) * PRINT_RENDER_SCALE;
  const mmToPx = (mm: number) => Math.round((mm / MM_PER_INCH) * dpi);

  const rendered = new Map<string, { buffer: Buffer; widthPx: number; heightPx: number }>();
  for (const page of pages) {
    rendered.set(
      page.id,
      await renderPageToPng(page, answers, layoutOverrides, itemIndex, PRINT_RENDER_SCALE, layout.primaryColor)
    );
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
 * Strona projektu w rozdzielczosci podgladowej, ze znakiem wodnym.
 *
 * To NIE jest arkusz do druku: bez spadow, bez obrotow ze skladania i bez
 * lustra. Klient ma zobaczyc kartke tak, jak ja dostanie do reki, a nie
 * plik technologiczny. JPEG zamiast PNG - o rzad wielkosci mniejszy zalacznik
 * i material gorszy do dalszej reprodukcji.
 */
export async function renderProofPagePng(
  page: TemplatePage,
  answers: Record<string, any>,
  layoutOverrides?: any,
  itemIndex?: number,
  options: { dpi?: number; watermarkText?: string | null; quality?: number } = {}
): Promise<{ buffer: Buffer; widthMm: number; heightMm: number; widthPx: number; heightPx: number }> {
  const { createCanvas, Image } = await import('canvas');

  const nativeDpi = Number(page.canvas.dpi || 300);
  const proofDpi = Math.max(72, Math.min(nativeDpi, Number(options.dpi) || PROOF_DPI));
  const render = await renderPageToPng(page, answers, layoutOverrides, itemIndex, proofDpi / nativeDpi);

  const canvas = createCanvas(render.widthPx, render.heightPx);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, render.widthPx, render.heightPx);

  const img = new Image();
  img.src = render.buffer;
  ctx.drawImage(img, 0, 0, render.widthPx, render.heightPx);

  drawWatermark(ctx, render.widthPx, render.heightPx, options.watermarkText);

  const dims = canvasMmDimensions(page.canvas);
  return {
    buffer: canvas.toBuffer('image/jpeg', { quality: options.quality ?? 0.78 }),
    widthMm: dims.widthMm,
    heightMm: dims.heightMm,
    widthPx: render.widthPx,
    heightPx: render.heightPx,
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

  // Mockup pokazuje to, co pojdzie do druku - czyli wariant wybrany odpowiedziami.
  const pages = getTemplatePagesForAnswers(layout, answers);

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
