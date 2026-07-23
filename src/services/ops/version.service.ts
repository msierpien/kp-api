export const API_VERSION = process.env.APP_VERSION || '1.6.2';
export const API_CONTRACT_VERSION = Number(process.env.API_CONTRACT_VERSION || 5);
export const MIN_ADMIN_CONTRACT_VERSION = Number(process.env.MIN_ADMIN_CONTRACT_VERSION || 3);
export const MIN_ADMIN_VERSION = process.env.MIN_ADMIN_VERSION || '0.6.0';
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

export type AdminVersionClient = {
  version: string | null;
  apiContractVersion: number | null;
  compatibilityProfile: string | null;
};

export type AdminCompatibilityResult = {
  compatible: boolean;
  label: string;
  reason: string;
  statusCode: 200 | 426;
  client: AdminVersionClient;
  api: ApplicationVersionInfo;
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
      'personalization-case-print-package-v1',
      'personalization-case-answer-validation-v1',
      'personalization-structured-answers-v1',
      'personalization-template-mm-layout-v1',
      'orders-list-v1',
      'product-card-content-v1',
      'prestashop-admin-connector-bridge-v1',
      'prestashop-admin-connector-carrier-restrictions-v1',
      'prestashop-carrier-size-restrictions-v1',
      'public-invoice-pdf-v1',
      'warehouse-full-inventory-v1',
      'warehouse-inventory-scanner-v1',
      'warehouse-mixed-availability-v1',
      'warehouse-stock-tracking-v1',
    ],
  };
}

function parseSemver(version: string) {
  const [major = 0, minor = 0, patch = 0] = version
    .split('-')[0]
    .split('.')
    .map((part) => Number(part) || 0);

  return [major, minor, patch] as const;
}

export function isVersionAtLeast(version: string, minimum: string) {
  const current = parseSemver(version);
  const required = parseSemver(minimum);

  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }

  return true;
}

function normalizeHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string) {
  return normalizeHeaderValue(headers[name.toLowerCase()] ?? headers[name]);
}

export function readAdminVersionClient(
  headers: Record<string, string | string[] | undefined>
): AdminVersionClient {
  const apiContractVersionHeader = getHeader(headers, 'X-Admin-Api-Contract-Version');
  const apiContractVersion = apiContractVersionHeader ? Number(apiContractVersionHeader) : NaN;

  return {
    version: getHeader(headers, 'X-Admin-Version'),
    apiContractVersion: Number.isFinite(apiContractVersion) ? apiContractVersion : null,
    compatibilityProfile: getHeader(headers, 'X-Admin-Compatibility-Profile'),
  };
}

export function getAdminCompatibility(
  client: AdminVersionClient,
  environment: string
): AdminCompatibilityResult {
  const api = getApplicationVersionInfo(environment);

  if (client.compatibilityProfile !== COMPATIBILITY_PROFILE) {
    return {
      compatible: false,
      label: 'Niezgodny profil',
      reason: `Admin musi wysylac profil ${COMPATIBILITY_PROFILE}, otrzymano ${client.compatibilityProfile || 'brak'}.`,
      statusCode: 426,
      client,
      api,
    };
  }

  if (client.apiContractVersion === null) {
    return {
      compatible: false,
      label: 'Brak kontraktu',
      reason: 'Admin nie wyslal numeru kontraktu API.',
      statusCode: 426,
      client,
      api,
    };
  }

  const contractCompatible =
    MIN_ADMIN_CONTRACT_VERSION <= client.apiContractVersion &&
    client.apiContractVersion <= API_CONTRACT_VERSION;

  if (!contractCompatible) {
    return {
      compatible: false,
      label: 'Niezgodny kontrakt',
      reason: `Admin wysyla kontrakt ${client.apiContractVersion}, API obsluguje zakres ${MIN_ADMIN_CONTRACT_VERSION}-${API_CONTRACT_VERSION}.`,
      statusCode: 426,
      client,
      api,
    };
  }

  if (!client.version) {
    return {
      compatible: false,
      label: 'Brak wersji admina',
      reason: `API wymaga admina co najmniej ${MIN_ADMIN_VERSION}, ale request nie zawiera wersji admina.`,
      statusCode: 426,
      client,
      api,
    };
  }

  if (!isVersionAtLeast(client.version, MIN_ADMIN_VERSION)) {
    return {
      compatible: false,
      label: 'Admin za stary',
      reason: `API wymaga admina co najmniej ${MIN_ADMIN_VERSION}, otrzymano ${client.version}.`,
      statusCode: 426,
      client,
      api,
    };
  }

  return {
    compatible: true,
    label: 'Zgodne',
    reason: `Admin v${client.version}, API v${API_VERSION}, kontrakt ${client.apiContractVersion}.`,
    statusCode: 200,
    client,
    api,
  };
}

export function getAdminCompatibilityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  environment: string
) {
  return getAdminCompatibility(readAdminVersionClient(headers), environment);
}
