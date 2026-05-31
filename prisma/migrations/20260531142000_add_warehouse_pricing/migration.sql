ALTER TABLE "warehouse_products"
ADD COLUMN "average_purchase_cost" DECIMAL(10,2);

CREATE TABLE "warehouse_pricing_rules" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "shop_id" TEXT,
  "catalog_id" TEXT,
  "warehouse_product_id" TEXT,
  "margin_percent" DECIMAL(7,3),
  "min_profit" DECIMAL(10,2),
  "fixed_net_price" DECIMAL(10,2),
  "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 23,
  "rounding_mode" TEXT NOT NULL DEFAULT 'END_99',
  "sync_mode" TEXT NOT NULL DEFAULT 'CONFIRM',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_pricing_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_product_shop_prices" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "warehouse_product_id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "pricing_rule_id" TEXT,
  "cost_basis" DECIMAL(10,2),
  "net_price" DECIMAL(10,2),
  "gross_price" DECIMAL(10,2),
  "margin_percent" DECIMAL(7,3),
  "profit_amount" DECIMAL(10,2),
  "warning_code" TEXT,
  "warning_message" TEXT,
  "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_product_shop_prices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_pricing_rules_tenant_id_idx" ON "warehouse_pricing_rules"("tenant_id");
CREATE INDEX "warehouse_pricing_rules_tenant_id_level_idx" ON "warehouse_pricing_rules"("tenant_id", "level");
CREATE INDEX "warehouse_pricing_rules_shop_id_idx" ON "warehouse_pricing_rules"("shop_id");
CREATE INDEX "warehouse_pricing_rules_catalog_id_idx" ON "warehouse_pricing_rules"("catalog_id");
CREATE INDEX "warehouse_pricing_rules_warehouse_product_id_idx" ON "warehouse_pricing_rules"("warehouse_product_id");
CREATE INDEX "warehouse_pricing_rules_tenant_id_is_active_idx" ON "warehouse_pricing_rules"("tenant_id", "is_active");

CREATE UNIQUE INDEX "warehouse_product_shop_prices_warehouse_product_id_shop_id_key" ON "warehouse_product_shop_prices"("warehouse_product_id", "shop_id");
CREATE INDEX "warehouse_product_shop_prices_tenant_id_idx" ON "warehouse_product_shop_prices"("tenant_id");
CREATE INDEX "warehouse_product_shop_prices_warehouse_product_id_idx" ON "warehouse_product_shop_prices"("warehouse_product_id");
CREATE INDEX "warehouse_product_shop_prices_shop_id_idx" ON "warehouse_product_shop_prices"("shop_id");
CREATE INDEX "warehouse_product_shop_prices_pricing_rule_id_idx" ON "warehouse_product_shop_prices"("pricing_rule_id");
CREATE INDEX "warehouse_product_shop_prices_tenant_id_calculated_at_idx" ON "warehouse_product_shop_prices"("tenant_id", "calculated_at");

ALTER TABLE "warehouse_pricing_rules"
ADD CONSTRAINT "warehouse_pricing_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_pricing_rules"
ADD CONSTRAINT "warehouse_pricing_rules_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_pricing_rules"
ADD CONSTRAINT "warehouse_pricing_rules_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "warehouse_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_pricing_rules"
ADD CONSTRAINT "warehouse_pricing_rules_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_product_shop_prices"
ADD CONSTRAINT "warehouse_product_shop_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_product_shop_prices"
ADD CONSTRAINT "warehouse_product_shop_prices_warehouse_product_id_fkey" FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_product_shop_prices"
ADD CONSTRAINT "warehouse_product_shop_prices_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_product_shop_prices"
ADD CONSTRAINT "warehouse_product_shop_prices_pricing_rule_id_fkey" FOREIGN KEY ("pricing_rule_id") REFERENCES "warehouse_pricing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
