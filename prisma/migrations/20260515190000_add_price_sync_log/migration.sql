-- CreateTable
CREATE TABLE "price_sync_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shop_product_mapping_id" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "price_before" DECIMAL(10,2),
    "price_after" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_sync_logs_tenant_id_idx" ON "price_sync_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "price_sync_logs_warehouse_product_id_idx" ON "price_sync_logs"("warehouse_product_id");

-- CreateIndex
CREATE INDEX "price_sync_logs_shop_id_idx" ON "price_sync_logs"("shop_id");

-- CreateIndex
CREATE INDEX "price_sync_logs_shop_product_mapping_id_idx" ON "price_sync_logs"("shop_product_mapping_id");

-- CreateIndex
CREATE INDEX "price_sync_logs_status_idx" ON "price_sync_logs"("status");

-- CreateIndex
CREATE INDEX "price_sync_logs_created_at_idx" ON "price_sync_logs"("created_at");

-- AddForeignKey
ALTER TABLE "price_sync_logs" ADD CONSTRAINT "price_sync_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_sync_logs" ADD CONSTRAINT "price_sync_logs_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_sync_logs" ADD CONSTRAINT "price_sync_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_sync_logs" ADD CONSTRAINT "price_sync_logs_shop_product_mapping_id_fkey" FOREIGN KEY ("shop_product_mapping_id") REFERENCES "shop_product_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
