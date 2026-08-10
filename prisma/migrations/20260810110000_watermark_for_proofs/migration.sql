-- Znak wodny zmienia adresata: dotad trafial na pliki produkcyjne (psul wydruk),
-- teraz obowiazuje wylacznie materialy pokazywane klientowi - podglad w portalu
-- i PDF podgladowy. Wlaczamy go wszystkim: sprzedawcy wylaczali go po to, by
-- nie brudzil druku, a nie po to, by oddawac klientowi czysty projekt.
ALTER TABLE "print_settings"
  ALTER COLUMN "watermark_enabled" SET DEFAULT true;

UPDATE "print_settings"
  SET "watermark_enabled" = true
  WHERE "watermark_enabled" = false;
