/**
 * Zmienne srodowiskowe dla testow, ustawiane PRZED zaladowaniem configu.
 *
 * Przypisania w samym pliku testu sa za pozno: kompilacja do CJS przenosi
 * `require` na gore modulu, wiec config startuje przed nimi i pada na
 * walidacji env. Importowanie tego modulu jako pierwszego rozwiazuje
 * kolejnosc - `require` wykonuja sie w kolejnosci importow.
 */
process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

export {};
