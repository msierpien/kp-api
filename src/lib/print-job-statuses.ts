/**
 * Statusy zlecen druku i agentow.
 *
 * Baza trzyma je jako zwykle stringi (konwencja tego schematu - patrz RenderJob),
 * wiec ta lista jest jedyna bariera przed literowka, ktora po cichu zepsulaby
 * filtry. Uzywac wszedzie: w zodach, w `where`, w mapowaniu odpowiedzi.
 */
export const PRINT_JOB_STATUSES = [
  'QUEUED', // czeka na agenta
  'CLAIMED', // agent pobral, nic jeszcze nie poszlo na drukarke
  'PRINTING', // przekazane do CUPS
  'DONE', // CUPS potwierdzil zakonczenie
  'FAILED',
  'CANCELLED',
  'STALE', // agent zamilkl w trakcie druku - nie wiadomo, czy wyszlo
] as const;

export type PrintJobStatus = typeof PRINT_JOB_STATUSES[number];

/** Statusy, w ktorych zadanie zajmuje miejsce w kolejce. */
export const PRINT_JOB_ACTIVE_STATUSES = ['QUEUED', 'CLAIMED', 'PRINTING'] as const;

/** Statusy koncowe - zadanie nie zmieni juz stanu samo z siebie. */
export const PRINT_JOB_FINAL_STATUSES = ['DONE', 'FAILED', 'CANCELLED'] as const;

/**
 * Co agent moze zaraportowac.
 *
 * `REJECTED` konczy zadanie bez ponowienia. Uzywane, gdy powtorka nie ma sensu:
 * plik nie przeszedl lokalnej walidacji (zly rozmiar strony, za duzo stron) albo
 * ktos anulowal wydruk na panelu drukarki - ponawianie byloby wtedy dzialaniem
 * wbrew swiadomej decyzji czlowieka.
 */
export const PRINT_AGENT_REPORT_STATUSES = ['PRINTING', 'DONE', 'FAILED', 'REJECTED'] as const;

export type PrintAgentReportStatus = typeof PRINT_AGENT_REPORT_STATUSES[number];

export const PRINT_AGENT_STATUSES = ['ACTIVE', 'DISABLED'] as const;

export type PrintAgentStatus = typeof PRINT_AGENT_STATUSES[number];

/** Po tylu milisekundach ciszy agent jest pokazywany jako offline. */
export const PRINT_AGENT_ONLINE_WINDOW_MS = 90_000;

/** Jak dlugo agent trzyma zadanie, zanim reaper uzna dzierzawe za wygasla. */
export const PRINT_JOB_LEASE_MS = 10 * 60 * 1000;

/** Domyslny odstep miedzy odpytaniami agenta (sekundy). */
export const PRINT_AGENT_POLL_INTERVAL_SEC = 10;

export function isPrintJobStatus(value: string): value is PrintJobStatus {
  return (PRINT_JOB_STATUSES as readonly string[]).includes(value);
}

export function isPrintJobActive(status: string): boolean {
  return (PRINT_JOB_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isPrintAgentOnline(lastSeenAt: Date | null | undefined): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < PRINT_AGENT_ONLINE_WINDOW_MS;
}
