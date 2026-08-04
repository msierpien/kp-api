import { Prisma } from '@prisma/client';

export type WholesaleOrderCsvTemplate = 'GODAN' | 'PARTYDECO' | 'GENERIC';

export interface WholesaleOrderCsvSourceRow {
  code: string;
  quantity: number;
  unit: string;
  providerPreset?: WholesaleOrderCsvTemplate | null;
}

export interface WholesaleOrderCsvBuildResult {
  content: string;
  rows: number;
  separator: ',' | ';';
  template: WholesaleOrderCsvTemplate;
  header: string[];
}

function configRecord(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function providerPresetFromConfig(configJson: Prisma.JsonValue | null | undefined): WholesaleOrderCsvTemplate | null {
  const config = configRecord(configJson);
  const preset = typeof config.preset === 'string' ? config.preset.toUpperCase() : '';
  if (preset === 'GODAN' || preset === 'PARTYDECO') return preset;
  return null;
}

export function detectWholesaleOrderCsvTemplate(
  providerName: string | null,
  presets: Array<WholesaleOrderCsvTemplate | null> = [],
): WholesaleOrderCsvTemplate {
  if (presets.includes('PARTYDECO')) return 'PARTYDECO';
  if (presets.includes('GODAN')) return 'GODAN';

  const normalizedName = (providerName ?? '').toLowerCase();
  if (normalizedName.includes('partydeco')) return 'PARTYDECO';
  if (normalizedName.includes('godan')) return 'GODAN';

  return 'GENERIC';
}

export function wholesaleOrderCsvSeparator(template: WholesaleOrderCsvTemplate): ',' | ';' {
  return template === 'GODAN' ? ',' : ';';
}

export function wholesaleOrderCsvHeader(template: WholesaleOrderCsvTemplate) {
  if (template === 'GODAN') return ['Kod produktu/Ean', 'Ilość', 'Jednostka miary'];
  return ['code', 'count'];
}

export function normalizeCsvUnit(value: string | null | undefined, template: WholesaleOrderCsvTemplate) {
  const unit = value?.trim() || 'szt';
  if (template === 'GODAN' && /^szt\.?$/i.test(unit)) return 'szt.';
  return unit;
}

export function formatCsvQuantity(value: number) {
  const rounded = Math.round(value * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace('.', ',');
}

export function csvEscape(value: string | number | null | undefined, separator: ',' | ';') {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text.includes(separator) && !text.includes('"') && !text.includes('\n') && !text.includes('\r')) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Buduje CSV zamowienia w formacie wymaganym przez dostawce.
 * PartyDeco importuje naglowki `code;count`, GoDan `Kod produktu/Ean,Ilosc,Jednostka miary`.
 * Plik nie ma BOM - dostawcy parsuja naglowek doslownie.
 */
export function buildWholesaleOrderCsvContent(
  template: WholesaleOrderCsvTemplate,
  sourceRows: WholesaleOrderCsvSourceRow[],
): WholesaleOrderCsvBuildResult {
  const separator = wholesaleOrderCsvSeparator(template);
  const aggregated = new Map<string, WholesaleOrderCsvSourceRow>();

  for (const row of sourceRows) {
    const unit = normalizeCsvUnit(row.unit, template);
    const key = template === 'GODAN' ? `${row.code}|${unit}` : row.code;
    const existing = aggregated.get(key);
    if (existing) {
      existing.quantity += row.quantity;
    } else {
      aggregated.set(key, { ...row, unit });
    }
  }

  const exportRows = Array.from(aggregated.values())
    .filter((row) => row.quantity > 0)
    .sort((a, b) => a.code.localeCompare(b.code, 'pl'));
  if (exportRows.length === 0) throw new Error('Brak pozycji z dodatnią ilością do eksportu CSV');

  const header = wholesaleOrderCsvHeader(template);
  const csvRows = template === 'GODAN'
    ? exportRows.map((row) => [row.code, formatCsvQuantity(row.quantity), row.unit])
    : exportRows.map((row) => [row.code, formatCsvQuantity(row.quantity)]);
  // CRLF zgodnie z RFC 4180 i wzorcami plikow importu dostawcow.
  const content = `${[header, ...csvRows].map((row) => row.map((cell) => csvEscape(cell, separator)).join(separator)).join('\r\n')}\r\n`;

  return {
    content,
    rows: exportRows.length,
    separator,
    template,
    header,
  };
}
