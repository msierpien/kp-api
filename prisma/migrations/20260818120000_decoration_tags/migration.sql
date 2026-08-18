-- Kategoria porzadkuje biblioteke, ale przy szukaniu konkretnego ozdobnika
-- bywa za gruba: "kokardka" moze byc i slubna, i urodzinowa, a "roza" pasuje
-- do kwiatowych i do monogramow. Tagi opisuja te same pliki z kilku stron
-- naraz - dokladnie jak przy szablonach (personalization_templates.tags).
ALTER TABLE "decoration_assets"
    ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Filtrowanie po tagach idzie operatorem zawierania (@>), ktory bez indeksu
-- GIN skanowalby cala tabele.
CREATE INDEX "decoration_assets_tags_idx"
    ON "decoration_assets" USING GIN ("tags");
