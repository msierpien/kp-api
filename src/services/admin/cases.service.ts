import prisma from '../../lib/prisma';
import { config } from '../../config';
import type { CaseListItem, PaginatedResponse } from '../../types';
import type { CasesQueryInput } from '../../schemas/admin.schema';
import { emailService } from '../email/email.service';
import { queuePersonalizationEmail } from '../queue/email.queue';
import { triggerAutomations, AutomationTrigger } from './automation.service';
import { generateAccessToken, getTokenExpiryDate, maskToken } from '../../lib/token';
import {
  canonicalizeTemplateForms,
  computeCaseAnswerProgress,
  flattenCaseAnswers,
  getFieldScope,
  getStoredAnswerValue,
  hasAnswerValue,
  mergeCaseAnswers,
  normalizeCaseAnswers,
  type PersonalizationAnswerField,
  type StructuredCaseAnswers,
} from '../../lib/personalization-answers';
import { createZipBuffer, type ZipEntry } from '../../lib/zip';
import {
  getCanvasHeightPx as getLayoutCanvasHeightPx,
  getCanvasWidthPx as getLayoutCanvasWidthPx,
  getTemplatePages,
  getTemplatePagesForAnswers,
  normalizeCanvasConfig,
  pxToMm,
  shouldPrintPagesSeparately,
  type TemplateLayoutJson,
  type Layer,
} from '../../types/template-layout';
import {
  renderPreview,
  renderPrintPagePng,
  renderPrintSheetPng,
} from '../renderer/fabric-renderer.service';
import {
  validatePrintPackageAnswers,
  type FieldValidationConfig,
  type PrintPackageValidationSummary,
} from '../renderer/answers-validation.service';
import { getCaseLayout } from '../../lib/case-layout';
import { addPrintPackageJob, type PrintPackageOptions } from '../queue/render.queue';
import { resolvePrintPackageOptions } from './print-settings.service';
import { buildStorageUrl, deleteFile, saveFile } from '../storage/local-storage.service';
import { PRINT_JOB_ACTIVE_STATUSES } from '../../lib/print-job-statuses';
import { isPersonalizationCaseStatus } from '../../lib/personalization-case-statuses';

/** Jeden wyrenderowany arkusz sztuki: cala kartka albo pojedyncza strona. */
interface ItemRender {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  dpi: number;
  /** Nazwa pliku bez rozszerzenia. */
  baseName: string;
  pageId?: string;
  pageNumber?: number;
  pageName?: string;
}

interface RenderedPackageItem {
  itemIndex: number;
  /** Ustawiane tylko gdy strony ida na osobne arkusze. */
  pageId?: string;
  pageNumber?: number;
  pdfAssetId?: string;
  pngAssetId?: string;
  pdfFilePath?: string;
  pngFilePath?: string;
  pdfFileUrl?: string;
  pngFileUrl?: string;
  pdfFileSize?: number;
  pngFileSize?: number;
}

interface GeneratePrintPackageOptions {
  renderJobId?: string;
  bullmqJobId?: string | number;
  mode?: 'SYNC' | 'BULLMQ';
  onProgress?: (progress: number) => Promise<void>;
  /** Opcje z ustawień druku (formaty, zbiorczy PDF, znak wodny). Brak = domyślne. */
  packageOptions?: PrintPackageOptions;
}

/** Pliki paczki do druku - wszystko, co powstaje przy generowaniu. */
const PRINT_PACKAGE_ASSET_TYPES = ['PRINT_PACKAGE_ZIP', 'PDF_PRINT', 'PNG_PRINT'];

export interface DeletePrintAssetsResult {
  deleted: number;
  freedBytes: number;
  skippedActive: number;
}

/**
 * Kasuje pliki paczek do druku razem z plikami na dysku.
 *
 * `createdBefore` ogranicza kasowanie do plikow starszych niz podany moment -
 * tak sprzatamy przy generowaniu nowej paczki. Kryterium jest CZAS, a nie
 * "wszystko poza tym jednym ZIP-em": paczka to nie jeden plik, tylko ZIP plus
 * PDF-y i PNG-y kazdej sztuki, wiec wyjatek na pojedyncze id skasowalby
 * swiezo wyrenderowane pliki.
 *
 * Plik z AKTYWNYM zadaniem druku zostaje nietkniety: `PrintJob` kasuje sie
 * kaskadowo razem z assetem, wiec usuniecie zabraloby agentowi zadanie
 * w trakcie pobierania albo drukowania.
 */
export async function deleteCasePrintAssets(
  caseId: string,
  options: { createdBefore?: Date } = {}
): Promise<DeletePrintAssetsResult> {
  const assets = await prisma.asset.findMany({
    where: {
      caseId,
      assetType: { in: PRINT_PACKAGE_ASSET_TYPES },
      ...(options.createdBefore ? { createdAt: { lt: options.createdBefore } } : {}),
    },
    select: {
      id: true,
      filePath: true,
      fileSize: true,
      printJobs: {
        where: { status: { in: [...PRINT_JOB_ACTIVE_STATUSES] } },
        select: { id: true },
      },
    },
  });

  const removable = assets.filter((asset) => asset.printJobs.length === 0);
  const skippedActive = assets.length - removable.length;
  if (removable.length === 0) return { deleted: 0, freedBytes: 0, skippedActive };

  // Najpierw baza, potem dysk: osierocony plik to strata miejsca, a osierocony
  // wpis w bazie to bledny link w panelu i wywrocony podglad.
  await prisma.asset.deleteMany({ where: { id: { in: removable.map((asset) => asset.id) } } });

  let freedBytes = 0;
  for (const asset of removable) {
    freedBytes += asset.fileSize;
    try {
      await deleteFile(asset.filePath);
    } catch (error) {
      // Brak pliku nie jest bledem - wpis i tak juz zniknal z bazy.
      console.warn(`[Cases] Nie udalo sie skasowac pliku ${asset.filePath}:`, error);
    }
  }

  return { deleted: removable.length, freedBytes, skippedActive };
}

/** Znormalizowane opcje paczki z bezpiecznymi domyślnymi. */
function normalizePrintPackageOptions(input?: PrintPackageOptions) {
  const formats = new Set<'pdf' | 'png'>(
    input?.formats && input.formats.length ? input.formats : ['pdf', 'png']
  );
  const combinedPdf = input?.combinedPdf ?? true;
  const watermarkText = input?.watermarkText?.trim() || null;
  // Korekta pozycji wydruku - kompensuje przesuniecie podajnika drukarki.
  const offsetXMm = Number(input?.printOffsetXMm) || 0;
  const offsetYMm = Number(input?.printOffsetYMm) || 0;

  // Paczka bez zadnego pliku nie ma sensu - wymuszamy sensowne minimum.
  if (!formats.size && !combinedPdf) formats.add('pdf');

  return { formats, combinedPdf, watermarkText, offsetXMm, offsetYMm };
}

type CasesSummary = ReturnType<typeof buildCasesSummary>;
type CasesListResponse = PaginatedResponse<CaseListItem> & {
  summary: CasesSummary;
};

export class CasePackageValidationError extends Error {
  validationSummary: PrintPackageValidationSummary;

  constructor(validationSummary: PrintPackageValidationSummary) {
    super('Case package validation failed');
    this.validationSummary = validationSummary;
  }
}

export async function getCases(query: CasesQueryInput): Promise<CasesListResponse> {
  const { page, limit, status, emailStatus, search, sortBy, sortOrder } = query;
  const skip = (page - 1) * limit;

  const where = buildCasesWhere({ status, emailStatus, search });
  const summaryWhere = buildCasesWhere({ emailStatus, search });

  const orderByMap: Record<string, any> = {
    createdAt: { createdAt: sortOrder },
    submittedAt: { submittedAt: sortOrder },
    status: { status: sortOrder },
    orderReference: { order: { orderReference: sortOrder } },
  };

  const [cases, total, groupedStatuses] = await Promise.all([
    prisma.personalizationCase.findMany({
      where,
      skip,
      take: limit,
      orderBy: orderByMap[sortBy] || { createdAt: 'desc' },
      include: {
        order: {
          select: {
            orderReference: true,
            customerEmail: true,
            customerName: true,
          },
        },
        orderItem: {
          select: {
            productNameSnapshot: true,
            quantity: true,
          },
        },
        // Sam licznik otwartych zgloszen - lista ma pokazac, ze klient czeka
        // na reakcje, bez dociagania tresci kazdego zgloszenia.
        _count: {
          select: {
            helpRequests: { where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } },
          },
        },
        template: {
          select: {
            name: true,
            forms: {
              select: {
                fields: {
                  select: {
                    key: true,
                    required: true,
                    scope: true,
                    repeaterGroupKey: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.personalizationCase.count({ where }),
    prisma.personalizationCase.groupBy({
      by: ['status'],
      where: summaryWhere,
      _count: { _all: true },
    }),
  ]);

  const data: CaseListItem[] = cases.map((c) => {
    const fields = c.template.forms.flatMap((form) => form.fields);
    const answerProgress = computeCaseAnswerProgress(c.answersJson, fields, c.orderItem.quantity);

    return {
      id: c.id,
      status: c.status,
      orderReference: c.order.orderReference,
      customerEmail: c.order.customerEmail,
      customerName: c.order.customerName,
      productName: c.orderItem.productNameSnapshot,
      templateName: c.template.name,
      quantity: c.orderItem.quantity,
      answerProgress,
      filled: answerProgress.filled,
      qty: answerProgress.qty,
      submittedAt: c.submittedAt,
      createdAt: c.createdAt,
      emailSentAt: c.emailSentAt,
      emailFailedAt: c.emailFailedAt,
      emailError: c.emailError,
      emailAttempts: c.emailAttempts,
      openHelpRequests: c._count?.helpRequests ?? 0,
    } as CaseListItem;
  });

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    summary: buildCasesSummary(groupedStatuses),
  };
}

function buildCasesWhere(input: Pick<CasesQueryInput, 'status' | 'emailStatus' | 'search'>) {
  const where: any = {};

  if (input.status) {
    where.status = input.status;
  }

  if (input.emailStatus === 'sent') {
    where.emailSentAt = { not: null };
  } else if (input.emailStatus === 'not_sent') {
    where.emailSentAt = null;
  } else if (input.emailStatus === 'failed') {
    where.emailFailedAt = { not: null };
  }

  if (input.search) {
    where.OR = [
      {
        order: {
          orderReference: { contains: input.search, mode: 'insensitive' },
        },
      },
      {
        order: {
          customerEmail: { contains: input.search, mode: 'insensitive' },
        },
      },
      {
        order: {
          customerName: { contains: input.search, mode: 'insensitive' },
        },
      },
    ];
  }

  return where;
}

function buildCasesSummary(groupedStatuses: Array<{ status: string; _count: { _all: number } }>) {
  const byStatus = groupedStatuses.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = item._count._all;
    return acc;
  }, {});
  const get = (status: string) => byStatus[status] ?? 0;

  return {
    total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
    byStatus,
    waitingForCustomer: get('WAITING_FOR_CUSTOMER'),
    submitted: get('SUBMITTED'),
    readyForPrint: get('READY_FOR_PRINT'),
    failedRender: get('FAILED_RENDER'),
  };
}

export async function getCaseById(id: string) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          shop: true,
        },
      },
      orderItem: {
        include: {
          personalizedProduct: {
            include: {
              template: true,
            },
          },
        },
      },
      template: {
        include: {
          forms: {
            where: { isActive: true },
            include: {
              fields: {
                orderBy: { sortOrder: 'asc' },
              },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
      assets: {
        orderBy: { createdAt: 'desc' },
        take: 25,
      },
      renderJobs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          caseId: true,
          jobType: true,
          status: true,
          attempts: true,
          error: true,
          metadata: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const { renderJobs, ...caseData } = caseItem;
  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const answersJson = normalizeCaseAnswers(caseItem.answersJson, fields, caseItem.orderItem.quantity);
  const answerProgress = computeCaseAnswerProgress(caseItem.answersJson, fields, caseItem.orderItem.quantity);
  const template = {
    ...caseData.template,
    forms: canonicalizeTemplateForms(caseData.template.forms),
  };

  // Konwersja Decimal na number dla frontendowych operacji
  return {
    ...caseData,
    template,
    answersJson,
    answerProgress,
    filled: answerProgress.filled,
    qty: answerProgress.qty,
    latestRenderJob: renderJobs[0] ?? null,
    assets: caseItem.assets.map((asset) => ({
      ...asset,
      fileUrl: buildStorageUrl(asset.filePath),
    })),
    order: {
      ...caseItem.order,
      totalPaid: caseItem.order.totalPaid.toNumber(),
    },
  };
}

export async function updateCaseAnswers(id: string, payload: { answers?: any; sharedAnswers?: Record<string, any>; items?: Array<Record<string, any>> }) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          shop: true,
        },
      },
      orderItem: true,
      template: {
        include: {
          forms: {
            include: {
              fields: true,
            },
          },
        },
      },
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const updatedAnswers = mergeCaseAnswers(caseItem.answersJson, payload, fields, caseItem.orderItem.quantity);
  const answerProgress = computeCaseAnswerProgress(updatedAnswers, fields, caseItem.orderItem.quantity);
  const hasAnyAnswer =
    Object.values(updatedAnswers.sharedAnswers).some(hasAnswerValue) ||
    updatedAnswers.items.some((item) => Object.values(item).some(hasAnswerValue));

  // Sprawdź czy wszystkie wymagane pola są wypełnione
  const allFieldsFilled =
    hasAnyAnswer &&
    answerProgress.filled >= answerProgress.qty &&
    answerProgress.sharedFilled >= answerProgress.sharedTotal;
  const shouldSubmit = allFieldsFilled && caseItem.status === 'WAITING_FOR_CUSTOMER';

  const updated = await prisma.$transaction(async (tx) => {
    await syncAnswerRows(tx, id, fields, updatedAnswers);

    return tx.personalizationCase.update({
      where: { id },
      data: {
        answersJson: JSON.parse(JSON.stringify(updatedAnswers)),
        validationSummary: JSON.parse(JSON.stringify({ answerProgress })),
        ...(shouldSubmit ? {
          status: 'SUBMITTED',
          submittedAt: new Date()
        } : {}),
        updatedAt: new Date(),
      },
      include: {
        order: {
          include: {
            shop: true,
          },
        },
        orderItem: true,
        template: true,
      },
    });
  });

  // Trigger automation if case was submitted
  if (shouldSubmit) {
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_SUBMITTED,
      caseId: updated.id,
      caseData: updated,
    });
  }

  return getCaseById(updated.id);
}

export async function validateCaseAnswers(id: string, payload: { answers?: any; sharedAnswers?: Record<string, any>; items?: Array<Record<string, any>> }) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      orderItem: true,
      template: {
        include: {
          forms: {
            include: {
              fields: { orderBy: { sortOrder: 'asc' } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const layout = getCaseLayout(caseItem);
  if (!layout) {
    throw new Error('Template layout is required for answer validation');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const qty = Math.max(1, Number(caseItem.orderItem.quantity) || 1);
  const answers = mergeCaseAnswers(caseItem.answersJson, payload, fields, qty);
  const answerProgress = computeCaseAnswerProgress(answers, fields, qty);
  const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty, caseItem.layoutOverrides);

  return {
    answerProgress,
    validationSummary,
  };
}

export async function enqueueCasePrintPackage(id: string, enqueueOptions: { tenantId?: string } = {}) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      order: true,
      orderItem: true,
      template: {
        include: {
          forms: {
            include: {
              fields: { orderBy: { sortOrder: 'asc' } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const layout = getCaseLayout(caseItem);
  if (!layout) {
    throw new Error('Template layout is required for print package rendering');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const qty = Math.max(1, Number(caseItem.orderItem.quantity) || 1);
  const answers = normalizeCaseAnswers(caseItem.answersJson, fields, qty);
  const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty, caseItem.layoutOverrides);

  if (!validationSummary.isValid) {
    await prisma.personalizationCase.update({
      where: { id },
      data: {
        status: 'FAILED_RENDER',
        validationSummary: JSON.parse(JSON.stringify(validationSummary)),
      },
    });
    throw new CasePackageValidationError(validationSummary);
  }

  // Ustawienia druku (formaty, zbiorczy PDF, znak wodny) czytamy tu, bo worker
  // dostaje gotowe opcje w jobie. Admin ma kontekst tenanta w request; publiczny
  // submit podaje tenantId sprawy wprost.
  const packageOptions = await resolvePrintPackageOptions(enqueueOptions.tenantId);

  const renderJob = await prisma.renderJob.create({
    data: {
      caseId: id,
      jobType: 'PDF_PRINT_PACKAGE',
      status: 'PENDING',
      metadata: {
        mode: 'BULLMQ',
        templateId: caseItem.templateId,
        templateVersion: caseItem.templateVersionFrozen,
        quantity: qty,
        packageOptions: JSON.parse(JSON.stringify(packageOptions)),
      },
    },
  });

  try {
    const bullmqJob = await addPrintPackageJob({
      caseId: id,
      renderJobId: renderJob.id,
      answers: {},
      templateName: caseItem.template.name,
      templateVersion: caseItem.templateVersionFrozen,
      layoutConfig: layout,
      layoutOverrides: caseItem.layoutOverrides as any,
      orderId: caseItem.orderId,
      orderReference: caseItem.order.orderReference || undefined,
      productName: caseItem.orderItem.productNameSnapshot,
      packageOptions,
    });

    await prisma.$transaction([
      prisma.renderJob.update({
        where: { id: renderJob.id },
        data: {
          metadata: {
            ...(renderJob.metadata as object || {}),
            bullmqJobId: bullmqJob.id,
          },
        },
      }),
      prisma.personalizationCase.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          validationSummary: JSON.parse(JSON.stringify(validationSummary)),
          updatedAt: new Date(),
        },
      }),
    ]);

    return {
      success: true,
      queued: true,
      status: 'PENDING',
      renderJobId: renderJob.id,
      bullmqJobId: bullmqJob.id,
      validationSummary,
    };
  } catch (error) {
    await prisma.renderJob.update({
      where: { id: renderJob.id },
      data: {
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Unknown queue error',
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

export async function generateCasePrintPackage(id: string, options: GeneratePrintPackageOptions = {}) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      order: true,
      orderItem: true,
      template: {
        include: {
          forms: {
            include: {
              fields: { orderBy: { sortOrder: 'asc' } },
            },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  let renderJob: { id: string; metadata: unknown } | null = null;

  // Znacznik startu: po udanym generowaniu kasujemy pliki STARSZE od niego,
  // czyli poprzednie paczki, nie te wlasnie wyrenderowane.
  const packageStartedAt = new Date();

  try {
    const layout = getCaseLayout(caseItem);

    if (!layout) {
      throw new Error('Template layout is required for print package rendering');
    }

    const fields = caseItem.template.forms.flatMap((form) => form.fields);
    const qty = Math.max(1, Number(caseItem.orderItem.quantity) || 1);
    renderJob = options.renderJobId
      ? await prisma.renderJob.update({
        where: { id: options.renderJobId },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          error: null,
          metadata: {
            mode: options.mode || 'BULLMQ',
            templateId: caseItem.templateId,
            templateVersion: caseItem.templateVersionFrozen,
            quantity: qty,
            bullmqJobId: options.bullmqJobId,
          },
        },
      })
      : await prisma.renderJob.create({
        data: {
          caseId: id,
          jobType: 'PDF_PRINT_PACKAGE',
          status: 'PROCESSING',
          startedAt: new Date(),
          metadata: {
            mode: options.mode || 'SYNC',
            templateId: caseItem.templateId,
            templateVersion: caseItem.templateVersionFrozen,
            quantity: qty,
            bullmqJobId: options.bullmqJobId,
          },
        },
      });

    await options.onProgress?.(10);

    const answers = normalizeCaseAnswers(caseItem.answersJson, fields, qty);
    const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty, caseItem.layoutOverrides);
    await options.onProgress?.(20);

    if (!validationSummary.isValid) {
      await prisma.$transaction([
        prisma.personalizationCase.update({
          where: { id },
          data: {
            status: 'FAILED_RENDER',
            validationSummary: JSON.parse(JSON.stringify(validationSummary)),
          },
        }),
        prisma.renderJob.update({
          where: { id: renderJob.id },
          data: {
            status: 'FAILED',
            error: 'Validation failed for print package',
            completedAt: new Date(),
            metadata: {
              ...(renderJob.metadata as object || {}),
              validationSummary: JSON.parse(JSON.stringify(validationSummary)),
            },
          },
        }),
      ]);
      throw new CasePackageValidationError(validationSummary);
    }

    const printTarget = buildPrintLayout(layout);
    // Szablony wielostronicowe: kazda sztuka to arkusz zlozony ze wszystkich
    // stron (renderPrintSheetPng). buildPrintLayout zna tylko lustro pierwszej
    // strony, wiec paczka mialaby sam przod (np. winietki bez tylu).
    // Ta sciezka nie obsluguje jeszcze spadow (bleed).
    const templatePages = getTemplatePages(layout);
    const isMultiPage = templatePages.length > 1;
    // Strony o roznych wymiarach to osobne kartki (zaproszenie + zwrotka), a nie
    // przod i tyl tej samej. Skladanie ich na wspolny arkusz dawaloby wydruk nie
    // do przyciecia, wiec kazda dostaje wlasny arkusz i wlasny plik.
    // Decyzja idzie po ukladzie podstawowym: warianty roznia sie trescia stron,
    // nie ich formatem.
    const printPagesSeparately = isMultiPage && shouldPrintPagesSeparately(layout);
    const packageEntries: ZipEntry[] = [];
    const renderedItems: RenderedPackageItem[] = [];
    const packageBaseName = sanitizeFilePart(`${caseItem.order.orderReference}-${caseItem.template.code}`) || `case-${id}`;

    const pkg = normalizePrintPackageOptions(options.packageOptions);
    const combinedPages: Array<{ png: Buffer; widthPx: number; heightPx: number; dpi: number }> = [];

    for (let itemIndex = 0; itemIndex < qty; itemIndex += 1) {
      await options.onProgress?.(20 + Math.round((itemIndex / qty) * 60));
      const flatAnswers = flattenCaseAnswers(answers, itemIndex);
      const itemBaseName = `${packageBaseName}-szt-${String(itemIndex + 1).padStart(2, '0')}`;
      const itemRenders: ItemRender[] = [];
      let pngBuffer: Buffer;
      let renderDpi = printTarget.dpi;
      let renderWidthPx = printTarget.widthPx;
      let renderHeightPx = printTarget.heightPx;

      if (printPagesSeparately) {
        // Wariant moze byc inny dla kazdej sztuki - odpowiedzi indywidualne
        // rozjezdzaja sie miedzy pozycjami, wiec strony bierzemy per sztuka.
        const itemPages = getTemplatePagesForAnswers(layout, flatAnswers);

        for (let pageIndex = 0; pageIndex < itemPages.length; pageIndex += 1) {
          const page = itemPages[pageIndex];
          const sheet = await renderPrintPagePng(
            layout,
            page,
            flatAnswers,
            caseItem.layoutOverrides || undefined,
            pkg.watermarkText,
            itemIndex
          );
          itemRenders.push({
            png: sheet.buffer,
            widthPx: sheet.widthPx,
            heightPx: sheet.heightPx,
            dpi: sheet.dpi,
            baseName: `${itemBaseName}-str-${pageIndex + 1}`,
            pageId: page.id,
            pageNumber: pageIndex + 1,
            pageName: page.name,
          });
        }
      } else if (isMultiPage) {
        const sheet = await renderPrintSheetPng(
          layout,
          flatAnswers,
          caseItem.layoutOverrides || undefined,
          pkg.watermarkText,
          itemIndex
        );
        pngBuffer = sheet.buffer;
        renderDpi = sheet.dpi;
        renderWidthPx = sheet.widthPx;
        renderHeightPx = sheet.heightPx;
        itemRenders.push({
          png: pngBuffer,
          widthPx: renderWidthPx,
          heightPx: renderHeightPx,
          dpi: renderDpi,
          baseName: itemBaseName,
        });
      } else {
        const templateData = {
          answers: flatAnswers,
          templateName: caseItem.template.name,
          layoutConfig: printTarget.layout,
          layoutOverrides: caseItem.layoutOverrides || undefined,
          // Bez indeksu druk zignorowalby poprawki zrobione dla tej sztuki.
          itemIndex,
          watermark: pkg.watermarkText
            ? { text: pkg.watermarkText, opacity: 0.18, angle: -30 }
            : undefined,
        };

        pngBuffer = await renderPreview(templateData as any, {
          width: printTarget.widthPx,
          height: printTarget.heightPx,
          scale: 1,
          deviceScaleFactor: 1,
          format: 'png',
          includeWatermark: Boolean(pkg.watermarkText),
        });
        itemRenders.push({
          png: pngBuffer,
          widthPx: renderWidthPx,
          heightPx: renderHeightPx,
          dpi: renderDpi,
          baseName: itemBaseName,
        });
      }

      for (const render of itemRenders) {
        if (pkg.combinedPdf) {
          combinedPages.push({
            png: render.png,
            widthPx: render.widthPx,
            heightPx: render.heightPx,
            dpi: render.dpi,
          });
        }

        const assetMetadata = {
          renderJobId: renderJob.id,
          itemIndex,
          itemNumber: itemIndex + 1,
          ...(render.pageId
            ? { pageId: render.pageId, pageNumber: render.pageNumber, pageName: render.pageName }
            : {}),
          generatedAt: new Date().toISOString(),
          dpi: render.dpi,
          widthPx: render.widthPx,
          heightPx: render.heightPx,
          bleedPx: isMultiPage ? 0 : printTarget.bleedPx,
          bleedMm: isMultiPage ? 0 : printTarget.bleedMm,
          watermark: pkg.watermarkText || undefined,
        };
        const renderedItem: RenderedPackageItem = {
          itemIndex,
          ...(render.pageId ? { pageId: render.pageId, pageNumber: render.pageNumber } : {}),
        };

        if (pkg.formats.has('png')) {
          const savedPng = await saveFile(render.png, {
            orderId: caseItem.orderId,
            templateVersion: caseItem.templateVersionFrozen,
            filename: `${render.baseName}-print`,
            extension: 'png',
          });
          const pngAsset = await prisma.asset.create({
            data: {
              caseId: id,
              assetType: 'PNG_PRINT',
              filePath: savedPng.relativePath,
              fileSize: savedPng.size,
              mimeType: 'image/png',
              metadata: assetMetadata,
            },
          });
          packageEntries.push({ name: `png/${render.baseName}.png`, data: render.png });
          renderedItem.pngAssetId = pngAsset.id;
          renderedItem.pngFilePath = savedPng.relativePath;
          renderedItem.pngFileUrl = savedPng.url;
          renderedItem.pngFileSize = savedPng.size;
        }

        if (pkg.formats.has('pdf')) {
          const pdfBuffer = await pngToPdfBuffer(
            render.png,
            render.widthPx,
            render.heightPx,
            render.dpi,
            pkg.offsetXMm,
            pkg.offsetYMm
          );
          const savedPdf = await saveFile(pdfBuffer, {
            orderId: caseItem.orderId,
            templateVersion: caseItem.templateVersionFrozen,
            filename: `${render.baseName}-print`,
            extension: 'pdf',
          });
          const pdfAsset = await prisma.asset.create({
            data: {
              caseId: id,
              assetType: 'PDF_PRINT',
              filePath: savedPdf.relativePath,
              fileSize: savedPdf.size,
              mimeType: 'application/pdf',
              metadata: assetMetadata,
            },
          });
          packageEntries.push({ name: `pdf/${render.baseName}.pdf`, data: pdfBuffer });
          renderedItem.pdfAssetId = pdfAsset.id;
          renderedItem.pdfFilePath = savedPdf.relativePath;
          renderedItem.pdfFileUrl = savedPdf.url;
          renderedItem.pdfFileSize = savedPdf.size;
        }

        renderedItems.push(renderedItem);
      }
    }

    // Zbiorczy PDF: wszystkie sztuki jako kolejne strony jednego pliku.
    let combinedPdfInfo: { assetId: string; filePath: string; fileUrl: string; fileSize: number } | null = null;
    if (pkg.combinedPdf && combinedPages.length > 0) {
      const combinedBuffer = await pngsToPdfBuffer(combinedPages, pkg.offsetXMm, pkg.offsetYMm);
      const savedCombined = await saveFile(combinedBuffer, {
        orderId: caseItem.orderId,
        templateVersion: caseItem.templateVersionFrozen,
        filename: `${packageBaseName}-komplet`,
        extension: 'pdf',
      });
      const combinedAsset = await prisma.asset.create({
        data: {
          caseId: id,
          assetType: 'PDF_PRINT',
          filePath: savedCombined.relativePath,
          fileSize: savedCombined.size,
          mimeType: 'application/pdf',
          metadata: {
            renderJobId: renderJob.id,
            combined: true,
            pages: combinedPages.length,
            generatedAt: new Date().toISOString(),
            watermark: pkg.watermarkText || undefined,
          },
        },
      });
      packageEntries.push({ name: `${packageBaseName}-komplet.pdf`, data: combinedBuffer });
      combinedPdfInfo = {
        assetId: combinedAsset.id,
        filePath: savedCombined.relativePath,
        fileUrl: savedCombined.url,
        fileSize: savedCombined.size,
      };
    }

    await options.onProgress?.(85);

    const zipBuffer = createZipBuffer(packageEntries);
    const savedZip = await saveFile(zipBuffer, {
      orderId: caseItem.orderId,
      templateVersion: caseItem.templateVersionFrozen,
      filename: `${packageBaseName}-print-package`,
      extension: 'zip',
    });

    const packageAsset = await prisma.asset.create({
      data: {
        caseId: id,
        assetType: 'PRINT_PACKAGE_ZIP',
        filePath: savedZip.relativePath,
        fileSize: savedZip.size,
        mimeType: 'application/zip',
        metadata: JSON.parse(JSON.stringify({
          renderJobId: renderJob.id,
          generatedAt: new Date().toISOString(),
          quantity: qty,
          files: renderedItems,
          dpi: printTarget.dpi,
          widthPx: printTarget.widthPx,
          heightPx: printTarget.heightPx,
          bleedPx: printTarget.bleedPx,
          bleedMm: printTarget.bleedMm,
          packageOptions: {
            formats: [...pkg.formats],
            combinedPdf: pkg.combinedPdf,
            watermarkText: pkg.watermarkText,
          },
          combinedPdf: combinedPdfInfo,
        })),
      },
    });

    await options.onProgress?.(92);

    // Poprzednie paczki i ich pliki - panel pokazuje wylacznie najnowsza, wiec
    // starsze byly niewidoczne i tylko rosly na dysku. Sprzatamy PO zapisaniu
    // nowej, zeby nieudane generowanie nie zabralo sprawie jedynej paczki.
    const cleanup = await deleteCasePrintAssets(id, { createdBefore: packageStartedAt });
    if (cleanup.deleted > 0) {
      console.log(
        `[Cases] Sprzatnieto ${cleanup.deleted} starszych plikow paczki (${Math.round(cleanup.freedBytes / 1024 / 1024)} MB)`
      );
    }

    await prisma.$transaction([
      prisma.personalizationCase.update({
        where: { id },
        data: {
          status: 'READY_FOR_PRINT',
          validationSummary: JSON.parse(JSON.stringify(validationSummary)),
          updatedAt: new Date(),
        },
      }),
      prisma.renderJob.update({
        where: { id: renderJob.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          metadata: {
            ...(renderJob.metadata as object || {}),
            packageAssetId: packageAsset.id,
            quantity: qty,
            fileCount: packageEntries.length,
          },
        },
      }),
    ]);

    await options.onProgress?.(100);

    return {
      success: true,
      renderJobId: renderJob.id,
      packageAssetId: packageAsset.id,
      asset: {
        id: packageAsset.id,
        assetType: packageAsset.assetType,
        filePath: packageAsset.filePath,
        fileUrl: savedZip.url,
        fileSize: packageAsset.fileSize,
        mimeType: packageAsset.mimeType,
      },
      files: renderedItems,
      combinedPdf: combinedPdfInfo,
      validationSummary,
    };
  } catch (error) {
    if (error instanceof CasePackageValidationError) {
      throw error;
    }

    await prisma.personalizationCase.update({
      where: { id },
      data: {
        status: 'FAILED_RENDER',
        validationSummary: {
          isValid: false,
          errors: [{
            field: '_render',
            message: error instanceof Error ? error.message : 'Unknown render error',
            severity: 'error',
          }],
          warnings: [],
        },
      },
    });

    if (renderJob) {
      await prisma.renderJob.update({
        where: { id: renderJob.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown render error',
          completedAt: new Date(),
        },
      });
    }

    throw error;
  }
}

function sanitizeFilePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function getCanvasDpi(layout: TemplateLayoutJson) {
  return Math.max(1, Number(layout.canvas?.dpi || 300));
}

function getBleedPx(layout: TemplateLayoutJson) {
  const normalizedCanvas = normalizeCanvasConfig(layout.canvas);
  return Math.max(0, Math.round(normalizedCanvas.bleed || 0));
}

function buildPrintLayout(layout: TemplateLayoutJson) {
  const normalizedLayout = {
    ...layout,
    canvas: normalizeCanvasConfig(layout.canvas),
  };
  const dpi = getCanvasDpi(normalizedLayout);
  const widthPx = getLayoutCanvasWidthPx(normalizedLayout.canvas);
  const heightPx = getLayoutCanvasHeightPx(normalizedLayout.canvas);
  const bleedPx = getBleedPx(normalizedLayout);

  if (bleedPx <= 0) {
    return {
      layout: normalizedLayout,
      widthPx,
      heightPx,
      dpi,
      bleedPx: 0,
      bleedMm: 0,
    };
  }

  const printWidthPx = widthPx + bleedPx * 2;
  const printHeightPx = heightPx + bleedPx * 2;
  const expandedLayers = normalizedLayout.layers.map((layer) => expandLayerForBleed(layer, widthPx, heightPx, printWidthPx, printHeightPx, bleedPx));

  return {
    layout: {
      ...normalizedLayout,
      canvas: {
        ...normalizedLayout.canvas,
        width: printWidthPx,
        height: printHeightPx,
        unit: 'mm' as const,
        widthMm: pxToMm(printWidthPx, dpi),
        heightMm: pxToMm(printHeightPx, dpi),
        bleed: bleedPx,
        bleedMm: pxToMm(bleedPx, dpi),
      },
      layers: expandedLayers,
    },
    widthPx: printWidthPx,
    heightPx: printHeightPx,
    dpi,
    bleedPx,
    bleedMm: pxToMm(bleedPx, dpi),
  };
}

function expandLayerForBleed(
  layer: Layer,
  trimWidthPx: number,
  trimHeightPx: number,
  printWidthPx: number,
  printHeightPx: number,
  bleedPx: number
): Layer {
  const isFullBackground =
    layer.type === 'background' &&
    Math.abs(layer.x) <= 1 &&
    Math.abs(layer.y) <= 1 &&
    Math.abs(layer.width - trimWidthPx) <= 2 &&
    Math.abs(layer.height - trimHeightPx) <= 2;

  if (isFullBackground) {
    return {
      ...layer,
      x: 0,
      y: 0,
      width: printWidthPx,
      height: printHeightPx,
    };
  }

  return {
    ...layer,
    x: layer.x + bleedPx,
    y: layer.y + bleedPx,
  };
}

/** Jeden wielostronicowy PDF z listy stron PNG (zbiorczy plik paczki). */
async function pngsToPdfBuffer(
  pages: Array<{ png: Buffer; widthPx: number; heightPx: number; dpi: number }>,
  offsetXMm = 0,
  offsetYMm = 0
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 0, autoFirstPage: false });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const page of pages) {
      const widthPt = (page.widthPx / page.dpi) * 72;
      const heightPt = (page.heightPx / page.dpi) * 72;
      doc.addPage({ size: [widthPt, heightPt], margin: 0 });
      // Ta sama korekta co przy plikach per sztuka - zbiorczy PDF tez idzie
      // na te sama drukarke.
      doc.image(page.png, mmToPt(offsetXMm), mmToPt(offsetYMm), {
        width: widthPt,
        height: heightPt,
        fit: [widthPt, heightPt],
      });
    }

    doc.end();
  });
}

/**
 * PNG na strone PDF, z korekta pozycji.
 *
 * Offset przesuwa RYSUNEK wzgledem strony (strona zostaje w swoim rozmiarze),
 * bo kompensujemy mechanike drukarki, a nie zmieniamy formatu arkusza.
 * To, co wyjdzie poza strone, przycina sie samo - przy druku bezramkowym
 * i tak idzie w spad.
 */
async function pngToPdfBuffer(
  pngBuffer: Buffer,
  widthPx: number,
  heightPx: number,
  dpi: number,
  offsetXMm = 0,
  offsetYMm = 0
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const widthPt = (widthPx / dpi) * 72;
  const heightPt = (heightPx / dpi) * 72;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: [widthPt, heightPt],
      margin: 0,
      autoFirstPage: false,
    });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.addPage({ size: [widthPt, heightPt], margin: 0 });
    doc.image(pngBuffer, mmToPt(offsetXMm), mmToPt(offsetYMm), {
      width: widthPt,
      height: heightPt,
      fit: [widthPt, heightPt],
    });
    doc.end();
  });
}

/** Milimetry na punkty PDF (1 pt = 1/72 cala). */
function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

async function syncAnswerRows(
  tx: Pick<typeof prisma, 'personalizationAnswer'>,
  caseId: string,
  fields: PersonalizationAnswerField[] & Array<{ id?: string }>,
  answers: StructuredCaseAnswers
) {
  for (const field of fields) {
    if (!field.id) continue;

    const value = getStoredAnswerValue(field, answers);

    if (!hasAnswerValue(value)) {
      await tx.personalizationAnswer.deleteMany({
        where: {
          caseId,
          fieldId: field.id,
        },
      });
      continue;
    }
    const valueText = typeof value === 'string' ? value : null;
    const valueJson = valueText === null ? JSON.parse(JSON.stringify(value)) : null;

    await tx.personalizationAnswer.upsert({
      where: {
        caseId_fieldId: {
          caseId,
          fieldId: field.id,
        },
      },
      update: {
        valueText,
        valueJson,
      },
      create: {
        caseId,
        fieldId: field.id,
        valueText,
        valueJson,
      },
    });
  }
}

export async function updateCaseStatus(id: string, status: string) {
  if (!isPersonalizationCaseStatus(status)) {
    throw new Error('Invalid status');
  }

  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
    include: {
      order: {
        include: {
          shop: true,
        },
      },
      orderItem: true,
      template: true,
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const oldStatus = caseItem.status;

  const updated = await prisma.personalizationCase.update({
    where: { id },
    data: {
      status,
      updatedAt: new Date(),
    },
    include: {
      order: {
        include: {
          shop: true,
        },
      },
      orderItem: true,
      template: true,
    },
  });

  // Trigger automation for status change
  await triggerAutomations({
    trigger: AutomationTrigger.CASE_STATUS_CHANGED,
    caseId: updated.id,
    caseData: updated,
    previousStatus: oldStatus,
    newStatus: updated.status,
  });

  return updated;
}

export async function addCaseNote(id: string, note: string) {
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const currentNotes = (caseItem.notesInternal || '') as string;
  const timestamp = new Date().toISOString();
  const newNote = `[${timestamp}] ${note}`;
  const updatedNotes = currentNotes ? `${currentNotes}\n${newNote}` : newNote;

  return await prisma.personalizationCase.update({
    where: { id },
    data: {
      notesInternal: updatedNotes,
      updatedAt: new Date(),
    },
  });
}

export async function resendPersonalizationEmail(id: string) {
  // Pobierz pełne dane case'a
  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
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

  if (!caseItem) {
    throw new Error('Case not found');
  }

  if (!emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }

  // Generujemy NOWY token - stary będzie nieaktywny
  // To też zabezpiecza przed wyciekiem poprzedniego tokena
  const { token: newToken, hash: newHash, encrypted: newEncrypted } = generateAccessToken();

  // Aktualizuj hash i zaszyfrowany token w bazie danych
  await prisma.personalizationCase.update({
    where: { id },
    data: {
      customerTokenHash: newHash,
      customerTokenEncrypted: newEncrypted,
      tokenActive: true, // Reaktywuj token jeśli był nieaktywny
      // Nowy link = nowy termin waznosci; stary przestaje istniec razem z hashem.
      customerTokenExpiresAt: getTokenExpiryDate(),
      updatedAt: new Date(),
    },
  });

  const baseUrl = config.frontend.portalUrl;

  // Queue email instead of sending synchronously
  await queuePersonalizationEmail({
    to: caseItem.order.customerEmail,
    customerName: caseItem.order.customerName || '',
    orderReference: caseItem.order.orderReference,
    shopName: caseItem.order.shop.name,
    items: [{
      productName: caseItem.orderItem.productNameSnapshot,
      quantity: caseItem.orderItem.quantity,
      personalizationUrl: `${baseUrl}/${newToken}`, // Używamy oryginalnego tokena, nie hasha
    }],
    baseUrl,
    caseId: id, // Track case ID for update after send
    shopId: caseItem.order.shop.id,
  });

  console.log(`[Cases] 📧 Email queued for ${caseItem.order.customerEmail}, case ${id} (token: ${maskToken(newToken)})`);

  return {
    success: true,
    message: 'Email queued for sending',
    newToken: maskToken(newToken),
  };
}
