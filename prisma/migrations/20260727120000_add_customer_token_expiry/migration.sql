-- Termin waznosci linku klienta.
-- Istniejace sprawy zostaja z NULL (bez terminu) - retroaktywne zamkniecie
-- zerwaloby linki wyslane klientom, ktorzy jeszcze nie wypelnili formularza.
ALTER TABLE "personalization_cases"
  ADD COLUMN "customer_token_expires_at" TIMESTAMP(3);

-- Wygasanie sprawdzamy przy kazdym wejsciu po tokenie.
CREATE INDEX "personalization_cases_customer_token_expires_at_idx"
  ON "personalization_cases"("customer_token_expires_at");
