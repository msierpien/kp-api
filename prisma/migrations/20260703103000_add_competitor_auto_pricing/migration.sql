-- Add source metadata for pricing rules.
ALTER TABLE "warehouse_pricing_rules"
ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'MANUAL';

CREATE INDEX "warehouse_pricing_rules_tenant_id_origin_idx"
ON "warehouse_pricing_rules"("tenant_id", "origin");

-- Add competitor auto-pricing settings to the existing pricing settings row.
ALTER TABLE "warehouse_pricing_settings"
ADD COLUMN "competitor_auto_pricing_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "competitor_auto_pricing_shop_id" TEXT,
ADD COLUMN "competitor_auto_pricing_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN "competitor_auto_pricing_min_markup_percent" DECIMAL(7,3) NOT NULL DEFAULT 40,
ADD COLUMN "competitor_auto_pricing_below_market_tolerance_percent" DECIMAL(7,3) NOT NULL DEFAULT 1,
ADD COLUMN "competitor_auto_pricing_above_market_tolerance_percent" DECIMAL(7,3) NOT NULL DEFAULT 5,
ADD COLUMN "competitor_auto_pricing_last_run_at" TIMESTAMP(3),
ADD COLUMN "competitor_auto_pricing_last_error_at" TIMESTAMP(3),
ADD COLUMN "competitor_auto_pricing_last_error_message" TEXT;

ALTER TABLE "warehouse_pricing_settings"
ADD CONSTRAINT "warehouse_pricing_settings_competitor_auto_pricing_shop_id_fkey"
FOREIGN KEY ("competitor_auto_pricing_shop_id") REFERENCES "shops"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Store scheduled/manual auto-pricing run summaries.
CREATE TABLE "competitor_price_automation_runs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requested" INTEGER NOT NULL DEFAULT 0,
  "applied" INTEGER NOT NULL DEFAULT 0,
  "skipped_manual_overrides" INTEGER NOT NULL DEFAULT 0,
  "synced" INTEGER NOT NULL DEFAULT 0,
  "enqueued" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "actionable_before" INTEGER NOT NULL DEFAULT 0,
  "min_markup_percent" DECIMAL(7,3) NOT NULL,
  "below_market_tolerance_percent" DECIMAL(7,3) NOT NULL,
  "above_market_tolerance_percent" DECIMAL(7,3) NOT NULL,
  "error_message" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "competitor_price_automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "competitor_price_automation_runs_tenant_id_started_at_idx"
ON "competitor_price_automation_runs"("tenant_id", "started_at");

CREATE INDEX "competitor_price_automation_runs_tenant_id_shop_id_started_at_idx"
ON "competitor_price_automation_runs"("tenant_id", "shop_id", "started_at");

CREATE INDEX "competitor_price_automation_runs_tenant_id_status_idx"
ON "competitor_price_automation_runs"("tenant_id", "status");

ALTER TABLE "competitor_price_automation_runs"
ADD CONSTRAINT "competitor_price_automation_runs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "competitor_price_automation_runs"
ADD CONSTRAINT "competitor_price_automation_runs_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
