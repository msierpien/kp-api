-- CreateTable
CREATE TABLE "warehouse_lead_time_groups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lead_time_days" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_lead_time_groups_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "warehouse_products"
ADD COLUMN "lead_time_days_override" INTEGER,
ADD COLUMN "lead_time_group_id" TEXT;

-- AlterTable
ALTER TABLE "stock_sync_logs"
ADD COLUMN "published_lead_time_days" INTEGER,
ADD COLUMN "remote_lead_time_days" INTEGER;

-- AlterTable
ALTER TABLE "wholesale_providers"
ADD COLUMN "lead_time_days" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_lead_time_groups_tenant_id_code_key" ON "warehouse_lead_time_groups"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "warehouse_lead_time_groups_tenant_id_idx" ON "warehouse_lead_time_groups"("tenant_id");

-- CreateIndex
CREATE INDEX "warehouse_lead_time_groups_tenant_id_is_active_idx" ON "warehouse_lead_time_groups"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "warehouse_products_lead_time_group_id_idx" ON "warehouse_products"("lead_time_group_id");

-- AddForeignKey
ALTER TABLE "warehouse_lead_time_groups"
ADD CONSTRAINT "warehouse_lead_time_groups_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_products"
ADD CONSTRAINT "warehouse_products_lead_time_group_id_fkey"
FOREIGN KEY ("lead_time_group_id") REFERENCES "warehouse_lead_time_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Validation
ALTER TABLE "warehouse_lead_time_groups"
ADD CONSTRAINT "warehouse_lead_time_groups_lead_time_days_check"
CHECK ("lead_time_days" >= 0 AND "lead_time_days" <= 365);

ALTER TABLE "warehouse_products"
ADD CONSTRAINT "warehouse_products_lead_time_days_override_check"
CHECK ("lead_time_days_override" IS NULL OR ("lead_time_days_override" >= 0 AND "lead_time_days_override" <= 365));

ALTER TABLE "wholesale_providers"
ADD CONSTRAINT "wholesale_providers_lead_time_days_check"
CHECK ("lead_time_days" IS NULL OR ("lead_time_days" >= 0 AND "lead_time_days" <= 365));

ALTER TABLE "stock_sync_logs"
ADD CONSTRAINT "stock_sync_logs_published_lead_time_days_check"
CHECK ("published_lead_time_days" IS NULL OR ("published_lead_time_days" >= 0 AND "published_lead_time_days" <= 365));

ALTER TABLE "stock_sync_logs"
ADD CONSTRAINT "stock_sync_logs_remote_lead_time_days_check"
CHECK ("remote_lead_time_days" IS NULL OR ("remote_lead_time_days" >= 0 AND "remote_lead_time_days" <= 365));
