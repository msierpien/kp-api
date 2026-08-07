-- Zamiana produktu w pozycji zamowienia: pozycja dalej wskazuje to samo
-- zamowienie ze sklepu, ale wydajemy inny produkt magazynowy. Snapshot
-- oryginalu zostaje przy pozycji, bo sklep nadal zna produkt pierwotny.
ALTER TABLE "order_items"
    ADD COLUMN "is_substituted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "substituted_from_sku" TEXT,
    ADD COLUMN "substituted_from_name" TEXT,
    ADD COLUMN "substituted_from_product_id" TEXT,
    ADD COLUMN "substituted_at" TIMESTAMP(3),
    ADD COLUMN "substitution_reason" TEXT;

-- Lista zamowien filtrowana po zamianach (raport "co podmienilismy") idzie
-- po tej fladze, a zamienionych pozycji jest garstka - stad indeks czesciowy.
CREATE INDEX "order_items_is_substituted_idx"
    ON "order_items" ("is_substituted")
    WHERE "is_substituted" = true;
