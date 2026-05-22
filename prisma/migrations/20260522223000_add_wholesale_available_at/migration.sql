-- Track trustworthy warehouse availability dates from wholesale feeds.
ALTER TABLE "wholesale_product_mappings"
ADD COLUMN "warehouse_available_at" TIMESTAMP(3);

ALTER TABLE "stock_sync_logs"
ADD COLUMN "published_warehouse_available_at" TIMESTAMP(3),
ADD COLUMN "remote_warehouse_available_at" TIMESTAMP(3);
