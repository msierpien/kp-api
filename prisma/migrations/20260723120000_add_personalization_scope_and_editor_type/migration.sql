-- Formalize shared/individual personalization fields and template editor modes.
CREATE TYPE "FieldScope" AS ENUM ('SHARED', 'INDIVIDUAL');
CREATE TYPE "TemplateEditorType" AS ENUM ('SIMPLE', 'ADVANCED');

ALTER TABLE "form_fields"
  ADD COLUMN "scope" "FieldScope" NOT NULL DEFAULT 'SHARED';

UPDATE "form_fields"
SET "scope" = 'INDIVIDUAL'
WHERE "repeater_group_key" IS NOT NULL AND "repeater_group_key" <> '';

ALTER TABLE "personalization_templates"
  ADD COLUMN "editor_type" "TemplateEditorType" NOT NULL DEFAULT 'ADVANCED';

