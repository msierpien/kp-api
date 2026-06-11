import type { IfirmaInvoiceSettingsSnapshot } from './ifirma-invoice.mapper';

export interface IfirmaCorrectionItemInput {
  productName: string;
  quantity: number;
  unitPriceTaxIncl?: number | string | null;
  totalRefundTaxIncl?: number | string | null;
  taxRate?: number | string | null;
}

export interface IfirmaCorrectionBuildInput {
  sourceInvoicePayload: Record<string, unknown> | null | undefined;
  settings: IfirmaInvoiceSettingsSnapshot;
  orderReference: string;
  correctionType: 'CANCELLATION' | 'RETURN';
  reason?: string | null;
  returnedItems: IfirmaCorrectionItemInput[];
  refundShipping?: boolean;
}

export interface IfirmaCorrectionPreview {
  payload: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export function buildIfirmaDomesticInvoiceCorrectionPayload(
  input: IfirmaCorrectionBuildInput,
  now: Date = new Date(),
): IfirmaCorrectionPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = input.sourceInvoicePayload && typeof input.sourceInvoicePayload === 'object'
    ? input.sourceInvoicePayload
    : null;
  const sourcePositions = Array.isArray(source?.Pozycje) ? source.Pozycje as Array<Record<string, unknown>> : [];

  if (!source) {
    errors.push('Brak payloadu faktury pierwotnej do zbudowania korekty iFirma.');
  }
  if (sourcePositions.length === 0) {
    errors.push('Faktura pierwotna nie ma pozycji zapisanych w KP Admin.');
  }

  const fullCancellation = input.correctionType === 'CANCELLATION';
  const positions = sourcePositions.map((position) => ({ ...position }));

  if (fullCancellation) {
    for (const position of positions) {
      position.Ilosc = 0;
    }
  } else {
    applyReturnedQuantities(positions, input.returnedItems, warnings);
    if (input.refundShipping) {
      const shipping = positions.find(isShippingPosition);
      if (shipping) {
        shipping.Ilosc = 0;
      } else {
        warnings.push('Zaznaczono zwrot wysyłki, ale faktura pierwotna nie ma pozycji wysyłki.');
      }
    }
  }

  const issueDate = formatDate(now);
  const reason = input.reason?.trim();
  const payload: Record<string, unknown> = {
    DataWystawienia: issueDate,
    TerminPlatnosci: issueDate,
    MiejsceWystawienia: input.settings.issuePlace?.trim() || undefined,
    NazwaSeriiNumeracji: input.settings.numberingSeriesName?.trim() || undefined,
    NazwaSzablonu: input.settings.templateName?.trim() || undefined,
    PowodKorekty: 'ZWR_SPRZ_TOW',
    PowodKorektyNaWydruku: true,
    Zaplacono: 0,
    SposobZaplaty: input.settings.defaultPaymentMethod || 'KOM',
    NumerKontaBankowego: input.settings.bankAccountNumber?.trim() || null,
    RodzajPodpisuOdbiorcy: input.settings.receiverSignatureType || 'BPO',
    PodpisOdbiorcy: input.settings.receiverSignature?.trim() || undefined,
    PodpisWystawcy: input.settings.issuerSignature?.trim() || undefined,
    SpelnionoWarunki: true,
    Uwagi: [
      fullCancellation ? `Anulowanie zamowienia ${input.orderReference}` : `Zwrot do zamowienia ${input.orderReference}`,
      reason || null,
    ].filter(Boolean).join('\n'),
    Pozycje: positions,
  };

  removeUndefined(payload);
  return { payload, errors, warnings };
}

function applyReturnedQuantities(
  positions: Array<Record<string, unknown>>,
  returnedItems: IfirmaCorrectionItemInput[],
  warnings: string[],
) {
  for (const item of returnedItems) {
    const quantity = positiveNumber(item.quantity) ?? 0;
    if (quantity <= 0) continue;

    const target = findMatchingPosition(positions, item);
    if (!target) {
      warnings.push(`Nie znaleziono pozycji faktury do korekty: ${item.productName}.`);
      continue;
    }

    const currentQuantity = positiveNumber(target.Ilosc) ?? 0;
    target.Ilosc = roundQuantity(Math.max(0, currentQuantity - quantity));
  }
}

function findMatchingPosition(positions: Array<Record<string, unknown>>, item: IfirmaCorrectionItemInput) {
  const normalizedName = normalizeText(item.productName);
  const grossUnit = numberOrNull(item.unitPriceTaxIncl);

  const candidates = positions.filter((position) => {
    if (isShippingPosition(position)) return false;
    const positionName = normalizeText(String(position.NazwaPelna ?? ''));
    return positionName === normalizedName || positionName.includes(normalizedName) || normalizedName.includes(positionName);
  });

  if (candidates.length === 0) return null;
  if (grossUnit === null) return candidates[0];

  return candidates.find((position) => {
    const price = numberOrNull(position.CenaJednostkowa);
    return price !== null && Math.abs(price - grossUnit) < 0.02;
  }) ?? candidates[0];
}

function isShippingPosition(position: Record<string, unknown>) {
  return normalizeText(String(position.NazwaPelna ?? '')).startsWith('wysylka');
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundQuantity(value: number) {
  return Number(value.toFixed(4));
}

function formatDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function removeUndefined(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}
