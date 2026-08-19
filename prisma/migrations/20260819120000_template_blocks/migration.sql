-- Biblioteka blokow wielokrotnego uzytku: stopka RSVP, ramka, monogram,
-- blok adresowy. Dotad jedyna droga na przeniesienie gotowego fragmentu do
-- kolejnego projektu byl kopiuj-wklej miedzy zakladkami albo duplikowanie
-- calego szablonu razem z formatem i formularzem.
CREATE TABLE "template_blocks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Warstwy, grupy, fonty i lista assetow. Wspolrzedne wzgledem wlasnego
    -- bounding boxa bloku, nie wzgledem kartki zrodlowej.
    "payload" JSONB NOT NULL,
    "preview_path" TEXT,
    "width_mm" DOUBLE PRECISION NOT NULL,
    "height_mm" DOUBLE PRECISION NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source_template_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "template_blocks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "template_blocks_tenant_id_category_idx"
    ON "template_blocks" ("tenant_id", "category");

-- Filtr po tagach idzie operatorem zawierania (@>) - bez GIN skanowalby cala
-- tabele, tak samo jak przy ozdobnikach.
CREATE INDEX "template_blocks_tags_idx" ON "template_blocks" USING GIN ("tags");

ALTER TABLE "template_blocks"
    ADD CONSTRAINT "template_blocks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
