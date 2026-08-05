-- Etykiety porzadkujace biblioteke szablonow: okazja ("slub", "chrzest"),
-- rodzaj produktu ("zaproszenie", "winietka"). Jeden szablon ma ich kilka,
-- bo "winietka slubna" to i okazja, i rodzaj.
ALTER TABLE "personalization_templates"
    ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Filtrowanie po tagach idzie operatorem zawierania (@>), ktory bez indeksu
-- GIN skanowalby cala tabele.
CREATE INDEX "personalization_templates_tags_idx"
    ON "personalization_templates" USING GIN ("tags");
