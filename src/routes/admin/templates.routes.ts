import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  templateFormSchema,
  templateIdParamsSchema,
  createTemplateSchema,
  updateTemplateMetadataSchema,
  templateLayoutSchema,
  templateAssetParamsSchema,
  type TemplateFormInput,
  type TemplateIdParams,
  type CreateTemplateInput,
  type UpdateTemplateMetadataInput,
  type TemplateLayoutInput,
  type TemplateAssetParams
} from '../../schemas/admin.schema';
import {
  listTemplates,
  getTemplateForm,
  replaceTemplateForm,
  createTemplate,
  updateTemplateMetadata,
  deleteTemplate
} from '../../services/admin/templates.service';
import {
  getTemplateLayout,
  updateTemplateLayout,
  listTemplateAssets,
  uploadTemplateAsset,
  deleteTemplateAsset,
} from '../../services/admin/templates-layout.service';

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

  // ============================================
  // Layout endpoints (wizualny edytor szablonów)
  // ============================================

  // GET /admin/templates/:id/layout
  fastify.get<{ Params: TemplateIdParams }>(
    '/:id/layout',
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      try {
        const layout = await getTemplateLayout(paramsParsed.data.id);
        return reply.send({ layout });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
    }
  );

  // PUT /admin/templates/:id/layout
  fastify.put<{ Params: TemplateIdParams; Body: TemplateLayoutInput }>(
    '/:id/layout',
    async (request: FastifyRequest<{ Params: TemplateIdParams; Body: TemplateLayoutInput }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const bodyParsed = templateLayoutSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Nieprawidłowa struktura layoutu',
          details: bodyParsed.error.errors,
        });
      }
      try {
        const layout = await updateTemplateLayout(paramsParsed.data.id, bodyParsed.data);
        return reply.send({ layout });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Update Failed', message: error.message });
      }
    }
  );

  // ============================================
  // Asset endpoints (pliki graficzne szablonów)
  // ============================================

  // GET /admin/templates/:id/assets
  fastify.get<{ Params: TemplateIdParams }>(
    '/:id/assets',
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const assets = await listTemplateAssets(paramsParsed.data.id);
      return reply.send({ assets });
    }
  );

  // POST /admin/templates/:id/assets
  fastify.post<{ Params: TemplateIdParams }>(
    '/:id/assets',
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
      }

      // Walidacja typu MIME
      const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
      if (!allowedMimeTypes.includes(data.mimetype)) {
        return reply.status(400).send({
          error: 'Upload Error',
          message: `Niedozwolony typ pliku: ${data.mimetype}. Dozwolone: PNG, JPG, SVG, WebP`,
        });
      }

      // Odczytaj typ assetu z pola formularza (domyślnie BACKGROUND)
      const assetType = (data.fields?.assetType as any)?.value || 'BACKGROUND';

      try {
        const buffer = await data.toBuffer();
        const asset = await uploadTemplateAsset(
          paramsParsed.data.id,
          buffer,
          data.filename,
          data.mimetype,
          assetType,
          { originalName: data.filename }
        );
        return reply.status(201).send({ asset });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Upload Failed', message: error.message });
      }
    }
  );

  // DELETE /admin/templates/:id/assets/:assetId
  fastify.delete<{ Params: TemplateAssetParams }>(
    '/:id/assets/:assetId',
    async (request: FastifyRequest<{ Params: TemplateAssetParams }>, reply: FastifyReply) => {
      const paramsParsed = templateAssetParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      try {
        await deleteTemplateAsset(paramsParsed.data.assetId);
        return reply.send({ success: true });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Delete Failed', message: error.message });
      }
    }
  );
}
