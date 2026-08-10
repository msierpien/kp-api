import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import type { PrintPackageOptions } from '../queue/render.queue';

export interface PrintSettingsView {
  formatPdf: boolean;
  formatPng: boolean;
  combinedPdf: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  /** Korekta pozycji wydruku w mm; ujemna przesuwa w lewo / do gory. */
  printOffsetXMm: number;
  printOffsetYMm: number;
}

export interface UpdatePrintSettingsInput {
  formatPdf?: boolean;
  formatPng?: boolean;
  combinedPdf?: boolean;
  watermarkEnabled?: boolean;
  watermarkText?: string;
  printOffsetXMm?: number;
  printOffsetYMm?: number;
}

const defaults: PrintSettingsView = {
  formatPdf: true,
  formatPng: true,
  combinedPdf: true,
  watermarkEnabled: false,
  watermarkText: 'PODGLĄD',
  printOffsetXMm: 0,
  printOffsetYMm: 0,
};

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant context is required for print settings');
  }
  return tenantId;
}

function toView(record: {
  formatPdf: boolean;
  formatPng: boolean;
  combinedPdf: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  printOffsetXMm?: number;
  printOffsetYMm?: number;
} | null): PrintSettingsView {
  if (!record) return { ...defaults };
  return {
    formatPdf: record.formatPdf,
    formatPng: record.formatPng,
    combinedPdf: record.combinedPdf,
    watermarkEnabled: record.watermarkEnabled,
    watermarkText: record.watermarkText,
    printOffsetXMm: record.printOffsetXMm ?? 0,
    printOffsetYMm: record.printOffsetYMm ?? 0,
  };
}

/** Korekta ponad centymetr to niemal na pewno pomylka, nie ustawienie drukarki. */
const MAX_OFFSET_MM = 10;

function clampOffset(value: number | undefined, fallback: number): number {
  const next = value ?? fallback;
  if (!Number.isFinite(next)) return fallback;
  return Math.max(-MAX_OFFSET_MM, Math.min(MAX_OFFSET_MM, Math.round(next * 10) / 10));
}

export async function getPrintSettings(): Promise<PrintSettingsView> {
  const tenantId = requireTenantId();
  const record = await prisma.printSettings.findUnique({ where: { tenantId } });
  return toView(record);
}

export async function updatePrintSettings(input: UpdatePrintSettingsInput): Promise<PrintSettingsView> {
  const tenantId = requireTenantId();

  const current = toView(await prisma.printSettings.findUnique({ where: { tenantId } }));
  const next: PrintSettingsView = {
    formatPdf: input.formatPdf ?? current.formatPdf,
    formatPng: input.formatPng ?? current.formatPng,
    combinedPdf: input.combinedPdf ?? current.combinedPdf,
    watermarkEnabled: input.watermarkEnabled ?? current.watermarkEnabled,
    watermarkText: (input.watermarkText ?? current.watermarkText).trim() || defaults.watermarkText,
    printOffsetXMm: clampOffset(input.printOffsetXMm, current.printOffsetXMm),
    printOffsetYMm: clampOffset(input.printOffsetYMm, current.printOffsetYMm),
  };

  if (!next.formatPdf && !next.formatPng && !next.combinedPdf) {
    throw new Error('Wybierz przynajmniej jeden format wyjściowy (PDF, PNG lub zbiorczy PDF)');
  }

  const record = await prisma.printSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...next },
    update: next,
  });

  return toView(record);
}

/**
 * Ustawienia druku przetłumaczone na opcje joba paczki. Wołane przy zlecaniu
 * (kontekst tenanta jest w request adminowym; worker dostaje gotowe opcje).
 * Publiczny submit nie ma kontekstu tenanta — podaje tenantId sprawy wprost.
 */
export async function resolvePrintPackageOptions(tenantId?: string): Promise<PrintPackageOptions> {
  const settings = tenantId
    ? toView(await prisma.printSettings.findUnique({ where: { tenantId } }))
    : await getPrintSettings();
  const formats: Array<'pdf' | 'png'> = [];
  if (settings.formatPdf) formats.push('pdf');
  if (settings.formatPng) formats.push('png');

  return {
    formats,
    combinedPdf: settings.combinedPdf,
    watermarkText: settings.watermarkEnabled ? settings.watermarkText : null,
    printOffsetXMm: settings.printOffsetXMm,
    printOffsetYMm: settings.printOffsetYMm,
  };
}
