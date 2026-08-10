-- Korekta pozycji wydruku (mm). Kompensuje przesuniecie podajnika drukarki:
-- wartosc ujemna przesuwa projekt w lewo / do gory.
ALTER TABLE "print_settings"
  ADD COLUMN "print_offset_x_mm" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "print_offset_y_mm" DOUBLE PRECISION NOT NULL DEFAULT 0;
