export const API_VERSION = process.env.APP_VERSION || '1.3.9';
export const API_CONTRACT_VERSION = Number(process.env.API_CONTRACT_VERSION || 3);
export const MIN_ADMIN_CONTRACT_VERSION = Number(process.env.MIN_ADMIN_CONTRACT_VERSION || 2);
export const MIN_ADMIN_VERSION = process.env.MIN_ADMIN_VERSION || '0.3.0';
export const COMPATIBILITY_PROFILE = 'kp-admin-api';

export type ApplicationVersionInfo = {
  name: string;
  version: string;
  environment: string;
  compatibilityProfile: string;
  apiContractVersion: number;
  minAdminContractVersion: number;
  minAdminVersion: string;
  buildSha: string | null;
  builtAt: string | null;
  features: string[];
};

export function getApplicationVersionInfo(environment: string): ApplicationVersionInfo {
  return {
    name: 'Personalization API',
    version: API_VERSION,
    environment,
    compatibilityProfile: COMPATIBILITY_PROFILE,
    apiContractVersion: API_CONTRACT_VERSION,
    minAdminContractVersion: MIN_ADMIN_CONTRACT_VERSION,
    minAdminVersion: MIN_ADMIN_VERSION,
    buildSha: process.env.GIT_SHA || process.env.COMMIT_SHA || null,
    builtAt: process.env.BUILD_DATE || null,
    features: [
      'ifirma-invoices-v1',
      'invoice-prestashop-delivery-v1',
      'order-returns-v1',
      'order-status-mapping-v1',
      'orders-list-v1',
      'product-card-content-v1',
      'prestashop-admin-connector-bridge-v1',
      'public-invoice-pdf-v1',
      'warehouse-full-inventory-v1',
    ],
  };
}
