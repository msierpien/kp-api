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
  getFieldScope,
  hasAnswerValue,
  mergeCaseAnswers,
  normalizeCaseAnswers,
  type PersonalizationAnswerField,
  type StructuredCaseAnswers,
} from '../../lib/personalization-answers';

export async function getCases(query: CasesQueryInput): Promise<PaginatedResponse<CaseListItem>> {
  const { page, limit, status, emailStatus, search, sortBy, sortOrder } = query;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (status) {
    where.status = status;
  }

  // Email status filter
  if (emailStatus === 'sent') {
    where.emailSentAt = { not: null };
  } else if (emailStatus === 'not_sent') {
    where.emailSentAt = null;
  } else if (emailStatus === 'failed') {
    where.emailFailedAt = { not: null };
  }

  if (search) {
    where.OR = [
      {
        order: {
          orderReference: { contains: search, mode: 'insensitive' },
        },
      },
      {
        order: {
          customerEmail: { contains: search, mode: 'insensitive' },
        },
      },
      {
        order: {
          customerName: { contains: search, mode: 'insensitive' },
        },
      },
    ];
  }

  const orderByMap: Record<string, any> = {
    createdAt: { createdAt: sortOrder },
    submittedAt: { submittedAt: sortOrder },
    status: { status: sortOrder },
    orderReference: { order: { orderReference: sortOrder } },
  };

  const [cases, total] = await Promise.all([
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
  const validStatuses = ['NEW', 'WAITING_FOR_CUSTOMER', 'SUBMITTED', 'READY_FOR_PRINT', 'ARCHIVED'];
  
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
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
