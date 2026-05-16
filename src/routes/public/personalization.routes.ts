import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { hashToken, maskToken } from '../../lib/token';
import { validateAnswers } from '../../services/renderer/text-validator.service';
import { saveFile, fileExists, buildStorageUrl } from '../../services/storage/local-storage.service';
import { addFinalPdfJob } from '../../services/queue/render.queue';
import { listFonts } from '../../services/admin/fonts.service';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';

interface PersonalizationParams {
  token: string;
}

interface SaveDesignBody {
  answers: Record<string, string | any>;
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
async function saveAnswers(
  caseId: string,
  currentAnswersJson: any,
  answers: Record<string, any>,
  fieldKeyToId: Map<string, string>
) {
  for (const [fieldKey, value] of Object.entries(answers)) {
    const fieldId = fieldKeyToId.get(fieldKey);
    if (!fieldId) {
      // Skip unknown fields to avoid FK errors
      continue;
    }

    await prisma.personalizationAnswer.upsert({
      where: {
        caseId_fieldId: {
          caseId,
          fieldId,
        },
      },
      update: {
        valueText: typeof value === 'string' ? value : null,
        valueJson: typeof value !== 'string' ? value : null,
      },
      create: {
        caseId,
        fieldId,
        valueText: typeof value === 'string' ? value : null,
        valueJson: typeof value !== 'string' ? value : null,
      },
    });
  }

  return {
    ...((currentAnswersJson as any) || {}),
    ...answers,
  };
}

// Helper do dodawania nagłówków bezpieczeństwa
function addSecurityHeaders(reply: FastifyReply) {
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

async function enrichTemplateLayoutWithGlobalFonts(template: any) {
  if (!template?.layoutJson) return template;

  const globalFonts = await listFonts();
  const layoutJson = template.layoutJson as any;

  return {
    ...template,
    layoutJson: {
      ...layoutJson,
      fonts: globalFonts.map((font) => ({
        family: font.family,
        src: font.filePath,
        weight: 400,
        style: 'normal' as const,
      })),
    },
  };
}

function getCaseTemplate(personalizationCase: any) {
  return personalizationCase.template || personalizationCase.orderItem?.personalizedProduct?.template || null;
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
          200: { type: 'object', description: 'Dane personalizacji wraz z formularzem i layoutem' },
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

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        const enrichedTemplate = await enrichTemplateLayoutWithGlobalFonts(getCaseTemplate(personalizationCase));

        return reply.send({
          ...personalizationCase,
          orderItem: personalizationCase.orderItem
            ? {
                ...personalizationCase.orderItem,
                personalizedProduct: personalizationCase.orderItem.personalizedProduct
                  ? {
                      ...personalizationCase.orderItem.personalizedProduct,
                      template: enrichedTemplate,
                    }
                  : enrichedTemplate
                    ? {
                        id: `template-${enrichedTemplate.id}`,
                        template: enrichedTemplate,
                      }
                    : null,
              }
            : personalizationCase.orderItem,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać personalizacji',
        });
      }
    }
  );

  // PUT /personalization/:token/design (alias: /answers) - Save personalization draft
  fastify.put<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/:endpoint(answers|design)',
    {
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
          required: ['answers'],
          properties: {
            answers: { type: 'object', description: 'Mapa klucz pola → wartość' },
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
          200: { type: 'object' },
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

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        // Zbuduj mapę fieldKey -> fieldId (na podstawie template)
        const fieldKeyToId = new Map<string, string>();
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => fieldKeyToId.set(f.key, f.id));
        });

        // Save answers rows + merged JSON for admin panel
        const mergedAnswers = await saveAnswers(
          personalizationCase.id,
          personalizationCase.answersJson,
          request.body.answers,
          fieldKeyToId
        );

        // Update case status
        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: tokenHash },
          data: {
            status: 'WAITING_FOR_CUSTOMER',
            answersJson: mergedAnswers,
            layoutOverrides: request.body.layoutOverrides ? JSON.parse(JSON.stringify(request.body.layoutOverrides)) : undefined,
          },
          include: {
            answers: {
              include: { field: true },
            },
          },
        });

        return reply.send(updated);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zapisać odpowiedzi',
        });
      }
    }
  );

  // POST /personalization/:token/preview - Generate preview and validate
  fastify.post<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/preview',
    {
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
            layoutOverrides: { type: 'object' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              previewUrl: { type: 'string', nullable: true },
              validation: { type: 'object' },
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

        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        // Zbuduj mapę fieldKey -> fieldId
        const fieldKeyToId = new Map<string, string>();
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => fieldKeyToId.set(f.key, f.id));
        });

        // Zapisz odpowiedzi jeśli przyszły w body
        let mergedAnswers = personalizationCase.answersJson || {};
        const layoutOverrides = request.body?.layoutOverrides ?? personalizationCase.layoutOverrides;
        if (request.body?.answers) {
          mergedAnswers = await saveAnswers(
            personalizationCase.id,
            personalizationCase.answersJson,
            request.body.answers,
            fieldKeyToId
          );
        }

        // Pobierz wszystkie pola z template
        const allFields: any[] = [];
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          allFields.push(...form.fields);
        });

        // Walidacja z opentype.js
        const answersForValidation = mergedAnswers as Record<string, string | number | boolean | undefined>;
        const validation = await validateAnswers(answersForValidation, allFields.map(f => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          maxLength: f.maxLength || undefined,
          minLength: f.minLength || undefined,
          pattern: f.pattern || undefined,
        })));

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
            answersJson: mergedAnswers,
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
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się przetworzyć zapytania',
        });
      }
    }
  );

  // POST /personalization/:token/submit - Submit personalization for production
  fastify.post<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/submit',
    {
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
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
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

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        // Zbuduj mapę fieldKey -> fieldId (na podstawie template)
        const fieldKeyToId = new Map<string, string>();
        getCaseTemplate(personalizationCase)?.forms?.forEach((form: any) => {
          form.fields.forEach((f: any) => fieldKeyToId.set(f.key, f.id));
        });

        // Jeśli w body przyszły odpowiedzi, zapisz je przed walidacją
        let mergedAnswers = personalizationCase.answersJson;
        const layoutOverrides = request.body?.layoutOverrides ?? personalizationCase.layoutOverrides;
        if (request.body?.answers) {
          mergedAnswers = await saveAnswers(
            personalizationCase.id,
            personalizationCase.answersJson,
            request.body.answers,
            fieldKeyToId
          );

          await prisma.personalizationCase.update({
            where: { id: personalizationCase.id },
            data: { answersJson: mergedAnswers as object },
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

        // Pobierz dane potrzebne do renderowania
        const submitTemplate = getCaseTemplate(personalizationCase);
        const templateSlug = (submitTemplate as any)?.slug || submitTemplate?.name?.toLowerCase().replace(/\s+/g, '-') || 'default';
        const templateVersion = submitTemplate?.version || personalizationCase.templateVersionFrozen || 1;
        const layoutConfig = (submitTemplate as any)?.layoutJson || null;
        const orderId = personalizationCase.orderId;
        const orderReference = personalizationCase.order?.orderReference;

        // Utwórz RenderJob w bazie (dla śledzenia)
        const dbRenderJob = await prisma.renderJob.create({
          data: {
            caseId: personalizationCase.id,
            jobType: 'PDF_PRINT',
            status: 'PENDING',
            metadata: {
              templateId: personalizationCase.templateId,
              templateVersion: personalizationCase.templateVersionFrozen,
            },
          },
        });

        // Dodaj job do BullMQ queue
        const bullmqJob = await addFinalPdfJob({
          caseId: personalizationCase.id,
          answers: mergedAnswers as Record<string, string | number | boolean>,
          templateName: templateSlug,
          templateVersion,
          layoutConfig,
          layoutOverrides: layoutOverrides as any,
          orderId,
          orderReference: orderReference || undefined,
          renderOptions: {
            width: 297, // A4 landscape for 2-page spread (148mm x 2)
            height: 210,
          },
        });

        // Zaktualizuj RenderJob z ID BullMQ
        await prisma.renderJob.update({
          where: { id: dbRenderJob.id },
          data: {
            metadata: {
              ...(dbRenderJob.metadata as object || {}),
              bullmqJobId: bullmqJob.id,
            },
          },
        });

        // Zaktualizuj status case na SUBMITTED
        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: tokenHash },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
            layoutOverrides: layoutOverrides ? JSON.parse(JSON.stringify(layoutOverrides)) : undefined,
          },
        });

        fastify.log.info(`RenderJob created: ${dbRenderJob.id}, BullMQ job: ${bullmqJob.id} for case: ${personalizationCase.id}`);

        return reply.send({
          ...updated,
          renderJob: {
            id: dbRenderJob.id,
            bullmqJobId: bullmqJob.id,
            status: 'PENDING',
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zatwierdzić projektu',
        });
      }
    }
  );

  // POST /personalization/:token/upload-preview - Upload PNG preview from frontend
  fastify.post<{ Params: PersonalizationParams }>(
    '/:token/upload-preview',
    {
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
            tokenActive: true,
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

        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (!(await assertPersonalizationFeatureEnabled(personalizationCase, reply))) return;

        // Pobierz plik z multipart
        const data = await request.file();
        
        if (!data) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Brak pliku preview',
          });
        }

        // Sprawdź typ pliku
        if (!data.mimetype.startsWith('image/')) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Plik musi być obrazem',
          });
        }

        fastify.log.info(`[UploadPreview] File received: ${data.filename}, size: ${data.file.bytesRead} bytes`);

        // Konwertuj stream na buffer
        const buffer = await data.toBuffer();

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
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zapisać podglądu',
        });
      }
    }
  );
}
