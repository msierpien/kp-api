CREATE TABLE "competitor_category_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_category_id" TEXT NOT NULL,
    "source_category_name" TEXT,
    "source_category_path" TEXT,
    "target_category_id" TEXT NOT NULL,
    "target_category_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitor_category_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "competitor_category_mappings_tenant_id_shop_id_source_source_category_id_key"
    ON "competitor_category_mappings"("tenant_id", "shop_id", "source", "source_category_id");

CREATE INDEX "competitor_category_mappings_tenant_id_idx"
    ON "competitor_category_mappings"("tenant_id");

CREATE INDEX "competitor_category_mappings_shop_id_idx"
    ON "competitor_category_mappings"("shop_id");

CREATE INDEX "competitor_category_mappings_source_idx"
    ON "competitor_category_mappings"("source");

ALTER TABLE "competitor_category_mappings"
    ADD CONSTRAINT "competitor_category_mappings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "competitor_category_mappings"
    ADD CONSTRAINT "competitor_category_mappings_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
