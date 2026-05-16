import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as catalogService from '../../services/admin/warehouse-catalogs.service';

export async function warehouseCatalogsRoutes(fastify: FastifyInstance) {
  fastify.get('/', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Lista katalogów produktów magazynowych',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: catalogService.CatalogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await catalogService.getCatalogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania katalogów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Utwórz katalog produktów magazynowych',
      body: {
        type: 'object',
        required: ['code', 'name'],
        properties: {
          code: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          isDefault: { type: 'boolean', default: false },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: catalogService.CreateCatalogInput }>, reply: FastifyReply) => {
    try {
      const catalog = await catalogService.createCatalog(request.body);
      return reply.status(201).send(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia katalogu';
      const status = message.includes('Brak kontekstu') ? 400 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/:id', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Szczegóły katalogu produktów magazynowych',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const catalog = await catalogService.getCatalogById(request.params.id);
      if (!catalog) return reply.status(404).send({ error: 'Not Found', message: 'Katalog nie znaleziony' });
      return reply.send(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania katalogu';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/:id/products', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Lista produktów z katalogu magazynowego',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: catalogService.CatalogProductsQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await catalogService.getCatalogProducts(request.params.id, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania produktów katalogu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/:id', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Edytuj katalog produktów magazynowych',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          isDefault: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: catalogService.UpdateCatalogInput;
  }>, reply: FastifyReply) => {
    try {
      const catalog = await catalogService.updateCatalog(request.params.id, request.body);
      return reply.send(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji katalogu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/:id', {
    schema: {
      tags: ['warehouse-catalogs'],
      summary: 'Usuń katalog produktów magazynowych',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await catalogService.deleteCatalog(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania katalogu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
