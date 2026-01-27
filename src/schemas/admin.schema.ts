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
export const shopBaseSchema = z.object({
  name: z.string().min(1),
  platform: z.enum(['PRESTASHOP', 'WOOCOMMERCE', 'SHOPIFY', 'MAGENTO', 'MANUAL', 'CUSTOM_API', 'OTHER']).default('PRESTASHOP'),
  baseUrl: z.string().default(''), // Opcjonalny dla MANUAL
  apiKey: z.string().optional().nullable().default(''),
  apiSecret: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  config: z.any().optional().default({}), // Elastyczna konfiguracja JSON
});

export const createShopSchema = shopBaseSchema;

export const updateShopSchema = shopBaseSchema;

export const shopIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type CasesQueryInput = z.infer<typeof casesQuerySchema>;
export type SyncLogsQueryInput = z.infer<typeof syncLogsQuerySchema>;
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

// Template creation
export const createTemplateSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/, 'Kod może zawierać tylko wielkie litery, cyfry i podkreślenia'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  version: z.number().int().positive().default(1),
  isActive: z.boolean().default(true),
});

// Template metadata update (not forms)
export const updateTemplateMetadataSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  version: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});

export type TemplateFormInput = z.infer<typeof templateFormSchema>;
export type TemplateIdParams = z.infer<typeof templateIdParamsSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateMetadataInput = z.infer<typeof updateTemplateMetadataSchema>;

// Manual Orders
export const createManualOrderItemSchema = z.object({
  sku: z.string().min(1),
  productName: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitPrice: z.number().positive().optional(),
});

export const createManualOrderSchema = z.object({
  shopId: z.string().min(1),
  orderReference: z.string().min(1),
  customerEmail: z.string().email(),
  customerName: z.string().optional().nullable(),
  totalPaid: z.number().positive(),
  currency: z.string().default('PLN'),
  language: z.string().default('pl'),
  createdAtShop: z.string().datetime().optional(), // ISO string
  items: z.array(createManualOrderItemSchema).min(1),
  notes: z.string().optional(),
});

export type CreateManualOrderInput = z.infer<typeof createManualOrderSchema>;
export type CreateManualOrderItemInput = z.infer<typeof createManualOrderItemSchema>;

// Cases management
export const caseIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const updateCaseAnswersSchema = z.object({
  answers: z.any(), // JSON - będzie walidowane względem pól template'a
});

export const updateCaseStatusSchema = z.object({
  status: z.enum(['NEW', 'WAITING_FOR_CUSTOMER', 'SUBMITTED', 'READY_FOR_PRINT', 'ARCHIVED']),
});

export const addCaseNoteSchema = z.object({
  note: z.string().min(1).max(1000),
});

export type CaseIdParams = z.infer<typeof caseIdParamsSchema>;
export type UpdateCaseAnswersInput = z.infer<typeof updateCaseAnswersSchema>;
export type UpdateCaseStatusInput = z.infer<typeof updateCaseStatusSchema>;
export type AddCaseNoteInput = z.infer<typeof addCaseNoteSchema>;

// Email Settings
export const emailSettingsSchema = z.object({
  host: z.string().min(1, 'Host SMTP jest wymagany'),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().min(1, 'Użytkownik SMTP jest wymagany'),
  password: z.string().min(1, 'Hasło SMTP jest wymagane'),
  fromEmail: z.string().email('Nieprawidłowy adres email'),
  fromName: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

export const emailSettingsIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type EmailSettingsInput = z.infer<typeof emailSettingsSchema>;
export type EmailSettingsIdParams = z.infer<typeof emailSettingsIdParamsSchema>;
