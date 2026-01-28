-- AlterTable
ALTER TABLE "personalization_templates" ADD COLUMN     "layout_json" JSONB,
ADD COLUMN     "thumbnail_url" TEXT;

-- CreateTable
CREATE TABLE "template_assets" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "metadata" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "template_assets_template_id_idx" ON "template_assets"("template_id");

-- CreateIndex
CREATE INDEX "template_assets_asset_type_idx" ON "template_assets"("asset_type");

-- AddForeignKey
ALTER TABLE "template_assets" ADD CONSTRAINT "template_assets_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "personalization_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
