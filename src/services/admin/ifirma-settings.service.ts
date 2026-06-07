import prisma from '../../lib/prisma';
import { decrypt, encrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import type { IfirmaSettingsInput } from '../../schemas/admin.schema';

function tenantScopedShopWhere(shopId: string) {
  const tenantId = getTenantId();
  const context = getTenantContext();
  if (!tenantId && context?.role !== 'SUPER_ADMIN') {
    throw new Error('Brak kontekstu tenanta');
  }

  return {
    id: shopId,
    ...(tenantId ? { tenantId } : {}),
  };
}

async function getShop(shopId: string) {
  const shop = await prisma.shop.findFirst({
    where: tenantScopedShopWhere(shopId),
    select: { id: true, tenantId: true, platform: true },
  });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.platform !== 'PRESTASHOP') throw new Error('iFirma jest dostępna tylko dla sklepów PrestaShop');
  return shop;
}

function sanitize(settings: any) {
  if (!settings) {
    return null;
  }

  return {
    ...settings,
    invoiceKey: settings.invoiceKey ? '***' : '',
    hasInvoiceKey: Boolean(settings.invoiceKey),
  };
}

export async function getIfirmaSettings(shopId: string) {
  const shop = await getShop(shopId);
  const settings = await prisma.ifirmaSettings.findUnique({
    where: { shopId: shop.id },
  });

  return sanitize(settings);
}

export async function getDecryptedIfirmaSettings(shopId: string) {
  const shop = await getShop(shopId);
  const settings = await prisma.ifirmaSettings.findUnique({
    where: { shopId: shop.id },
  });
  if (!settings || !settings.isActive) {
    throw new Error('Brak aktywnej konfiguracji iFirma dla sklepu');
  }

  return {
    ...settings,
    invoiceKey: decrypt(settings.invoiceKey),
  };
}

export async function upsertIfirmaSettings(shopId: string, input: IfirmaSettingsInput) {
  const shop = await getShop(shopId);
  const existing = await prisma.ifirmaSettings.findUnique({ where: { shopId: shop.id } });
  const encryptedKey = input.invoiceKey === '***' && existing?.invoiceKey
    ? existing.invoiceKey
    : encrypt(input.invoiceKey);

  const settings = await prisma.ifirmaSettings.upsert({
    where: { shopId: shop.id },
    update: {
      login: input.login,
      invoiceKey: encryptedKey,
      mode: input.mode,
      isActive: input.isActive,
      defaultPaymentMethod: input.defaultPaymentMethod,
      paymentTermDays: input.paymentTermDays,
      numberingSeriesName: input.numberingSeriesName ?? null,
      templateName: input.templateName ?? null,
      issuePlace: input.issuePlace ?? null,
      bankAccountNumber: input.bankAccountNumber ?? null,
      receiverSignatureType: input.receiverSignatureType,
      receiverSignature: input.receiverSignature ?? null,
      issuerSignature: input.issuerSignature ?? null,
      visibleBdo: input.visibleBdo,
      sendEmailAfterIssue: input.sendEmailAfterIssue,
      splitBundleItems: input.splitBundleItems,
    },
    create: {
      tenantId: shop.tenantId,
      shopId: shop.id,
      login: input.login,
      invoiceKey: encryptedKey,
      mode: input.mode,
      isActive: input.isActive,
      defaultPaymentMethod: input.defaultPaymentMethod,
      paymentTermDays: input.paymentTermDays,
      numberingSeriesName: input.numberingSeriesName ?? null,
      templateName: input.templateName ?? null,
      issuePlace: input.issuePlace ?? null,
      bankAccountNumber: input.bankAccountNumber ?? null,
      receiverSignatureType: input.receiverSignatureType,
      receiverSignature: input.receiverSignature ?? null,
      issuerSignature: input.issuerSignature ?? null,
      visibleBdo: input.visibleBdo,
      sendEmailAfterIssue: input.sendEmailAfterIssue,
      splitBundleItems: input.splitBundleItems,
    },
  });

  return sanitize(settings);
}
