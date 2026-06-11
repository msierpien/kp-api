import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const casesQuerySchema = paginationSchema.extend({
  status: z.enum(['NEW', 'WAITING_FOR_CUSTOMER', 'SUBMITTED', 'READY_FOR_PRINT', 'ARCHIVED', '']).optional(),
  emailStatus: z.enum(['sent', 'not_sent', 'failed', '']).optional(),
  search: z.string().optional(),
  sortBy: z.enum(['createdAt', 'submittedAt', 'status', 'orderReference']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const syncLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  shopId: z.string().optional(),
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
  tenantId: z.string().optional(), // SUPER_ADMIN może wskazać tenant docelowy
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

export const ifirmaSettingsSchema = z.object({
  login: z.string().min(1, 'Login iFirma jest wymagany'),
  invoiceKey: z.string().min(1, 'Klucz faktura iFirma jest wymagany'),
  mode: z.enum(['production', 'test']).default('production'),
  isActive: z.boolean().default(true),
  defaultPaymentMethod: z.string().min(1).default('PRZ'),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  numberingSeriesName: z.string().optional().nullable(),
  templateName: z.string().optional().nullable(),
  issuePlace: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  receiverSignatureType: z.enum(['OUP', 'UPO', 'BPO', 'BWO']).default('BPO'),
  receiverSignature: z.string().optional().nullable(),
  issuerSignature: z.string().optional().nullable(),
  visibleBdo: z.boolean().default(false),
  sendEmailAfterIssue: z.boolean().default(false),
  splitBundleItems: z.boolean().default(false),
});

export const shopOrderStatusMappingSchema = z.object({
  statuses: z.array(z.object({
    externalStatusId: z.string().min(1),
    isPaid: z.boolean().optional(),
    isCancelled: z.boolean().optional(),
    isReadyForInvoice: z.boolean().optional(),
    isInvoiceTarget: z.boolean().optional(),
  })).default([]),
});

export const updateOrderStatusSchema = z.object({
  operationalStatus: z.string().min(1).optional(),
  externalStatusId: z.string().min(1).optional(),
});

export const orderReturnItemSchema = z.object({
  orderItemId: z.string().min(1),
  quantity: z.coerce.number().positive(),
});

export const orderReturnActionSchema = z.object({
  reason: z.string().max(1000).optional().nullable(),
  items: z.array(orderReturnItemSchema).default([]),
  refundShipping: z.boolean().default(false),
  restockItems: z.boolean().default(true),
  autoConfirmWarehouseDocument: z.boolean().default(true),
  externalStatusId: z.string().min(1).optional().nullable(),
});

export const orderCancellationActionSchema = orderReturnActionSchema.omit({ items: true }).extend({
  items: z.array(orderReturnItemSchema).optional(),
});

export type IfirmaSettingsInput = z.infer<typeof ifirmaSettingsSchema>;
export type ShopOrderStatusMappingInput = z.infer<typeof shopOrderStatusMappingSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type OrderReturnActionInput = z.infer<typeof orderReturnActionSchema>;
export type OrderCancellationActionInput = z.infer<typeof orderCancellationActionSchema>;

// ============================================
// Template Layout (wizualny edytor szablonów)
// ============================================

const backgroundPropertiesSchema = z.object({
  type: z.literal('background'),
  imageUrl: z.string().min(1),
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
});

const imagePropertiesSchema = z.object({
  type: z.literal('image'),
  imageUrl: z.string().min(1),
  fit: z.enum(['cover', 'contain', 'fill']).default('contain'),
});

const textFieldPropertiesSchema = z.object({
  type: z.literal('text'),
  fieldKey: z.string().min(1),
  placeholder: z.string().default(''),
  fontSize: z.number().positive(),
  fontUnit: z.enum(['px', 'pt']).default('pt'),
  fontFamily: z.string().min(1),
  fontWeight: z.number().int().min(100).max(900).default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fill: z.string().default('#000000'),
  textAlign: z.enum(['left', 'center', 'right']).default('left'),
  lineHeight: z.number().positive().default(1.2),
  maxLines: z.number().int().positive().default(1),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).default('none'),
  editable: z.literal(true).default(true),
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
});

const staticTextPropertiesSchema = z.object({
  type: z.literal('static_text'),
  text: z.string().default(''),
  fontSize: z.number().positive(),
  fontUnit: z.enum(['px', 'pt']).default('pt'),
  fontFamily: z.string().min(1),
  fontWeight: z.number().int().min(100).max(900).default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fill: z.string().default('#000000'),
  textAlign: z.enum(['left', 'center', 'right']).default('left'),
  lineHeight: z.number().positive().default(1.2),
  editable: z.literal(false).default(false),
});

const textboxPropertiesSchema = z.object({
  type: z.literal('textbox'),
  fieldKey: z.string().optional(),
  text: z.string().default(''),
  fontSize: z.number().positive(),
  fontUnit: z.enum(['px', 'pt']).default('pt'),
  fontFamily: z.string().min(1),
  fontWeight: z.number().int().min(100).max(900).default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fill: z.string().default('#000000'),
  textAlign: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).default('top'),
  lineHeight: z.number().positive().default(1.2),
  padding: z.number().min(0).default(0),
  backgroundColor: z.string().default('transparent'),
  borderColor: z.string().default('transparent'),
  borderWidth: z.number().min(0).default(0),
  editable: z.boolean().default(true),
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
});

const shapePropertiesSchema = z.object({
  type: z.literal('shape'),
  shapeType: z.enum(['rectangle', 'circle', 'ellipse', 'line']),
  fill: z.string().default('transparent'),
  stroke: z.string().default('#000000'),
  strokeWidth: z.number().min(0).default(1),
  borderRadius: z.number().min(0).default(0),
});

const cutLinePropertiesSchema = z.object({
  type: z.literal('cut_line'),
  stroke: z.string().default('#ff0000'),
  strokeWidth: z.number().min(0).default(0.5),
  strokeDashArray: z.array(z.number()).default([5, 5]),
  clientVisible: z.literal(false).default(false),
});

const layerPropertiesSchema = z.discriminatedUnion('type', [
  backgroundPropertiesSchema,
  imagePropertiesSchema,
  textFieldPropertiesSchema,
  staticTextPropertiesSchema,
  textboxPropertiesSchema,
  shapePropertiesSchema,
  cutLinePropertiesSchema,
]);

const layerBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['background', 'image', 'text', 'static_text', 'textbox', 'shape', 'cut_line']),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  zIndex: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
  rotation: z.number().default(0),
  properties: layerPropertiesSchema,
});

const fontConfigSchema = z.object({
  family: z.string().min(1),
  src: z.string().min(1),
  weight: z.number().int().min(100).max(900).default(400),
  style: z.enum(['normal', 'italic']).default('normal'),
});

const canvasConfigSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.enum(['px', 'mm']).default('px'),
  dpi: z.number().positive().default(300),
  bleed: z.number().min(0).default(0),
  safeArea: z.number().min(0).default(0),
  backgroundColor: z.string().default('#ffffff'),
});

export const templateLayoutSchema = z.object({
  version: z.literal(1),
  canvas: canvasConfigSchema,
  fonts: z.array(fontConfigSchema).default([]),
  layers: z.array(layerBaseSchema).default([]),
});

export const templateAssetParamsSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
});

export type TemplateLayoutInput = z.infer<typeof templateLayoutSchema>;
export type TemplateAssetParams = z.infer<typeof templateAssetParamsSchema>;
