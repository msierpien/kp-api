ALTER TABLE "order_items"
ADD COLUMN "warehouse_product_id" TEXT;

ALTER TABLE "warehouse_document_items"
ADD COLUMN "reservation_id" TEXT;

CREATE INDEX "order_items_warehouse_product_id_idx" ON "order_items"("warehouse_product_id");
CREATE INDEX "warehouse_document_items_reservation_id_idx" ON "warehouse_document_items"("reservation_id");

CREATE UNIQUE INDEX "warehouse_reservations_active_order_item_uidx"
ON "warehouse_reservations"("order_item_id")
WHERE "status" = 'ACTIVE' AND "order_item_id" IS NOT NULL;

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_warehouse_product_id_fkey"
FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_document_items"
ADD CONSTRAINT "warehouse_document_items_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "warehouse_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
