import { z } from 'zod';
import { RoleSchema } from './roles.js';

/**
 * Supabase access-token claims the API relies on. The custom access token hook
 * may add `org_roles` ({orgId: role}); the API treats the DB membership table as
 * authoritative and uses the claim only as a hint.
 */
export const AccessTokenClaimsSchema = z
  .object({
    sub: z.string().uuid(),
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
