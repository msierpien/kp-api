import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createTemplateBlockSchema,
  updateTemplateBlockSchema,
} from '../../schemas/admin.schema';
import {
  copyBlockAssets,
  createTemplateBlock,
  deleteTemplateBlock,
  listTemplateBlocks,
  updateTemplateBlock,
} from '../../services/admin/template-blocks.service';

/**
 * Biblioteka blokow wielokrotnego uzytku.
 *
 * Uklad tras jak przy ozdobnikach: lista z filtrem, zapis z edytora, porzadki
 * (nazwa, kategoria, tagi, widocznosc) i kasowanie. Doszlo `copy-assets` -
 * grafiki bloku musza trafic do assetow szablonu docelowego, inaczej wstawiony
 * blok wskazywalby pliki cudzego szablonu.
 */
export async function templateBlocksRoutes(fastify: FastifyInstance) {
  // GET /admin/template-blocks
  fastify.get<{ Querystring: { includeInactive?: string } }>(
    '/',
    {
      schema: {
        tags: ['template-blocks'],
        summary: 'Lista blokow wielokrotnego uzytku',
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: { includeInactive?: string } }>, reply: FastifyReply) => {
      try {
        return reply.send(
          await listTemplateBlocks({ includeInactive: request.query?.includeInactive === 'true' })
        );
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
    }
  );

  // POST /admin/template-blocks - zapis zaznaczenia z edytora
  fastify.post(
    '/',
    {
      schema: {
        tags: ['template-blocks'],
        summary: 'Zapisz blok w bibliotece',
        body: { type: 'object', additionalProperties: true },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createTemplateBlockSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      try {
        return reply.status(201).send({ block: await createTemplateBlock(parsed.data) });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
    }
  );

  // PATCH /admin/template-blocks/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['template-blocks'],
        summary: 'Zmien nazwe, kategorie, tagi albo widocznosc bloku',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = updateTemplateBlockSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      try {
        return reply.send({ block: await updateTemplateBlock(request.params.id, parsed.data) });
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
    }
  );

  // DELETE /admin/template-blocks/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['template-blocks'],
        summary: 'Usun blok z biblioteki',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await deleteTemplateBlock(request.params.id);
        return reply.status(204).send();
      } catch (error: any) {
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
    }
  );

  // POST /admin/template-blocks/:id/copy-assets?templateId=...
  //
  // Wolane PRZED wstawieniem bloku: panel podmienia `imageUrl` w warstwach na
  // sciezki zwrocone tutaj. Bez tego kroku blok niosl by odwolania do assetow
  // szablonu, z ktorego powstal.
  fastify.post<{ Params: { id: string }; Querystring: { templateId?: string } }>(
    '/:id/copy-assets',
    {
      schema: {
        tags: ['template-blocks'],
        summary: 'Skopiuj grafiki bloku do assetow szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          required: ['templateId'],
          properties: { templateId: { type: 'string' } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { templateId?: string } }>,
      reply: FastifyReply
    ) => {
      const templateId = request.query?.templateId;
      if (!templateId) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak templateId' });
      }

      try {
        return reply.send(await copyBlockAssets(request.params.id, templateId));
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Bad Request', message: error.message });
      }
    }
  );
}
