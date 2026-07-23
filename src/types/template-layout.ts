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
export type CanvasConfigInput = Partial<CanvasConfig>;

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

const DEFAULT_CANVAS_FORMAT: TemplateFormatPreset = 'THANK_YOU_148X105';
const DEFAULT_CANVAS_PRESET = TEMPLATE_FORMAT_PRESETS.find((preset) => preset.key === DEFAULT_CANVAS_FORMAT)!;

function toPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function toNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveFormatPreset(value: unknown): TemplateFormatPreset | undefined {
  if (typeof value !== 'string') return undefined;
  return TEMPLATE_FORMAT_PRESETS.some((preset) => preset.key === value)
    ? value as TemplateFormatPreset
    : undefined;
}

function getPresetDimensions(formatPreset?: TemplateFormatPreset): TemplateFormatOption {
  if (!formatPreset || formatPreset === 'CUSTOM') return DEFAULT_CANVAS_PRESET;
  return TEMPLATE_FORMAT_PRESETS.find((preset) => preset.key === formatPreset) ?? DEFAULT_CANVAS_PRESET;
}

export function mmToPx(mm: number, dpi = 300): number {
  return Math.round((mm / 25.4) * dpi);
}

export function pxToMm(px: number, dpi = 300): number {
  return Number(((px / dpi) * 25.4).toFixed(2));
}

export function getCanvasWidthMm(canvas: CanvasConfigInput): number {
  const explicitWidthMm = toPositiveNumber(canvas.widthMm);
  if (explicitWidthMm) return explicitWidthMm;

  const formatPreset = resolveFormatPreset(canvas.formatPreset);
  if (formatPreset && formatPreset !== 'CUSTOM') return getPresetDimensions(formatPreset).widthMm;

  const widthPx = toPositiveNumber(canvas.width);
  if (widthPx) return pxToMm(widthPx, toPositiveNumber(canvas.dpi) ?? 300);

  return DEFAULT_CANVAS_PRESET.widthMm;
}

export function getCanvasHeightMm(canvas: CanvasConfigInput): number {
  const explicitHeightMm = toPositiveNumber(canvas.heightMm);
  if (explicitHeightMm) return explicitHeightMm;

  const formatPreset = resolveFormatPreset(canvas.formatPreset);
  if (formatPreset && formatPreset !== 'CUSTOM') return getPresetDimensions(formatPreset).heightMm;

  const heightPx = toPositiveNumber(canvas.height);
  if (heightPx) return pxToMm(heightPx, toPositiveNumber(canvas.dpi) ?? 300);

  return DEFAULT_CANVAS_PRESET.heightMm;
}

export function getCanvasWidthPx(canvas: CanvasConfigInput): number {
  const dpi = toPositiveNumber(canvas.dpi) ?? 300;
  return mmToPx(getCanvasWidthMm(canvas), dpi);
}

export function getCanvasHeightPx(canvas: CanvasConfigInput): number {
  const dpi = toPositiveNumber(canvas.dpi) ?? 300;
  return mmToPx(getCanvasHeightMm(canvas), dpi);
}

export function normalizeCanvasConfig(canvas: CanvasConfigInput): CanvasConfig {
  const dpi = toPositiveNumber(canvas.dpi) ?? 300;
  const widthMm = getCanvasWidthMm(canvas);
  const heightMm = getCanvasHeightMm(canvas);
  const bleedMm = toNonNegativeNumber(canvas.bleedMm) ?? pxToMm(toNonNegativeNumber(canvas.bleed) ?? 0, dpi);
  const safeAreaMm = toNonNegativeNumber(canvas.safeAreaMm) ?? pxToMm(toNonNegativeNumber(canvas.safeArea) ?? 0, dpi);
  const formatPreset = resolveFormatPreset(canvas.formatPreset);

  return {
    width: mmToPx(widthMm, dpi),
    height: mmToPx(heightMm, dpi),
    unit: 'mm',
    widthMm,
    heightMm,
    ...(formatPreset ? { formatPreset } : {}),
    dpi,
    bleedMm,
    safeAreaMm,
    bleed: mmToPx(bleedMm, dpi),
    safeArea: mmToPx(safeAreaMm, dpi),
    backgroundColor: typeof canvas.backgroundColor === 'string' && canvas.backgroundColor
      ? canvas.backgroundColor
      : '#ffffff',
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

export type SimpleSlotKey =
  | 'TOP_LEFT'
  | 'TOP_CENTER'
  | 'TOP_RIGHT'
  | 'MIDDLE_LEFT'
  | 'MIDDLE_CENTER'
  | 'MIDDLE_RIGHT'
  | 'BOTTOM_LEFT'
  | 'BOTTOM_CENTER'
  | 'BOTTOM_RIGHT';

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
  simpleSlot?: SimpleSlotKey;  // pozycja w trybie SIMPLE
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
  simpleSlot?: SimpleSlotKey;  // pozycja w trybie SIMPLE
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
