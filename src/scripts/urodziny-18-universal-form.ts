/**
 * Robi z zaproszenia URODZINY_18 wzor na KAZDE urodziny, nie tylko na
 * osiemnastke.
 *
 * Problem: kartka ma trzy napisy przywiazane do wieku - motto ("Osiemnascie
 * lat to poczatek nowej podrozy"), formule okazji ("NA PRZYJECIE Z OKAZJI
 * MOICH OSIEMNASTYCH URODZIN") i zwrot wprowadzajacy. Dwa pierwsze klient
 * zamawiajacy trzydziestke musi zauwazyc i przepisac SAM - a motta i zwrotu
 * nie ma nawet w formularzu (warstwy wskazuja na pola, ktore ktos usunal),
 * wiec z formularza nie da sie ich zmienic w ogole.
 *
 * Co robi skrypt:
 *
 *  1. WRACAJA POLA `quote_text` i `invitation_intro`. Warstwy juz na nie
 *     wskazuja - brakowalo drugiej strony tego polaczenia.
 *  2. TRZY POLA STAJA SIE LISTA WYBORU z wlasnym tekstem (`allowCustom`).
 *     Lista pokazuje wszystkie mozliwosci naraz, wiec klient WIDZI, ze ten
 *     napis jest jego decyzja - inaczej niz tresc startowa w polu tekstowym,
 *     ktora wyglada na gotowa.
 *  3. FORMULA OKAZJI TRACI LICZEBNIK. Liczba lat jest juz na kartce jako duza
 *     cyfra w przerwie kreski (pole `age_number`), wiec "OSIEMNASTYCH" na
 *     dole powtarzalo ja slowem - i tylko to slowo starzalo sie z wzorem.
 *     Wersja z liczebnikiem zostaje na liscie dla tych, ktorzy ja lubia.
 *  4. Pola sa WYMAGANE i bez tresci startowej: bez swiadomego wyboru klient
 *     nie przejdzie do podgladu. Renderer zostawia wtedy napis z szablonu
 *     (`fabric-renderer.service`: pusta odpowiedz nie kasuje `properties.text`),
 *     wiec zaden druk nie wyjdzie z dziura.
 *
 * Uruchomienie (domyslnie DRY RUN):
 *
 *   pnpm tsx src/scripts/urodziny-18-universal-form.ts
 *   pnpm tsx src/scripts/urodziny-18-universal-form.ts --apply
 *
 * Idempotentny. Layoutu NIE rusza - warstwy zostaja takie, jakie sa.
 *
 * Na produkcji: kompilacja lokalna i `docker cp` do /app/dist/scripts
 * (w kontenerze nie ma tsx) - patrz docs/operations.md.
 */
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

const TEMPLATE_CODE = 'URODZINY_18';

/** Opcja listy: `value` idzie na kartke, `label` widzi klient w rozwijanym menu. */
type Option = { value: string; label: string };

/** Etykieta jednoliniowa - w rozwijanym menu lamanie wiersza i tak nie wyglada. */
function option(value: string): Option {
  return { value, label: value.replace(/\n/g, ' · ') };
}

/**
 * Motta. Pierwsze cztery nie mowia o wieku ani slowem - dzialaja na trzydziestce
 * tak samo jak na osiemnastce. Ostatnie dwa zostaja dla konkretnych okazji.
 *
 * Limit pola to 110 znakow (tyle miesci ramka motta) - dluzsze warianty nie
 * przeszlyby walidacji odpowiedzi.
 */
const QUOTE_OPTIONS: Option[] = [
  option('Są takie chwile, które chce się\nprzeżywać w dobrym towarzystwie'),
  option('Najpiękniejsze wspomnienia\npowstają wtedy, gdy jesteśmy razem'),
  option('Czas najlepiej mierzyć\nliczbą pięknych chwil'),
  option('Ten dzień chcę świętować\nz ludźmi, na których mi zależy'),
  option('Osiemnaście lat to początek nowej podróży\n– pełnej marzeń, wyzwań i pięknych chwil'),
  option('Okrągła rocznica to dobry moment,\nżeby spotkać się w swoim gronie'),
];

/**
 * Formuly okazji. Wersaliki - krój nie zamienia liter automatycznie.
 *
 * Pierwsze trzy nie zawieraja liczebnika: wiek pokazuje cyfra w kresce, wiec
 * napis dziala na kazdych urodzinach.
 */
const OCCASION_OPTIONS: Option[] = [
  option('NA PRZYJĘCIE Z OKAZJI\nMOICH URODZIN'),
  option('NA PRZYJĘCIE URODZINOWE'),
  option('NA WSPÓLNE ŚWIĘTOWANIE\nMOICH URODZIN'),
  option('NA PRZYJĘCIE Z OKAZJI MOICH\nOSIEMNASTYCH URODZIN'),
  option('NA PRZYJĘCIE Z OKAZJI\nMOJEJ OKRĄGŁEJ ROCZNICY'),
];

/** Zwrot wprowadzajacy - nie starzeje sie z wiekiem, wiec ma tresc startowa. */
const INTRO_OPTIONS: Option[] = [
  option('SERDECZNIE ZAPRASZAM'),
  option('SERDECZNIE ZAPRASZAMY'),
  option('MAM ZASZCZYT ZAPROSIĆ'),
  option('Z RADOŚCIĄ ZAPRASZAM'),
];

interface FieldPlan {
  key: string;
  label: string;
  scope: 'SHARED' | 'INDIVIDUAL';
  required: boolean;
  sortOrder: number;
  maxLength: number;
  options: Option[];
  helpText: string;
  placeholder: string;
  /** Tresc startowa - tylko tam, gdzie napis nie zalezy od wieku. */
  defaultValue?: string;
}

const PLAN: FieldPlan[] = [
  {
    key: 'quote_text',
    label: 'Motto',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    maxLength: 110,
    options: QUOTE_OPTIONS,
    helpText: 'Wybierz z listy albo wpisz własne. Cztery pierwsze pasują do każdych urodzin.',
    placeholder: 'Wybierz motto…',
  },
  {
    key: 'invitation_intro',
    label: 'Zwrot wprowadzający',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    maxLength: 30,
    options: INTRO_OPTIONS,
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie.',
    placeholder: 'Wybierz zwrot…',
    defaultValue: 'SERDECZNIE ZAPRASZAM',
  },
  {
    key: 'occasion_text',
    label: 'Okazja',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    maxLength: 90,
    options: OCCASION_OPTIONS,
    helpText:
      'Liczba lat jest już na zaproszeniu jako duża cyfra - formuła nie musi jej powtarzać słowem.',
    placeholder: 'Wybierz formułę…',
  },
];

/** Najdluzsza opcja musi zmiescic sie w limicie pola, inaczej odbije ja walidacja. */
function assertOptionsFit(plan: FieldPlan) {
  const tooLong = plan.options.filter((entry) => entry.value.length > plan.maxLength);
  if (tooLong.length > 0) {
    throw new Error(
      `Pole ${plan.key}: opcje dluzsze niz ${plan.maxLength} znakow: ${tooLong
        .map((entry) => `"${entry.label}" (${entry.value.length})`)
        .join(', ')}`
    );
  }
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply');

  PLAN.forEach(assertOptionsFit);

  const template = await prisma.personalizationTemplate.findFirst({
    where: { code: TEMPLATE_CODE },
    include: { forms: { include: { fields: true }, orderBy: { sortOrder: 'asc' } } },
  });
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`);

  const form = template.forms[0];
  if (!form) throw new Error('Szablon nie ma formularza');

  const existing = new Map(form.fields.map((field) => [field.key, field]));
  const report: string[] = [];

  for (const plan of PLAN) {
    const current = existing.get(plan.key);
    const data = {
      label: plan.label,
      type: 'select',
      scope: plan.scope as any,
      required: plan.required,
      sortOrder: plan.sortOrder,
      maxLength: plan.maxLength,
      placeholder: plan.placeholder,
      helpText: plan.helpText,
      // Tresc startowa tylko tam, gdzie napis nie zalezy od wieku - reszta ma
      // wymusic swiadomy wybor.
      defaultValue: plan.defaultValue ?? null,
      optionsJson: plan.options as unknown as Prisma.InputJsonValue,
      // Portal pokazuje "Wlasny tekst..." wylacznie przy tej fladze - bez niej
      // lista bylaby zamknieta, a nikt nie przewidzi wszystkich formul.
      validationRulesJson: { allowCustom: true } as Prisma.InputJsonValue,
    };

    if (current) {
      report.push(
        `zmiana  ${plan.key}: ${current.type} → select, ${plan.options.length} opcji, wymagane=${plan.required}` +
          (current.defaultValue ? `, tresc startowa "${current.defaultValue.replace(/\n/g, ' / ')}" znika` : '')
      );
      if (apply) await prisma.formField.update({ where: { id: current.id }, data });
    } else {
      report.push(`dodanie ${plan.key}: select, ${plan.options.length} opcji, wymagane=${plan.required}`);
      if (apply) await prisma.formField.create({ data: { formId: form.id, key: plan.key, ...data } });
    }
  }

  console.log(report.join('\n'));

  if (!apply) {
    console.log('\nDRY RUN — nic nie zapisano. Uruchom z --apply.');
    return;
  }

  const after = await prisma.formField.findMany({
    where: { formId: form.id },
    orderBy: { sortOrder: 'asc' },
    select: { key: true, label: true, type: true, required: true, defaultValue: true },
  });

  console.log('\nFormularz po zmianie:');
  for (const field of after) {
    const value = field.defaultValue ? ` = "${field.defaultValue.replace(/\n/g, ' / ')}"` : '';
    console.log(`  ${field.key} (${field.type}${field.required ? ', wymagane' : ''})${value}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
