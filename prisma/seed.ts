import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

export async function seed() {
  console.log('🌱 Seeding database...');

  // 1. Utwórz przykładowy sklep
  const shop = await prisma.shop.upsert({
    where: { id: 'shop_1' },
    update: {},
    create: {
      id: 'shop_1',
      name: 'Kreatywne Papierki',
      platform: 'PRESTASHOP',
      baseUrl: 'https://kreatywne-papierki.pl',
      apiKey: 'dev-api-key-change-in-production',
      apiSecret: null,
      status: 'ACTIVE',
    },
  });
  console.log('✅ Shop created:', shop.name);

  // 2. Utwórz użytkownika admin
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@kreatywne-papierki.pl' },
    update: {},
    create: {
      email: 'admin@kreatywne-papierki.pl',
      passwordHash: adminPassword,
      name: 'Administrator',
      role: 'ADMIN',
      isActive: true,
    },
  });
  console.log('✅ Admin user created:', admin.email);

  // 3. Utwórz użytkownika seller
  const sellerPassword = await bcrypt.hash('seller123', 10);
  const seller = await prisma.user.upsert({
    where: { email: 'seller@kreatywne-papierki.pl' },
    update: {},
    create: {
      email: 'seller@kreatywne-papierki.pl',
      passwordHash: sellerPassword,
      name: 'Sprzedawca',
      role: 'SELLER',
      isActive: true,
    },
  });
  console.log('✅ Seller user created:', seller.email);

  // 4. Utwórz przykładowy szablon personalizacji
  const template = await prisma.personalizationTemplate.upsert({
    where: { code: 'INV_KOMUNIA_01' },
    update: {},
    create: {
      code: 'INV_KOMUNIA_01',
      name: 'Zaproszenie komunijne - wzór 01',
      description: 'Eleganckie zaproszenie na Pierwszą Komunię Świętą',
      version: 1,
      isActive: true,
    },
  });
  console.log('✅ Template created:', template.name);

  // 5. Utwórz formularz dla szablonu
  const form = await prisma.form.create({
    data: {
      templateId: template.id,
      name: 'Dane zaproszenia',
      sortOrder: 1,
      isActive: true,
    },
  });
  console.log('✅ Form created:', form.name);

  // 6. Utwórz pola formularza
  const fields = [
    {
      formId: form.id,
      key: 'child_name',
      label: 'Imię i nazwisko dziecka',
      type: 'text',
      required: true,
      sortOrder: 1,
      placeholder: 'np. Jan Kowalski',
    },
    {
      formId: form.id,
      key: 'ceremony_date',
      label: 'Data ceremonii',
      type: 'date',
      required: true,
      sortOrder: 2,
    },
    {
      formId: form.id,
      key: 'ceremony_time',
      label: 'Godzina ceremonii',
      type: 'time',
      required: true,
      sortOrder: 3,
    },
    {
      formId: form.id,
      key: 'church_name',
      label: 'Nazwa kościoła',
      type: 'text',
      required: true,
      sortOrder: 4,
      placeholder: 'np. Parafia św. Jana',
    },
    {
      formId: form.id,
      key: 'church_address',
      label: 'Adres kościoła',
      type: 'text',
      required: true,
      sortOrder: 5,
      placeholder: 'np. ul. Kościelna 1, Warszawa',
    },
    {
      formId: form.id,
      key: 'reception_place',
      label: 'Miejsce przyjęcia',
      type: 'text',
      required: false,
      sortOrder: 6,
      placeholder: 'np. Restauracja Pod Gruszą',
    },
    {
      formId: form.id,
      key: 'additional_info',
      label: 'Dodatkowe informacje',
      type: 'textarea',
      required: false,
      sortOrder: 7,
      maxLength: 500,
      placeholder: 'Opcjonalne informacje dla gości',
    },
  ];

  for (const field of fields) {
    await prisma.formField.create({ data: field });
  }
  console.log(`✅ Created ${fields.length} form fields`);

  // 7. Utwórz produkt personalizowany
  const personalizedProduct = await prisma.personalizedProduct.create({
    data: {
      shopId: shop.id,
      name: 'Zaproszenie komunijne - wzór 01',
      identifierType: 'SKU',
      identifierValue: 'INV-KOMUNIA-001',
      templateId: template.id,
      isActive: true,
    },
  });
  console.log('✅ Personalized product created:', personalizedProduct.name, `(${personalizedProduct.identifierType}=${personalizedProduct.identifierValue})`);

  // 8. Utwórz przykładowe zamówienia i PersonalizationCase
  const order1 = await prisma.order.upsert({
    where: { shopId_externalOrderId: { shopId: shop.id, externalOrderId: 'WC-1001' } },
    update: {},
    create: {
      shopId: shop.id,
      externalOrderId: 'WC-1001',
      orderReference: 'KP-2024-001',
      customerEmail: 'sierpien.michal@gmail.com',
      customerName: 'Jan Kowalski',
      language: 'pl',
      currency: 'PLN',
      totalPaid: 149.99,
      createdAtShop: new Date('2024-01-15T10:30:00Z'),
      payloadJson: { items: [{ sku: 'INV-KOMUNIA-001', qty: 1 }] },
    },
  });

  const order2 = await prisma.order.upsert({
    where: { shopId_externalOrderId: { shopId: shop.id, externalOrderId: 'WC-1002' } },
    update: {},
    create: {
      shopId: shop.id,
      externalOrderId: 'WC-1002',
      orderReference: 'KP-2024-002',
      customerEmail: 'anna.nowak@example.com',
      customerName: 'Anna Nowak',
      language: 'pl',
      currency: 'PLN',
      totalPaid: 299.99,
      createdAtShop: new Date('2024-01-16T14:20:00Z'),
      payloadJson: { items: [{ sku: 'INV-KOMUNIA-001', qty: 2 }] },
    },
  });
  console.log('✅ Sample orders created');

  // 9. Utwórz OrderItems
  const orderItem1 = await prisma.orderItem.upsert({
    where: { id: 'order_item_1' },
    update: {},
    create: {
      id: 'order_item_1',
      orderId: order1.id,
      externalItemId: 'ext-1',
      sku: 'INV-KOMUNIA-001',
      productNameSnapshot: 'Zaproszenie komunijne - wzór 01',
      quantity: 1,
      personalizedProductId: personalizedProduct.id,
    },
  });

  const orderItem2 = await prisma.orderItem.upsert({
    where: { id: 'order_item_2' },
    update: {},
    create: {
      id: 'order_item_2',
      orderId: order2.id,
      externalItemId: 'ext-2',
      sku: 'INV-KOMUNIA-001',
      productNameSnapshot: 'Zaproszenie komunijne - wzór 01',
      quantity: 2,
      personalizedProductId: personalizedProduct.id,
    },
  });
  console.log('✅ Order items created');

  // 10. Utwórz PersonalizationCase
  await prisma.personalizationCase.upsert({
    where: { orderItemId: orderItem1.id },
    update: {},
    create: {
      orderId: order1.id,
      orderItemId: orderItem1.id,
      templateId: template.id,
      templateVersionFrozen: 1,
      status: 'NEW',
      tokenActive: true,
    },
  });

  await prisma.personalizationCase.upsert({
    where: { orderItemId: orderItem2.id },
    update: {},
    create: {
      orderId: order2.id,
      orderItemId: orderItem2.id,
      templateId: template.id,
      templateVersionFrozen: 1,
      status: 'WAITING_FOR_CUSTOMER',
      tokenActive: true,
    },
  });
  console.log('✅ Personalization cases created');

  // 11. Utwórz przykładowy SyncLog
  await prisma.syncLog.create({
    data: {
      shopId: shop.id,
      syncType: 'ORDERS',
      status: 'SUCCESS',
      ordersFetched: 5,
      ordersCreated: 2,
      ordersSkipped: 3,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  console.log('✅ Sample sync log created');

  console.log('🎉 Seeding completed successfully!');
  console.log('\n📋 Test credentials:');
  console.log('   Admin: admin@kreatywne-papierki.pl / admin123');
  console.log('   Seller: seller@kreatywne-papierki.pl / seller123');
}

// Auto-run if main script (not imported)
if (require.main === module) {
  seed()
    .catch((e) => {
      console.error('❌ Error seeding database:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
