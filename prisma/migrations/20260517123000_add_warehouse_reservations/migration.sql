CREATE TYPE "WarehouseReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'CANCELLED');

CREATE TABLE "warehouse_reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "quantity" DECIMAL(10, 3) NOT NULL,
    "status" "WarehouseReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "released_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_reservations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_reservations_tenant_id_idx" ON "warehouse_reservations"("tenant_id");
CREATE INDEX "warehouse_reservations_warehouse_product_id_idx" ON "warehouse_reservations"("warehouse_product_id");
CREATE INDEX "warehouse_reservations_order_id_idx" ON "warehouse_reservations"("order_id");
CREATE INDEX "warehouse_reservations_order_item_id_idx" ON "warehouse_reservations"("order_item_id");
CREATE INDEX "warehouse_reservations_tenant_id_status_idx" ON "warehouse_reservations"("tenant_id", "status");
CREATE INDEX "warehouse_reservations_tenant_id_created_at_idx" ON "warehouse_reservations"("tenant_id", "created_at");
CREATE INDEX "warehouse_reservations_warehouse_product_id_status_idx" ON "warehouse_reservations"("warehouse_product_id", "status");
CREATE INDEX "warehouse_reservations_order_id_status_idx" ON "warehouse_reservations"("order_id", "status");

ALTER TABLE "warehouse_reservations"
ADD CONSTRAINT "warehouse_reservations_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_reservations"
ADD CONSTRAINT "warehouse_reservations_warehouse_product_id_fkey"
FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_reservations"
ADD CONSTRAINT "warehouse_reservations_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_reservations"
ADD CONSTRAINT "warehouse_reservations_order_item_id_fkey"
FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
