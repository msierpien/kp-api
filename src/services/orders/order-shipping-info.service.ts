export interface OrderShippingInfo {
  carrierId: string | null;
  carrierName: string | null;
  totalTaxIncl: number | null;
  totalTaxExcl: number | null;
  taxRate: number | null;
  currency: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = parseString(source[key]);
    if (value) return value;
  }

  return null;
}

function readMoney(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = parseMoney(source[key]);
    if (value !== null) return value;
  }

  return null;
}

function formatMoney(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(2)}%`;
}

function buildLabel(info: Omit<OrderShippingInfo, 'label'>): string {
  const amount = info.totalTaxIncl !== null
    ? `${formatMoney(info.totalTaxIncl, info.currency)} brutto`
    : info.totalTaxExcl !== null
      ? `${formatMoney(info.totalTaxExcl, info.currency)} netto`
      : 'Kwota transportu nieznana';

  const details: string[] = [];
  if (info.totalTaxIncl !== null && info.totalTaxExcl !== null) {
    details.push(`netto ${formatMoney(info.totalTaxExcl, info.currency)}`);
  }
  if (info.taxRate !== null) {
    details.push(`VAT ${formatPercent(info.taxRate)}`);
  }

  return details.length > 0 ? `${amount} (${details.join(', ')})` : amount;
}

export function extractOrderShippingInfo(payloadJson: unknown, currency = 'PLN'): OrderShippingInfo | null {
  if (!isRecord(payloadJson)) return null;

  const order = isRecord(payloadJson.order) ? payloadJson.order : payloadJson;
  const carrier = isRecord(payloadJson.carrier) ? payloadJson.carrier : null;

  const totalTaxIncl = readMoney(order, ['total_shipping_tax_incl', 'total_shipping']);
  const totalTaxExcl = readMoney(order, ['total_shipping_tax_excl']);
  const taxRate = readMoney(order, ['carrier_tax_rate']);
  const carrierId = readString(order, ['id_carrier', 'carrier_id']);
  const carrierName = readString(order, ['carrier_name', 'shipping_method', 'shipping_name'])
    ?? (carrier ? readString(carrier, ['name', 'carrier_name']) : null);

  if (
    totalTaxIncl === null
    && totalTaxExcl === null
    && taxRate === null
    && carrierId === null
    && carrierName === null
  ) {
    return null;
  }

  const info = {
    carrierId,
    carrierName,
    totalTaxIncl,
    totalTaxExcl,
    taxRate,
    currency,
  };

  return {
    ...info,
    label: buildLabel(info),
  };
}

export function buildShippingInfoDescription(info: OrderShippingInfo | null): string | null {
  if (!info) return null;

  const carrierLabel = info.carrierName
    ?? (info.carrierId ? `kurier #${info.carrierId}` : null);

  return carrierLabel
    ? `Transport opłacony: ${info.label}, ${carrierLabel}`
    : `Transport opłacony: ${info.label}`;
}
