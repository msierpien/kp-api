import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  bulkUpdateDecorations,
  createCategory,
  deleteCategory,
  deleteDecoration,
  isDecorationCategory,
  listCategories,
  listDecorations,
  listTags,
  retintDecoration,
  updateCategory,
  updateDecoration,
  uploadDecoration,
  type DecorationBulkAction,
} from '../../services/admin/decorations.service';
import { RATE_LIMITS } from '../../lib/rate-limits';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import {
  AiDescribeUnavailableError,
  describeDecorations,
} from '../../services/ai/decoration-describe.service';

/** Multipart oddaje pola tekstowe jako obiekty z `value`. */
function fieldValue(fields: Record<string, { value?: unknown } | undefined>, key: string): string | undefined {
  const raw = fields?.[key]?.value;
  return typeof raw === 'string' ? raw : undefined;
}

export async function decorationsRoutes(fastify: FastifyInstance) {
  // GET /admin/decorations
  fastify.get(
    '/',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Biblioteka ozdobników sprzedawcy',
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'boolean', default: false } },
        },
        response: {
          // Bez additionalProperties fast-json-stringify zwrocilby puste obiekty.
          200: {
            type: 'object',
            properties: {
              decorations: { type: 'array', items: { type: 'object', additionalProperties: true } },
              categories: { type: 'array', items: { type: 'object', additionalProperties: true } },
              tags: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { includeInactive?: boolean } }>,
      reply: FastifyReply
    ) => {
      const includeInactive = request.query.includeInactive === true;
      const [decorations, categories, tags] = await Promise.all([
        listDecorations({ includeInactive }),
        listCategories({ ensureDefaults: true }),
        listTags({ includeInactive }),
      ]);
      return reply.send({ decorations, categories, tags });
    }
  );

  // POST /admin/decorations/bulk - operacja na zaznaczeniu
  fastify.post<{ Body: { ids?: string[]; action?: DecorationBulkAction } }>(
    '/bulk',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Zmiana kategorii, tagów, widoczności albo usunięcie zaznaczenia',
        body: {
          type: 'object',
          required: ['ids', 'action'],
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            action: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: { type: 'object', properties: { affected: { type: 'integer' } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { ids?: string[]; action?: DecorationBulkAction } }>,
      reply: FastifyReply
    ) => {
      const { ids, action } = request.body || {};
      if (!Array.isArray(ids) || !action?.type) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Brak zaznaczenia albo akcji' });
      }

      try {
        return reply.send(await bulkUpdateDecorations(ids, action));
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // POST /admin/decorations/describe - propozycje tagow z wygladu grafiki
  fastify.post<{ Body: { ids?: string[] } }>(
    '/describe',
    {
      config: { rateLimit: RATE_LIMITS.adminUpload },
      schema: {
        tags: ['decorations'],
        summary: 'Zaproponuj tagi, kategorię i nazwę na podstawie wyglądu',
        body: {
          type: 'object',
          required: ['ids'],
          properties: { ids: { type: 'array', items: { type: 'string' } } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              suggestions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { ids?: string[] } }>, reply: FastifyReply) => {
      const ids = request.body?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Brak zaznaczenia' });
      }

      // Kazdy plik to osobne wywolanie modelu, wiec paczka ma sufit - inaczej
      // jedno klikniecie potrafiloby zjesc dzienny budzet sprzedawcy.
      if (ids.length > 25) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Maksymalnie 25 ozdobników naraz — każdy to osobne zapytanie do modelu',
        });
      }

      const context = getTenantContext();
      const tenantId = getTenantId() || context?.tenantId;
      if (!tenantId) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Brak kontekstu firmy' });
      }

      try {
        const result = await describeDecorations({
          tenantId,
          userId: context?.userId ?? null,
          ids,
        });
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        const status = error instanceof AiDescribeUnavailableError ? 400 : 400;
        return reply.status(status).send({
          error: 'Bad Request',
          message: error?.message || 'Nie udało się opisać grafik',
        });
      }
    }
  );

  // GET /admin/decorations/categories
  fastify.get(
    '/categories',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Grupy ozdobników',
        response: {
          200: {
            type: 'object',
            properties: {
              categories: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ categories: await listCategories({ ensureDefaults: true }) });
    }
  );

  // POST /admin/decorations/categories
  fastify.post<{ Body: { name?: string } }>(
    '/categories',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Dodaj grupę ozdobników',
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        response: {
          201: { type: 'object', properties: { category: { type: 'object', additionalProperties: true } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: { name?: string } }>, reply: FastifyReply) => {
      try {
        const category = await createCategory({ name: String(request.body?.name ?? '') });
        return reply.status(201).send({ category });
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // PATCH /admin/decorations/categories/:id
  fastify.patch<{ Params: { id: string }; Body: { name?: string; sortOrder?: number } }>(
    '/categories/:id',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Zmień nazwę albo kolejność grupy',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: { name: { type: 'string' }, sortOrder: { type: 'integer' } },
        },
        response: {
          200: { type: 'object', properties: { category: { type: 'object', additionalProperties: true } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { name?: string; sortOrder?: number } }>,
      reply: FastifyReply
    ) => {
      try {
        const category = await updateCategory(request.params.id, request.body || {});
        return reply.send({ category });
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // DELETE /admin/decorations/categories/:id
  fastify.delete<{ Params: { id: string } }>(
    '/categories/:id',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Usuń pustą grupę ozdobników',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await deleteCategory(request.params.id);
        return reply.send({ success: true });
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // POST /admin/decorations (multipart: file + pola category/name/tintable)
  fastify.post(
    '/',
    {
      config: { rateLimit: RATE_LIMITS.decorationUpload },
      schema: {
        tags: ['decorations'],
        summary: 'Wgraj ozdobnik (SVG/PNG/JPG/WebP)',
        consumes: ['multipart/form-data'],
        response: {
          201: { type: 'object', properties: { decoration: { type: 'object', additionalProperties: true } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
      }

      // Pola tekstowe multipart siedza w data.fields.
      const fields = data.fields as Record<string, { value?: unknown } | undefined>;
      const rawCategory = fieldValue(fields, 'category');
      const rawName = fieldValue(fields, 'name');
      const rawTintable = fieldValue(fields, 'tintable');
      const rawTags = fieldValue(fields, 'tags');
      const rawDetect = fieldValue(fields, 'detectFromFileName');

      if (!(await isDecorationCategory(rawCategory))) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Nieprawidłowa kategoria — odśwież listę grup i spróbuj ponownie',
        });
      }

      try {
        const buffer = await data.toBuffer();
        const decoration = await uploadDecoration({
          buffer,
          fileName: data.filename,
          mimeType: data.mimetype,
          category: rawCategory as string,
          name: rawName,
          tags: rawTags ? rawTags.split(',') : undefined,
          detectFromFileName: rawDetect === 'true',
          tintable: rawTintable === 'true',
        });
        return reply.status(201).send({ decoration });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({
          error: 'Upload Failed',
          message: error?.message || 'Nie udało się wgrać ozdobnika',
        });
      }
    }
  );

  // PATCH /admin/decorations/:id - nazwa, kategoria, kolejnosc, widocznosc
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; category?: string; sortOrder?: number; isActive?: boolean; tags?: string[] };
  }>(
    '/:id',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Zmień metadane ozdobnika',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            category: { type: 'string' },
            sortOrder: { type: 'integer' },
            isActive: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        response: {
          200: { type: 'object', properties: { decoration: { type: 'object', additionalProperties: true } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { name?: string; category?: string; sortOrder?: number; isActive?: boolean; tags?: string[] };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const decoration = await updateDecoration(request.params.id, request.body || {});
        return reply.send({ decoration });
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // POST /admin/decorations/:id/retint - przygotuj wgrany SVG do przebarwiania
  fastify.post<{ Params: { id: string } }>(
    '/:id/retint',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Zamień twarde wypełnienia SVG na currentColor',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { decoration: { type: 'object', additionalProperties: true } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const decoration = await retintDecoration(request.params.id);
        return reply.send({ decoration });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Bad Request', message: error?.message });
      }
    }
  );

  // DELETE /admin/decorations/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Usuń ozdobnik z biblioteki',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await deleteDecoration(request.params.id);
        return reply.send({ success: true });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(404).send({ error: 'Not Found', message: error?.message });
      }
    }
  );
}
