import prisma from '../../lib/prisma';
import { PrestaShopClient } from '../prestashop/prestashop-client';
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

export async function syncShopOrders(shopId: string): Promise<SyncResult> {
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
    // 1. Get shop configuration
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

    const personalizationEnabledForTenant = await tenantHasFeature(shop.tenantId, FEATURE_PERSONALIZATION_EDITOR);

    // 2. Initialize PrestaShop client
    const config = (shop.configJson as any) || {};
    const authType = config.authType || 'WEB_SERVICE';

    // Odszyfruj klucze API przed użyciem
    const apiKey = decrypt(shop.apiKey);

    const client = new PrestaShopClient({
      baseUrl: shop.baseUrl,
      apiKey: apiKey,
      authType,
      adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
    });

    // 3. Get orders from last sync or last 7 days
    const dateFrom = shop.lastSyncAt
      ? shop.lastSyncAt.toISOString().split('T')[0]
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get sync limit from config or default to 50
    const syncLimit = config.orderSync?.limit || 50;
    
    const orders = await client.fetchOrders({
      limit: syncLimit,
      dateFrom,
      currentState: config.orderSync?.orderStatus === 'PAID' ? 2 : undefined, // 2 = Payment accepted
    });

    result.ordersFetched = orders.length;
    if (DEBUG_SHOP_SYNC) console.log(`[Sync] Fetched ${orders.length} orders from PrestaShop (limit: ${syncLimit})`);

    // 4. Build product mapping by identifier type
    const productMap = {
      SKU: new Map<string, any>(),      // reference
      INDEX: new Map<string, any>(),    // supplier_reference
      EAN: new Map<string, any>(),      // ean13
    } as const;

    for (const pp of shop.personalizedProducts as any[]) {
      const type = pp.identifierType as keyof typeof productMap;
      if (productMap[type]) {
        productMap[type].set(pp.identifierValue.toLowerCase(), pp);
        if (DEBUG_SHOP_SYNC) console.log(`[Sync] Mapped ${type}: "${pp.identifierValue}" -> Product: ${pp.name}`);
      }
    }

    if (DEBUG_SHOP_SYNC) console.log(`[Sync] Product map built: SKU=${productMap.SKU.size}, INDEX=${productMap.INDEX.size}, EAN=${productMap.EAN.size}`);

    const mappingsByExternalProductId = new Map<string, any>();
    const mappingsBySku = new Map<string, any>();
    for (const mapping of shop.productMappings as any[]) {
      mappingsByExternalProductId.set(String(mapping.externalProductId), mapping);
      if (mapping.externalSku) {
        mappingsBySku.set(mapping.externalSku.trim().toLowerCase(), mapping);
      }
    }
    if (DEBUG_SHOP_SYNC) console.log(`[Sync] Shop mapping map built: externalId=${mappingsByExternalProductId.size}, SKU=${mappingsBySku.size}`);

    // 5. Process each order
    for (const orderData of orders) {
      try {
        // Check if order already exists
        const existingOrder = await prisma.order.findUnique({
          where: {
            shopId_externalOrderId: {
              shopId: shop.id,
              externalOrderId: String(orderData.id),
            },
          },
        });

        if (existingOrder) {
          try {
            await reserveOrder(existingOrder.id);
            if (await shouldAutoCreateWzForTenant(shop.tenantId)) {
              await createWzForOrder(existingOrder.id);
            }
          } catch (reservationError) {
            const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation error';
            result.errors.push(`Order ${orderData.id}: reservation not updated: ${message}`);
          }
          result.ordersSkipped++;
          continue;
        }

        // Fetch full order details
        if (DEBUG_SHOP_SYNC) console.log(`Fetching details for order ${orderData.id}...`);
        const details = await client.fetchOrderDetails(orderData.id);
        if (DEBUG_SHOP_SYNC) console.log(`Order ${orderData.id} details fetched successfully`);
        
        // Debug: show all items in order
        if (DEBUG_SHOP_SYNC) {
          console.log(`[Sync] Order ${orderData.id} has ${details.items.length} items:`);
          details.items.forEach((item, idx) => {
            console.log(`  [${idx + 1}] ${item.product_name}`);
            console.log(`      product_reference: "${item.product_reference}"`);
            console.log(`      product_id: ${item.product_id}`);
            console.log(`      quantity: ${item.quantity}`);
          });
        }

        const getPersonalizedProduct = (item: { product_reference: string }) => {
          const ref = (item.product_reference || '').toLowerCase();
          return productMap.SKU.get(ref) ||
            productMap.INDEX.get(ref) ||
            productMap.EAN.get(ref) ||
            null;
        };

        const getShopMapping = (item: { product_id: number; product_reference: string }) => {
          const byExternalId = mappingsByExternalProductId.get(String(item.product_id));
          if (byExternalId) return byExternalId;

          const ref = (item.product_reference || '').trim().toLowerCase();
          return ref ? mappingsBySku.get(ref) || null : null;
        };

        // Save order items that are either personalized or warehouse-mapped.
        const relevantItems = details.items.filter((item) => {
          const ref = (item.product_reference || '').toLowerCase();
          const personalizedProduct = getPersonalizedProduct(item);
          const shopMapping = getShopMapping(item);
          const isWarehouseMapped = Boolean(shopMapping?.warehouseProductId);
          const isPersonalizationMapped = Boolean(
            personalizationEnabledForTenant &&
            shopMapping?.warehouseProductId &&
            shopMapping?.personalizationEnabled &&
            shopMapping?.personalizationTemplateId
          );

          if (isPersonalizationMapped) {
            if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched personalized mapping item: ${item.product_name} (reference: ${ref})`);
          } else if (personalizationEnabledForTenant && personalizedProduct) {
            if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched personalized item: ${item.product_name} (reference: ${ref})`);
          } else if (isWarehouseMapped) {
            if (DEBUG_SHOP_SYNC) console.log(`[Sync] Matched warehouse item: ${item.product_name} (reference: ${ref})`);
          } else {
            if (DEBUG_SHOP_SYNC) console.log(`[Sync] No match: ${item.product_name} (reference: ${ref})`);
          }

          return isPersonalizationMapped || (personalizationEnabledForTenant && Boolean(personalizedProduct)) || isWarehouseMapped;
        });

        if (relevantItems.length === 0) {
          if (DEBUG_SHOP_SYNC) console.log(`[Sync] Order ${orderData.id} has no personalized or warehouse-mapped products, skipping`);
          result.ordersSkipped++;
          continue;
        }

        if (DEBUG_SHOP_SYNC) console.log(`Order ${orderData.id} has ${relevantItems.length} relevant items`);

        // Validate and normalize customer email (required field in Prisma)
        const customerEmail = details.customer.email?.trim().toLowerCase();
        if (!customerEmail) {
          console.warn(`[Sync] Order ${orderData.id} has no customer email, skipping`);
          result.ordersSkipped++;
          result.errors.push(`Order ${orderData.id}: missing customer email`);
          continue;
        }

        // Create order in database
        const order = await prisma.order.create({
          data: {
            shopId: shop.id,
            externalOrderId: String(details.order.id),
            orderReference: details.order.reference,
            customerEmail: customerEmail,
            customerName: `${details.customer.firstname} ${details.customer.lastname}`.trim(),
            language: 'pl',
            currency: 'PLN',
            totalPaid: parseFloat(details.order.total_paid),
            createdAtShop: new Date(details.order.date_add),
            payloadJson: JSON.parse(JSON.stringify(details)),
          },
        });

        result.ordersCreated++;

        // Zbierz wszystkie przypadki personalizacji dla tego zamówienia
        const casesForEmail: Array<{
          productName: string;
          quantity: number;
          token: string;
        }> = [];

        // Create order items for all relevant items; create personalization cases only where applicable.
        for (const item of relevantItems) {
          const shopMapping: any = getShopMapping(item);
          const personalizedProduct: any = getPersonalizedProduct(item);
          const mappingTemplate = personalizationEnabledForTenant &&
            shopMapping?.warehouseProductId &&
            shopMapping?.personalizationEnabled
              ? shopMapping.personalizationTemplate
              : null;
          const legacyTemplate = personalizationEnabledForTenant ? personalizedProduct?.template : null;
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

          // Create personalization case for this item
          // Generujemy token, hash i zaszyfrowany token
          const { token: customerToken, hash: tokenHash, encrypted: tokenEncrypted } = generateAccessToken();

          const newCase = await prisma.personalizationCase.create({
            data: {
              orderId: order.id,
              orderItemId: orderItem.id,
              templateId: caseTemplate.id,
              templateVersionFrozen: caseTemplate.version,
              status: 'NEW',
              customerTokenHash: tokenHash, // Hash do wyszukiwania
              customerTokenEncrypted: tokenEncrypted, // Zaszyfrowany token do pokazania adminom
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

          // Trigger automation for new case
          const { triggerAutomations, AutomationTrigger } = await import('../admin/automation.service');
          await triggerAutomations({
            trigger: AutomationTrigger.CASE_CREATED,
            caseId: newCase.id,
            caseData: newCase,
          });

          // Dodaj do listy do emaila - używamy oryginalnego tokena, nie hasha
          casesForEmail.push({
            productName: item.product_name,
            quantity: item.quantity,
            token: customerToken, // Oryginalny token dla klienta (nie hash!)
          });
        }

        try {
          const reservationResult = await reserveOrder(order.id);
          if (DEBUG_SHOP_SYNC) {
            console.log(`[Sync] Order ${orderData.id} reservations:`, reservationResult);
          }
        } catch (reservationError) {
          const message = reservationError instanceof Error ? reservationError.message : 'Unknown reservation error';
          result.errors.push(`Order ${orderData.id}: reservation not created: ${message}`);
        }

        if (await shouldAutoCreateWzForTenant(shop.tenantId)) {
          try {
            await createWzForOrder(order.id);
          } catch (warehouseError) {
            const message = warehouseError instanceof Error ? warehouseError.message : 'Unknown warehouse error';
            result.errors.push(`Order ${orderData.id}: WZ not created: ${message}`);
          }
        }

        // Wyślij email z linkami do personalizacji (jeśli AUTO_SEND_EMAILS = true)
        if (casesForEmail.length > 0 && emailService.isConfigured() && config.smtp.autoSend) {
          try {
            const baseUrl = config.frontend.portalUrl;
            
            await emailService.sendPersonalizationEmail({
              to: customerEmail,
              customerName: `${details.customer.firstname} ${details.customer.lastname}`.trim(),
              orderReference: details.order.reference,
              shopName: shop.name,
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
            // Nie przerywaj synchronizacji, jeśli email się nie powiódł
          }
        } else if (casesForEmail.length > 0 && !config.smtp.autoSend) {
          if (DEBUG_SHOP_SYNC) console.log(`[Sync] AUTO_SEND_EMAILS=false - email NOT sent for order ${details.order.reference} (${casesForEmail.length} cases created, manual send required)`);
        } else if (casesForEmail.length > 0) {
          console.warn(`[Sync] ⚠️  Email service not configured, skipping email for order ${details.order.reference}`);
        }

      } catch (error) {
        result.errors.push(
          `Order ${orderData.id}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // 6. Update last sync time
    await prisma.shop.update({
      where: { id: shopId },
      data: { lastSyncAt: new Date() },
    });

    result.success = result.errors.length === 0;

    // 7. Log sync result
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
