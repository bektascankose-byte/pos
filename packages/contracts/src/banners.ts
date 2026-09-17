/**
 * Website banners: the brand artwork on the home page and over brand pages.
 *
 * Two views of one record. The back office sees everything, including whether
 * shoppers can see it right now and, if not, why. The storefront sees only what
 * it needs to draw a banner that is showing -- never a storage key, never a
 * banner that is switched off.
 */

import { z } from 'zod';
import { timestamp, uuid, entityStatus } from './primitives.js';

export const bannerPlacementSchema = z.enum(['home_hero', 'home_feature', 'brand_header']);
export const bannerLinkKindSchema = z.enum(['brand', 'category', 'product', 'search', 'none']);

const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });

export const storefrontBannerSchema = z.object({
  id: uuid,
  placement: bannerPlacementSchema,
  title: z.string(),
  headline: z.string().nullable(),
  body: z.string().nullable(),
  cta_label: z.string().nullable(),
  link_kind: bannerLinkKindSchema,
  link_value: z.string().nullable(),
  image: size,
  mobile_image: size.nullable(),
  has_video: z.boolean(),
  video_bytes: z.number().int().nullable(),
  alt_text: z.string(),
  advertises_nicotine: z.boolean(),
  hide_when_unavailable: z.boolean(),
  starts_at: timestamp.nullable(),
  ends_at: timestamp.nullable(),
  sort_order: z.number().int(),
  status: entityStatus,
  source_note: z.string().nullable(),
  /** Whether a shopper sees it right now, and if not, the reason in words. */
  visibility: z.object({ showing: z.boolean(), reason: z.string().nullable() }),
  created_at: timestamp,
  updated_at: timestamp,
});

/**
 * The text fields sent alongside the uploaded artwork. Sent as multipart form
 * fields, so booleans and numbers arrive as strings and are read here.
 */
const formBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', 'on'])])
  .transform((value) => value === true || value === 'true' || value === 'on');

export const createBannerFieldsSchema = z
  .object({
    placement: bannerPlacementSchema,
    title: z.string().trim().min(1).max(120),
    headline: z.string().trim().max(120).optional(),
    body: z.string().trim().max(300).optional(),
    cta_label: z.string().trim().max(40).optional(),
    link_kind: bannerLinkKindSchema,
    link_value: z.string().trim().max(200).optional(),
    alt_text: z.string().trim().min(3, 'describe the picture for people who cannot see it').max(300),
    advertises_nicotine: formBoolean.default(true),
    hide_when_unavailable: formBoolean.default(true),
    starts_at: z.string().datetime({ offset: true }).optional(),
    ends_at: z.string().datetime({ offset: true }).optional(),
    source_note: z.string().trim().max(200).optional(),
  })
  .refine((value) => value.link_kind === 'none' || !!value.link_value, {
    message: 'say where the banner links to',
    path: ['link_value'],
  })
  .refine((value) => value.placement !== 'brand_header' || value.link_kind === 'brand', {
    message: 'a brand header belongs to a brand',
    path: ['link_kind'],
  });

export const updateBannerSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  headline: z.string().trim().max(120).nullable().optional(),
  body: z.string().trim().max(300).nullable().optional(),
  cta_label: z.string().trim().max(40).nullable().optional(),
  alt_text: z.string().trim().min(3).max(300).optional(),
  advertises_nicotine: z.boolean().optional(),
  hide_when_unavailable: z.boolean().optional(),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  sort_order: z.number().int().min(-1000).max(1000).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

/** A banner as the storefront draws it. */
export const shopBannerSchema = z.object({
  id: uuid,
  placement: bannerPlacementSchema,
  headline: z.string().nullable(),
  body: z.string().nullable(),
  cta_label: z.string().nullable(),
  link: z.object({ kind: bannerLinkKindSchema.exclude(['none']), value: z.string() }).nullable(),
  image: size,
  mobile_image: size.nullable(),
  has_video: z.boolean(),
  alt_text: z.string(),
  advertises_nicotine: z.boolean(),
});

export type BannerPlacement = z.infer<typeof bannerPlacementSchema>;
export type BannerLinkKind = z.infer<typeof bannerLinkKindSchema>;
export type StorefrontBanner = z.infer<typeof storefrontBannerSchema>;
export type CreateBannerFields = z.infer<typeof createBannerFieldsSchema>;
export type UpdateBanner = z.infer<typeof updateBannerSchema>;
export type ShopBanner = z.infer<typeof shopBannerSchema>;
