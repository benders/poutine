/**
 * The placeholder user row seeded when a hub boots with no real accounts yet
 * (`library/seed-instances.ts`), so `instances.owner_id`'s FK has something to
 * point at. It is hidden from `GET /api/admin/hub/users` and is not a valid
 * target for any admin user mutation (#274).
 */
export const SYSTEM_USERNAME = "__system__";
