import { Queue } from 'bullmq';
import { config } from '../../config';
import { createLogger } from '../../lib/logger';

const logger = createLogger('email-queue');

/**
 * Email job data interfaces
 */
export interface PersonalizationEmailJob {
  to: string;
  customerName: string;
  orderReference: string;
  shopName: string;
  items: Array<{
    productName: string;
    quantity: number;
    personalizationUrl: string;
  }>;
  baseUrl: string;
  caseId?: string; // Optional: for tracking
  /**
   * Sklep, w imieniu ktorego wysylamy - decyduje o adresie nadawcy.
   *
   * Bez niego worker uzyje serwisu globalnego, czyli adresu pierwszego
   * lepszego sklepu; klient dostalby maila z obcej domeny.
   */
  shopId?: string;
}

/**
 * Jeden mail na ZAMOWIENIE, nie na sprawe.
 *
 * Tresc przychodzi z automatyzacji (redagowana w panelu), a linki worker
 * zbiera dopiero przy wysylce - dzieki opoznieniu widzi juz wszystkie
 * pozycje zamowienia.
 */
export interface OrderPersonalizationEmailJob {
  orderId: string;
  shopId?: string;
  to: string;
  subject: string;
  body: string;
  shopName: string;
}

export interface TestEmailJob {
  to: string;
  subject?: string;
  message?: string;
}

/**
 * Powiadomienie dla obslugi: klient poprosil grafika o pomoc.
 *
 * Bez niego zgloszenie ladowalo w bazie i nikt sie o nim nie dowiadywal,
 * a klient widzial w portalu obietnice "grafik wprowadzi zmiany".
 */
export interface HelpRequestEmailJob {
  to: string;
  shopName: string;
  orderReference: string;
  customerName?: string | null;
  productName?: string | null;
  message: string;
  /** Link do sprawy w panelu - obsluga ma trafic prosto do projektu. */
  caseUrl?: string | null;
  helpRequestId: string;
}

/**
 * Mail z PDF-em podgladowym po zatwierdzeniu projektu.
 *
 * Niesie tylko identyfikatory - adresata, nadawce i tresc worker sklada przy
 * wysylce, tak jak przy mailach o personalizacji.
 */
export interface CaseProofEmailJob {
  caseId: string;
  /** Sciezka wzgledna w magazynie; worker dolacza plik z dysku. */
  proofFilePath: string;
}

export type EmailJobData =
  | PersonalizationEmailJob
  | OrderPersonalizationEmailJob
  | TestEmailJob
  | HelpRequestEmailJob
  | CaseProofEmailJob;

/**
 * BullMQ Queue for email sending
 */
export const emailQueue = new Queue<EmailJobData>('email', {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
      age: 24 * 3600, // Keep for 24 hours
    },
    removeOnFail: {
      count: 500, // Keep last 500 failed jobs for debugging
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
});

/**
 * Add personalization email to queue
 */
/**
 * @param options.force wysylka ZLECONA RECZNIE - pomija deduplikacje po sprawie.
 *
 * Staly `jobId` chroni przed drugim mailem, gdy zakolejkowanie zostanie
 * powtorzone automatycznie (ponowiona synchronizacja, retry). Ale BullMQ
 * odrzuca zadanie o istniejacym id TAKZE wtedy, gdy poprzednie jest juz
 * ukonczone - a ukonczone zostaje w kolejce. Bez tej furtki operator klikal
 * "Wyslij ponownie" i nic sie nie dzialo: API zwracalo sukces, a zadanie
 * nigdy nie trafialo do workera.
 */
/**
 * Ile czekamy na pozostale pozycje zamowienia. Import zamowienia zaklada
 * sprawy sekwencyjnie i miesci sie w sekundach; minuta to zapas na wolna
 * synchronizacje, a dla klienta to wciaz "od razu".
 */
const ORDER_EMAIL_DELAY_MS = Number(process.env.ORDER_EMAIL_DELAY_MS) || 60_000;

export async function queuePersonalizationEmail(
  data: PersonalizationEmailJob,
  options: { force?: boolean } = {}
) {
  const jobId = data.caseId
    ? `personalization-${data.caseId}${options.force ? `-${Date.now()}` : ''}`
    : undefined;

  const job = await emailQueue.add('personalization', data, { jobId });

  logger.info({ jobId: job.id, to: data.to }, 'Queued personalization email');
  return job;
}

/**
 * Mail zbiorczy dla zamowienia - z opoznieniem i deduplikacja po zamowieniu.
 *
 * Sprawy powstaja jedna po drugiej, wiec przy pierwszej z nich pozostale
 * jeszcze nie istnieja. Opoznienie daje czas na komplet, a `jobId` po
 * ZAMOWIENIU sprawia, ze kolejne sprawy tego samego zamowienia trafiaja
 * w istniejace zadanie zamiast dokladac wiadomosci.
 */
export async function queueOrderPersonalizationEmail(data: OrderPersonalizationEmailJob) {
  const job = await emailQueue.add('order-personalization', data, {
    jobId: `order-personalization-${data.orderId}`,
    delay: ORDER_EMAIL_DELAY_MS,
  });

  logger.info({ jobId: job.id, to: data.to, orderId: data.orderId }, 'Queued order personalization email');
  return job;
}

/**
 * Powiadomienie o zgloszeniu do grafika.
 *
 * `jobId` po id zgloszenia - ponowne wywolanie tej samej sprawy nie wysle
 * drugiego maila, gdyby zapis i kolejkowanie zostaly kiedys ponowione.
 */
export async function queueHelpRequestEmail(data: HelpRequestEmailJob) {
  const job = await emailQueue.add('help-request', data, {
    jobId: `help-request-${data.helpRequestId}`,
  });

  logger.info({ jobId: job.id, to: data.to }, 'Queued help request email');
  return job;
}

/**
 * Mail z podgladem projektu.
 *
 * `jobId` po sprawie chroni przed dublem, gdy render podgladu zostanie
 * ponowiony. `force` przepuszcza wysylke zlecona recznie z panelu -
 * ukonczone zadanie zostaje w kolejce i bez tego blokowaloby ponowienie.
 */
export async function queueCaseProofEmail(
  caseId: string,
  proofFilePath: string,
  options: { force?: boolean } = {}
) {
  const job = await emailQueue.add(
    'case-proof',
    { caseId, proofFilePath },
    { jobId: `case-proof-${caseId}${options.force ? `-${Date.now()}` : ''}` }
  );

  logger.info({ jobId: job.id, caseId }, 'Queued proof email');
  return job;
}

/**
 * Add test email to queue
 */
export async function queueTestEmail(data: TestEmailJob) {
  const job = await emailQueue.add('test', data);
  
  logger.info({ jobId: job.id, to: data.to }, 'Queued test email');
  return job;
}

/**
 * Close email queue connection
 */
export async function closeEmailQueue() {
  await emailQueue.close();
  logger.info('Queue closed');
}

/**
 * Get email queue instance
 */
export function getEmailQueue() {
  return emailQueue;
}

/**
 * Get email queue stats
 */
export async function getEmailQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    emailQueue.getWaitingCount(),
    emailQueue.getActiveCount(),
    emailQueue.getCompletedCount(),
    emailQueue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
