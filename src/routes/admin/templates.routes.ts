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
  listTemplateTags,
  getTemplateForm,
  replaceTemplateForm,
  duplicateTemplate,
  createTemplate,
  updateTemplateMetadata,
  deleteTemplate
} from '../../services/admin/templates.service';
import {
  getTemplateLayout,
  updateTemplateLayout,
  listTemplateLayoutVersions,
  restoreTemplateLayoutVersion,
  listTemplateAssets,
  uploadTemplateAsset,
  deleteTemplateAsset,
} from '../../services/admin/templates-layout.service';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_TEMPLATE_ASSET_BYTES,
  assertAllowedImageUpload,
} from '../../lib/upload-validation';
import { regenerateTemplateThumbnail } from '../../services/admin/template-thumbnail.service';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { RATE_LIMITS } from '../../lib/rate-limits';

const templateItemResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    code: { type: 'string' },
    description: { type: ['string', 'null'] },
    version: { type: 'number' },
    editorType: { type: 'string', enum: ['SIMPLE', 'ADVANCED'] },
    isActive: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    thumbnailUrl: { type: ['string', 'null'] },
    layout: {
      type: ['object', 'null'],
      additionalProperties: true,
      properties: {
        widthMm: { type: ['number', 'null'] },
        heightMm: { type: ['number', 'null'] },
        dpi: { type: ['number', 'null'] },
        width: { type: ['number', 'null'] },
        height: { type: ['number', 'null'] },
        formatPreset: { type: ['string', 'null'] },
      },
    },
    fieldCount: { type: 'number' },
    individualFieldCount: { type: 'number' },
    productCount: { type: 'number' },
    // Liczba aktywnych mapowan na produkty w sklepach. Bez zadeklarowania
    // pola fast-json-stringify wycina je z odpowiedzi, a karta w bibliotece
    // pokazuje wtedy "brak produktow" nawet przy podpietym produkcie.
    mappingCount: { type: 'number' },
    createdAt: { type: 'string' },
  },
  required: ['id', 'name', 'code', 'version', 'isActive', 'createdAt'],
} as const;

const templateFormResponseSchema = {
  type: 'object',
  properties: {
    // Bez zadeklarowania pola fast-json-stringify wycina je z odpowiedzi,
    // a panel nie ma czym pilnowac konfliktu zapisu.
    version: { type: 'string' },
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
    version: { type: 'string' },
    layout: {
      type: ['object', 'null'],
      additionalProperties: true,
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
  },
  required: ['layout'],
} as const;

const templateAssetResponseSchema = {
  type: 'object',
  additionalProperties: true,
} as const;

/** Znacznik wersji szablonu wczytanej przez panel - patrz template-version.ts. */
type TemplateVersionQuery = { expectedVersion?: string };

const templateVersionQuerySchema = {
  type: 'object',
  properties: {
    expectedVersion: {
      type: 'string',
      description: 'Znacznik wersji z GET; zapis odrzucany (409), gdy szablon zmienil sie w miedzyczasie',
    },
  },
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

  // GET /admin/templates/tags - slownik biblioteki
  fastify.get('/tags', {
    schema: {
      tags: ['templates'],
      summary: 'Tagi używane w bibliotece szablonów wraz z liczbą użyć',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tag: { type: 'string' },
              label: { type: 'string' },
              count: { type: 'number' },
            },
          },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await listTemplateTags());
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
            editorType: { type: 'string', enum: ['SIMPLE', 'ADVANCED'] },
            tags: { type: 'array', items: { type: 'string' } },
            layout: { type: 'object', additionalProperties: true },
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
            editorType: { type: 'string', enum: ['SIMPLE', 'ADVANCED'] },
            tags: { type: 'array', items: { type: 'string' } },
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
  fastify.put<{ Params: TemplateIdParams; Body: TemplateFormInput; Querystring: TemplateVersionQuery }>(
    '/:id/form',
    {
      schema: {
        tags: ['templates'],
        summary: 'Zastąp konfigurację formularza szablonu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: templateVersionQuerySchema,
        body: { type: 'object', description: 'Konfiguracja formularza z polami (TemplateFormInput)' },
        response: { 200: templateFormResponseSchema },
      },
    },
    async (
      request: FastifyRequest<{ Params: TemplateIdParams; Body: TemplateFormInput; Querystring: TemplateVersionQuery }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      const bodyParsed = templateFormSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: bodyParsed.error.errors[0].message });
      }
      try {
        const data = await replaceTemplateForm(
          paramsParsed.data.id,
          bodyParsed.data,
          request.query?.expectedVersion
        );
        return reply.send(data);
      } catch (error: any) {
        if (error instanceof ConflictError) {
          return reply.status(error.statusCode).send({
            error: error.error,
            message: error.message,
            details: error.details,
          });
        }
        throw error;
      }
    }
  );

  // GET /admin/templates/:id/layout/versions
  fastify.get<{ Params: TemplateIdParams }>(
    '/:id/layout/versions',
    {
      schema: {
        tags: ['templates'],
        summary: 'Historia zapisanych wersji layoutu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              versions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: TemplateIdParams }>, reply: FastifyReply) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }
      return reply.send(await listTemplateLayoutVersions(paramsParsed.data.id));
    }
  );

  // POST /admin/templates/:id/layout/versions/:versionId/restore
  fastify.post<{ Params: TemplateIdParams & { versionId: string } }>(
    '/:id/layout/versions/:versionId/restore',
    {
      schema: {
        tags: ['templates'],
        summary: 'Przywroc layout z historii',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, versionId: { type: 'string' } },
        },
        response: { 200: templateLayoutResponseSchema },
      },
    },
    async (
      request: FastifyRequest<{ Params: TemplateIdParams & { versionId: string } }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }

      try {
        const result = await restoreTemplateLayoutVersion(
          paramsParsed.data.id,
          String(request.params.versionId)
        );
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Restore Failed', message: error.message });
      }
    }
  );

  // POST /admin/templates/:id/duplicate
  fastify.post<{ Params: TemplateIdParams; Body: { code?: string; name?: string } }>(
    '/:id/duplicate',
    {
      schema: {
        tags: ['templates'],
        summary: 'Skopiuj szablon razem z layoutem i formularzem',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['code', 'name'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 50 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        response: {
          201: { type: 'object', additionalProperties: true },
          409: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: TemplateIdParams; Body: { code?: string; name?: string } }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = templateIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: paramsParsed.error.errors[0].message });
      }

      const code = String(request.body?.code || '').trim().toUpperCase();
      const name = String(request.body?.name || '').trim();
      if (!/^[A-Z0-9_]+$/.test(code)) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Kod może zawierać tylko wielkie litery, cyfry i podkreślenia',
        });
      }
      if (!name) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Podaj nazwę kopii' });
      }

      try {
        const template = await duplicateTemplate(paramsParsed.data.id, { code, name });
        return reply.status(201).send(template);
      } catch (error: any) {
        if (error instanceof ConflictError || error instanceof NotFoundError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Duplicate Failed', message: error.message });
      }
    }
  );

  // POST /admin/templates/:id/thumbnail - odswiez miniature w bibliotece
  fastify.post<{ Params: TemplateIdParams }>(
    '/:id/thumbnail',
    {
      config: {
        // Render kosztuje CPU, wiec ten sam limit co uploady - klikanie
        // „odswiez” w kolko nie ma zajezdzic serwera.
        rateLimit: RATE_LIMITS.adminUpload,
      },
      schema: {
        tags: ['templates'],
        summary: 'Wygeneruj miniaturę szablonu z aktualnego layoutu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: { thumbnailUrl: { type: ['string', 'null'] } },
          },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
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
        const thumbnailUrl = await regenerateTemplateThumbnail(paramsParsed.data.id);
        return reply.send({ thumbnailUrl });
      } catch (error: any) {
        if (error instanceof NotFoundError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        fastify.log.error(error);
        return reply.status(400).send({ error: 'Thumbnail Failed', message: error.message });
      }
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
        const { layout, version } = await getTemplateLayout(paramsParsed.data.id);
        return reply.send({ layout, version });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
    }
  );

  // PUT /admin/templates/:id/layout
  fastify.put<{ Params: TemplateIdParams; Body: TemplateLayoutInput; Querystring: TemplateVersionQuery }>(
    '/:id/layout',
    {
      schema: {
        tags: ['templates'],
        summary: 'Zapisz wizualny layout szablonu (Fabric.js JSON)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: templateVersionQuerySchema,
        body: { type: 'object', description: 'Konfiguracja layoutu Fabric.js z warstwami i fontami' },
        response: {
          200: templateLayoutResponseSchema,
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: TemplateIdParams; Body: TemplateLayoutInput; Querystring: TemplateVersionQuery }>,
      reply: FastifyReply
    ) => {
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
        const result = await updateTemplateLayout(
          paramsParsed.data.id,
          bodyParsed.data,
          request.query?.expectedVersion
        );
        return reply.send(result);
      } catch (error: any) {
        // Konflikt wersji to normalna sytuacja przy dwoch kartach, nie awaria -
        // panel ma na nim poprosic o odswiezenie, a nie pokazac "blad zapisu".
        if (error instanceof ConflictError) {
          return reply.status(error.statusCode).send({
            error: error.error,
            message: error.message,
            details: error.details,
          });
        }
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
