import prisma from '../../lib/prisma';
import type { PersonalizedProductInput } from '../../schemas/admin.schema';

function normalizeIdentifier(value: string): string {
  return value.trim();
}

export async function listPersonalizedProducts() {
  const items = await prisma.personalizedProduct.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      shop: { select: { id: true, name: true } },
      template: { select: { id: true, name: true, code: true } },
    },
  });
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    identifierType: i.identifierType,
    identifierValue: i.identifierValue,
    isActive: i.isActive,
    shop: i.shop,
    template: i.template,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }));
}

export async function createPersonalizedProduct(input: PersonalizedProductInput) {
  const item = await prisma.personalizedProduct.create({
    data: {
      shopId: input.shopId,
      name: input.name.trim(),
      identifierType: input.identifierType,
      identifierValue: normalizeIdentifier(input.identifierValue),
      templateId: input.templateId,
      isActive: input.isActive,
    },
    include: {
      shop: { select: { id: true, name: true } },
      template: { select: { id: true, name: true, code: true } },
    },
  });
  return item;
}

export async function updatePersonalizedProduct(id: string, input: PersonalizedProductInput) {
  const item = await prisma.personalizedProduct.update({
    where: { id },
    data: {
      shopId: input.shopId,
      name: input.name.trim(),
      identifierType: input.identifierType,
      identifierValue: normalizeIdentifier(input.identifierValue),
      templateId: input.templateId,
      isActive: input.isActive,
    },
    include: {
      shop: { select: { id: true, name: true } },
      template: { select: { id: true, name: true, code: true } },
    },
  });
  return item;
}

export async function deletePersonalizedProduct(id: string) {
  await prisma.personalizedProduct.delete({ where: { id } });
  return { success: true };
}
