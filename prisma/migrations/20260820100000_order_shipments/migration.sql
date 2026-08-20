-- Kopia przesylek kuriera z systemu sklepu. Statusy InPost zyja w module po
-- stronie PrestaShop i dotad panel pytal o nie osobno dla kazdego zamowienia,
-- wiec lista zamowien nie miala czego pokazac, a automatyzacje nie mialy
-- poprzedniego stanu do porownania.
CREATE TABLE "order_shipments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "carrier" TEXT NOT NULL DEFAULT 'INPOST',
    -- id_shipment z tabeli sklepu: po nim rozpoznajemy te sama przesylke
    -- przy kolejnej synchronizacji.
    "external_shipment_id" TEXT NOT NULL,
    "shipx_shipment_id" TEXT,
    "tracking_number" TEXT,
    "service" TEXT,
    "sending_method" TEXT,
    "target_point" TEXT,
    -- Surowy status przewoznika (np. ready_to_pickup) i wyliczony z niego
    -- etap doreczenia. Trzymamy oba: przewoznik dokłada statusy, a etap ma
    -- zostac stabilny dla warunkow automatyzacji i filtrow w panelu.
    "status" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "status_changed_at" TIMESTAMP(3),
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "payload_json" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_shipments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_shipments_order_id_carrier_external_shipment_id_key"
    ON "order_shipments" ("order_id", "carrier", "external_shipment_id");

CREATE INDEX "order_shipments_order_id_idx" ON "order_shipments" ("order_id");

-- Synchronizacja pyta o przesylki jeszcze w drodze, panel filtruje po etapie.
CREATE INDEX "order_shipments_tenant_id_stage_idx" ON "order_shipments" ("tenant_id", "stage");
CREATE INDEX "order_shipments_tenant_id_is_final_idx" ON "order_shipments" ("tenant_id", "is_final");
CREATE INDEX "order_shipments_tracking_number_idx" ON "order_shipments" ("tracking_number");

ALTER TABLE "order_shipments"
    ADD CONSTRAINT "order_shipments_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_shipments"
    ADD CONSTRAINT "order_shipments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
