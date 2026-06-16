UPDATE "ai_settings"
SET
    "anthropic_text_model" = CASE "anthropic_text_model"
        WHEN 'claude-opus-4.8' THEN 'claude-opus-4-8'
        WHEN 'claude-sonnet-4.6' THEN 'claude-sonnet-4-6'
        WHEN 'claude-haiku-4.5' THEN 'claude-haiku-4-5'
        WHEN 'claude-3-5-sonnet-latest' THEN 'claude-sonnet-4-6'
        ELSE "anthropic_text_model"
    END,
    "anthropic_vision_model" = CASE "anthropic_vision_model"
        WHEN 'claude-opus-4.8' THEN 'claude-opus-4-8'
        WHEN 'claude-sonnet-4.6' THEN 'claude-sonnet-4-6'
        WHEN 'claude-haiku-4.5' THEN 'claude-haiku-4-5'
        WHEN 'claude-3-5-sonnet-latest' THEN 'claude-haiku-4-5'
        ELSE "anthropic_vision_model"
    END;

ALTER TABLE "ai_settings"
    ALTER COLUMN "anthropic_text_model" SET DEFAULT 'claude-sonnet-4-6',
    ALTER COLUMN "anthropic_vision_model" SET DEFAULT 'claude-haiku-4-5';
