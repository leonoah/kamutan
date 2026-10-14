import { z } from 'zod';
import { RoleSchema } from './roles.js';

/**
 * Identity-token claims the API relies on (Firebase ID token). `sub` is the Firebase
 * uid (an opaque string, not a UUID). The API treats the membership table as
 * authoritative; `org_roles` is only a hint and never trusted for authorization.
 */
export const AccessTokenClaimsSchema = z
  .object({
    sub: z.string().min(1).max(128),
    role: z.string().optional(),
    aud: z.union([z.string(), z.array(z.string())]).optional(),
    exp: z.number().int(),
    iat: z.number().int().optional(),
    iss: z.string().optional(),
    aal: z.enum(['aal1', 'aal2']).optional(),
    session_id: z.string().optional(),
    org_ids: z.array(z.string().uuid()).optional(),
    org_roles: z.record(z.string().uuid(), RoleSchema).optional(),
  })
  .passthrough();
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;
