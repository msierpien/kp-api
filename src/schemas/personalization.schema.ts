import { z } from 'zod';

/**
 * Schemat nadpisan layoutu przysylanych przez portal klienta.
 *
 * Do tej pory `layoutOverrides` szlo do bazy i do renderera jako surowy JSON -
 * jedyna kontrola byla liczba elementow i dlugosc tekstu. Klient dostarcza
 * jednak CALE obiekty warstw (`addedLayers[].layer`), wiec mogl podac dowolne
 * `imageUrl`, a renderer robil z niego `path.join(storage, imageUrl)` albo
 * pobieral adres http - czyli path traversal i SSRF jednym polem.
 *
 * UWAGA (ta sama pulapka co w admin.schema.ts): `z.object` po cichu usuwa
 * klucze spoza schematu. Kazde nowe pole nadpisania trzeba dopisac TUTAJ,
 * inaczej zniknie przy zapisie.
 */

export const MAX_ADDED_LAYERS = 40;
export const MAX_ADDED_LAYER_TEXT = 2000;
export const MAX_CUSTOM_FIELDS = 10;
export const MAX_CUSTOM_FIELD_LABEL = 60;
/** Sufit na liczbe sztuk z wlasnymi nadpisaniami (lista gosci bywa dluga). */
const MAX_ITEM_ENTRIES = 500;
/** Sufit na liczbe warstw w jednym wiadrze nadpisan. */
const MAX_LAYER_ENTRIES = 200;

/** Wspolrzedne i wymiary w px szablonu - z zapasem, ale nie w nieskonczonosc. */
const coordinate = z.number().finite().min(-100_000).max(100_000);
const dimension = z.number().finite().min(0).max(100_000);
const color = z.string().max(64);

/**
 * Sciezka pliku w storage - jedyna forma `imageUrl`, jaka przyjmujemy od
 * klienta. Bez protokolu (SSRF), bez `..` i bez wiodacego `/` (wyjscie poza
 * katalog storage). Renderer i tak przepuszcza ja przez `safeStoragePath`,
 * ale zla sciezka ma polec juz przy zapisie, a nie dopiero przy druku.
 */
const storageRelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/^[a-z][a-z0-9+.-]*:/i.test(value), {
    message: 'Adres grafiki musi wskazywać plik w magazynie, nie adres zewnętrzny',
  })
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), {
    message: 'Nieprawidłowa ścieżka grafiki',
  })
  .refine((value) => !value.split(/[\\/]/).includes('..'), {
    message: 'Nieprawidłowa ścieżka grafiki',
  });

const textAlign = z.enum(['left', 'center', 'right', 'justify']);

/** Zgody, ktore klient nadaje wlasnemu elementowi (na warstwach szablonu decyduje projektant). */
const clientFlags = {
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
  clientFontSize: z.boolean().optional(),
  clientFontFamily: z.boolean().optional(),
  clientColor: z.boolean().optional(),
  clientTextAlign: z.boolean().optional(),
  clientFontWeight: z.boolean().optional(),
};

const textPropertiesSchema = z.object({
  type: z.enum(['text', 'textbox']).optional(),
  text: z.string().max(MAX_ADDED_LAYER_TEXT).optional(),
  fieldKey: z.string().max(120).optional(),
  placeholder: z.string().max(200).optional(),
  fontSize: z.number().finite().min(1).max(2000).optional(),
  fontUnit: z.enum(['pt', 'px']).optional(),
  fontFamily: z.string().max(120).optional(),
  fontWeight: z.number().finite().min(1).max(1000).optional(),
  fontStyle: z.string().max(32).optional(),
  fill: color.optional(),
  textAlign: textAlign.optional(),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
  lineHeight: z.number().finite().min(0.1).max(10).optional(),
  maxLines: z.number().int().min(1).max(100).optional(),
  textTransform: z.string().max(32).optional(),
  splitByGrapheme: z.boolean().optional(),
  editable: z.boolean().optional(),
  padding: z.number().finite().min(0).max(1000).optional(),
  backgroundColor: color.optional(),
  backgroundOpacity: z.number().finite().min(0).max(1).optional(),
  borderColor: color.optional(),
  borderWidth: z.number().finite().min(0).max(1000).optional(),
  ...clientFlags,
});

const imagePropertiesSchema = z.object({
  type: z.literal('image').optional(),
  imageUrl: storageRelativePath,
  fit: z.enum(['contain', 'cover', 'fill']).optional(),
  tint: color.optional(),
  lockAspectRatio: z.boolean().optional(),
  ...clientFlags,
});

const baseAddedLayer = {
  id: z.string().min(1).max(120),
  name: z.string().max(200).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  zIndex: z.number().finite().min(-10_000).max(10_000).optional(),
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  rotation: z.number().finite().min(-360).max(360).optional(),
};

/**
 * Warstwa dodana przez klienta. Tylko trzy typy - portal nie tworzy innych,
 * a tlo czy linia ciecia to decyzje projektanta szablonu.
 */
const addedLayerSchema = z.discriminatedUnion('type', [
  z.object({ ...baseAddedLayer, type: z.literal('text'), properties: textPropertiesSchema }),
  z.object({ ...baseAddedLayer, type: z.literal('textbox'), properties: textPropertiesSchema }),
  z.object({ ...baseAddedLayer, type: z.literal('image'), properties: imagePropertiesSchema }),
]);

/** Nadpisanie pojedynczej warstwy - geometria i styl, ktory szablon dopuszcza. */
const layerOverrideSchema = z.object({
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  rotation: z.number().finite().min(-360).max(360).optional(),
  zIndex: z.number().finite().min(-10_000).max(10_000).optional(),
  visible: z.boolean().optional(),
  fontSize: z.number().finite().min(1).max(2000).optional(),
  fontFamily: z.string().max(120).optional(),
  fill: color.optional(),
  textAlign: textAlign.optional(),
  fontWeight: z.number().finite().min(1).max(1000).optional(),
  text: z.string().max(MAX_ADDED_LAYER_TEXT).optional(),
  tint: color.optional(),
  /** Pole wylacznie kliencie - renderer czyta gotowy `fontSize`. */
  autoFit: z.boolean().optional(),
});

const layersMapSchema = z.record(z.string().max(120), layerOverrideSchema).refine(
  (value) => Object.keys(value).length <= MAX_LAYER_ENTRIES,
  { message: `Za dużo nadpisanych warstw (maksymalnie ${MAX_LAYER_ENTRIES})` }
);

export const layoutOverridesSchema = z.object({
  layers: layersMapSchema.optional(),
  items: z
    .record(
      z.string().max(12),
      z.object({ layers: layersMapSchema.optional() })
    )
    .refine((value) => Object.keys(value).length <= MAX_ITEM_ENTRIES, {
      message: `Za dużo sztuk z własnymi ustawieniami (maksymalnie ${MAX_ITEM_ENTRIES})`,
    })
    .optional(),
  addedLayers: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        pageId: z.string().min(1).max(120),
        layer: addedLayerSchema,
      })
    )
    .max(MAX_ADDED_LAYERS, `Za dużo dodanych elementów (maksymalnie ${MAX_ADDED_LAYERS})`)
    .optional(),
  customFields: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[a-z0-9_]+$/i, 'Nieprawidłowy klucz kolumny'),
        label: z.string().min(1).max(MAX_CUSTOM_FIELD_LABEL),
        scope: z.enum(['SHARED', 'INDIVIDUAL']),
      })
    )
    .max(MAX_CUSTOM_FIELDS, `Za dużo dodanych kolumn (maksymalnie ${MAX_CUSTOM_FIELDS})`)
    .optional(),
});

export type LayoutOverridesInput = z.infer<typeof layoutOverridesSchema>;

export type LayoutOverridesParseResult =
  | { ok: true; data: LayoutOverridesInput | undefined }
  | { ok: false; message: string };

/**
 * Waliduje nadpisania z requestu. Brak pola to poprawny przypadek - klient
 * moze zapisac same odpowiedzi, bez ruszania projektu.
 */
export function parseLayoutOverrides(input: unknown): LayoutOverridesParseResult {
  if (input === undefined || input === null) return { ok: true, data: undefined };

  const result = layoutOverridesSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };

  const issue = result.error.issues[0];
  const path = issue?.path?.length ? ` (${issue.path.join('.')})` : '';
  return {
    ok: false,
    message: `Nieprawidłowe zmiany projektu${path}: ${issue?.message || 'nieznany błąd'}`,
  };
}
