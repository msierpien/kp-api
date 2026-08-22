-- Archiwum produktu i log porzadkow w katalogu.
--
-- Dotad jedynym sposobem na pozbycie sie produktu z panelu bylo twarde DELETE,
-- ktore wywala sie na pozycjach dokumentow, a jak przejdzie, to zabiera ze soba
-- historie. Archiwum daje etap posredni: produkt wypada z list, stanow i
-- synchronizacji, ale faktura i zwrot dalej maja na czym stanac.
ALTER TABLE "warehouse_products"
    ADD COLUMN "archived_at" TIMESTAMP(3),
    ADD COLUMN "archived_reason" TEXT;

CREATE INDEX "warehouse_products_tenant_id_archived_at_idx"
    ON "warehouse_products"("tenant_id", "archived_at");

CREATE TABLE "warehouse_cleanup_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shop_id" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    -- Selekcja zapisana tak, jak ja podano: liste id albo filtry listy. Filtry
    -- sa wazniejsze niz lista - 1842 produktow nie zmiesci sie w limicie 500 id.
    "selection_json" JSONB NOT NULL,
    "preview_json" JSONB,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "shop_deactivated" INTEGER NOT NULL DEFAULT 0,
    "shop_deleted" INTEGER NOT NULL DEFAULT 0,
    "archived" INTEGER NOT NULL DEFAULT 0,
    "purged" INTEGER NOT NULL DEFAULT 0,
    "unlinked" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "stop_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_cleanup_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_cleanup_run_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "warehouse_product_id" TEXT,
    -- SKU i nazwa przepisane, bo przy trybie PURGE produktu juz nie ma.
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_product_id" TEXT,
    "status" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_cleanup_run_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_cleanup_runs_tenant_id_created_at_idx" ON "warehouse_cleanup_runs"("tenant_id", "created_at");
CREATE INDEX "warehouse_cleanup_runs_tenant_id_status_idx" ON "warehouse_cleanup_runs"("tenant_id", "status");
CREATE INDEX "warehouse_cleanup_run_items_run_id_status_idx" ON "warehouse_cleanup_run_items"("run_id", "status");
CREATE INDEX "warehouse_cleanup_run_items_tenant_id_idx" ON "warehouse_cleanup_run_items"("tenant_id");
CREATE INDEX "warehouse_cleanup_run_items_warehouse_product_id_idx" ON "warehouse_cleanup_run_items"("warehouse_product_id");

ALTER TABLE "warehouse_cleanup_runs" ADD CONSTRAINT "warehouse_cleanup_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_cleanup_runs" ADD CONSTRAINT "warehouse_cleanup_runs_shop_id_fkey"
    FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_cleanup_runs" ADD CONSTRAINT "warehouse_cleanup_runs_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_cleanup_run_items" ADD CONSTRAINT "warehouse_cleanup_run_items_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "warehouse_cleanup_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_cleanup_run_items" ADD CONSTRAINT "warehouse_cleanup_run_items_warehouse_product_id_fkey"
    FOREIGN KEY ("warehouse_product_id") REFERENCES "warehouse_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
