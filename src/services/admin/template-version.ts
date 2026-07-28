import { ConflictError } from '../../lib/errors';

/**
 * Znacznik wersji szablonu do zapisu z kontrola konfliktu.
 *
 * Panel wysyla ZA KAZDYM razem komplet: caly formularz albo caly layout. Bez
 * kontroli wersji zapis z karty otwartej pol godziny temu po cichu kasowal
 * zmiany zrobione w miedzyczasie gdzie indziej (zdarzylo sie realnie - pole
 * formularza dodane skryptem znikelo po zapisie z panelu).
 *
 * Wersja to `updatedAt` szablonu: kazdy zapis - layoutu i formularza - dotyka
 * tego samego wiersza, wiec jeden znacznik pilnuje obu sciezek.
 */
export function templateVersionToken(updatedAt: Date): string {
  return updatedAt.toISOString();
}

/**
 * Przerywa zapis, gdy szablon zmienil sie od czasu wczytania.
 *
 * Brak `expectedVersion` = zapis bez kontroli (starszy panel, skrypt) - nie
 * blokujemy go, zeby aktualizacja API nie wywrocila istniejacych narzedzi.
 */
export function assertTemplateVersion(currentUpdatedAt: Date, expectedVersion?: string): void {
  if (!expectedVersion) return;

  const current = templateVersionToken(currentUpdatedAt);
  if (current === expectedVersion) return;

  throw new ConflictError(
    'Szablon zmienił się od czasu wczytania - odśwież stronę, żeby nie nadpisać cudzych zmian.',
    { currentVersion: current, expectedVersion }
  );
}
