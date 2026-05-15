CREATE TYPE "WholesalePlatform" AS ENUM ('CSV_FEED', 'XML_FEED', 'REST_API');

CREATE TABLE "wholesale_providers" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "platform" "WholesalePlatform" NOT NULL DEFAULT 'CSV_FEED',
  "feed_url" TEXT NOT NULL,
  "config_json" JSONB,
  "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wholesale_providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wholesale_product_mappings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "external_sku" TEXT NOT NULL,
  "external_ean" TEXT,
  "external_name" TEXT,
  "external_category" TEXT,
  "warehouse_product_id" TEXT,
  "last_known_stock" DECIMAL(10, 3),
  "last_known_price" DECIMAL(10, 2),
  "payload_json" JSONB,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wholesale_product_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wholesale_sync_logs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SUCCESS',
  "items_fetched" INTEGER NOT NULL DEFAULT 0,
  "mappings_created" INTEGER NOT NULL DEFAULT 0,
  "mappings_updated" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "error_message" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "wholesale_sync_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wholesale_providers_tenant_id_idx"
ON "wholesale_providers"("tenant_id");

CREATE INDEX "wholesale_providers_tenant_id_is_active_idx"
ON "wholesale_providers"("tenant_id", "is_active");

CREATE INDEX "wholesale_providers_tenant_id_sync_enabled_idx"
ON "wholesale_providers"("tenant_id", "sync_enabled");

CREATE UNIQUE INDEX "wholesale_product_mappings_provider_id_external_sku_key"
ON "wholesale_product_mappings"("provider_id", "external_sku");

CREATE INDEX "wholesale_product_mappings_tenant_id_idx"
ON "wholesale_product_mappings"("tenant_id");

CREATE INDEX "wholesale_product_mappings_provider_id_idx"
ON "wholesale_product_mappings"("provider_id");

CREATE INDEX "wholesale_product_mappings_warehouse_product_id_idx"
ON "wholesale_product_mappings"("warehouse_product_id");

CREATE INDEX "wholesale_product_mappings_tenant_id_external_sku_idx"
ON "wholesale_product_mappings"("tenant_id", "external_sku");

CREATE INDEX "wholesale_product_mappings_tenant_id_is_active_idx"
ON "wholesale_product_mappings"("tenant_id", "is_active");

CREATE INDEX "wholesale_sync_logs_tenant_id_idx"
ON "wholesale_sync_logs"("tenant_id");

CREATE INDEX "wholesale_sync_logs_provider_id_idx"
ON "wholesale_sync_logs"("provider_id");

CREATE INDEX "wholesale_sync_logs_status_idx"
ON "wholesale_sync_logs"("status");

CREATE INDEX "wholesale_sync_logs_started_at_idx"
ON "wholesale_sync_logs"("started_at");

ALTER TABLE "wholesale_providers"
ADD CONSTRAINT "wholesale_providers_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_product_mappings"
ADD CONSTRAINT "wholesale_product_mappings_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_product_mappings"
ADD CONSTRAINT "wholesale_product_mappings_provider_id_fkey"
FOREIGN KEY ("provider_id") REFERENCES "wholesale_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_product_mappings"
ADD CONSTRAINT "wholesale_product_mappings_warehouse_product_id_fkey"
FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wholesale_sync_logs"
ADD CONSTRAINT "wholesale_sync_logs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "wholesale_sync_logs"
ADD CONSTRAINT "wholesale_sync_logs_provider_id_fkey"
FOREIGN KEY ("provider_id") REFERENCES "wholesale_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
