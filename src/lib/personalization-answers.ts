export type FieldScopeValue = 'SHARED' | 'INDIVIDUAL';

export interface PersonalizationAnswerField {
  key: string;
  required?: boolean | null;
  scope?: FieldScopeValue | null;
  repeaterGroupKey?: string | null;
}

export interface StructuredCaseAnswers {
  sharedAnswers: Record<string, any>;
  items: Array<Record<string, any>>;
}

export interface CaseAnswerProgress {
  filled: number;
  qty: number;
  sharedFilled: number;
  sharedTotal: number;
  itemFilled: number;
  itemTotal: number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getFieldScope(field: PersonalizationAnswerField): FieldScopeValue {
  if (field.scope === 'INDIVIDUAL' || field.repeaterGroupKey) return 'INDIVIDUAL';
  return 'SHARED';
}

export function normalizeCaseAnswers(
  rawAnswers: unknown,
  fields: PersonalizationAnswerField[] = [],
  quantity = 1
): StructuredCaseAnswers {
  const normalizedQuantity = Math.max(1, Number(quantity) || 1);
  const raw = isRecord(rawAnswers) ? rawAnswers : {};

  if ('sharedAnswers' in raw || 'items' in raw) {
    const items = Array.isArray(raw.items)
      ? raw.items.map((item) => (isRecord(item) ? item : {}))
      : [];

    while (items.length < normalizedQuantity) {
      items.push({});
    }

    return {
      sharedAnswers: isRecord(raw.sharedAnswers) ? raw.sharedAnswers : {},
      items,
    };
  }

  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const sharedAnswers: Record<string, any> = {};
  const firstItemAnswers: Record<string, any> = {};

  for (const [key, value] of Object.entries(raw)) {
    const field = fieldByKey.get(key);
    if (field && getFieldScope(field) === 'INDIVIDUAL') {
      firstItemAnswers[key] = value;
    } else {
      sharedAnswers[key] = value;
    }
  }

  const items = Array.from({ length: normalizedQuantity }, (_, index) =>
    index === 0 ? firstItemAnswers : {}
  );

  return { sharedAnswers, items };
}

export function mergeCaseAnswers(
  currentAnswers: unknown,
  payload: { answers?: any; sharedAnswers?: Record<string, any>; items?: Array<Record<string, any>> },
  fields: PersonalizationAnswerField[] = [],
  quantity = 1
): StructuredCaseAnswers {
  const current = normalizeCaseAnswers(currentAnswers, fields, quantity);
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));

  if (isRecord(payload.answers)) {
    for (const [key, value] of Object.entries(payload.answers)) {
      const field = fieldByKey.get(key);
      if (field && getFieldScope(field) === 'INDIVIDUAL') {
        current.items[0] = { ...(current.items[0] || {}), [key]: value };
      } else {
        current.sharedAnswers[key] = value;
      }
    }
  }

  if (isRecord(payload.sharedAnswers)) {
    current.sharedAnswers = {
      ...current.sharedAnswers,
      ...payload.sharedAnswers,
    };
  }

  if (Array.isArray(payload.items)) {
    const maxLength = Math.max(current.items.length, payload.items.length, Math.max(1, Number(quantity) || 1));
    current.items = Array.from({ length: maxLength }, (_, index) => ({
      ...(current.items[index] || {}),
      ...(isRecord(payload.items?.[index]) ? payload.items[index] : {}),
    }));
  }

  return current;
}

export function flattenCaseAnswers(answers: unknown, itemIndex = 0): Record<string, any> {
  const normalized = normalizeCaseAnswers(answers);
  return {
    ...normalized.sharedAnswers,
    ...(normalized.items[itemIndex] || {}),
  };
}

export function hasAnswerValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function countFilledFields(fields: PersonalizationAnswerField[], answers: Record<string, any>): number {
  return fields.filter((field) => hasAnswerValue(answers[field.key])).length;
}

function fieldsToCheck(fields: PersonalizationAnswerField[]): PersonalizationAnswerField[] {
  const required = fields.filter((field) => field.required);
  return required.length > 0 ? required : fields;
}

export function computeCaseAnswerProgress(
  rawAnswers: unknown,
  fields: PersonalizationAnswerField[],
  quantity = 1
): CaseAnswerProgress {
  const qty = Math.max(1, Number(quantity) || 1);
  const answers = normalizeCaseAnswers(rawAnswers, fields, qty);
  const sharedFields = fields.filter((field) => getFieldScope(field) === 'SHARED');
  const itemFields = fields.filter((field) => getFieldScope(field) === 'INDIVIDUAL');
  const sharedRequired = fieldsToCheck(sharedFields);
  const itemRequired = fieldsToCheck(itemFields);
  const sharedFilled = countFilledFields(sharedRequired, answers.sharedAnswers);
  const sharedComplete = sharedRequired.length === 0 || sharedFilled >= sharedRequired.length;

  const itemFilled = itemFields.length
    ? answers.items.slice(0, qty).filter((item) => countFilledFields(itemRequired, item) >= itemRequired.length).length
    : sharedComplete
      ? qty
      : 0;

  return {
    filled: itemFilled,
    qty,
    sharedFilled,
    sharedTotal: sharedRequired.length,
    itemFilled,
    itemTotal: itemRequired.length,
  };
}
