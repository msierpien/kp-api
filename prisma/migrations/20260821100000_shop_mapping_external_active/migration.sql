-- Rozdzielenie dwoch znaczen, ktore dotad siedzialy w jednej kolumnie.
-- Import sklepowy wpisywal w is_active wartosc `active` z PrestaShop, a reszta
-- kodu czytala to pole jako "mapowanie jest wazne". Produkt wylaczony w sklepie
-- wygladal wiec jak produkt bez mapowania: znikal z listy, z masowek i z
-- synchronizacji, wiec nie dalo sie go ani zobaczyc, ani posprzatac.
ALTER TABLE "shop_product_mappings"
    ADD COLUMN "external_active" BOOLEAN,
    ADD COLUMN "external_active_synced_at" TIMESTAMP(3),
    ADD COLUMN "missing_in_shop_since" TIMESTAMP(3);

-- Przenosimy dotychczasowa wartosc: to, co tam bylo, opisywalo stan w sklepie.
UPDATE "shop_product_mappings" SET "external_active" = "is_active";

-- is_active zostaje jak jest. Nie ozywiamy mapowan hurtem, bo w tej samej
-- kolumnie siedza dwa przypadki nie do odroznienia po fakcie: produkt wylaczony
-- w sklepie oraz mapowanie swiadomie zerwane przez "Usun ze sklepu". Pierwszy
-- przypadek naprawi najblizszy import (leci juz z activeOnly=false i robi upsert
-- ustawiajac is_active=true, external_active=false), drugi ma zostac zerwany.

CREATE INDEX "shop_product_mappings_tenant_id_external_active_idx"
    ON "shop_product_mappings"("tenant_id", "external_active");
