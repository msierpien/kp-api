CREATE TABLE "ai_prompt_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'UNIVERSAL',
    "product_type" TEXT,
    "occasion_context" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'naturalny sprzedazowy',
    "brief" TEXT NOT NULL,
    "system_prompt" TEXT,
    "html_mode" TEXT NOT NULL DEFAULT 'basic',
    "rules_json" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompt_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_prompt_templates_tenant_id_idx" ON "ai_prompt_templates"("tenant_id");
CREATE INDEX "ai_prompt_templates_tenant_id_is_active_idx" ON "ai_prompt_templates"("tenant_id", "is_active");
CREATE INDEX "ai_prompt_templates_tenant_id_is_default_idx" ON "ai_prompt_templates"("tenant_id", "is_default");

ALTER TABLE "ai_prompt_templates" ADD CONSTRAINT "ai_prompt_templates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
