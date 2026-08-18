-- Odcisk tresci pliku (SHA-256). Upload nie sprawdzal, czy grafika juz jest
-- w bibliotece, wiec przerwane w polowie wgrywanie paczki trzeba bylo
-- powtarzac w calosci - i konczylo sie dwudziestoma duplikatami do recznego
-- wysprzatania.
--
-- Liczony z tresci ZAPISANEJ (po sanityzacji i ewentualnym przygotowaniu do
-- przebarwiania), a nie z oryginalu: dzieki temu skrypt liczacy odciski
-- wstecz czyta pliki z dysku i dostaje te same wartosci, co upload.
--
-- Bez UNIQUE: biblioteki, ktore juz maja duplikaty, nie moga sie wywrocic na
-- migracji. Powtorzenia odsiewa upload, ktory i tak musi je zglosic panelowi.
ALTER TABLE "decoration_assets"
    ADD COLUMN "content_hash" TEXT;

CREATE INDEX "decoration_assets_tenant_id_content_hash_idx"
    ON "decoration_assets" ("tenant_id", "content_hash");
