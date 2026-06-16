CREATE TABLE "ai_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "active_provider" TEXT NOT NULL DEFAULT 'OPENAI',
    "openai_api_key" TEXT,
    "anthropic_api_key" TEXT,
    "deepseek_api_key" TEXT,
    "openai_text_model" TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
    "openai_vision_model" TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
    "anthropic_text_model" TEXT NOT NULL DEFAULT 'claude-3-5-sonnet-latest',
    "anthropic_vision_model" TEXT NOT NULL DEFAULT 'claude-3-5-sonnet-latest',
    "deepseek_text_model" TEXT NOT NULL DEFAULT 'deepseek-chat',
    "deepseek_vision_model" TEXT,
    "daily_limit" INTEGER NOT NULL DEFAULT 200,
    "monthly_limit" INTEGER NOT NULL DEFAULT 5000,
    "timeout_ms" INTEGER NOT NULL DEFAULT 45000,
    "max_batch_size" INTEGER NOT NULL DEFAULT 20,
    "default_prompt_template_id" TEXT,
    "tone_json" JSONB,
    "rules_json" JSONB,
    "last_test_provider" TEXT,
    "last_test_status" TEXT,
    "last_test_at" TIMESTAMP(3),
    "last_test_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_settings_tenant_id_key" ON "ai_settings"("tenant_id");
CREATE INDEX "ai_settings_tenant_id_idx" ON "ai_settings"("tenant_id");

ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
