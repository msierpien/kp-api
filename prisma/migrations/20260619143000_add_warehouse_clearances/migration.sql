-- Add manual clearance prices for product/group pricing workflows.
CREATE TABLE "warehouse_clearances" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "warehouse_product_id" TEXT,
  "price_group_id" TEXT,
  "shop_id" TEXT,
  "clearance_net_price" DECIMAL(10, 2) NOT NULL,
  "reason" TEXT,
  "valid_from" TIMESTAMP(3),
  "valid_to" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "warehouse_clearances_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "warehouse_clearances"
  ADD CONSTRAINT "warehouse_clearances_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_clearances"
  ADD CONSTRAINT "warehouse_clearances_warehouse_product_id_fkey"
  FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_clearances"
  ADD CONSTRAINT "warehouse_clearances_price_group_id_fkey"
  FOREIGN KEY ("price_group_id") REFERENCES "warehouse_price_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_clearances"
  ADD CONSTRAINT "warehouse_clearances_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "warehouse_clearances_tenant_id_is_active_valid_from_valid_to_idx"
  ON "warehouse_clearances"("tenant_id", "is_active", "valid_from", "valid_to");

CREATE INDEX "warehouse_clearances_tenant_id_scope_idx"
  ON "warehouse_clearances"("tenant_id", "scope");

CREATE INDEX "warehouse_clearances_warehouse_product_id_idx"
  ON "warehouse_clearances"("warehouse_product_id");

CREATE INDEX "warehouse_clearances_price_group_id_idx"
  ON "warehouse_clearances"("price_group_id");

CREATE INDEX "warehouse_clearances_shop_id_idx"
  ON "warehouse_clearances"("shop_id");

ALTER TABLE "warehouse_product_shop_prices"
  ADD COLUMN "clearance_id" TEXT,
  ADD COLUMN "clearance_until" TIMESTAMP(3);
