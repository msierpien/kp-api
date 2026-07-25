-- CreateTable
CREATE TABLE "print_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "format_pdf" BOOLEAN NOT NULL DEFAULT true,
    "format_png" BOOLEAN NOT NULL DEFAULT true,
    "combined_pdf" BOOLEAN NOT NULL DEFAULT true,
    "watermark_enabled" BOOLEAN NOT NULL DEFAULT false,
    "watermark_text" TEXT NOT NULL DEFAULT 'PODGLĄD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_settings_tenant_id_key" ON "print_settings"("tenant_id");

-- AddForeignKey
ALTER TABLE "print_settings" ADD CONSTRAINT "print_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
