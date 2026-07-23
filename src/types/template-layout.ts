// ============================================
// Template Layout JSON - definicja struktury wizualnej szablonu
// ============================================

/**
 * Główna struktura layoutu szablonu.
 * Zapisywana w PersonalizationTemplate.layoutJson
 */
export interface TemplateLayoutJson {
  version: 1;
  canvas: CanvasConfig;
  fonts: FontConfig[];
  layers: Layer[];
}

// ============================================
// Canvas
// ============================================

export interface CanvasConfig {
  width: number;        // pochodna szerokość w px dla kompatybilności renderera
  height: number;       // pochodna wysokość w px dla kompatybilności renderera
  unit: 'px' | 'mm';   // dla nowych layoutów źródłem prawdy jest mm
  widthMm?: number;
  heightMm?: number;
  formatPreset?: TemplateFormatPreset;
  dpi: number;          // rozdzielczość (300 dla druku)
  bleed: number;        // pochodna spadówka w px
  safeArea: number;     // pochodna strefa bezpieczna w px
  bleedMm?: number;
  safeAreaMm?: number;
  backgroundColor: string;
}

export type TemplateFormatPreset = 'WINIETKA_90X50' | 'A6_105X148' | 'DL_99X210' | 'THANK_YOU_148X105' | 'CUSTOM';

export interface TemplateFormatOption {
  key: TemplateFormatPreset;
  label: string;
  widthMm: number;
  heightMm: number;
}

export const TEMPLATE_FORMAT_PRESETS: TemplateFormatOption[] = [
  { key: 'WINIETKA_90X50', label: 'Winietka 90 x 50 mm', widthMm: 90, heightMm: 50 },
  { key: 'A6_105X148', label: 'A6 105 x 148 mm', widthMm: 105, heightMm: 148 },
  { key: 'DL_99X210', label: 'DL 99 x 210 mm', widthMm: 99, heightMm: 210 },
  { key: 'THANK_YOU_148X105', label: 'Podziękowania 148 x 105 mm', widthMm: 148, heightMm: 105 },
  { key: 'CUSTOM', label: 'Własny format', widthMm: 148, heightMm: 105 },
];

export function mmToPx(mm: number, dpi = 300): number {
  return Math.round((mm / 25.4) * dpi);
}

export function pxToMm(px: number, dpi = 300): number {
  return Number(((px / dpi) * 25.4).toFixed(2));
}

export function getCanvasWidthMm(canvas: CanvasConfig): number {
  if (typeof canvas.widthMm === 'number' && canvas.widthMm > 0) return canvas.widthMm;
  return pxToMm(canvas.width, canvas.dpi || 300);
}

export function getCanvasHeightMm(canvas: CanvasConfig): number {
  if (typeof canvas.heightMm === 'number' && canvas.heightMm > 0) return canvas.heightMm;
  return pxToMm(canvas.height, canvas.dpi || 300);
}

export function getCanvasWidthPx(canvas: CanvasConfig): number {
  if (canvas.unit === 'mm' && canvas.widthMm) return mmToPx(canvas.widthMm, canvas.dpi || 300);
  return canvas.width;
}

export function getCanvasHeightPx(canvas: CanvasConfig): number {
  if (canvas.unit === 'mm' && canvas.heightMm) return mmToPx(canvas.heightMm, canvas.dpi || 300);
  return canvas.height;
}

export function normalizeCanvasConfig(canvas: CanvasConfig): CanvasConfig {
  const dpi = canvas.dpi || 300;
  const widthMm = getCanvasWidthMm(canvas);
  const heightMm = getCanvasHeightMm(canvas);
  const bleedMm = typeof canvas.bleedMm === 'number' ? canvas.bleedMm : pxToMm(canvas.bleed || 0, dpi);
  const safeAreaMm = typeof canvas.safeAreaMm === 'number' ? canvas.safeAreaMm : pxToMm(canvas.safeArea || 0, dpi);

  return {
    ...canvas,
    unit: 'mm',
    widthMm,
    heightMm,
    width: mmToPx(widthMm, dpi),
    height: mmToPx(heightMm, dpi),
    dpi,
    bleedMm,
    safeAreaMm,
    bleed: mmToPx(bleedMm, dpi),
    safeArea: mmToPx(safeAreaMm, dpi),
  };
}

// ============================================
// Fonts
// ============================================

export interface FontConfig {
  family: string;       // np. "Great Vibes"
  src: string;          // URL Google Fonts lub lokalna ścieżka
  weight: number;       // np. 400, 600, 700
  style: 'normal' | 'italic';
}

// ============================================
// Layers
// ============================================

export type LayerType = 'background' | 'image' | 'text' | 'static_text' | 'textbox' | 'shape' | 'cut_line';

export interface LayerBase {
  id: string;
  name: string;
  type: LayerType;
  visible: boolean;
  locked: boolean;
  opacity: number;      // 0-1
  zIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;     // w stopniach
}

// Discriminated union layers
export type Layer =
  | BackgroundLayer
  | ImageLayer
  | TextFieldLayer
  | StaticTextLayer
  | TextBoxLayer
  | ShapeLayer
  | CutLineLayer;

// ============================================
// Layer types
// ============================================

export interface BackgroundLayer extends LayerBase {
  type: 'background';
  properties: BackgroundProperties;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  properties: ImageProperties;
}

export interface TextFieldLayer extends LayerBase {
  type: 'text';
  properties: TextFieldProperties;
}

export interface StaticTextLayer extends LayerBase {
  type: 'static_text';
  properties: StaticTextProperties;
}

export interface TextBoxLayer extends LayerBase {
  type: 'textbox';
  properties: TextBoxProperties;
}

export interface ShapeLayer extends LayerBase {
  type: 'shape';
  properties: ShapeProperties;
}

export interface CutLineLayer extends LayerBase {
  type: 'cut_line';
  properties: CutLineProperties;
}

// ============================================
// Properties per layer type
// ============================================

export interface BackgroundProperties {
  type: 'background';
  imageUrl: string;           // ścieżka do pliku w storage
  fit: 'cover' | 'contain' | 'fill';
}

export interface ImageProperties {
  type: 'image';
  imageUrl: string;
  fit: 'cover' | 'contain' | 'fill';
}

/**
 * Pole tekstowe edytowalne przez klienta.
 * fieldKey łączy warstwę z FormField.key w bazie danych.
 */
export interface TextFieldProperties {
  type: 'text';
  fieldKey: string;           // KLUCZ POWIĄZANIA z FormField.key
  placeholder: string;
  fontSize: number;
  fontUnit?: 'px' | 'pt';
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string;               // kolor tekstu (hex)
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  maxLines: number;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  editable: true;
  // Client interaction settings
  clientDraggable?: boolean;  // Czy klient może przesuwać
  clientResizable?: boolean;  // Czy klient może zmieniać rozmiar
  clientRotatable?: boolean;  // Czy klient może obracać
}

/**
 * Stały tekst - nie edytowalny przez klienta.
 * @deprecated Użyj TextBoxLayer z editable: false
 */
export interface StaticTextProperties {
  type: 'static_text';
  text: string;               // stały tekst
  fontSize: number;
  fontUnit?: 'px' | 'pt';
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  editable: false;
}

/**
 * TextBox - pole tekstowe z ramką (Frame Text).
 * Może być edytowalne lub statyczne.
 */
export interface TextBoxProperties {
  type: 'textbox';
  fieldKey?: string;          // opcjonalny klucz powiązania z FormField.key
  text: string;               // tekst (może zawierać {{ fieldKey }})
  fontSize: number;
  fontUnit?: 'px' | 'pt';
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fill: string;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  verticalAlign: 'top' | 'middle' | 'bottom';
  lineHeight: number;
  padding: number;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  editable: boolean;          // czy edytowalne przez klienta
  // Client interaction settings
  clientDraggable?: boolean;  // Czy klient może przesuwać
  clientResizable?: boolean;  // Czy klient może zmieniać rozmiar
  clientRotatable?: boolean;  // Czy klient może obracać
}

export interface ShapeProperties {
  type: 'shape';
  shapeType: 'rectangle' | 'circle' | 'ellipse' | 'line';
  fill: string;
  stroke: string;
  strokeWidth: number;
  borderRadius: number;
}

export interface CutLineProperties {
  type: 'cut_line';
  stroke: string;
  strokeWidth: number;
  strokeDashArray: number[];
  clientVisible: false;       // zawsze niewidoczne dla klienta
}

// ============================================
// Template Asset (plik graficzny szablonu)
// ============================================

export interface TemplateAssetItem {
  id: string;
  templateId: string;
  assetType: 'BACKGROUND' | 'DECORATION' | 'LOGO' | 'CUT_LINE_SVG';
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  metadata: {
    width?: number;
    height?: number;
    originalName?: string;
  } | null;
  sortOrder: number;
  createdAt: Date;
}

// ============================================
// Helpers
// ============================================

/**
 * Tworzy domyślny pusty layout dla nowego szablonu.
 */
export function createEmptyLayout(
  widthMm = 148,
  heightMm = 105,
  dpi = 300,
  formatPreset: TemplateFormatPreset = 'THANK_YOU_148X105'
): TemplateLayoutJson {
  const canvas = normalizeCanvasConfig({
    width: mmToPx(widthMm, dpi),
    height: mmToPx(heightMm, dpi),
    unit: 'mm',
    widthMm,
    heightMm,
    formatPreset,
    dpi,
    bleed: 0,
    safeArea: 0,
    bleedMm: 0,
    safeAreaMm: 0,
    backgroundColor: '#ffffff',
  });

  return {
    version: 1,
    canvas,
    fonts: [],
    layers: [],
  };
}
