ALTER TABLE "stock_sync_logs"
ADD COLUMN "published_quantity" DECIMAL(10, 3),
ADD COLUMN "availability_policy" TEXT,
ADD COLUMN "out_of_stock_behavior" INTEGER,
ADD COLUMN "warning_message" TEXT;
