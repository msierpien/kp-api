import prisma from '../../lib/prisma';
import { PrestaShopClient } from '../prestashop/prestashop-client';
import { decrypt } from '../../lib/encryption';

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

    const orders = await client.fetchOrders({
      limit: 100,
      dateFrom,
      currentState: config.orderSync?.orderStatus === 'PAID' ? 2 : undefined, // 2 = Payment accepted
    });

    result.ordersFetched = orders.length;

    // Limit to 3 orders for testing
    const ordersToProcess = orders.slice(0, 3);
    console.log(`Processing ${ordersToProcess.length} orders (limited for testing)`);

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
      }
    }

    // 5. Process each order
    for (const orderData of ordersToProcess) {
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

        // Check if order contains personalized products
        // Match by SKU (reference) - most common case
        const personalizedItems = details.items.filter((item) => {
          const ref = (item.product_reference || '').toLowerCase();
          return productMap.SKU.has(ref);
        });

        if (personalizedItems.length === 0) {
          console.log(`Order ${orderData.id} has no personalized products, skipping`);
          result.ordersSkipped++;
          continue;
        }

        console.log(`Order ${orderData.id} has ${personalizedItems.length} personalized items`);

        // Create order in database
        const order = await prisma.order.create({
          data: {
            shopId: shop.id,
            externalOrderId: String(details.order.id),
            orderReference: details.order.reference,
            customerEmail: details.customer.email,
            customerName: `${details.customer.firstname} ${details.customer.lastname}`,
            language: 'pl',
            currency: 'PLN',
            totalPaid: parseFloat(details.order.total_paid),
            createdAtShop: new Date(details.order.date_add),
            payloadJson: JSON.parse(JSON.stringify(details)),
          },
        });

        result.ordersCreated++;

        // Create order items and personalization cases
        for (const item of personalizedItems) {
          const ref = (item.product_reference || '').toLowerCase();
          const personalizedProduct: any =
            productMap.SKU.get(ref) ||
            productMap.INDEX.get(ref) ||
            productMap.EAN.get(ref);
          if (!personalizedProduct) continue;

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
          const tokenHash = generateAccessToken();

          await prisma.personalizationCase.create({
            data: {
              orderId: order.id,
              orderItemId: orderItem.id,
              templateId: personalizedProduct.templateId,
              templateVersionFrozen: personalizedProduct.template.version,
              status: 'NEW',
              customerTokenHash: tokenHash,
              tokenActive: true,
            },
          });

          result.casesCreated++;
        }

        // TODO: Send email with personalization link
        // await sendPersonalizationEmail(order, cases);

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

function generateAccessToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
