import { z } from 'zod';

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'fail', 'skipped'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
