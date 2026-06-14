ALTER TABLE "shop_order_statuses"
  ADD COLUMN "operational_status" TEXT;

CREATE INDEX "shop_order_statuses_tenant_id_operational_status_idx"
  ON "shop_order_statuses"("tenant_id", "operational_status");

CREATE INDEX "orders_shop_id_created_at_shop_idx"
  ON "orders"("shop_id", "created_at_shop");

CREATE INDEX "orders_shop_id_max_shipping_date_idx"
  ON "orders"("shop_id", "max_shipping_date");
