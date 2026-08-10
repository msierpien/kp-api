import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import {
  PRINT_JOB_ACTIVE_STATUSES,
  PRINT_JOB_LEASE_MS,
  type PrintAgentReportStatus,
} from '../../lib/print-job-statuses';

const logger = createLogger('print-job.service');

/** Ile kandydatow pobrac na jedno miejsce w claimie - zapas na wyscig z innym agentem. */
const CLAIM_CANDIDATE_FACTOR = 3;

/** Reaper nie ma sensu czesciej niz co pol minuty; wolamy go leniwie z kilku miejsc. */
const REAPER_THROTTLE_MS = 30_000;
let lastReaperRun = 0;

export interface PrintAgentContext {
  id: string;
  tenantId: string;
  name: string;
}

export interface ClaimedJob {
  id: string;
  claimToken: string;
  profile: string;
  copies: number;
  title: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  downloadPath: string;
  expectedPageMm: number[] | null;
  maxPages: number | null;
  /** Wybor z panelu - agent naklada go na opcje profilu. */
  options: Record<string, string> | null;
  claimExpiresAt: Date;
}

function newClaimToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function jobTitle(job: { metadata: unknown; profile: string }): string {
  const meta = (job.metadata || {}) as Record<string, unknown>;
  const parts = [meta.orderReference, meta.productName, meta.fileName].filter(Boolean);
  return parts.length ? parts.join(' · ') : job.profile;
}

/**
 * Odzyskuje zadania po agencie, ktory zamilkl.
 *
 * Rozroznienie CLAIMED/PRINTING jest tu najwazniejsze i celowe:
 * - CLAIMED znaczy, ze nic jeszcze nie poszlo na drukarke, wiec zadanie mozna
 *   bezpiecznie oddac do kolejki;
 * - PRINTING znaczy, ze plik moze juz lezec na papierze. Automatyczne wznowienie
 *   byloby najprostsza droga do podwojnego nakladu, wiec zamiast tego oznaczamy
 *   zadanie jako STALE i zostawiamy decyzje operatorowi.
 */
export async function reclaimStalePrintJobs(tenantId?: string, force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastReaperRun < REAPER_THROTTLE_MS) return 0;
  lastReaperRun = now;

  const expired = { lt: new Date(now) };
  const scope = tenantId ? { tenantId } : {};

  const orphaned = await prisma.printJob.findMany({
    where: { ...scope, status: 'CLAIMED', claimExpiresAt: expired },
    select: { id: true, attempts: true, maxAttempts: true, metadata: true },
  });

  let recovered = 0;
  for (const job of orphaned) {
    const attempts = job.attempts + 1;
    const meta = (job.metadata || {}) as Record<string, unknown>;
    const exhausted = attempts >= job.maxAttempts;

    const { count } = await prisma.printJob.updateMany({
      where: { id: job.id, status: 'CLAIMED' },
      data: {
        status: exhausted ? 'FAILED' : 'QUEUED',
        attempts,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        completedAt: exhausted ? new Date() : null,
        error: exhausted ? 'Agent nie odebral zadania w wyznaczonym czasie' : null,
        metadata: { ...meta, reclaims: Number(meta.reclaims || 0) + 1 },
      },
    });
    recovered += count;
  }

  // Wydruki w toku, ktore stracily kontakt - papier mogl juz wyjechac.
  const { count: stale } = await prisma.printJob.updateMany({
    where: { ...scope, status: 'PRINTING', claimExpiresAt: expired },
    data: {
      status: 'STALE',
      claimToken: null,
      error: 'Agent nie potwierdzil zakonczenia - sprawdz, czy wydruk wyszedl',
    },
  });

  if (recovered || stale) {
    logger.warn({ recovered, stale, tenantId }, 'Odzyskano zawieszone zadania druku');
  }
  return recovered + stale;
}

/**
 * Wydaje agentowi zadania do druku.
 *
 * Sedno: status zmieniamy przez `updateMany` z warunkiem `status: 'QUEUED'`.
 * Postgres blokuje wiersz na czas UPDATE-u, wiec przy dwoch agentach dokladnie
 * jeden dostanie `count === 1`, a drugi `0`. Sam `findMany` + `update` pozwolilby
 * obu wziac to samo zadanie i wydrukowac je dwa razy.
 */
export async function claimPrintJobs(
  agent: PrintAgentContext,
  profiles: string[],
  max: number
): Promise<ClaimedJob[]> {
  await reclaimStalePrintJobs(agent.tenantId);

  if (!profiles.length) return [];
  const limit = Math.min(Math.max(max, 1), 5);

  const candidates = await prisma.printJob.findMany({
    where: {
      tenantId: agent.tenantId,
      status: 'QUEUED',
      profile: { in: profiles },
      OR: [{ agentId: agent.id }, { agentId: null }],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: limit * CLAIM_CANDIDATE_FACTOR,
    include: { asset: true },
  });

  const claimed: ClaimedJob[] = [];

  for (const job of candidates) {
    if (claimed.length >= limit) break;

    const claimToken = newClaimToken();
    const claimExpiresAt = new Date(Date.now() + PRINT_JOB_LEASE_MS);

    const { count } = await prisma.printJob.updateMany({
      where: { id: job.id, status: 'QUEUED', tenantId: agent.tenantId },
      data: {
        status: 'CLAIMED',
        agentId: agent.id,
        claimToken,
        claimedAt: new Date(),
        claimExpiresAt,
        startedAt: job.startedAt ?? new Date(),
      },
    });

    // count === 0 znaczy, ze inny agent byl szybszy - to normalny wyscig, nie blad.
    if (count !== 1) continue;

    const meta = (job.metadata || {}) as Record<string, unknown>;
    claimed.push({
      id: job.id,
      claimToken,
      profile: job.profile,
      copies: job.copies,
      title: jobTitle(job),
      fileName: String(meta.fileName || job.asset.filePath.split('/').pop() || 'wydruk.pdf'),
      fileSize: job.asset.fileSize,
      mimeType: job.asset.mimeType,
      downloadPath: `/print-agent/jobs/${job.id}/file`,
      expectedPageMm: (meta.expectedPageMm as number[]) ?? null,
      maxPages: (meta.maxPages as number) ?? null,
      options: (meta.options as Record<string, string>) ?? null,
      claimExpiresAt,
    });
  }

  if (claimed.length) {
    logger.info({ agentId: agent.id, count: claimed.length }, 'Wydano zadania druku agentowi');
  }
  return claimed;
}

/** Zadanie w kontekscie agenta - sprawdza wlasnosc i wazny claim. */
export async function getAgentJob(agent: PrintAgentContext, jobId: string, claimToken: string) {
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, tenantId: agent.tenantId },
    include: { asset: true },
  });

  if (!job) throw new NotFoundError('Nie ma takiego zadania druku');
  if (job.agentId !== agent.id) throw new ForbiddenError('Zadanie nalezy do innego agenta');
  if (job.status === 'CANCELLED') throw new ConflictError('Zadanie zostalo anulowane');
  if (!job.claimToken || !safeCompare(job.claimToken, claimToken)) {
    throw new ForbiddenError('Nieprawidlowy token zadania');
  }
  return job;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface AgentReport {
  status: PrintAgentReportStatus;
  cupsJobId?: string | null;
  message?: string | null;
  geometry?: Record<string, unknown> | null;
}

/**
 * Przyjmuje raport agenta i przeklada go na status zadania.
 *
 * Raporty sa idempotentne - agent po odzyskaniu sieci moze wyslac ten sam raport
 * drugi raz i nie moze to zepsuc stanu.
 */
export async function reportJobStatus(
  agent: PrintAgentContext,
  jobId: string,
  report: AgentReport
) {
  const job = await prisma.printJob.findFirst({
    where: { id: jobId, tenantId: agent.tenantId },
  });

  if (!job) throw new NotFoundError('Nie ma takiego zadania druku');
  if (job.agentId !== agent.id) throw new ForbiddenError('Zadanie nalezy do innego agenta');
  if (job.status === 'CANCELLED') {
    // Agent ma sie dowiedziec, ze ma skasowac zadanie w CUPS.
    throw new ConflictError('Zadanie zostalo anulowane');
  }

  const meta = (job.metadata || {}) as Record<string, unknown>;
  const now = new Date();
  const nextMeta: Record<string, unknown> = { ...meta };
  if (report.geometry) nextMeta.geometry = report.geometry;
  if (report.message) nextMeta.cupsState = report.message;

  let data: Record<string, unknown>;

  switch (report.status) {
    case 'PRINTING':
      data = {
        status: 'PRINTING',
        cupsJobId: report.cupsJobId ?? job.cupsJobId,
        startedAt: job.startedAt ?? now,
        // Druk moze trwac dlugo (papier podawany recznie), wiec kazdy sygnal
        // zycia przedluza dzierzawe, zeby reaper nie uznal zadania za zgubione.
        claimExpiresAt: new Date(Date.now() + PRINT_JOB_LEASE_MS),
        error: null,
        metadata: nextMeta,
      };
      break;

    case 'DONE':
      data = {
        status: 'DONE',
        completedAt: job.completedAt ?? now,
        cupsJobId: report.cupsJobId ?? job.cupsJobId,
        claimToken: null,
        claimExpiresAt: null,
        error: null,
        metadata: nextMeta,
      };
      break;

    case 'REJECTED':
      // Koniec bez ponawiania: albo plik nie przeszedl walidacji (powtorka dalaby
      // ten sam wynik), albo ktos anulowal wydruk na panelu drukarki.
      nextMeta.rejectedReason = report.message ?? 'Odrzucone przez agenta';
      data = {
        status: 'FAILED',
        completedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        error: report.message ?? 'Plik nie przeszedl walidacji agenta',
        metadata: nextMeta,
      };
      break;

    case 'FAILED':
    default: {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.maxAttempts;
      data = {
        status: exhausted ? 'FAILED' : 'QUEUED',
        attempts,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: exhausted ? now : null,
        error: report.message ?? 'Blad druku po stronie agenta',
        metadata: nextMeta,
      };
      break;
    }
  }

  const updated = await prisma.printJob.update({ where: { id: job.id }, data });

  const pending = await prisma.printJob.count({
    where: {
      tenantId: agent.tenantId,
      status: 'QUEUED',
      OR: [{ agentId: agent.id }, { agentId: null }],
    },
  });

  return { job: updated, more: pending > 0 };
}

export interface CreatePrintJobInput {
  assetId: string;
  agentId: string;
  profile: string;
  copies?: number;
  priority?: number;
  requestedById?: string | null;
  /** Nadpisanie ustawien profilu (jakosc, typ papieru) na to jedno zlecenie. */
  options?: Record<string, string>;
}

/**
 * Tworzy zlecenie druku po walidacji, ze plik, agent i profil do siebie pasuja.
 *
 * Tenant wyliczamy ze sprawy (asset -> case -> order -> shop) i wymagamy zgody
 * z tenantem agenta - inaczej dalo by sie wydrukowac cudzy plik na swojej drukarce.
 */
export async function createPrintJob(input: CreatePrintJobInput) {
  const asset = await prisma.asset.findFirst({
    where: { id: input.assetId },
    include: {
      case: { include: { order: { include: { shop: true } } } },
    },
  });

  if (!asset) throw new NotFoundError('Nie ma takiego pliku');
  if (asset.assetType !== 'PDF_PRINT') {
    throw new ValidationError('Do druku nadaja sie tylko pliki PDF_PRINT');
  }

  const tenantId = asset.case?.order?.shop?.tenantId;
  if (!tenantId) throw new ValidationError('Nie udalo sie ustalic wlasciciela pliku');

  const agent = await prisma.printAgent.findFirst({ where: { id: input.agentId } });
  if (!agent) throw new NotFoundError('Nie ma takiego agenta druku');
  if (agent.tenantId !== tenantId) throw new ForbiddenError('Agent nalezy do innego najemcy');
  if (agent.status !== 'ACTIVE') throw new ValidationError('Agent druku jest wylaczony');

  const profiles = (agent.profilesJson || []) as Array<Record<string, unknown>>;
  const profile = profiles.find((p) => p.name === input.profile);
  if (!profile) {
    throw new ValidationError(`Agent nie zna profilu "${input.profile}"`);
  }
  if (profile.enabled === false) {
    throw new ValidationError(`Profil "${input.profile}" jest wylaczony w konfiguracji agenta`);
  }

  const copies = input.copies ?? 1;
  if (copies < 1 || copies > 50) {
    throw new ValidationError('Naklad musi miescic sie w zakresie 1-50');
  }

  const options = pickKnownOptions(profile, input.options);

  const assetMeta = (asset.metadata || {}) as Record<string, unknown>;

  return prisma.printJob.create({
    data: {
      tenantId,
      assetId: asset.id,
      caseId: asset.caseId,
      agentId: agent.id,
      profile: input.profile,
      copies,
      priority: input.priority ?? 0,
      requestedById: input.requestedById ?? null,
      metadata: {
        fileName: asset.filePath.split('/').pop(),
        fileSize: asset.fileSize,
        orderReference: asset.case?.order?.orderReference ?? null,
        combined: assetMeta.combined === true,
        itemIndex: assetMeta.itemIndex ?? null,
        expectedPageMm: profile.expectSizeMm ?? null,
        maxPages: profile.maxPages ?? null,
        profileSnapshot: { printer: profile.printer ?? null, media: profile.media ?? null },
        // Opcje leza w metadata, a nie w osobnej kolumnie: agent czyta je
        // razem z reszta opisu zadania, a schemat bazy zostaje bez migracji.
        options,
      },
    },
  });
}

/**
 * Opcje wydruku przyciete do tego, co agent zglosil dla danego profilu.
 *
 * Panel wysyla wybor obslugujacego, ale listy pochodza z PPD drukarki, wiec
 * to one rozstrzygaja. Wartosc spoza listy odrzucamy z bledem zamiast po cichu
 * pomijac - inaczej operator zobaczylby "wydrukowano" przy ustawieniu, ktore
 * nigdy nie dojechalo do drukarki.
 */
function pickKnownOptions(
  profile: Record<string, unknown>,
  options: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!options || Object.keys(options).length === 0) return undefined;

  const choices = (profile.choices || []) as Array<{
    key: string;
    values?: Array<{ value: string }>;
  }>;

  const allowed = new Map(
    choices.map((choice) => [choice.key, new Set((choice.values || []).map((v) => v.value))])
  );

  for (const [key, value] of Object.entries(options)) {
    const values = allowed.get(key);
    if (!values) throw new ValidationError(`Drukarka nie zna opcji "${key}"`);
    if (!values.has(value)) throw new ValidationError(`Opcja "${key}" nie przyjmuje wartosci "${value}"`);
  }

  return options;
}

export async function cancelPrintJob(jobId: string) {
  const job = await prisma.printJob.findFirst({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Nie ma takiego zadania druku');

  if (!(PRINT_JOB_ACTIVE_STATUSES as readonly string[]).includes(job.status)) {
    throw new ConflictError(`Zadania w stanie ${job.status} nie da sie juz anulowac`);
  }

  const meta = (job.metadata || {}) as Record<string, unknown>;
  return prisma.printJob.update({
    where: { id: job.id },
    data: {
      status: 'CANCELLED',
      completedAt: new Date(),
      claimToken: null,
      claimExpiresAt: null,
      metadata: { ...meta, cancelRequestedAt: new Date().toISOString() },
    },
  });
}

/** Ponowienie tworzy nowe zadanie - stare zostaje w historii ze swoim bledem. */
export async function retryPrintJob(jobId: string, requestedById?: string | null) {
  const job = await prisma.printJob.findFirst({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Nie ma takiego zadania druku');

  return prisma.printJob.create({
    data: {
      tenantId: job.tenantId,
      assetId: job.assetId,
      caseId: job.caseId,
      agentId: job.agentId,
      profile: job.profile,
      copies: job.copies,
      priority: job.priority,
      requestedById: requestedById ?? job.requestedById,
      metadata: {
        ...((job.metadata || {}) as Record<string, unknown>),
        retryOf: job.id,
      },
    },
  });
}

export interface ListPrintJobsQuery {
  page: number;
  limit: number;
  status?: string;
  agentId?: string;
  caseId?: string;
}

export async function listPrintJobs(query: ListPrintJobsQuery) {
  // Lista jest naturalnym momentem na sprzatniecie zawieszonych zadan - operator
  // ma zobaczyc prawde, a nie zadanie "w druku" po agencie, ktory dawno zamilkl.
  await reclaimStalePrintJobs();

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.caseId ? { caseId: query.caseId } : {}),
  };

  const [total, jobs] = await Promise.all([
    prisma.printJob.count({ where }),
    prisma.printJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        agent: { select: { id: true, name: true } },
        case: {
          select: { id: true, order: { select: { orderReference: true } } },
        },
      },
    }),
  ]);

  return {
    data: jobs.map(toPrintJobDto),
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.ceil(total / query.limit) || 1,
  };
}

export function toPrintJobDto(job: Record<string, any>) {
  const meta = (job.metadata || {}) as Record<string, unknown>;
  return {
    id: job.id,
    status: job.status,
    profile: job.profile,
    copies: job.copies,
    attempts: job.attempts,
    cupsJobId: job.cupsJobId,
    error: job.error,
    caseId: job.caseId,
    assetId: job.assetId,
    agentId: job.agentId,
    agentName: job.agent?.name ?? null,
    orderReference: job.case?.order?.orderReference ?? meta.orderReference ?? null,
    fileName: meta.fileName ?? null,
    printer: (meta.profileSnapshot as Record<string, unknown>)?.printer ?? null,
    media: (meta.profileSnapshot as Record<string, unknown>)?.media ?? null,
    cupsState: meta.cupsState ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * Pliki tej sprawy, ktore nadaja sie do druku.
 *
 * `kind` rozdziela komplet (jeden PDF ze wszystkimi sztukami) od pojedynczych
 * sztuk - dialog druku daje wybrac jedno albo drugie.
 */
export async function listCasePrintAssets(caseId: string) {
  const assets = await prisma.asset.findMany({
    where: { caseId, assetType: 'PDF_PRINT' },
    orderBy: { createdAt: 'asc' },
  });

  const lastJobs = await prisma.printJob.findMany({
    where: { caseId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, assetId: true, status: true, createdAt: true },
  });

  return assets.map((asset) => {
    const meta = (asset.metadata || {}) as Record<string, unknown>;
    const lastJob = lastJobs.find((job) => job.assetId === asset.id);
    return {
      id: asset.id,
      kind: meta.combined === true ? 'combined' : 'item',
      fileName: asset.filePath.split('/').pop(),
      fileSize: asset.fileSize,
      itemIndex: meta.itemIndex ?? null,
      createdAt: asset.createdAt,
      lastPrintJob: lastJob
        ? { id: lastJob.id, status: lastJob.status, createdAt: lastJob.createdAt }
        : null,
    };
  });
}

/** Reczne domkniecie zadania STALE, gdy operator potwierdzi, ze wydruk wyszedl. */
export async function resolveStaleJob(jobId: string, printed: boolean) {
  const job = await prisma.printJob.findFirst({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Nie ma takiego zadania druku');
  if (job.status !== 'STALE') throw new ConflictError('To zadanie nie czeka na potwierdzenie');

  return prisma.printJob.update({
    where: { id: job.id },
    data: {
      status: printed ? 'DONE' : 'FAILED',
      completedAt: new Date(),
      error: printed ? null : 'Operator potwierdzil, ze wydruk nie wyszedl',
    },
  });
}
