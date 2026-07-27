import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DECORATION_CATEGORIES,
  deleteDecoration,
  isDecorationCategory,
  listDecorations,
  uploadDecoration,
} from '../../services/admin/decorations.service';
import { RATE_LIMITS } from '../../lib/rate-limits';

export async function decorationsRoutes(fastify: FastifyInstance) {
  // GET /admin/decorations
  fastify.get(
    '/',
    {
      schema: {
        tags: ['decorations'],
        summary: 'Biblioteka ozdobników sprzedawcy',
        response: {
          // Bez additionalProperties fast-json-stringify zwrocilby puste obiekty.
          200: {
            type: 'object',
            properties: {
              decorations: { type: 'array', items: { type: 'object', additionalProperties: true } },
              categories: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const decorations = await listDecorations();
      return reply.send({ decorations, categories: [...DECORATION_CATEGORIES] });
    }
  );

  // POST /admin/decorations (multipart: file + pola category/name)
  fastify.post(
    '/',
    {
      config: { rateLimit: RATE_LIMITS.adminUpload },
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
      const rawCategory = fields?.category?.value;
      const rawName = fields?.name?.value;

      if (!isDecorationCategory(rawCategory)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Nieprawidłowa kategoria. Dozwolone: ${DECORATION_CATEGORIES.join(', ')}`,
        });
      }

      try {
        const buffer = await data.toBuffer();
        const decoration = await uploadDecoration({
          buffer,
          fileName: data.filename,
          mimeType: data.mimetype,
          category: rawCategory,
          name: typeof rawName === 'string' ? rawName : undefined,
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
