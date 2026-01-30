import prisma from '../../lib/prisma';
import { PrestaShopClient } from '../prestashop/prestashop-client';
import { decrypt } from '../../lib/encryption';
import { emailService } from '../email/email.service';
import { generateAccessToken } from '../../lib/token';

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
      },
    });

    if (!shop) {
      throw new Error('Shop not found');
    }

    if (shop.status !== 'ACTIVE') {
      throw new Error('Shop is not active');
    }

    if (shop.personalizedProducts.length === 0) {
      result.errors.push('No personalized products configured');
      await logSync(shopId, 'ORDERS', 'PARTIAL', result, startTime);
      return result;
    }

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
    console.log(`[Sync] Fetched ${orders.length} orders from PrestaShop (limit: ${syncLimit})`);

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
        console.log(`[Sync] Mapped ${type}: "${pp.identifierValue}" → Product: ${pp.name}`);
      }
    }

    console.log(`[Sync] Product map built: SKU=${productMap.SKU.size}, INDEX=${productMap.INDEX.size}, EAN=${productMap.EAN.size}`);

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
          result.ordersSkipped++;
          continue;
        }

        // Fetch full order details
        console.log(`Fetching details for order ${orderData.id}...`);
        const details = await client.fetchOrderDetails(orderData.id);
        console.log(`Order ${orderData.id} details fetched successfully`);
        
        // Debug: show all items in order
        console.log(`[Sync] Order ${orderData.id} has ${details.items.length} items:`);
        details.items.forEach((item, idx) => {
          console.log(`  [${idx + 1}] ${item.product_name}`);
          console.log(`      product_reference: "${item.product_reference}"`);
          console.log(`      product_id: ${item.product_id}`);
          console.log(`      quantity: ${item.quantity}`);
        });

        // Check if order contains personalized products
        // Match product_reference against all identifier types (SKU/INDEX/EAN)
        const personalizedItems = details.items.filter((item) => {
          const ref = (item.product_reference || '').toLowerCase();
          
          const matched = productMap.SKU.has(ref) || 
                         productMap.INDEX.has(ref) || 
                         productMap.EAN.has(ref);
          
          if (matched) {
            console.log(`[Sync] ✓ Matched item: ${item.product_name} (reference: ${ref})`);
          } else {
            console.log(`[Sync] ✗ No match: ${item.product_name} (reference: ${ref})`);
          }
          
          return matched;
        });

        if (personalizedItems.length === 0) {
          console.log(`[Sync] Order ${orderData.id} has no personalized products, skipping`);
          result.ordersSkipped++;
          continue;
        }

        console.log(`Order ${orderData.id} has ${personalizedItems.length} personalized items`);

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

        // Create order items and personalization cases
        for (const item of personalizedItems) {
          const ref = (item.product_reference || '').toLowerCase();
          
          const personalizedProduct: any =
            productMap.SKU.get(ref) ||
            productMap.INDEX.get(ref) ||
            productMap.EAN.get(ref);
          
          if (!personalizedProduct) {
            console.warn(`[Sync] Could not find personalized product mapping for item: ${item.product_name}`);
            continue;
          }

          const orderItem = await prisma.orderItem.create({
            data: {
              orderId: order.id,
              externalItemId: String(item.id),
              sku: item.product_reference,
              productNameSnapshot: item.product_name,
              quantity: item.quantity,
              personalizedProductId: personalizedProduct.id,
            },
          });

          // Create personalization case for this item
          // Generujemy token i hash - token wysyłamy klientowi, hash zapisujemy w bazie
          const { token: customerToken, hash: tokenHash } = generateAccessToken();

          const newCase = await prisma.personalizationCase.create({
            data: {
              orderId: order.id,
              orderItemId: orderItem.id,
              templateId: personalizedProduct.templateId,
              templateVersionFrozen: personalizedProduct.template.version,
              status: 'NEW',
              customerTokenHash: tokenHash, // Zapisujemy HASH w bazie, nie sam token
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
            caseItem: newCase,
          });

          // Dodaj do listy do emaila - używamy oryginalnego tokena, nie hasha
          casesForEmail.push({
            productName: item.product_name,
            quantity: item.quantity,
            token: customerToken, // Oryginalny token dla klienta (nie hash!)
          });
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

            console.log(`[Sync] ✉️  Email sent to ${customerEmail} for order ${details.order.reference}`);
          } catch (emailError) {
            console.error(`[Sync] Failed to send email for order ${details.order.reference}:`, emailError);
            // Nie przerywaj synchronizacji, jeśli email się nie powiódł
          }
        } else if (casesForEmail.length > 0 && !config.smtp.autoSend) {
          console.log(`[Sync] ℹ️  AUTO_SEND_EMAILS=false - email NOT sent for order ${details.order.reference} (${casesForEmail.length} cases created, manual send required)`);
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

