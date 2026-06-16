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
  splitBundleItems?: boolean;
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
  items?: Array<{
    sku?: string | null;
    productNameSnapshot?: string | null;
    quantity?: unknown;
    unitPriceTaxIncl?: unknown;
    unitPriceTaxExcl?: unknown;
    totalPriceTaxIncl?: unknown;
    totalPriceTaxExcl?: unknown;
    taxRate?: unknown;
    taxName?: string | null;
    sourceType?: string | null;
    bundleGroupId?: string | null;
    bundleName?: string | null;
    bundleExternalItemId?: string | null;
    bundleExternalProductId?: string | null;
    payloadJson?: any;
  }>;
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

  // Data sprzedaży i wystawienia są ustawiane na ten sam dzień (dzień wystawienia faktury).
  const issueDate = formatDate(now);
  const saleDate = issueDate;
  const paymentTerm = settings.paymentTermDays > 0
    ? formatDate(addDays(now, settings.paymentTermDays))
    : null;

  const positions = buildPositions(snapshot, order, settings, warnings);
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

  // Faktura oznaczona jako opłacona w całości; iFirma datuje wpłatę na dzień wystawienia.
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

function buildPositions(
  snapshot: any,
  order: OrderSnapshot,
  settings: IfirmaInvoiceSettingsSnapshot,
  warnings: string[],
) {
  const snapshotRows = Array.isArray(snapshot.items) ? snapshot.items : [];
  const fallbackRows = snapshotRows.length > 0 ? [] : buildFallbackRowsFromOrderItems(order);
  const rows = settings.splitBundleItems
    ? expandBundleRows(snapshotRows.length > 0 ? snapshotRows : fallbackRows, snapshot, order, warnings)
    : snapshotRows.length > 0 ? snapshotRows : fallbackRows;
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

  reconcileSmallRoundingDelta(positions, order, warnings);

  if (snapshotRows.length === 0 && fallbackRows.length > 0) {
    warnings.push('Snapshot PrestaShop nie zawiera `items`; użyto pozycji zapisanych lokalnie w zamówieniu.');
  }

  if (rows.length === 0) {
    warnings.push('Snapshot PrestaShop nie zawiera `items`; faktura nie może zostać wystawiona bez pozycji.');
  }

  return positions;
}

function reconcileSmallRoundingDelta(positions: Array<Record<string, unknown>>, order: OrderSnapshot, warnings: string[]) {
  const expectedTotal = roundMoney(numberOrZero(order.totalPaid));
  if (expectedTotal <= 0 || positions.length === 0) return;

  const actualTotal = positionsGrossTotal(positions);
  const delta = roundMoney(expectedTotal - actualTotal);
  if (Math.abs(delta) < 0.005 || Math.abs(delta) > 0.05) return;

  const index = findRoundingAdjustmentPosition(positions, delta);
  if (index < 0) return;

  const position = positions[index];
  const quantity = positiveNumber(position.Ilosc) ?? 1;
  const price = numberOrNull(position.CenaJednostkowa);
  if (price === null) return;

  const nextPrice = roundMoney(price + delta / quantity);
  if (nextPrice <= 0) return;

  const nextPositions = positions.map((item, itemIndex) =>
    itemIndex === index ? { ...item, CenaJednostkowa: nextPrice } : item
  );
  if (positionsGrossTotal(nextPositions) !== expectedTotal) return;

  position.CenaJednostkowa = nextPrice;
  warnings.push(`Skorygowano końcówkę zaokrągleń pozycji faktury o ${delta.toFixed(2)} PLN.`);
}

function positionsGrossTotal(positions: Array<Record<string, unknown>>) {
  return roundMoney(positions.reduce((sum, position) => {
    const quantity = positiveNumber(position.Ilosc) ?? 0;
    const price = numberOrNull(position.CenaJednostkowa) ?? 0;
    return sum + roundMoney(quantity * price);
  }, 0));
}

function findRoundingAdjustmentPosition(positions: Array<Record<string, unknown>>, delta: number) {
  const preferred = [
    (position: Record<string, unknown>) => !isShippingPosition(position) && isSingleQuantityPosition(position),
    (position: Record<string, unknown>) => isSingleQuantityPosition(position),
    (position: Record<string, unknown>) => !isShippingPosition(position),
    () => true,
  ];

  for (const predicate of preferred) {
    for (let index = positions.length - 1; index >= 0; index--) {
      const position = positions[index];
      const price = numberOrNull(position.CenaJednostkowa);
      const quantity = positiveNumber(position.Ilosc);
      if (price === null || !quantity || !predicate(position)) continue;
      if (price + delta / quantity > 0) return index;
    }
  }

  return -1;
}

function isShippingPosition(position: Record<string, unknown>) {
  return String(position.NazwaPelna ?? '').trim().toLowerCase().startsWith('wysyłka');
}

function isSingleQuantityPosition(position: Record<string, unknown>) {
  return (positiveNumber(position.Ilosc) ?? 0) === 1;
}

function expandBundleRows(rows: any[], snapshot: any, order: OrderSnapshot, warnings: string[]) {
  const bundlesByOrderDetailId = new Map<string, any>();
  for (const selection of Array.isArray(snapshot.bundleSelections) ? snapshot.bundleSelections : []) {
    const key = selection?.id_order_detail ?? selection?.idOrderDetail;
    if (key !== undefined && key !== null) {
      bundlesByOrderDetailId.set(String(key), selection);
    }
  }

  const localBundleComponents = new Map<string, NonNullable<OrderSnapshot['items']>>();
  for (const item of Array.isArray(order.items) ? order.items : []) {
    if (item.sourceType !== 'BUNDLE_COMPONENT' || !item.bundleExternalItemId) continue;
    const current = localBundleComponents.get(item.bundleExternalItemId) ?? [];
    current.push(item);
    localBundleComponents.set(item.bundleExternalItemId, current);
  }

  let expandedBundles = 0;
  const expandedRows = rows.flatMap((row) => {
    const rowId = row?.id;
    const bundle = rowId !== undefined && rowId !== null ? bundlesByOrderDetailId.get(String(rowId)) : null;
    if (bundle?.components?.length) {
      expandedBundles++;
      return buildBundleComponentRowsFromSnapshot(row, bundle);
    }

    const localComponents = rowId !== undefined && rowId !== null ? localBundleComponents.get(String(rowId)) : null;
    if (localComponents?.length) {
      expandedBundles++;
      return buildBundleComponentRowsFromOrderItems(row, localComponents);
    }

    return [row];
  });

  if (expandedBundles > 0) {
    warnings.push(`Rozbito ${expandedBundles} ${expandedBundles === 1 ? 'zestaw' : 'zestawy'} na pozycje składników faktury.`);
  }

  return expandedRows;
}

function buildBundleComponentRowsFromSnapshot(parentRow: any, bundle: any) {
  const parentPrice = parentPriceSnapshot(parentRow);
  const components: any[] = Array.isArray(bundle.components) ? bundle.components : [];
  const parentQuantity = positiveNumber(parentRow.quantity ?? parentRow.product_quantity) ?? 1;
  const totalComponentQuantity = components.reduce((sum: number, component: any) => {
    const componentQuantity = positiveNumber(component?.quantity ?? component?.qty) ?? 1;
    return sum + componentQuantity * parentQuantity;
  }, 0);

  return components.map((component: any) => {
    const componentQuantity = (positiveNumber(component?.quantity ?? component?.qty) ?? 1) * parentQuantity;
    const grossUnit = firstNumber(
      component?.unit_price_tax_incl,
      component?.price_tax_incl,
      component?.price,
      parentPrice.grossTotal !== null && totalComponentQuantity > 0 ? parentPrice.grossTotal / totalComponentQuantity : null,
    );
    const netUnit = firstNumber(
      component?.unit_price_tax_excl,
      component?.price_tax_excl,
      component?.net_price,
      parentPrice.netTotal !== null && totalComponentQuantity > 0 ? parentPrice.netTotal / totalComponentQuantity : null,
    );

    return {
      product_reference: component?.reference ?? component?.sku ?? '',
      product_name: component?.name ?? component?.product_name ?? `Produkt #${component?.id_product ?? component?.idProduct ?? ''}`.trim(),
      product_quantity: componentQuantity,
      quantity: componentQuantity,
      unit_price_tax_incl: grossUnit,
      unit_price_tax_excl: netUnit,
      total_price_tax_incl: grossUnit === null ? null : grossUnit * componentQuantity,
      total_price_tax_excl: netUnit === null ? null : netUnit * componentQuantity,
      tax_rate: component?.tax_rate ?? parentRow.tax_rate,
      tax_name: component?.tax_name ?? parentRow.tax_name,
    };
  });
}

function buildBundleComponentRowsFromOrderItems(parentRow: any, components: NonNullable<OrderSnapshot['items']>) {
  const parentPrice = parentPriceSnapshot(parentRow);
  const totalComponentQuantity = components.reduce((sum, component) =>
    sum + (positiveNumber(component.quantity) ?? 1)
  , 0);

  return components.map((component) => {
    const componentQuantity = positiveNumber(component.quantity) ?? 1;
    const grossUnit = firstNumber(
      component.unitPriceTaxIncl,
      parentPrice.grossTotal !== null && totalComponentQuantity > 0 ? parentPrice.grossTotal / totalComponentQuantity : null,
    );
    const netUnit = firstNumber(
      component.unitPriceTaxExcl,
      parentPrice.netTotal !== null && totalComponentQuantity > 0 ? parentPrice.netTotal / totalComponentQuantity : null,
    );

    return {
      product_reference: component.sku ?? '',
      product_name: component.productNameSnapshot ?? component.bundleName ?? 'Produkt',
      product_quantity: componentQuantity,
      quantity: componentQuantity,
      unit_price_tax_incl: grossUnit,
      unit_price_tax_excl: netUnit,
      total_price_tax_incl: grossUnit === null ? null : grossUnit * componentQuantity,
      total_price_tax_excl: netUnit === null ? null : netUnit * componentQuantity,
      tax_rate: component.taxRate ?? parentRow.tax_rate,
      tax_name: component.taxName ?? parentRow.tax_name,
    };
  });
}

function parentPriceSnapshot(row: any) {
  const quantity = positiveNumber(row.quantity ?? row.product_quantity) ?? 1;
  const grossUnit = numberOrNull(row.unit_price_tax_incl);
  const netUnit = numberOrNull(row.unit_price_tax_excl ?? row.product_price);
  return {
    grossTotal: numberOrNull(row.total_price_tax_incl) ?? (grossUnit === null ? null : grossUnit * quantity),
    netTotal: numberOrNull(row.total_price_tax_excl) ?? (netUnit === null ? null : netUnit * quantity),
  };
}

function buildFallbackRowsFromOrderItems(order: OrderSnapshot) {
  if (!Array.isArray(order.items)) return [];
  return order.items.map((item) => {
    const payload = item.payloadJson && typeof item.payloadJson === 'object' && !Array.isArray(item.payloadJson)
      ? item.payloadJson
      : {};
    return {
      ...payload,
      product_reference: item.sku,
      product_name: item.productNameSnapshot,
      product_quantity: item.quantity,
      quantity: item.quantity,
      unit_price_tax_incl: item.unitPriceTaxIncl,
      unit_price_tax_excl: item.unitPriceTaxExcl,
      total_price_tax_incl: item.totalPriceTaxIncl,
      total_price_tax_excl: item.totalPriceTaxExcl,
      tax_rate: item.taxRate,
      tax_name: item.taxName,
      source_type: item.sourceType,
      bundle_group_id: item.bundleGroupId,
      bundle_name: item.bundleName,
      bundle_external_item_id: item.bundleExternalItemId,
      bundle_external_product_id: item.bundleExternalProductId,
    };
  });
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

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function positiveNumber(value: unknown) {
  const number = numberOrNull(value);
  return number !== null && number > 0 ? number : null;
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
