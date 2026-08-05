import {
  layoutOperationSchema,
  type EditorLayer,
  type LayoutOperation,
} from '../../schemas/ai-editor.schema';

/**
 * Przepuszczanie operacji zaproponowanych przez model.
 *
 * Model dostaje w prompcie tresci wpisane przez osoby trzecie (imiona gosci,
 * dedykacje) i zwraca JSON, ktory steruje projektem klienta. Zamiast ufac tej
 * odpowiedzi, przycinamy ja do tego, co ma sens na TEJ stronie: istniejaca
 * warstwa, ktorej klient i tak moze dotknac, geometria w granicach arkusza,
 * rozmiar pisma w granicach szablonu.
 *
 * Operacja, ktora nie przechodzi, jest odrzucana z powodem - powod trafia do
 * dziennika, zeby dalo sie zobaczyc, ze model probowal czegos dziwnego.
 */

/** Warstwy techniczne nalezace do szablonu - klient ich nie rozbiera. */
const TECHNICAL_LAYER_TYPES = new Set(['background', 'cut_line', 'shape']);

/** Te same granice, co w panelu klienta (layer-style.ts w kp-client). */
const MIN_SIZE_RATIO = 0.5;
const MAX_SIZE_RATIO = 2;
const ABSOLUTE_MIN_FONT = 6;
const ABSOLUTE_MAX_FONT = 200;

export interface SanitizeResult {
  operations: LayoutOperation[];
  rejected: Array<{ operation: unknown; reason: string }>;
}

interface SanitizeInput {
  operations: unknown;
  layers: EditorLayer[];
  page: { widthMm: number; heightMm: number; safeAreaMm: number };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeLayoutOperations({
  operations,
  layers,
  page,
}: SanitizeInput): SanitizeResult {
  const accepted: LayoutOperation[] = [];
  const rejected: Array<{ operation: unknown; reason: string }> = [];

  if (!Array.isArray(operations)) {
    return { operations: accepted, rejected };
  }

  const byId = new Map(layers.map((layer) => [layer.id, layer]));

  for (const raw of operations) {
    const parsed = layoutOperationSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ operation: raw, reason: 'Nieznana operacja albo zly ksztalt danych' });
      continue;
    }

    const operation = parsed.data;
    const layer = byId.get(operation.layerId);

    if (!layer) {
      rejected.push({ operation, reason: 'Warstwa nie istnieje na tej stronie' });
      continue;
    }

    if (TECHNICAL_LAYER_TYPES.has(layer.type)) {
      rejected.push({ operation, reason: 'Warstwa techniczna szablonu' });
      continue;
    }

    if (operation.op === 'setGeometry') {
      if (layer.canMove === false) {
        rejected.push({ operation, reason: 'Szablon nie pozwala ruszac tej warstwy' });
        continue;
      }

      // Geometria przycinana do arkusza z zachowaniem marginesu bezpiecznego.
      // Kotwica warstwy jest w srodku, wiec granice licza sie od polowy
      // szerokosci - inaczej "wysrodkuj" spychaloby napis poza kadr.
      const width = operation.width ?? layer.widthMm;
      const height = operation.height ?? layer.heightMm;
      const halfWidth = width / 2;
      const halfHeight = height / 2;

      const next: LayoutOperation = { op: 'setGeometry', layerId: operation.layerId };

      if (operation.x !== undefined) {
        next.x = clamp(
          operation.x,
          page.safeAreaMm + halfWidth,
          page.widthMm - page.safeAreaMm - halfWidth
        );
      }
      if (operation.y !== undefined) {
        next.y = clamp(
          operation.y,
          page.safeAreaMm + halfHeight,
          page.heightMm - page.safeAreaMm - halfHeight
        );
      }
      if (operation.width !== undefined) {
        next.width = clamp(operation.width, 1, page.widthMm - 2 * page.safeAreaMm);
      }
      if (operation.height !== undefined) {
        next.height = clamp(operation.height, 1, page.heightMm - 2 * page.safeAreaMm);
      }

      // Operacja bez zadnej wartosci nic nie robi - nie ma po co jej oddawac.
      if (next.x === undefined && next.y === undefined && next.width === undefined && next.height === undefined) {
        rejected.push({ operation, reason: 'Operacja bez zadnej wartosci' });
        continue;
      }

      accepted.push(next);
      continue;
    }

    if (operation.op === 'setStyle') {
      if (layer.canStyle === false) {
        rejected.push({ operation, reason: 'Szablon nie pozwala zmieniac wygladu tej warstwy' });
        continue;
      }

      const next: LayoutOperation = { op: 'setStyle', layerId: operation.layerId };

      if (operation.fontSize !== undefined) {
        const base = layer.fontSize ?? operation.fontSize;
        next.fontSize = Math.round(
          clamp(
            operation.fontSize,
            Math.max(ABSOLUTE_MIN_FONT, Math.round(base * MIN_SIZE_RATIO)),
            Math.min(ABSOLUTE_MAX_FONT, Math.round(base * MAX_SIZE_RATIO))
          )
        );
      }
      if (operation.textAlign !== undefined) next.textAlign = operation.textAlign;
      if (operation.autoFit !== undefined) next.autoFit = operation.autoFit;

      if (next.fontSize === undefined && next.textAlign === undefined && next.autoFit === undefined) {
        rejected.push({ operation, reason: 'Operacja bez zadnej wartosci' });
        continue;
      }

      accepted.push(next);
      continue;
    }

    if (operation.op === 'setText') {
      // Tresc pola z listy gosci nalezy do goscia, nie do modelu - podmiana
      // przepisalaby czyjes nazwisko na wymyslone.
      if (layer.individual) {
        rejected.push({ operation, reason: 'Tresc pola z listy gosci pochodzi od klienta' });
        continue;
      }
      accepted.push(operation);
      continue;
    }

    if (operation.op === 'setVisibility') {
      // Ukrycie warstwy szablonu, ktorej klient sam nie moze ruszyc, byloby
      // zmiana projektu za jego plecami.
      if (layer.canMove === false && layer.canStyle === false) {
        rejected.push({ operation, reason: 'Warstwa ustalona przez szablon' });
        continue;
      }
      accepted.push(operation);
    }
  }

  return { operations: accepted, rejected };
}
