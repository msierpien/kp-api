-- CreateTable
CREATE TABLE "shop_product_import_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "items_fetched" INTEGER NOT NULL DEFAULT 0,
    "mappings_created" INTEGER NOT NULL DEFAULT 0,
    "mappings_updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "skipped_no_sku" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_product_import_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_product_import_logs_tenant_id_idx" ON "shop_product_import_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "shop_product_import_logs_shop_id_idx" ON "shop_product_import_logs"("shop_id");

-- CreateIndex
CREATE INDEX "shop_product_import_logs_status_idx" ON "shop_product_import_logs"("status");

-- CreateIndex
CREATE INDEX "shop_product_import_logs_started_at_idx" ON "shop_product_import_logs"("started_at");

-- AddForeignKey
ALTER TABLE "shop_product_import_logs" ADD CONSTRAINT "shop_product_import_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_product_import_logs" ADD CONSTRAINT "shop_product_import_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
