import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getCases } from '../../services/admin/cases.service';
import { casesQuerySchema, CasesQueryInput } from '../../schemas/admin.schema';

export async function casesRoutes(fastify: FastifyInstance) {
  // GET /admin/cases
  fastify.get<{ Querystring: CasesQueryInput }>(
    '/',
    async (request: FastifyRequest<{ Querystring: CasesQueryInput }>, reply: FastifyReply) => {
      try {
        const parsed = casesQuerySchema.safeParse(request.query);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const result = await getCases(parsed.data);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać listy case',
        });
      }
    }
  );
}
