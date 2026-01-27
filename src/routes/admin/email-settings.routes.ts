import type { FastifyPluginAsync } from 'fastify';
import { 
  emailSettingsSchema, 
  emailSettingsIdParamsSchema,
  type EmailSettingsInput,
  type EmailSettingsIdParams,
} from '../../schemas/admin.schema';
import {
  getAllEmailSettings,
  getEmailSettingsById,
  createEmailSettings,
  updateEmailSettings,
  deleteEmailSettings,
  testEmailSettings,
} from '../../services/admin/email-settings.service';

export const emailSettingsRoutes: FastifyPluginAsync = async (server) => {
  // GET /admin/email-settings - lista wszystkich konfiguracji
  server.get('/', async (request, reply) => {
    try {
      const settings = await getAllEmailSettings();
      return reply.send(settings);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ 
        error: 'Failed to fetch email settings',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // POST /admin/email-settings/test - MUSI BYĆ PRZED POST / i /:id
  server.post('/test', async (request, reply) => {
    try {
      const parsed = emailSettingsSchema.safeParse(request.body);
      
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const result = await testEmailSettings(parsed.data);
      
      if (result.success) {
        return reply.send({ success: true, message: result.message });
      } else {
        return reply.status(400).send({ success: false, message: result.message });
      }
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ 
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // POST /admin/email-settings - utworzenie nowej konfiguracji
  server.post('/', async (request, reply) => {
    try {
      const parsed = emailSettingsSchema.safeParse(request.body);
      
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const settings = await createEmailSettings(parsed.data);
      return reply.status(201).send(settings);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ 
        error: 'Failed to create email settings',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // GET /admin/email-settings/:id - szczegóły jednej konfiguracji
  server.get('/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const parsed = emailSettingsIdParamsSchema.safeParse(params);
      
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const settings = await getEmailSettingsById(parsed.data.id);
      
      if (!settings) {
        return reply.status(404).send({ error: 'Email settings not found' });
      }

      return reply.send(settings);
    } catch (error) {
      server.log.error(error);
      return reply.status(500).send({ 
        error: 'Failed to fetch email settings',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // PUT /admin/email-settings/:id - aktualizacja konfiguracji
  server.put('/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const paramsValidation = emailSettingsIdParamsSchema.safeParse(params);
      
      if (!paramsValidation.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsValidation.error.errors[0].message,
        });
      }

      const settings = await updateEmailSettings(paramsValidation.data.id, request.body as any);
      return reply.send(settings);
    } catch (error) {
      server.log.error(error);
      
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.status(404).send({ error: 'Email settings not found' });
      }
      
      return reply.status(500).send({ 
        error: 'Failed to update email settings',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // DELETE /admin/email-settings/:id - usunięcie konfiguracji
  server.delete('/:id', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const parsed = emailSettingsIdParamsSchema.safeParse(params);
      
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      await deleteEmailSettings(parsed.data.id);
      return reply.send({ success: true });
    } catch (error) {
      server.log.error(error);
      
      if (error instanceof Error && error.message.includes('not found')) {
        return reply.status(404).send({ error: 'Email settings not found' });
      }
      
      return reply.status(500).send({ 
        error: 'Failed to delete email settings',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
};
