import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { templateFormSchema, templateIdParamsSchema, type TemplateFormInput, type TemplateIdParams } from '../../schemas/admin.schema';
import { listTemplates, getTemplateForm, replaceTemplateForm } from '../../services/admin/templates.service';

export async function templatesRoutes(fastify: FastifyInstance) {
  // GET /admin/templates
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const templates = await listTemplates();
    return reply.send(templates);
  });

  // GET /admin/templates/:id/form
  fastify.get<{ Params: TemplateIdParams }>(
    '/:id/form',
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const data = await getTemplateForm(paramsParsed.data.id);
      return reply.send(data);
    }
  );

  // PUT /admin/templates/:id/form
  fastify.put<{ Params: TemplateIdParams; Body: TemplateFormInput }>(
    '/:id/form',
    async (request: FastifyRequest<{ Params: TemplateIdParams; Body: TemplateFormInput }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const bodyParsed = templateFormSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: bodyParsed.error.errors[0].message });
      }
      const data = await replaceTemplateForm(paramsParsed.data.id, bodyParsed.data);
      return reply.send(data);
    }
  );
}
