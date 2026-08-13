-- Zwrot szedl all-or-nothing: kazda operacja probowala wystawic korekte w iFirma
-- i order slip w PrestaShop. Gdy ktorys z tych dokumentow powstal juz recznie
-- (albo faktura zrodlowa istnieje tylko w iFirma), panel byl bezuzyteczny —
-- ponowne uruchomienie zdublowaloby dokumenty. Te dwa przelaczniki pozwalaja
-- wykonac sam krok magazynowy.
ALTER TABLE "order_returns"
  ADD COLUMN "issue_ifirma_correction" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "create_prestashop_slip" BOOLEAN NOT NULL DEFAULT true;
