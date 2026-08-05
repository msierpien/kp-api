/**
 * Normalizacja identyfikatorow modeli.
 *
 * Nazwy krazą w dwoch zapisach: z kropka ("claude-sonnet-4.6") i z myslnikiem
 * ("claude-sonnet-4-6"). API dostawcy przyjmuje tylko ten drugi, wiec pierwszy
 * tlumaczymy zamiast odrzucac - inaczej literowka w ustawieniach konczy sie
 * bledem dopiero przy pierwszym wywolaniu modelu.
 *
 * Modele rodziny Claude 5 (`claude-opus-5`, `claude-sonnet-5`) nie maja
 * wersji z kropka, wiec przechodza bez zmiany.
 */
export function normalizeAiModelId(model: string): string;
export function normalizeAiModelId(model?: string | null): string | null | undefined;
export function normalizeAiModelId(model?: string | null) {
  if (!model) return model;

  const aliases: Record<string, string> = {
    'claude-opus-4.8': 'claude-opus-4-8',
    'claude-sonnet-4.6': 'claude-sonnet-4-6',
    'claude-haiku-4.5': 'claude-haiku-4-5',
  };

  return aliases[model] ?? model;
}
