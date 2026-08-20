import { z } from 'zod';
import { ORDER_OPERATIONAL_STATUSES } from '../lib/order-statuses';
import { PERSONALIZATION_CASE_STATUSES } from '../lib/personalization-case-statuses';

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const orderOperationalStatusSchema = z.enum(ORDER_OPERATIONAL_STATUSES);

export const casesQuerySchema = paginationSchema.extend({
  status: z.enum([...PERSONALIZATION_CASE_STATUSES, '']).optional(),
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

export const prestaShopCategoriesQuerySchema = z.object({
  activeOnly: z.union([z.boolean(), z.string()]).optional().transform((value) => {
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return !['false', '0', 'no'].includes(value.trim().toLowerCase());
  }),
  tree: z.union([z.boolean(), z.string()]).optional().transform((value) => {
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  }),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

export const prestaShopCategoryParamsSchema = shopIdParamsSchema.extend({
  categoryId: z.string().min(1),
});

export const prestaShopCategoryProductsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(160).optional().default(''),
  sort: z.enum(['nameAsc', 'nameDesc', 'priceAsc', 'priceDesc', 'updatedDesc']).default('nameAsc'),
});

export const prestaShopSubcategoryCandidatesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(500).default(500),
  search: z.string().trim().max(160).optional().default(''),
  sort: z.enum(['nameAsc', 'nameDesc', 'priceAsc', 'priceDesc', 'updatedDesc']).default('nameAsc'),
});

export const detachPrestaShopCategoryProductsSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1).max(200),
});

export const distributePrestaShopSubcategoryProductsSchema = z.object({
  mode: z.enum(['ADD', 'MOVE']).default('ADD'),
  items: z.array(z.object({
    productId: z.string().min(1),
    targetCategoryId: z.union([z.string(), z.number()])
      .transform((value) => String(value).trim())
      .pipe(z.string().min(1)),
  })).min(1).max(200),
});

const optionalCategoryText = z.string().trim().max(65535).optional().nullable();

export const createPrestaShopCategorySchema = z.object({
  name: z.string().trim().min(1, 'Nazwa kategorii jest wymagana').max(128),
  parentId: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).pipe(z.string().min(1, 'Kategoria nadrzędna jest wymagana')),
  active: z.boolean().optional().default(true),
  linkRewrite: z.string().trim().max(128).optional().nullable(),
  description: optionalCategoryText,
  metaTitle: z.string().trim().max(255).optional().nullable(),
  metaDescription: z.string().trim().max(512).optional().nullable(),
  languageId: z.union([z.string(), z.number()]).optional().nullable(),
  idShopDefault: z.union([z.string(), z.number()]).optional().nullable(),
});

export const updatePrestaShopCategorySchema = createPrestaShopCategorySchema.partial().extend({
  active: z.boolean().optional(),
});

export const deletePrestaShopCategoryQuerySchema = z.object({
  hard: z.union([z.boolean(), z.string()]).optional().transform((value) => {
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  }),
});

export type PaginationInput = z.infer<typeof paginationSchema>;
export type CasesQueryInput = z.infer<typeof casesQuerySchema>;
export type SyncLogsQueryInput = z.infer<typeof syncLogsQuerySchema>;
export type CreateShopInput = z.infer<typeof createShopSchema>;
export type UpdateShopInput = z.infer<typeof updateShopSchema>;
export type ShopIdParamsInput = z.infer<typeof shopIdParamsSchema>;
export type PrestaShopCategoriesQueryInput = z.infer<typeof prestaShopCategoriesQuerySchema>;
export type PrestaShopCategoryParamsInput = z.infer<typeof prestaShopCategoryParamsSchema>;
export type PrestaShopCategoryProductsQueryInput = z.infer<typeof prestaShopCategoryProductsQuerySchema>;
export type PrestaShopSubcategoryCandidatesQueryInput = z.infer<typeof prestaShopSubcategoryCandidatesQuerySchema>;
export type DetachPrestaShopCategoryProductsInput = z.infer<typeof detachPrestaShopCategoryProductsSchema>;
export type DistributePrestaShopSubcategoryProductsInput = z.infer<typeof distributePrestaShopSubcategoryProductsSchema>;
export type CreatePrestaShopCategoryInput = z.infer<typeof createPrestaShopCategorySchema>;
export type UpdatePrestaShopCategoryInput = z.infer<typeof updatePrestaShopCategorySchema>;
export type DeletePrestaShopCategoryQueryInput = z.infer<typeof deletePrestaShopCategoryQuerySchema>;

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
  previousKey: z.string().min(1).optional().nullable(),
  label: z.string().min(1),
  type: z.string().min(1),
  scope: z.enum(['SHARED', 'INDIVIDUAL']).default('SHARED'),
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
  editorType: z.enum(['SIMPLE', 'ADVANCED']).default('ADVANCED'),
  isActive: z.boolean().default(true),
  /** Etykiety biblioteki - normalizowane w serwisie, nie tutaj. */
  tags: z.array(z.string().max(40)).max(20).optional(),
  layout: z.any().optional(),
});

// Template metadata update (not forms)
export const updateTemplateMetadataSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Z0-9_]+$/).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  version: z.number().int().positive().optional(),
  editorType: z.enum(['SIMPLE', 'ADVANCED']).optional(),
  isActive: z.boolean().optional(),
  // Brak pola = „nie ruszaj tagow”. Pusta tablica = „skasuj wszystkie”.
  tags: z.array(z.string().max(40)).max(20).optional(),
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
  answers: z.any().optional(), // stary płaski JSON
  sharedAnswers: z.record(z.any()).optional(),
  items: z.array(z.record(z.any())).optional(),
}).refine((value) => value.answers !== undefined || value.sharedAnswers !== undefined || value.items !== undefined, {
  message: 'answers, sharedAnswers albo items są wymagane',
});

export const updateCaseStatusSchema = z.object({
  status: z.enum(PERSONALIZATION_CASE_STATUSES),
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
  /** Sklep, ktory ma nadawac z tego adresu. Brak = konfiguracja zapasowa. */
  shopId: z.string().min(1).optional().nullable(),
  isActive: z.boolean().default(true),
});

export const emailSettingsIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type EmailSettingsInput = z.infer<typeof emailSettingsSchema>;
export type EmailSettingsIdParams = z.infer<typeof emailSettingsIdParamsSchema>;

// AI Settings
export const aiProviderSchema = z.enum(['OPENAI', 'ANTHROPIC', 'DEEPSEEK']);

export const aiSettingsSchema = z.object({
  activeProvider: aiProviderSchema.default('OPENAI'),
  textProvider: aiProviderSchema.default('OPENAI'),
  visionProvider: aiProviderSchema.default('OPENAI'),
  openaiApiKey: z.string().optional().nullable(),
  anthropicApiKey: z.string().optional().nullable(),
  deepseekApiKey: z.string().optional().nullable(),
  openaiTextModel: z.string().min(1).default('gpt-4.1-mini'),
  openaiVisionModel: z.string().min(1).default('gpt-4.1-mini'),
  anthropicTextModel: z.string().min(1).default('claude-sonnet-5'),
  anthropicVisionModel: z.string().min(1).default('claude-haiku-4-5'),
  deepseekTextModel: z.string().min(1).default('deepseek-chat'),
  deepseekVisionModel: z.string().optional().nullable(),
  dailyLimit: z.coerce.number().int().min(1).max(100000).default(200),
  monthlyLimit: z.coerce.number().int().min(1).max(1000000).default(5000),
  timeoutMs: z.coerce.number().int().min(5000).max(180000).default(45000),
  maxBatchSize: z.coerce.number().int().min(1).max(200).default(20),
  defaultPromptTemplateId: z.string().optional().nullable(),
  toneJson: z.any().optional().nullable(),
  rulesJson: z.any().optional().nullable(),
  // Asystent w edytorze klienta. Osobne limity od generatora opisow -
  // to jedyna funkcja, w ktorej wywolanie modelu inicjuje klient koncowy.
  //
  // Wszystkie pola sa OPCJONALNE bez wartosci domyslnej, i to celowo:
  // z `default(false)` zapis ustawien z panelu, ktory tych pol nie zna,
  // po cichu wylaczalby asystenta. Brak pola = "nie ruszaj", a nie "wylacz".
  editorEnabled: z.boolean().optional(),
  /** Puste = dziedziczy dostawce i model tekstowy z ustawien powyzej. */
  editorProvider: aiProviderSchema.optional().nullable(),
  editorModel: z.string().max(120).optional().nullable(),
  editorDailyLimit: z.coerce.number().int().min(1).max(10000).optional(),
  editorPerCaseLimit: z.coerce.number().int().min(1).max(200).optional(),
  editorSystemPrompt: z.string().max(4000).optional().nullable(),
});

export const aiProviderTestSchema = z.object({
  provider: aiProviderSchema,
});

export const aiPromptTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(80).default('UNIVERSAL'),
  productType: z.string().max(120).optional().nullable(),
  occasionContext: z.string().max(200).optional().nullable(),
  tone: z.string().min(1).max(120).default('naturalny sprzedazowy'),
  brief: z.string().min(1).max(8000),
  systemPrompt: z.string().max(8000).optional().nullable(),
  htmlMode: z.enum(['basic', 'plain']).default('basic'),
  rulesJson: z.any().optional().nullable(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const aiPromptTemplateUpdateSchema = aiPromptTemplateSchema.partial();

export const aiPromptTemplateIdParamsSchema = z.object({
  id: z.string().min(1),
});

export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;
export type AiProviderTestInput = z.infer<typeof aiProviderTestSchema>;
export type AiPromptTemplateInput = z.infer<typeof aiPromptTemplateSchema>;
export type AiPromptTemplateUpdateInput = z.infer<typeof aiPromptTemplateUpdateSchema>;
export type AiPromptTemplateIdParams = z.infer<typeof aiPromptTemplateIdParamsSchema>;

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
    operationalStatus: orderOperationalStatusSchema.optional().nullable(),
    isPaid: z.boolean().optional(),
    isCancelled: z.boolean().optional(),
    isReadyForInvoice: z.boolean().optional(),
    isInvoiceTarget: z.boolean().optional(),
  })).default([]),
});

export const updateOrderStatusSchema = z.object({
  operationalStatus: orderOperationalStatusSchema.optional(),
  externalStatusId: z.string().min(1).optional(),
});

export const ordersListQuerySchema = paginationSchema.extend({
  q: z.string().trim().optional(),
  statusGroup: z.enum(['active', 'cancelled', 'returned', 'all', '']).optional(),
  operationalStatus: orderOperationalStatusSchema.optional(),
  shopId: z.string().trim().optional(),
  payment: z.enum(['all', 'paid', 'unpaid', '']).default('all'),
  invoice: z.enum(['all', 'issued', 'missing', '']).default('all'),
  personalization: z.enum(['all', 'required', 'waiting', 'ready', '']).default('all'),
  datePreset: z.enum(['all', '7d', '30d', '90d', '']).default('all'),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
  shipBy: z.enum(['overdue', 'today', 'tomorrow', 'future', 'shipped', '']).optional(),
  sortBy: z.enum(['createdAtShop', 'totalPaid', 'maxShippingDate', 'orderReference']).default('createdAtShop'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const ordersCountsQuerySchema = ordersListQuerySchema.omit({
  page: true,
  limit: true,
  operationalStatus: true,
  statusGroup: true,
}).extend({
  scope: z.enum(['sidebar', 'list', '']).default('sidebar'),
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
  // Odznaczane, gdy korekta lub refund powstaly juz recznie poza panelem.
  issueIfirmaCorrection: z.boolean().default(true),
  createPrestashopSlip: z.boolean().default(true),
  externalStatusId: z.string().min(1).optional().nullable(),
});

export const orderCancellationActionSchema = orderReturnActionSchema.omit({ items: true }).extend({
  items: z.array(orderReturnItemSchema).optional(),
});

// Zamiana produktu w pozycji zamówienia. Cena i ilość zostają bez zmian —
// zamieniamy tylko to, co realnie wychodzi z magazynu.
export const substituteOrderItemSchema = z.object({
  warehouseProductId: z.string().min(1),
  reason: z.string().max(1000).optional().nullable(),
  notifyShop: z.boolean().default(true),
});

export type IfirmaSettingsInput = z.infer<typeof ifirmaSettingsSchema>;
export type ShopOrderStatusMappingInput = z.infer<typeof shopOrderStatusMappingSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type OrdersListQueryInput = z.infer<typeof ordersListQuerySchema>;
export type OrdersCountsQueryInput = z.infer<typeof ordersCountsQuerySchema>;
export type OrderReturnActionInput = z.infer<typeof orderReturnActionSchema>;
export type OrderCancellationActionInput = z.infer<typeof orderCancellationActionSchema>;
export type SubstituteOrderItemInput = z.infer<typeof substituteOrderItemSchema>;

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
  // Zgody na ruch w portalu klienta - jak przy warstwach tekstowych.
  // Tlo (background) celowo bez nich: klient nigdy nie rusza tla.
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
  // Kolor ozdobnika (SVG z currentColor) i blokada proporcji.
  tint: z.string().optional(),
  lockAspectRatio: z.boolean().optional(),
});

const simpleSlotSchema = z.enum([
  'TOP_LEFT',
  'TOP_CENTER',
  'TOP_RIGHT',
  'MIDDLE_LEFT',
  'MIDDLE_CENTER',
  'MIDDLE_RIGHT',
  'BOTTOM_LEFT',
  'BOTTOM_CENTER',
  'BOTTOM_RIGHT',
]);

/**
 * Styl fragmentu tekstu. Zakres liczy sie na surowym tekscie warstwy - patrz
 * TextStyleRange w @msierpien/kp-template-core.
 */
const textStyleRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  fontWeight: z.number().int().min(100).max(900).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  underline: z.boolean().optional(),
  fill: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
});

const textFieldPropertiesSchema = z.object({
  type: z.literal('text'),
  fieldKey: z.string().default(''),
  simpleSlot: simpleSlotSchema.optional(),
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
  styleRanges: z.array(textStyleRangeSchema).optional(),
  letterSpacing: z.number().optional(),
  editable: z.literal(true).default(true),
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
  clientFontSize: z.boolean().optional(),
  clientFontFamily: z.boolean().optional(),
  clientColor: z.boolean().optional(),
  clientTextAlign: z.boolean().optional(),
  clientFontWeight: z.boolean().optional(),
  // Bez tego pola zgoda ustawiona w panelu znikalaby przy zapisie layoutu -
  // z.object wycina nieznane klucze po cichu.
  clientLineHeight: z.boolean().optional(),
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
  simpleSlot: simpleSlotSchema.optional(),
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
  // Krycie tla w procentach (0-100). Brak = pelne krycie.
  backgroundOpacity: z.number().min(0).max(100).optional(),
  borderColor: z.string().default('transparent'),
  borderWidth: z.number().min(0).default(0),
  editable: z.boolean().default(true),
  splitByGrapheme: z.boolean().optional(),
  styleRanges: z.array(textStyleRangeSchema).optional(),
  letterSpacing: z.number().optional(),
  clientDraggable: z.boolean().optional(),
  clientResizable: z.boolean().optional(),
  clientRotatable: z.boolean().optional(),
  clientFontSize: z.boolean().optional(),
  clientFontFamily: z.boolean().optional(),
  clientColor: z.boolean().optional(),
  clientTextAlign: z.boolean().optional(),
  clientFontWeight: z.boolean().optional(),
  // Bez tego pola zgoda ustawiona w panelu znikalaby przy zapisie layoutu -
  // z.object wycina nieznane klucze po cichu.
  clientLineHeight: z.boolean().optional(),
});

/**
 * Tekst po krzywej.
 *
 * Bez tego schematu `z.object` po cichu wycialby CALA warstwe przy zapisie
 * layoutu - projektant dodalby luk, zapisal i zobaczyl pusta kartke, bez
 * zadnego bledu.
 */
const textPathPropertiesSchema = z.object({
  type: z.literal('text_path'),
  fieldKey: z.string().optional(),
  text: z.string().optional(),
  placeholder: z.string().optional(),
  // Geometria prowadnicy - liczy ja pakiet, tutaj tylko wpuszczamy wartosci.
  pathShape: z.enum(['arc', 'circle']).default('arc'),
  radiusMm: z.number().positive(),
  startAngle: z.number().default(0),
  sweepAngle: z.number().min(-360).max(360).default(180),
  pathSide: z.enum(['left', 'right']).default('left'),
  pathAlign: z.enum(['baseline', 'center', 'ascender', 'descender']).default('baseline'),
  textPathAlign: z.enum(['start', 'center', 'end']).default('center'),
  pathD: z.string().optional(),
  fontSize: z.number().positive(),
  fontUnit: z.enum(['px', 'pt']).default('pt'),
  fontFamily: z.string().min(1),
  fontWeight: z.number().int().min(100).max(900).default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fill: z.string().default('#000000'),
  textTransform: z.enum(['none', 'uppercase', 'lowercase', 'capitalize']).optional(),
  letterSpacing: z.number().optional(),
  clientFontSize: z.boolean().optional(),
  clientFontFamily: z.boolean().optional(),
  clientColor: z.boolean().optional(),
  clientFontWeight: z.boolean().optional(),
});

const shapePropertiesSchema = z.object({
  type: z.literal('shape'),
  shapeType: z.enum(['rectangle', 'circle', 'ellipse', 'line']),
  fill: z.string().default('transparent'),
  stroke: z.string().default('#000000'),
  strokeWidth: z.number().min(0).default(1),
  // Milimetry maja pierwszenstwo przed pikselami - w mm mysli projektant.
  // Piksele zostaja dla szablonow zapisanych przed ich wprowadzeniem.
  strokeWidthMm: z.number().min(0).optional(),
  borderRadius: z.number().min(0).default(0),
  borderRadiusMm: z.number().min(0).optional(),
  strokeDashArray: z.array(z.number()).optional(),
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
  textPathPropertiesSchema,
  shapePropertiesSchema,
  cutLinePropertiesSchema,
]);

const layerBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['background', 'image', 'text', 'static_text', 'textbox', 'text_path', 'shape', 'cut_line']),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  zIndex: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
  rotation: z.number().default(0),
  // Grupa, do ktorej warstwa nalezy. Pole nieopisane w schemacie jest CICHO
  // wycinane przy zapisie - bez tej linii grupy znikalyby po pierwszym zapisie.
  groupId: z.string().min(1).optional(),
  // Blok z biblioteki, z ktorego warstwa powstala. Dokladnie ta sama pulapka:
  // panel stemplowal to pole, a zapis je wycinal, wiec rozpoznawanie instancji
  // bloku nie mialo na czym stanac.
  blockId: z.string().min(1).optional(),
  properties: layerPropertiesSchema,
});

/**
 * Grupa warstw - pojemnik, nie warstwa. Renderery jej nie czytaja: ustawienia
 * grupy sa zmaterializowane w warstwach, a to jest zapis samego pojemnika
 * (nazwa, zagniezdzenie, ostatnie ustawienia nadane calej grupie).
 */
const layerGroupSettingsSchema = z.object({
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fill: z.string().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  letterSpacing: z.number().optional(),
});

const layerGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).optional(),
  collapsed: z.boolean().optional(),
  settings: layerGroupSettingsSchema.optional(),
});

const fontConfigSchema = z.object({
  family: z.string().min(1),
  src: z.string().min(1),
  weight: z.number().int().min(100).max(900).default(400),
  style: z.enum(['normal', 'italic']).default('normal'),
});

const canvasConfigSchema = z.object({
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  unit: z.enum(['px', 'mm']).default('mm'),
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  formatPreset: z.enum(['WINIETKA_90X50', 'A6_105X148', 'DL_99X210', 'THANK_YOU_148X105', 'CUSTOM']).optional(),
  dpi: z.number().positive().default(300),
  bleed: z.number().min(0).default(0),
  safeArea: z.number().min(0).default(0),
  bleedMm: z.number().min(0).optional(),
  safeAreaMm: z.number().min(0).optional(),
  backgroundColor: z.string().default('#ffffff'),
});

/**
 * Blok wielokrotnego uzytku - warstwy, grupy, fonty i lista assetow.
 *
 * Reuzywa `layerBaseSchema` i `layerGroupSchema` SWIADOMIE: blok nie moze
 * zawierac warstwy w ksztalcie, ktorego layout nie przyjmie - inaczej wstawienie
 * konczyloby sie bledem zapisu dopiero u projektanta.
 */
const templateBlockPayloadSchema = z.object({
  version: z.literal(1).default(1),
  layers: z.array(layerBaseSchema).min(1).max(64),
  groups: z.array(layerGroupSchema).max(16).optional(),
  fonts: z.array(fontConfigSchema).max(16).optional(),
  /** Sciezki grafik uzytych przez warstwy - kopiowane do szablonu docelowego. */
  assets: z.array(z.string().min(1)).max(32).optional(),
});

export type TemplateBlockPayload = z.infer<typeof templateBlockPayloadSchema>;

export const createTemplateBlockSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(60),
  payload: templateBlockPayloadSchema,
  widthMm: z.number().positive().max(2000),
  heightMm: z.number().positive().max(2000),
  tags: z.array(z.string()).max(12).optional(),
  sourceTemplateId: z.string().optional(),
});

export const updateTemplateBlockSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(60).optional(),
  tags: z.array(z.string()).max(12).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

// Strona projektu (wersja 2). Kazda ma wlasny canvas i warstwy.
const templatePageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canvas: canvasConfigSchema,
  layers: z.array(layerBaseSchema).default([]),
  // 64 grupy na stronie to i tak wiecej, niz da sie ogarnac wzrokiem - limit
  // chroni przed zapetlonym zapisem z panelu.
  groups: z.array(layerGroupSchema).max(64).optional(),
});

const printPlacementSchema = z.object({
  pageId: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

const printLayoutSchema = z.object({
  sheet: z.object({
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  placements: z.array(printPlacementSchema).default([]),
  // Brak = tryb wynika z wymiarow stron (shouldPrintPagesSeparately).
  mode: z.enum(['sheet', 'separate']).optional(),
});

/**
 * Pasery Print & Cut. Domyslne wartosci odpowiadaja SILHOUETTE_MARKS_DEFAULT
 * z kp-template-core - te same liczby po obu stronach, bo rozjazd oznacza
 * wydruk, w ktory ploter nie trafi.
 */
const registrationMarksSchema = z.object({
  preset: z.enum(['silhouette', 'none']).default('silhouette'),
  insetTopMm: z.number().min(0).default(15.88),
  insetRightMm: z.number().min(0).default(15.88),
  insetBottomMm: z.number().min(0).default(15.88),
  insetLeftMm: z.number().min(0).default(15.88),
  armLengthMm: z.number().positive().default(10),
  armLengthRightMm: z.number().positive().default(5),
  thicknessMm: z.number().positive().default(0.5),
  color: z.string().default('#000000'),
});

const impositionSlotSchema = z.object({
  id: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  pageId: z.string().min(1).optional(),
});

/** Sklad wielu SZTUK na jednym arkuszu (inne ziarno niz printLayoutSchema). */
const sheetImpositionSchema = z.object({
  enabled: z.boolean().default(false),
  sheet: z.object({
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  slots: z.array(impositionSlotSchema).default([]),
  marks: registrationMarksSchema.optional(),
  backgroundUrl: z.string().min(1).optional(),
  // Podklad per strona. Pusty string jest DOZWOLONY i znaczy "ten arkusz bez
  // podkladu" - stad brak min(1) na wartosci.
  pageBackgrounds: z.record(z.string(), z.string()).optional(),
  // Kalibracje moga byc ujemne, wiec bez min().
  // slotOffset* - uzytki wzgledem paserow (po probnym CIECIU).
  slotOffsetXMm: z.number().optional(),
  slotOffsetYMm: z.number().optional(),
  // sheetOffset* - caly arkusz razem z paserami (po probnym WYDRUKU).
  sheetOffsetXMm: z.number().optional(),
  sheetOffsetYMm: z.number().optional(),
});

const mockupPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const mockupSurfaceSchema = z.object({
  id: z.string().min(1),
  pageId: z.string().min(1),
  corners: z.tuple([mockupPointSchema, mockupPointSchema, mockupPointSchema, mockupPointSchema]),
  blendMode: z.enum(['normal', 'multiply', 'screen', 'overlay']).default('multiply'),
  opacity: z.number().min(0).max(1).default(1),
});

const mockupConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  imageUrl: z.string().min(1),
  surfaces: z.array(mockupSurfaceSchema).default([]),
});

/** Wariant ukladu - wlasny komplet stron dla tego samego produktu. */
const templateVariantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  matchValue: z.string().optional(),
  pages: z.array(templatePageSchema).default([]),
});

export const templateLayoutSchema = z.object({
  // Wersja 2 wprowadza pages/print. Wersja 1 (canvas + layers) nadal akceptowana.
  version: z.union([z.literal(1), z.literal(2)]),
  canvas: canvasConfigSchema,
  fonts: z.array(fontConfigSchema).default([]),
  layers: z.array(layerBaseSchema).default([]),
  // Bez tych pol z.object wycialoby strony przy zapisie (strip nieznanych kluczy).
  pages: z.array(templatePageSchema).optional(),
  variants: z.array(templateVariantSchema).optional(),
  variantFieldKey: z.string().optional(),
  print: printLayoutSchema.optional(),
  imposition: sheetImpositionSchema.optional(),
  mockups: z.array(mockupConfigSchema).optional(),
  // Kolory proponowane klientowi; pilnujemy formatu hex, bo trafiaja wprost
  // do stylu tekstu i do wydruku.
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(24).optional(),
  // Kolor wiodacy motywu - podstawiany pod `currentColor` w warstwach
  // i w podkladzie wektorowym arkusza.
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  // Korekta pozycji wydruku dla TEGO szablonu - kompensuje sposob, w jaki
  // drukarka prowadzi konkretny format. Zakres jak przy korekcie globalnej.
  printOffsetXMm: z.number().min(-20).max(20).optional(),
  printOffsetYMm: z.number().min(-20).max(20).optional(),
});

export const templateAssetParamsSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
});

export type TemplateLayoutInput = z.infer<typeof templateLayoutSchema>;
export type TemplateAssetParams = z.infer<typeof templateAssetParamsSchema>;
