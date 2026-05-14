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
  width: number;        // szerokość w px
  height: number;       // wysokość w px
  unit: 'px' | 'mm';   // jednostka bazowa
  dpi: number;          // rozdzielczość (300 dla druku)
  bleed: number;        // spadówka w px
  safeArea: number;     // strefa bezpieczna w px
  backgroundColor: string;
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
export function createEmptyLayout(width: number, height: number, dpi = 300): TemplateLayoutJson {
  return {
    version: 1,
    canvas: {
      width,
      height,
      unit: 'px',
      dpi,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [],
  };
}
