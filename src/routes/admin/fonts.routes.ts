import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { listFonts, uploadFont, deleteFont } from '../../services/admin/fonts.service';

export async function fontsRoutes(fastify: FastifyInstance) {
  // GET /admin/fonts
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const fonts = await listFonts();
    return reply.send({ fonts });
  });

  // POST /admin/fonts
  fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'Upload Error', message: 'Brak pliku' });
    }

    const ext = data.filename.split('.').pop()?.toLowerCase() || '';
    if (!['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
      return reply.status(400).send({
        error: 'Upload Error',
        message: `Niedozwolony format: .${ext}. Dozwolone: TTF, OTF, WOFF, WOFF2`,
      });
    }

    try {
      const buffer = await data.toBuffer();
      const font = await uploadFont(buffer, data.filename, data.mimetype);
      return reply.status(201).send({ font });
    } catch (error: any) {
      fastify.log.error(error);
      return reply.status(400).send({ error: 'Upload Failed', message: error.message });
    }
  });

  // DELETE /admin/fonts/:fileName
  fastify.delete<{ Params: { fileName: string } }>(
    '/:fileName',
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
