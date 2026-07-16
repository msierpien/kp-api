ALTER TABLE "wholesale_sync_logs"
ADD COLUMN "baseline_items" INTEGER,
ADD COLUMN "feed_drop_percent" DECIMAL(5,2),
ADD COLUMN "validation_status" TEXT;

CREATE UNLOGGED TABLE "wholesale_feed_staging_items" (
  "id" TEXT NOT NULL,
  "sync_log_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "external_sku" TEXT NOT NULL,
  "external_ean" TEXT,
  "external_name" TEXT,
  "external_category" TEXT,
  "last_known_stock" DECIMAL(10,3),
  "last_known_price" DECIMAL(10,2),
  "warehouse_available_at" TIMESTAMP(3),
  "payload_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wholesale_feed_staging_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wholesale_feed_staging_items_sync_log_id_fkey"
    FOREIGN KEY ("sync_log_id") REFERENCES "wholesale_sync_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wholesale_feed_staging_items_sync_log_id_external_sku_key"
ON "wholesale_feed_staging_items"("sync_log_id", "external_sku");

CREATE INDEX "wholesale_feed_staging_items_provider_id_external_sku_idx"
ON "wholesale_feed_staging_items"("provider_id", "external_sku");

CREATE INDEX "wholesale_feed_staging_items_tenant_id_idx"
ON "wholesale_feed_staging_items"("tenant_id");
