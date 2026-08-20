import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createEmailTemplate,
  deleteEmailTemplate,
  getEmailTemplateById,
  listEmailTemplateVariables,
  listEmailTemplates,
  renderEmailTemplatePreview,
  sendEmailTemplateTest,
  updateEmailTemplate,
  type EmailTemplateScope,
} from '../../services/admin/email-templates.service';

const looseObjectResponse = { type: 'object', additionalProperties: true } as const;

const scopeSchema = z.enum(['ORDER', 'CASE']);

const createSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional().nullable(),
  subject: z.string().min(1).max(300),
  bodyText: z.string().min(1),
  scope: scopeSchema.default('ORDER'),
  shopId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const previewSchema = z.object({
  subject: z.string().default(''),
  bodyText: z.string().default(''),
  scope: scopeSchema.default('ORDER'),
});

const testSendSchema = z.object({
  to: z.string().email(),
});

export async function emailTemplatesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { scope?: EmailTemplateScope } }>(
    '/',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Lista szablonów wiadomości',
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['ORDER', 'CASE'] } },
        },
        response: { 200: { type: 'array', items: looseObjectResponse } },
      },
    },
    async (request, reply) => {
      const templates = await listEmailTemplates(request.query.scope);
      return reply.send(templates);
    },
  );

  fastify.get<{ Querystring: { scope?: EmailTemplateScope } }>(
    '/variables',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Zmienne dostępne w szablonie',
        querystring: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['ORDER', 'CASE'] } },
        },
        response: { 200: { type: 'array', items: looseObjectResponse } },
      },
    },
    async (request, reply) => {
      return reply.send(listEmailTemplateVariables(request.query.scope ?? 'ORDER'));
    },
  );

  // Podglad dziala na tresci Z FORMULARZA, a nie na zapisanym szablonie —
  // autor widzi efekt, zanim cokolwiek zapisze.
  fastify.post<{ Body: unknown }>(
    '/preview',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Podgląd szablonu na przykładowych danych',
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }
      return reply.send(renderEmailTemplatePreview(parsed.data));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Szczegóły szablonu wiadomości',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await getEmailTemplateById(request.params.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się pobrać szablonu';
        return reply.status(404).send({ error: 'Not Found', message });
      }
    },
  );

  fastify.post<{ Body: unknown }>(
    '/',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Utwórz szablon wiadomości',
        body: { type: 'object', additionalProperties: true },
        response: { 201: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      try {
        const template = await createEmailTemplate(parsed.data);
        return reply.status(201).send(template);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się utworzyć szablonu';
        return reply.status(400).send({ error: 'Validation Error', message });
      }
    },
  );

  fastify.put<{ Params: { id: string }; Body: unknown }>(
    '/:id',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Zapisz szablon wiadomości',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      try {
        return reply.send(await updateEmailTemplate(request.params.id, parsed.data));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się zapisać szablonu';
        return reply.status(400).send({ error: 'Validation Error', message });
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Usuń szablon wiadomości',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      try {
        await deleteEmailTemplate(request.params.id);
        return reply.send({ deleted: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się usunąć szablonu';
        return reply.status(400).send({ error: 'Validation Error', message });
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/:id/test-send',
    {
      schema: {
        tags: ['email-templates'],
        summary: 'Wyślij wiadomość testową z szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply) => {
      const parsed = testSendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Podaj poprawny adres e-mail' });
      }

      try {
        return reply.send(await sendEmailTemplateTest({ id: request.params.id, to: parsed.data.to }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się wysłać wiadomości testowej';
        return reply.status(400).send({ error: 'Email Error', message });
      }
    },
  );
}
