import prisma from '../../lib/prisma';
import type { CaseListItem, PaginatedResponse } from '../../types';
import type { CasesQueryInput } from '../../schemas/admin.schema';
import { emailService } from '../email/email.service';
import { triggerAutomations, AutomationTrigger } from './automation.service';

export async function getCases(query: CasesQueryInput): Promise<PaginatedResponse<CaseListItem>> {
  const { page, limit, status, search, sortBy, sortOrder } = query;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (status) {
    where.status = status;
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
          },
        },
        template: {
          select: {
            name: true,
          },
        },
      },
    }),
    prisma.personalizationCase.count({ where }),
  ]);

  const data: CaseListItem[] = cases.map((c) => ({
    id: c.id,
    status: c.status,
    orderReference: c.order.orderReference,
    customerEmail: c.order.customerEmail,
    customerName: c.order.customerName,
    productName: c.orderItem.productNameSnapshot,
    templateName: c.template.name,
    submittedAt: c.submittedAt,
    createdAt: c.createdAt,
  }));

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

  // Konwersja Decimal na number dla frontendowych operacji
  return {
    ...caseItem,
    order: {
      ...caseItem.order,
      totalPaid: caseItem.order.totalPaid.toNumber(),
    },
  };
}

export async function updateCaseAnswers(id: string, answers: any) {
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

  // Merge z istniejącymi odpowiedziami
  const updatedAnswers = {
    ...(caseItem.answersJson as any),
    ...answers,
  };

  // Sprawdź czy wszystkie wymagane pola są wypełnione
  const allFieldsFilled = Object.keys(updatedAnswers).length > 0;
  const shouldSubmit = allFieldsFilled && caseItem.status === 'WAITING_FOR_CUSTOMER';

  const updated = await prisma.personalizationCase.update({
    where: { id },
    data: {
      answersJson: updatedAnswers,
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

  // Trigger automation if case was submitted
  if (shouldSubmit) {
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_SUBMITTED,
      caseItem: updated,
    });
  }

  return updated;
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
    caseItem: updated,
    oldStatus,
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

  const baseUrl = process.env.PUBLIC_PORTAL_BASE_URL || 'http://localhost:3002';
  
  try {
    await emailService.sendPersonalizationEmail({
      to: caseItem.order.customerEmail,
      customerName: caseItem.order.customerName || '',
      orderReference: caseItem.order.orderReference,
      shopName: caseItem.order.shop.name,
      items: [{
        productName: caseItem.orderItem.productNameSnapshot,
        quantity: caseItem.orderItem.quantity,
        personalizationUrl: `${baseUrl}/personalize?token=${caseItem.customerTokenHash}`,
      }],
      baseUrl,
    });

    console.log(`[Cases] ✉️  Email resent to ${caseItem.order.customerEmail} for case ${id}`);
    
    return { 
      success: true, 
      message: 'Email został wysłany ponownie' 
    };
  } catch (error) {
    console.error(`[Cases] Failed to resend email for case ${id}:`, error);
    throw new Error('Nie udało się wysłać emaila');
  }
}
