import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getCases,
  getCaseById,
  updateCaseAnswers,
  updateCaseStatus,
  addCaseNote,
} from '../../services/admin/cases.service';
import {
  casesQuerySchema,
  caseIdParamsSchema,
  updateCaseAnswersSchema,
  updateCaseStatusSchema,
  addCaseNoteSchema,
  CasesQueryInput,
  CaseIdParams,
  UpdateCaseAnswersInput,
  UpdateCaseStatusInput,
  AddCaseNoteInput,
} from '../../schemas/admin.schema';

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

  // GET /admin/cases/:id
  fastify.get<{ Params: CaseIdParams }>(
    '/:id',
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const parsed = caseIdParamsSchema.safeParse(request.params);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const caseItem = await getCaseById(parsed.data.id);
        return reply.send(caseItem);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać szczegółów case',
        });
      }
    }
  );

  // PUT /admin/cases/:id/answers
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>(
    '/:id/answers',
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseAnswersSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : bodyValidation.error.errors[0].message,
          });
        }

        const updated = await updateCaseAnswers(
          paramsValidation.data.id,
          bodyValidation.data.answers
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować odpowiedzi',
        });
      }
    }
  );

  // PUT /admin/cases/:id/status
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>(
    '/:id/status',
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseStatusSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : bodyValidation.error.errors[0].message,
          });
        }

        const updated = await updateCaseStatus(
          paramsValidation.data.id,
          bodyValidation.data.status
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować statusu',
        });
      }
    }
  );

  // POST /admin/cases/:id/notes
  fastify.post<{ Params: CaseIdParams; Body: AddCaseNoteInput }>(
    '/:id/notes',
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: AddCaseNoteInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = addCaseNoteSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : bodyValidation.error.errors[0].message,
          });
        }

        const updated = await addCaseNote(paramsValidation.data.id, bodyValidation.data.note);
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się dodać notatki',
        });
      }
    }
  );
}
