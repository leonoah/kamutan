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
  /** Sprint 3: org setting blockExportOnRed and red lines exist. */
  'export_blocked',
  /** Sprint 5: the org is being offboarded — every access is blocked except the offboarding export download (SEC-52). */
  'org_offboarding',
  /** Sprint 5: the action needs a sign-in within the last 10 minutes (ID token `auth_time`); re-authenticate. */
  'recent_auth_required',
  /** Sprint 5: public share link unknown (404) / expired or revoked (410) — identical body for both statuses. */
  'share_unavailable',
  /** Sprint 5: non-GET on the public share API (405). */
  'method_not_allowed',
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
