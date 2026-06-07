-- Order import with bundle component snapshots and KP API stock ownership.

CREATE TYPE "OrderItemSourceType" AS ENUM ('SIMPLE', 'BUNDLE_COMPONENT');
CREATE TYPE "WarehouseReservationSource" AS ENUM ('LOCAL_STOCK', 'WHOLESALE_BACKORDER');

ALTER TABLE "orders"
  ADD COLUMN "max_shipping_date" TIMESTAMP(3),
  ADD COLUMN "shipping_promise_label" TEXT,
  ADD COLUMN "shipping_cutoff_used_at" TIMESTAMP(3);

ALTER TABLE "order_items"
  ADD COLUMN "source_type" "OrderItemSourceType" NOT NULL DEFAULT 'SIMPLE',
  ADD COLUMN "bundle_group_id" TEXT,
  ADD COLUMN "bundle_name" TEXT,
  ADD COLUMN "bundle_external_item_id" TEXT,
  ADD COLUMN "bundle_external_product_id" TEXT,
  ADD COLUMN "shipping_date" TIMESTAMP(3),
  ADD COLUMN "shipping_lead_time_days" INTEGER,
  ADD COLUMN "shipping_source" TEXT;

ALTER TABLE "warehouse_reservations"
  ADD COLUMN "source" "WarehouseReservationSource" NOT NULL DEFAULT 'LOCAL_STOCK',
  ADD COLUMN "expected_ship_date" TIMESTAMP(3);

CREATE INDEX "order_items_source_type_idx" ON "order_items"("source_type");
CREATE INDEX "order_items_bundle_group_id_idx" ON "order_items"("bundle_group_id");

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_shipping_lead_time_days_check"
  CHECK ("shipping_lead_time_days" IS NULL OR "shipping_lead_time_days" >= 0);
