import prisma from '../../lib/prisma';
import { CreateManualOrderInput } from '../../schemas/admin.schema';
import type { ManualOrderResponse } from '../../types';

// Temporary array to store created cases outside transaction
const manualCasesCreated: any[] = [];

/**
 * Tworzy ręczne zamówienie (dla platform MANUAL - FB, Instagram, email itp.)
 */
export async function createManualOrder(data: CreateManualOrderInput): Promise<ManualOrderResponse> {
  manualCasesCreated.length = 0; // Clear array before starting

  // Walidacja: czy sklep istnieje i jest typu MANUAL
  const shop = await prisma.shop.findUnique({
    where: { id: data.shopId },
  });

  if (!shop) {
    throw new Error('Sklep nie istnieje');
  }

  if (shop.platform !== 'MANUAL') {
    throw new Error('Można tworzyć ręczne zamówienia tylko dla sklepów typu MANUAL');
  }

  // Sprawdź czy order reference już nie istnieje dla tego sklepu
  const existingOrder = await prisma.order.findUnique({
    where: {
      shopId_externalOrderId: {
        shopId: data.shopId,
        externalOrderId: data.orderReference,
      },
    },
  });

  if (existingOrder) {
    throw new Error(`Zamówienie ${data.orderReference} już istnieje dla tego sklepu`);
  }

  const createdAtShop = data.createdAtShop ? new Date(data.createdAtShop) : new Date();

  // Utwórz zamówienie z pozycjami w transakcji
  const order = await prisma.$transaction(async (tx) => {
    // Utwórz zamówienie
    const newOrder = await tx.order.create({
      data: {
        shopId: data.shopId,
        externalOrderId: data.orderReference,
        orderReference: data.orderReference,
        customerEmail: data.customerEmail,
        customerName: data.customerName || null,
        language: data.language || 'pl',
        currency: data.currency || 'PLN',
        totalPaid: data.totalPaid,
        createdAtShop,
        payloadJson: {
          source: 'manual',
          notes: data.notes,
          createdBy: 'admin', // TODO: pobierać z auth context
        },
        syncedAt: new Date(),
      },
    });

    // Utwórz pozycje zamówienia
    for (const item of data.items) {
      // Sprawdź czy produkt jest personalizowany
      const personalizedProduct = await tx.personalizedProduct.findFirst({
        where: {
          shopId: data.shopId,
          identifierType: 'SKU',
          identifierValue: item.sku,
          isActive: true,
        },
        include: {
          template: {
            include: {
              forms: {
                where: { isActive: true },
                include: {
                  fields: {
                    orderBy: { sortOrder: 'asc' },
                  },
                },
                orderBy: { sortOrder: 'asc' },
              },
            },
          },
        },
      });

      // Utwórz pozycję zamówienia
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: newOrder.id,
          externalItemId: `${data.orderReference}-${item.sku}`,
          sku: item.sku,
          productNameSnapshot: item.productName,
          quantity: item.quantity,
          personalizedProductId: personalizedProduct?.id || null,
        },
      });

      // Jeśli produkt jest personalizowany, utwórz case(y)
      if (personalizedProduct) {
        for (let i = 0; i < item.quantity; i++) {
          const newCase = await tx.personalizationCase.create({
            data: {
              orderId: newOrder.id,
              orderItemId: orderItem.id,
              productIdentifierType: 'SKU',
              productIdentifierValue: item.sku,
              productNameSnapshot: item.productName,
              templateId: personalizedProduct.templateId,
              status: 'NEW',
              submissionUrl: '', // TODO: generować link
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 dni
            },
            include: {
              order: {
                include: {
                  shop: true,
                },
              },
              orderItem: true,
              template: true,
            },
          });

          // Trigger automation (poza transakcją, po commit)
          manualCasesCreated.push(newCase);
        }
      }
    }

    return newOrder;
  });

  // Trigger automations for created cases (after transaction commits)
  const { triggerAutomations, AutomationTrigger } = await import('./automation.service');
  for (const caseItem of manualCasesCreated) {
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_CREATED,
      caseItem,
    });
  }

  // Policz ile cases utworzono
  const casesCount = await prisma.personalizationCase.count({
    where: { orderId: order.id },
  });

  return {
    orderId: order.id,
    casesCreated: casesCount,
    message: `Utworzono zamówienie ${data.orderReference} z ${casesCount} przypadkami personalizacji`,
  };
}

/**
 * Usuwa zamówienie wraz z wszystkimi powiązanymi danymi
 */
export async function deleteOrder(orderId: string): Promise<void> {
  // Sprawdź czy zamówienie istnieje
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new Error('Zamówienie nie istnieje');
  }

  // Usuń w transakcji
  await prisma.$transaction(async (tx) => {
    // Usuń wszystkie case'y powiązane z zamówieniem
    await tx.personalizationCase.deleteMany({
      where: { orderId },
    });

    // Usuń pozycje zamówienia
    await tx.orderItem.deleteMany({
      where: { orderId },
    });

    // Usuń zamówienie
    await tx.order.delete({
      where: { id: orderId },
    });
  });
}
