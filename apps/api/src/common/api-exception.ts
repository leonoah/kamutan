import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@kamutan/contracts';

export interface ApiIssue {
  path: string;
  message: string;
}

/** HttpException carrying a stable machine-readable error code. */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly issues?: ApiIssue[],
  ) {
    super({ code, message, issues }, status);
  }
}

export const notFound = (what = 'resource') =>
  new ApiException(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`);
export const forbidden = (message = 'insufficient role') =>
  new ApiException(HttpStatus.FORBIDDEN, 'forbidden', message);
export const unauthorized = (message = 'authentication required') =>
  new ApiException(HttpStatus.UNAUTHORIZED, 'unauthorized', message);
export const badRequest = (message: string) =>
  new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', message);
export const conflict = (message: string) => new ApiException(HttpStatus.CONFLICT, 'conflict', message);
