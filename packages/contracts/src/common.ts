import { z } from 'zod';

/** RFC 4122 UUID (all ids are UUIDs, never sequential — SEC-10). */
export const UuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** ISO-8601 timestamp string as returned by Postgres/JSON. */
export const TimestampSchema = z.string().datetime({ offset: true });

/** Lowercase hex SHA-256 digest. */
export const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256 digest');
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** Cursor pagination query (all list endpoints). */
export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
