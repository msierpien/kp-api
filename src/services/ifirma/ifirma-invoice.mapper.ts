export interface IfirmaInvoiceSettingsSnapshot {
  defaultPaymentMethod: string;
  paymentTermDays: number;
  numberingSeriesName?: string | null;
  templateName?: string | null;
  issuePlace?: string | null;
  bankAccountNumber?: string | null;
  receiverSignatureType: string;
  receiverSignature?: string | null;
  issuerSignature?: string | null;
  visibleBdo: boolean;
}

export interface IfirmaInvoicePreview {
  payload: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

type OrderSnapshot = {
  id: string;
  orderReference: string;
  customerEmail: string;
  customerName?: string | null;
  currency: string;
  totalPaid: unknown;
  totalShippingTaxIncl?: unknown;
  totalShippingTaxExcl?: unknown;
  totalDiscountsTaxIncl?: unknown;
  createdAtShop: Date | string;
  payloadJson: any;
  billingAddressJson?: any;
  deliveryAddressJson?: any;
};

export function buildIfirmaDomesticInvoicePayload(
  order: OrderSnapshot,
  settings: IfirmaInvoiceSettingsSnapshot,
  now: Date = new Date(),
): IfirmaInvoicePreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const snapshot = normalizeSnapshot(order.payloadJson);
  const invoiceAddress = order.billingAddressJson ?? snapshot.invoiceAddress ?? null;
  const invoiceCountry = invoiceAddress?.country ?? snapshot.invoiceCountry ?? null;
  const currency = String(order.currency || snapshot.order?.currency || 'PLN').toUpperCase();
  const countryCode = normalizeCountryCode(invoiceAddress, invoiceCountry);

  if (currency !== 'PLN') {
    errors.push(`iFirma MVP obsługuje tylko PLN, a zamówienie ma walutę ${currency}.`);
  }
  if (countryCode !== 'PL') {
    errors.push(`iFirma MVP obsługuje tylko faktury krajowe PL, a adres faktury ma kraj ${countryCode || 'brak'}.`);
  }

  const issueDate = formatDate(now);
  const saleDate = formatDate(order.createdAtShop);
  const paymentTerm = settings.paymentTermDays > 0
    ? formatDate(addDays(now, settings.paymentTermDays))
    : null;

  const positions = buildPositions(snapshot, order, warnings);
  if (positions.length === 0) {
    errors.push('Zamówienie nie ma pozycji możliwych do przeniesienia na fakturę.');
  }

  const contractor = buildContractor(order, invoiceAddress, invoiceCountry, errors);
  const totalPaid = roundMoney(numberOrZero(order.totalPaid));
  const discount = numberOrZero(order.totalDiscountsTaxIncl ?? snapshot.order?.total_discounts_tax_incl);
  const notes = [
    `Zamówienie ${order.orderReference}`,
    discount > 0 ? `Rabat z zamówienia: ${roundMoney(discount).toFixed(2)} PLN.` : null,
  ].filter(Boolean).join('\n');

  const payload: Record<string, unknown> = {
    Zaplacono: totalPaid,
    ZaplaconoNaDokumencie: totalPaid,
    LiczOd: 'BRT',
    NumerKontaBankowego: settings.bankAccountNumber?.trim() || null,
    DataWystawienia: issueDate,
    MiejsceWystawienia: settings.issuePlace?.trim() || undefined,
    DataSprzedazy: saleDate,
    FormatDatySprzedazy: 'DZN',
    TerminPlatnosci: paymentTerm,
    SposobZaplaty: settings.defaultPaymentMethod || 'PRZ',
    NazwaSeriiNumeracji: settings.numberingSeriesName?.trim() || undefined,
    NazwaSzablonu: settings.templateName?.trim() || undefined,
    RodzajPodpisuOdbiorcy: settings.receiverSignatureType || 'BPO',
    PodpisOdbiorcy: settings.receiverSignature?.trim() || undefined,
    PodpisWystawcy: settings.issuerSignature?.trim() || undefined,
    Uwagi: notes,
    WidocznyNumerBdo: settings.visibleBdo,
    Numer: null,
    Pozycje: positions,
    Kontrahent: contractor,
  };

  removeUndefined(payload);
  return { payload, errors, warnings };
}

function normalizeSnapshot(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function buildPositions(snapshot: any, order: OrderSnapshot, warnings: string[]) {
  const rows = Array.isArray(snapshot.items) ? snapshot.items : [];
  const positions = rows
    .map((row: any) => buildProductPosition(row))
    .filter((position: any): position is Record<string, unknown> => Boolean(position));

  const shippingGross = numberOrZero(order.totalShippingTaxIncl ?? snapshot.order?.total_shipping_tax_incl);
  if (shippingGross > 0) {
    const shippingNet = numberOrNull(order.totalShippingTaxExcl ?? snapshot.order?.total_shipping_tax_excl);
    const carrierName = snapshot.carrier?.name ? ` - ${snapshot.carrier.name}` : '';
    positions.push({
      StawkaVat: normalizeVatRate(deriveVatRate(shippingGross, shippingNet)),
      Ilosc: 1,
      CenaJednostkowa: roundMoney(shippingGross),
      NazwaPelna: truncate(`Wysyłka${carrierName}`, 300),
      Jednostka: 'szt',
      PKWiU: '',
      TypStawkiVat: 'PRC',
    });
  }

  if (rows.length === 0) {
    warnings.push('Snapshot PrestaShop nie zawiera `items`; faktura nie może zostać wystawiona bez pozycji.');
  }

  return positions;
}

function buildProductPosition(row: any) {
  const quantity = Number(row.quantity ?? row.product_quantity ?? 0);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const grossTotal = numberOrNull(row.total_price_tax_incl);
  const grossUnit = numberOrNull(row.unit_price_tax_incl)
    ?? (grossTotal === null ? null : grossTotal / quantity);
  const fallbackNetUnit = numberOrNull(row.unit_price_tax_excl ?? row.product_price);
  const price = grossUnit ?? fallbackNetUnit;
  if (price === null || price <= 0) return null;

  const rawRate = numberOrNull(row.tax_rate);
  const vatRate = rawRate === null ? deriveVatRate(price, fallbackNetUnit) : rawRate / 100;

  return {
    StawkaVat: normalizeVatRate(vatRate),
    Ilosc: quantity,
    CenaJednostkowa: roundMoney(price),
    NazwaPelna: truncate(String(row.product_name || row.name || 'Produkt'), 300),
    Jednostka: 'szt',
    PKWiU: '',
    TypStawkiVat: 'PRC',
  };
}

function buildContractor(order: OrderSnapshot, address: any, country: any, errors: string[]) {
  if (!address) {
    errors.push('Brak adresu faktury w snapshotcie zamówienia.');
  }

  const company = clean(address?.company);
  const firstName = clean(address?.firstname);
  const lastName = clean(address?.lastname);
  const name = company || clean(`${firstName} ${lastName}`) || clean(order.customerName) || 'Klient';
  const postcode = clean(address?.postcode);
  const city = clean(address?.city);

  if (!postcode) errors.push('Brak kodu pocztowego nabywcy.');
  if (!city) errors.push('Brak miejscowości nabywcy.');

  return {
    Nazwa: truncate(name, 150),
    Identyfikator: null,
    PrefiksUE: null,
    NIP: normalizeNip(address?.vat_number ?? address?.dni),
    Ulica: truncate(clean([address?.address1, address?.address2].filter(Boolean).join(' ')), 65),
    KodPocztowy: truncate(postcode || '', 16),
    Kraj: truncate(normalizeCountryName(country), 70),
    KodKraju: normalizeCountryCode(address, country) || 'PL',
    Miejscowosc: truncate(city || '', 65),
    Email: truncate(order.customerEmail || '', 65),
    Telefon: truncate(clean(address?.phone_mobile || address?.phone), 32),
    OsobaFizyczna: !company && !normalizeNip(address?.vat_number ?? address?.dni),
  };
}

function normalizeCountryCode(address: any, country: any) {
  const code = clean(country?.iso_code ?? address?.country?.iso_code ?? address?.KodKraju).toUpperCase();
  return code === 'EL' ? 'EL' : code || 'PL';
}

function normalizeCountryName(country: any) {
  const value = country?.name;
  if (typeof value === 'string') return value.trim() || 'Polska';
  if (value && typeof value === 'object') {
    if (typeof value.value === 'string') return value.value.trim() || 'Polska';
    if (Array.isArray(value.language)) {
      const first = value.language.find((item: any) => typeof item?.value === 'string');
      if (first?.value) return first.value.trim();
    }
  }
  return 'Polska';
}

function deriveVatRate(gross: number, net: number | null) {
  if (!net || net <= 0) return 0.23;
  return gross / net - 1;
}

function normalizeVatRate(value: number) {
  const allowed = [0, 0.05, 0.08, 0.23];
  const normalized = Number.isFinite(value) ? value : 0.23;
  return allowed.reduce((closest, candidate) =>
    Math.abs(candidate - normalized) < Math.abs(closest - normalized) ? candidate : closest
  , allowed[0]);
}

function numberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max);
}

function normalizeNip(value: unknown) {
  const text = clean(value).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return text || null;
}

function formatDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(new Date());
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function removeUndefined(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}
