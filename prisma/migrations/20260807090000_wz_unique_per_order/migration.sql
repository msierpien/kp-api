-- Jedno aktywne WZ na zamowienie: rownolegly webhook + sync + reczne "Utworz WZ"
-- moglyby stworzyc dwa dokumenty (createWzForOrder nie trzyma locka miedzy
-- sprawdzeniem a utworzeniem). Czesciowy indeks unikalny domyka to na poziomie bazy.
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_documents_wz_per_order"
ON "warehouse_documents" ("tenant_id", "order_id")
WHERE "type" = 'WZ' AND "status" <> 'CANCELLED' AND "order_id" IS NOT NULL;
