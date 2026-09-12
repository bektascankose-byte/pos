/**
 * Employee and role contracts.
 *
 * Deliberately does not let a client edit what a role grants -- see
 * `role_permissions` and the register's own `docs/POS_DESIGN_SYSTEM.md`.
 * System roles (`roles.org_id IS NULL`) are shared defaults across every
 * organization on this platform; editing one here would be a global change,
 * not a per-org preference, the same class of risk the manual
 * `sale.price_override` migration earlier this project carried. What this
 * file supports is assigning an *existing* role to a person, and resetting
 * how they get in -- a password for the back office, a PIN for the register.
 */

import { z } from 'zod';
import { uuid, phone, email, timestamp } from './primitives.js';

export const userStatus = z.enum(['invited', 'active', 'suspended', 'terminated']);

export const roleAssignmentSchema = z.object({
  id: uuid,
  role_id: uuid,
  role_key: z.string(),
  role_name: z.string(),
  store_id: uuid.nullable(),
});

export const employeeSchema = z.object({
  id: uuid,
  email: email.nullable(),
  phone: phone.nullable(),
  full_name: z.string().min(1).max(256),
  display_name: z.string().max(64).nullable(),
  employee_code: z.string().max(32).nullable(),
  hired_at: z.string().nullable(),
  status: userStatus,
  last_login_at: timestamp.nullable(),
  created_at: timestamp,
  roles: z.array(roleAssignmentSchema).optional(),
});

const contactable = <T extends { phone?: string | undefined; email?: string | undefined }>(
  v: T,
) => v.phone !== undefined || v.email !== undefined;

export const createEmployeeSchema = z
  .object({
    full_name: z.string().min(1).max(256),
    display_name: z.string().max(64).optional(),
    email: email.optional(),
    phone: phone.optional(),
    employee_code: z.string().max(32).optional(),
    hired_at: z.string().optional(),
    /** A system role's key -- 'cashier', 'shift_lead', 'manager', and so on. */
    role_key: z.string().min(1),
    store_id: uuid.optional(),
    /** Register unlock. Optional -- a back-office-only account may never touch a register. */
    pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits').optional(),
    /** Dashboard sign-in. Optional -- most employees only ever unlock a register with a PIN. */
    password: z.string().min(8).max(200).optional(),
  })
  .refine(contactable, { message: 'an employee needs a phone or an email', path: ['phone'] });

export const updateEmployeeSchema = z.object({
  full_name: z.string().min(1).max(256).optional(),
  display_name: z.string().max(64).optional(),
  email: email.optional(),
  phone: phone.optional(),
  employee_code: z.string().max(32).optional(),
  hired_at: z.string().optional(),
  status: userStatus.optional(),
});

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits'),
});

export const assignRoleSchema = z.object({
  role_key: z.string().min(1),
  store_id: uuid.nullable().optional(),
});

export type Employee = z.infer<typeof employeeSchema>;
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;
export type CreateEmployee = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployee = z.infer<typeof updateEmployeeSchema>;
export type SetPin = z.infer<typeof setPinSchema>;
export type AssignRole = z.infer<typeof assignRoleSchema>;
