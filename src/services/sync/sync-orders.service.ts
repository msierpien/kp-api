import prisma from '../../lib/prisma';
import {
  PrestaShopClient,
  type PrestaShopBundleOrderSelection,
  type PrestaShopOrder,
  type PrestaShopOrderDetails,
} from '../prestashop/prestashop-client';
import { decrypt } from '../../lib/encryption';
import { emailService } from '../email/email.service';
import { generateAccessToken } from '../../lib/token';
import { createWzForOrder, shouldAutoCreateWzForTenant } from '../admin/warehouse-documents.service';
import { releaseOrderReservations, reserveOrder } from '../admin/warehouse-reservations.service';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';
import { getInventoryPublicationDecision, resolveInventoryPublishedLeadTime } from '../stock/stock-sync.service';
import {
  calculateShippingPromise,
  maxShippingPromise,
  normalizeCutoff,
  type ShippingPromise,
} from '../orders/shipping-promise.service';
import { resolveOrderSyncFromDate } from './order-sync-date';
import {
  inferOperationalStatusFromShopStatus,
  isStockReservationOrderOperationalStatus,
} from '../../lib/order-statuses';
import type { OrderOperationalStatus } from '../../lib/order-statuses';
import { findShopOrderStatusRecord } from '../shop-order-statuses.repository';

const DEBUG_SHOP_SYNC = process.env.DEBUG_SHOP_SYNC === 'true';

export interface SyncResult {
  success: boolean;
  fromDate?: string;
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

type OrderStatusSnapshot = {
  externalStatusId: string;
  externalStatusName: string | null;
  operationalStatus: OrderOperationalStatus;
};

type OrderImportItem = {
  id: string;
  product_id: number;
  product_reference: string;
  product_name: string;
  quantity: number;
  product_price?: string;
  unit_price_tax_incl?: string;
  unit_price_tax_excl?: string;
  total_price_tax_incl?: string;
  total_price_tax_excl?: string;
  tax_rate?: string;
  tax_name?: string;
  payload?: Record<string, unknown>;
  sourceType: 'SIMPLE' | 'BUNDLE_COMPONENT';
  bundleGroupId?: string | null;
  bundleName?: string | null;
  bundleExternalItemId?: string | null;
  bundleExternalProductId?: string | null;
};

export interface SyncShopOrdersOptions {
  fromDate?: string;
  fromOrderId?: string;
  limit?: number;
}

function resolvePaidOrderStatusIds(config: any): number[] | undefined {
  const orderSync = config?.orderSync ?? {};
  const orderStatus = typeof orderSync.orderStatus === 'string'
    ? orderSync.orderStatus.trim().toUpperCase()
    : 'PAID';

  if (orderStatus === 'ALL') {
    return undefined;
  }

  const rawStatusIds = orderStatus === 'CUSTOM'
    ? orderSync.currentStateIds ?? orderSync.currentStates
    : orderSync.paidStatusIds ?? orderSync.currentStateIds ?? orderSync.currentStates;
  const values = Array.isArray(rawStatusIds)
    ? rawStatusIds
    : typeof rawStatusIds === 'string'
      ? rawStatusIds.split(',')
      : rawStatusIds === undefined || rawStatusIds === null
        ? []
        : [rawStatusIds];

  const statusIds = Array.from(new Set(
    values
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0)
  ));

  if (statusIds.length > 0) {
    return statusIds;
  }

  return orderStatus === 'PAID' ? [2] : undefined;
}

async function fetchOrdersByStatus(
  client: PrestaShopClient,
  params: {
    limit: number;
    dateFrom?: string;
    dateField?: 'date_add' | 'date_upd';
    idFrom?: string;
  },
  currentStates: number[] | undefined,
): Promise<PrestaShopOrder[]> {
  if (!currentStates || currentStates.length === 0) {
    return client.fetchOrders(params);
  }

  const ordersById = new Map<string, PrestaShopOrder>();
  for (const currentState of currentStates) {
    const orders = await client.fetchOrders({
      ...params,
      currentState,
    });
    for (const order of orders) {
      ordersById.set(String(order.id), order);
    }
  }

  return Array.from(ordersById.values()).sort((a, b) => Number(a.id) - Number(b.id));
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

    const dateFrom = resolveOrderSyncFromDate({
      requestedFromDate: options.fromDate,
      lastSyncAt: context.shop.lastSyncAt,
      config: context.config,
      now: startTime,
    });
    result.fromDate = dateFrom;

    const syncLimit = options.limit ?? context.config.orderSync?.limit ?? 50;

    const orders = await fetchOrdersByStatus(context.client, {
      limit: syncLimit,
      dateFrom: options.fromOrderId ? undefined : dateFrom,
      dateField: 'date_upd',
      idFrom: options.fromOrderId,
    }, resolvePaidOrderStatusIds(context.config));

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
        }, orderData);

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

async function resolveOrderStatusSnapshot(
  context: ShopSyncContext,
  externalOrderId: string,
  sourceOrder?: PrestaShopOrder,
): Promise<OrderStatusSnapshot | null> {
  let externalStatusId = sourceOrder?.current_state == null ? null : String(sourceOrder.current_state);
  let externalStatusName: string | null = null;
  let orderStatus: PrestaShopOrderDetails['orderStatus'] = null;

  if (!externalStatusId) {
    const details = await context.client.fetchOrderDetails(Number(externalOrderId));
    externalStatusId = details.order.current_state == null ? null : String(details.order.current_state);
    externalStatusName = details.orderStatus?.name ?? null;
    orderStatus = details.orderStatus;
  }

  if (!externalStatusId) return null;

  const mappedStatus = await findShopOrderStatusRecord(context.shop.id, externalStatusId);
  const statusName = mappedStatus?.name ?? externalStatusName ?? null;

  return {
    externalStatusId,
    externalStatusName: statusName,
    operationalStatus: inferOperationalStatusFromShopStatus(mappedStatus ?? orderStatus ?? {
      externalStatusId,
      name: statusName,
    }),
  };
}

async function refreshExistingOrderStatus(
  context: ShopSyncContext,
  existingOrder: { id: string },
  externalOrderId: string,
  sourceOrder?: PrestaShopOrder,
): Promise<OrderStatusSnapshot | null> {
  const status = await resolveOrderStatusSnapshot(context, externalOrderId, sourceOrder);
  if (!status) return null;

  await prisma.order.update({
    where: { id: existingOrder.id },
    data: {
      externalStatusId: status.externalStatusId,
      externalStatusName: status.externalStatusName,
      operationalStatus: status.operationalStatus,
      statusSyncedAt: new Date(),
      statusSyncError: null,
    },
  });

  return status;
}

async function importPrestaShopOrderWithContext(
  context: ShopSyncContext,
  externalOrderId: string,
  options: Required<ImportPrestaShopOrderOptions>,
  sourceOrder?: PrestaShopOrder,
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

    let currentStatus: OrderStatusSnapshot | null = null;
    try {
      currentStatus = await refreshExistingOrderStatus(context, existingOrder, externalOrderId, sourceOrder);
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : 'Unknown status refresh error';
      result.errors.push(`Order ${externalOrderId}: status not refreshed: ${message}`);
    }

    if (options.reserveStock && isStockReservationOrderOperationalStatus(currentStatus?.operationalStatus ?? existingOrder.operationalStatus)) {
      try {
        await reserveOrder(existingOrder.id);
        if (options.autoCreateWz) {
          await createWzForOrder(existingOrder.id);
        }
      } catch (reservationError) {
        const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation error';
        result.errors.push(`Order ${externalOrderId}: reservation not updated: ${message}`);
      }
    } else if (currentStatus && !isStockReservationOrderOperationalStatus(currentStatus.operationalStatus)) {
      try {
        await releaseOrderReservations(existingOrder.id);
      } catch (reservationError) {
        const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation release error';
        result.errors.push(`Order ${externalOrderId}: reservation not released: ${message}`);
      }
    }

    result.success = result.errors.length === 0;
    return result;
  }

  if (DEBUG_SHOP_SYNC) console.log(`Fetching details for order ${externalOrderId}...`);
  const bundleConfig = context.config.advancedBundle ?? context.config.kpAdvancedBundle ?? {};
  const bundleImportEnabled = Boolean(bundleConfig.enabled ?? bundleConfig.importBundles);
  const bundleApiKey = typeof bundleConfig.apiKey === 'string'
    ? bundleConfig.apiKey
    : typeof bundleConfig.token === 'string'
      ? bundleConfig.token
      : '';

  if (bundleImportEnabled && !bundleApiKey.trim()) {
    result.errors.push(`Order ${externalOrderId}: advanced bundle import enabled but apiKey is missing`);
    return result;
  }

  let details: PrestaShopOrderDetails;
  try {
    details = await context.client.fetchOrderDetails(
      Number(externalOrderId),
      bundleImportEnabled ? { bundleApiKey } : {},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown PrestaShop order error';
    result.errors.push(`Order ${externalOrderId}: ${message}`);
    return result;
  }
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

  const importItems = buildImportItems(details);

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

  importItems.forEach((item) => {
    const ref = (item.product_reference || '').toLowerCase();
    const personalizedProduct = getPersonalizedProduct(item);
    const shopMapping = getShopMapping(item);
    const isBundleComponent = item.sourceType === 'BUNDLE_COMPONENT';
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

    return isBundleComponent ||
      isPersonalizationMapped ||
      (context.personalizationEnabledForTenant && Boolean(personalizedProduct)) ||
      isWarehouseMapped;
  });

  const customerEmail = details.customer.email?.trim().toLowerCase();
  if (!customerEmail) {
    console.warn(`[Sync] Order ${details.order.id} has no customer email, skipping`);
    result.skipped = true;
    result.errors.push(`Order ${details.order.id}: missing customer email`);
    result.success = false;
    return result;
  }

  const shippingPromisesByItemId = new Map<string, ShippingPromise>();
  for (const item of importItems) {
    const shopMapping: any = getShopMapping(item);
    const shippingPromise = await buildItemShippingPromise(context, details, shopMapping);
    if (shippingPromise) {
      shippingPromisesByItemId.set(item.id, shippingPromise);
    }
  }
  const orderShippingPromise = maxShippingPromise(Array.from(shippingPromisesByItemId.values()));
  const externalStatusId = details.order.current_state == null ? null : String(details.order.current_state);
  const mappedStatus = externalStatusId
    ? await findShopOrderStatusRecord(context.shop.id, externalStatusId)
    : null;
  const operationalStatus = inferOperationalStatusFromShopStatus(mappedStatus ?? {
    externalStatusId,
    name: details.orderStatus?.name ?? null,
    isPaid: details.orderStatus?.paid ?? null,
    isCancelled: details.orderStatus?.deleted ?? null,
    shipped: details.orderStatus?.shipped ?? null,
    delivery: details.orderStatus?.delivery ?? null,
  });

  const order = await prisma.order.create({
    data: {
      shopId: context.shop.id,
      externalOrderId: String(details.order.id),
      orderReference: details.order.reference,
      customerEmail,
      customerName: `${details.customer.firstname} ${details.customer.lastname}`.trim(),
      language: 'pl',
      currency: String((details.order as any).currency || 'PLN'),
      totalPaid: parseFloat(details.order.total_paid),
      totalShippingTaxIncl: decimalOrNull(details.order.total_shipping_tax_incl),
      totalShippingTaxExcl: decimalOrNull(details.order.total_shipping_tax_excl),
      totalDiscountsTaxIncl: decimalOrNull(details.order.total_discounts_tax_incl),
      totalDiscountsTaxExcl: decimalOrNull(details.order.total_discounts_tax_excl),
      paymentMethod: details.order.payment || details.order.module || null,
      operationalStatus,
      externalStatusId,
      externalStatusName: details.orderStatus?.name ?? null,
      createdAtShop: new Date(details.order.date_add),
      maxShippingDate: orderShippingPromise?.shippingDate ?? null,
      shippingPromiseLabel: orderShippingPromise?.shippingPromiseLabel ?? null,
      billingAddressJson: details.invoiceAddress ? JSON.parse(JSON.stringify({
        ...details.invoiceAddress,
        country: details.invoiceCountry,
      })) : null,
      deliveryAddressJson: details.deliveryAddress ? JSON.parse(JSON.stringify({
        ...details.deliveryAddress,
        country: details.deliveryCountry,
        carrier: details.carrier,
      })) : null,
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

  for (const item of importItems) {
    const shopMapping: any = getShopMapping(item);
    const personalizedProduct: any = getPersonalizedProduct(item);
    const shippingPromise = shippingPromisesByItemId.get(item.id);
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
        unitPriceTaxIncl: decimalOrNull(item.unit_price_tax_incl),
        unitPriceTaxExcl: decimalOrNull(item.unit_price_tax_excl ?? item.product_price),
        totalPriceTaxIncl: decimalOrNull(item.total_price_tax_incl),
        totalPriceTaxExcl: decimalOrNull(item.total_price_tax_excl),
        taxRate: decimalOrNull(item.tax_rate),
        taxName: item.tax_name ?? null,
        sourceType: item.sourceType,
        bundleGroupId: item.bundleGroupId ?? null,
        bundleName: item.bundleName ?? null,
        bundleExternalItemId: item.bundleExternalItemId ?? null,
        bundleExternalProductId: item.bundleExternalProductId ?? null,
        shippingDate: shippingPromise?.shippingDate ?? null,
        shippingLeadTimeDays: shippingPromise?.shippingLeadTimeDays ?? null,
        shippingSource: shippingPromise?.shippingSource ?? null,
        personalizedProductId: personalizedProduct?.id ?? null,
        warehouseProductId: shopMapping?.warehouseProductId ?? null,
        payloadJson: item.payload ? JSON.parse(JSON.stringify(item.payload)) : null,
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

  if (options.reserveStock && isStockReservationOrderOperationalStatus(operationalStatus)) {
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

function buildImportItems(details: PrestaShopOrderDetails): OrderImportItem[] {
  const bundleByOrderDetailId = new Map<number, PrestaShopBundleOrderSelection>();
  for (const selection of details.bundleSelections ?? []) {
    bundleByOrderDetailId.set(Number(selection.id_order_detail), selection);
  }

  const items: OrderImportItem[] = [];
  for (const row of details.items) {
    const bundle = bundleByOrderDetailId.get(Number(row.id));
    if (!bundle?.components?.length) {
      items.push({
        id: String(row.id),
        product_id: row.product_id,
        product_reference: row.product_reference,
        product_name: row.product_name,
        quantity: row.quantity,
        product_price: row.product_price,
        unit_price_tax_incl: row.unit_price_tax_incl,
        unit_price_tax_excl: row.unit_price_tax_excl,
        total_price_tax_incl: row.total_price_tax_incl,
        total_price_tax_excl: row.total_price_tax_excl,
        tax_rate: row.tax_rate,
        tax_name: row.tax_name,
        payload: row.payload,
        sourceType: 'SIMPLE',
      });
      continue;
    }

    const bundleGroupId = `ps:${details.order.id}:od:${row.id}`;
    bundle.components.forEach((component, index) => {
      items.push({
        id: `${row.id}:${component.id_product}:${component.id_product_attribute ?? 0}:${index}`,
        product_id: component.id_product,
        product_reference: component.reference || '',
        product_name: component.name || `Produkt #${component.id_product}`,
        quantity: Math.max(1, Number(component.quantity ?? 1)) * Math.max(1, row.quantity),
        payload: {
          bundleParent: row.payload,
          component,
        },
        sourceType: 'BUNDLE_COMPONENT',
        bundleGroupId,
        bundleName: bundle.bundle_name || row.product_name,
        bundleExternalItemId: String(row.id),
        bundleExternalProductId: String(row.product_id),
      });
    });
  }

  return items;
}

async function buildItemShippingPromise(
  context: ShopSyncContext,
  details: PrestaShopOrderDetails,
  shopMapping: any,
): Promise<ShippingPromise | null> {
  if (!shopMapping?.warehouseProductId) return null;

  const decision = await getInventoryPublicationDecision(shopMapping.warehouseProductId);
  if (decision.availabilityPolicy === 'OUT_OF_STOCK') {
    return null;
  }

  const cutoff = normalizeCutoff(context.config);
  const publishedLeadTime = resolveInventoryPublishedLeadTime(decision, context.config);
  const promise = calculateShippingPromise({
    baseDate: new Date(details.order.date_add),
    leadTimeDays: publishedLeadTime.leadTimeDays,
    cutoffHour: cutoff.hour,
    cutoffMinute: cutoff.minute,
    timeZone: context.config.timeZone ?? 'Europe/Warsaw',
    notBefore: decision.warehouseAvailableAt ?? null,
  });

  return {
    ...promise,
    shippingSource: decision.availabilityPolicy === 'BACKORDER_FROM_WHOLESALE'
      ? 'WHOLESALE_BACKORDER'
      : publishedLeadTime.source,
  };
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

function decimalOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
