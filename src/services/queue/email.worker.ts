import { Worker } from 'bullmq';
import { config } from '../../config';
import { emailService } from '../email/email.service';
import { createShopEmailService } from '../admin/email-settings.service';
import {
  formatLinksForEmail,
  getOrderPersonalizationLinks,
} from '../../lib/case-personalization-links';
import type {
  CaseProofEmailJob,
  EmailJobData,
  HelpRequestEmailJob,
  OrderPersonalizationEmailJob,
  PersonalizationEmailJob,
  TestEmailJob,
} from './email.queue';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { resolveStorageFilePath } from '../storage/local-storage.service';

/**
 * BullMQ Worker for processing email jobs
 */
let emailWorker: Worker<EmailJobData> | null = null;

export function startEmailWorker() {
  if (emailWorker) {
    console.log('[EmailWorker] Worker already running');
    return;
  }

  emailWorker = new Worker<EmailJobData>(
    'email',
    async (job) => {
      const { name, data } = job;

      console.log(`[EmailWorker] Processing ${name} job: ${job.id}`);

      try {
        if (name === 'personalization') {
          return await processPersonalizationEmail(data as PersonalizationEmailJob);
        } else if (name === 'order-personalization') {
          return await processOrderPersonalizationEmail(data as OrderPersonalizationEmailJob);
        } else if (name === 'test') {
          return await processTestEmail(data as TestEmailJob);
        } else if (name === 'help-request') {
          return await processHelpRequestEmail(data as HelpRequestEmailJob);
        } else if (name === 'case-proof') {
          return await processCaseProofEmail(data as CaseProofEmailJob);
        } else {
          throw new Error(`Unknown email job type: ${name}`);
        }
      } catch (error) {
        console.error(`[EmailWorker] Job ${job.id} failed:`, error);
        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
      },
      concurrency: 5, // Process up to 5 emails concurrently
    }
  );

  emailWorker.on('completed', (job) => {
    console.log(`[EmailWorker] ✅ Job ${job.id} completed successfully`);
  });

  emailWorker.on('failed', (job, err) => {
    console.error(`[EmailWorker] ❌ Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
  });

  emailWorker.on('error', (err) => {
    console.error('[EmailWorker] Worker error:', err);
  });

  console.log('[EmailWorker] 📧 Email worker started');
}

export async function stopEmailWorker() {
  if (emailWorker) {
    await emailWorker.close();
    emailWorker = null;
    console.log('[EmailWorker] Worker stopped');
  }
}

/**
 * Jeden mail na zamowienie - z linkami do wszystkich jego spraw.
 *
 * Linki zbieramy DOPIERO TERAZ, a nie przy kolejkowaniu: zadanie czeka
 * minute wlasnie po to, zeby zdazyly powstac pozostale pozycje zamowienia.
 */
async function processOrderPersonalizationEmail(
  data: OrderPersonalizationEmailJob
): Promise<{ success: boolean }> {
  const links = await getOrderPersonalizationLinks(data.orderId, config.frontend.portalUrl);
  if (links.length === 0) {
    throw new Error(`Zamówienie ${data.orderId} nie ma spraw personalizacji`);
  }

  const mailer =
    (data.shopId ? await createShopEmailService(data.shopId).catch(() => null) : null) ?? emailService;
  if (!mailer.isConfigured()) {
    throw new Error('Brak konfiguracji SMTP dla tej wysyłki');
  }

  // Podstawiamy dopiero tutaj, bo dopiero teraz znamy komplet linkow.
  // `personalizationUrl` zostaje dla zgodnosci z trescia napisana pod jeden
  // produkt - dostaje adres pierwszej sprawy.
  const replacements: Record<string, string> = {
    personalizationLinks: formatLinksForEmail(links),
    personalizationUrl: links[0].url,
    productName: links.map((link) => link.productName).join(', '),
    quantity: String(links.reduce((sum, link) => sum + link.quantity, 0)),
  };

  const render = (text: string) =>
    Object.entries(replacements).reduce(
      (acc, [key, value]) => acc.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value),
      text
    );

  const success = await mailer.sendAutomationEmail({
    to: data.to,
    subject: render(data.subject),
    body: render(data.body),
    shopName: data.shopName,
  });

  if (!success) {
    throw new Error(`Nie udało się wysłać wiadomości do ${data.to}`);
  }

  // Znacznik wysylki na każdej sprawie zamowienia - panel pokazuje go przy
  // sprawie, a mail byl jeden na wszystkie.
  await prisma.personalizationCase.updateMany({
    where: { id: { in: links.map((link) => link.caseId) } },
    data: { emailSentAt: new Date(), emailAttempts: { increment: 1 } },
  });

  return { success };
}

/**
 * Mail z PDF-em podgladowym po zatwierdzeniu projektu.
 *
 * Adresata i nadawce czytamy tu, a nie przy kolejkowaniu: zadanie powstaje
 * w workerze renderu, ktory zna tylko sprawe.
 */
async function processCaseProofEmail(data: CaseProofEmailJob): Promise<{ success: boolean }> {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id: data.caseId },
    select: {
      tokenActive: true,
      customerTokenEncrypted: true,
      orderItem: { select: { productNameSnapshot: true } },
      order: {
        select: {
          orderReference: true,
          customerEmail: true,
          customerName: true,
          shopId: true,
          shop: { select: { name: true } },
        },
      },
    },
  });

  if (!caseItem?.order?.customerEmail) {
    throw new Error(`Sprawa ${data.caseId} nie ma adresu e-mail klienta`);
  }

  const shopMailer = caseItem.order.shopId
    ? await createShopEmailService(caseItem.order.shopId).catch((error) => {
        console.warn('[EmailWorker] Nie udalo sie zbudowac nadawcy dla sklepu:', error);
        return null;
      })
    : null;
  const mailer = shopMailer ?? emailService;

  if (!mailer.isConfigured()) {
    throw new Error('Brak konfiguracji SMTP dla tej wysyłki');
  }

  // Link tylko wtedy, gdy token wciaz zyje. Nowego nie wystawiamy - sprawa
  // jest juz zatwierdzona i nie ma powodu otwierac do niej dostepu na nowo.
  let caseUrl: string | null = null;
  if (caseItem.tokenActive && caseItem.customerTokenEncrypted) {
    try {
      caseUrl = `${config.frontend.portalUrl}/${decrypt(caseItem.customerTokenEncrypted)}`;
    } catch {
      caseUrl = null;
    }
  }

  const result = await mailer.sendProofEmail({
    to: caseItem.order.customerEmail,
    customerName: caseItem.order.customerName,
    orderReference: caseItem.order.orderReference || '',
    shopName: caseItem.order.shop?.name || 'Sklep',
    productName: caseItem.orderItem?.productNameSnapshot,
    pdfPath: resolveStorageFilePath(data.proofFilePath),
    caseUrl,
  });

  if (!result.success) {
    throw new Error(`Nie udało się wysłać podglądu do ${caseItem.order.customerEmail}`);
  }

  return { success: true };
}

/**
 * Process personalization email job
 */
async function processPersonalizationEmail(data: PersonalizationEmailJob): Promise<{ success: boolean; messageId?: string }> {
  // Nadawca zalezy od sklepu: kazdy wysyla z wlasnej domeny, inaczej SPF
  // i DKIM nie zgadzaja sie z adresem. Serwis globalny zostaje jako zapas
  // dla zadan bez sklepu (starsze wpisy w kolejce).
  const shopMailer = data.shopId
    ? await createShopEmailService(data.shopId).catch((error) => {
        console.warn('[EmailWorker] Nie udalo sie zbudowac nadawcy dla sklepu:', error);
        return null;
      })
    : null;
  const mailer = shopMailer ?? emailService;

  if (!mailer.isConfigured()) {
    // Rzucamy zamiast zwracac `false`: BullMQ ma to policzyc jako blad
    // i ponowic. Ciche `false` konczylo zadanie jako UDANE, wiec panel
    // pokazywal "wyslane", mimo ze nic nie wyszlo.
    throw new Error('Brak konfiguracji SMTP dla tej wysyłki');
  }

  const success = await mailer.sendPersonalizationEmail({
    to: data.to,
    customerName: data.customerName,
    orderReference: data.orderReference,
    shopName: data.shopName,
    items: data.items,
    baseUrl: data.baseUrl,
  });

  // Update case if caseId provided
  if (data.caseId && success) {
    try {
      await prisma.personalizationCase.update({
        where: { id: data.caseId },
        data: {
          emailSentAt: new Date(),
          emailAttempts: { increment: 1 },
        },
      });
      console.log(`[EmailWorker] Updated case ${data.caseId}: emailSentAt set`);
    } catch (error) {
      console.error(`[EmailWorker] Failed to update case ${data.caseId}:`, error);
    }
  } else if (data.caseId && !success) {
    // Track failed attempt
    try {
      await prisma.personalizationCase.update({
        where: { id: data.caseId },
        data: {
          emailFailedAt: new Date(),
          emailAttempts: { increment: 1 },
          emailError: 'Failed to send email',
        },
      });
    } catch (error) {
      console.error(`[EmailWorker] Failed to update case ${data.caseId}:`, error);
    }
  }

  // Nieudana wysylka konczy zadanie BLEDEM, nie sukcesem: inaczej BullMQ
  // uznaje je za zrobione, nie ponawia, a panel pokazuje "wyslane".
  if (!success) {
    throw new Error(`Nie udało się wysłać wiadomości do ${data.to}`);
  }

  return { success };
}

/**
 * Powiadomienie dla obslugi o zgloszeniu klienta.
 *
 * Tresc idzie prosto z tego, co klient wpisal - obsluga ma wiedziec, co
 * poprawic, bez otwierania panelu. Link do sprawy jest dla tych, ktorzy
 * chca od razu zabrac sie za projekt.
 */
async function processHelpRequestEmail(data: HelpRequestEmailJob): Promise<{ success: boolean }> {
  if (!emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }

  const lines = [
    `Klient prosi o pomoc przy projekcie (zamówienie ${data.orderReference}).`,
    '',
    data.customerName ? `Klient: ${data.customerName}` : null,
    data.productName ? `Produkt: ${data.productName}` : null,
    '',
    'Treść zgłoszenia:',
    data.message,
    '',
    data.caseUrl ? `Sprawa w panelu: ${data.caseUrl}` : null,
  ].filter((line) => line !== null);

  const success = await emailService.sendAutomationEmail({
    to: data.to,
    subject: `Prośba o pomoc grafika — zamówienie ${data.orderReference}`,
    body: lines.join('\n'),
    shopName: data.shopName,
  });

  return { success };
}

/**
 * Process test email job
 */
async function processTestEmail(data: TestEmailJob): Promise<{ success: boolean; messageId?: string }> {
  if (!emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }

  // Send simple test email
  const success = await emailService.sendPersonalizationEmail({
    to: data.to,
    customerName: 'Test User',
    orderReference: 'TEST-' + Date.now(),
    shopName: 'Kreatywne Papierki (TEST)',
    items: [
      {
        productName: 'Test Product - Zaproszenie komunijne',
        quantity: 10,
        personalizationUrl: 'http://localhost:3002/personalize/test-token',
      },
    ],
    baseUrl: config.frontend.portalUrl,
  });

  return { success };
}
