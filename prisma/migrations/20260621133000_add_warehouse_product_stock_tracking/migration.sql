-- Add a separate warehouse tracking flag so products can stay active/mapped
-- without participating in stock control and full inventory sessions.
ALTER TABLE "warehouse_products"
  ADD COLUMN "is_stock_tracked" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "warehouse_products_tenant_active_stock_tracked_idx"
  ON "warehouse_products"("tenant_id", "is_active", "is_stock_tracked");
