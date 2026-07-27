-- Biblioteka ozdobnikow sprzedawcy (wspolna dla wszystkich jego szablonow).
CREATE TABLE "decoration_assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "tintable" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decoration_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decoration_assets_tenant_id_category_idx" ON "decoration_assets"("tenant_id", "category");

-- AddForeignKey
ALTER TABLE "decoration_assets" ADD CONSTRAINT "decoration_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
