export type ApiErrorStatus = 400 | 401 | 404 | 409 | 422 | 429 | 500;

export class ApiError extends Error {
  constructor(readonly statusCode: ApiErrorStatus, readonly code: string, message: string, readonly param?: string) {
    super(message);
    this.name = 'ApiError';
  }
}
