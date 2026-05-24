import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listFonts, uploadFont, deleteFont } from '../../services/admin/fonts.service';
import { ALLOWED_FONT_EXTENSIONS, MAX_FONT_UPLOAD_BYTES, assertAllowedFontUpload } from '../../lib/upload-validation';

export async function fontsRoutes(fastify: FastifyInstance) {
  // GET /admin/fonts
  fastify.get('/', {
    schema: {
      tags: ['fonts'],
      summary: 'Lista globalnych czcionek',
      response: { 200: { type: 'object', properties: { fonts: { type: 'array', items: { type: 'object' } } } } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const fonts = await listFonts();
    return reply.send({ fonts });
  });

  // POST /admin/fonts
  fastify.post('/', {
    schema: {
      tags: ['fonts'],
      summary: 'Wgraj czcionkę (TTF/OTF/WOFF/WOFF2)',
      description: 'Przyjmuje multipart/form-data z plikiem czcionki',
      consumes: ['multipart/form-data'],
      response: {
        201: { type: 'object', properties: { font: { type: 'object' } } },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
    }

    const ext = data.filename.split('.').pop()?.toLowerCase() || '';

    try {
      const buffer = await data.toBuffer();
      assertAllowedFontUpload(buffer, ext, { maxBytes: MAX_FONT_UPLOAD_BYTES });
      const font = await uploadFont(buffer, data.filename);
      return reply.status(201).send({ font });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(400).send({
        error: 'Upload Failed',
        message: error.message || `Dozwolone formaty: ${ALLOWED_FONT_EXTENSIONS.join(', ')}`,
      });
    }
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
