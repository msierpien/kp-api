CREATE TABLE "ai_bulk_content_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "shop_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "action" TEXT NOT NULL,
    "template_id" TEXT,
    "include_images" BOOLEAN NOT NULL DEFAULT true,
    "requested_count" INTEGER NOT NULL DEFAULT 0,
    "pending_count" INTEGER NOT NULL DEFAULT 0,
    "processing_count" INTEGER NOT NULL DEFAULT 0,
    "approval_count" INTEGER NOT NULL DEFAULT 0,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "bullmq_job_id" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_bulk_content_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_bulk_content_job_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "used_image" BOOLEAN NOT NULL DEFAULT false,
    "proposal_json" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_bulk_content_job_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "warehouse_product_id" TEXT,
    "ai_bulk_content_job_id" TEXT,
    "ai_bulk_content_job_item_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'INLINE',
    "used_image" BOOLEAN NOT NULL DEFAULT false,
    "prompt_template_id" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "estimated_cost" DECIMAL(12,6),
    "error_message" TEXT,
    "metadata_json" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_bulk_content_job_items_job_id_warehouse_product_id_key"
    ON "ai_bulk_content_job_items"("job_id", "warehouse_product_id");
CREATE INDEX "ai_bulk_content_jobs_tenant_id_created_at_idx" ON "ai_bulk_content_jobs"("tenant_id", "created_at");
CREATE INDEX "ai_bulk_content_jobs_tenant_id_status_idx" ON "ai_bulk_content_jobs"("tenant_id", "status");
CREATE INDEX "ai_bulk_content_job_items_tenant_id_status_idx" ON "ai_bulk_content_job_items"("tenant_id", "status");
CREATE INDEX "ai_bulk_content_job_items_warehouse_product_id_idx" ON "ai_bulk_content_job_items"("warehouse_product_id");
CREATE INDEX "ai_usage_logs_tenant_id_created_at_idx" ON "ai_usage_logs"("tenant_id", "created_at");
CREATE INDEX "ai_usage_logs_tenant_id_status_idx" ON "ai_usage_logs"("tenant_id", "status");
CREATE INDEX "ai_usage_logs_warehouse_product_id_idx" ON "ai_usage_logs"("warehouse_product_id");
CREATE INDEX "ai_usage_logs_ai_bulk_content_job_id_idx" ON "ai_usage_logs"("ai_bulk_content_job_id");

ALTER TABLE "ai_bulk_content_jobs"
    ADD CONSTRAINT "ai_bulk_content_jobs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_bulk_content_job_items"
    ADD CONSTRAINT "ai_bulk_content_job_items_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ai_bulk_content_job_items_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "ai_bulk_content_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ai_bulk_content_job_items_warehouse_product_id_fkey"
    FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_usage_logs"
    ADD CONSTRAINT "ai_usage_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ai_usage_logs_warehouse_product_id_fkey"
    FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ai_usage_logs_ai_bulk_content_job_id_fkey"
    FOREIGN KEY ("ai_bulk_content_job_id") REFERENCES "ai_bulk_content_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "ai_usage_logs_ai_bulk_content_job_item_id_fkey"
    FOREIGN KEY ("ai_bulk_content_job_item_id") REFERENCES "ai_bulk_content_job_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
