export const API_VERSION = process.env.APP_VERSION || '1.1.1';
export const API_CONTRACT_VERSION = Number(process.env.API_CONTRACT_VERSION || 2);
export const MIN_ADMIN_CONTRACT_VERSION = Number(process.env.MIN_ADMIN_CONTRACT_VERSION || 2);
export const MIN_ADMIN_VERSION = process.env.MIN_ADMIN_VERSION || '0.2.0';

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
    compatibilityProfile: 'kp-admin-api',
    apiContractVersion: API_CONTRACT_VERSION,
    minAdminContractVersion: MIN_ADMIN_CONTRACT_VERSION,
    minAdminVersion: MIN_ADMIN_VERSION,
    buildSha: process.env.GIT_SHA || process.env.COMMIT_SHA || null,
    builtAt: process.env.BUILD_DATE || null,
    features: ['ifirma-invoices-v1', 'order-returns-v1'],
  };
}
