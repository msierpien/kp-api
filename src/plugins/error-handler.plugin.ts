import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Standardowy format odpowiedzi błędu
 */
export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
  details?: any;
}

/**
 * Plugin do centralnego error handling
 *
 * Przechwytuje wszystkie błędy i zwraca spójny format odpowiedzi
 */
export async function errorHandlerPlugin(fastify: FastifyInstance) {
  fastify.setErrorHandler(
    async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      // Log błędu
      fastify.log.error({
        err: error,
        url: request.url,
        method: request.method,
      });

      // Określ status code
      const statusCode = error.statusCode || 500;

      // Format odpowiedzi
      const response: ErrorResponse = {
        error: getErrorName(statusCode),
        message: getErrorMessage(error, statusCode),
        statusCode,
      };

      // Dodaj szczegóły w dev mode
      if (process.env.NODE_ENV === 'development' && error.validation) {
        response.details = error.validation;
      }

      return reply.status(statusCode).send(response);
    }
  );

  // Handler dla 404
  fastify.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });
}

/**
 * Mapowanie status code na nazwę błędu
 */
function getErrorName(statusCode: number): string {
  const errorNames: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };

  return errorNames[statusCode] || 'Error';
}

/**
 * Generuje przyjazną wiadomość błędu
 */
function getErrorMessage(error: FastifyError, statusCode: number): string {
  // Użyj message z błędu jeśli jest
  if (error.message) {
    return error.message;
  }

  // Domyślne wiadomości
  const defaultMessages: Record<number, string> = {
    400: 'Nieprawidłowe żądanie',
    401: 'Brak autoryzacji',
    403: 'Brak dostępu',
    404: 'Nie znaleziono zasobu',
    409: 'Konflikt danych',
    422: 'Nieprawidłowe dane',
    429: 'Za dużo żądań',
    500: 'Błąd serwera',
    502: 'Błąd bramy',
    503: 'Serwis niedostępny',
  };

  return defaultMessages[statusCode] || 'Wystąpił błąd';
}
