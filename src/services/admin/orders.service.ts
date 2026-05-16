import prisma from '../../lib/prisma';
import { CreateManualOrderInput } from '../../schemas/admin.schema';
import type { ManualOrderResponse } from '../../types';
import { generateAccessToken } from '../../lib/token';
import { config } from '../../config';
import { emailService } from '../email/email.service';
import { queuePersonalizationEmail } from '../queue/email.queue';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';

function normalizeSku(value: string): string {
  return value.trim();
}

/**
 * Tworzy ręczne zamówienie (dla platform MANUAL - FB, Instagram, email itp.)
 */
export async function createManualOrder(data: CreateManualOrderInput): Promise<ManualOrderResponse> {
  const manualCasesCreated: Array<{
    id: string;
    token: string;
    orderReference: string;
    customerEmail: string;
    customerName: string;
    shopName: string;
    productName: string;
    quantity: number;
  }> = [];

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

  const personalizationEnabledForTenant = await tenantHasFeature(shop.tenantId, FEATURE_PERSONALIZATION_EDITOR);

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
      const normalizedSku = normalizeSku(item.sku);

      const shopMapping = await tx.shopProductMapping.findFirst({
        where: {
          shopId: data.shopId,
          externalSku: { equals: normalizedSku, mode: 'insensitive' },
          isActive: true,
        },
        include: {
          personalizationTemplate: true,
        },
      });

      // Legacy fallback for SKU-based personalized products.
      const personalizedProduct = personalizationEnabledForTenant && !shopMapping?.personalizationTemplate
        ? await tx.personalizedProduct.findFirst({
            where: {
              shopId: data.shopId,
              identifierType: 'SKU',
              identifierValue: { equals: normalizedSku, mode: 'insensitive' },
              isActive: true,
            },
            include: { template: true },
          })
        : null;

      const mappingTemplate = personalizationEnabledForTenant &&
        shopMapping?.warehouseProductId &&
        shopMapping?.personalizationEnabled
          ? shopMapping.personalizationTemplate
          : null;
      const caseTemplate = mappingTemplate || personalizedProduct?.template || null;

      // Utwórz pozycję zamówienia
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: newOrder.id,
          externalItemId: `${data.orderReference}-${normalizedSku}`,
          sku: normalizedSku,
          productNameSnapshot: item.productName.trim(),
          quantity: item.quantity,
          personalizedProductId: personalizedProduct?.id || null,
        },
      });

      // Jeśli produkt jest personalizowany, utwórz jeden case dla pozycji
      if (caseTemplate) {
        const { token, hash, encrypted } = generateAccessToken();

        const newCase = await tx.personalizationCase.create({
          data: {
            orderId: newOrder.id,
            orderItemId: orderItem.id,
            templateId: caseTemplate.id,
            templateVersionFrozen: caseTemplate.version,
            status: 'WAITING_FOR_CUSTOMER',
            customerTokenHash: hash,
            customerTokenEncrypted: encrypted,
            tokenActive: true,
          },
        });

        manualCasesCreated.push({
          id: newCase.id,
          token,
          orderReference: newOrder.orderReference,
          customerEmail: newOrder.customerEmail,
          customerName: newOrder.customerName || '',
          shopName: shop.name,
          productName: orderItem.productNameSnapshot,
          quantity: orderItem.quantity,
        });
      }
    }

    return newOrder;
  });

  // Trigger automations for created cases (after transaction commits)
  const { triggerAutomations, AutomationTrigger } = await import('./automation.service');
  const { createWzForOrder, shouldAutoCreateWzForTenant } = await import('./warehouse.service');

  if (await shouldAutoCreateWzForTenant(shop.tenantId)) {
    await createWzForOrder(order.id);
  }

  for (const caseItem of manualCasesCreated) {
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_CREATED,
      caseId: caseItem.id,
    });

    if (emailService.isConfigured() && config.smtp.autoSend) {
      await queuePersonalizationEmail({
        to: caseItem.customerEmail,
        customerName: caseItem.customerName,
        orderReference: caseItem.orderReference,
        shopName: caseItem.shopName,
        items: [
          {
            productName: caseItem.productName,
            quantity: caseItem.quantity,
            personalizationUrl: `${config.frontend.portalUrl}/${caseItem.token}`,
          },
        ],
        baseUrl: config.frontend.portalUrl,
        caseId: caseItem.id,
      });
    }
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
