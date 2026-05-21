import prisma from '../../lib/prisma';
import { PrestaShopClient, type PrestaShopOrderDetails } from '../prestashop/prestashop-client';
import { decrypt } from '../../lib/encryption';
import { emailService } from '../email/email.service';
import { generateAccessToken } from '../../lib/token';
import { createWzForOrder, shouldAutoCreateWzForTenant } from '../admin/warehouse.service';
import { reserveOrder } from '../admin/warehouse-reservations.service';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';

const DEBUG_SHOP_SYNC = process.env.DEBUG_SHOP_SYNC === 'true';

export interface SyncResult {
  success: boolean;
  ordersFetched: number;
  ordersCreated: number;
  ordersSkipped: number;
  casesCreated: number;
  errors: string[];
}

export interface ImportPrestaShopOrderOptions {
  reserveStock?: boolean;
  autoCreateWz?: boolean;
  sendPersonalizationEmail?: boolean;
}

export interface ImportPrestaShopOrderResult {
  success: boolean;
  externalOrderId: string;
  orderId: string | null;
  created: boolean;
  skipped: boolean;
  casesCreated: number;
  errors: string[];
}

type ShopSyncContext = {
  shop: any;
  config: any;
  client: PrestaShopClient;
  productMap: {
    SKU: Map<string, any>;
    INDEX: Map<string, any>;
    EAN: Map<string, any>;
  };
  mappingsByExternalProductId: Map<string, any>;
  mappingsBySku: Map<string, any>;
  personalizationEnabledForTenant: boolean;
};

export interface SyncShopOrdersOptions {
  fromDate?: string;
  fromOrderId?: string;
  limit?: number;
}

export async function syncShopOrders(shopId: string, options: SyncShopOrdersOptions = {}): Promise<SyncResult> {
  const startTime = new Date();
  const result: SyncResult = {
    success: false,
    ordersFetched: 0,
    ordersCreated: 0,
    ordersSkipped: 0,
    casesCreated: 0,
    errors: [],
  };

  try {
    const context = await createShopSyncContext(shopId);
    const autoCreateWz = await shouldAutoCreateWzForTenant(context.shop.tenantId);

    const dateFrom = options.fromDate
      ?? (context.shop.lastSyncAt
        ? context.shop.lastSyncAt.toISOString().split('T')[0]
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);

    const syncLimit = options.limit ?? context.config.orderSync?.limit ?? 50;

    const orders = await context.client.fetchOrders({
      limit: syncLimit,
      dateFrom,
      idFrom: options.fromOrderId,
      currentState: context.config.orderSync?.orderStatus === 'PAID' ? 2 : undefined,
    });

    result.ordersFetched = orders.length;
    if (DEBUG_SHOP_SYNC) {
      console.log(`[Sync] Fetched ${orders.length} orders from PrestaShop (limit: ${syncLimit})`);
    }

    for (const orderData of orders) {
      try {
        const imported = await importPrestaShopOrderWithContext(context, String(orderData.id), {
          reserveStock: true,
          autoCreateWz,
          sendPersonalizationEmail: true,
        });

        if (imported.created) result.ordersCreated++;
        if (imported.skipped) result.ordersSkipped++;
        result.casesCreated += imported.casesCreated;
        result.errors.push(...imported.errors);
      } catch (error) {
        result.errors.push(
          `Order ${orderData.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: { lastSyncAt: new Date() },
    });

    result.success = result.errors.length === 0;

    await logSync(
      shopId,
      'ORDERS',
      result.success ? 'SUCCESS' : result.ordersCreated > 0 ? 'PARTIAL' : 'FAILED',
      result,
      startTime
    );

    return result;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Unknown error');
    await logSync(shopId, 'ORDERS', 'FAILED', result, startTime);
    return result;
  }
}

export async function importPrestaShopOrder(
  shopId: string,
  externalOrderId: string | number,
  options: ImportPrestaShopOrderOptions = {}
): Promise<ImportPrestaShopOrderResult> {
  const context = await createShopSyncContext(shopId);
  const autoCreateWz = options.autoCreateWz ?? (await shouldAutoCreateWzForTenant(context.shop.tenantId));

  return importPrestaShopOrderWithContext(context, String(externalOrderId), {
    reserveStock: options.reserveStock ?? true,
    autoCreateWz,
    sendPersonalizationEmail: options.sendPersonalizationEmail ?? true,
  });
}

async function createShopSyncContext(shopId: string): Promise<ShopSyncContext> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: {
      personalizedProducts: {
        where: { isActive: true },
        include: { template: true },
      },
      productMappings: {
        where: {
          isActive: true,
        },
        include: {
          personalizationTemplate: true,
        },
      },
    },
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  if (shop.status !== 'ACTIVE') {
    throw new Error('Shop is not active');
  }

  const config = (shop.configJson as any) || {};
  const authType = config.authType || 'WEB_SERVICE';
  const apiKey = decrypt(shop.apiKey);

  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey,
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
  });

  const productMap = {
    SKU: new Map<string, any>(),
    INDEX: new Map<string, any>(),
    EAN: new Map<string, any>(),
  };

  for (const pp of shop.personalizedProducts as any[]) {
    const type = pp.identifierType as keyof typeof productMap;
    if (productMap[type]) {
      productMap[type].set(pp.identifierValue.toLowerCase(), pp);
      if (DEBUG_SHOP_SYNC) {
        console.log(`[Sync] Mapped ${type}: "${pp.identifierValue}" -> Product: ${pp.name}`);
      }
    }
  }

  const mappingsByExternalProductId = new Map<string, any>();
  const mappingsBySku = new Map<string, any>();
  for (const mapping of shop.productMappings as any[]) {
    mappingsByExternalProductId.set(String(mapping.externalProductId), mapping);
    if (mapping.externalSku) {
      mappingsBySku.set(mapping.externalSku.trim().toLowerCase(), mapping);
    }
  }

  if (DEBUG_SHOP_SYNC) {
    console.log(`[Sync] Product map built: SKU=${productMap.SKU.size}, INDEX=${productMap.INDEX.size}, EAN=${productMap.EAN.size}`);
    console.log(`[Sync] Shop mapping map built: externalId=${mappingsByExternalProductId.size}, SKU=${mappingsBySku.size}`);
  }

  const personalizationEnabledForTenant = await tenantHasFeature(shop.tenantId, FEATURE_PERSONALIZATION_EDITOR);

  return {
    shop,
    config,
    client,
    productMap,
    mappingsByExternalProductId,
    mappingsBySku,
    personalizationEnabledForTenant,
  };
}

async function importPrestaShopOrderWithContext(
  context: ShopSyncContext,
  externalOrderId: string,
  options: Required<ImportPrestaShopOrderOptions>
): Promise<ImportPrestaShopOrderResult> {
  const result: ImportPrestaShopOrderResult = {
    success: false,
    externalOrderId,
    orderId: null,
    created: false,
    skipped: false,
    casesCreated: 0,
    errors: [],
  };

  const existingOrder = await prisma.order.findUnique({
    where: {
      shopId_externalOrderId: {
        shopId: context.shop.id,
        externalOrderId,
      },
    },
  });

  if (existingOrder) {
    result.orderId = existingOrder.id;
    result.skipped = true;

    if (options.reserveStock) {
      try {
        await reserveOrder(existingOrder.id);
        if (options.autoCreateWz) {
          await createWzForOrder(existingOrder.id);
        }
      } catch (reservationError) {
        const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation error';
        result.errors.push(`Order ${externalOrderId}: reservation not updated: ${message}`);
      }
    }

    result.success = result.errors.length === 0;
    return result;
  }

  if (DEBUG_SHOP_SYNC) console.log(`Fetching details for order ${externalOrderId}...`);
  const details = await context.client.fetchOrderDetails(Number(externalOrderId));
  if (DEBUG_SHOP_SYNC) console.log(`Order ${externalOrderId} details fetched successfully`);

  return createOrderFromDetails(context, details, options, result);
}

async function createOrderFromDetails(
  context: ShopSyncContext,
  details: PrestaShopOrderDetails,
  options: Required<ImportPrestaShopOrderOptions>,
  result: ImportPrestaShopOrderResult
): Promise<ImportPrestaShopOrderResult> {
  if (DEBUG_SHOP_SYNC) {
    console.log(`[Sync] Order ${details.order.id} has ${details.items.length} items:`);
    details.items.forEach((item, idx) => {
      console.log(`  [${idx + 1}] ${item.product_name}`);
      console.log(`      product_reference: "${item.product_reference}"`);
      console.log(`      product_id: ${item.product_id}`);
      console.log(`      quantity: ${item.quantity}`);
    });
  }

  const getPersonalizedProduct = (item: { product_reference: string }) => {
    const ref = (item.product_reference || '').toLowerCase();
    return context.productMap.SKU.get(ref) ||
      context.productMap.INDEX.get(ref) ||
      context.productMap.EAN.get(ref) ||
      null;
  };

  const getShopMapping = (item: { product_id: number; product_reference: string }) => {
    const byExternalId = context.mappingsByExternalProductId.get(String(item.product_id));
    if (byExternalId) return byExternalId;

    const ref = (item.product_reference || '').trim().toLowerCase();
    return ref ? context.mappingsBySku.get(ref) || null : null;
  };

  const relevantItems = details.items.filter((item) => {
    const ref = (item.product_reference || '').toLowerCase();
    const personalizedProduct = getPersonalizedProduct(item);
    const shopMapping = getShopMapping(item);
    const isWarehouseMapped = Boolean(shopMapping?.warehouseProductId);
    const isPersonalizationMapped = Boolean(
      context.personalizationEnabledForTenant &&
      shopMapping?.warehouseProductId &&
      shopMapping?.personalizationEnabled &&
      shopMapping?.personalizationTemplateId
    );

    if (isPersonalizationMapped) {
      if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched personalized mapping item: ${item.product_name} (reference: ${ref})`);
    } else if (context.personalizationEnabledForTenant && personalizedProduct) {
      if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched personalized item: ${item.product_name} (reference: ${ref})`);
    } else if (isWarehouseMapped) {
      if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched warehouse item: ${item.product_name} (reference: ${ref})`);
    } else {
      if (DEBUG_SHOP_SYNC) console.log(`[Sync] No match: ${item.product_name} (reference: ${ref})`);
    }

    return isPersonalizationMapped ||
      (context.personalizationEnabledForTenant && Boolean(personalizedProduct)) ||
      isWarehouseMapped;
  });

  if (relevantItems.length === 0) {
    if (DEBUG_SHOP_SYNC) console.log(`[Sync] Order ${details.order.id} has no personalized or warehouse-mapped products, skipping`);
    result.skipped = true;
    result.success = true;
    return result;
  }

  const customerEmail = details.customer.email?.trim().toLowerCase();
  if (!customerEmail) {
    console.warn(`[Sync] Order ${details.order.id} has no customer email, skipping`);
    result.skipped = true;
    result.errors.push(`Order ${details.order.id}: missing customer email`);
    result.success = false;
    return result;
  }

  const order = await prisma.order.create({
    data: {
      shopId: context.shop.id,
      externalOrderId: String(details.order.id),
      orderReference: details.order.reference,
      customerEmail,
      customerName: `${details.customer.firstname} ${details.customer.lastname}`.trim(),
      language: 'pl',
      currency: 'PLN',
      totalPaid: parseFloat(details.order.total_paid),
      createdAtShop: new Date(details.order.date_add),
      payloadJson: JSON.parse(JSON.stringify(details)),
    },
  });

  result.orderId = order.id;
  result.created = true;

  const casesForEmail: Array<{
    productName: string;
    quantity: number;
    token: string;
  }> = [];

  for (const item of relevantItems) {
    const shopMapping: any = getShopMapping(item);
    const personalizedProduct: any = getPersonalizedProduct(item);
    const mappingTemplate = context.personalizationEnabledForTenant &&
      shopMapping?.warehouseProductId &&
      shopMapping?.personalizationEnabled
        ? shopMapping.personalizationTemplate
        : null;
    const legacyTemplate = context.personalizationEnabledForTenant ? personalizedProduct?.template : null;
    const caseTemplate = mappingTemplate || legacyTemplate || null;
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        externalItemId: String(item.id),
        sku: item.product_reference,
        productNameSnapshot: item.product_name,
        quantity: item.quantity,
        personalizedProductId: personalizedProduct?.id ?? null,
        warehouseProductId: shopMapping?.warehouseProductId ?? null,
      },
    });

    if (!caseTemplate) {
      continue;
    }

    const { token: customerToken, hash: tokenHash, encrypted: tokenEncrypted } = generateAccessToken();

    const newCase = await prisma.personalizationCase.create({
      data: {
        orderId: order.id,
        orderItemId: orderItem.id,
        templateId: caseTemplate.id,
        templateVersionFrozen: caseTemplate.version,
        status: 'NEW',
        customerTokenHash: tokenHash,
        customerTokenEncrypted: tokenEncrypted,
        tokenActive: true,
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

    result.casesCreated++;

    const { triggerAutomations, AutomationTrigger } = await import('../admin/automation.service');
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_CREATED,
      caseId: newCase.id,
      caseData: newCase,
    });

    casesForEmail.push({
      productName: item.product_name,
      quantity: item.quantity,
      token: customerToken,
    });
  }

  if (options.reserveStock) {
    try {
      const reservationResult = await reserveOrder(order.id);
      if (DEBUG_SHOP_SYNC) {
        console.log(`[Sync] Order ${details.order.id} reservations:`, reservationResult);
      }
    } catch (reservationError) {
      const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation error';
      result.errors.push(`Order ${details.order.id}: reservation not created: ${message}`);
    }

    if (options.autoCreateWz) {
      try {
        await createWzForOrder(order.id);
      } catch (warehouseError) {
        const message = warehouseError instanceof Error ? warehouseError.message : 'Unknown warehouse error';
        result.errors.push(`Order ${details.order.id}: WZ not created: ${message}`);
      }
    }
  }

  if (options.sendPersonalizationEmail && casesForEmail.length > 0 && emailService.isConfigured() && context.config.smtp?.autoSend) {
    try {
      const baseUrl = context.config.frontend.portalUrl;

      await emailService.sendPersonalizationEmail({
        to: customerEmail,
        customerName: `${details.customer.firstname} ${details.customer.lastname}`.trim(),
        orderReference: details.order.reference,
        shopName: context.shop.name,
        items: casesForEmail.map(c => ({
          productName: c.productName,
          quantity: c.quantity,
          personalizationUrl: `${baseUrl}/${c.token}`,
        })),
        baseUrl,
      });

      console.log(`[Sync] Email sent to ${customerEmail} for order ${details.order.reference}`);
    } catch (emailError) {
      console.error(`[Sync] Failed to send email for order ${details.order.reference}:`, emailError);
    }
  } else if (options.sendPersonalizationEmail && casesForEmail.length > 0 && !context.config.smtp?.autoSend) {
    if (DEBUG_SHOP_SYNC) {
      console.log(`[Sync] AUTO_SEND_EMAILS=false - email NOT sent for order ${details.order.reference} (${casesForEmail.length} cases created, manual send required)`);
    }
  } else if (options.sendPersonalizationEmail && casesForEmail.length > 0) {
    console.warn(`[Sync] Email service not configured, skipping email for order ${details.order.reference}`);
  }

  result.success = result.errors.length === 0;
  return result;
}

async function logSync(
  shopId: string,
  syncType: string,
  status: string,
  result: SyncResult,
  startTime: Date
) {
  await prisma.syncLog.create({
    data: {
      shopId,
      syncType,
      status,
      ordersFetched: result.ordersFetched,
      ordersCreated: result.ordersCreated,
      ordersSkipped: result.ordersSkipped,
      errorMessage: result.errors.join('; ') || null,
      startedAt: startTime,
      finishedAt: new Date(),
    },
  });
}
