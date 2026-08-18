/**
 * Miniatury szablonow do biblioteki w panelu.
 *
 * Renderujemy po stronie serwera i zapisujemy do magazynu, zamiast rysowac
 * fabricem w przegladarce na kazdym wejsciu na liste: layouty maja tla i
 * czcionki, wiec kilkanascie kart znaczyloby kilkanascie rownoleglych
 * renderow w karcie panelu. Tu render dzieje sie raz - po zapisie layoutu.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import { NotFoundError } from '../../lib/errors';
import type { TemplateLayoutJson } from '../../types/template-layout';
import { resolveStorageFilePath } from '../storage/local-storage.service';

const logger = createLogger('template-thumbnail');

/** Szerokosc miniatury - karta w bibliotece ma ~360 px, wiec z zapasem na 2x. */
const THUMBNAIL_WIDTH_PX = 720;

function sanitizePathPart(value: string) {
  return path
    .basename(value)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

interface SampleField {
  key: string;
  defaultValue: string | null;
  placeholder: string | null;
  optionsJson: unknown;
}

/** Pierwsza opcja listy wyboru - `optionsJson` bywa tablica stringow albo obiektow. */
function firstOption(optionsJson: unknown): string {
  if (!Array.isArray(optionsJson)) return '';
  const first = optionsJson[0];
  if (typeof first === 'string') return first.trim();
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>;
    return String(record.value ?? record.label ?? '').trim();
  }
  return '';
}

/**
 * Przykladowa wartosc pola na miniature.
 *
 * Kolejnosc: wartosc domyslna, pierwsza opcja listy, na koniec `placeholder`
 * bez wiodacego „np.” (z „np. 9” robi sie „9”). Warstwy tekstowe poradzilyby
 * sobie same - renderer wstawia im wtedy wlasny `placeholder` - ale napisy
 * skladane z szablonu („STOLIK {{ stolik }}”) bez odpowiedzi zostawiaja na
 * miniaturze surowy znacznik w klamerkach.
 */
function sampleValue(field: SampleField): string {
  const defaultValue = (field.defaultValue ?? '').trim();
  if (defaultValue) return defaultValue;

  const option = firstOption(field.optionsJson);
  if (option) return option;

  return (field.placeholder ?? '').trim().replace(/^np\.?\s*/i, '');
}

/**
 * Przykladowe odpowiedzi calego szablonu. Eksportowane, bo sprawdzenie skladu
 * (`src/scripts/template-thumbnail-render-check.ts`) liczy je bez bazy.
 */
export function buildSampleAnswers(forms: Array<{ fields: SampleField[] }>) {
  const answers: Record<string, string> = {};
  for (const form of forms) {
    for (const field of form.fields) {
      const value = sampleValue(field);
      if (value) answers[field.key] = value;
    }
  }
  return answers;
}

/** Katalog miniatur szablonu w magazynie (sciezka relatywna od storage root). */
function thumbnailDir(templateCode: string, templateId: string) {
  return path.posix.join('templates', sanitizePathPart(templateCode) || templateId, 'thumbnail');
}

/**
 * Usuwa poprzednie miniatury tego szablonu.
 *
 * Nazwa pliku zawiera skrot layoutu, wiec kazdy zapis projektu daje nowy plik -
 * bez sprzatania katalog rosnie o kolejna kopie przy kazdym Ctrl+S. Zostawiamy
 * wylacznie plik aktualny.
 */
async function pruneOldThumbnails(dirRelative: string, keepFileName: string) {
  try {
    const dirAbsolute = resolveStorageFilePath(dirRelative);
    const entries = await fs.readdir(dirAbsolute);
    await Promise.all(
      entries
        .filter((entry) => entry !== keepFileName && /^thumb-.*\.jpg$/.test(entry))
        .map((entry) => fs.unlink(path.join(dirAbsolute, entry)).catch(() => undefined))
    );
  } catch {
    // Brak katalogu albo brak praw - miniatura jest juz zapisana, nie przerywamy.
  }
}

/**
 * Renderuje i zapisuje miniature szablonu, zwraca sciezke relatywna w magazynie
 * (taka sama konwencja jak `imageUrl` warstw - panel sklada z niej adres
 * `${API_URL}/storage/...`).
 *
 * Zwraca `null`, gdy szablon nie ma jeszcze layoutu - to nie blad, tylko
 * nowy szablon bez projektu.
 */
export async function regenerateTemplateThumbnail(templateId: string): Promise<string | null> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      code: true,
      layoutJson: true,
      thumbnailUrl: true,
      forms: {
        select: {
          fields: {
            select: { key: true, defaultValue: true, placeholder: true, optionsJson: true },
          },
        },
      },
    },
  });

  if (!template) {
    throw new NotFoundError('Szablon nie znaleziony');
  }

  const layout = (template.layoutJson as unknown as TemplateLayoutJson | null) ?? null;
  if (!layout || !Array.isArray(layout.layers)) {
    return null;
  }

  // Renderer ciagnie za soba node-canvas i czcionki - import dynamiczny, zeby
  // proces API bez renderowania nie placil za to przy starcie.
  const { renderTemplateThumbnailJpeg } = await import('../renderer/fabric-renderer.service');

  const answers = buildSampleAnswers(template.forms);
  const render = await renderTemplateThumbnailJpeg(layout, answers, { widthPx: THUMBNAIL_WIDTH_PX });

  const layoutHash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ layout, answers }))
    .digest('hex')
    .slice(0, 10);

  const dirRelative = thumbnailDir(template.code, template.id);
  const fileName = `thumb-${layoutHash}.jpg`;
  const relativePath = path.posix.join(dirRelative, fileName);

  const absolutePath = resolveStorageFilePath(relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, render.buffer);
  await pruneOldThumbnails(dirRelative, fileName);

  await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: { thumbnailUrl: relativePath },
  });

  logger.info(
    { templateId, code: template.code, relativePath, sizeKb: Math.round(render.buffer.length / 1024) },
    'Miniatura szablonu wygenerowana'
  );

  return relativePath;
}

/**
 * Regeneracja w tle - do wolania po zapisie layoutu.
 *
 * Zapis projektu nie moze czekac na render (kilka sekund przy tlach), a jego
 * blad nie moze wywrocic zapisu: layout jest w bazie, miniatura to ozdoba.
 */
export function scheduleTemplateThumbnail(templateId: string): void {
  void regenerateTemplateThumbnail(templateId).catch((error) => {
    logger.warn({ err: error, templateId }, 'Nie udalo sie odswiezyc miniatury szablonu');
  });
}

/** Sprzatanie po usunieciu szablonu - miniatura nie ma juz do czego nalezec. */
export async function deleteTemplateThumbnail(thumbnailUrl: string | null | undefined): Promise<void> {
  const value = String(thumbnailUrl || '').trim();
  if (!value || /^https?:\/\//i.test(value)) return;

  try {
    await fs.unlink(resolveStorageFilePath(value));
  } catch {
    // Plik moze nie istniec - nic sie nie stalo.
  }
}
