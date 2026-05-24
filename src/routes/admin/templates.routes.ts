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
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_TEMPLATE_ASSET_BYTES,
  assertAllowedImageUpload,
} from '../../lib/upload-validation';
import { RATE_LIMITS } from '../../lib/rate-limits';

const templateItemResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    code: { type: 'string' },
    description: { type: ['string', 'null'] },
    version: { type: 'number' },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string' },
  },
  required: ['id', 'name', 'code', 'version', 'isActive', 'createdAt'],
} as const;

const templateFormResponseSchema = {
  type: 'object',
  properties: {
    forms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
        },
      },
    },
  },
  required: ['forms'],
} as const;

const templateLayoutResponseSchema = {
  type: 'object',
  properties: {
    layout: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
  },
  required: ['layout'],
} as const;

const templateAssetResponseSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function templatesRoutes(fastify: FastifyInstance) {
  // GET /admin/templates
  fastify.get('/', {
    schema: {
      tags: ['templates'],
      summary: 'Lista szablonów personalizacji',
      response: {
        200: {
          type: 'array',
          items: templateItemResponseSchema,
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const templates = await listTemplates();
    return reply.send(templates);
  });

  // POST /admin/templates
  fastify.post<{ Body: CreateTemplateInput }>(
    '/',
    {
      schema: {
        tags: ['templates'],
        summary: 'Utwórz nowy szablon',
        body: {
          type: 'object',
          required: ['name', 'code'],
          properties: {
            name: { type: 'string' },
            code: { type: 'string' },
            description: { type: 'string' },
          },
        },
        response: {
          201: templateItemResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Pobierz konfigurację formularza szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: templateFormResponseSchema },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Zaktualizuj metadane szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
        response: {
          200: templateItemResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Zastąp konfigurację formularza szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', description: 'Konfiguracja formularza z polami (TemplateFormInput)' },
        response: { 200: templateFormResponseSchema },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Usuń szablon',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Pobierz konfigurację wizualnego layoutu (Fabric.js JSON)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: templateLayoutResponseSchema,
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Zapisz wizualny layout szablonu (Fabric.js JSON)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object', description: 'Konfiguracja layoutu Fabric.js z warstwami i fontami' },
        response: {
          200: templateLayoutResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['templates'],
        summary: 'Lista zasobów graficznych szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              assets: {
                type: 'array',
                items: templateAssetResponseSchema,
              },
            },
            required: ['assets'],
          },
        },
      },
    },
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
    {
      config: {
        rateLimit: RATE_LIMITS.adminUpload,
      },
      schema: {
        tags: ['templates'],
        summary: 'Wgraj zasób graficzny do szablonu (PNG/JPG/WebP)',
        description: 'Przyjmuje multipart/form-data z plikiem obrazu i opcjonalnym polem assetType',
        consumes: ['multipart/form-data'],
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          201: {
            type: 'object',
            properties: { asset: templateAssetResponseSchema },
            required: ['asset'],
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
      }

      try {
        const buffer = await data.toBuffer();
        assertAllowedImageUpload(buffer, data.mimetype, { maxBytes: MAX_TEMPLATE_ASSET_BYTES });

        // Odczytaj typ assetu z pola formularza (domyślnie BACKGROUND)
        const assetType = String((data.fields?.assetType as any)?.value || 'BACKGROUND').toUpperCase();

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
        return reply.status(400).send({
          error: 'Upload Failed',
          message: error.message ||
            `Niedozwolony typ pliku. Dozwolone: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`,
        });
      }
    }
  );

  // DELETE /admin/templates/:id/assets/:assetId
  fastify.delete<{ Params: TemplateAssetParams }>(
    '/:id/assets/:assetId',
    {
      schema: {
        tags: ['templates'],
        summary: 'Usuń zasób graficzny szablonu',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            assetId: { type: 'string' },
          },
        },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' } } },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
