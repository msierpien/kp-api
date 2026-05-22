ALTER TABLE "stock_sync_logs"
ADD COLUMN "sync_mode" TEXT,
ADD COLUMN "remote_quantity" DECIMAL(10, 3),
ADD COLUMN "stock_available_id" TEXT,
ADD COLUMN "prestashop_shop_id" TEXT;
