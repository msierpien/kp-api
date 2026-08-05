-- Domyslny model tekstowy Anthropic dla nowych tenantow. Istniejacych
-- ustawien nie ruszamy - sprzedawca mogl wybrac model swiadomie.
ALTER TABLE "ai_settings"
    ALTER COLUMN "anthropic_text_model" SET DEFAULT 'claude-sonnet-5';

-- Asystent AI w edytorze klienta.
-- Osobne pola od generatora opisow produktow: inne zadanie, inny budzet
-- i jedyne miejsce, gdzie wywolanie modelu inicjuje klient koncowy.
-- Domyslnie WYLACZONY - sprzedawca wlacza go swiadomie.
ALTER TABLE "ai_settings"
    ADD COLUMN "editor_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "editor_provider" TEXT,
    ADD COLUMN "editor_model" TEXT,
    ADD COLUMN "editor_daily_limit" INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN "editor_per_case_limit" INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN "editor_system_prompt" TEXT;

-- Bez tego pola nie da sie ani wyegzekwowac limitu na sprawe, ani
-- odpowiedziec na pytanie "ile nas kosztowala ta personalizacja".
ALTER TABLE "ai_usage_logs"
    ADD COLUMN "personalization_case_id" TEXT;

CREATE INDEX "ai_usage_logs_personalization_case_id_idx"
    ON "ai_usage_logs"("personalization_case_id");

ALTER TABLE "ai_usage_logs"
    ADD CONSTRAINT "ai_usage_logs_personalization_case_id_fkey"
    FOREIGN KEY ("personalization_case_id") REFERENCES "personalization_cases"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Zgloszenie klienta "Poproscie grafika". Osobna tabela, a nie dopisek do
-- notes_internal: zgloszenie ma status i historie obslugi.
CREATE TABLE "case_help_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "personalization_case_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "handled_by_user_id" TEXT,
    "handled_at" TIMESTAMP(3),
    "response_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_help_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_help_requests_tenant_id_status_idx"
    ON "case_help_requests"("tenant_id", "status");

CREATE INDEX "case_help_requests_personalization_case_id_idx"
    ON "case_help_requests"("personalization_case_id");

ALTER TABLE "case_help_requests" ADD CONSTRAINT "case_help_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "case_help_requests" ADD CONSTRAINT "case_help_requests_personalization_case_id_fkey"
    FOREIGN KEY ("personalization_case_id") REFERENCES "personalization_cases"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
