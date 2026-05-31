import { FastifyRequest } from 'fastify';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  tenantId: string;
  sessionId?: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user: JwtPayload;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    tenantId: string;
    tenant: {
      id: string;
      name: string;
      slug: string;
      features?: Record<string, boolean>;
    };
  };
}

export interface StatsResponse {
  newCases: number;
  waitingCases: number;
  submittedCases: number;
  readyForPrintCases: number;
  totalCases: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CaseListItem {
  id: string;
  status: string;
  orderReference: string;
  customerEmail: string;
  customerName: string | null;
  productName: string;
  templateName: string;
  submittedAt: Date | null;
  createdAt: Date;
}

export interface SyncLogItem {
  id: string;
  shopName: string;
  syncType: string;
  status: string;
  ordersFetched: number;
  ordersCreated: number;
  ordersSkipped: number;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface PersonalizedProductItem {
  id: string;
  name: string;
  identifierType: string;
  identifierValue: string;
  isActive: boolean;
  shop: { id: string; name: string };
  template: { id: string; name: string; code: string };
  createdAt: Date;
  updatedAt: Date;
}

// Shops / integrations
export type ShopPlatform = 'PRESTASHOP' | 'WOOCOMMERCE' | 'SHOPIFY' | 'MAGENTO' | 'MANUAL' | 'CUSTOM_API' | 'OTHER';

export interface ShopItem {
  id: string;
  name: string;
  platform: ShopPlatform;
  baseUrl: string;
  status: string;
  lastSyncAt: Date | null;
  apiKey: string;
  apiSecret: string | null;
  authType?: 'WEB_SERVICE' | 'ADMIN_API' | 'REST_API' | 'OAUTH' | 'MANUAL';
  config: any;
  hasBulkStock?: boolean;
  bulkStockUrl?: string | null;
  defaultLeadTimeDays?: number | null;
  bulkStockBatchSize?: number | null;
  prestashopShopId?: string | null;
  tenantId: string;
}

export interface CreateShopDto {
  name: string;
  platform: ShopPlatform;
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string | null;
  status: string;
  config?: any; // Elastyczna konfiguracja
  tenantId?: string;
}

export interface UpdateShopDto extends CreateShopDto {}

// Manual Orders
export interface CreateManualOrderDto {
  shopId: string;
  orderReference: string;
  customerEmail: string;
  customerName?: string | null;
  totalPaid: number;
  currency?: string;
  language?: string;
  createdAtShop?: string; // ISO date string
  items: CreateManualOrderItemDto[];
  notes?: string;
}

export interface CreateManualOrderItemDto {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice?: number;
}

export interface ManualOrderResponse {
  orderId: string;
  casesCreated: number;
  message: string;
}
