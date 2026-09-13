/**
 * Employee onboarding checklists. One org-wide template (managed on its own
 * screen) is snapshotted into a fresh per-employee checklist the moment
 * someone is hired -- see `onboarding_checklist_items.title` being copied
 * text, not a live reference, so a later template edit never rewrites what
 * an already-hired employee was actually asked to do.
 */

import { z } from 'zod';
import { uuid, timestamp } from './primitives.js';

export const onboardingTaskTemplateSchema = z.object({
  id: uuid,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  sort_order: z.number().int(),
  is_active: z.boolean(),
  created_at: timestamp,
});

export const createOnboardingTaskTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  sort_order: z.number().int().optional(),
});

export const updateOnboardingTaskTemplateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

export const onboardingChecklistItemSchema = z.object({
  id: uuid,
  checklist_id: uuid,
  template_item_id: uuid.nullable(),
  title: z.string(),
  sort_order: z.number().int(),
  is_completed: z.boolean(),
  completed_by: uuid.nullable(),
  /** Denormalized for display only, set whenever `completed_by` is. */
  completed_by_name: z.string().nullable(),
  completed_at: timestamp.nullable(),
  note: z.string().nullable(),
});

export const onboardingChecklistSchema = z.object({
  id: uuid,
  user_id: uuid,
  started_at: timestamp,
  completed_at: timestamp.nullable(),
  items: z.array(onboardingChecklistItemSchema),
});

/** A one-off item added to a single employee's checklist -- not part of the shared template. */
export const addOnboardingChecklistItemSchema = z.object({
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
});

export type OnboardingTaskTemplate = z.infer<typeof onboardingTaskTemplateSchema>;
export type CreateOnboardingTaskTemplate = z.infer<typeof createOnboardingTaskTemplateSchema>;
export type UpdateOnboardingTaskTemplate = z.infer<typeof updateOnboardingTaskTemplateSchema>;
export type OnboardingChecklistItem = z.infer<typeof onboardingChecklistItemSchema>;
export type OnboardingChecklist = z.infer<typeof onboardingChecklistSchema>;
export type AddOnboardingChecklistItem = z.infer<typeof addOnboardingChecklistItemSchema>;
