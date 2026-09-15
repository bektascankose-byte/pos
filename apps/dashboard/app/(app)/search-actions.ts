"use server";

import { apiFetch, ApiError } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

export interface PaletteHit {
  id: string;
  label: string;
  sublabel: string;
  href: string;
}

export interface PaletteResults {
  items: PaletteHit[];
  customers: PaletteHit[];
}

interface CatalogSearchRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  variant_name: string | null;
  sku: string;
  brand_name: string | null;
}

interface CustomerRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
}

const LIMIT = 6;

/**
 * What the command palette searches besides its own menu: the actual records
 * someone is usually looking for. Both endpoints already exist and already do
 * the matching -- `/catalog/products` over name/sku/variant/brand, and
 * `/customers` over name/phone/email -- so this only fans out and reshapes.
 *
 * Server-side like every other action here, so the API token stays in its
 * httpOnly cookie instead of reaching browser JavaScript.
 */
export async function searchEverythingAction(query: string): Promise<ActionResult<PaletteResults>> {
  const q = query.trim();
  if (q.length < 2) {
    return { ok: true, data: { items: [], customers: [] } };
  }

  try {
    const [items, customers] = await Promise.all([
      apiFetch<{ data: CatalogSearchRow[] }>(
        `/api/v1/catalog/products?q=${encodeURIComponent(q)}&limit=${LIMIT}`,
      )
        .then((res) =>
          res.data.map((row) => ({
            id: row.variant_id,
            label: `${row.product_name}${row.variant_name ? ` | ${row.variant_name}` : ""}`,
            sublabel: `${row.brand_name ? `${row.brand_name} · ` : ""}UPC ${row.sku}`,
            href: `/catalog/${row.product_id}`,
          })),
        )
        .catch(() => [] as PaletteHit[]),
      apiFetch<{ data: CustomerRow[] }>(
        `/api/v1/customers?q=${encodeURIComponent(q)}&limit=${LIMIT}`,
      )
        .then((res) =>
          res.data.map((row) => ({
            id: row.id,
            label: row.full_name ?? row.phone ?? row.email ?? "Customer",
            sublabel: [row.phone, row.email].filter(Boolean).join(" · "),
            href: `/customers/${row.id}`,
          })),
        )
        // One side failing (a permission the signed-in role lacks, say)
        // shouldn't blank out the other half of the results.
        .catch(() => [] as PaletteHit[]),
    ]);

    return { ok: true, data: { items, customers } };
  } catch (e) {
    return { ok: false, error: e instanceof ApiError ? e.message : "Could not search." };
  }
}
