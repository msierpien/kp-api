import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listFonts, uploadFont, deleteFont, FontItem } from '../../services/admin/fonts.service';
import { ALLOWED_FONT_EXTENSIONS, MAX_FONT_UPLOAD_BYTES, assertAllowedFontUpload } from '../../lib/upload-validation';
import { RATE_LIMITS } from '../../lib/rate-limits';

/** Maks. liczba plikow w jednym zadaniu masowego wgrywania. */
const MAX_FONT_FILES_PER_REQUEST = 30;

export async function fontsRoutes(fastify: FastifyInstance) {
  // GET /admin/fonts
  fastify.get('/', {
    schema: {
      tags: ['fonts'],
      summary: 'Lista globalnych czcionek',
      response: { 200: { type: 'object', properties: { fonts: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const fonts = await listFonts();
    return reply.send({ fonts });
  });

  // POST /admin/fonts
  fastify.post('/', {
    config: {
      rateLimit: RATE_LIMITS.adminUpload,
    },
    schema: {
      tags: ['fonts'],
      summary: 'Wgraj jedną lub więcej czcionek (TTF/OTF/WOFF/WOFF2)',
      description: 'Przyjmuje multipart/form-data z jednym lub wieloma plikami w polu "file"',
      consumes: ['multipart/form-data'],
      response: {
        201: {
          type: 'object',
          properties: {
            fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { fileName: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: { fileName: { type: 'string' }, message: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parts = request.files({
      limits: { files: MAX_FONT_FILES_PER_REQUEST, fileSize: MAX_FONT_UPLOAD_BYTES },
    });

    const fonts: FontItem[] = [];
    const errors: { fileName: string; message: string }[] = [];
    let receivedAny = false;

    for await (const part of parts) {
      receivedAny = true;
      const ext = part.filename.split('.').pop()?.toLowerCase() || '';

      try {
        const buffer = await part.toBuffer();
        assertAllowedFontUpload(buffer, ext, { maxBytes: MAX_FONT_UPLOAD_BYTES });
        const font = await uploadFont(buffer, part.filename);
        fonts.push(font);
      } catch (error: any) {
        fastify.log.error(error);
        errors.push({
          fileName: part.filename,
          message: error.message || `Dozwolone formaty: ${ALLOWED_FONT_EXTENSIONS.join(', ')}`,
        });
      }
    }

    if (!receivedAny) {
      return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
    }

    if (fonts.length === 0) {
      return reply.status(400).send({
        error: 'Upload Failed',
        message: errors[0]?.message || 'Nie udało się wgrać żadnej czcionki',
        errors,
      });
    }

    return reply.status(201).send({ fonts, errors });
  });

  // DELETE /admin/fonts/:fileName
  fastify.delete<{ Params: { fileName: string } }>(
    '/:fileName',
    {
      schema: {
        tags: ['fonts'],
        summary: 'Usuń czcionkę',
        params: { type: 'object', properties: { fileName: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { fileName: string } }>, reply: FastifyReply) => {
      const { fileName } = request.params;
      try {
        await deleteFont(fileName);
        return reply.send({ success: true });
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
    }
  );
}
