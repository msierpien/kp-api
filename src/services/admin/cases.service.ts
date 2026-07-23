import prisma from '../../lib/prisma';
import { config } from '../../config';
import type { CaseListItem, PaginatedResponse } from '../../types';
import type { CasesQueryInput } from '../../schemas/admin.schema';
import { emailService } from '../email/email.service';
import { queuePersonalizationEmail } from '../queue/email.queue';
import { triggerAutomations, AutomationTrigger } from './automation.service';
import { generateAccessToken, maskToken } from '../../lib/token';
import {
  computeCaseAnswerProgress,
  flattenCaseAnswers,
  getFieldScope,
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
  normalizeCanvasConfig,
  pxToMm,
  type TemplateLayoutJson,
  type Layer,
} from '../../types/template-layout';
import { renderPreview } from '../renderer/fabric-renderer.service';
import { validateAnswers } from '../renderer/text-validator.service';
import { addPrintPackageJob } from '../queue/render.queue';
import { buildStorageUrl, saveFile } from '../storage/local-storage.service';
import { isPersonalizationCaseStatus } from '../../lib/personalization-case-statuses';

type FieldValidationConfig = PersonalizationAnswerField & {
  label: string;
  type: string;
  maxLength?: number | null;
  minLength?: number | null;
  pattern?: string | null;
};

interface PrintPackageFieldIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  itemIndex?: number;
  details?: Record<string, any>;
}

interface PrintPackageValidationSummary {
  isValid: boolean;
  shared: {
    isValid: boolean;
    errors: PrintPackageFieldIssue[];
    warnings: PrintPackageFieldIssue[];
  };
  items: Array<{
    itemIndex: number;
    isValid: boolean;
    errors: PrintPackageFieldIssue[];
    warnings: PrintPackageFieldIssue[];
  }>;
  errors: PrintPackageFieldIssue[];
  warnings: PrintPackageFieldIssue[];
}

interface RenderedPackageItem {
  itemIndex: number;
  pdfAssetId: string;
  pngAssetId: string;
  pdfFilePath: string;
  pngFilePath: string;
  pdfFileUrl: string;
  pngFileUrl: string;
  pdfFileSize: number;
  pngFileSize: number;
}

interface GeneratePrintPackageOptions {
  renderJobId?: string;
  bullmqJobId?: string | number;
  mode?: 'SYNC' | 'BULLMQ';
  onProgress?: (progress: number) => Promise<void>;
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
    },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const answersJson = normalizeCaseAnswers(caseItem.answersJson, fields, caseItem.orderItem.quantity);
  const answerProgress = computeCaseAnswerProgress(caseItem.answersJson, fields, caseItem.orderItem.quantity);

  // Konwersja Decimal na number dla frontendowych operacji
  return {
    ...caseItem,
    answersJson,
    answerProgress,
    filled: answerProgress.filled,
    qty: answerProgress.qty,
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

  return updated;
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

  const layout = caseItem.template.layoutJson as unknown as TemplateLayoutJson | null;
  if (!layout) {
    throw new Error('Template layout is required for answer validation');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const qty = Math.max(1, Number(caseItem.orderItem.quantity) || 1);
  const answers = mergeCaseAnswers(caseItem.answersJson, payload, fields, qty);
  const answerProgress = computeCaseAnswerProgress(answers, fields, qty);
  const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty);

  return {
    answerProgress,
    validationSummary,
  };
}

export async function enqueueCasePrintPackage(id: string) {
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

  const layout = caseItem.template.layoutJson as unknown as TemplateLayoutJson | null;
  if (!layout) {
    throw new Error('Template layout is required for print package rendering');
  }

  const fields = caseItem.template.forms.flatMap((form) => form.fields);
  const qty = Math.max(1, Number(caseItem.orderItem.quantity) || 1);
  const answers = normalizeCaseAnswers(caseItem.answersJson, fields, qty);
  const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty);

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

  try {
    const layout = caseItem.template.layoutJson as unknown as TemplateLayoutJson | null;

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
    const validationSummary = await validatePrintPackageAnswers(answers, fields, layout, qty);
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
    const packageEntries: ZipEntry[] = [];
    const renderedItems: RenderedPackageItem[] = [];
    const packageBaseName = sanitizeFilePart(`${caseItem.order.orderReference}-${caseItem.template.code}`) || `case-${id}`;

    for (let itemIndex = 0; itemIndex < qty; itemIndex += 1) {
      await options.onProgress?.(20 + Math.round((itemIndex / qty) * 60));
      const flatAnswers = flattenCaseAnswers(answers, itemIndex);
      const itemBaseName = `${packageBaseName}-szt-${String(itemIndex + 1).padStart(2, '0')}`;
      const templateData = {
        answers: flatAnswers,
        templateName: caseItem.template.name,
        layoutConfig: printTarget.layout,
        layoutOverrides: caseItem.layoutOverrides || undefined,
      };

      const pngBuffer = await renderPreview(templateData as any, {
        width: printTarget.widthPx,
        height: printTarget.heightPx,
        scale: 1,
        deviceScaleFactor: 1,
        format: 'png',
        includeWatermark: false,
      });
      const pdfBuffer = await pngToPdfBuffer(pngBuffer, printTarget.widthPx, printTarget.heightPx, printTarget.dpi);

      const [savedPng, savedPdf] = await Promise.all([
        saveFile(pngBuffer, {
          orderId: caseItem.orderId,
          templateVersion: caseItem.templateVersionFrozen,
          filename: `${itemBaseName}-print`,
          extension: 'png',
        }),
        saveFile(pdfBuffer, {
          orderId: caseItem.orderId,
          templateVersion: caseItem.templateVersionFrozen,
          filename: `${itemBaseName}-print`,
          extension: 'pdf',
        }),
      ]);

      const [pngAsset, pdfAsset] = await prisma.$transaction([
        prisma.asset.create({
          data: {
            caseId: id,
            assetType: 'PNG_PRINT',
            filePath: savedPng.relativePath,
            fileSize: savedPng.size,
            mimeType: 'image/png',
            metadata: {
              renderJobId: renderJob.id,
              itemIndex,
              itemNumber: itemIndex + 1,
              generatedAt: new Date().toISOString(),
              dpi: printTarget.dpi,
              widthPx: printTarget.widthPx,
              heightPx: printTarget.heightPx,
              bleedPx: printTarget.bleedPx,
              bleedMm: printTarget.bleedMm,
            },
          },
        }),
        prisma.asset.create({
          data: {
            caseId: id,
            assetType: 'PDF_PRINT',
            filePath: savedPdf.relativePath,
            fileSize: savedPdf.size,
            mimeType: 'application/pdf',
            metadata: {
              renderJobId: renderJob.id,
              itemIndex,
              itemNumber: itemIndex + 1,
              generatedAt: new Date().toISOString(),
              dpi: printTarget.dpi,
              widthPx: printTarget.widthPx,
              heightPx: printTarget.heightPx,
              bleedPx: printTarget.bleedPx,
              bleedMm: printTarget.bleedMm,
            },
          },
        }),
      ]);

      packageEntries.push(
        { name: `png/${itemBaseName}.png`, data: pngBuffer },
        { name: `pdf/${itemBaseName}.pdf`, data: pdfBuffer }
      );

      renderedItems.push({
        itemIndex,
        pngAssetId: pngAsset.id,
        pdfAssetId: pdfAsset.id,
        pngFilePath: savedPng.relativePath,
        pdfFilePath: savedPdf.relativePath,
        pngFileUrl: savedPng.url,
        pdfFileUrl: savedPdf.url,
        pngFileSize: savedPng.size,
        pdfFileSize: savedPdf.size,
      });
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
        })),
      },
    });

    await options.onProgress?.(92);

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

function getLayerFieldKey(layer: Layer): string | null {
  if (layer.type !== 'text' && layer.type !== 'textbox') return null;
  const fieldKey = (layer.properties as any)?.fieldKey;
  return typeof fieldKey === 'string' && fieldKey.trim() ? fieldKey : null;
}

function fontSizeToValidatorPx(fontSize: number, fontUnit: unknown, dpi: number) {
  if (fontUnit === 'px') return fontSize;
  return (fontSize / 72) * dpi;
}

function getValidationFields(fields: FieldValidationConfig[], layout: TemplateLayoutJson) {
  const dpi = getCanvasDpi(layout);
  const layerByFieldKey = new Map<string, Layer>();

  for (const layer of layout.layers) {
    if (layer.visible === false) continue;
    const fieldKey = getLayerFieldKey(layer);
    if (fieldKey && !layerByFieldKey.has(fieldKey)) {
      layerByFieldKey.set(fieldKey, layer);
    }
  }

  return fields.map((field) => {
    const layer = layerByFieldKey.get(field.key);
    const props = layer?.properties as any;
    const fontSize = typeof props?.fontSize === 'number'
      ? fontSizeToValidatorPx(props.fontSize, props.fontUnit, dpi)
      : undefined;
    const horizontalPadding = layer?.type === 'textbox' ? Number(props?.padding || 0) * 2 : 0;
    const width = layer ? Math.max(1, Number(layer.width || 0) - horizontalPadding) : undefined;
    const lineHeight = Number(props?.lineHeight || 1.2);
    const maxLines = typeof props?.maxLines === 'number'
      ? props.maxLines
      : layer && fontSize
        ? Math.max(1, Math.floor(Number(layer.height || 0) / Math.max(1, fontSize * lineHeight)))
        : undefined;

    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      maxLength: field.maxLength || undefined,
      minLength: field.minLength || undefined,
      pattern: field.pattern || undefined,
      width,
      maxLines,
      font: props ? {
        family: props.fontFamily || 'Inter',
        size: fontSize,
        weight: Number(props.fontWeight || 400),
      } : undefined,
    };
  });
}

function prefixIssues(
  issues: Array<{ field: string; message: string; severity: 'error' | 'warning'; details?: Record<string, any> }>,
  itemIndex?: number
): PrintPackageFieldIssue[] {
  return issues.map((issue) => ({
    ...issue,
    itemIndex,
    message: itemIndex === undefined ? issue.message : `Sztuka ${itemIndex + 1}: ${issue.message}`,
  }));
}

async function validatePrintPackageAnswers(
  answers: StructuredCaseAnswers,
  fields: FieldValidationConfig[],
  layout: TemplateLayoutJson,
  qty: number
): Promise<PrintPackageValidationSummary> {
  const validationFields = getValidationFields(fields, layout);
  const sharedFields = fields.filter((field) => getFieldScope(field) === 'SHARED');
  const itemFields = fields.filter((field) => getFieldScope(field) === 'INDIVIDUAL');
  const validationFieldByKey = new Map(validationFields.map((field) => [field.key, field]));
  const sharedValidationFields = sharedFields
    .map((field) => validationFieldByKey.get(field.key))
    .filter((field): field is NonNullable<typeof field> => !!field);
  const itemValidationFields = itemFields
    .map((field) => validationFieldByKey.get(field.key))
    .filter((field): field is NonNullable<typeof field> => !!field);

  const sharedResult = await validateAnswers(answers.sharedAnswers, sharedValidationFields);
  const sharedErrors = prefixIssues(sharedResult.errors);
  const sharedWarnings = prefixIssues(sharedResult.warnings);
  const items = [];

  for (let itemIndex = 0; itemIndex < qty; itemIndex += 1) {
    const result = await validateAnswers(answers.items[itemIndex] || {}, itemValidationFields);
    const errors = prefixIssues(result.errors, itemIndex);
    const warnings = prefixIssues(result.warnings, itemIndex);
    items.push({
      itemIndex,
      isValid: result.isValid,
      errors,
      warnings,
    });
  }

  const errors = [
    ...sharedErrors,
    ...items.flatMap((item) => item.errors),
  ];
  const warnings = [
    ...sharedWarnings,
    ...items.flatMap((item) => item.warnings),
  ];

  return {
    isValid: errors.length === 0,
    shared: {
      isValid: sharedResult.isValid,
      errors: sharedErrors,
      warnings: sharedWarnings,
    },
    items,
    errors,
    warnings,
  };
}

async function pngToPdfBuffer(
  pngBuffer: Buffer,
  widthPx: number,
  heightPx: number,
  dpi: number
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
    doc.image(pngBuffer, 0, 0, {
      width: widthPt,
      height: heightPt,
      fit: [widthPt, heightPt],
    });
    doc.end();
  });
}

async function syncAnswerRows(
  tx: Pick<typeof prisma, 'personalizationAnswer'>,
  caseId: string,
  fields: PersonalizationAnswerField[] & Array<{ id?: string }>,
  answers: StructuredCaseAnswers
) {
  for (const field of fields) {
    if (!field.id) continue;

    const scope = getFieldScope(field);
    const value = scope === 'INDIVIDUAL'
      ? answers.items.map((item) => item[field.key]).filter(hasAnswerValue)
      : answers.sharedAnswers[field.key];

    if (!hasAnswerValue(value)) continue;

    await tx.personalizationAnswer.upsert({
      where: {
        caseId_fieldId: {
          caseId,
          fieldId: field.id,
        },
      },
      update: {
        valueText: typeof value === 'string' ? value : null,
        valueJson: typeof value !== 'string' ? value : null,
      },
      create: {
        caseId,
        fieldId: field.id,
        valueText: typeof value === 'string' ? value : null,
        valueJson: typeof value !== 'string' ? value : null,
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
  });

  console.log(`[Cases] 📧 Email queued for ${caseItem.order.customerEmail}, case ${id} (token: ${maskToken(newToken)})`);

  return {
    success: true,
    message: 'Email queued for sending',
    newToken: maskToken(newToken),
  };
}
