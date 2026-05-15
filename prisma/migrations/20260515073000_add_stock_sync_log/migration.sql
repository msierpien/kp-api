CREATE TABLE "stock_sync_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "document_id" TEXT,
    "stock_before" DECIMAL(10, 3),
    "stock_after" DECIMAL(10, 3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_sync_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_sync_logs_tenant_id_idx" ON "stock_sync_logs"("tenant_id");
CREATE INDEX "stock_sync_logs_warehouse_product_id_idx" ON "stock_sync_logs"("warehouse_product_id");
CREATE INDEX "stock_sync_logs_shop_id_idx" ON "stock_sync_logs"("shop_id");
CREATE INDEX "stock_sync_logs_status_idx" ON "stock_sync_logs"("status");
CREATE INDEX "stock_sync_logs_created_at_idx" ON "stock_sync_logs"("created_at");

ALTER TABLE "stock_sync_logs" ADD CONSTRAINT "stock_sync_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_sync_logs" ADD CONSTRAINT "stock_sync_logs_warehouse_product_id_fkey"
    FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_sync_logs" ADD CONSTRAINT "stock_sync_logs_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "stock_sync_logs" ADD CONSTRAINT "stock_sync_logs_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "warehouse_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
