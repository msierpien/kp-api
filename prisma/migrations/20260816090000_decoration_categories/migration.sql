-- Kategorie ozdobnikow byly zaszyte w kodzie (SLUBNE, KWIATOWE, LINIE,
-- MONOGRAMY) w trzech miejscach naraz: serwisie API, panelu i portalu klienta.
-- Sprzedawca nie mial jak dodac wlasnej grupy ani zmienic kolejnosci.
--
-- `decoration_assets.category` zostaje slugiem i NIE dostaje klucza obcego:
-- kategoria porzadkuje biblioteke, ale nie jest wlascicielem pliku, wiec
-- skasowanie grupy nie ma prawa pociagnac za soba ozdobnikow.
CREATE TABLE "decoration_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decoration_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decoration_categories_tenant_id_slug_key" ON "decoration_categories"("tenant_id", "slug");

-- AddForeignKey
ALTER TABLE "decoration_categories" ADD CONSTRAINT "decoration_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Przesiew dotychczasowych kategorii do tabeli. Bierzemy kazdy slug, ktory
-- realnie wystepuje w bibliotece tenanta - takze spoza czworki zaszytej
-- w kodzie, gdyby cos wpadlo tam skryptem. Bez tego biblioteka wygladalaby
-- po wdrozeniu na pusta: pliki maja kategorie, ktorej nikt juz nie zna.
INSERT INTO "decoration_categories" ("id", "tenant_id", "slug", "name", "sort_order")
SELECT
    md5(random()::text || clock_timestamp()::text),
    a."tenant_id",
    a."category",
    CASE a."category"
        WHEN 'SLUBNE' THEN 'Ślubne'
        WHEN 'KWIATOWE' THEN 'Kwiatowe'
        WHEN 'LINIE' THEN 'Linie'
        WHEN 'MONOGRAMY' THEN 'Monogramy'
        ELSE a."category"
    END,
    CASE a."category"
        WHEN 'SLUBNE' THEN 0
        WHEN 'KWIATOWE' THEN 1
        WHEN 'LINIE' THEN 2
        WHEN 'MONOGRAMY' THEN 3
        ELSE 100
    END
FROM (SELECT DISTINCT "tenant_id", "category" FROM "decoration_assets") a;

-- Komplet startowy dla KAZDEGO tenanta. Czworka byla dotad na sztywno na
-- liscie wyboru przy uploadzie, wiec sprzedawca, ktory uzywal tylko dwoch
-- z nich, nie moze po wdrozeniu stracic pozostalych - inaczej wgranie
-- pierwszego kwiatka wymagaloby najpierw zalozenia grupy.
-- Konflikt oznacza, ze grupa przyszla juz z przesiewu wyzej (razem ze swoim
-- porzadkiem) - zostawiamy ja w spokoju.
INSERT INTO "decoration_categories" ("id", "tenant_id", "slug", "name", "sort_order")
SELECT
    md5(random()::text || clock_timestamp()::text),
    t."id",
    c."slug",
    c."name",
    c."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
    ('SLUBNE', 'Ślubne', 0),
    ('KWIATOWE', 'Kwiatowe', 1),
    ('LINIE', 'Linie', 2),
    ('MONOGRAMY', 'Monogramy', 3)
) AS c("slug", "name", "sort_order")
ON CONFLICT ("tenant_id", "slug") DO NOTHING;
