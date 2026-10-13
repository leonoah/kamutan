import { z } from 'zod';

export const API_ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'mfa_required',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_file_type',
  'upload_expired',
  'upload_missing',
  'rate_limited',
  'not_ready',
  'internal_error',
  'service_unavailable',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** Every non-2xx API response body. Never contains file content or PII. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** Developer-facing English message. UI maps `code` to a Hebrew string. */
    message: z.string(),
    requestId: z.string().nullable(),
    issues: z.array(ApiErrorIssueSchema).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
