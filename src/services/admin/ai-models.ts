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
