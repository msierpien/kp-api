CREATE TABLE "warehouse_price_groups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_price_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_price_group_members" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "price_group_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_price_group_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_pricing_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "default_margin_percent" DECIMAL(7,3) NOT NULL DEFAULT 30,
    "default_min_profit" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "default_vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 23,
    "default_rounding_mode" TEXT NOT NULL DEFAULT 'END_99',
    "default_sync_mode" TEXT NOT NULL DEFAULT 'CONFIRM',
    "cost_ceiling_enabled_default" BOOLEAN NOT NULL DEFAULT true,
    "abnormal_profit_threshold" DECIMAL(7,3) NOT NULL DEFAULT 200,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_pricing_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "warehouse_pricing_rules"
  ADD COLUMN "price_group_id" TEXT,
  ADD COLUMN "price_mode" TEXT NOT NULL DEFAULT 'MARGIN',
  ADD COLUMN "cost_ceiling_enabled" BOOLEAN;

UPDATE "warehouse_pricing_rules"
SET "price_mode" = CASE WHEN "fixed_net_price" IS NOT NULL THEN 'FIXED' ELSE 'MARGIN' END;

INSERT INTO "warehouse_pricing_settings" (
  "id",
  "tenant_id",
  "default_margin_percent",
  "default_min_profit",
  "default_vat_rate",
  "default_rounding_mode",
  "default_sync_mode",
  "cost_ceiling_enabled_default",
  "abnormal_profit_threshold",
  "created_at",
  "updated_at"
)
SELECT
  'pricing-settings-' || t."id",
  t."id",
  COALESCE(r."margin_percent", 30),
  COALESCE(r."min_profit", 1),
  COALESCE(r."vat_rate", 23),
  COALESCE(r."rounding_mode", 'END_99'),
  COALESCE(r."sync_mode", 'CONFIRM'),
  true,
  200,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenants" t
LEFT JOIN LATERAL (
  SELECT *
  FROM "warehouse_pricing_rules" r
  WHERE r."tenant_id" = t."id"
    AND r."level" = 'GLOBAL'
    AND r."is_active" = true
  ORDER BY r."updated_at" DESC
  LIMIT 1
) r ON true;

ALTER TABLE "warehouse_pricing_rules"
  ALTER COLUMN "vat_rate" DROP NOT NULL,
  ALTER COLUMN "vat_rate" DROP DEFAULT,
  ALTER COLUMN "rounding_mode" DROP NOT NULL,
  ALTER COLUMN "rounding_mode" DROP DEFAULT,
  ALTER COLUMN "sync_mode" DROP NOT NULL,
  ALTER COLUMN "sync_mode" DROP DEFAULT;

UPDATE "warehouse_pricing_rules" r
SET
  "vat_rate" = CASE WHEN r."vat_rate" = s."default_vat_rate" THEN NULL ELSE r."vat_rate" END,
  "rounding_mode" = CASE WHEN r."rounding_mode" = s."default_rounding_mode" THEN NULL ELSE r."rounding_mode" END,
  "sync_mode" = CASE WHEN r."sync_mode" = s."default_sync_mode" THEN NULL ELSE r."sync_mode" END
FROM "warehouse_pricing_settings" s
WHERE r."tenant_id" = s."tenant_id";

UPDATE "warehouse_pricing_rules"
SET "is_active" = false
WHERE "level" = 'GLOBAL'
  AND "is_active" = true;

ALTER TABLE "warehouse_product_shop_prices"
  ADD COLUMN "pricing_rule_level" TEXT,
  ADD COLUMN "price_source" TEXT,
  ADD COLUMN "price_mode" TEXT,
  ADD COLUMN "price_group_id" TEXT,
  ADD COLUMN "price_group_name" TEXT,
  ADD COLUMN "configured_margin_percent" DECIMAL(7,3),
  ADD COLUMN "realized_margin_percent" DECIMAL(7,3),
  ADD COLUMN "info_code" TEXT,
  ADD COLUMN "overrides_group" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sync_mode" TEXT;

CREATE UNIQUE INDEX "warehouse_price_groups_tenant_id_name_key" ON "warehouse_price_groups"("tenant_id", "name");
CREATE INDEX "warehouse_price_groups_tenant_id_idx" ON "warehouse_price_groups"("tenant_id");
CREATE INDEX "warehouse_price_groups_tenant_id_is_active_idx" ON "warehouse_price_groups"("tenant_id", "is_active");

CREATE UNIQUE INDEX "warehouse_price_group_members_price_group_id_warehouse_product_id_key"
ON "warehouse_price_group_members"("price_group_id", "warehouse_product_id");
CREATE INDEX "warehouse_price_group_members_tenant_id_idx" ON "warehouse_price_group_members"("tenant_id");
CREATE INDEX "warehouse_price_group_members_tenant_id_warehouse_product_id_idx"
ON "warehouse_price_group_members"("tenant_id", "warehouse_product_id");
CREATE INDEX "warehouse_price_group_members_price_group_id_idx" ON "warehouse_price_group_members"("price_group_id");
CREATE INDEX "warehouse_price_group_members_warehouse_product_id_idx" ON "warehouse_price_group_members"("warehouse_product_id");

CREATE UNIQUE INDEX "warehouse_pricing_settings_tenant_id_key" ON "warehouse_pricing_settings"("tenant_id");

CREATE INDEX "warehouse_pricing_rules_price_group_id_idx" ON "warehouse_pricing_rules"("price_group_id");

ALTER TABLE "warehouse_price_groups"
  ADD CONSTRAINT "warehouse_price_groups_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_price_group_members"
  ADD CONSTRAINT "warehouse_price_group_members_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_price_group_members"
  ADD CONSTRAINT "warehouse_price_group_members_price_group_id_fkey"
  FOREIGN KEY ("price_group_id") REFERENCES "warehouse_price_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_price_group_members"
  ADD CONSTRAINT "warehouse_price_group_members_warehouse_product_id_fkey"
  FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_pricing_settings"
  ADD CONSTRAINT "warehouse_pricing_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_pricing_rules"
  ADD CONSTRAINT "warehouse_pricing_rules_price_group_id_fkey"
  FOREIGN KEY ("price_group_id") REFERENCES "warehouse_price_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
