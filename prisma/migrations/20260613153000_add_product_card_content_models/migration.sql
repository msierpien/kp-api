CREATE TABLE "product_channel_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_channel_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_channel_sync_configs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "fields_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_channel_sync_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_card_operation_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "shop_id" TEXT,
    "section" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'PANEL_TO_SHOP',
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "request_hash" TEXT,
    "response_hash" TEXT,
    "error_message" TEXT,
    "payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_card_operation_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_channel_snapshots_warehouse_product_id_shop_id_key" ON "product_channel_snapshots"("warehouse_product_id", "shop_id");
CREATE INDEX "product_channel_snapshots_tenant_id_idx" ON "product_channel_snapshots"("tenant_id");
CREATE INDEX "product_channel_snapshots_warehouse_product_id_idx" ON "product_channel_snapshots"("warehouse_product_id");
CREATE INDEX "product_channel_snapshots_shop_id_idx" ON "product_channel_snapshots"("shop_id");
CREATE INDEX "product_channel_snapshots_tenant_id_fetched_at_idx" ON "product_channel_snapshots"("tenant_id", "fetched_at");

CREATE UNIQUE INDEX "product_channel_sync_configs_warehouse_product_id_shop_id_key" ON "product_channel_sync_configs"("warehouse_product_id", "shop_id");
CREATE INDEX "product_channel_sync_configs_tenant_id_idx" ON "product_channel_sync_configs"("tenant_id");
CREATE INDEX "product_channel_sync_configs_warehouse_product_id_idx" ON "product_channel_sync_configs"("warehouse_product_id");
CREATE INDEX "product_channel_sync_configs_shop_id_idx" ON "product_channel_sync_configs"("shop_id");

CREATE INDEX "product_card_operation_logs_tenant_id_idx" ON "product_card_operation_logs"("tenant_id");
CREATE INDEX "product_card_operation_logs_warehouse_product_id_idx" ON "product_card_operation_logs"("warehouse_product_id");
CREATE INDEX "product_card_operation_logs_shop_id_idx" ON "product_card_operation_logs"("shop_id");
CREATE INDEX "product_card_operation_logs_status_idx" ON "product_card_operation_logs"("status");
CREATE INDEX "product_card_operation_logs_created_at_idx" ON "product_card_operation_logs"("created_at");

ALTER TABLE "product_channel_snapshots" ADD CONSTRAINT "product_channel_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_channel_snapshots" ADD CONSTRAINT "product_channel_snapshots_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_channel_snapshots" ADD CONSTRAINT "product_channel_snapshots_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_channel_sync_configs" ADD CONSTRAINT "product_channel_sync_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_channel_sync_configs" ADD CONSTRAINT "product_channel_sync_configs_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_channel_sync_configs" ADD CONSTRAINT "product_channel_sync_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_card_operation_logs" ADD CONSTRAINT "product_card_operation_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_card_operation_logs" ADD CONSTRAINT "product_card_operation_logs_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_card_operation_logs" ADD CONSTRAINT "product_card_operation_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
