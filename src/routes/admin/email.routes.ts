import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { emailService } from '../../services/email/email.service';
import { queuePersonalizationEmail, queueTestEmail } from '../../services/queue/email.queue';
import prisma from '../../lib/prisma';
import { config } from '../../config';

// Validation schemas
const bulkSendEmailSchema = z.object({
  caseIds: z.array(z.string()).min(1).max(50, 'Maximum 50 cases at once'),
});

const testEmailSchema = z.object({
  to: z.string().email('Invalid email address'),
  subject: z.string().optional(),
  message: z.string().optional(),
});

type BulkSendEmailInput = z.infer<typeof bulkSendEmailSchema>;
type TestEmailInput = z.infer<typeof testEmailSchema>;

export async function emailRoutes(fastify: FastifyInstance) {
  /**
   * POST /admin/email/test
   * Send test email to verify SMTP configuration
   */
  fastify.post<{ Body: TestEmailInput }>(
    '/test',
    async (request: FastifyRequest<{ Body: TestEmailInput }>, reply: FastifyReply) => {
      try {
        const parsed = testEmailSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        // Test connection first
        const connectionTest = await emailService.testConnection();
        if (!connectionTest.success) {
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: `SMTP connection failed: ${connectionTest.message}`,
            connectionTest,
          });
        }

        // Queue test email
        const job = await queueTestEmail(parsed.data);

        return reply.send({
          success: true,
          message: 'Test email queued for sending',
          jobId: job.id,
          connectionTest,
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error.message || 'Failed to send test email',
        });
      }
    }
  );

  /**
   * POST /admin/cases/bulk-send-email
   * Send personalization emails for multiple cases
   */
  fastify.post<{ Body: BulkSendEmailInput }>(
    '/cases/bulk-send-email',
    async (request: FastifyRequest<{ Body: BulkSendEmailInput }>, reply: FastifyReply) => {
      try {
        const parsed = bulkSendEmailSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const { caseIds } = parsed.data;

        // Fetch all cases
        const cases = await prisma.personalizationCase.findMany({
          where: {
            id: { in: caseIds },
          },
          include: {
            order: {
              include: {
                shop: true,
              },
            },
            orderItem: {
              include: {
                personalizedProduct: true,
              },
            },
          },
        });

        if (cases.length === 0) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'No cases found with provided IDs',
          });
        }

        // Check which cases already have emails sent
        const alreadySent = cases.filter(c => c.emailSentAt !== null);
        const toSend = cases.filter(c => c.emailSentAt === null);

        // Queue emails for cases that haven't been sent
        const queued = [];
        for (const caseItem of toSend) {
          try {
            const baseUrl = config.frontend.portalUrl;
            const token = caseItem.customerTokenHash; // Simplified - should regenerate token
            
            await queuePersonalizationEmail({
              to: caseItem.order.customerEmail,
              customerName: caseItem.order.customerName || '',
              orderReference: caseItem.order.orderReference,
              shopName: caseItem.order.shop.name,
              items: [{
                productName: caseItem.orderItem.productNameSnapshot,
                quantity: caseItem.orderItem.quantity,
                personalizationUrl: `${baseUrl}/${token}`,
              }],
              baseUrl,
              caseId: caseItem.id,
            });
            
            queued.push(caseItem.id);
          } catch (error) {
            fastify.log.error(`Failed to queue email for case ${caseItem.id}:`, error);
          }
        }

        return reply.send({
          success: true,
          message: `Queued ${queued.length} emails for sending`,
          summary: {
            requested: caseIds.length,
            found: cases.length,
            alreadySent: alreadySent.length,
            queued: queued.length,
            skipped: caseIds.length - queued.length - alreadySent.length,
          },
          queuedCaseIds: queued,
          alreadySentCaseIds: alreadySent.map(c => c.id),
        });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error.message || 'Failed to queue bulk emails',
        });
      }
    }
  );
}
