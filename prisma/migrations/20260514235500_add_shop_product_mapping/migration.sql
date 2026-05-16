CREATE TABLE "shop_product_mappings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "external_product_id" TEXT NOT NULL,
  "external_sku" TEXT NOT NULL,
  "external_name" TEXT,
  "warehouse_product_id" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shop_product_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_product_mappings_shop_id_external_product_id_key"
ON "shop_product_mappings"("shop_id", "external_product_id");

CREATE INDEX "shop_product_mappings_tenant_id_idx"
ON "shop_product_mappings"("tenant_id");

CREATE INDEX "shop_product_mappings_shop_id_idx"
ON "shop_product_mappings"("shop_id");

CREATE INDEX "shop_product_mappings_warehouse_product_id_idx"
ON "shop_product_mappings"("warehouse_product_id");

CREATE INDEX "shop_product_mappings_tenant_id_external_sku_idx"
ON "shop_product_mappings"("tenant_id", "external_sku");

CREATE INDEX "shop_product_mappings_tenant_id_is_active_idx"
ON "shop_product_mappings"("tenant_id", "is_active");

ALTER TABLE "shop_product_mappings"
ADD CONSTRAINT "shop_product_mappings_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shop_product_mappings"
ADD CONSTRAINT "shop_product_mappings_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shop_product_mappings"
ADD CONSTRAINT "shop_product_mappings_warehouse_product_id_fkey"
FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
