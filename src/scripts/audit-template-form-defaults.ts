/**
 * Audyt formularzy szablonow pod katem tresci, ktora KLIENT MOZE PRZEOCZYC.
 *
 * Zaproszenie sprzedaje sie latami, a napisy na nim starzeja sie razem z nim:
 * "OSIEMNASTYCH URODZIN" na wzorze kupionym pod trzydziestke, "16.08.2029"
 * u kogos, kto ma przyjecie w maju, podpis "Dorota" u Kowalskich. Formularz
 * z takimi wartosciami w `default_value` otwiera sie WYGLADAJAC NA WYPELNIONY -
 * klient poprawia to, co rzuca mu sie w oczy, klika Dalej i drukuje cudza
 * uroczystosc.
 *
 * Skrypt szuka trzech rodzin usterek:
 *
 *  1. RYZYKOWNA DOMYSLKA (`risky-default`) - `default_value`, ktore wyglada
 *     na prawdziwa tresc: data, godzina, liczebnik wieku / rocznicy, imie,
 *     nazwa lokalu. Wzorzec z "xx.xx.xxxx" nie jest ryzykowny - widac go na
 *     pierwszy rzut oka (patrz zaproszenie-12x17-simplify-form.ts).
 *
 *  2. OSIEROCONY fieldKey (`orphan-field-key`) - warstwa wskazuje na pole,
 *     ktorego w formularzu NIE MA. Render podmienia tresc warstwy na odpowiedz
 *     klienta, a odpowiedzi nie bedzie, wiec napis zostaje taki, jak go
 *     zbudowano - i nie ma go jak zmienic z formularza.
 *
 *  3. POLE BEZ PODPOWIEDZI (`no-hint`) - pole tekstowe bez `default_value`
 *     i bez `placeholder`. Nie jest usterka samo w sobie, ale w parze
 *     z punktem 1 pokazuje, gdzie tresc startowa zniknela zamiast zamienic
 *     sie w podpowiedz.
 *
 * Uruchomienie (NIC nie zapisuje - to sam raport):
 *
 *   pnpm tsx src/scripts/audit-template-form-defaults.ts
 *   pnpm tsx src/scripts/audit-template-form-defaults.ts --template=URODZINY_18
 *   pnpm tsx src/scripts/audit-template-form-defaults.ts --json
 *
 * Na produkcji: kompilacja lokalna i `docker cp` do /app/dist/scripts
 * (w kontenerze nie ma tsx) - patrz docs/operations.md.
 */
import { getTemplateVariants, type TemplateLayoutJson } from '@msierpien/kp-template-core';
import prisma from '../lib/prisma';
import { CHOICE_TYPES, NO_PLACEHOLDER_TYPES, describeRisk } from './lib/risky-defaults';

type LayerLike = Record<string, any>;

type FindingKind = 'risky-default' | 'orphan-field-key' | 'no-hint';

interface Finding {
  kind: FindingKind;
  /** Klucz pola formularza albo warstwy - po nim sie potem poprawia. */
  key: string;
  label?: string;
  /** Co dokladnie w tej wartosci wyglada na prawdziwa tresc. */
  reason: string;
  value?: string;
}

interface TemplateReport {
  code: string;
  name: string;
  findings: Finding[];
}

/** Pola, przy ktorych domyslka z faktami boli najbardziej - do sortowania raportu. */
function severityOf(finding: Finding): number {
  if (finding.kind === 'orphan-field-key') return 0;
  if (finding.kind === 'risky-default') return 1;
  return 2;
}

/** Wszystkie warstwy szablonu - z kazdego wariantu i kazdej strony. */
function collectLayers(layout: TemplateLayoutJson | null): Array<{ where: string; layer: LayerLike }> {
  if (!layout) return [];

  const out: Array<{ where: string; layer: LayerLike }> = [];
  for (const variant of getTemplateVariants(layout)) {
    variant.pages?.forEach((page: any, pageIndex: number) => {
      (page.layers ?? []).forEach((layer: LayerLike) => {
        out.push({ where: `${variant.id}/strona ${pageIndex + 1}`, layer });
      });
    });
  }

  return out;
}

function auditTemplate(template: {
  code: string;
  name: string;
  layoutJson: unknown;
  forms: Array<{ fields: Array<Record<string, any>> }>;
}): TemplateReport {
  const fields = template.forms.flatMap((form) => form.fields);
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const findings: Finding[] = [];

  for (const field of fields) {
    const value = String(field.defaultValue ?? '');
    const reason = describeRisk(value);

    // Lista wyboru pokazuje wszystkie warianty naraz, wiec domyslka nie udaje
    // tresci wpisanej przez klienta - to widoczny wybor, nie cichy zapis.
    if (reason && !CHOICE_TYPES.has(field.type)) {
      findings.push({
        kind: 'risky-default',
        key: field.key,
        label: field.label,
        reason,
        value: value.replace(/\n/g, ' / '),
      });
    }

    const hintable = !NO_PLACEHOLDER_TYPES.has(field.type);
    if (hintable && !value && !String(field.placeholder ?? '').trim()) {
      findings.push({
        kind: 'no-hint',
        key: field.key,
        label: field.label,
        reason: 'pole bez tresci startowej i bez podpowiedzi',
      });
    }
  }

  const seenOrphans = new Set<string>();
  for (const { where, layer } of collectLayers(template.layoutJson as TemplateLayoutJson | null)) {
    const fieldKey = layer.properties?.fieldKey;
    if (!fieldKey || fieldByKey.has(fieldKey) || seenOrphans.has(fieldKey)) continue;

    seenOrphans.add(fieldKey);
    findings.push({
      kind: 'orphan-field-key',
      key: fieldKey,
      reason: `warstwa "${layer.id}" (${where}) wskazuje na pole, ktorego nie ma w formularzu`,
      value: String(layer.properties?.text ?? '').slice(0, 80).replace(/\n/g, ' / '),
    });
  }

  findings.sort((a, b) => severityOf(a) - severityOf(b) || a.key.localeCompare(b.key));

  return { code: template.code, name: template.name, findings };
}

const KIND_LABEL: Record<FindingKind, string> = {
  'risky-default': 'RYZYKOWNA DOMYSLKA',
  'orphan-field-key': 'OSIEROCONY fieldKey',
  'no-hint': 'bez podpowiedzi',
};

async function main() {
  const args = process.argv.slice(2);
  const templateArg = args.find((arg) => arg.startsWith('--template='))?.split('=')[1];
  const asJson = args.includes('--json');

  const templates = await prisma.personalizationTemplate.findMany({
    where: templateArg ? { code: templateArg } : undefined,
    orderBy: { code: 'asc' },
    select: {
      code: true,
      name: true,
      layoutJson: true,
      forms: {
        select: {
          fields: {
            orderBy: { sortOrder: 'asc' },
            select: {
              key: true,
              label: true,
              type: true,
              defaultValue: true,
              placeholder: true,
              optionsJson: true,
            },
          },
        },
      },
    },
  });

  const reports = templates.map((template) => auditTemplate(template as never));

  if (asJson) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  const withFindings = reports.filter((report) => report.findings.length > 0);

  console.log(`Przejrzano szablonow: ${reports.length}, z uwagami: ${withFindings.length}\n`);

  for (const report of withFindings) {
    console.log(`== ${report.code} — ${report.name}`);
    for (const finding of report.findings) {
      const label = finding.label ? ` (${finding.label})` : '';
      const value = finding.value ? ` → "${finding.value}"` : '';
      console.log(`   [${KIND_LABEL[finding.kind]}] ${finding.key}${label}: ${finding.reason}${value}`);
    }
    console.log('');
  }

  const risky = withFindings.reduce(
    (sum, report) => sum + report.findings.filter((f) => f.kind === 'risky-default').length,
    0
  );
  const orphans = withFindings.reduce(
    (sum, report) => sum + report.findings.filter((f) => f.kind === 'orphan-field-key').length,
    0
  );

  console.log(`Razem: ${risky} ryzykownych domyslek, ${orphans} osieroconych fieldKey.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
