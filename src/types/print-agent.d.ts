import type { PrintAgentContext } from '../services/print/print-job.service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Ustawiane przez `requirePrintAgent` na trasach `/print-agent/*`. */
    printAgent?: PrintAgentContext;
  }
}
