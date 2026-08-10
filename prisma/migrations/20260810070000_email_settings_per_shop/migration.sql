-- Konfiguracja SMTP per sklep: kazdy sklep wysyla z wlasnej domeny, inaczej
-- SPF i DKIM nie zgadzaja sie z adresem nadawcy i poczta ladu je w spamie.
-- NULL w `shop_id` = ustawienie zapasowe tenanta (sklepy bez wlasnego wpisu).
ALTER TABLE "email_settings"
  ADD COLUMN "shop_id" TEXT;

ALTER TABLE "email_settings"
  ADD CONSTRAINT "email_settings_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "email_settings_shop_id_key" ON "email_settings"("shop_id");

-- Jeden wpis na tenanta przestaje obowiazywac: teraz to jedna konfiguracja
-- zapasowa PLUS po jednej na sklep.
DROP INDEX IF EXISTS "email_settings_tenant_id_key";

-- Zapasowa moze byc tylko jedna na tenanta - w Postgresie NULL-e nie koliduja
-- w zwyklym indeksie unikalnym, wiec potrzebny jest indeks czesciowy.
CREATE UNIQUE INDEX "email_settings_tenant_default_key"
  ON "email_settings"("tenant_id") WHERE "shop_id" IS NULL;
