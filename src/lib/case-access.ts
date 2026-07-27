import type { FastifyReply } from 'fastify';

/**
 * Reguly dostepu do sprawy przez token klienta.
 *
 * Do tej pory pilnowal ich WYLACZNIE portal (`isReadOnlyStatus` w kp-client),
 * wiec zwykly `curl` z linkiem potrafil nadpisac dane sprawy juz wydrukowanej
 * i cofnac jej status. Serwer musi egzekwowac to samo, co UI.
 */

/** Statusy, w ktorych sprawa jest zamknieta dla klienta (tylko odczyt). */
export const READ_ONLY_CASE_STATUSES = [
  'SUBMITTED',
  'RENDERED',
  'READY_FOR_PRINT',
  'ARCHIVED',
] as const;

export function isCaseWritable(status: string | null | undefined): boolean {
  if (!status) return true;
  return !(READ_ONLY_CASE_STATUSES as readonly string[]).includes(status);
}

type TokenGuardCase = {
  status?: string | null;
  tokenActive?: boolean | null;
  customerTokenExpiresAt?: Date | null;
};

/**
 * Czy token nadaje sie do uzycia (odczyt i zapis).
 *
 * Wygasniecie zwraca 410, nie 403 - portal ma dla tego kodu osobny komunikat
 * ("Link wygasl. Skontaktuj sie z nami, aby otrzymac nowy"), a admin z panelu
 * wysyla nowy link. Sprawy sprzed wprowadzenia terminu maja NULL i zyja dalej
 * bez ograniczenia - retroaktywne zamkniecie zerwaloby aktywne linki.
 */
export function assertTokenUsable(personalizationCase: TokenGuardCase, reply: FastifyReply): boolean {
  if (!personalizationCase.tokenActive) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Token jest nieaktywny',
    });
    return false;
  }

  const expiresAt = personalizationCase.customerTokenExpiresAt;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    reply.status(410).send({
      error: 'Gone',
      message: 'Link do personalizacji wygasł',
    });
    return false;
  }

  return true;
}

/**
 * Czy sprawa przyjmuje jeszcze zmiany od klienta.
 *
 * 409, bo to konflikt ze stanem zasobu, a nie brak uprawnien - admin moze
 * cofnac status na "Czeka na klienta" i sprawa znow bedzie edytowalna.
 */
export function assertCaseWritable(personalizationCase: TokenGuardCase, reply: FastifyReply): boolean {
  if (isCaseWritable(personalizationCase.status)) return true;

  reply.status(409).send({
    error: 'Conflict',
    message: 'Personalizacja została już zatwierdzona i nie można jej zmieniać',
  });
  return false;
}
