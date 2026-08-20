-- Historia uruchomien automatyzacji. Dotad po regule zostawal tylko licznik
-- i tresc ostatniego bledu, wiec nie dalo sie sprawdzic, czego dotyczylo
-- konkretne uruchomienie ani czy mail juz poszedl.
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "matched" BOOLEAN NOT NULL DEFAULT true,
    -- Klucz idempotencji, np. shipment:<id>:ready_to_pickup. NULL dla
    -- uruchomien, ktorych nie ma sensu odcinac (pominiete warunki, dry-run) —
    -- w Postgresie NULL nie koliduje z indeksem unikalnym, wiec takie wpisy
    -- moga sie powtarzac dowolnie.
    "context_key" TEXT,
    "subject_label" TEXT,
    "payload_json" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- Blokada powtorki: ta sama zmiana statusu nie wysle drugiego maila.
CREATE UNIQUE INDEX "automation_runs_automation_id_context_key_key"
    ON "automation_runs" ("automation_id", "context_key");

CREATE INDEX "automation_runs_automation_id_created_at_idx"
    ON "automation_runs" ("automation_id", "created_at");
CREATE INDEX "automation_runs_tenant_id_created_at_idx"
    ON "automation_runs" ("tenant_id", "created_at");

ALTER TABLE "automation_runs"
    ADD CONSTRAINT "automation_runs_automation_id_fkey"
    FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_runs"
    ADD CONSTRAINT "automation_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
