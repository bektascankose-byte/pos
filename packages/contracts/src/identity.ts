/**
 * Identity, organizations and permissions.
 *
 * Two authentication paths, deliberately different in strength:
 *
 *   Password  - a person signing in to the dashboard or claiming a device.
 *               Argon2id, short lived access token, rotating refresh token.
 *
 *   PIN       - a cashier unlocking a register mid shift, hundreds of times a
 *               day, often offline. A four digit PIN is not a password and is
 *               not treated as one: it authenticates against a device that has
 *               already been claimed by a real login, it is rate limited per
 *               register, and it can never be used against the HTTP API.
 *
 * The distinction matters because the PIN's whole purpose is to be fast and
 * offline verifiable, which is exactly what makes it weak.
 */

import { z } from 'zod';
import { uuid, email, phone, slug, storeCode, registerCode, timestamp } from './primitives.js';

// ------------------------------------------------------------------------ auth

export const loginSchema = z.object({
  email,
  password: z.string().min(8).max(256),
  /** Present when signing in on a register, absent for the dashboard. */
  device_id: uuid.optional(),
});

export const tokenPairSchema = z.object({
  access_token: z.string(),
  /** Short lived: a stolen access token should expire before it is useful. */
  expires_in: z.number().int(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
});

/**
 * Refresh tokens rotate: using one invalidates it and issues a new pair. A
 * replay of a spent token means it was stolen, so the whole family is revoked
 * and the user is signed out everywhere.
 */
export const refreshSchema = z.object({ refresh_token: z.string() });

export const pinUnlockSchema = z.object({
  register_id: uuid,
  pin: z.string().regex(/^\d{4,8}$/),
});

/** A sensitive action a cashier lacks: price override, refund, drawer open. */
export const managerApprovalSchema = z.object({
  action: z.string().max(64),
  pin: z.string().regex(/^\d{4,8}$/),
  context: z.record(z.unknown()).optional(),
});

export const sessionSchema = z.object({
  user_id: uuid,
  org_id: uuid,
  store_id: uuid.nullable(),
  register_id: uuid.nullable(),
  display_name: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});

// --------------------------------------------------------------- organization

export const organizationSchema = z.object({
  id: uuid,
  slug,
  legal_name: z.string().min(1).max(256),
  display_name: z.string().min(1).max(128),
  status: z.enum(['active', 'inactive', 'archived']),
});

export const storeSchema = z.object({
  id: uuid,
  code: storeCode,
  name: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
  phone: phone.nullable(),
  email: email.nullable(),
  address_line1: z.string().max(128).nullable(),
  city: z.string().max(64).nullable(),
  /** State or province. Drives tax and, more importantly, compliance rules. */
  region: z.string().max(64).nullable(),
  postal_code: z.string().max(16).nullable(),
  /** County matters: several regulated product rules are county level. */
  county: z.string().max(64).nullable(),
  country: z.string().length(2),
  status: z.enum(['active', 'inactive', 'archived']),
});

export const createStoreSchema = storeSchema
  .omit({ id: true, status: true })
  .partial({ phone: true, email: true, address_line1: true, city: true, region: true, postal_code: true, county: true, country: true });

export const registerSchema = z.object({
  id: uuid,
  store_id: uuid,
  code: registerCode,
  name: z.string().min(1).max(64),
  status: z.enum(['active', 'inactive', 'archived']),
});

/**
 * A device is the physical terminal; a register is its identity in reports.
 * They are separate so a terminal can be replaced after a spill without
 * orphaning a year of sales history.
 */
export const deviceSchema = z.object({
  id: uuid,
  register_id: uuid.nullable(),
  name: z.string().max(64),
  platform: z.string().max(32),
  app_version: z.string().max(32).nullable(),
  last_seen_at: timestamp.nullable(),
  /** Measured at handshake. A register with a wrong clock is visible, not silent. */
  clock_offset_ms: z.number().int().nullable(),
});

export const claimDeviceSchema = z.object({
  register_id: uuid,
  name: z.string().min(1).max(64),
  platform: z.string().max(32).default('android'),
  app_version: z.string().max(32).optional(),
});

// ----------------------------------------------------------------- permissions

/**
 * Permissions are `resource.action` strings, stored as rows and checked against
 * the database rather than compiled into the code, so a custom role is data and
 * not a deploy.
 */
export const permissionSchema = z.object({
  code: z.string().regex(/^[a-z_]+\.[a-z_]+$/),
  category: z.string(),
  description: z.string(),
});

/**
 * A role, as read for display -- assigning one, resetting a PIN, and editing
 * an employee's own fields live in `employees.ts`, wired to real endpoints.
 * What a role itself grants is not editable through this API: `key` and
 * `is_system` match `roles.key`/`roles.is_system` exactly, because a system
 * role (`is_system`, `org_id IS NULL`) is a platform default shared by every
 * organization, and letting one org's admin change what it grants would be a
 * global change wearing a per-org settings screen.
 */
export const roleSchema = z.object({
  id: uuid,
  key: slug,
  name: z.string().min(1).max(64),
  description: z.string().max(256).nullable(),
  is_system: z.boolean(),
  permissions: z.array(z.string()),
});

export type Session = z.infer<typeof sessionSchema>;
export type TokenPair = z.infer<typeof tokenPairSchema>;
export type Store = z.infer<typeof storeSchema>;
export type Role = z.infer<typeof roleSchema>;
