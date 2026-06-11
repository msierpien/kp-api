-- Order cancellation / return workflow with document trail
ALTER TYPE "SalesDocumentType" ADD VALUE 'CORRECTION';
ALTER TYPE "WarehouseDocumentType" ADD VALUE 'ZW';

CREATE TYPE "OrderReturnType" AS ENUM ('CANCELLATION', 'RETURN');
CREATE TYPE "OrderReturnStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "order_returns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "type" "OrderReturnType" NOT NULL,
    "status" "OrderReturnStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "refund_shipping" BOOLEAN NOT NULL DEFAULT false,
    "restock_items" BOOLEAN NOT NULL DEFAULT true,
    "auto_confirm_warehouse_document" BOOLEAN NOT NULL DEFAULT true,
    "total_refund_tax_incl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_refund_tax_excl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shipping_refund_tax_incl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shipping_refund_tax_excl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "external_status_id" TEXT,
    "external_status_name" TEXT,
    "warehouse_document_id" TEXT,
    "ifirma_status" TEXT,
    "ifirma_request_payload_json" JSONB,
    "ifirma_response_payload_json" JSONB,
    "ifirma_error_message" TEXT,
    "prestashop_status" TEXT,
    "prestashop_order_slip_id" TEXT,
    "prestashop_request_payload_json" JSONB,
    "prestashop_response_payload_json" JSONB,
    "prestashop_error_message" TEXT,
    "error_message" TEXT,
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_return_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_return_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "external_item_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unit_price_tax_incl" DECIMAL(10,2),
    "unit_price_tax_excl" DECIMAL(10,2),
    "total_refund_tax_incl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_refund_tax_excl" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(5,4),
    "warehouse_product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_return_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sales_documents" ADD COLUMN "document_key" TEXT NOT NULL DEFAULT 'PRIMARY';
ALTER TABLE "sales_documents" ADD COLUMN "parent_document_id" TEXT;
ALTER TABLE "sales_documents" ADD COLUMN "order_return_id" TEXT;

DROP INDEX "sales_documents_shop_id_external_order_id_document_type_key";
CREATE UNIQUE INDEX "sales_documents_shop_id_external_order_id_document_type_document_key_key"
ON "sales_documents"("shop_id", "external_order_id", "document_type", "document_key");

CREATE UNIQUE INDEX "sales_documents_order_return_id_key" ON "sales_documents"("order_return_id");
CREATE INDEX "sales_documents_parent_document_id_idx" ON "sales_documents"("parent_document_id");
CREATE INDEX "sales_documents_order_return_id_idx" ON "sales_documents"("order_return_id");

CREATE UNIQUE INDEX "order_returns_warehouse_document_id_key" ON "order_returns"("warehouse_document_id");
CREATE INDEX "order_returns_tenant_id_idx" ON "order_returns"("tenant_id");
CREATE INDEX "order_returns_shop_id_idx" ON "order_returns"("shop_id");
CREATE INDEX "order_returns_order_id_idx" ON "order_returns"("order_id");
CREATE INDEX "order_returns_status_idx" ON "order_returns"("status");
CREATE INDEX "order_returns_type_idx" ON "order_returns"("type");

CREATE INDEX "order_return_items_tenant_id_idx" ON "order_return_items"("tenant_id");
CREATE INDEX "order_return_items_order_return_id_idx" ON "order_return_items"("order_return_id");
CREATE INDEX "order_return_items_order_item_id_idx" ON "order_return_items"("order_item_id");
CREATE INDEX "order_return_items_warehouse_product_id_idx" ON "order_return_items"("warehouse_product_id");

ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_warehouse_document_id_fkey" FOREIGN KEY ("warehouse_document_id") REFERENCES "warehouse_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_order_return_id_fkey" FOREIGN KEY ("order_return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "sales_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_order_return_id_fkey" FOREIGN KEY ("order_return_id") REFERENCES "order_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
