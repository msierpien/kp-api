ALTER TABLE "warehouse_products"
ADD COLUMN "reorder_point" DECIMAL(10, 3),
ADD COLUMN "reorder_quantity" DECIMAL(10, 3);

ALTER TABLE "warehouse_products"
ADD CONSTRAINT "warehouse_products_reorder_point_check"
CHECK ("reorder_point" IS NULL OR "reorder_point" >= 0),
ADD CONSTRAINT "warehouse_products_reorder_quantity_check"
CHECK ("reorder_quantity" IS NULL OR "reorder_quantity" > 0);
