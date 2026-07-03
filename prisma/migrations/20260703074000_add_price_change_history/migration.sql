-- CreateTable
CREATE TABLE "price_change_history" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shop_product_mapping_id" TEXT NOT NULL,
    "price_sync_log_id" TEXT,
    "triggered_by" TEXT NOT NULL,
    "price_before" DECIMAL(10,2),
    "price_after" DECIMAL(10,2) NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_change_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_change_history_tenant_id_idx" ON "price_change_history"("tenant_id");

-- CreateIndex
CREATE INDEX "price_change_history_warehouse_product_id_idx" ON "price_change_history"("warehouse_product_id");

-- CreateIndex
CREATE INDEX "price_change_history_shop_id_idx" ON "price_change_history"("shop_id");

-- CreateIndex
CREATE INDEX "price_change_history_shop_product_mapping_id_idx" ON "price_change_history"("shop_product_mapping_id");

-- CreateIndex
CREATE INDEX "price_change_history_price_sync_log_id_idx" ON "price_change_history"("price_sync_log_id");

-- CreateIndex
CREATE INDEX "price_change_history_tenant_id_warehouse_product_id_shop_id_changed_at_idx" ON "price_change_history"("tenant_id", "warehouse_product_id", "shop_id", "changed_at");

-- AddForeignKey
ALTER TABLE "price_change_history" ADD CONSTRAINT "price_change_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_change_history" ADD CONSTRAINT "price_change_history_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_change_history" ADD CONSTRAINT "price_change_history_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_change_history" ADD CONSTRAINT "price_change_history_shop_product_mapping_id_fkey" FOREIGN KEY ("shop_product_mapping_id") REFERENCES "shop_product_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_change_history" ADD CONSTRAINT "price_change_history_price_sync_log_id_fkey" FOREIGN KEY ("price_sync_log_id") REFERENCES "price_sync_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
