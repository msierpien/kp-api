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

export type EmailJobData = PersonalizationEmailJob | TestEmailJob | HelpRequestEmailJob;

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
