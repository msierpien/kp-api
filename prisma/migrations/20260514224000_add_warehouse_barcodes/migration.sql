-- Add barcode support for warehouse products and document item scan snapshots.

CREATE TABLE "warehouse_product_barcodes" (
    "id"                  TEXT NOT NULL,
    "tenant_id"           TEXT NOT NULL,
    "warehouse_product_id" TEXT NOT NULL,
    "ean"                 TEXT NOT NULL,
    "label"               TEXT,
    "quantity_multiplier" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "is_primary"          BOOLEAN NOT NULL DEFAULT false,
    "is_active"           BOOLEAN NOT NULL DEFAULT true,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_product_barcodes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "warehouse_document_items"
    ADD COLUMN "barcode_id" TEXT,
    ADD COLUMN "scanned_ean" TEXT,
    ADD COLUMN "base_quantity" DECIMAL(10,3),
    ADD COLUMN "quantity_multiplier" DECIMAL(10,3);

CREATE UNIQUE INDEX "warehouse_product_barcodes_tenant_id_ean_key"
    ON "warehouse_product_barcodes"("tenant_id", "ean");

CREATE INDEX "warehouse_product_barcodes_tenant_id_idx"
    ON "warehouse_product_barcodes"("tenant_id");

CREATE INDEX "warehouse_product_barcodes_warehouse_product_id_idx"
    ON "warehouse_product_barcodes"("warehouse_product_id");

CREATE INDEX "warehouse_product_barcodes_tenant_id_is_active_idx"
    ON "warehouse_product_barcodes"("tenant_id", "is_active");

CREATE INDEX "warehouse_document_items_barcode_id_idx"
    ON "warehouse_document_items"("barcode_id");

ALTER TABLE "warehouse_product_barcodes" ADD CONSTRAINT "warehouse_product_barcodes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_product_barcodes" ADD CONSTRAINT "warehouse_product_barcodes_warehouse_product_id_fkey"
    FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_document_items" ADD CONSTRAINT "warehouse_document_items_barcode_id_fkey"
    FOREIGN KEY ("barcode_id") REFERENCES "warehouse_product_barcodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
