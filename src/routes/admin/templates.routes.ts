import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { 
  templateFormSchema, 
  templateIdParamsSchema, 
  createTemplateSchema,
  updateTemplateMetadataSchema,
  type TemplateFormInput, 
  type TemplateIdParams,
  type CreateTemplateInput,
  type UpdateTemplateMetadataInput
} from '../../schemas/admin.schema';
import { 
  listTemplates, 
  getTemplateForm, 
  replaceTemplateForm,
  createTemplate,
  updateTemplateMetadata,
  deleteTemplate
} from '../../services/admin/templates.service';

export async function templatesRoutes(fastify: FastifyInstance) {
  // GET /admin/templates
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const templates = await listTemplates();
    return reply.send(templates);
  });

  // POST /admin/templates
  fastify.post<{ Body: CreateTemplateInput }>(
    '/',
    async (request: FastifyRequest<{ Body: CreateTemplateInput }>, reply: FastifyReply) => {
      const bodyParsed = createTemplateSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: bodyParsed.error.errors[0].message });
      }
      try {
        const template = await createTemplate(bodyParsed.data);
        return reply.status(201).send(template);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Create Failed', message: error.message });
      }
    }
  );

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

  // PUT /admin/templates/:id - Update metadata (not forms)
  fastify.put<{ Params: TemplateIdParams; Body: UpdateTemplateMetadataInput }>(
    '/:id',
    async (request: FastifyRequest<{ Params: TemplateIdParams; Body: UpdateTemplateMetadataInput }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const bodyParsed = updateTemplateMetadataSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: bodyParsed.error.errors[0].message });
      }
      try {
        const template = await updateTemplateMetadata(paramsParsed.data.id, bodyParsed.data);
        return reply.send(template);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Update Failed', message: error.message });
      }
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

  // DELETE /admin/templates/:id
  fastify.delete<{ Params: TemplateIdParams }>(
    '/:id',
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      try {
        await deleteTemplate(paramsParsed.data.id);
        return reply.send({ success: true });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Delete Failed', message: error.message });
      }
    }
  );
}
