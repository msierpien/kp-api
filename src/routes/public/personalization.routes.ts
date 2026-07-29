import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { hashToken, maskToken } from '../../lib/token';
import { validateAnswers } from '../../services/renderer/text-validator.service';
import { validatePrintPackageAnswers } from '../../services/renderer/answers-validation.service';
import { getCaseLayout } from '../../lib/case-layout';
import { saveFile, fileExists, buildStorageUrl } from '../../services/storage/local-storage.service';
import { enqueueCasePrintPackage } from '../../services/admin/cases.service';
import { listFonts } from '../../services/admin/fonts.service';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';
import {
  MAX_PREVIEW_UPLOAD_BYTES,
  assertAllowedImageUpload,
  assertAllowedPngUpload,
  isUploadValidationError,
} from '../../lib/upload-validation';
import { RATE_LIMITS } from '../../lib/rate-limits';
import { assertCaseWritable, assertTokenUsable } from '../../lib/case-access';
import { parseLayoutOverrides } from '../../schemas/personalization.schema';
import { listDecorations } from '../../services/admin/decorations.service';
import { SvgSanitizeError, sanitizeSvg, svgSupportsTint } from '../../lib/svg-sanitizer';
import {
  canonicalizeTemplateForms,
  flattenCaseAnswers,
  getStoredAnswerValue,
  hasAnswerValue,
  mergeCaseAnswers,
  normalizeCaseAnswers,
  type PersonalizationAnswerField,
} from '../../lib/personalization-answers';

interface PersonalizationParams {
  token: string;
}

/**
 * Awaria po stronie serwera z numerem zgloszenia.
 *
 * Klient pisal "nie dziala", a obsluga nie miala czego szukac w logach -
 * wszystkie sciezki publiczne konczyly sie samym komunikatem. `request.id`
 * jest krotki (6 znakow) i trafia do kazdej linii logu tego zadania.
 */
function failWithReference(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  message: string
) {
  request.log.error({ err: error }, message);
  return reply.status(500).send({
    error: 'Internal Server Error',
    message,
    requestId: request.id,
  });
}

interface SaveDesignBody {
  /** Plaska mapa klucz->wartosc. Pola INDIVIDUAL trafiaja do pierwszej pozycji. */
  answers?: Record<string, string | any>;
  /** Wartosci wspolne dla calej pozycji zamowienia (pola SHARED). */
  sharedAnswers?: Record<string, any>;
  /** Wartosci per sztuka (pola INDIVIDUAL) - np. lista gosci na winietkach. */
  items?: Array<Record<string, any>>;
  layoutOverrides?: {
    layers: Record<
      string,
      {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        rotation?: number;
      }
    >;
  };
}

// Helper: upserts answers rows for case and returns merged answersJson.
// answers keys are FORM FIELD KEYS coming from frontend; we map them to field IDs.
type AnswersPayload = Pick<SaveDesignBody, 'answers' | 'sharedAnswers' | 'items'>;

/** Czy request niesie jakiekolwiek odpowiedzi (plaskie lub strukturalne). */
function hasAnswersPayload(body: AnswersPayload | undefined): boolean {
  return !!(body?.answers || body?.sharedAnswers || body?.items);
}

async function saveAnswers(
  caseId: string,
  currentAnswersJson: any,
  payload: AnswersPayload,
  fieldKeyToId: Map<string, string>,
  fields: PersonalizationAnswerField[],
  quantity = 1
) {
  const mergedAnswers = mergeCaseAnswers(currentAnswersJson, payload, fields, quantity);

  for (const field of fields) {
    const fieldId = fieldKeyToId.get(field.key);
    if (!fieldId) {
      // Skip unknown fields to avoid FK errors
      continue;
    }

    const value = getStoredAnswerValue(field, mergedAnswers);

    if (!hasAnswerValue(value)) {
      await prisma.personalizationAnswer.deleteMany({
        where: {
          caseId,
          fieldId,
        },
      });
      continue;
    }
    const valueText = typeof value === 'string' ? value : null;
    const valueJson = valueText === null ? JSON.parse(JSON.stringify(value)) : null;

    await prisma.personalizationAnswer.upsert({
      where: {
        caseId_fieldId: {
          caseId,
          fieldId,
        },
      },
      update: {
        valueText,
        valueJson,
      },
      create: {
        caseId,
        fieldId,
        valueText,
        valueJson,
      },
    });
  }

  return mergedAnswers;
}

/** Wlasna grafika klienta - wieksza niz ozdobnik z biblioteki (zdjecia). */
const MAX_CLIENT_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * Klucz limitu zapytan: sprawa, nie adres IP.
 *
 * Cala rodzina zamawiajaca z jednego Wi-Fi to jeden adres, a klient
 * w pociagu zmienia adres co chwile - liczenie po IP karaloby nie tych,
 * co trzeba. Hash, zeby token nie lezal w pamieci limitera otwartym tekstem.
 */
function tokenRateLimitKey(request: FastifyRequest): string {
  const token = (request.params as { token?: string })?.token;
  return token ? hashToken(token) : request.ip;
}

/**
 * Rozdzielczosc zrodla bitmapy. Klient dzieli ja przez docelowy rozmiar
 * w calach i dostaje realne DPI wydruku - ponizej 300 ostrzegamy, ze
 * grafika moze byc nieostra.
 */
async function readRasterDimensions(
  buffer: Buffer
): Promise<{ widthPx: number; heightPx: number } | null> {
  try {
    const { loadImage } = await import('canvas');
    const image = await loadImage(buffer);
    return { widthPx: image.width, heightPx: image.height };
  } catch {
    // Brak wymiarow tylko wylacza ostrzezenie o DPI - nie blokuje uploadu.
    return null;
  }
}

/**
 * Sprawdza nadpisania z requestu schematem Zod i zwraca komunikat bledu.
 *
 * Zwracamy dane po parsowaniu, nie oryginal: to one ida do bazy, wiec
 * wszystko, czego schemat nie zna, ma tu zginac (m.in. `imageUrl`
 * wskazujacy poza magazyn plikow).
 */
function readLayoutOverrides(
  fastify: FastifyInstance,
  body: { layoutOverrides?: unknown } | undefined
) {
  const result = parseLayoutOverrides(body?.layoutOverrides);

  // Rozjazd portal <-> API zostawia slad. Cisza w tym miejscu kosztowala juz
  // dwa razy: pole dodane po jednej stronie znikalo przy zapisie po drugiej.
  if (result.ok && result.dropped.length) {
    fastify.log.warn(
      { droppedKeys: result.dropped.slice(0, 20) },
      'layoutOverrides: klucze spoza schematu zostaly pominiete przy zapisie'
    );
  }

  return result;
}

// Helper do dodawania nagłówków bezpieczeństwa
function addSecurityHeaders(reply: FastifyReply) {
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

async function enrichTemplateLayoutWithGlobalFonts(template: any) {
  if (!template) return template;

  const canonicalTemplate = {
    ...template,
    forms: canonicalizeTemplateForms(template.forms || []),
  };

  if (!template.layoutJson) return canonicalTemplate;

  const globalFonts = await listFonts();
  const layoutJson = template.layoutJson as any;

  return {
    ...canonicalTemplate,
    layoutJson: {
      ...layoutJson,
      // Kazdy plik idzie dwa razy: pod nazwa pliku (starsze szablony trzymaja
      // ja w fontFamily) i pod rodzina typograficzna z waga oraz stylem, po
      // ktorych przegladarka wybiera wariant. Bez tej drugiej pozycji podglad
      // klienta pokazywalby regular tam, gdzie wydruk da bold albo kursywe.
      fonts: globalFonts.flatMap((font) => {
        const variant = {
          src: font.filePath,
          weight: font.weight,
          style: font.style,
        };
        const entries = [{ family: font.family, ...variant }];
        if (font.typographicFamily && font.typographicFamily !== font.family) {
          entries.push({ family: font.typographicFamily, ...variant });
        }
        return entries;
      }),
    },
  };
}

function getCaseTemplate(personalizationCase: any) {
  return personalizationCase.template || personalizationCase.orderItem?.personalizedProduct?.template || null;
}

/**
 * Walidacja odpowiedzi sprawy - ta sama dla podgladu i dla zatwierdzenia.
 *
 * Mierzy KAZDA sztuke osobno (opentype.js + geometria warstw) po nalozeniu
 * `layoutOverrides`, bo klient mogl juz zmniejszyc czcionke wlasnie po to,
 * zeby dlugie nazwisko sie zmiescilo. Sprawy bez layoutu (starsze szablony)
 * spadaja na walidacje samych wartosci.
 */
async function validateCaseAnswers(
  personalizationCase: any,
  allFields: any[],
  mergedAnswers: unknown,
  layoutOverrides: unknown
) {
  const template = getCaseTemplate(personalizationCase);
  const caseLayout = template
    ? getCaseLayout({
        layoutSnapshot: personalizationCase.layoutSnapshot,
        template: { layoutJson: template.layoutJson },
      })
    : null;

  const quantity = Math.max(1, Number(personalizationCase.orderItem?.quantity) || 1);

  if (caseLayout) {
    return validatePrintPackageAnswers(
      normalizeCaseAnswers(mergedAnswers, allFields, quantity),
      allFields,
      caseLayout,
      quantity,
      layoutOverrides
    );
  }

  return validateAnswers(
    flattenCaseAnswers(mergedAnswers) as Record<string, string | number | boolean | undefined>,
    allFields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      maxLength: f.maxLength || undefined,
      minLength: f.minLength || undefined,
      pattern: f.pattern || undefined,
    }))
  );
}

async function assertPersonalizationFeatureEnabled(personalizationCase: any, reply: FastifyReply) {
  const tenantId = personalizationCase.order?.shop?.tenantId || personalizationCase.orderItem?.order?.shop?.tenantId;
  if (!tenantId) return true;

  const enabled = await tenantHasFeature(tenantId, FEATURE_PERSONALIZATION_EDITOR);
  if (enabled) return true;

  reply.status(403).send({
    error: 'Forbidden',
    message: 'Moduł personalizacji nie jest aktywny dla tej firmy',
  });
  return false;
}

export async function personalizationRoutes(fastify: FastifyInstance) {
  // GET /personalization/:token - Get personalization case by access token
  fastify.get<{ Params: PersonalizationParams }>(
    '/:token',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.personalizationRead, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Pobierz dane personalizacji po tokenie klienta',
        security: [],
        params: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Token dostępu klienta' },
          },
        },
        response: {
          // additionalProperties: true jest wymagane - bez niego fast-json-stringify
          // wycina cala odpowiedz i klient dostaje puste {}.
          200: {
            type: 'object',
            additionalProperties: true,
            description: 'Dane personalizacji wraz z formularzem i layoutem',
          },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        addSecurityHeaders(reply);

        // Hash tokena z URL przed wyszukaniem w bazie
        const tokenHash = hashToken(request.params.token);
        fastify.log.info(`Looking up personalization case (token: ${maskToken(request.params.token)})`);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: tokenHash },
          include: {
            order: {
              select: {
                shop: { select: { tenantId: true } },
              },
            },
            template: {
              select: {
                id: true,
                code: true,
                name: true,
                description: true,
                version: true,
                layoutJson: true,
                forms: {
                  include: {
                    fields: {
                      orderBy: { sortOrder: 'asc' },
                    },
                  },
                  orderBy: { sortOrder: 'asc' },
                },
              },
            },
            orderItem: {
              include: {
                order: {
                  select: {
                    orderReference: true,
                    customerEmail: true,
                    customerName: true,
                  },
                },
                personalizedProduct: {
                  include: {
                    template: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        description: true,
                        version: true,
                        layoutJson: true,
                        forms: {
                          include: {
                            fields: {
                              orderBy: { sortOrder: 'asc' },
                            },
                          },
                          orderBy: { sortOrder: 'asc' },
                        },
                      },
                    },
                  },
                },
              },
            },
            answers: {
              include: {
                field: true,
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        if (!assertTokenUsable(personalizationCase, reply)) return;

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        const enrichedTemplate = await enrichTemplateLayoutWithGlobalFonts(getCaseTemplate(personalizationCase));

        // UWAGA: to jest endpoint publiczny (chroniony tylko tokenem z linku).
        // Zwracamy WYLACZNIE pola potrzebne portalowi klienta - nie rozpakowujemy
        // calego rekordu, bo niesie on dane wewnetrzne (customerTokenHash,
        // customerTokenEncrypted, notesInternal, telemetria e-mail, tenantId)
        // oraz pelne dane cenowe i payloadJson pozycji zamowienia.
        const orderItem = personalizationCase.orderItem;

        const personalizedProduct = orderItem?.personalizedProduct
          ? { id: orderItem.personalizedProduct.id, template: enrichedTemplate }
          : enrichedTemplate
            ? { id: `template-${enrichedTemplate.id}`, template: enrichedTemplate }
            : null;

        // Ostatni zapisany podglad. Po zatwierdzeniu portal nie pokazuje juz
        // edytora, wiec bez tego klient chcacy sprawdzic literowke w nazwisku
        // mial do dyspozycji wylacznie adres e-mail do biura.
        const savedPreview = await prisma.asset.findFirst({
          where: { caseId: personalizationCase.id, assetType: 'PNG_PREVIEW' },
          orderBy: { createdAt: 'desc' },
        });
        const previewUrl =
          savedPreview && (await fileExists(savedPreview.filePath))
            ? buildStorageUrl(savedPreview.filePath)
            : null;

        return reply.send({
          id: personalizationCase.id,
          status: personalizationCase.status,
          tokenActive: personalizationCase.tokenActive,
          submittedAt: personalizationCase.submittedAt,
          previewUrl,
          layoutOverrides: personalizationCase.layoutOverrides,
          validationSummary: personalizationCase.validationSummary,
          answersJson: personalizationCase.answersJson,
          orderItem: orderItem
            ? {
                id: orderItem.id,
                productNameSnapshot: orderItem.productNameSnapshot,
                quantity: orderItem.quantity,
                order: orderItem.order
                  ? {
                      orderReference: orderItem.order.orderReference,
                      customerEmail: orderItem.order.customerEmail,
                      customerName: orderItem.order.customerName,
                    }
                  : null,
                personalizedProduct,
              }
            : null,
          answers: (personalizationCase.answers || []).map((answer: any) => ({
            id: answer.id,
            valueText: answer.valueText,
            valueJson: answer.valueJson,
            field: answer.field ? { key: answer.field.key } : null,
          })),
        });
      } catch (error) {
        return failWithReference(request, reply, error, 'Nie udało się pobrać personalizacji');
      }
    }
  );

  // PUT /personalization/:token/design (alias: /answers) - Save personalization draft
  fastify.put<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/:endpoint(answers|design)',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.personalizationWrite, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Zapisz odpowiedzi / szkic projektu',
        security: [],
        params: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            endpoint: { type: 'string', enum: ['answers', 'design'] },
          },
        },
        body: {
          type: 'object',
          // Bez required: klient moze przyslac sam strukturalny zapis
          // (sharedAnswers/items) bez plaskiej mapy answers.
          properties: {
            answers: { type: 'object', description: 'Mapa klucz pola → wartość (pola INDIVIDUAL trafiają do pierwszej pozycji)' },
            sharedAnswers: { type: 'object', description: 'Wartości wspólne dla całej pozycji (pola SHARED)' },
            items: {
              type: 'array',
              description: 'Wartości per sztuka (pola INDIVIDUAL) - np. lista gości',
              items: { type: 'object' },
            },
            layoutOverrides: {
              type: 'object',
              description: 'Opcjonalne przesunięcia warstw layoutu',
              properties: {
                layers: { type: 'object' },
              },
            },
          },
        },
        response: {
          // Patrz uwaga przy GET /:token - bez additionalProperties odpowiedz
          // zostaje wyczyszczona do {}.
          200: { type: 'object', additionalProperties: true },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: PersonalizationParams; Body: SaveDesignBody }>,
      reply: FastifyReply
    ) => {
      try {
        addSecurityHeaders(reply);

        const overrides = readLayoutOverrides(fastify, request.body);
        if (!overrides.ok) {
          return reply.status(400).send({ error: 'Bad Request', message: overrides.message });
        }

        // Hash tokena z URL przed wyszukaniem w bazie
        const tokenHash = hashToken(request.params.token);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: tokenHash },
          include: {
            order: { select: { shop: { select: { tenantId: true } } } },
            template: {
              include: {
                forms: {
                  include: {
                    fields: true,
                  },
                },
              },
            },
            orderItem: {
              include: {
                personalizedProduct: {
                  include: {
                    template: {
                      include: {
                        forms: {
                          include: {
                            fields: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        if (!assertTokenUsable(personalizationCase, reply)) return;

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;
        // Sprawa zatwierdzona nie przyjmuje juz zmian. Do tej pory pilnowal
        // tego wylacznie portal, wiec zapis wracal tu z kazdego zapytania -
        // razem z cofnieciem statusu na "Czeka na klienta".
        if (!assertCaseWritable(personalizationCase, reply)) return;

        // Zbuduj mapę fieldKey -> fieldId (na podstawie template)
        const fieldKeyToId = new Map<string, string>();
        const allFields: any[] = [];
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => {
            fieldKeyToId.set(f.key, f.id);
            allFields.push(f);
          });
        });

        // Save answers rows + merged JSON for admin panel
        const mergedAnswers = await saveAnswers(
          personalizationCase.id,
          personalizationCase.answersJson,
          request.body,
          fieldKeyToId,
          allFields,
          personalizationCase.orderItem.quantity
        );

        // Update case status
        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: tokenHash },
          data: {
            status: 'WAITING_FOR_CUSTOMER',
            answersJson: JSON.parse(JSON.stringify(mergedAnswers)),
            // Zapisujemy dane PO schemacie, nie surowe z requestu.
            layoutOverrides: overrides.data ? JSON.parse(JSON.stringify(overrides.data)) : undefined,
          },
          include: {
            answers: {
              include: { field: true },
            },
          },
        });

        // Endpoint publiczny - odsylamy tylko potwierdzenie zapisu, nie caly
        // rekord (niesie customerTokenHash, notesInternal, telemetrie e-mail).
        return reply.send({
          message: 'Zapisano',
          id: updated.id,
          status: updated.status,
          answersJson: updated.answersJson,
          layoutOverrides: updated.layoutOverrides,
          updatedAt: updated.updatedAt,
        });
      } catch (error) {
        return failWithReference(request, reply, error, 'Nie udało się zapisać odpowiedzi');
      }
    }
  );

  // POST /personalization/:token/preview - Generate preview and validate
  fastify.post<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/preview',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.personalizationPreview, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Waliduj odpowiedzi i pobierz URL podglądu',
        security: [],
        params: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          properties: {
            answers: { type: 'object' },
            sharedAnswers: { type: 'object' },
            items: { type: 'array', items: { type: 'object' } },
            layoutOverrides: { type: 'object' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              previewUrl: { type: 'string', nullable: true },
              validation: { type: 'object', additionalProperties: true },
              status: { type: 'string' },
            },
          },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: PersonalizationParams; Body: SaveDesignBody }>,
      reply: FastifyReply
    ) => {
      try {
        addSecurityHeaders(reply);

        const overrides = readLayoutOverrides(fastify, request.body);
        if (!overrides.ok) {
          return reply.status(400).send({ error: 'Bad Request', message: overrides.message });
        }

        const tokenHash = hashToken(request.params.token);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: tokenHash },
          include: {
            order: { select: { shop: { select: { tenantId: true } } } },
            template: {
              select: {
                id: true,
                code: true,
                name: true,
                version: true,
                layoutJson: true,
                forms: {
                  include: { fields: { orderBy: { sortOrder: 'asc' } } },
                  orderBy: { sortOrder: 'asc' },
                },
              },
            },
            orderItem: {
              include: {
                order: { select: { id: true, orderReference: true } },
                personalizedProduct: {
                  include: {
                    template: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        version: true,
                        layoutJson: true,
                        forms: {
                          include: { fields: { orderBy: { sortOrder: 'asc' } } },
                          orderBy: { sortOrder: 'asc' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        if (!assertTokenUsable(personalizationCase, reply)) return;

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;
        // Podglad tez zapisuje odpowiedzi i przestawia status sprawy.
        if (!assertCaseWritable(personalizationCase, reply)) return;

        // Zbuduj mapę fieldKey -> fieldId
        const fieldKeyToId = new Map<string, string>();
        const allFields: any[] = [];
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => {
            fieldKeyToId.set(f.key, f.id);
            allFields.push(f);
          });
        });

        // Zapisz odpowiedzi jeśli przyszły w body
        let mergedAnswers: unknown = personalizationCase.answersJson || {};
        const layoutOverrides = overrides.data ?? personalizationCase.layoutOverrides;
        if (hasAnswersPayload(request.body)) {
          mergedAnswers = await saveAnswers(
            personalizationCase.id,
            personalizationCase.answersJson,
            request.body,
            fieldKeyToId,
            allFields,
            personalizationCase.orderItem.quantity
          );
        }

        const validation = await validateCaseAnswers(
          personalizationCase,
          allFields,
          mergedAnswers,
          layoutOverrides
        );

        // Generuj preview - WYŁĄCZONE, używaj frontendu (Opcja A)
        let previewUrl: string | null = null;

        // Backend rendering wyłączony - frontend generuje PNG
        // Użyj POST /:token/upload-preview z frontendu
        fastify.log.info('[Preview] Backend rendering disabled - use frontend upload');
        
        // Sprawdź czy jest już zapisany preview
        const existingPreview = await prisma.asset.findFirst({
          where: {
            caseId: personalizationCase.id,
            assetType: 'PNG_PREVIEW',
          },
          orderBy: {
            createdAt: 'desc',
          },
        });
        
        if (existingPreview) {
          const existsOnDisk = await fileExists(existingPreview.filePath);
          if (existsOnDisk) {
            // Skonstruuj URL używając centralnej funkcji
            previewUrl = buildStorageUrl(existingPreview.filePath);
            fastify.log.info('[Preview] Using existing frontend-generated preview');
          } else {
            fastify.log.warn('[Preview] Existing preview missing on disk, ignoring');
          }
        }

        // Zaktualizuj case z validation summary
        await prisma.personalizationCase.update({
          where: { id: personalizationCase.id },
          data: {
            answersJson: JSON.parse(JSON.stringify(mergedAnswers)),
            layoutOverrides: layoutOverrides ? JSON.parse(JSON.stringify(layoutOverrides)) : undefined,
            validationSummary: JSON.parse(JSON.stringify(validation)),
            status: previewUrl ? 'PREVIEW_READY' : 'DRAFT',
          },
        });

        return reply.send({
          previewUrl,
          validation,
          status: previewUrl ? 'PREVIEW_READY' : 'DRAFT',
        });
      } catch (error) {
        return failWithReference(request, reply, error, 'Nie udało się przetworzyć zapytania');
      }
    }
  );

  // POST /personalization/:token/submit - Submit personalization for production
  fastify.post<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/submit',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.personalizationSubmit, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Zatwierdź personalizację do produkcji (tworzy RenderJob)',
        security: [],
        params: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          properties: {
            answers: { type: 'object' },
            sharedAnswers: { type: 'object' },
            items: { type: 'array', items: { type: 'object' } },
            layoutOverrides: { type: 'object' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              renderJob: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  bullmqJobId: { type: 'string' },
                  status: { type: 'string' },
                },
              },
            },
          },
          // `validation` musi byc wymienione ze `additionalProperties`,
          // inaczej fast-json-stringify wytnie je z odpowiedzi i portal
          // pokaze sam komunikat, bez wskazania wiersza.
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
              validation: { type: 'object', additionalProperties: true },
            },
          },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: PersonalizationParams; Body: SaveDesignBody }>,
      reply: FastifyReply
    ) => {
      try {
        addSecurityHeaders(reply);

        const overrides = readLayoutOverrides(fastify, request.body);
        if (!overrides.ok) {
          return reply.status(400).send({ error: 'Bad Request', message: overrides.message });
        }

        // Hash tokena z URL przed wyszukaniem w bazie
        const tokenHash = hashToken(request.params.token);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: tokenHash },
          include: {
            answers: true,
            order: {
              select: {
                orderReference: true,
                shop: { select: { tenantId: true } },
              },
            },
            template: {
              include: {
                forms: {
                  include: { fields: true },
                },
              },
            },
            orderItem: {
              include: {
                personalizedProduct: {
                  include: {
                    template: {
                      include: {
                        forms: {
                          include: { fields: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        if (!assertTokenUsable(personalizationCase, reply)) return;

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;
        // Powtorne zatwierdzenie tej samej sprawy kolejkowalo kolejna paczke
        // renderow i przestawialo `submittedAt` - sprawa zatwierdzona jest
        // zamknieta do czasu, az admin cofnie status.
        if (!assertCaseWritable(personalizationCase, reply)) return;

        // Zbuduj mapę fieldKey -> fieldId (na podstawie template)
        const fieldKeyToId = new Map<string, string>();
        const allFields: any[] = [];
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => {
            fieldKeyToId.set(f.key, f.id);
            allFields.push(f);
          });
        });

        // Jeśli w body przyszły odpowiedzi, zapisz je przed walidacją
        let mergedAnswers: unknown = personalizationCase.answersJson;
        const layoutOverrides = overrides.data ?? personalizationCase.layoutOverrides;
        if (hasAnswersPayload(request.body)) {
          mergedAnswers = await saveAnswers(
            personalizationCase.id,
            personalizationCase.answersJson,
            request.body,
            fieldKeyToId,
            allFields,
            personalizationCase.orderItem.quantity
          );

          await prisma.personalizationCase.update({
            where: { id: personalizationCase.id },
            data: { answersJson: JSON.parse(JSON.stringify(mergedAnswers)) },
          });
        }

        const answersCount = await prisma.personalizationAnswer.count({
          where: { caseId: personalizationCase.id },
        });

        if (answersCount === 0) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Brak wypełnionych pól personalizacji',
          });
        }

        // Ta sama walidacja, ktora blokuje przycisk w portalu - tyle ze tutaj
        // realnie decyduje. Do tej pory `submit` sprawdzal wylacznie to, czy
        // cokolwiek wypelniono, wiec sprawa z nazwiskiem wychodzacym poza
        // ramke przechodzila i konczyla sie `FAILED_RENDER` przy paczce.
        // Ostrzezenia (np. przybliżony pomiar bez kroju w rejestrze) nie
        // blokuja - blokuja wylacznie bledy.
        const submitValidation = await validateCaseAnswers(
          personalizationCase,
          allFields,
          mergedAnswers,
          layoutOverrides
        );

        if (submitValidation.errors?.length) {
          await prisma.personalizationCase.update({
            where: { id: personalizationCase.id },
            data: { validationSummary: JSON.parse(JSON.stringify(submitValidation)) },
          });

          return reply.status(400).send({
            error: 'Validation Failed',
            message: submitValidation.errors[0]?.message || 'Personalizacja zawiera błędy',
            validation: submitValidation,
          });
        }

        // Zamrozenie layoutu w chwili zatwierdzenia. Bez tego edycja szablonu
        // w adminie zmieniala wydruk spraw juz zatwierdzonych - klient
        // akceptowal jeden projekt, a z drukarki wychodzil inny.
        const layoutSnapshot = getCaseTemplate(personalizationCase)?.layoutJson ?? null;

        // Najpierw utrwal zatwierdzenie i overrides - paczka czyta je z bazy.
        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: tokenHash },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
            layoutOverrides: layoutOverrides ? JSON.parse(JSON.stringify(layoutOverrides)) : undefined,
            layoutSnapshot: layoutSnapshot
              ? JSON.parse(JSON.stringify(layoutSnapshot))
              : undefined,
          },
        });

        // Zatwierdzenie generuje komplet plikow jak "Generuj paczke" w adminie:
        // wszystkie pozycje (per gosc), ustawienia druku tenanta (formaty,
        // zbiorczy PDF, znak wodny). Wczesniej PDF_PRINT renderowal tylko
        // pierwsza pozycje. Blad kolejkowania nie cofa zatwierdzenia klienta -
        // admin zobaczy status sprawy i moze ponowic z panelu.
        let renderJobInfo: { id: string; bullmqJobId?: string | number; status: string } | null = null;
        try {
          const enqueueResult = await enqueueCasePrintPackage(personalizationCase.id, {
            tenantId: personalizationCase.order?.shop?.tenantId,
          });
          renderJobInfo = {
            id: enqueueResult.renderJobId,
            bullmqJobId: enqueueResult.bullmqJobId,
            status: enqueueResult.status,
          };
          fastify.log.info(
            `Print package queued: ${enqueueResult.renderJobId} (bullmq ${enqueueResult.bullmqJobId}) for case: ${personalizationCase.id}`
          );
        } catch (packageError) {
          fastify.log.error(
            { err: packageError, caseId: personalizationCase.id },
            'Nie udalo sie zakolejkowac paczki po zatwierdzeniu'
          );
        }

        return reply.send({
          ...updated,
          renderJob: renderJobInfo,
        });
      } catch (error) {
        return failWithReference(request, reply, error, 'Nie udało się zatwierdzić projektu');
      }
    }
  );

  // POST /personalization/:token/upload-preview - Upload PNG preview from frontend
  fastify.post<{ Params: PersonalizationParams }>(
    '/:token/upload-preview',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.publicPreviewUpload, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Wgraj podgląd PNG wygenerowany przez frontend',
        description: 'Przyjmuje multipart/form-data z plikiem obrazu',
        security: [],
        consumes: ['multipart/form-data'],
        params: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              previewUrl: { type: 'string' },
              size: { type: 'integer' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        addSecurityHeaders(reply);

        // Hash tokena
        const tokenHash = hashToken(request.params.token);
        fastify.log.info(`[UploadPreview] Processing for token: ${maskToken(request.params.token)}`);

        // Sprawdź czy case istnieje
        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: tokenHash },
          select: {
            id: true,
            status: true,
            tokenActive: true,
            customerTokenExpiresAt: true,
            orderItem: {
              select: {
                orderId: true,
                order: { select: { shop: { select: { tenantId: true } } } },
                personalizedProduct: {
                  select: {
                    template: {
                      select: { version: true },
                    },
                  },
                },
              },
            },
            template: {
              select: { version: true },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        if (!assertTokenUsable(personalizationCase, reply)) return;

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;
        if (!assertCaseWritable(personalizationCase, reply)) return;

        // Pobierz plik z multipart
        const data = await request.file();
        
        if (!data) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Brak pliku preview',
          });
        }

        fastify.log.info(`[UploadPreview] File received: ${data.filename}, size: ${data.file.bytesRead} bytes`);

        // Konwertuj stream na buffer
        const buffer = await data.toBuffer();
        assertAllowedPngUpload(buffer, data.mimetype, { maxBytes: MAX_PREVIEW_UPLOAD_BYTES });

        // Zapisz plik
        const savedFile = await saveFile(buffer, {
          orderId: personalizationCase.orderItem?.orderId || 'unknown',
          templateVersion:
            personalizationCase.template?.version ||
            personalizationCase.orderItem?.personalizedProduct?.template?.version ||
            1,
          filename: `preview-${personalizationCase.id}`,
          extension: 'png',
        });

        fastify.log.info(`[UploadPreview] File saved: ${savedFile.path}`);

        // Zapisz informację o preview w bazie (upsert by znajdź istniejący lub utwórz nowy)
        const existingAsset = await prisma.asset.findFirst({
          where: {
            caseId: personalizationCase.id,
            assetType: 'PNG_PREVIEW',
          },
        });

        if (existingAsset) {
          // Update existing
          await prisma.asset.update({
            where: { id: existingAsset.id },
            data: {
              filePath: savedFile.path,
              fileSize: buffer.length,
              mimeType: 'image/png',
            },
          });
        } else {
          // Create new
          await prisma.asset.create({
            data: {
              caseId: personalizationCase.id,
              assetType: 'PNG_PREVIEW',
              filePath: savedFile.path,
              fileSize: buffer.length,
              mimeType: 'image/png',
            },
          });
        }

        return reply.send({
          success: true,
          previewUrl: savedFile.url,
          size: buffer.length,
        });
      } catch (error) {
        fastify.log.error({ err: error }, '[UploadPreview] Failed');
        if (isUploadValidationError(error)) {
          return reply.status(400).send({
            error: 'Upload Failed',
            message: error.message,
          });
        }

        return failWithReference(request, reply, error, 'Nie udało się zapisać podglądu');
      }
    }
  );

  // GET /personalization/:token/decorations - biblioteka ozdobnikow sprzedawcy
  fastify.get<{ Params: PersonalizationParams }>(
    '/:token/decorations',
    {
      schema: {
        tags: ['personalization'],
        summary: 'Ozdobniki dostępne dla tej sprawy',
        security: [],
        params: { type: 'object', properties: { token: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              decorations: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        addSecurityHeaders(reply);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: hashToken(request.params.token) },
          select: {
            tokenActive: true,
            customerTokenExpiresAt: true,
            order: { select: { shop: { select: { tenantId: true } } } },
            orderItem: { select: { order: { select: { shop: { select: { tenantId: true } } } } } },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({ error: 'Not Found', message: 'Nie znaleziono personalizacji' });
        }
        if (!assertTokenUsable(personalizationCase, reply)) return;
        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        // Tenant bierzemy ze sprawy - portal nie ma kontekstu admina, a klient
        // nie moze zobaczyc biblioteki innego sprzedawcy.
        const tenantId =
          personalizationCase.order?.shop?.tenantId ||
          personalizationCase.orderItem?.order?.shop?.tenantId;

        if (!tenantId) return reply.send({ decorations: [] });

        return reply.send({ decorations: await listDecorations({ tenantId }) });
      } catch (error) {
        return failWithReference(request, reply, error, 'Nie udało się pobrać ozdobników');
      }
    }
  );

  // POST /personalization/:token/asset - wlasna grafika klienta
  fastify.post<{ Params: PersonalizationParams }>(
    '/:token/asset',
    {
      config: {
        rateLimit: { ...RATE_LIMITS.publicAssetUpload, keyGenerator: tokenRateLimitKey },
      },
      schema: {
        tags: ['personalization'],
        summary: 'Wgraj własną grafikę do projektu',
        description: 'Przyjmuje multipart/form-data (PNG/JPG/WebP/SVG)',
        security: [],
        consumes: ['multipart/form-data'],
        params: { type: 'object', properties: { token: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              imageUrl: { type: 'string' },
              filePath: { type: 'string' },
              mimeType: { type: 'string' },
              widthPx: { type: 'integer', nullable: true },
              heightPx: { type: 'integer', nullable: true },
              tintable: { type: 'boolean' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        addSecurityHeaders(reply);

        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: hashToken(request.params.token) },
          select: {
            id: true,
            status: true,
            tokenActive: true,
            customerTokenExpiresAt: true,
            order: { select: { shop: { select: { tenantId: true } } } },
            template: { select: { version: true } },
            orderItem: {
              select: {
                orderId: true,
                order: { select: { shop: { select: { tenantId: true } } } },
                personalizedProduct: { select: { template: { select: { version: true } } } },
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({ error: 'Not Found', message: 'Nie znaleziono personalizacji' });
        }
        if (!assertTokenUsable(personalizationCase, reply)) return;
        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;
        if (!assertCaseWritable(personalizationCase, reply)) return;

        const data = await request.file();
        if (!data) {
          return reply.status(400).send({ error: 'Bad Request', message: 'Brak pliku' });
        }

        const buffer = await data.toBuffer();
        const isSvg = data.mimetype === 'image/svg+xml' || data.filename.toLowerCase().endsWith('.svg');

        let payload = buffer;
        let extension = 'png';
        let mimeType = data.mimetype;
        let tintable = false;
        let dimensions: { widthPx: number; heightPx: number } | null = null;

        if (isSvg) {
          // Plik klienta trafia na nasza domene - czyscimy go u wejscia.
          const clean = sanitizeSvg(buffer.toString('utf-8'));
          payload = Buffer.from(clean, 'utf-8');
          extension = 'svg';
          mimeType = 'image/svg+xml';
          tintable = svgSupportsTint(clean);
        } else {
          assertAllowedImageUpload(buffer, data.mimetype, { maxBytes: MAX_CLIENT_ASSET_BYTES });
          extension = data.mimetype === 'image/jpeg' ? 'jpg' : data.mimetype === 'image/webp' ? 'webp' : 'png';
          // Rozdzielczosc zrodla - klient policzy z niej realne DPI wydruku.
          dimensions = await readRasterDimensions(buffer);
        }

        if (payload.length > MAX_CLIENT_ASSET_BYTES) {
          return reply.status(400).send({
            error: 'Upload Failed',
            message: 'Plik jest za duży (maksymalnie 5 MB)',
          });
        }

        const savedFile = await saveFile(payload, {
          orderId: personalizationCase.orderItem?.orderId || 'unknown',
          templateVersion:
            personalizationCase.template?.version ||
            personalizationCase.orderItem?.personalizedProduct?.template?.version ||
            1,
          filename: `klient-${personalizationCase.id}`,
          extension,
        });

        // Asset przypisany do sprawy, NIE do biblioteki sprzedawcy - to plik
        // jednego klienta i nie ma prawa pojawic sie u innych.
        await prisma.asset.create({
          data: {
            caseId: personalizationCase.id,
            assetType: 'CLIENT_UPLOAD',
            filePath: savedFile.path,
            fileSize: payload.length,
            mimeType,
          },
        });

        return reply.send({
          imageUrl: savedFile.path,
          filePath: savedFile.path,
          mimeType,
          widthPx: dimensions?.widthPx ?? null,
          heightPx: dimensions?.heightPx ?? null,
          tintable,
        });
      } catch (error) {
        fastify.log.error({ err: error }, '[ClientAsset] Upload failed');
        if (error instanceof SvgSanitizeError || isUploadValidationError(error)) {
          return reply.status(400).send({ error: 'Upload Failed', message: error.message });
        }
        return failWithReference(request, reply, error, 'Nie udało się wgrać pliku');
      }
    }
  );
}
