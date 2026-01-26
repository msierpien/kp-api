import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const casesQuerySchema = paginationSchema.extend({
  status: z.enum(['NEW', 'WAITING_FOR_CUSTOMER', 'SUBMITTED', 'READY_FOR_PRINT', 'ARCHIVED', '']).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['createdAt', 'submittedAt', 'status', 'orderReference']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const syncLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

// Shops / integrations
export const shopConfigSchema = z.object({
  orderSync: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.coerce.number().int().min(1).max(1440).default(10),
    orderStatus: z.string().min(1).default('PAID'),
  }),
  adminApi: z
    .object({
      clientId: z.string().optional().nullable(),
      clientSecret: z.string().optional().nullable(),
      scopes: z.array(z.string()).default([]),
    })
    .optional()
    .default({ clientId: null, clientSecret: null, scopes: [] }),
});

export const shopBaseSchema = z.object({
  name: z.string().min(1),
  platform: z.enum(['PRESTASHOP', 'WOOCOMMERCE', 'SHOPIFY', 'MAGENTO', 'OTHER']).default('PRESTASHOP'),
  baseUrl: z.string().url(),
  apiKey: z.string().optional().nullable(),
  apiSecret: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  authType: z.enum(['WEB_SERVICE', 'ADMIN_API']).default('WEB_SERVICE'),
  config: shopConfigSchema.default({
    orderSync: {
      enabled: true,
      intervalMinutes: 10,
      orderStatus: 'PAID',
    },
    adminApi: { clientId: null, clientSecret: null, scopes: [] },
  }),
});

export const createShopSchema = shopBaseSchema;

export const updateShopSchema = shopBaseSchema;

export const shopIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type CasesQueryInput = z.infer<typeof casesQuerySchema>;
export type SyncLogsQueryInput = z.infer<typeof syncLogsQuerySchema>;
export type ShopConfigInput = z.infer<typeof shopConfigSchema>;
export type CreateShopInput = z.infer<typeof createShopSchema>;
export type UpdateShopInput = z.infer<typeof updateShopSchema>;
export type ShopIdParamsInput = z.infer<typeof shopIdParamsSchema>;

// Personalized products (mapping identifier -> template)
export const personalizedProductSchema = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1),
  identifierType: z.enum(['SKU', 'INDEX', 'EAN']).default('SKU'),
  identifierValue: z.string().min(1),
  templateId: z.string().min(1),
  isActive: z.boolean().default(true),
});

export const personalizedProductParamsSchema = z.object({
  id: z.string().min(1),
});

export type PersonalizedProductInput = z.infer<typeof personalizedProductSchema>;
export type PersonalizedProductParams = z.infer<typeof personalizedProductParamsSchema>;

// Templates / forms
export const formFieldInputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().default(false),
  minLength: z.number().int().optional().nullable(),
  maxLength: z.number().int().optional().nullable(),
  pattern: z.string().optional().nullable(),
  placeholder: z.string().optional().nullable(),
  helpText: z.string().optional().nullable(),
  defaultValue: z.string().optional().nullable(),
  optionsJson: z.any().optional().nullable(),
  repeaterGroupKey: z.string().optional().nullable(),
  sortOrder: z.number().int().default(0),
  validationRulesJson: z.any().optional().nullable(),
});

export const formInputSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  fields: z.array(formFieldInputSchema).default([]),
});

export const templateFormSchema = z.object({
  forms: z.array(formInputSchema).default([]),
});

export const templateIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type TemplateFormInput = z.infer<typeof templateFormSchema>;
export type TemplateIdParams = z.infer<typeof templateIdParamsSchema>;
