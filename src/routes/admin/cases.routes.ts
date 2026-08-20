import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getCases,
  getCaseById,
  enqueueCasePrintPackage,
  deleteCasePrintAssets,
  updateCaseAnswers,
  validateCaseAnswers,
  updateCaseStatus,
  addCaseNote,
  refreshCaseLayoutFromTemplate,
  resendPersonalizationEmail,
  CasePackageValidationError,
} from '../../services/admin/cases.service';
import {
  casesQuerySchema,
  caseIdParamsSchema,
  updateCaseAnswersSchema,
  updateCaseStatusSchema,
  addCaseNoteSchema,
  CasesQueryInput,
  CaseIdParams,
  UpdateCaseAnswersInput,
  UpdateCaseStatusInput,
  AddCaseNoteInput,
} from '../../schemas/admin.schema';
import { casePrintSchema } from '../../schemas/print.schema';
import {
  createPrintJob,
  listCasePrintAssets,
  getCaseTemplatePrintProfile,
  toPrintJobDto,
} from '../../services/print/print-job.service';
import {
  AiEditorDisabledError,
  AiLimitExceededError,
  auditEditorDesign,
  generateEditorText,
  proposeEditorLayout,
  type EditorAgentContext,
} from '../../services/ai/editor-agent.service';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import {
  HELP_REQUEST_STATUSES,
  listCaseHelpRequests,
  updateCaseHelpRequest,
  type HelpRequestStatus,
} from '../../services/admin/case-help-requests.service';
import { isAppError } from '../../lib/errors';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { decrypt } from '../../lib/encryption';
import { PERSONALIZATION_CASE_STATUSES } from '../../lib/personalization-case-statuses';

export async function casesRoutes(fastify: FastifyInstance) {
  // GET /admin/cases
  fastify.get<{ Querystring: CasesQueryInput }>(
    '/',
    {
      schema: {
        tags: ['cases'],
        summary: 'Lista case\'ów personalizacji',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
            status: { type: 'string', description: 'Filtr po statusie' },
            emailStatus: { type: 'string', enum: ['sent', 'not_sent', 'failed', ''] },
            search: { type: 'string', description: 'Szukaj po referencji zamówienia lub emailu' },
            shopId: { type: 'string' },
            sortBy: { type: 'string', default: 'createdAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object', additionalProperties: true } },
              total: { type: 'integer' },
              page: { type: 'integer' },
              limit: { type: 'integer' },
              totalPages: { type: 'integer' },
              summary: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  total: { type: 'integer' },
                  byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
                  waitingForCustomer: { type: 'integer' },
                  submitted: { type: 'integer' },
                  readyForPrint: { type: 'integer' },
                  failedRender: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: CasesQueryInput }>, reply: FastifyReply) => {
      try {
        const parsed = casesQuerySchema.safeParse(request.query);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const result = await getCases(parsed.data);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać listy case',
        });
      }
    }
  );

  // GET /admin/cases/:id
  fastify.get<{ Params: CaseIdParams }>(
    '/:id',
    {
      schema: {
        tags: ['cases'],
        summary: 'Szczegóły case\'u',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const parsed = caseIdParamsSchema.safeParse(request.params);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const caseItem = await getCaseById(parsed.data.id);
        return reply.send(caseItem);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać szczegółów case',
        });
      }
    }
  );

  // PUT /admin/cases/:id/answers
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>(
    '/:id/answers',
    {
      schema: {
        tags: ['cases'],
        summary: 'Aktualizuj odpowiedzi case\'u (korekta sprzedawcy)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            answers: { type: 'object', description: 'Stara płaska mapa klucz pola → wartość' },
            sharedAnswers: { type: 'object', description: 'Odpowiedzi wspólne dla całej pozycji' },
            items: {
              type: 'array',
              description: 'Odpowiedzi indywidualne per sztuka',
              items: { type: 'object' },
            },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseAnswersSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await updateCaseAnswers(
          paramsValidation.data.id,
          bodyValidation.data
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować odpowiedzi',
        });
      }
    }
  );

  // POST /admin/cases/:id/answers/validate
  fastify.post<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>(
    '/:id/answers/validate',
    {
      schema: {
        tags: ['cases'],
        summary: 'Waliduj odpowiedzi case\'u bez generowania paczki',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            answers: { type: 'object', description: 'Stara płaska mapa klucz pola → wartość' },
            sharedAnswers: { type: 'object', description: 'Odpowiedzi wspólne dla całej pozycji' },
            items: {
              type: 'array',
              description: 'Odpowiedzi indywidualne per sztuka',
              items: { type: 'object' },
            },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          422: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseAnswersSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const result = await validateCaseAnswers(
          paramsValidation.data.id,
          bodyValidation.data
        );
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        if (error.message === 'Template layout is required for answer validation') {
          return reply.status(422).send({
            error: 'Validation Error',
            message: 'Szablon musi mieć layout przed walidacją odpowiedzi',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zwalidować odpowiedzi',
        });
      }
    }
  );

  // POST /admin/cases/:id/render-package
  fastify.post<{ Params: CaseIdParams }>(
    '/:id/render-package',
    {
      schema: {
        tags: ['cases'],
        summary: 'Generuj paczkę plików do druku dla case\'u',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          422: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, validationSummary: { type: 'object', additionalProperties: true } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);

        if (!paramsValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: paramsValidation.error.errors[0].message,
          });
        }

        const result = await enqueueCasePrintPackage(paramsValidation.data.id);
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        if (error instanceof CasePackageValidationError) {
          return reply.status(422).send({
            error: 'Validation Error',
            message: 'Odpowiedzi wymagają poprawy przed generowaniem paczki',
            validationSummary: error.validationSummary,
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się wygenerować paczki do druku',
        });
      }
    }
  );

  // GET /admin/cases/:id/print-assets
  fastify.get<{ Params: CaseIdParams }>(
    '/:id/print-assets',
    {
      schema: {
        tags: ['cases'],
        summary: 'Pliki tej sprawy, ktore mozna wyslac na drukarke',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      const parsed = caseIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }
      // Razem z plikami oddajemy profil druku z szablonu - okno druku ustawia
      // sie samo, zamiast kazac operatorowi pamietac, na czym drukuje sie ten
      // format.
      const [assets, printProfile] = await Promise.all([
        listCasePrintAssets(parsed.data.id),
        getCaseTemplatePrintProfile(parsed.data.id),
      ]);
      return reply.send({ assets, printProfile });
    }
  );

  // DELETE /admin/cases/:id/print-assets - sprzatanie paczek do druku
  fastify.delete<{ Params: CaseIdParams }>(
    '/:id/print-assets',
    {
      schema: {
        tags: ['cases'],
        summary: 'Usuniecie plikow paczki do druku (ZIP, PDF i PNG sztuk)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      const parsed = caseIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      const result = await deleteCasePrintAssets(parsed.data.id);
      return reply.send(result);
    }
  );

  // POST /admin/cases/:id/print — glowna droga druku z panelu
  fastify.post<{ Params: CaseIdParams }>(
    '/:id/print',
    {
      schema: {
        tags: ['cases'],
        summary: 'Zlec druk plikow tej sprawy',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          201: { type: 'object', additionalProperties: true },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      const params = caseIdParamsSchema.safeParse(request.params);
      const body = casePrintSchema.safeParse(request.body);

      if (!params.success || !body.success) {
        const message = params.success
          ? body.error!.errors[0].message
          : params.error.errors[0].message;
        return reply.status(400).send({ error: 'Validation Error', message });
      }

      const assets = await listCasePrintAssets(params.data.id);
      if (!assets.length) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Ta sprawa nie ma jeszcze plikow do druku — wygeneruj paczke',
        });
      }

      // Zakres wybiera operator: komplet to jeden plik z wszystkimi sztukami,
      // 'items' to kazda sztuka osobno (latwiej powtorzyc pojedyncza po zacieciu).
      let selected = assets;
      if (body.data.scope === 'combined') {
        selected = assets.filter((asset) => asset.kind === 'combined');
      } else if (body.data.scope === 'items') {
        selected = assets.filter((asset) => asset.kind === 'item');
      } else {
        const wanted = new Set(body.data.assetIds ?? []);
        selected = assets.filter((asset) => wanted.has(asset.id));
      }

      if (!selected.length) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Wybrany zakres nie obejmuje zadnego pliku',
        });
      }

      const created = [];
      try {
        for (const asset of selected) {
          const job = await createPrintJob({
            assetId: asset.id,
            agentId: body.data.agentId,
            profile: body.data.profile,
            copies: body.data.copies,
            options: body.data.options,
            requestedById: request.user?.userId ?? null,
          });
          created.push(toPrintJobDto(job));
        }
      } catch (error) {
        if (isAppError(error)) {
          // Czesc zadan mogla juz powstac - mowimy o tym wprost, zeby operator
          // wiedzial, ze polowa nakladu jest w kolejce.
          return reply.status(error.statusCode).send({
            error: error.error,
            message: created.length
              ? `${error.message} (utworzono juz ${created.length} zadan)`
              : error.message,
          });
        }
        throw error;
      }

      return reply.status(201).send({ jobs: created, created: created.length });
    }
  );

  // PUT /admin/cases/:id/status
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>(
    '/:id/status',
    {
      schema: {
        tags: ['cases'],
        summary: 'Zmień status case\'u',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: PERSONALIZATION_CASE_STATUSES,
            },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseStatusSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await updateCaseStatus(
          paramsValidation.data.id,
          bodyValidation.data.status
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować statusu',
        });
      }
    }
  );

  // POST /admin/cases/:id/notes
  fastify.post<{ Params: CaseIdParams; Body: AddCaseNoteInput }>(
    '/:id/notes',
    {
      schema: {
        tags: ['cases'],
        summary: 'Dodaj notatkę wewnętrzną do case\'u',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['note'],
          properties: {
            note: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: AddCaseNoteInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = addCaseNoteSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await addCaseNote(paramsValidation.data.id, bodyValidation.data.note);
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się dodać notatki',
        });
      }
    }
  );

  // POST /admin/cases/:id/resend-email
  fastify.post<{ Params: CaseIdParams }>(
    '/:id/resend-email',
    {
      schema: {
        tags: ['cases'],
        summary: 'Ponownie wyślij email personalizacji do klienta',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          503: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);

        if (!paramsValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: paramsValidation.error.errors[0].message,
          });
        }

        const result = await resendPersonalizationEmail(paramsValidation.data.id);
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        if (error.message === 'Email service not configured') {
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Serwis email nie jest skonfigurowany',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się wysłać emaila',
        });
      }
    }
  );

  // POST /admin/cases/:id/refresh-layout - zdejmij zamrozony layout
  fastify.post<{ Params: CaseIdParams }>(
    '/:id/refresh-layout',
    {
      schema: {
        tags: ['cases'],
        summary: 'Wczytaj do sprawy aktualny layout szablonu (zdejmij snapshot)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      const paramsValidation = caseIdParamsSchema.safeParse(request.params);
      if (!paramsValidation.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsValidation.error.errors[0].message,
        });
      }

      try {
        const result = await refreshCaseLayoutFromTemplate(paramsValidation.data.id);
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się odświeżyć layoutu sprawy',
        });
      }
    }
  );

  // GET /admin/cases/:id/token - Get personalization token for case
  fastify.get<{ Params: CaseIdParams }>(
    '/:id/token',
    {
      schema: {
        tags: ['cases'],
        summary: 'Pobierz token klienta i URL personalizacji',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              url: { type: 'string' },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);

        if (!paramsValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: paramsValidation.error.errors[0].message,
          });
        }

        const caseItem = await prisma.personalizationCase.findUnique({
          where: { id: paramsValidation.data.id },
          select: {
            id: true,
            customerTokenEncrypted: true,
          },
        });

        if (!caseItem) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }

        if (!caseItem.customerTokenEncrypted) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Token nie został jeszcze wygenerowany',
          });
        }

        // Odszyfruj token
        const token = decrypt(caseItem.customerTokenEncrypted);

        return reply.send({
          token,
          url: `${config.frontend.portalUrl}/${token}`,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać tokena',
        });
      }
    }
  );

  // ============================================
  // Zgloszenia "Poproscie grafika"
  // ============================================

  fastify.get<{ Params: CaseIdParams }>(
    '/:id/help-requests',
    {
      schema: {
        tags: ['cases'],
        summary: 'Zgłoszenia klienta do grafika dla tej sprawy',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              helpRequests: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const params = caseIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation Error', message: params.error.errors[0].message });
        }

        return reply.send({ helpRequests: await listCaseHelpRequests(params.data.id) });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać zgłoszeń',
        });
      }
    }
  );

  fastify.patch<{ Params: { id: string; helpRequestId: string }; Body: { status?: string; responseNote?: string | null } }>(
    '/:id/help-requests/:helpRequestId',
    {
      schema: {
        tags: ['cases'],
        summary: 'Zmień status zgłoszenia do grafika',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, helpRequestId: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: [...HELP_REQUEST_STATUSES] },
            responseNote: { type: 'string', nullable: true, maxLength: 2000 },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      try {
        const updated = await updateCaseHelpRequest(request.params.helpRequestId, {
          status: request.body?.status as HelpRequestStatus | undefined,
          responseNote: request.body?.responseNote,
        });
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (String(error?.message).includes('nie znalezione')) {
          return reply.status(404).send({ error: 'Not Found', message: 'Zgłoszenie nie istnieje' });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować zgłoszenia',
        });
      }
    }
  );

  // ============================================
  // Asystent AI dla obslugi
  // ============================================

  /**
   * Te same trzy akcje, ktore ma klient w edytorze - tyle ze wolane przez
   * pracownika, zwykle po zgloszeniu "poproscie grafika". Limit na sprawe
   * celowo NIE obowiazuje: to praca obslugi, a nie klient klikajacy
   * „jeszcze raz" - jego licznik nie ma tu czego pilnowac. Limity tenanta
   * (dzienny i miesieczny) dzialaja normalnie.
   */
  const aiActions = {
    text: generateEditorText,
    layout: proposeEditorLayout,
    audit: auditEditorDesign,
  } as const;

  for (const [action, run] of Object.entries(aiActions)) {
    fastify.post<{ Params: CaseIdParams; Body: unknown }>(
      `/:id/ai/${action}`,
      {
        schema: {
          tags: ['cases'],
          summary: `Asystent AI dla sprawy (${action})`,
          params: { type: 'object', properties: { id: { type: 'string' } } },
          body: { type: 'object', additionalProperties: true },
          response: {
            200: { type: 'object', additionalProperties: true },
            403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
            404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
            429: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
            502: { type: 'object', additionalProperties: true },
          },
        },
      },
      async (request, reply) => {
        const params = caseIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation Error', message: params.error.errors[0].message });
        }

        const context = getTenantContext();
        const tenantId = getTenantId() || context?.tenantId;
        if (!tenantId) {
          return reply.status(403).send({ error: 'Forbidden', message: 'Brak kontekstu firmy' });
        }

        try {
          const result = await (run as (input: never, ctx: EditorAgentContext) => Promise<unknown>)(
            request.body as never,
            {
              tenantId,
              userId: context?.userId ?? null,
              // Bez `personalizationCaseId` limit na sprawe sie nie liczy,
              // ale wywolanie i tak trafia do dziennika po tenancie.
              source: 'ADMIN_EDITOR',
            }
          );
          return reply.send(result);
        } catch (error: any) {
          if (error instanceof AiEditorDisabledError) {
            return reply.status(403).send({ error: 'Forbidden', message: error.message });
          }
          if (error instanceof AiLimitExceededError) {
            return reply.status(429).send({ error: 'Too Many Requests', message: error.message });
          }
          fastify.log.error({ err: error }, '[AiEditor][admin] call failed');
          return reply.status(502).send({
            error: 'Bad Gateway',
            message: 'Asystent nie odpowiedział. Spróbuj ponownie.',
            requestId: request.id,
          });
        }
      }
    );
  }
}
