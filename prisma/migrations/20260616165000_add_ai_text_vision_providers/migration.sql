ALTER TABLE "ai_settings"
    ADD COLUMN "text_provider" TEXT NOT NULL DEFAULT 'OPENAI',
    ADD COLUMN "vision_provider" TEXT NOT NULL DEFAULT 'OPENAI';

UPDATE "ai_settings"
SET "text_provider" = COALESCE(NULLIF("active_provider", ''), 'OPENAI'),
    "vision_provider" = CASE
        WHEN COALESCE(NULLIF("active_provider", ''), 'OPENAI') = 'DEEPSEEK' THEN 'OPENAI'
        ELSE COALESCE(NULLIF("active_provider", ''), 'OPENAI')
    END;
