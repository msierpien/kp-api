-- Records the in-stock (local) quantity for the mixed IN_STOCK_WITH_BACKORDER
-- publication, where published_quantity is the combined cap (local + wholesale).
ALTER TABLE "stock_sync_logs"
  ADD COLUMN "in_stock_quantity" DECIMAL(10,3);
