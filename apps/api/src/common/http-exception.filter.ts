import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiError, ApiErrorCode } from '@kamutan/contracts';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiException } from './api-exception';

const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'upload_expired',
  413: 'payload_too_large',
  415: 'unsupported_file_type',
  422: 'validation_failed',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/**
 * Maps every error to the contract ApiError shape. Internal error details are
 * logged (without request bodies) but never returned to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: unknown }>();
    const requestId = typeof req?.id === 'string' ? req.id : req?.id != null ? String(req.id) : null;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiError['error'];

    if (exception instanceof ApiException) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, requestId, issues: exception.issues };
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      body = {
        code: 'validation_failed',
        message: 'request validation failed',
        requestId,
        issues: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      body = { code: 'rate_limited', message: 'too many requests', requestId };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
      const message = status === 413 ? 'payload too large' : status >= 500 ? 'internal error' : exception.message;
      body = { code, message, requestId };
    } else {
      body = { code: 'internal_error', message: 'internal error', requestId };
    }

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error({ err: { name: err.name, message: err.message, stack: err.stack }, requestId }, 'unhandled error');
    }
    if (body.issues === undefined) delete body.issues;
    if (!res.headersSent) res.status(status).json({ error: body } satisfies ApiError);
  }
}
