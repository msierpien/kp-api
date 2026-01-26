/// <reference lib="dom" />
import prisma from '../../lib/prisma';
import type { CreateShopInput, UpdateShopInput } from '../../schemas/admin.schema';
import type { ShopItem } from '../../types';

const mapShop = (shop: any): ShopItem => ({
  id: shop.id,
  name: shop.name,
  platform: shop.platform,
  baseUrl: shop.baseUrl,
  status: shop.status,
  lastSyncAt: shop.lastSyncAt,
  apiKey: shop.apiKey,
  apiSecret: shop.apiSecret,
  authType: (shop.configJson as any)?.authType || 'WEB_SERVICE',
  config: (shop.configJson as any) || {
    orderSync: {
      enabled: true,
      intervalMinutes: 10,
      orderStatus: 'PAID',
    },
    adminApi: {
      clientId: null,
      clientSecret: null,
      scopes: [],
    },
  },
});

export async function listShops(): Promise<ShopItem[]> {
  const shops = await prisma.shop.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return shops.map(mapShop);
}

export async function createShop(input: CreateShopInput): Promise<ShopItem> {
  const shop = await prisma.shop.create({
    data: {
      name: input.name,
      platform: input.platform,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey || '',
      apiSecret: input.apiSecret || null,
      status: input.status,
      configJson: {
        ...input.config,
        authType: input.authType,
      },
    },
  });

  return mapShop(shop);
}

export async function updateShop(id: string, input: UpdateShopInput): Promise<ShopItem> {
  const shop = await prisma.shop.update({
    where: { id },
    data: {
      name: input.name,
      platform: input.platform,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey || '',
      apiSecret: input.apiSecret || null,
      status: input.status,
      configJson: {
        ...input.config,
        authType: input.authType,
      },
    },
  });

  return mapShop(shop);
}

export async function testShopConnection(id: string) {
  const shop = await prisma.shop.findUnique({ where: { id } });
  if (!shop) {
    throw new Error('Shop not found');
  }

  const config = (shop.configJson as any) || {};
  const authType = config.authType || 'WEB_SERVICE';
  const started = Date.now();

  // Normalize base URL (avoid double /api when user already provided it)
  let baseUrl = shop.baseUrl.replace(/\/+$/, '');
  if (authType === 'WEB_SERVICE' && baseUrl.endsWith('/api')) {
    baseUrl = baseUrl.replace(/\/api$/, '');
  }

  const allowInsecure =
    process.env.ALLOW_INSECURE_PRESTA === '1' ||
    baseUrl.includes('localhost') ||
    baseUrl.includes('127.0.0.1');
  const shouldDisableTls = allowInsecure && baseUrl.startsWith('https://');
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (shouldDisableTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  try {
    if (authType === 'WEB_SERVICE') {
      const url = `${baseUrl}/api/orders?limit=1&output_format=JSON`;
      const authHeader = 'Basic ' + Buffer.from(`${shop.apiKey || ''}:`).toString('base64');

      // try Authorization header
      let res = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });
      let body = await res.text();

      // fallback: some hosts strip Authorization; try ws_key query param
      if (!res.ok && res.status === 401) {
        const urlWithKey = `${baseUrl}/api/orders?limit=1&output_format=JSON&ws_key=${encodeURIComponent(
          shop.apiKey || ''
        )}`;
        res = await fetch(urlWithKey, { headers: { Accept: 'application/json' } });
        body = await res.text();
      }

      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        message: res.ok
          ? 'Połączenie OK (Webservice)'
          : `Błąd Webservice: ${res.status} ${body?.slice(0, 180)}`,
      };
    }

    // ADMIN_API
    const adminApi = config.adminApi || {};
    const tokenRes = await fetch(`${baseUrl}/admin-api/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: adminApi.clientId || '',
        client_secret: adminApi.clientSecret || '',
        scope: Array.isArray(adminApi.scopes) ? adminApi.scopes.join(' ') : '',
      }),
    });

    if (!tokenRes.ok) {
      return {
        ok: false,
        status: tokenRes.status,
        latencyMs: Date.now() - started,
        message: `Błąd tokenu Admin API: ${tokenRes.status}`,
      };
    }

    const tokenJson = await tokenRes.json();
    const token = tokenJson.access_token as string | undefined;
    if (!token) {
      return {
        ok: false,
        status: 500,
        latencyMs: Date.now() - started,
        message: 'Brak access_token w odpowiedzi',
      };
    }

    const pingRes = await fetch(`${baseUrl}/admin-api/api-client/infos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await pingRes.text();

    return {
      ok: pingRes.ok,
      status: pingRes.status,
      latencyMs: Date.now() - started,
      message: pingRes.ok
        ? 'Połączenie OK (Admin API)'
        : `Błąd Admin API: ${pingRes.status} ${body?.slice(0, 180)}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'Nieznany błąd',
    };
  } finally {
    if (shouldDisableTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
  }
}
