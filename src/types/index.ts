import { FastifyRequest } from 'fastify';

export interface JwtPayload {
  userId: string;
  email: string;
  role: 'ADMIN' | 'SELLER';
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
    role: string;
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
export interface ShopItem {
  id: string;
  name: string;
  platform: string;
  baseUrl: string;
  status: string;
  lastSyncAt: Date | null;
  apiKey: string;
  apiSecret: string | null;
  authType: 'WEB_SERVICE' | 'ADMIN_API';
  config: {
    orderSync: {
      enabled: boolean;
      intervalMinutes: number;
      orderStatus: string;
    };
    adminApi: {
      clientId: string | null;
      clientSecret: string | null;
      scopes: string[];
    };
  };
}

export interface CreateShopDto {
  name: string;
  platform: string;
  baseUrl: string;
  apiKey: string;
  apiSecret?: string | null;
  status: string;
  authType: 'WEB_SERVICE' | 'ADMIN_API';
  config: {
    orderSync: {
      enabled: boolean;
      intervalMinutes: number;
      orderStatus: string;
    };
    adminApi: {
      clientId: string | null;
      clientSecret: string | null;
      scopes: string[];
    };
  };
}

export interface UpdateShopDto extends CreateShopDto {}
