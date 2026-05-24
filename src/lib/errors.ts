export class AppError extends Error {
  readonly statusCode: number;
  readonly error: string;
  readonly details?: unknown;

  constructor(statusCode: number, error: string, message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.error = error;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Nieprawidłowe dane', details?: unknown) {
    super(400, 'Bad Request', message, details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Brak autoryzacji', details?: unknown) {
    super(401, 'Unauthorized', message, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Brak dostępu', details?: unknown) {
    super(403, 'Forbidden', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Nie znaleziono zasobu', details?: unknown) {
    super(404, 'Not Found', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Konflikt danych', details?: unknown) {
    super(409, 'Conflict', message, details);
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Błąd serwera', details?: unknown) {
    super(500, 'Internal Server Error', message, details);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
