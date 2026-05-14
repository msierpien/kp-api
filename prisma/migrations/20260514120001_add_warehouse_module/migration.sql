-- Migracja: moduł magazynowy (PZ/PW/WZ/RW)

-- Enum: typ dokumentu magazynowego
CREATE TYPE "WarehouseDocumentType" AS ENUM ('PZ', 'PW', 'WZ', 'RW');

-- Enum: status dokumentu magazynowego
CREATE TYPE "WarehouseDocumentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- Tabela produktów magazynowych
CREATE TABLE "warehouse_products" (
    "id"          TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "sku"         TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "unit"        TEXT NOT NULL DEFAULT 'szt',
    "description" TEXT,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_products_pkey" PRIMARY KEY ("id")
);

-- Tabela dokumentów magazynowych
CREATE TABLE "warehouse_documents" (
    "id"          TEXT NOT NULL,
    "tenant_id"   TEXT NOT NULL,
    "number"      TEXT NOT NULL,
    "type"        "WarehouseDocumentType" NOT NULL,
    "status"      "WarehouseDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "date"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT,
    "order_id"    TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_documents_pkey" PRIMARY KEY ("id")
);

-- Tabela pozycji dokumentów magazynowych
CREATE TABLE "warehouse_document_items" (
    "id"          TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "product_id"  TEXT NOT NULL,
    "quantity"    DECIMAL(10,3) NOT NULL,
    "unit_price"  DECIMAL(10,2),
    "notes"       TEXT,

    CONSTRAINT "warehouse_document_items_pkey" PRIMARY KEY ("id")
);

-- Unikalne constrainty
CREATE UNIQUE INDEX "warehouse_products_tenant_id_sku_key" ON "warehouse_products"("tenant_id", "sku");
CREATE UNIQUE INDEX "warehouse_documents_tenant_id_number_key" ON "warehouse_documents"("tenant_id", "number");

-- Indeksy
CREATE INDEX "warehouse_products_tenant_id_idx" ON "warehouse_products"("tenant_id");
CREATE INDEX "warehouse_products_tenant_id_is_active_idx" ON "warehouse_products"("tenant_id", "is_active");
CREATE INDEX "warehouse_documents_tenant_id_idx" ON "warehouse_documents"("tenant_id");
CREATE INDEX "warehouse_documents_tenant_id_type_idx" ON "warehouse_documents"("tenant_id", "type");
CREATE INDEX "warehouse_documents_tenant_id_status_idx" ON "warehouse_documents"("tenant_id", "status");
CREATE INDEX "warehouse_documents_tenant_id_date_idx" ON "warehouse_documents"("tenant_id", "date");
CREATE INDEX "warehouse_document_items_document_id_idx" ON "warehouse_document_items"("document_id");
CREATE INDEX "warehouse_document_items_product_id_idx" ON "warehouse_document_items"("product_id");

-- Foreign keys
ALTER TABLE "warehouse_products" ADD CONSTRAINT "warehouse_products_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_documents" ADD CONSTRAINT "warehouse_documents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_documents" ADD CONSTRAINT "warehouse_documents_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_document_items" ADD CONSTRAINT "warehouse_document_items_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "warehouse_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_document_items" ADD CONSTRAINT "warehouse_document_items_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "warehouse_products"("id") ON UPDATE CASCADE;
