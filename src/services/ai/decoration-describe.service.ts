/**
 * Opisywanie ozdobnikow przez model wizyjny.
 *
 * Paczka wgrana hurtem nie ma opisu, a nazwy plikow czesto nic nie znacza
 * („Untitled-1.svg”). Model oglada grafike i proponuje tagi, kategorie oraz -
 * gdy nazwa jest pusta w tresci - nazwe.
 *
 * Wynikiem jest PROPOZYCJA, nigdy zapis: sprzedawca przeglada ja w panelu
 * i zatwierdza to, co trafne. Ta sama umowa co przy asystencie w edytorze.
 *
 * Kosztuje jedno wywolanie na plik, wiec chodzi WYLACZNIE na zadanie - nigdy
 * automatycznie przy wgrywaniu.
 */
import path from 'path';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import {
  DEFAULT_TIMEOUT_MS,
  assertAiLimits,
  extractJson,
  getProviderApiKey,
  resolveProviderAndModel,
  runAiCall,
} from './provider-client';
import { rasterizeSvgFile } from '../renderer/svg-raster.service';
import { normalizeTags } from '../../lib/template-tags';
import { listCategories, listTags } from '../admin/decorations.service';

/** Szerokosc rasteryzacji SVG - tyle wystarczy, zeby rozpoznac ksztalt. */
const PREVIEW_WIDTH_PX = 512;
const MAX_TOKENS = 400;

export class AiDescribeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiDescribeUnavailableError';
  }
}

export interface DecorationSuggestion {
  id: string;
  /** Znormalizowane tagi - gotowe do zapisania bez dalszej obrobki. */
  tags: string[];
  /** Slug istniejacej kategorii albo null, gdy model nie znalazl pasujacej. */
  category: string | null;
  /** Propozycja nazwy - tylko dla plikow o nazwie bez tresci. */
  name?: string;
  /** Czemu propozycji nie ma - panel pokazuje to przy kafelku. */
  error?: string;
}

const SYSTEM_PROMPT = [
  'Opisujesz ozdobniki graficzne do zaproszen i papeterii okolicznosciowej.',
  'Odpowiadasz wylacznie JSON-em, bez komentarza i bez bloku Markdown.',
  'Piszesz po polsku, rzeczowo, bez ozdobnikow jezykowych.',
].join(' ');

/**
 * Obraz dla modelu jako `data:` URL.
 *
 * SVG trzeba zrasteryzowac - zaden z dostawcow go nie czyta. Raster idzie
 * wprost, bo przechodzi przez ta sama sciezke `imageUrl`.
 */
async function buildImageUrl(filePath: string, mimeType: string): Promise<string> {
  const fullPath = path.join(config.storage.path, filePath);

  if (mimeType === 'image/svg+xml') {
    const png = await rasterizeSvgFile({ filePath: fullPath, widthPx: PREVIEW_WIDTH_PX });
    return `data:image/png;base64,${png.toString('base64')}`;
  }

  const fs = await import('fs/promises');
  const buffer = await fs.readFile(fullPath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Nazwa bez tresci - taka warto zastapic propozycja modelu.
 *
 * Rozpoznajemy po tym, ze z nazwy nie da sie wyciagnac ani jednego sensownego
 * czlonu (patrz lib/decoration-naming.ts) - „Untitled-1”, „export_v3”.
 */
function shouldProposeName(name: string, meaningless: boolean): boolean {
  return meaningless || name.trim().length === 0;
}

export async function describeDecorations(options: {
  tenantId: string;
  userId?: string | null;
  ids: string[];
}): Promise<{ suggestions: DecorationSuggestion[] }> {
  const { tenantId, userId } = options;
  const ids = [...new Set(options.ids.filter(Boolean))];
  if (ids.length === 0) return { suggestions: [] };

  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  if (!settings) {
    throw new AiDescribeUnavailableError('AI nie jest skonfigurowane dla tego sklepu.');
  }

  // Limit sprawdzamy RAZ, przed cala paczka - i tak przerwiemy w polowie,
  // gdyby budzet skonczyl sie po drodze (patrz petla nizej).
  await assertAiLimits(tenantId, settings);

  const { provider, model } = resolveProviderAndModel(settings, { needsVision: true });
  if (provider === 'DEEPSEEK') {
    throw new AiDescribeUnavailableError(
      'Wybrany dostawca nie obsluguje obrazow - wskaz model wizyjny w ustawieniach AI.'
    );
  }

  const apiKey = getProviderApiKey(settings, provider);

  const [rows, knownTags, categories] = await Promise.all([
    prisma.decorationAsset.findMany({
      where: { id: { in: ids }, tenantId },
      select: { id: true, name: true, filePath: true, mimeType: true, category: true },
    }),
    listTags({ tenantId, includeInactive: true }),
    listCategories({ tenantId }),
  ]);

  const { isMeaninglessFileName } = await import('../../lib/decoration-naming');
  const categorySlugs = new Set(categories.map((item) => item.slug));

  const knownTagList = knownTags.slice(0, 40).map((item) => item.tag).join(', ');
  const categoryList = categories.map((item) => `${item.slug} (${item.name})`).join(', ');

  const suggestions: DecorationSuggestion[] = [];

  for (const row of rows) {
    try {
      const imageUrl = await buildImageUrl(row.filePath, row.mimeType);
      const wantsName = shouldProposeName(row.name, isMeaninglessFileName(row.name));

      const prompt = [
        'Obejrzyj grafike i opisz ja do biblioteki ozdobnikow.',
        '',
        'Zwroc JSON:',
        wantsName
          ? '{"tags":["..."],"category":"SLUG albo null","name":"krotka nazwa"}'
          : '{"tags":["..."],"category":"SLUG albo null"}',
        '',
        'Zasady:',
        '- 3 do 6 tagow: co przedstawia grafika i do jakiej okazji pasuje.',
        knownTagList
          ? `- Uzywaj tagow, ktore juz sa w bibliotece, jesli pasuja: ${knownTagList}.`
          : '',
        '- Nowy tag proponuj tylko wtedy, gdy zaden istniejacy nie oddaje tresci.',
        '- Tagi po polsku, male litery, bez ogonkow, pojedyncze slowa.',
        categoryList
          ? `- Kategoria WYLACZNIE jedna z: ${categoryList}. Gdy zadna nie pasuje, wpisz null.`
          : '- Kategorii brak, wpisz null.',
        wantsName ? '- Nazwa: 2-4 slowa opisujace grafike, np. "Kokardka ze wstazki".' : '',
      ]
        .filter(Boolean)
        .join('\n');

      const result = await runAiCall({
        tenantId,
        userId: userId ?? null,
        provider,
        model,
        apiKey,
        action: 'DECORATION_DESCRIBE',
        source: 'ADMIN_EDITOR',
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        imageUrl,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxTokens: MAX_TOKENS,
      });

      const parsed = JSON.parse(extractJson(result.text)) as {
        tags?: unknown;
        category?: unknown;
        name?: unknown;
      };

      // Kategoria spoza biblioteki sprzedawcy odpada - model bywa kreatywny,
      // a slug musi wskazywac na istniejaca grupe.
      const category =
        typeof parsed.category === 'string' && categorySlugs.has(parsed.category)
          ? parsed.category
          : null;

      const name =
        wantsName && typeof parsed.name === 'string' && parsed.name.trim()
          ? parsed.name.trim().slice(0, 60)
          : undefined;

      suggestions.push({
        id: row.id,
        tags: normalizeTags(parsed.tags),
        category,
        ...(name ? { name } : {}),
      });
    } catch (error: any) {
      // Jeden plik nie moze przerwac calej paczki - zglaszamy go i idziemy dalej.
      suggestions.push({
        id: row.id,
        tags: [],
        category: null,
        error: error?.message || 'Nie udało się opisać tej grafiki',
      });
    }
  }

  return { suggestions };
}
