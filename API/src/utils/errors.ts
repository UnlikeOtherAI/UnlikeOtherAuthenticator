export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly statusCode: number;

  public constructor(code: AppErrorCode, statusCode: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

