import { createCanvas as createNodeCanvas, loadImage, registerFont } from 'canvas';
import { StaticCanvas, FabricImage, IText, Textbox } from 'fabric/node';
import type { TemplateLayoutJson, Layer, TextFieldProperties, TextBoxProperties, ImageProperties } from '../../types/template-layout';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../../config';

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

/**
 * Ładuje czcionkę Google Fonts do node-canvas
 */
async function loadGoogleFont(fontFamily: string, weight: number = 400): Promise<void> {
  const fontKey = `${fontFamily}-${weight}`;
  if (loadedFonts.has(fontKey)) return;

  try {
    const fontPath = path.join(__dirname, '../../fonts', `${fontFamily.replace(/\s+/g, '-')}-${weight}.ttf`);
    await fs.access(fontPath);
    registerFont(fontPath, { family: fontFamily, weight: String(weight) });
    loadedFonts.add(fontKey);
    console.log(`[Fabric] Font loaded: ${fontFamily} (${weight})`);
  } catch (error) {
    console.warn(`[Fabric] Font not found: ${fontFamily}, using system default`);
  }
}

/**
 * Ładuje wszystkie czcionki z layoutu
 */
async function loadLayoutFonts(layout: TemplateLayoutJson): Promise<void> {
  const fonts = new Set<string>();
  
  for (const layer of layout.layers) {
    if (layer.type === 'text' || layer.type === 'static_text' || layer.type === 'textbox') {
      const props = layer.properties as any;
      const weight = props.fontWeight || 400;
      fonts.add(`${props.fontFamily}-${weight}`);
    }
  }
  
  for (const fontKey of fonts) {
    const [family, weight] = fontKey.split('-');
    await loadGoogleFont(family, parseInt(weight));
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
      
      return {
        ...layer,
        x: override.x ?? layer.x,
        y: override.y ?? layer.y,
        width: override.width ?? layer.width,
        height: override.height ?? layer.height,
        rotation: override.rotation ?? layer.rotation,
      };
    })
  };
}

/**
 * Konwertuje Layer na obiekt Fabric.js
 */
async function layerToFabricObject(
  layer: Layer,
  answers: Record<string, any>,
  scale: number,
  assetBaseUrl: string
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
      : `${assetBaseUrl}${props.imageUrl}`;
    
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
      fontSize: props.fontSize * scale,
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
      fontSize: props.fontSize * scale,
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
    
    return new Textbox(value, {
      ...common,
      fontSize: props.fontSize * scale,
      fontFamily: props.fontFamily,
      fontWeight: String(props.fontWeight || 400),
      fontStyle: props.fontStyle || 'normal',
      fill: props.fill,
      textAlign: props.textAlign as any,
      backgroundColor: props.backgroundColor,
      padding: props.padding || 10,
      originX: 'center',
      originY: 'center',
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

  // Merge layout z overrides
  const layout = mergeLayoutWithOverrides(data.layoutConfig, data.layoutOverrides);

  // Załaduj czcionki
  await loadLayoutFonts(layout);

  // Oblicz finalne wymiary
  const finalWidth = width * deviceScaleFactor;
  const finalHeight = height * deviceScaleFactor;
  const finalScale = scale * deviceScaleFactor;

  // Utwórz node-canvas
  const nodeCanvas = createNodeCanvas(finalWidth, finalHeight);
  
  // Utwórz Static Canvas Fabric.js dla Node.js
  // fabric/node automatycznie używa node-canvas
  const fabricCanvas = new StaticCanvas(nodeCanvas as any, {
    width: finalWidth,
    height: finalHeight,
    backgroundColor: layout.canvas.backgroundColor || '#ffffff',
  });

  // Asset base URL
  const assetBaseUrl = config.app.url;

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
        assetBaseUrl
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
