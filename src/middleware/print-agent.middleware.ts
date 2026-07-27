import { FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../lib/prisma';
import { hashToken } from '../lib/token';
import { touchAgentLastSeen } from '../services/print/print-agent.service';

/**
 * Uwierzytelnia lokalnego agenta druku po tokenie bearer.
 *
 * Trasy agenta celowo stoja poza `/admin`: tamtejszy `requireAdminApiCompatibility`
 * odrzucalby klienta bez naglowkow panelu (426), a RBAC i feature gating dzialaja
 * na JWT uzytkownika, ktorego agent nie ma.
 */
export function requirePrintAgent(options: { touchLastSeen?: boolean } = {}) {
  const { touchLastSeen = true } = options;

  return async function authenticateAgent(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const token = bearer || (request.headers['x-print-agent-token'] as string | undefined);

    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Brak tokenu agenta druku',
      });
    }

    const agent = await prisma.printAgent.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    // Ten sam komunikat co przy braku tokenu - nie zdradzamy, czy agent istnieje.
    if (!agent) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Brak tokenu agenta druku',
      });
    }

    if (agent.status !== 'ACTIVE') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Agent druku jest wylaczony',
      });
    }

    request.printAgent = { id: agent.id, tenantId: agent.tenantId, name: agent.name };

    if (touchLastSeen) {
      await touchAgentLastSeen(agent.id, agent.lastSeenAt, request.ip);
    }
  };
}
