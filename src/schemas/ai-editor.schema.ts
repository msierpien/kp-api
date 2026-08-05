import { z } from 'zod';

/**
 * Kontrakt asystenta w edytorze klienta.
 *
 * Kazda operacja, ktora model moze zaproponowac, jest tu wymieniona z nazwy.
 * To nie jest formalnosc: odpowiedz modelu wraca do przegladarki klienta
 * i steruje jego projektem, a tresci w prompcie (imiona gosci, dedykacje)
 * pochodza od osob trzecich. Zamkniety zbior operacji sprawia, ze nawet
 * udana proba wstrzykniecia polecenia nie wykona niczego poza przesunieciem
 * warstwy, ktora i tak nalezy do tego projektu.
 */

export const AI_EDITOR_ACTIONS = ['TEXT', 'LAYOUT', 'AUDIT'] as const;
export type AiEditorAction = (typeof AI_EDITOR_ACTIONS)[number];

/** Intencje tekstowe - kazda ma inny prompt i inne oczekiwania co do dlugosci. */
export const AI_TEXT_INTENTS = ['WISHES', 'PROOFREAD', 'SHORTEN', 'REWRITE'] as const;
export type AiTextIntent = (typeof AI_TEXT_INTENTS)[number];

const textAlign = z.enum(['left', 'center', 'right', 'justify']);

/**
 * Operacja na projekcie. Nazwy odpowiadaja akcjom reduktora nadpisan
 * w portalu klienta - dzieki temu przyjecie propozycji przechodzi przez
 * zwykla sciezke zmian i daje sie cofnac jednym Ctrl+Z.
 */
export const layoutOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('setGeometry'),
    layerId: z.string().min(1),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
  }),
  z.object({
    op: z.literal('setStyle'),
    layerId: z.string().min(1),
    fontSize: z.number().finite().positive().optional(),
    textAlign: textAlign.optional(),
    autoFit: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('setText'),
    layerId: z.string().min(1),
    text: z.string().max(2000),
  }),
  z.object({
    op: z.literal('setVisibility'),
    layerId: z.string().min(1),
    visible: z.boolean(),
  }),
]);

export type LayoutOperation = z.infer<typeof layoutOperationSchema>;

/** Warstwa w postaci, w jakiej opisujemy ja modelowi (i przyjmujemy z portalu). */
export const editorLayerSchema = z.object({
  id: z.string().min(1),
  /** text | textbox | static_text | image | ... - decyduje, co wolno zmienic. */
  type: z.string().min(1),
  name: z.string().max(200).optional(),
  /** Geometria w milimetrach - model nie musi znac pikseli szablonu. */
  xMm: z.number().finite(),
  yMm: z.number().finite(),
  widthMm: z.number().finite().nonnegative(),
  heightMm: z.number().finite().nonnegative(),
  fontSize: z.number().finite().positive().optional(),
  textAlign: textAlign.optional(),
  /** Tresc widoczna na ogladanej sztuce. */
  text: z.string().max(2000).optional(),
  /** Czy tresc rozni sie miedzy sztukami (pole z listy gosci). */
  individual: z.boolean().optional(),
  /** Czy klient moze ta warstwe ruszac / stylowac - model ma tego pilnowac. */
  canMove: z.boolean().optional(),
  canStyle: z.boolean().optional(),
});

export type EditorLayer = z.infer<typeof editorLayerSchema>;

export const editorPageSchema = z.object({
  widthMm: z.number().finite().positive(),
  heightMm: z.number().finite().positive(),
  safeAreaMm: z.number().finite().nonnegative().default(0),
  bleedMm: z.number().finite().nonnegative().default(0),
  layers: z.array(editorLayerSchema).max(200),
});

/** Problem znaleziony przez walidacje - agent audytu dostaje go jako kontekst. */
const issueSchema = z.object({
  field: z.string().max(200).optional(),
  fieldLabel: z.string().max(200).optional(),
  message: z.string().max(500),
  severity: z.enum(['error', 'warning']).optional(),
  itemIndex: z.number().int().nonnegative().optional(),
});

// ============================================
// Wejscie z portalu klienta
// ============================================

export const aiTextRequestSchema = z.object({
  intent: z.enum(AI_TEXT_INTENTS),
  /** Tekst do obrobki. Przy WISHES moze byc pusty. */
  currentText: z.string().max(2000).optional(),
  /** Nazwa warstwy / pola - podpowiada modelowi, o czym jest ten napis. */
  fieldLabel: z.string().max(200).optional(),
  /** Ile znakow miesci sie w polu - wynika z ramki warstwy. */
  maxChars: z.number().int().positive().max(2000).optional(),
  /** Nazwa produktu i okazja - "Zaproszenie slubne", "25 lipca 2026". */
  context: z.string().max(1000).optional(),
});

export const aiLayoutRequestSchema = z.object({
  page: editorPageSchema,
  /** Co konkretnie klient chce poprawic. Puste = ogolna ocena ukladu. */
  goal: z.string().max(500).optional(),
  /** Warstwa, na ktorej klient stoi - propozycja ma dotyczyc glownie jej. */
  focusLayerId: z.string().max(100).optional(),
  issues: z.array(issueSchema).max(50).optional(),
});

export const aiAuditRequestSchema = z.object({
  page: editorPageSchema,
  issues: z.array(issueSchema).max(50).optional(),
  /** Ile sztuk i ile z nich ma komplet danych. */
  itemCount: z.number().int().nonnegative().optional(),
  filledCount: z.number().int().nonnegative().optional(),
});

export type AiTextRequest = z.infer<typeof aiTextRequestSchema>;
export type AiLayoutRequest = z.infer<typeof aiLayoutRequestSchema>;
export type AiAuditRequest = z.infer<typeof aiAuditRequestSchema>;

// ============================================
// Odpowiedz modelu (przed walidacja wzgledem strony)
// ============================================

export const aiTextResponseSchema = z.object({
  variants: z.array(z.string().max(2000)).min(1).max(3),
  notes: z.array(z.string().max(300)).max(3).optional(),
});

export const aiLayoutResponseSchema = z.object({
  operations: z.array(layoutOperationSchema).max(20),
  explanation: z.string().max(600),
});

export const aiAuditFindingSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  title: z.string().max(160),
  description: z.string().max(600),
  operations: z.array(layoutOperationSchema).max(10).optional(),
});

export const aiAuditResponseSchema = z.object({
  findings: z.array(aiAuditFindingSchema).max(10),
});

export type AiAuditFinding = z.infer<typeof aiAuditFindingSchema>;
