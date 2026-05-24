import prisma from './prisma';

export const FEATURE_PERSONALIZATION_EDITOR = 'personalization_editor' as const;
const TENANT_FEATURES_CACHE_TTL_MS = Number(process.env.TENANT_FEATURES_CACHE_TTL_MS ?? 60_000);

export type TenantFeature = typeof FEATURE_PERSONALIZATION_EDITOR;

export type TenantFeatures = Partial<Record<TenantFeature, boolean>>;

type TenantFeaturesCacheEntry = {
  features: TenantFeatures;
  expiresAt: number;
};

const tenantFeaturesCache = new Map<string, TenantFeaturesCacheEntry>();

export function normalizeFeatures(value: unknown): TenantFeatures {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    [FEATURE_PERSONALIZATION_EDITOR]: raw[FEATURE_PERSONALIZATION_EDITOR] === true,
  };
}

export function clearTenantFeaturesCache(tenantId?: string): void {
  if (tenantId) {
    tenantFeaturesCache.delete(tenantId);
    return;
  }

  tenantFeaturesCache.clear();
}

export async function getTenantFeatures(tenantId: string): Promise<TenantFeatures> {
  const cached = tenantFeaturesCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.features;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { featuresJson: true },
  });

  const features = normalizeFeatures(tenant?.featuresJson);
  tenantFeaturesCache.set(tenantId, {
    features,
    expiresAt: Date.now() + TENANT_FEATURES_CACHE_TTL_MS,
  });

  return features;
}

export async function tenantHasFeature(tenantId: string, feature: TenantFeature): Promise<boolean> {
  const features = await getTenantFeatures(tenantId);
  return features[feature] === true;
}
