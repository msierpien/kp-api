-- Layout szablonu zamrozony w chwili zatwierdzenia sprawy przez klienta.
-- Sprawy sprzed tej migracji maja NULL - konsumenci czytaja wtedy biezacy
-- layout szablonu (zachowanie sprzed zmiany).
ALTER TABLE "personalization_cases" ADD COLUMN "layout_snapshot" JSONB;
