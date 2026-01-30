import prisma from '../../lib/prisma';
import { encrypt, decrypt } from '../../lib/encryption';
import { emailService } from '../email/email.service';
import type { EmailSettingsInput } from '../../schemas/admin.schema';

/**
 * Pobiera aktywne ustawienia email z bazy
 */
export async function getActiveEmailSettings() {
  const settings = await prisma.emailSettings.findFirst({
    where: { isActive: true },
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
  // Jeśli ta konfiguracja ma być aktywna, dezaktywuj wszystkie inne
  if (data.isActive) {
    await prisma.emailSettings.updateMany({
      where: { isActive: true },
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
  // Jeśli ta konfiguracja ma być aktywna, dezaktywuj wszystkie inne
  if (data.isActive === true) {
    await prisma.emailSettings.updateMany({
      where: { 
        id: { not: id },
        isActive: true 
      },
      data: { isActive: false },
    });
  }

  // Zaszyfruj hasło jeśli zostało podane
  const updateData: any = { ...data };
  if (data.password) {
    updateData.password = encrypt(data.password);
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
  });

  return await testService.testConnection();
}

/**
 * Przeładowuje email service z aktywnymi ustawieniami z bazy
 */
export async function reloadEmailService() {
  const settings = await getActiveEmailSettings();
  
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
  });

  console.log('[EmailSettings] Email service reloaded with active settings');
}
