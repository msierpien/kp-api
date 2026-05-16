-- Add tenant feature flags.
ALTER TABLE "tenants" ADD COLUMN "features_json" JSONB;

UPDATE "tenants"
SET "features_json" = jsonb_build_object('personalization_editor', true)
WHERE "slug" = 'kreatywne-papierki';

UPDATE "tenants"
SET "features_json" = jsonb_build_object('personalization_editor', false)
WHERE "features_json" IS NULL;

-- Attach optional personalization configuration to the existing shop -> warehouse mapping.
ALTER TABLE "shop_product_mappings"
ADD COLUMN "personalization_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "personalization_template_id" TEXT;

ALTER TABLE "shop_product_mappings"
ADD CONSTRAINT "shop_product_mappings_personalization_template_id_fkey"
FOREIGN KEY ("personalization_template_id") REFERENCES "personalization_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "shop_product_mappings_tenant_id_personalization_enabled_idx"
ON "shop_product_mappings"("tenant_id", "personalization_enabled");

CREATE INDEX "shop_product_mappings_personalization_template_id_idx"
ON "shop_product_mappings"("personalization_template_id");

-- Best-effort migration from the legacy PersonalizedProduct table.
-- SKU and EAN can be matched against imported shop mappings. INDEX remains as legacy fallback
-- because imported product mappings do not currently store supplier_reference separately.
UPDATE "shop_product_mappings" spm
SET
  "personalization_enabled" = true,
  "personalization_template_id" = pp."template_id"
FROM "personalized_products" pp
WHERE
  pp."shop_id" = spm."shop_id"
  AND pp."is_active" = true
  AND (
    (pp."identifier_type" = 'SKU' AND lower(pp."identifier_value") = lower(spm."external_sku"))
    OR (pp."identifier_type" = 'EAN' AND spm."external_ean" IS NOT NULL AND lower(pp."identifier_value") = lower(spm."external_ean"))
  );
