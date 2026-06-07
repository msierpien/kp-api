-- Order workflow and invoice snapshot fields
ALTER TABLE "orders" ADD COLUMN "total_shipping_tax_incl" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN "total_shipping_tax_excl" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN "total_discounts_tax_incl" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN "total_discounts_tax_excl" DECIMAL(10,2);
ALTER TABLE "orders" ADD COLUMN "payment_method" TEXT;
ALTER TABLE "orders" ADD COLUMN "operational_status" TEXT NOT NULL DEFAULT 'NEW';
ALTER TABLE "orders" ADD COLUMN "external_status_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "external_status_name" TEXT;
ALTER TABLE "orders" ADD COLUMN "status_synced_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "status_sync_error" TEXT;
ALTER TABLE "orders" ADD COLUMN "billing_address_json" JSONB;
ALTER TABLE "orders" ADD COLUMN "delivery_address_json" JSONB;

CREATE INDEX "orders_shop_id_operational_status_idx" ON "orders"("shop_id", "operational_status");
CREATE INDEX "orders_shop_id_external_status_id_idx" ON "orders"("shop_id", "external_status_id");

ALTER TABLE "order_items" ADD COLUMN "unit_price_tax_incl" DECIMAL(10,2);
ALTER TABLE "order_items" ADD COLUMN "unit_price_tax_excl" DECIMAL(10,2);
ALTER TABLE "order_items" ADD COLUMN "total_price_tax_incl" DECIMAL(10,2);
ALTER TABLE "order_items" ADD COLUMN "total_price_tax_excl" DECIMAL(10,2);
ALTER TABLE "order_items" ADD COLUMN "tax_rate" DECIMAL(5,4);
ALTER TABLE "order_items" ADD COLUMN "tax_name" TEXT;
ALTER TABLE "order_items" ADD COLUMN "payload_json" JSONB;

-- PrestaShop status catalog per shop
CREATE TABLE "shop_order_statuses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "external_status_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "is_ready_for_invoice" BOOLEAN NOT NULL DEFAULT false,
    "is_invoice_target" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "payload_json" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_order_statuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_order_statuses_shop_id_external_status_id_key" ON "shop_order_statuses"("shop_id", "external_status_id");
CREATE INDEX "shop_order_statuses_tenant_id_idx" ON "shop_order_statuses"("tenant_id");
CREATE INDEX "shop_order_statuses_shop_id_idx" ON "shop_order_statuses"("shop_id");
CREATE INDEX "shop_order_statuses_tenant_id_is_ready_for_invoice_idx" ON "shop_order_statuses"("tenant_id", "is_ready_for_invoice");

ALTER TABLE "shop_order_statuses" ADD CONSTRAINT "shop_order_statuses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_order_statuses" ADD CONSTRAINT "shop_order_statuses_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "SalesDocumentType" AS ENUM ('INVOICE');
CREATE TYPE "SalesDocumentStatus" AS ENUM ('DRAFT', 'PENDING', 'ISSUED', 'SENT', 'FAILED', 'CANCELLED');

-- iFirma configuration per shop
CREATE TABLE "ifirma_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "invoice_key" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'production',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "default_payment_method" TEXT NOT NULL DEFAULT 'PRZ',
    "payment_term_days" INTEGER NOT NULL DEFAULT 0,
    "numbering_series_name" TEXT,
    "template_name" TEXT,
    "issue_place" TEXT,
    "bank_account_number" TEXT,
    "receiver_signature_type" TEXT NOT NULL DEFAULT 'BPO',
    "receiver_signature" TEXT,
    "issuer_signature" TEXT,
    "visible_bdo" BOOLEAN NOT NULL DEFAULT false,
    "send_email_after_issue" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ifirma_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ifirma_settings_shop_id_key" ON "ifirma_settings"("shop_id");
CREATE INDEX "ifirma_settings_tenant_id_idx" ON "ifirma_settings"("tenant_id");
CREATE INDEX "ifirma_settings_shop_id_idx" ON "ifirma_settings"("shop_id");

ALTER TABLE "ifirma_settings" ADD CONSTRAINT "ifirma_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ifirma_settings" ADD CONSTRAINT "ifirma_settings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sales documents / invoices
CREATE TABLE "sales_documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "document_type" "SalesDocumentType" NOT NULL DEFAULT 'INVOICE',
    "status" "SalesDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "external_id" TEXT,
    "external_number" TEXT,
    "request_payload_json" JSONB,
    "response_payload_json" JSONB,
    "pdf_url" TEXT,
    "pdf_path" TEXT,
    "issued_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_documents_shop_id_external_order_id_document_type_key" ON "sales_documents"("shop_id", "external_order_id", "document_type");
CREATE INDEX "sales_documents_tenant_id_idx" ON "sales_documents"("tenant_id");
CREATE INDEX "sales_documents_shop_id_idx" ON "sales_documents"("shop_id");
CREATE INDEX "sales_documents_order_id_idx" ON "sales_documents"("order_id");
CREATE INDEX "sales_documents_status_idx" ON "sales_documents"("status");

ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "invoice_email_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sales_document_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "payload_json" JSONB,
    "error_message" TEXT,
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_email_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_email_logs_tenant_id_idx" ON "invoice_email_logs"("tenant_id");
CREATE INDEX "invoice_email_logs_sales_document_id_idx" ON "invoice_email_logs"("sales_document_id");
CREATE INDEX "invoice_email_logs_status_idx" ON "invoice_email_logs"("status");

ALTER TABLE "invoice_email_logs" ADD CONSTRAINT "invoice_email_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_email_logs" ADD CONSTRAINT "invoice_email_logs_sales_document_id_fkey" FOREIGN KEY ("sales_document_id") REFERENCES "sales_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
