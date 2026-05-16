-- Add audit metadata to warehouse documents.

ALTER TABLE "warehouse_documents"
    ADD COLUMN "created_by_user_id" TEXT,
    ADD COLUMN "confirmed_at" TIMESTAMP(3),
    ADD COLUMN "confirmed_by_user_id" TEXT,
    ADD COLUMN "cancelled_at" TIMESTAMP(3),
    ADD COLUMN "cancelled_by_user_id" TEXT,
    ADD COLUMN "cancel_reason" TEXT,
    ADD COLUMN "is_auto_generated" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "metadata_json" JSONB;

CREATE INDEX "warehouse_documents_created_by_user_id_idx"
    ON "warehouse_documents"("created_by_user_id");

CREATE INDEX "warehouse_documents_confirmed_by_user_id_idx"
    ON "warehouse_documents"("confirmed_by_user_id");

CREATE INDEX "warehouse_documents_cancelled_by_user_id_idx"
    ON "warehouse_documents"("cancelled_by_user_id");

CREATE INDEX "warehouse_documents_is_auto_generated_idx"
    ON "warehouse_documents"("is_auto_generated");
