-- AlterTable
ALTER TABLE "shop_product_mappings" ADD COLUMN "external_ean" TEXT;

-- CreateIndex
CREATE INDEX "shop_product_mappings_tenant_id_external_ean_idx" ON "shop_product_mappings"("tenant_id", "external_ean");
