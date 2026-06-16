import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('iFirma integration', () => {
  it('signs empty and non-empty payloads with the faktura key', async () => {
    const { IFIRMA_DOMESTIC_INVOICE_URL, IFIRMA_KEY_NAME_INVOICE, createIfirmaHmac } = await import('../src/services/ifirma/ifirma-client');
    const input = {
      url: IFIRMA_DOMESTIC_INVOICE_URL,
      user: 'user@example.com',
      keyName: IFIRMA_KEY_NAME_INVOICE,
      key: '00112233445566778899aabbccddeeff00112233',
    };

    assert.equal(
      createIfirmaHmac({ ...input, requestContent: '' }),
      'dc910445d0b3b8996509d73ff2cfc240ecb533ba',
    );
    assert.equal(
      createIfirmaHmac({ ...input, requestContent: '{"x":1}' }),
      '30e1a98ce5ed14f0973b6a3e607e37eeccb225b4',
    );
  });

  it('maps a PLN Polish PrestaShop snapshot to a domestic invoice payload', async () => {
    const { buildIfirmaDomesticInvoicePayload } = await import('../src/services/ifirma/ifirma-invoice.mapper');
    const order = {
      id: 'order-1',
      orderReference: 'KP-100',
      customerEmail: 'jan@example.com',
      customerName: 'Jan Kowalski',
      currency: 'PLN',
      totalPaid: '147.60',
      totalShippingTaxIncl: '12.30',
      totalShippingTaxExcl: '10.00',
      totalDiscountsTaxIncl: '5.00',
      createdAtShop: new Date('2026-06-01T10:00:00Z'),
      billingAddressJson: {
        company: 'Kupujący Sp. z o.o.',
        vat_number: 'PL 123-456-78-90',
        firstname: 'Jan',
        lastname: 'Kowalski',
        address1: 'Prosta 1',
        postcode: '00-001',
        city: 'Warszawa',
        phone_mobile: '+48123123123',
        country: { iso_code: 'PL', name: 'Polska' },
      },
      payloadJson: {
        carrier: { name: 'Kurier' },
        items: [
          {
            product_name: 'Kubek personalizowany',
            product_quantity: 2,
            unit_price_tax_incl: '61.50',
            unit_price_tax_excl: '50.00',
            tax_rate: '23.000',
          },
        ],
      },
    };

    const result = buildIfirmaDomesticInvoicePayload(order, {
      defaultPaymentMethod: 'PRZ',
      paymentTermDays: 7,
      receiverSignatureType: 'BPO',
      visibleBdo: false,
    }, new Date('2026-06-07T12:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.equal(result.payload.DataWystawienia, '2026-06-07');
    assert.equal(result.payload.DataSprzedazy, '2026-06-07');
    assert.equal(result.payload.TerminPlatnosci, '2026-06-14');
    assert.equal(result.payload.Zaplacono, 147.6);
    assert.equal(result.payload.ZaplaconoNaDokumencie, 147.6);
    assert.equal((result.payload.Kontrahent as any).Nazwa, 'Kupujący Sp. z o.o.');
    assert.equal((result.payload.Kontrahent as any).NIP, 'PL1234567890');
    assert.equal((result.payload.Pozycje as any[]).length, 2);
    assert.equal((result.payload.Pozycje as any[])[0].CenaJednostkowa, 61.5);
    assert.equal((result.payload.Pozycje as any[])[0].StawkaVat, 0.23);
    assert.match(String(result.payload.Uwagi), /Rabat z zamówienia: 5.00 PLN/);
  });

  it('blocks non-PLN or non-Polish invoices in MVP validation', async () => {
    const { buildIfirmaDomesticInvoicePayload } = await import('../src/services/ifirma/ifirma-invoice.mapper');
    const result = buildIfirmaDomesticInvoicePayload({
      id: 'order-2',
      orderReference: 'KP-101',
      customerEmail: 'ada@example.com',
      currency: 'EUR',
      totalPaid: 10,
      createdAtShop: new Date('2026-06-01T10:00:00Z'),
      billingAddressJson: {
        firstname: 'Ada',
        lastname: 'Nowak',
        address1: 'Long Street 1',
        postcode: '1000',
        city: 'Berlin',
        country: { iso_code: 'DE', name: 'Niemcy' },
      },
      payloadJson: { items: [{ product_name: 'Produkt', product_quantity: 1, unit_price_tax_incl: 10, tax_rate: 23 }] },
    }, {
      defaultPaymentMethod: 'PRZ',
      paymentTermDays: 0,
      receiverSignatureType: 'BPO',
      visibleBdo: false,
    });

    assert.match(result.errors.join('\n'), /tylko PLN/);
    assert.match(result.errors.join('\n'), /faktury krajowe PL/);
  });

  it('falls back to locally saved order items when snapshot items are missing', async () => {
    const { buildIfirmaDomesticInvoicePayload } = await import('../src/services/ifirma/ifirma-invoice.mapper');
    const result = buildIfirmaDomesticInvoicePayload({
      id: 'order-3',
      orderReference: 'KP-102',
      customerEmail: 'jan@example.com',
      customerName: 'Jan Kowalski',
      currency: 'PLN',
      totalPaid: 49.99,
      createdAtShop: new Date('2026-06-01T10:00:00Z'),
      billingAddressJson: {
        firstname: 'Jan',
        lastname: 'Kowalski',
        address1: 'Prosta 1',
        postcode: '00-001',
        city: 'Warszawa',
        country: { iso_code: 'PL', name: 'Polska' },
      },
      payloadJson: { order: { total_shipping_tax_incl: 0 } },
      items: [
        {
          sku: 'SKU-1',
          productNameSnapshot: 'Balon testowy',
          quantity: 1,
          unitPriceTaxIncl: '49.99',
          unitPriceTaxExcl: '40.64',
          taxRate: '23.0000',
        },
      ],
    }, {
      defaultPaymentMethod: 'PRZ',
      paymentTermDays: 0,
      receiverSignatureType: 'BPO',
      visibleBdo: false,
    }, new Date('2026-06-07T12:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.equal((result.payload.Pozycje as any[]).length, 1);
    assert.equal((result.payload.Pozycje as any[])[0].NazwaPelna, 'Balon testowy');
    assert.equal((result.payload.Pozycje as any[])[0].CenaJednostkowa, 49.99);
    assert.match(result.warnings.join('\n'), /użyto pozycji zapisanych lokalnie/);
  });

  it('can split PrestaShop bundle rows into component invoice positions', async () => {
    const { buildIfirmaDomesticInvoicePayload } = await import('../src/services/ifirma/ifirma-invoice.mapper');
    const result = buildIfirmaDomesticInvoicePayload({
      id: 'order-4',
      orderReference: 'KP-103',
      customerEmail: 'jan@example.com',
      customerName: 'Jan Kowalski',
      currency: 'PLN',
      totalPaid: 90,
      createdAtShop: new Date('2026-06-01T10:00:00Z'),
      billingAddressJson: {
        firstname: 'Jan',
        lastname: 'Kowalski',
        address1: 'Prosta 1',
        postcode: '00-001',
        city: 'Warszawa',
        country: { iso_code: 'PL', name: 'Polska' },
      },
      payloadJson: {
        order: { total_shipping_tax_incl: 0 },
        items: [
          {
            id: 10,
            product_name: 'Zestaw urodzinowy',
            product_quantity: 1,
            unit_price_tax_incl: '90.00',
            unit_price_tax_excl: '73.17',
            total_price_tax_incl: '90.00',
            total_price_tax_excl: '73.17',
            tax_rate: '23.000',
          },
        ],
        bundleSelections: [
          {
            id_order_detail: 10,
            bundle_name: 'Zestaw urodzinowy',
            components: [
              { id_product: 101, reference: 'BALON', name: 'Balon', quantity: 1 },
              { id_product: 102, reference: 'TALERZYK', name: 'Talerzyk', quantity: 2 },
            ],
          },
        ],
      },
    }, {
      defaultPaymentMethod: 'PRZ',
      paymentTermDays: 0,
      receiverSignatureType: 'BPO',
      visibleBdo: false,
      splitBundleItems: true,
    }, new Date('2026-06-07T12:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join('\n'), /Rozbito 1 zestaw/);
    assert.equal((result.payload.Pozycje as any[]).length, 2);
    assert.equal((result.payload.Pozycje as any[])[0].NazwaPelna, 'Balon');
    assert.equal((result.payload.Pozycje as any[])[0].Ilosc, 1);
    assert.equal((result.payload.Pozycje as any[])[0].CenaJednostkowa, 30);
    assert.equal((result.payload.Pozycje as any[])[1].NazwaPelna, 'Talerzyk');
    assert.equal((result.payload.Pozycje as any[])[1].Ilosc, 2);
    assert.equal((result.payload.Pozycje as any[])[1].CenaJednostkowa, 30);
  });

  it('corrects small rounding leftovers after splitting bundle items', async () => {
    const { buildIfirmaDomesticInvoicePayload } = await import('../src/services/ifirma/ifirma-invoice.mapper');
    const result = buildIfirmaDomesticInvoicePayload({
      id: 'order-5',
      orderReference: 'THSIPQKVH',
      customerEmail: 'jan@example.com',
      customerName: 'Jan Kowalski',
      currency: 'PLN',
      totalPaid: 95.43,
      totalShippingTaxIncl: 20,
      totalShippingTaxExcl: 16.26,
      createdAtShop: new Date('2026-06-07T10:00:00Z'),
      billingAddressJson: {
        firstname: 'Jan',
        lastname: 'Kowalski',
        address1: 'Prosta 1',
        postcode: '00-001',
        city: 'Warszawa',
        country: { iso_code: 'PL', name: 'Polska' },
      },
      payloadJson: {
        order: { total_shipping_tax_incl: 20, total_shipping_tax_excl: 16.26 },
        carrier: { name: 'Kurier InPost' },
        items: [
          {
            id: 1855,
            product_name: 'Balon foliowy 19 cali gwiazda tęczowy z nadrukiem 18',
            product_quantity: 1,
            unit_price_tax_incl: '3.078936',
            unit_price_tax_excl: '2.503200',
            total_price_tax_incl: '3.078936',
            total_price_tax_excl: '2.503200',
            tax_rate: '23.000',
          },
          {
            id: 1856,
            product_name: 'Zestaw balonów na 18 urodziny Black & Gold XXL',
            product_quantity: 1,
            unit_price_tax_incl: '72.354848',
            unit_price_tax_excl: '58.825080',
            total_price_tax_incl: '72.354848',
            total_price_tax_excl: '58.825080',
            tax_rate: '23.000',
          },
        ],
        bundleSelections: [
          {
            id_order_detail: 1856,
            bundle_name: 'Zestaw balonów na 18 urodziny Black & Gold XXL',
            components: Array.from({ length: 9 }, (_, index) => ({
              id_product: 1000 + index,
              reference: `SKU-${index}`,
              name: `Składnik ${index + 1}`,
              quantity: 1,
            })),
          },
        ],
      },
    }, {
      defaultPaymentMethod: 'PRZ',
      paymentTermDays: 0,
      receiverSignatureType: 'BPO',
      visibleBdo: false,
      splitBundleItems: true,
    }, new Date('2026-06-07T12:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join('\n'), /Skorygowano końcówkę zaokrągleń/);
    const positions = result.payload.Pozycje as any[];
    const grossTotal = positions.reduce((sum, position) =>
      sum + Math.round(Number(position.CenaJednostkowa) * Number(position.Ilosc) * 100) / 100
    , 0);
    assert.equal(Math.round(grossTotal * 100) / 100, 95.43);
    assert.equal(positions.filter((position) => position.CenaJednostkowa === 8.03).length, 1);
  });

  it('builds a full cancellation correction payload by zeroing invoice positions', async () => {
    const { buildIfirmaDomesticInvoiceCorrectionPayload } = await import('../src/services/ifirma/ifirma-correction.mapper');
    const result = buildIfirmaDomesticInvoiceCorrectionPayload({
      orderReference: 'KP-104',
      correctionType: 'CANCELLATION',
      reason: 'Klient anulowal zamowienie',
      returnedItems: [],
      refundShipping: true,
      settings: {
        defaultPaymentMethod: 'KOM',
        paymentTermDays: 0,
        issuePlace: 'Polskowola',
        receiverSignatureType: 'BPO',
        visibleBdo: false,
      },
      sourceInvoicePayload: {
        Pozycje: [
          { NazwaPelna: 'Produkt A', Ilosc: 2, CenaJednostkowa: 10, StawkaVat: 0.23, Jednostka: 'szt', TypStawkiVat: 'PRC' },
          { NazwaPelna: 'Wysyłka', Ilosc: 1, CenaJednostkowa: 20, StawkaVat: 0.23, Jednostka: 'szt', TypStawkiVat: 'PRC' },
        ],
      },
    }, new Date('2026-06-08T10:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.equal(result.payload.PowodKorekty, 'ZWR_SPRZ_TOW');
    assert.equal(result.payload.SposobZaplaty, 'KOM');
    assert.equal((result.payload.Pozycje as any[])[0].Ilosc, 0);
    assert.equal((result.payload.Pozycje as any[])[1].Ilosc, 0);
  });

  it('builds a partial return correction payload by reducing returned quantities only', async () => {
    const { buildIfirmaDomesticInvoiceCorrectionPayload } = await import('../src/services/ifirma/ifirma-correction.mapper');
    const result = buildIfirmaDomesticInvoiceCorrectionPayload({
      orderReference: 'KP-105',
      correctionType: 'RETURN',
      returnedItems: [
        { productName: 'Produkt A', quantity: 1, unitPriceTaxIncl: 10 },
      ],
      refundShipping: false,
      settings: {
        defaultPaymentMethod: 'PRZ',
        paymentTermDays: 0,
        receiverSignatureType: 'BPO',
        visibleBdo: false,
      },
      sourceInvoicePayload: {
        Pozycje: [
          { NazwaPelna: 'Produkt A', Ilosc: 3, CenaJednostkowa: 10, StawkaVat: 0.23, Jednostka: 'szt', TypStawkiVat: 'PRC' },
          { NazwaPelna: 'Wysyłka', Ilosc: 1, CenaJednostkowa: 20, StawkaVat: 0.23, Jednostka: 'szt', TypStawkiVat: 'PRC' },
        ],
      },
    }, new Date('2026-06-08T10:00:00Z'));

    assert.deepEqual(result.errors, []);
    assert.equal((result.payload.Pozycje as any[])[0].Ilosc, 2);
    assert.equal((result.payload.Pozycje as any[])[1].Ilosc, 1);
  });

  it('builds PrestaShop order slip XML with refund details and shipping', async () => {
    const { buildOrderSlipXml } = await import('../src/services/prestashop/prestashop-client');
    const xml = buildOrderSlipXml({
      orderId: 123,
      customerId: 456,
      totalProductsTaxExcl: 40,
      totalProductsTaxIncl: 49.2,
      totalShippingTaxExcl: 10,
      totalShippingTaxIncl: 12.3,
      amount: 61.5,
      shippingCost: true,
      partial: true,
      details: [
        { idOrderDetail: 789, productQuantity: 1, amountTaxExcl: 40, amountTaxIncl: 49.2 },
      ],
    });

    assert.match(xml, /<order_slip>/);
    assert.match(xml, /<id_order>123<\/id_order>/);
    assert.match(xml, /<id_customer>456<\/id_customer>/);
    assert.match(xml, /<id_order_detail>789<\/id_order_detail>/);
    assert.match(xml, /<total_shipping_tax_incl>12\.30<\/total_shipping_tax_incl>/);
    assert.match(xml, /<partial>1<\/partial>/);
  });
});
