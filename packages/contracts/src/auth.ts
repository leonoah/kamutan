import { z } from 'zod';

/** Decoded Firebase ID token claims the API relies on (firebase-admin verifyIdToken). */
export const IdTokenClaimsSchema = z
  .object({
    uid: z.string().min(1).max(128),
    email: z.string().optional(),
    email_verified: z.boolean().optional(),
    firebase: z
      .object({
        sign_in_provider: z.string(),
        /** Present when the session was established with a second factor (MFA). */
        sign_in_second_factor: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;
