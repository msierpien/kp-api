import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getPrintSettings, updatePrintSettings, type UpdatePrintSettingsInput } from '../../services/admin/print-settings.service';

export const printSettingsRoutes: FastifyPluginAsync = async (server: any) => {
  server.get('/', {
    schema: {
      tags: ['settings'],
      summary: 'Pobierz ustawienia generowania paczek do druku',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await getPrintSettings());
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: 'Failed to fetch print settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.put('/', {
    schema: {
      tags: ['settings'],
      summary: 'Zapisz ustawienia generowania paczek do druku',
      body: {
        type: 'object',
        properties: {
          formatPdf: { type: 'boolean' },
          formatPng: { type: 'boolean' },
          combinedPdf: { type: 'boolean' },
          watermarkEnabled: { type: 'boolean' },
          watermarkText: { type: 'string', maxLength: 60 },
          printOffsetXMm: { type: 'number', minimum: -10, maximum: 10 },
          printOffsetYMm: { type: 'number', minimum: -10, maximum: 10 },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest<{ Body: UpdatePrintSettingsInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await updatePrintSettings(request.body || {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('przynajmniej jeden format') ? 400 : 500;
      server.log.error(error);
      return reply.status(status).send({ error: 'Failed to update print settings', message });
    }
  });
};
