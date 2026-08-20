/**
 * Rozbraja tresc startowa formularzy: `default_value` z faktami idzie do
 * `placeholder`, a odpowiedz zamowienia zostaje pusta, dopoki klient sam jej
 * nie wpisze.
 *
 * Po co: formularz z domyslka "16.08.2029" albo "OSIEMNASTYCH URODZIN" otwiera
 * sie WYGLADAJAC NA WYPELNIONY. Klient poprawia to, co rzuca mu sie w oczy,
 * i drukuje cudza date. Ta sama zamiana przeszla juz recznie w szablonie
 * ZAPROSZENIE_12X17 (`zaproszenie-12x17-simplify-form.ts`) - tutaj jest zrobiona
 * dla dowolnego szablonu, bo problem ma ich kilkanascie.
 *
 * Czego skrypt NIE psuje:
 *
 *  - ZDJECIA PRODUKTU. Miniatura bierze przykladowa odpowiedz w kolejnosci
 *    `default_value` -> pierwsza opcja listy -> `placeholder` bez "np."
 *    (`template-thumbnail.service.ts` -> `sampleValue`), wiec tresc przeniesiona
 *    do podpowiedzi nadal maluje karte.
 *  - PODGLADU W EDYTORZE. Ten rysuje `properties.text` warstwy. Gdyby warstwa
 *    pola byla pusta, straconoby jedyna kopie przykladu - skrypt wpisuje ja
 *    wtedy do warstwy, zanim wyczysci pole (patrz `backfillLayerTexts`).
 *  - ZLOZONYCH ZAMOWIEN. Ruszamy definicje formularza, nie odpowiedzi klientow.
 *
 * Pola listy wyboru zostaja bez zmian: tam domyslka jest widocznym wyborem,
 * a nie cicha tresci.
 *
 * Uruchomienie (domyslnie DRY RUN - nic nie zapisuje):
 *
 *   pnpm tsx src/scripts/defuse-template-defaults.ts
 *   pnpm tsx src/scripts/defuse-template-defaults.ts --template=URODZINY_18
 *   pnpm tsx src/scripts/defuse-template-defaults.ts --apply
 *
 * Idempotentny - po zapisie kolejne uruchomienia nie maja co zmieniac.
 *
 * Na produkcji: kompilacja lokalna i `docker cp` do /app/dist/scripts
 * (w kontenerze nie ma tsx) - patrz docs/operations.md.
 */
import { getTemplateVariants, type TemplateLayoutJson } from '@msierpien/kp-template-core';
import prisma from '../lib/prisma';
import { CHOICE_TYPES, NO_PLACEHOLDER_TYPES, describeRisk, hintFromDefault } from './lib/risky-defaults';

type LayerLike = Record<string, any>;

interface PlannedField {
  id: string;
  key: string;
  label: string;
  type: string;
  reason: string;
  oldDefault: string;
  /** `null`, gdy typ pola nie pokazuje podpowiedzi - zostaje samo czyszczenie. */
  newPlaceholder: string | null;
  /** Tresc dopisana do warstwy, zeby przyklad nie zniknal z podgladu. */
  backfilledLayers: string[];
}

interface PlannedTemplate {
  id: string;
  code: string;
  name: string;
  fields: PlannedField[];
  /** Layout do zapisu - `null`, gdy zadna warstwa nie wymagala uzupelnienia. */
  nextLayout: TemplateLayoutJson | null;
}

/**
 * Wpisuje przykladowa tresc do warstw pola, ktore maja ja pusta.
 *
 * Dotyczy tylko warstw z `fieldKey` rownym czyszczonemu polu i tylko takich,
 * ktore nie maja wlasnego tekstu. Warstwa z wlasna tresci (czesty przypadek:
 * projektant poprawil napis w edytorze) zostaje nietknieta - to ona jest
 * wersja aktualna, nie domyslka sprzed roku.
 */
function backfillLayerTexts(layout: TemplateLayoutJson, texts: Record<string, string>) {
  const touched: Record<string, string[]> = {};
  let changed = false;

  const nextVariants = getTemplateVariants(layout).map((variant) => ({
    ...variant,
    pages: (variant.pages ?? []).map((page: any) => ({
      ...page,
      layers: (page.layers ?? []).map((layer: LayerLike) => {
        const key = layer.properties?.fieldKey;
        const fill = key ? texts[key] : undefined;
        if (!fill || String(layer.properties?.text ?? '').trim()) return layer;

        changed = true;
        touched[key] = [...(touched[key] ?? []), layer.id];
        return { ...layer, properties: { ...layer.properties, text: fill } };
      }),
    })),
  }));

  if (!changed) return { layout: null, touched };

  // Lustro (`pages`/`layers`/`canvas`) idzie z pierwszego wariantu - tak trzyma
  // je `withTemplateVariants`, wiec nie przeliczamy go osobno.
  const first = nextVariants[0];
  const next = {
    ...layout,
    pages: first?.pages ?? (layout as any).pages,
    canvas: first?.pages?.[0]?.canvas ?? layout.canvas,
    layers: first?.pages?.[0]?.layers ?? (layout as any).layers,
    ...((layout as any).variants ? { variants: nextVariants } : {}),
  } as TemplateLayoutJson;

  return { layout: next, touched };
}

function planTemplate(template: {
  id: string;
  code: string;
  name: string;
  layoutJson: unknown;
  forms: Array<{ fields: Array<Record<string, any>> }>;
}): PlannedTemplate | null {
  const risky = template.forms
    .flatMap((form) => form.fields)
    .filter((field) => !CHOICE_TYPES.has(field.type))
    .map((field) => {
      const oldDefault = String(field.defaultValue ?? '');
      const reason = describeRisk(oldDefault);
      return reason ? { field, oldDefault, reason } : null;
    })
    .filter((entry): entry is { field: Record<string, any>; oldDefault: string; reason: string } => Boolean(entry));

  if (risky.length === 0) return null;

  const layout = template.layoutJson as TemplateLayoutJson | null;
  const backfill = layout
    ? backfillLayerTexts(
        layout,
        Object.fromEntries(risky.map(({ field, oldDefault }) => [field.key, oldDefault]))
      )
    : { layout: null, touched: {} as Record<string, string[]> };

  return {
    id: template.id,
    code: template.code,
    name: template.name,
    nextLayout: backfill.layout,
    fields: risky.map(({ field, oldDefault, reason }) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      reason,
      oldDefault: oldDefault.replace(/\n/g, ' / '),
      newPlaceholder: NO_PLACEHOLDER_TYPES.has(field.type)
        ? null
        : String(field.placeholder ?? '').trim() || hintFromDefault(oldDefault),
      backfilledLayers: backfill.touched[field.key] ?? [],
    })),
  };
}

async function applyTemplate(plan: PlannedTemplate) {
  for (const field of plan.fields) {
    await prisma.formField.update({
      where: { id: field.id },
      data: {
        defaultValue: null,
        ...(field.newPlaceholder ? { placeholder: field.newPlaceholder } : {}),
      },
    });
  }

  if (!plan.nextLayout) return;

  // Poprzedni layout ląduje w historii wersji - zmiane da sie cofnac z panelu.
  const previous = await prisma.personalizationTemplate.findUnique({
    where: { id: plan.id },
    select: { layoutJson: true },
  });

  if (previous?.layoutJson) {
    await prisma.templateLayoutVersion.create({
      data: {
        templateId: plan.id,
        layoutJson: previous.layoutJson as any,
        summary: 'przed przeniesieniem tresci startowej z formularza do warstw',
      },
    });
  }

  await prisma.personalizationTemplate.update({
    where: { id: plan.id },
    data: { layoutJson: plan.nextLayout as any },
  });
}

async function main() {
  const args = process.argv.slice(2);
  const templateArg = args.find((arg) => arg.startsWith('--template='))?.split('=')[1];
  const apply = args.includes('--apply');

  const templates = await prisma.personalizationTemplate.findMany({
    where: templateArg ? { code: templateArg } : undefined,
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      layoutJson: true,
      forms: {
        select: {
          fields: {
            orderBy: { sortOrder: 'asc' },
            select: { id: true, key: true, label: true, type: true, defaultValue: true, placeholder: true },
          },
        },
      },
    },
  });

  const plans = templates
    .map((template) => planTemplate(template as never))
    .filter((plan): plan is PlannedTemplate => plan !== null);

  if (plans.length === 0) {
    console.log('Nie ma czego rozbrajac - zadna tresc startowa nie wyglada na fakty.');
    return;
  }

  for (const plan of plans) {
    console.log(`== ${plan.code} — ${plan.name}`);
    for (const field of plan.fields) {
      const hint = field.newPlaceholder
        ? `podpowiedz: "${field.newPlaceholder}"`
        : `typ ${field.type} nie pokazuje podpowiedzi - zostaje samo czyszczenie`;
      const backfill = field.backfilledLayers.length
        ? `, tresc dopisana do warstw: ${field.backfilledLayers.join(', ')}`
        : '';
      console.log(`   ${field.key} (${field.label}) — ${field.reason}`);
      console.log(`      "${field.oldDefault}" → ${hint}${backfill}`);
    }
    console.log('');

    if (apply) await applyTemplate(plan);
  }

  const fieldCount = plans.reduce((sum, plan) => sum + plan.fields.length, 0);
  console.log(
    apply
      ? `Zapisano: ${fieldCount} pol w ${plans.length} szablonach.`
      : `DRY RUN — do zmiany ${fieldCount} pol w ${plans.length} szablonach. Uruchom z --apply, zeby zapisac.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
