import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  aiPromptTemplateIdParamsSchema,
  aiPromptTemplateSchema,
  aiPromptTemplateUpdateSchema,
  aiProviderTestSchema,
  aiSettingsSchema,
} from '../../schemas/admin.schema';
import { getAiSettings, testAiProvider, updateAiSettings } from '../../services/admin/ai-settings.service';
import {
  createAiPromptTemplate,
  deleteAiPromptTemplate,
  listAiPromptTemplates,
  updateAiPromptTemplate,
} from '../../services/admin/ai-prompt-templates.service';

export const aiSettingsRoutes: FastifyPluginAsync = async (server: any) => {
  server.get('/', {
    schema: {
      tags: ['ai'],
      summary: 'Pobierz ustawienia AI',
      response: { 200: { type: 'object' } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const settings = await getAiSettings();
      return reply.send(settings);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: 'Failed to fetch AI settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.put('/', {
    schema: {
      tags: ['ai'],
      summary: 'Zapisz ustawienia AI',
      body: { type: 'object' },
      response: { 200: { type: 'object' } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = aiSettingsSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const settings = await updateAiSettings(parsed.data);
      return reply.send(settings);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: 'Failed to update AI settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/test', {
    schema: {
      tags: ['ai'],
      summary: 'Sprawdź konfigurację dostawcy AI',
      body: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string', enum: ['OPENAI', 'ANTHROPIC', 'DEEPSEEK'] },
        },
      },
      response: { 200: { type: 'object' } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = aiProviderTestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const result = await testAiProvider(parsed.data.provider);
      return reply.status(result.success ? 200 : 400).send(result);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.get('/prompt-templates', {
    schema: {
      tags: ['ai'],
      summary: 'Lista szablonów promptów AI',
      response: { 200: { type: 'array', items: { type: 'object' } } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const templates = await listAiPromptTemplates();
      return reply.send(templates);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: 'Failed to fetch AI prompt templates',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.post('/prompt-templates', {
    schema: {
      tags: ['ai'],
      summary: 'Utwórz szablon promptu AI',
      body: { type: 'object' },
      response: { 201: { type: 'object' } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = aiPromptTemplateSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const template = await createAiPromptTemplate(parsed.data);
      return reply.status(201).send(template);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({
        error: 'Failed to create AI prompt template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.put('/prompt-templates/:id', {
    schema: {
      tags: ['ai'],
      summary: 'Zaktualizuj szablon promptu AI',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object' },
      response: { 200: { type: 'object' } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = aiPromptTemplateIdParamsSchema.safeParse(request.params);
      const body = aiPromptTemplateUpdateSchema.safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: params.success ? body.error?.errors[0]?.message : params.error.errors[0].message,
        });
      }

      const template = await updateAiPromptTemplate(params.data.id, body.data);
      return reply.send(template);
    } catch (error) {
      server.log.error(error);

      if (error instanceof Error && error.message.includes('not found')) {
        return reply.status(404).send({ error: 'AI prompt template not found' });
      }

      return reply.status(500).send({
        error: 'Failed to update AI prompt template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  server.delete('/prompt-templates/:id', {
    schema: {
      tags: ['ai'],
      summary: 'Usuń szablon promptu AI',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = aiPromptTemplateIdParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: params.error.errors[0].message,
        });
      }

      const result = await deleteAiPromptTemplate(params.data.id);
      return reply.send(result);
    } catch (error) {
      server.log.error(error);

      if (error instanceof Error && error.message.includes('not found')) {
        return reply.status(404).send({ error: 'AI prompt template not found' });
      }

      return reply.status(500).send({
        error: 'Failed to delete AI prompt template',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
};
