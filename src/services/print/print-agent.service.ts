import prisma from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import { decrypt } from '../../lib/encryption';
import { generateAccessToken, hashToken } from '../../lib/token';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import {
  PRINT_AGENT_POLL_INTERVAL_SEC,
  PRINT_JOB_ACTIVE_STATUSES,
  isPrintAgentOnline,
} from '../../lib/print-job-statuses';

const logger = createLogger('print-agent.service');

/** Ile pierwszych znakow tokenu pokazujemy na liscie agentow. */
const TOKEN_PREFIX_LENGTH = 8;

/**
 * `lastSeenAt` odswiezamy najwyzej raz na te chwile.
 *
 * Agent odpytuje co ~10 s; bez tego progu kazdy cykl generowalby UPDATE na tym
 * samym wierszu, a znacznik i tak sluzy tylko do wskaznika online/offline.
 */
const LAST_SEEN_THROTTLE_MS = 30_000;

export interface AgentProfileInput {
  name: string;
  printer?: string;
  media?: string | null;
  description?: string | null;
  expectSizeMm?: number[] | null;
  toleranceMm?: number | null;
  maxPages?: number | null;
  copies?: number | null;
  enabled?: boolean;
}

export interface AgentHelloInput {
  agentVersion?: string | null;
  hostname?: string | null;
  profiles?: AgentProfileInput[];
  printersOnline?: string[];
}

export async function createPrintAgent(name: string, tenantId: string) {
  const { token, hash, encrypted } = generateAccessToken();

  const agent = await prisma.printAgent.create({
    data: {
      tenantId,
      name,
      tokenHash: hash,
      tokenEncrypted: encrypted,
      tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
    },
  });

  logger.info({ agentId: agent.id, tenantId }, 'Utworzono agenta druku');
  // Plaintext wraca tylko tutaj - dalej zyje juz wylacznie jako hash.
  return { agent, token };
}

export async function rotatePrintAgentToken(agentId: string) {
  const agent = await prisma.printAgent.findFirst({ where: { id: agentId } });
  if (!agent) throw new NotFoundError('Nie ma takiego agenta druku');

  const { token, hash, encrypted } = generateAccessToken();
  const updated = await prisma.printAgent.update({
    where: { id: agent.id },
    data: {
      tokenHash: hash,
      tokenEncrypted: encrypted,
      tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
      tokenRotatedAt: new Date(),
    },
  });

  logger.warn({ agentId: agent.id }, 'Token agenta zrotowany - stary przestal dzialac');
  return { agent: updated, token };
}

export async function revealPrintAgentToken(agentId: string) {
  const agent = await prisma.printAgent.findFirst({ where: { id: agentId } });
  if (!agent) throw new NotFoundError('Nie ma takiego agenta druku');
  if (!agent.tokenEncrypted) {
    throw new ValidationError('Ten agent nie ma zapisanego tokenu - zrotuj go, zeby dostac nowy');
  }
  return { token: decrypt(agent.tokenEncrypted), prefix: agent.tokenPrefix };
}

export async function deletePrintAgent(agentId: string) {
  const agent = await prisma.printAgent.findFirst({ where: { id: agentId } });
  if (!agent) throw new NotFoundError('Nie ma takiego agenta druku');

  const active = await prisma.printJob.count({
    where: { agentId: agent.id, status: { in: [...PRINT_JOB_ACTIVE_STATUSES] } },
  });
  if (active > 0) {
    throw new ConflictError(`Agent ma ${active} zadan w toku - anuluj je albo poczekaj`);
  }

  await prisma.printAgent.delete({ where: { id: agent.id } });
}

/**
 * Rejestracja profili + heartbeat w jednym.
 *
 * Zgloszone profile sa jedynym zrodlem listy dla panelu: dodanie profilu w
 * config.json na Macu wystarcza, zeby pojawil sie w dialogu druku.
 */
export async function handleAgentHello(agentId: string, input: AgentHelloInput, ip?: string) {
  const profiles = (input.profiles ?? []).map((profile) => ({
    name: profile.name,
    printer: profile.printer ?? null,
    media: profile.media ?? null,
    description: profile.description ?? null,
    expectSizeMm: profile.expectSizeMm ?? null,
    toleranceMm: profile.toleranceMm ?? null,
    maxPages: profile.maxPages ?? null,
    copies: profile.copies ?? null,
    enabled: profile.enabled !== false,
  }));

  const agent = await prisma.printAgent.update({
    where: { id: agentId },
    data: {
      profilesJson: profiles,
      printersOnline: input.printersOnline ?? [],
      agentVersion: input.agentVersion ?? null,
      hostname: input.hostname ?? null,
      lastSeenAt: new Date(),
      lastIp: ip ?? null,
    },
  });

  const pendingJobs = await prisma.printJob.count({
    where: {
      tenantId: agent.tenantId,
      status: 'QUEUED',
      OR: [{ agentId: agent.id }, { agentId: null }],
    },
  });

  return {
    agentId: agent.id,
    name: agent.name,
    pollIntervalSec: PRINT_AGENT_POLL_INTERVAL_SEC,
    serverTime: new Date().toISOString(),
    pendingJobs,
  };
}

/** Odswieza znacznik kontaktu, ale tylko gdy zdazyl sie zestarzec. */
export async function touchAgentLastSeen(
  agentId: string,
  lastSeenAt: Date | null,
  ip?: string
): Promise<void> {
  if (lastSeenAt && Date.now() - lastSeenAt.getTime() < LAST_SEEN_THROTTLE_MS) return;
  await prisma.printAgent
    .update({ where: { id: agentId }, data: { lastSeenAt: new Date(), lastIp: ip ?? null } })
    .catch(() => undefined);
}

export async function listPrintAgents() {
  const agents = await prisma.printAgent.findMany({ orderBy: { createdAt: 'asc' } });

  const counts = await prisma.printJob.groupBy({
    by: ['agentId', 'status'],
    _count: { _all: true },
  });

  return agents.map((agent) => {
    const forAgent = counts.filter((row) => row.agentId === agent.id);
    const sumOf = (statuses: string[]) =>
      forAgent
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row._count._all, 0);

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      tokenPrefix: agent.tokenPrefix,
      tokenRotatedAt: agent.tokenRotatedAt,
      agentVersion: agent.agentVersion,
      hostname: agent.hostname,
      lastSeenAt: agent.lastSeenAt,
      online: isPrintAgentOnline(agent.lastSeenAt),
      profiles: (agent.profilesJson || []) as unknown[],
      printersOnline: (agent.printersOnline || []) as unknown[],
      queuedJobs: sumOf([...PRINT_JOB_ACTIVE_STATUSES]),
      failedJobs: sumOf(['FAILED', 'STALE']),
      createdAt: agent.createdAt,
    };
  });
}

export async function updatePrintAgent(
  agentId: string,
  data: { name?: string; status?: string }
) {
  const agent = await prisma.printAgent.findFirst({ where: { id: agentId } });
  if (!agent) throw new NotFoundError('Nie ma takiego agenta druku');
  return prisma.printAgent.update({ where: { id: agent.id }, data });
}
