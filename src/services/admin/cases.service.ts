import prisma from '../../lib/prisma';
import type { CaseListItem, PaginatedResponse } from '../../types';
import type { CasesQueryInput } from '../../schemas/admin.schema';

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
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  // Merge z istniejącymi odpowiedziami
  const updatedAnswers = {
    ...(caseItem.answersJson as any),
    ...answers,
  };

  return await prisma.personalizationCase.update({
    where: { id },
    data: {
      answersJson: updatedAnswers,
      updatedAt: new Date(),
    },
  });
}

export async function updateCaseStatus(id: string, status: string) {
  const validStatuses = ['NEW', 'WAITING_FOR_CUSTOMER', 'SUBMITTED', 'READY_FOR_PRINT', 'ARCHIVED'];
  
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }

  const caseItem = await prisma.personalizationCase.findUnique({
    where: { id },
  });

  if (!caseItem) {
    throw new Error('Case not found');
  }

  return await prisma.personalizationCase.update({
    where: { id },
    data: {
      status,
      updatedAt: new Date(),
    },
  });
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
