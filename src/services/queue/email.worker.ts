import { Worker } from 'bullmq';
import { config } from '../../config';
import { emailService } from '../email/email.service';
import type { EmailJobData, PersonalizationEmailJob, TestEmailJob } from './email.queue';
import prisma from '../../lib/prisma';

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
        } else if (name === 'test') {
          return await processTestEmail(data as TestEmailJob);
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
 * Process personalization email job
 */
async function processPersonalizationEmail(data: PersonalizationEmailJob): Promise<{ success: boolean; messageId?: string }> {
  if (!emailService.isConfigured()) {
    console.warn('[EmailWorker] Email service not configured, skipping send');
    return { success: false };
  }

  const success = await emailService.sendPersonalizationEmail({
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
