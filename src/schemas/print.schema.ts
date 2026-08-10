import { z } from 'zod';
import { paginationSchema } from './admin.schema';
import {
  PRINT_AGENT_REPORT_STATUSES,
  PRINT_AGENT_STATUSES,
  PRINT_JOB_STATUSES,
} from '../lib/print-job-statuses';

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * Opcje wydruku wybierane w panelu (jakosc, typ papieru).
 *
 * Wartosci ida na wiersz polecenia `lp` po stronie agenta, wiec ksztalt jest
 * ciasny: krotkie klucze i wartosci bez spacji i znakow powloki. Agent i tak
 * przepuszcza je jeszcze raz przez liste, ktora sam zglosil - to jest druga
 * bariera, nie jedyna.
 */
const optionKey = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const optionValue = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
export const printOptionsSchema = z.record(optionKey, optionValue).refine(
  (value) => Object.keys(value).length <= 8,
  { message: 'Za dużo opcji wydruku' }
);

/** Do wyboru w panelu - lista zgloszona przez agenta, prosto z PPD drukarki. */
const agentChoiceSchema = z.object({
  role: z.string().max(32),
  key: optionKey,
  label: z.string().max(80),
  values: z
    .array(z.object({ value: optionValue, label: z.string().max(120) }))
    .max(60),
});

const agentProfileSchema = z.object({
  name: z.string().min(1).max(64),
  printer: z.string().max(200).optional(),
  media: z.string().max(120).nullish(),
  description: z.string().max(500).nullish(),
  expectSizeMm: z.array(z.number()).length(2).nullish(),
  toleranceMm: z.number().nullish(),
  maxPages: z.number().int().positive().nullish(),
  copies: z.number().int().positive().nullish(),
  enabled: z.boolean().optional(),
  choices: z.array(agentChoiceSchema).max(8).optional(),
  currentOptions: printOptionsSchema.optional(),
});

export const printAgentHelloSchema = z.object({
  agentVersion: z.string().max(40).nullish(),
  hostname: z.string().max(200).nullish(),
  profiles: z.array(agentProfileSchema).max(50).optional(),
  printersOnline: z.array(z.string().max(200)).max(50).optional(),
});

export const printAgentClaimSchema = z.object({
  max: z.coerce.number().int().min(1).max(5).default(1),
  profiles: z.array(z.string().min(1).max(64)).min(1).max(50),
});

export const printAgentReportSchema = z.object({
  claimToken: z.string().min(1),
  status: z.enum(PRINT_AGENT_REPORT_STATUSES),
  cupsJobId: z.string().max(200).nullish(),
  message: z.string().max(2000).nullish(),
  geometry: z
    .object({
      widthMm: z.number().nullish(),
      heightMm: z.number().nullish(),
      pages: z.number().int().nullish(),
    })
    .nullish(),
});

export const printAgentFileParamsSchema = z.object({ id: z.string().min(1) });

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export const createPrintAgentSchema = z.object({
  name: z.string().min(1).max(120),
  // SUPER_ADMIN nie ma tenanta w kontekscie, wiec musi go wskazac jawnie.
  tenantId: z.string().min(1).optional(),
});

export const updatePrintAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(PRINT_AGENT_STATUSES).optional(),
});

export const createPrintJobSchema = z.object({
  assetId: z.string().min(1),
  agentId: z.string().min(1),
  profile: z.string().min(1).max(64),
  copies: z.number().int().min(1).max(50).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  /** Nadpisanie ustawien profilu na to jedno zlecenie. Brak = jak w profilu. */
  options: printOptionsSchema.optional(),
});

export const casePrintSchema = z.object({
  agentId: z.string().min(1),
  profile: z.string().min(1).max(64),
  copies: z.number().int().min(1).max(50).optional(),
  options: printOptionsSchema.optional(),
  scope: z.enum(['combined', 'items', 'selected']),
  assetIds: z.array(z.string().min(1)).max(200).optional(),
});

export const printJobsQuerySchema = paginationSchema.extend({
  status: z.enum(PRINT_JOB_STATUSES).optional(),
  agentId: z.string().optional(),
  caseId: z.string().optional(),
});

export const resolveStaleSchema = z.object({ printed: z.boolean() });

export const printIdParamsSchema = z.object({ id: z.string().min(1) });

export type PrintAgentHelloInput = z.infer<typeof printAgentHelloSchema>;
export type PrintAgentClaimInput = z.infer<typeof printAgentClaimSchema>;
export type PrintAgentReportInput = z.infer<typeof printAgentReportSchema>;
export type CasePrintInput = z.infer<typeof casePrintSchema>;
