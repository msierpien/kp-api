ALTER TABLE "stock_sync_logs"
ADD COLUMN "published_product_active" BOOLEAN,
ADD COLUMN "external_product_id" TEXT;

ALTER TABLE "wholesale_sync_logs"
ADD COLUMN "mappings_unchanged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "products_recalculated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "stock_sync_enqueued" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "stock_sync_skipped" INTEGER NOT NULL DEFAULT 0;
