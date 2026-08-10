import prisma from '../../lib/prisma';
import { config } from '../../config';
import { createLogger } from '../../lib/logger';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { queueHelpRequestEmail } from '../queue/email.queue';

/**
 * Zgloszenia "Poproscie grafika".
 *
 * Klient opisuje, co poprawic; obsluga widzi to na sprawie i odhacza po
 * wykonaniu. Powiadomienie e-mail jest czescia tej samej operacji - bez
 * niego zgloszenie ladowalo w bazie i nikt sie o nim nie dowiadywal, choc
 * portal obiecywal klientowi, ze grafik wprowadzi zmiany.
 */

const logger = createLogger('case-help-requests');

export const HELP_REQUEST_STATUSES = ['PENDING', 'IN_PROGRESS', 'HANDLED', 'CANCELLED'] as const;
export type HelpRequestStatus = (typeof HELP_REQUEST_STATUSES)[number];

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) throw new Error('Tenant context is required for help requests');
  return tenantId;
}

/**
 * Adres, na ktory idzie powiadomienie.
 *
 * Skrzynka nadawcza sklepu jest tu najlepszym przyblizeniem "obslugi" -
 * to na nia i tak wracaja odpowiedzi klientow. Gdy tenant nie ma wlasnych
 * ustawien, zostaje adres z konfiguracji serwera.
 */
async function resolveNotificationTarget(tenantId: string) {
  const [settings, tenant] = await Promise.all([
    // Konfiguracja ZAPASOWA tenanta (bez sklepu) - powiadomienie dla obslugi
    // nie dotyczy konkretnego sklepu, wiec idzie na adres ogolny.
    prisma.emailSettings.findFirst({
      where: { tenantId, shopId: null },
      select: { fromEmail: true, fromName: true, isActive: true },
    }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);

  const to = (settings?.isActive ? settings.fromEmail : null) || config.smtp.from;
  return { to, shopName: settings?.fromName || tenant?.name || 'Sklep' };
}

interface CreateHelpRequestInput {
  tenantId: string;
  personalizationCaseId: string;
  message: string;
}

export async function createCaseHelpRequest(input: CreateHelpRequestInput) {
  const helpRequest = await prisma.caseHelpRequest.create({
    data: {
      tenantId: input.tenantId,
      personalizationCaseId: input.personalizationCaseId,
      message: input.message,
    },
    select: { id: true, status: true, createdAt: true },
  });

  // Powiadomienie nie moze wywrocic zgloszenia: klient dostal juz
  // potwierdzenie, a rekord jest w bazie i widac go w panelu. Awaria SMTP
  // ma zostac w logach, nie w odpowiedzi HTTP.
  try {
    const personalizationCase = await prisma.personalizationCase.findUnique({
      where: { id: input.personalizationCaseId },
      select: {
        orderItem: {
          select: {
            productNameSnapshot: true,
            order: { select: { orderReference: true, customerName: true } },
          },
        },
      },
    });

    const target = await resolveNotificationTarget(input.tenantId);
    const adminUrl = config.frontend.adminUrl;

    if (target.to) {
      await queueHelpRequestEmail({
        to: target.to,
        shopName: target.shopName,
        orderReference: personalizationCase?.orderItem?.order?.orderReference || '—',
        customerName: personalizationCase?.orderItem?.order?.customerName ?? null,
        productName: personalizationCase?.orderItem?.productNameSnapshot ?? null,
        message: input.message,
        caseUrl: adminUrl ? `${adminUrl}/cases/${input.personalizationCaseId}` : null,
        helpRequestId: helpRequest.id,
      });
    } else {
      logger.warn(
        { helpRequestId: helpRequest.id },
        'Brak adresu do powiadomienia o zgloszeniu - zgloszenie widoczne tylko w panelu'
      );
    }
  } catch (error) {
    logger.error({ err: error, helpRequestId: helpRequest.id }, 'Nie udalo sie zakolejkowac powiadomienia');
  }

  return helpRequest;
}

/** Zgloszenia jednej sprawy - najnowsze na gorze. */
export async function listCaseHelpRequests(personalizationCaseId: string) {
  const tenantId = requireTenantId();

  return prisma.caseHelpRequest.findMany({
    where: { tenantId, personalizationCaseId },
    orderBy: { createdAt: 'desc' },
  });
}

/** Ile spraw czeka na reakcje - licznik dla listy spraw i pulpitu. */
export async function countPendingHelpRequests() {
  const tenantId = requireTenantId();

  const rows = await prisma.caseHelpRequest.groupBy({
    by: ['personalizationCaseId'],
    where: { tenantId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    _count: { _all: true },
  });

  return {
    total: rows.reduce((sum, row) => sum + row._count._all, 0),
    caseIds: rows.map((row) => row.personalizationCaseId),
  };
}

export async function updateCaseHelpRequest(
  id: string,
  input: { status?: HelpRequestStatus; responseNote?: string | null }
) {
  const tenantId = requireTenantId();
  const userId = getTenantContext()?.userId ?? null;

  const existing = await prisma.caseHelpRequest.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('Zgłoszenie nie znalezione');

  // Domkniecie zapisuje, KTO i KIEDY - bez tego "obsluzone" nie znaczy nic
  // przy dwóch osobach pracujacych na tej samej skrzynce.
  const closing = input.status === 'HANDLED' || input.status === 'CANCELLED';

  return prisma.caseHelpRequest.update({
    where: { id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.responseNote !== undefined ? { responseNote: input.responseNote } : {}),
      ...(closing ? { handledAt: new Date(), handledByUserId: userId } : {}),
    },
  });
}
