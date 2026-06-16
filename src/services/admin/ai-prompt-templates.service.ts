import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId, isSuperAdmin } from '../../lib/tenant-context';
import type { AiPromptTemplateInput, AiPromptTemplateUpdateInput } from '../../schemas/admin.schema';

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;

  if (!tenantId || (isSuperAdmin() && !getTenantContext()?.overrideTenantId && !getTenantContext()?.tenantId)) {
    throw new Error('Tenant context is required for AI prompt templates');
  }

  return tenantId;
}

function toResponse(template: any) {
  return {
    id: template.id,
    tenantId: template.tenantId,
    name: template.name,
    category: template.category,
    productType: template.productType,
    occasionContext: template.occasionContext,
    tone: template.tone,
    brief: template.brief,
    systemPrompt: template.systemPrompt,
    htmlMode: template.htmlMode,
    rulesJson: template.rulesJson,
    isDefault: template.isDefault,
    isActive: template.isActive,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

const presetTemplates: AiPromptTemplateInput[] = [
  {
    name: 'Balony stojące',
    category: 'Balony',
    productType: 'balony stojace i bukiety balonowe',
    occasionContext: 'urodziny, baby shower, przyjecia tematyczne',
    tone: 'naturalny sprzedazowy',
    brief: 'Opis ma pomagac dobrac balony do motywu imprezy, kolorystyki i wieku osoby. Pisz konkretnie, bez przesadnych obietnic.',
    systemPrompt: 'Podkresl kolor, liczbe sztuk, rozmiar i zastosowanie dekoracyjne. Nie wymyslaj zawartosci zestawu.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
  {
    name: 'Dekoracje urodzinowe',
    category: 'Dekoracje urodzinowe',
    productType: 'dekoracje urodzinowe',
    occasionContext: 'urodziny dziecka lub doroslego',
    tone: 'naturalny sprzedazowy',
    brief: 'Produkty sa dekoracjami urodzinowymi. Opis ma pomoc dobrac ozdobe do motywu imprezy, kolorystyki i klimatu przyjecia.',
    systemPrompt: 'Pisz krotko, praktycznie i po polsku. Glowny opis zwracaj w prostym HTML.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: true,
    isActive: true,
  },
  {
    name: 'Stół i tort',
    category: 'Stol i tort',
    productType: 'akcesoria na stol i tort',
    occasionContext: 'przyjecia urodzinowe, komunie, baby shower',
    tone: 'cieply praktyczny',
    brief: 'Opis ma pokazac, jak produkt uzupelnia aranzacje stolu albo tortu. Uwzglednij rozmiar, kolor i motyw, jesli sa w danych.',
    systemPrompt: 'Nie sugeruj kontaktu z zywnoscia, jesli dane produktu tego nie potwierdzaja.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
  {
    name: 'Serwetki',
    category: 'Serwetki',
    productType: 'serwetki papierowe',
    occasionContext: 'nakrycie stolu i dekoracja przyjecia',
    tone: 'neutralny sprzedazowy',
    brief: 'Opis ma laczyc funkcje praktyczna i dekoracyjna. Podkresl wzor, kolor, liczbe sztuk i okazje, jesli wystepuja w danych.',
    systemPrompt: 'Nie wymyslaj gramatury, warstw ani wymiarow, jesli ich nie ma.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
  {
    name: 'Zaproszenia i kartki',
    category: 'Zaproszenia i kartki',
    productType: 'zaproszenia i kartki okolicznosciowe',
    occasionContext: 'urodziny, chrzest, komunia, slub lub inne okazje',
    tone: 'elegancki prosty',
    brief: 'Opis ma jasno pokazac okazje, styl grafiki i zastosowanie produktu. Nie obiecuj personalizacji, jesli nie ma jej w danych.',
    systemPrompt: 'Unikaj zbyt kwiecistego tonu. SEO ma byc konkretne.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
  {
    name: 'Girlandy balonowe',
    category: 'Girlandy balonowe',
    productType: 'girlandy i zestawy balonowe',
    occasionContext: 'dekoracja tla, scianek i strefy zdjec',
    tone: 'inspirujacy praktyczny',
    brief: 'Opis ma pokazac efekt dekoracyjny girlandy oraz gdzie najlepiej ja wykorzystac. Trzymaj sie kolorow, liczby elementow i rozmiarow z danych.',
    systemPrompt: 'Nie dodawaj instrukcji montazu, jesli nie ma jej w danych.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
  {
    name: 'Uniwersalny HTML',
    category: 'UNIVERSAL',
    productType: 'produkt dekoracyjny',
    occasionContext: 'rozne okazje',
    tone: 'naturalny sprzedazowy',
    brief: 'Uniwersalny szablon do opisow produktow. Opis ma byc konkretny, pomocny i oparty na danych produktu.',
    systemPrompt: 'Zwracaj glowny opis w prostym HTML. Bez Markdown, klas CSS, styli inline, tabel i skryptow.',
    htmlMode: 'basic',
    rulesJson: { mainDescriptionFormat: 'basic_html' },
    isDefault: false,
    isActive: true,
  },
];

async function clearDefaultIfNeeded(tenantId: string, isDefault?: boolean, exceptId?: string) {
  if (!isDefault) return;

  await prisma.aiPromptTemplate.updateMany({
    where: {
      tenantId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      isDefault: true,
    },
    data: { isDefault: false },
  });
}

export async function listAiPromptTemplates() {
  const tenantId = requireTenantId();
  const templates = await prisma.aiPromptTemplate.findMany({
    where: { tenantId },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });

  return templates.map(toResponse);
}

export async function createAiPromptTemplate(input: AiPromptTemplateInput) {
  const tenantId = requireTenantId();
  await clearDefaultIfNeeded(tenantId, input.isDefault);

  const template = await prisma.aiPromptTemplate.create({
    data: {
      tenantId,
      name: input.name,
      category: input.category,
      productType: input.productType ?? null,
      occasionContext: input.occasionContext ?? null,
      tone: input.tone,
      brief: input.brief,
      systemPrompt: input.systemPrompt ?? null,
      htmlMode: input.htmlMode,
      rulesJson: input.rulesJson ?? Prisma.JsonNull,
      isDefault: input.isDefault,
      isActive: input.isActive,
    },
  });

  if (template.isDefault) {
    await prisma.aiSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPromptTemplateId: template.id },
      update: { defaultPromptTemplateId: template.id },
    });
  }

  return toResponse(template);
}

export async function updateAiPromptTemplate(id: string, input: AiPromptTemplateUpdateInput) {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findFirst({ where: { id, tenantId } });

  if (!existing) {
    throw new Error('AI prompt template not found');
  }

  await clearDefaultIfNeeded(tenantId, input.isDefault, id);

  const template = await prisma.aiPromptTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.productType !== undefined ? { productType: input.productType ?? null } : {}),
      ...(input.occasionContext !== undefined ? { occasionContext: input.occasionContext ?? null } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt ?? null } : {}),
      ...(input.htmlMode !== undefined ? { htmlMode: input.htmlMode } : {}),
      ...(input.rulesJson !== undefined ? { rulesJson: input.rulesJson ?? Prisma.JsonNull } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  if (template.isDefault) {
    await prisma.aiSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPromptTemplateId: template.id },
      update: { defaultPromptTemplateId: template.id },
    });
  }

  return toResponse(template);
}

export async function deleteAiPromptTemplate(id: string) {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findFirst({ where: { id, tenantId } });

  if (!existing) {
    throw new Error('AI prompt template not found');
  }

  await prisma.aiPromptTemplate.delete({ where: { id } });

  if (existing.isDefault) {
    await prisma.aiSettings.updateMany({
      where: { tenantId, defaultPromptTemplateId: id },
      data: { defaultPromptTemplateId: null },
    });
  }

  return { success: true };
}

export async function duplicateAiPromptTemplate(id: string) {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('AI prompt template not found');

  const template = await prisma.aiPromptTemplate.create({
    data: {
      tenantId,
      name: `${existing.name} - kopia`,
      category: existing.category,
      productType: existing.productType,
      occasionContext: existing.occasionContext,
      tone: existing.tone,
      brief: existing.brief,
      systemPrompt: existing.systemPrompt,
      htmlMode: existing.htmlMode,
      rulesJson: existing.rulesJson ?? Prisma.JsonNull,
      isDefault: false,
      isActive: existing.isActive,
    },
  });

  return toResponse(template);
}

export async function installAiPromptTemplatePresets() {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findMany({
    where: { tenantId },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((template) => template.name.toLowerCase()));
  const created = [];

  for (const preset of presetTemplates) {
    if (existingNames.has(preset.name.toLowerCase())) continue;
    if (preset.isDefault) await clearDefaultIfNeeded(tenantId, true);
    const template = await prisma.aiPromptTemplate.create({
      data: {
        tenantId,
        name: preset.name,
        category: preset.category,
        productType: preset.productType ?? null,
        occasionContext: preset.occasionContext ?? null,
        tone: preset.tone,
        brief: preset.brief,
        systemPrompt: preset.systemPrompt ?? null,
        htmlMode: preset.htmlMode,
        rulesJson: preset.rulesJson ?? Prisma.JsonNull,
        isDefault: preset.isDefault,
        isActive: preset.isActive,
      },
    });
    created.push(toResponse(template));
  }

  const defaultTemplate = created.find((template) => template.isDefault);
  if (defaultTemplate) {
    await prisma.aiSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPromptTemplateId: defaultTemplate.id },
      update: { defaultPromptTemplateId: defaultTemplate.id },
    });
  }

  return { created: created.length, templates: created };
}
