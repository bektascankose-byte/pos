/**
 * Employee scheduling: a roster of upcoming shifts.
 *
 * Distinct from `time_clock_entries` (identity.ts era schema, still unbuilt):
 * a shift is a plan for who is supposed to work when, not a record of what
 * actually happened. Cancelling a shift is a status change, never a delete --
 * the same reason most other entities in this system are soft-stated rather
 * than erased.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';

export const shiftStatus = z.enum(['scheduled', 'cancelled']);

export const shiftSchema = z.object({
  id: uuid,
  store_id: uuid,
  user_id: uuid,
  employee_name: z.string(),
  starts_at: timestamp,
  ends_at: timestamp,
  status: shiftStatus,
  note: z.string().nullable(),
  created_at: timestamp,
});

/** A range is required -- an unbounded shift list is not a useful roster view, the same reasoning as the reports module's range queries. */
export const shiftQuerySchema = z.object({
  store_id: uuid.optional(),
  user_id: uuid.optional(),
  from: timestamp,
  to: timestamp,
});

export const createShiftSchema = z
  .object({
    store_id: uuid,
    user_id: uuid,
    starts_at: timestamp,
    ends_at: timestamp,
    note: z.string().max(500).optional(),
  })
  .refine((v) => new Date(v.ends_at) > new Date(v.starts_at), {
    message: 'a shift must end after it starts',
    path: ['ends_at'],
  });

export const updateShiftSchema = z.object({
  starts_at: timestamp.optional(),
  ends_at: timestamp.optional(),
  note: z.string().max(500).optional(),
});

export type ShiftStatus = z.infer<typeof shiftStatus>;
export type Shift = z.infer<typeof shiftSchema>;
export type ShiftQuery = z.infer<typeof shiftQuerySchema>;
export type CreateShift = z.infer<typeof createShiftSchema>;
export type UpdateShift = z.infer<typeof updateShiftSchema>;
