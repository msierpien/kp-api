import prisma from './prisma';

export const FEATURE_PERSONALIZATION_EDITOR = 'personalization_editor' as const;

export type TenantFeature = typeof FEATURE_PERSONALIZATION_EDITOR;

export type TenantFeatures = Partial<Record<TenantFeature, boolean>>;

export function normalizeFeatures(value: unknown): TenantFeatures {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    [FEATURE_PERSONALIZATION_EDITOR]: raw[FEATURE_PERSONALIZATION_EDITOR] === true,
  };
}

export async function getTenantFeatures(tenantId: string): Promise<TenantFeatures> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { featuresJson: true },
  });

  return normalizeFeatures(tenant?.featuresJson);
}

export async function tenantHasFeature(tenantId: string, feature: TenantFeature): Promise<boolean> {
  const features = await getTenantFeatures(tenantId);
  return features[feature] === true;
}
