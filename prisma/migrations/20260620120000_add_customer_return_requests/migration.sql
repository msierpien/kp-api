CREATE TYPE "CustomerReturnRequestStatus" AS ENUM ('NEW', 'SHIPPING_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CLOSED', 'CANCELLED');

CREATE TYPE "CustomerReturnShippingChoice" AS ENUM ('UNDECIDED', 'MANUAL', 'INPOST_PAYU');

CREATE TYPE "ReturnShippingPaymentStatus" AS ENUM ('NEW', 'PENDING', 'COMPLETED', 'CANCELED', 'FAILED');

CREATE TABLE "customer_return_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "order_id" TEXT,
    "external_order_id" TEXT NOT NULL,
    "prestashop_request_id" TEXT NOT NULL,
    "order_reference" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "customer_name" TEXT,
    "return_type" TEXT NOT NULL,
    "reason" TEXT,
    "items_json" JSONB NOT NULL,
    "shipping_choice" "CustomerReturnShippingChoice" NOT NULL DEFAULT 'UNDECIDED',
    "package_count" INTEGER NOT NULL DEFAULT 0,
    "shipping_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "return_address" TEXT,
    "status" "CustomerReturnRequestStatus" NOT NULL DEFAULT 'NEW',
    "last_payload_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_return_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "return_shipping_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "customer_return_request_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAYU',
    "status" "ReturnShippingPaymentStatus" NOT NULL DEFAULT 'NEW',
    "ext_order_id" TEXT,
    "payu_order_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PLN',
    "package_count" INTEGER NOT NULL DEFAULT 0,
    "payload_json" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_shipping_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_return_requests_shop_id_prestashop_request_id_key" ON "customer_return_requests"("shop_id", "prestashop_request_id");
CREATE INDEX "customer_return_requests_tenant_id_idx" ON "customer_return_requests"("tenant_id");
CREATE INDEX "customer_return_requests_shop_id_idx" ON "customer_return_requests"("shop_id");
CREATE INDEX "customer_return_requests_order_id_idx" ON "customer_return_requests"("order_id");
CREATE INDEX "customer_return_requests_status_idx" ON "customer_return_requests"("status");
CREATE INDEX "customer_return_requests_shipping_choice_idx" ON "customer_return_requests"("shipping_choice");
CREATE INDEX "customer_return_requests_created_at_idx" ON "customer_return_requests"("created_at");

CREATE UNIQUE INDEX "return_shipping_payments_ext_order_id_key" ON "return_shipping_payments"("ext_order_id");
CREATE INDEX "return_shipping_payments_tenant_id_idx" ON "return_shipping_payments"("tenant_id");
CREATE INDEX "return_shipping_payments_shop_id_idx" ON "return_shipping_payments"("shop_id");
CREATE INDEX "return_shipping_payments_customer_return_request_id_idx" ON "return_shipping_payments"("customer_return_request_id");
CREATE INDEX "return_shipping_payments_payu_order_id_idx" ON "return_shipping_payments"("payu_order_id");
CREATE INDEX "return_shipping_payments_status_idx" ON "return_shipping_payments"("status");

ALTER TABLE "customer_return_requests" ADD CONSTRAINT "customer_return_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_return_requests" ADD CONSTRAINT "customer_return_requests_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_return_requests" ADD CONSTRAINT "customer_return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "return_shipping_payments" ADD CONSTRAINT "return_shipping_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "return_shipping_payments" ADD CONSTRAINT "return_shipping_payments_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "return_shipping_payments" ADD CONSTRAINT "return_shipping_payments_customer_return_request_id_fkey" FOREIGN KEY ("customer_return_request_id") REFERENCES "customer_return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
