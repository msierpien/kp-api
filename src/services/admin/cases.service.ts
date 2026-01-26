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
