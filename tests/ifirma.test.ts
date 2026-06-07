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
    assert.equal(result.payload.TerminPlatnosci, '2026-06-14');
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
});
