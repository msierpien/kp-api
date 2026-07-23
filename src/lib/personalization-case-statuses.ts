export const PERSONALIZATION_CASE_STATUSES = [
  'NEW',
  'WAITING_FOR_CUSTOMER',
  'DRAFT',
  'PREVIEW_READY',
  'SUBMITTED',
  'RENDERED',
  'FAILED_RENDER',
  'READY_FOR_PRINT',
  'ARCHIVED',
] as const;

export type PersonalizationCaseStatus = typeof PERSONALIZATION_CASE_STATUSES[number];

export function isPersonalizationCaseStatus(value: string): value is PersonalizationCaseStatus {
  return (PERSONALIZATION_CASE_STATUSES as readonly string[]).includes(value);
}
