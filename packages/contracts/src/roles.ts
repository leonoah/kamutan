import { z } from 'zod';

/** Membership role (SEC-07). Ordered from most to least privileged. */
export const ROLES = ['admin', 'editor', 'reviewer', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Numeric rank: higher means more privileges. */
export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  admin: 40,
  editor: 30,
  reviewer: 20,
  viewer: 10,
});

/** True when `actual` grants at least the privileges of `required`. */
export function roleSatisfies(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
