import prisma from '../../lib/prisma';
import { encrypt, decrypt } from '../../lib/encryption';
import { EmailService, emailService } from '../email/email.service';
import type { EmailSettingsInput } from '../../schemas/admin.schema';

/**
 * Pobiera aktywne ustawienia email z bazy
 */
export async function getActiveEmailSettings(tenantId?: string) {
  const settings = await prisma.emailSettings.findFirst({
    where: {
      isActive: true,
      ...(tenantId ? { tenantId } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!settings) {
    return null;
  }

  // Deszyfruj hasło przed zwróceniem
  return {
    ...settings,
    password: decrypt(settings.password),
  };
}

/**
 * Konfiguracja SMTP dla konkretnego sklepu, z zapasem na poziomie tenanta.
 *
 * Kazdy sklep ma wysylac z WLASNEJ domeny - inaczej SPF i DKIM nie zgadzaja
 * sie z adresem nadawcy i poczta laduje w spamie albo wraca. Sklep bez
 * wlasnego wpisu dostaje ustawienie zapasowe tenanta (`shopId` = NULL),
 * zeby brak konfiguracji nie zatrzymywal wysylki.
 */
export async function getEmailSettingsForShop(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { tenantId: true },
  });
  if (!shop) return null;

  const own = await prisma.emailSettings.findFirst({
    where: { shopId, isActive: true },
  });
  const settings =
    own ??
    (await prisma.emailSettings.findFirst({
      where: { tenantId: shop.tenantId, shopId: null, isActive: true },
    }));

  if (!settings) return null;
  return { ...settings, password: decrypt(settings.password), isShopSpecific: Boolean(own) };
}

/**
 * Serwis pocztowy nadajacy z adresu przypisanego do sklepu.
 *
 * Globalny `emailService` trzyma JEDEN transporter na proces, wiec nie da sie
 * nim wyslac raz z jednej, raz z drugiej domeny - stad osobna instancja na
 * czas wysylki.
 */
export async function createShopEmailService(shopId: string) {
  const settings = await getEmailSettingsForShop(shopId);
  if (!settings) return null;

  const service = new EmailService();
  service.initialize({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    pass: settings.password,
    from: settings.fromEmail,
    fromName: settings.fromName,
  });
  return service;
}

/** Zapasowa konfiguracja tenanta - ta bez przypisanego sklepu. */
async function getDefaultEmailSettings() {
  const settings = await prisma.emailSettings.findFirst({
    where: { isActive: true, shopId: null },
    orderBy: { createdAt: 'desc' },
  });
  return settings ? { ...settings, password: decrypt(settings.password) } : null;
}

/**
 * Pobiera wszystkie konfiguracje email (bez haseł)
 */
export async function getAllEmailSettings() {
  const settings = await prisma.emailSettings.findMany({
    orderBy: { createdAt: 'desc' },
  });

  // Nie zwracaj haseł w liście
  return settings.map(s => ({
    ...s,
    password: '***',
  }));
}

/**
 * Pobiera jedną konfigurację email (z hasłem)
 */
export async function getEmailSettingsById(id: string) {
  const settings = await prisma.emailSettings.findUnique({
    where: { id },
  });

  if (!settings) {
    return null;
  }

  // Deszyfruj hasło
  return {
    ...settings,
    password: decrypt(settings.password),
  };
}

/**
 * Tworzy nową konfigurację email
 */
export async function createEmailSettings(data: EmailSettingsInput) {
  // Aktywna moze byc jedna konfiguracja NA ZAKRES: jedna zapasowa tenanta
  // i po jednej na sklep. Dezaktywowanie wszystkich odebraloby drugiemu
  // sklepowi jego wlasny adres nadawcy.
  if (data.isActive) {
    await prisma.emailSettings.updateMany({
      where: { isActive: true, shopId: data.shopId ?? null },
      data: { isActive: false },
    });
  }

  // Zaszyfruj hasło przed zapisem
  const settings = await prisma.emailSettings.create({
    data: {
      ...data,
      password: encrypt(data.password),
      // tenantId will be added automatically by Prisma middleware
    } as any,
  });

  // Jeśli aktywna, załaduj do email service
  if (settings.isActive) {
    await reloadEmailService();
  }

  return {
    ...settings,
    password: '***',
  };
}

/**
 * Aktualizuje konfigurację email
 */
export async function updateEmailSettings(id: string, data: Partial<EmailSettingsInput>) {
  // Aktywna moze byc jedna konfiguracja NA ZAKRES (zapasowa tenanta albo
  // konkretny sklep) - patrz `createEmailSettings`.
  if (data.isActive === true) {
    const current = await prisma.emailSettings.findUnique({
      where: { id },
      select: { shopId: true },
    });
    await prisma.emailSettings.updateMany({
      where: {
        id: { not: id },
        isActive: true,
        shopId: data.shopId !== undefined ? data.shopId ?? null : current?.shopId ?? null,
      },
      data: { isActive: false },
    });
  }

  // Zaszyfruj hasło jeśli zostało podane. Panel przy edycji wysyła puste
  // hasło w znaczeniu "bez zmian", więc musi wypaść z danych do zapisu -
  // inaczej nadpisałoby zaszyfrowane hasło pustym stringiem.
  const updateData: any = { ...data };
  if (data.password) {
    updateData.password = encrypt(data.password);
  } else {
    delete updateData.password;
  }

  const settings = await prisma.emailSettings.update({
    where: { id },
    data: updateData,
  });

  // Jeśli aktywna, przeładuj email service
  if (settings.isActive) {
    await reloadEmailService();
  }

  return {
    ...settings,
    password: '***',
  };
}

/**
 * Usuwa konfigurację email
 */
export async function deleteEmailSettings(id: string) {
  const settings = await prisma.emailSettings.findUnique({
    where: { id },
  });

  if (!settings) {
    throw new Error('Email settings not found');
  }

  await prisma.emailSettings.delete({
    where: { id },
  });

  // Jeśli usunięta była aktywna, przeładuj email service
  if (settings.isActive) {
    await reloadEmailService();
  }

  return { success: true };
}

/**
 * Testuje połączenie SMTP z daną konfiguracją
 */
export async function testEmailSettings(data: EmailSettingsInput) {
  const testService = new (emailService.constructor as any)();
  
  testService.initialize({
    host: data.host,
    port: data.port,
    secure: data.secure,
    user: data.user,
    pass: data.password,
    from: data.fromEmail,
    fromName: data.fromName,
  });

  return await testService.testConnection();
}

/**
 * Przeładowuje email service z aktywnymi ustawieniami z bazy
 */
export async function reloadEmailService() {
  // Globalny serwis obsluguje sciezki bez sklepu w kontekscie (np. wysylka
  // reczna z panelu), wiec bierze konfiguracje ZAPASOWA tenanta. Sklepowe
  // wpisy sa uzywane przez `createShopEmailService` przy konkretnej sprawie.
  const settings =
    (await getDefaultEmailSettings()) ?? (await getActiveEmailSettings());
  
  if (!settings) {
    console.warn('[EmailSettings] No active settings found, email service disabled');
    return;
  }

  emailService.initialize({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    pass: settings.password,
    from: settings.fromEmail,
    fromName: settings.fromName,
  });

  console.log('[EmailSettings] Email service reloaded with active settings');
}

export async function createTenantEmailService(tenantId: string) {
  const settings = await getActiveEmailSettings(tenantId);
  if (!settings) {
    throw new Error('Brak aktywnej konfiguracji SMTP dla tenanta');
  }

  const service = new EmailService();
  service.initialize({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    pass: settings.password,
    from: settings.fromEmail,
    fromName: settings.fromName,
  });
  return service;
}
